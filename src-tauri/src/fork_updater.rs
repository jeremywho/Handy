use std::io::Write;
use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_updater::{Updater, UpdaterExt};

use crate::activity_gate::ActivityGate;
use crate::settings;

pub const FORK_ENDPOINT: &str =
    "https://github.com/jeremywho/Handy/releases/latest/download/latest.json";
pub const FORK_PUBKEY: &str = include_str!("../../fork/updater.pub");

const SELFTEST_FAILED: i32 = 3;

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

#[tauri::command]
#[specta::specta]
pub async fn install_update_now(app: AppHandle) -> Result<(), String> {
    if crate::portable::is_portable() {
        return Err("Portable installs update manually from the releases page.".to_string());
    }
    if !settings::update_checks_effectively_enabled(&settings::get_settings(&app)) {
        return Err("Update checks are disabled.".to_string());
    }

    let updater = build_updater(&app, Restart::Normal)?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|e| format!("Update check failed: {e}"))?
    else {
        return Ok(());
    };
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| format!("Update download failed: {e}"))?;

    let gate = app.state::<Arc<ActivityGate>>();
    let _install_guard = gate
        .try_begin_install()
        .ok_or_else(|| "Handy is busy. Try again when dictation finishes.".to_string())?;
    update
        .install(bytes)
        .map_err(|e| format!("Update install failed: {e}"))?;
    app.restart()
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
            "https://github.com/cjpais/Handy/releases/latest/download/latest.json".to_string(),
        ];
        assert_eq!(report(&upstream, FORK_PUBKEY)["ok"], false);

        let extra = vec![FORK_ENDPOINT.to_string(), upstream[0].clone()];
        assert_eq!(report(&extra, FORK_PUBKEY)["ok"], false);

        assert_eq!(report(&[], FORK_PUBKEY)["ok"], false);
        assert_eq!(report(&fork_endpoints, "other-key")["ok"], false);
        assert_eq!(report(&fork_endpoints, "")["ok"], false);
    }
}
