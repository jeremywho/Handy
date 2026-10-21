use std::io::Write;
use std::panic::{self, AssertUnwindSafe};
use std::path::Path;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_store::StoreExt;
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

use crate::activity_gate::ActivityGate;
use crate::settings::{self, AppSettings};

pub const FORK_ENDPOINT: &str =
    "https://github.com/jeremywho/Handy/releases/latest/download/latest.json";
pub const FORK_PUBKEY: &str = include_str!("../../fork/updater.pub");

pub const CHECK_INTERVAL: Duration = Duration::from_secs(4 * 3600);
pub const STARTUP_DELAY: Duration = Duration::from_secs(120);
pub const REQUIRED_IDLE: Duration = Duration::from_secs(600);
pub const IDLE_POLL: Duration = Duration::from_secs(30);

const SELFTEST_FAILED: i32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    WaitInterval,
    PollIdle,
    Install,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Disabled {
    Portable,
    UpdateChecksOff,
}

impl Disabled {
    fn message(self) -> &'static str {
        match self {
            Disabled::Portable => "Portable installs update manually from the releases page.",
            Disabled::UpdateChecksOff => "Update checks are disabled.",
        }
    }
}

fn disabled_reason(settings: &AppSettings, portable: bool) -> Option<Disabled> {
    if portable {
        Some(Disabled::Portable)
    } else if !settings::update_checks_effectively_enabled(settings) {
        Some(Disabled::UpdateChecksOff)
    } else {
        None
    }
}

fn current_disabled_reason(app: &AppHandle) -> Option<Disabled> {
    disabled_reason(&settings::get_settings(app), crate::portable::is_portable())
}

pub fn service_enabled(settings: &AppSettings, portable: bool) -> bool {
    disabled_reason(settings, portable).is_none()
}

pub fn next_step(downloaded: bool, check_failed: bool, idle: Duration, gate_free: bool) -> Step {
    if check_failed || !downloaded {
        Step::WaitInterval
    } else if idle >= REQUIRED_IDLE && gate_free {
        Step::Install
    } else {
        Step::PollIdle
    }
}

#[cfg(windows)]
pub fn input_idle() -> Duration {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    if !unsafe { GetLastInputInfo(&mut info) }.as_bool() {
        return Duration::ZERO;
    }
    let now = unsafe { GetTickCount() };
    // Both are u32 millisecond tick counts that wrap every 49.7 days; wrapping_sub stays exact across the wrap.
    Duration::from_millis(u64::from(now.wrapping_sub(info.dwTime)))
}

#[cfg(not(windows))]
pub fn input_idle() -> Duration {
    Duration::ZERO
}

pub enum Restart {
    Hidden,
    Normal,
}

pub fn build_updater(app: &AppHandle, restart: Restart) -> Result<Updater, String> {
    let endpoint =
        Url::parse(FORK_ENDPOINT).map_err(|e| format!("Invalid fork update endpoint: {e}"))?;
    let mut builder = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| format!("Failed to set the fork update endpoint: {e}"))?
        .pubkey(FORK_PUBKEY.trim());
    if let Restart::Hidden = restart {
        builder = builder.installer_arg("--start-hidden");
    }
    builder
        .build()
        .map_err(|e| format!("Failed to build the updater: {e}"))
}

fn report(config_endpoints: &[String], config_pubkey: &str) -> Value {
    let ok = config_endpoints.len() == 1
        && config_endpoints[0] == FORK_ENDPOINT
        && config_pubkey.trim() == FORK_PUBKEY.trim();
    json!({
        "endpoint": FORK_ENDPOINT,
        "pubkey": FORK_PUBKEY.trim(),
        "config_endpoints": config_endpoints,
        "config_pubkey": config_pubkey,
        "ok": ok,
    })
}

pub fn selftest_report(app: &AppHandle) -> Value {
    let updater_config = app.config().plugins.0.get("updater");
    let config_endpoints: Vec<String> = updater_config
        .and_then(|u| u.get("endpoints"))
        .and_then(Value::as_array)
        .map(|endpoints| {
            endpoints
                .iter()
                .map(|e| e.as_str().unwrap_or_default().to_string())
                .collect()
        })
        .unwrap_or_default();
    let config_pubkey = updater_config
        .and_then(|u| u.get("pubkey"))
        .and_then(Value::as_str)
        .unwrap_or_default();

    let mut result = report(&config_endpoints, config_pubkey);
    if let Err(e) = build_updater(app, Restart::Normal) {
        result["ok"] = json!(false);
        result["build_error"] = json!(e);
    }
    result
}

pub fn write_selftest(app: &AppHandle, path: &Path) -> i32 {
    let result = selftest_report(app);
    let ok = result["ok"] == true;
    match write_json(path, &result) {
        Ok(()) if ok => 0,
        Ok(()) => SELFTEST_FAILED,
        Err(e) => {
            log::error!("fork self-test: failed to write {}: {e}", path.display());
            SELFTEST_FAILED
        }
    }
}

fn write_json(path: &Path, value: &Value) -> std::io::Result<()> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = std::fs::File::create(path)?;
    serde_json::to_writer_pretty(&mut file, value)?;
    file.write_all(b"\n")?;
    file.sync_all()
}

async fn check_and_download(updater: &Updater) -> Result<Option<(Update, Vec<u8>)>, String> {
    let Some(update) = updater
        .check()
        .await
        .map_err(|e| format!("Update check failed: {e}"))?
    else {
        return Ok(None);
    };
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| format!("Update download failed: {e}"))?;
    Ok(Some((update, bytes)))
}

fn flush_settings(app: &AppHandle) -> Result<(), String> {
    app.store(crate::portable::store_path(settings::SETTINGS_STORE_PATH))
        .map_err(|e| format!("Failed to open the settings store: {e}"))?
        .save()
        .map_err(|e| format!("Failed to save the settings store: {e}"))
}

fn flush_then_install(app: &AppHandle, update: &Update, bytes: &[u8]) -> Result<(), String> {
    flush_settings(app)?;
    update
        .install(bytes)
        .map_err(|e| format!("Update install failed: {e}"))
}

#[tauri::command]
#[specta::specta]
pub async fn install_update_now(app: AppHandle) -> Result<(), String> {
    if let Some(reason) = current_disabled_reason(&app) {
        return Err(reason.message().to_string());
    }

    let updater = build_updater(&app, Restart::Normal)?;
    let Some((update, bytes)) = check_and_download(&updater).await? else {
        return Ok(());
    };

    let gate = app.state::<Arc<ActivityGate>>();
    let _install_guard = gate
        .try_begin_install()
        .ok_or_else(|| "Handy is busy. Try again when dictation finishes.".to_string())?;
    flush_then_install(&app, &update, &bytes)?;
    app.restart()
}

pub fn spawn_background(app: &AppHandle) {
    let app = app.clone();
    let spawned = thread::Builder::new()
        .name("fork-updater".into())
        .spawn(move || {
            log::info!(
                "fork updater: started; first check in {}s",
                STARTUP_DELAY.as_secs()
            );
            thread::sleep(STARTUP_DELAY);
            loop {
                if let Err(payload) = panic::catch_unwind(AssertUnwindSafe(|| run_cycle(&app))) {
                    let reason = payload
                        .downcast_ref::<&str>()
                        .copied()
                        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
                        .unwrap_or("non-string panic payload");
                    log::error!(
                        "fork updater: update cycle panicked ({reason}); the service keeps running"
                    );
                }
                log::info!("fork updater: next check in {}s", CHECK_INTERVAL.as_secs());
                thread::sleep(CHECK_INTERVAL);
            }
        });
    if let Err(e) = spawned {
        log::error!("fork updater: failed to start the background thread: {e}");
    }
}

fn run_cycle(app: &AppHandle) {
    if let Some(reason) = current_disabled_reason(app) {
        log::info!("fork updater: service disabled ({reason:?})");
        return;
    }

    log::info!("fork updater: checking {FORK_ENDPOINT}");
    let result = build_updater(app, Restart::Hidden)
        .and_then(|updater| tauri::async_runtime::block_on(check_and_download(&updater)));
    let (pending, check_failed) = match result {
        Ok(Some((update, bytes))) => {
            log::info!(
                "fork updater: downloaded and verified {} ({} bytes); installing after {}s without input",
                update.version,
                bytes.len(),
                REQUIRED_IDLE.as_secs()
            );
            (Some((update, bytes)), false)
        }
        Ok(None) => {
            log::info!("fork updater: no update available");
            (None, false)
        }
        Err(e) => {
            log::info!("fork updater: {e}");
            (None, true)
        }
    };

    let gate = Arc::clone(app.state::<Arc<ActivityGate>>().inner());
    let mut last_wait = None;
    loop {
        if !service_enabled(&settings::get_settings(app), crate::portable::is_portable()) {
            log::info!("fork updater: service disabled; abandoning this cycle");
            return;
        }
        let idle = input_idle();
        let gate_free = gate.is_free();
        match next_step(pending.is_some(), check_failed, idle, gate_free) {
            Step::WaitInterval => return,
            Step::PollIdle => {
                let wait = (idle >= REQUIRED_IDLE, gate_free);
                if last_wait != Some(wait) {
                    log::info!(
                        "fork updater: waiting to install (idle {}s, dictation idle: {gate_free}); polling every {}s",
                        idle.as_secs(),
                        IDLE_POLL.as_secs()
                    );
                    last_wait = Some(wait);
                }
            }
            Step::Install => {
                if let Some((update, bytes)) = &pending {
                    try_install(app, &gate, update, bytes);
                }
                last_wait = None;
            }
        }
        thread::sleep(IDLE_POLL);
    }
}

fn try_install(app: &AppHandle, gate: &Arc<ActivityGate>, update: &Update, bytes: &[u8]) {
    let Some(guard) = gate.try_begin_install() else {
        log::info!("fork updater: dictation started before install; polling again");
        return;
    };
    let idle = input_idle();
    if idle < REQUIRED_IDLE {
        drop(guard);
        log::info!(
            "fork updater: input {}s ago, before install; polling again",
            idle.as_secs()
        );
        return;
    }

    log::info!(
        "fork updater: installing {} after {}s idle; Handy restarts hidden",
        update.version,
        idle.as_secs()
    );
    match flush_then_install(app, update, bytes) {
        Ok(()) => app.restart(),
        Err(e) => {
            drop(guard);
            log::warn!("fork updater: {e}; polling again");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tauri_conf_updater() -> serde_json::Value {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        conf["plugins"]["updater"].clone()
    }

    #[test]
    fn fork_pubkey_matches_tauri_conf() {
        let updater = tauri_conf_updater();
        assert_eq!(updater["pubkey"].as_str().unwrap(), FORK_PUBKEY.trim());
    }

    #[test]
    fn fork_endpoint_is_only_config_endpoint() {
        let updater = tauri_conf_updater();
        let endpoints: Vec<&str> = updater["endpoints"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e.as_str().unwrap())
            .collect();
        assert_eq!(endpoints, vec![FORK_ENDPOINT]);
    }

    #[test]
    fn frontend_capabilities_grant_only_updater_check() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut updater_permissions = Vec::new();
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let capability: Value =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            for permission in capability["permissions"].as_array().unwrap() {
                let id = permission
                    .as_str()
                    .or_else(|| permission["identifier"].as_str())
                    .unwrap();
                if id.starts_with("updater:") {
                    updater_permissions.push(format!("{}: {id}", path.display()));
                }
            }
        }
        assert!(
            updater_permissions
                .iter()
                .all(|p| p.ends_with(": updater:allow-check")),
            "{updater_permissions:?}"
        );
        assert!(!updater_permissions.is_empty());
    }

    #[test]
    fn report_not_ok_when_config_differs() {
        let fork_endpoints = vec![FORK_ENDPOINT.to_string()];
        assert_eq!(report(&fork_endpoints, FORK_PUBKEY)["ok"], true);

        let upstream = vec![
            "https://github.com/someone-else/Handy/releases/latest/download/latest.json".to_string(),
        ];
        assert_eq!(report(&upstream, FORK_PUBKEY)["ok"], false);

        let extra = vec![FORK_ENDPOINT.to_string(), upstream[0].clone()];
        assert_eq!(report(&extra, FORK_PUBKEY)["ok"], false);

        assert_eq!(report(&[], FORK_PUBKEY)["ok"], false);
        assert_eq!(report(&fork_endpoints, "other-key")["ok"], false);
        assert_eq!(report(&fork_endpoints, "")["ok"], false);
    }

    const IDLE_ENOUGH: Duration = REQUIRED_IDLE;
    const NOT_IDLE: Duration = Duration::from_secs(599);

    #[test]
    fn next_step_on_check_error_waits() {
        for downloaded in [false, true] {
            for gate_free in [false, true] {
                for idle in [Duration::ZERO, NOT_IDLE, IDLE_ENOUGH, CHECK_INTERVAL] {
                    assert_eq!(
                        next_step(downloaded, true, idle, gate_free),
                        Step::WaitInterval,
                        "downloaded={downloaded} gate_free={gate_free} idle={idle:?}"
                    );
                }
            }
        }
        assert_eq!(
            next_step(false, false, IDLE_ENOUGH, true),
            Step::WaitInterval
        );
    }

    #[test]
    fn next_step_waits_for_ten_minutes_idle() {
        assert_eq!(REQUIRED_IDLE, Duration::from_secs(600));
        assert_eq!(next_step(true, false, Duration::ZERO, true), Step::PollIdle);
        assert_eq!(next_step(true, false, NOT_IDLE, true), Step::PollIdle);
        assert_eq!(next_step(true, false, IDLE_ENOUGH, true), Step::Install);
        assert_eq!(next_step(true, false, CHECK_INTERVAL, true), Step::Install);
    }

    #[test]
    fn next_step_polls_when_gate_busy_even_if_idle() {
        assert_eq!(next_step(true, false, IDLE_ENOUGH, false), Step::PollIdle);
        assert_eq!(
            next_step(true, false, CHECK_INTERVAL, false),
            Step::PollIdle
        );
    }

    const SERVICE_CHILD_ENV: &str = "HANDY_FORK_UPDATER_TEST_CHILD";
    const SERVICE_TEST: &str = "fork_updater::tests::service_disabled_for_portable_or_opt_out";

    fn run_service_child(mode: &str, forced_off: bool) {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", SERVICE_TEST, "--test-threads=1"])
            .env(SERVICE_CHILD_ENV, mode);
        if forced_off {
            command.env("HANDY_DISABLE_UPDATER", "1");
        } else {
            command.env_remove("HANDY_DISABLE_UPDATER");
        }
        let output = command.output().unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success() && stdout.contains("test result: ok. 1 passed"),
            "child {mode} failed: {stdout}{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn service_disabled_for_portable_or_opt_out() {
        let normal = settings::get_default_settings();
        let mut opted_out = settings::get_default_settings();
        opted_out.update_checks_enabled = false;

        match std::env::var(SERVICE_CHILD_ENV).as_deref() {
            Ok("forced_off") => {
                assert!(settings::update_checks_forced_disabled());
                assert!(!service_enabled(&normal, false));
            }
            Ok("normal") => {
                assert!(!settings::update_checks_forced_disabled());
                assert!(service_enabled(&normal, false));
                assert!(!service_enabled(&normal, true));
            }
            _ => {
                assert!(!service_enabled(&normal, true));
                assert!(!service_enabled(&opted_out, false));
                assert!(!service_enabled(&opted_out, true));
                run_service_child("forced_off", true);
                run_service_child("normal", false);
            }
        }
    }
}
