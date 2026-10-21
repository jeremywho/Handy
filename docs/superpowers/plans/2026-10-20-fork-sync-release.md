# Self-updating Handy fork: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** jeremywho/Handy carries Jeremy's commits on top of each upstream Handy release, publishes a signed Windows build automatically, and his installed copy updates itself while he isn't using the machine.

**Architecture:**
- **Branch:** `jw` is the fork's default branch, based on upstream's release tags.
- **Release workflow:** one GitHub workflow, `fork-release.yml`, does the plan, test, build, sign and publish steps. Small Node scripts in `fork/scripts/` hold all the decision logic so it can be unit-tested.
- **In the app:** an `ActivityGate` keeps installs from interrupting a dictation. A single `fork_updater` module builds every updater and runs the background service.
- **Monitoring:** none beyond GitHub's failed-run emails and the Actions page; the owner dropped the Talon watch (Task 10).

**Tech Stack:** Tauri 2.11.5, `tauri-plugin-updater` 2.10.1, `@tauri-apps/cli` 2.11.4, Rust, React/TypeScript, Bun, Node 22 (scripts use only built-in modules), GitHub Actions, NSIS.

**Spec:** `docs/superpowers/specs/2026-10-20-fork-sync-release-design.md`.

## Global Constraints

- Fork: `jeremywho/Handy`. Branch: `jw`. Upstream: `cjpais/Handy`.
- First base: tag `v0.9.8` = `14f6f0d31cb22a4268acfbddba3052820fd0a06e`.
- Updater endpoint, exactly one entry:
  `https://github.com/jeremywho/Handy/releases/latest/download/latest.json`.
- Version: `X.Y.Z-jw.N`. Tag: `vX.Y.Z-jw.N`. `N` starts at 1 per base.
- Bundle: NSIS only, target `x86_64-pc-windows-msvc`. Build with `--bundles nsis --no-sign`.
- Identity:
  - Unchanged: `identifier` `com.pais.handy`, `productName` `Handy`, NSIS publisher `pais`.
  - Uninstall key: `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Handy`.
- Schedules:
  - The upstream check runs every 6 hours.
  - The app checks at startup, then every 4 hours.
  - An automatic install waits for 10 minutes without input, and Handy restarts hidden (`--start-hidden`).
- Secrets:
  - GitHub environment `release` holds `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
  - Backups go in the 1Password vault "Private".
- **No push, no token (R30):** the workflow never pushes `jw` and never creates a ref to a new commit.
  - Each run takes the fork's commits `fork/base.json.sha..jw`. If upstream's latest release is newer than `fork/base.json`, it rebases them in the runner onto that release's tag; otherwise the candidate is `jw`'s head as it is. It tests, builds, signs and publishes that candidate.
  - The release tag goes on `jw`'s existing head (`preRebaseHead`) through the API with `GITHUB_TOKEN` (`contents: write`). `provenance.json` records `{version, sourceSha, preRebaseHead, baseTag, baseSha, stampHash, installerSha256, runId}`.
  - `jw` and `fork/base.json` move only when Jeremy pushes from his machine.
- Third-party actions are pinned by full commit SHA.
- Build locally from `D:\Data\...`, never `C:\Data\...`; that path is a junction and Vite rejects it.

## Review Focus

1. **Upstream tag doesn't match its app version** (for example, tag `v0.9.9` while `tauri.conf.json` says `0.9.9-rc1`). The run must stop, not publish a misnumbered release. Test: Task 8 `decide` fixture `tag-version-mismatch`.
2. **A crashed run left a draft or tag behind, and upstream ships a new release before the next run.** Reconcile must resume or clean up the old candidate first, never reuse its `N`. Test: Task 8 fixture `stale-draft-plus-new-upstream`.
3. **Jeremy starts dictating between the idle check and the install.** The recording is refused with a message, never cut off. Test: Task 4 `acquire_refused_while_installing`.
4. **Offline or asleep when the 4-hourly check fires.** The service logs, waits for the next interval, and never stops or crashes. Test: Task 7 `next_step_on_check_error_waits`.
5. **Portable install, or updates disabled by setting or environment variable.** The background service must not install anything. Test: Task 7 `service_disabled_for_portable_or_opt_out`.

---

### Task 1: Bootstrap `jw` on v0.9.8 and re-apply the window fix

**Files:**
- Create the worktree `D:\Data\Repos\.worktrees\Handy\jw` (branch `jw`, from tag `v0.9.8`).
- Create `fork/base.json` and `fork/patches.md`.
- Modify `src-tauri/src/lib.rs`: re-apply commit 2e3b3c0 by hand. Cherry-picking it onto v0.9.8 conflicts in this file.
- Carry over the spec and this plan from branch `free-hidden-main-window`.

**Interfaces:**
- Produces `fork/base.json`:
  ```json
  {
    "upstream": "cjpais/Handy",
    "tag": "v0.9.8",
    "sha": "14f6f0d31cb22a4268acfbddba3052820fd0a06e"
  }
  ```
- Produces `fork/patches.md`: one line per carried commit, in the form `- <title> — carried — <why>`.

- [ ] **Step 1:** Create the worktree.
  - Run: `git -C C:\Data\Repos\Handy fetch origin tag v0.9.8`
  - Run: `git -C C:\Data\Repos\Handy worktree add D:\Data\Repos\.worktrees\Handy\jw -b jw v0.9.8`
  - Expected: `HEAD is now at 14f6f0d`.
- [ ] **Step 2:** Carry over the documents.
  - Run: `git cherry-pick a7d1ea4` (the spec), plus the plan's commit.
  - Expected: no conflicts. These commits touch `docs/` only.
- [ ] **Step 3:** Re-apply 2e3b3c0's three changes to the v0.9.8 `lib.rs`:
  1. Split out `build_main_window(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow>`. `show_main_window` rebuilds the window when it is missing, and applies the theme.
  2. `CloseRequested` on `"main"` resumes shortcuts and lets the close go through.
  3. `RunEvent::ExitRequested { code: None, .. }` calls `prevent_exit()`.

  Use `git show 2e3b3c0` as the reference.
- [ ] **Step 4:** Build. Copy the `portable` marker file into `target\release`. Run `D:\Data\Repos\.worktrees\Handy\_test` scripts:
  - Expected: closing the window frees one renderer process.
  - Expected: reopening (relaunching the exe) rebuilds the window.
  - Expected: after starting a shortcut capture and then closing the window, Ctrl+Space starts a recording.
  - Quit the installed Handy before running the test, and restart it afterwards.
- [ ] **Step 5:** Run `cargo test` in `src-tauri`, `cargo fmt --check` and `bun run lint`.
  - Expected: all pass. The baseline at v0.9.8 is whatever it reports. Record it in `fork/patches.md`.
- [ ] **Step 6:** Write `fork/base.json` and `fork/patches.md`, then commit with the message `fork: carry the settings-window close fix onto v0.9.8`.

### Task 2: Fork identity, signing key and config guard

**Files:**
- Create `fork/updater.pub`. It is the only source of the public key, as the base64 string `tauri signer generate` outputs.
- Create `fork/identity.json`:
  ```json
  {
    "endpoint": "https://github.com/jeremywho/Handy/releases/latest/download/latest.json",
    "identifier": "com.pais.handy",
    "productName": "Handy",
    "publisher": "pais"
  }
  ```
- Create `fork/scripts/check-config.mjs`, with tests in `fork/scripts/check-config.test.mjs`.
- Modify `src-tauri/tauri.conf.json`:
  - set `plugins.updater.endpoints` to the fork endpoint
  - set `plugins.updater.pubkey` to the contents of `fork/updater.pub`
  - delete `bundle.windows.signCommand`.
- Modify `src/components/update-checker/portableInstaller.ts`: set `PORTABLE_RELEASES_URL` to `https://github.com/jeremywho/Handy/releases/latest`.

**Interfaces:**
- Produces `checkConfig({ baseConf, windowsConf, identity, pubkey, expectedVersion }) -> string[]`. It returns the list of violations; an empty list means pass.
- Produces `scanSources(rootDir) -> string[]`. It returns every file under `src/` and `src-tauri/src/` that contains `cjpais/Handy/releases`.
- CLI: `node fork/scripts/check-config.mjs [--version X.Y.Z-jw.N]` runs both `checkConfig` and `scanSources`. It exits 1 and prints the violations.

- [ ] **Step 1:** Generate the key.
  - Run: `bun run tauri signer generate -w D:\Data\Repos\.worktrees\Handy\_keys\fork.key`
  - Enter a strong password when it asks.
  - Put the private key file and the password into 1Password vault "Private" with one `op item create`.
  - Write the public key to `fork/updater.pub`.
  - `_keys` must stay outside every repo.
- [ ] **Step 2:** Check the backup works. Run `bun run tauri signer sign -f <key from 1Password> -p <pw> fork/identity.json`.
  - Expected: a `.sig` file is written. Delete it afterwards.
- [ ] **Step 3:** Write the failing tests, then run `node --test fork/scripts/`. Expected: FAIL.

  ```js
  test('passes the fork config', () => assert.deepEqual(checkConfig(okFixture), []));
  test('flags upstream endpoint in the windows overlay', () =>
    assert.match(checkConfig({...okFixture, windowsConf: {plugins:{updater:{endpoints:['https://github.com/cjpais/Handy/releases/latest/download/latest.json']}}}}).join(), /endpoint/));
  test('flags a second endpoint', ...);              // endpoints.length must be 1
  test('flags a pubkey that is not fork/updater.pub', ...);
  test('flags signCommand present', ...);
  test('flags identifier or productName change', ...);
  test('flags version mismatch when expectedVersion given', ...);
  test('scanSources finds a planted cjpais/Handy/releases string', ...);
  ```
- [ ] **Step 4:** Implement `check-config.mjs`. Merge `windowsConf` over `baseConf` with a JSON merge-patch (RFC 7396: objects merge, everything else replaces), which matches how Tauri merges platform config.
- [ ] **Step 5:** Make the edits to `tauri.conf.json` and `portableInstaller.ts`.
  - Run: `node --test fork/scripts/`
  - Run: `node fork/scripts/check-config.mjs`
  - Expected: PASS, and exit 0.
- [ ] **Step 6:** Commit with the message `fork: identity (endpoint, key, no Authenticode) and config guard`.

### Task 3: Version computation and stamping

**Files:**
- Create `fork/scripts/version.mjs`, with tests in `version.test.mjs`.

**Interfaces:**
- Produces `nextVersion(baseVersion: string, existingTags: string[]) -> string`. For example, `('0.9.8', ['v0.9.8-jw.1','v0.9.8-jw.3','v0.9.7-jw.9'])` returns `'0.9.8-jw.4'`.
- Produces `stamp(rootDir, version) -> void`. It writes the version into:
  - `src-tauri/tauri.conf.json` `version`
  - `src-tauri/Cargo.toml` `[package] version`
  - `package.json` `version`

  It edits text in place, not by re-serializing, so the files' formatting survives.
- Produces `readStamped(rootDir) -> {conf, cargo, pkg}`.
- CLI: `node fork/scripts/version.mjs stamp <version>`. It prints the SHA-256 of `version.mjs` itself, which goes into provenance.

- [ ] **Step 1:** Write the failing tests, then run `node --test`. Expected: FAIL.

  ```js
  test('first release on a base is jw.1', () => assert.equal(nextVersion('0.9.9', ['v0.9.8-jw.2']), '0.9.9-jw.1'));
  test('increments past the highest N, ignoring other bases', ...);   // example above → 0.9.8-jw.4
  test('ignores non-fork tags', () => assert.equal(nextVersion('0.9.8', ['v0.9.8']), '0.9.8-jw.1'));
  test('stamp writes all three files and readStamped agrees', ...);   // on a temp copy of the three files
  test('stamp leaves Cargo.toml dependency versions untouched', ...);
  ```
- [ ] **Step 2:** Implement it. Then run `node --test fork/scripts/`. Expected: PASS.
- [ ] **Step 3:** Commit with the message `fork: version computation and stamping`.

### Task 4: `ActivityGate`

**Files:**
- Create `src-tauri/src/activity_gate.rs`, with unit tests in the same file.
- Modify `src-tauri/src/lib.rs`: add `mod activity_gate;` and `.manage(activity_gate::ActivityGate::new())`.

**Interfaces:**
- Produces:
  ```rust
  pub struct ActivityGate { /* Mutex<GateState{active: usize, installing: bool}>, dictation: Mutex<Option<ActivityPermit>> */ }
  pub struct ActivityPermit;      // releases on Drop
  pub struct InstallGuard;        // clears `installing` on Drop
  pub struct InstallInProgress;   // error type
  impl ActivityGate {
      pub fn new() -> Arc<ActivityGate>;
      pub fn try_acquire(self: &Arc<Self>) -> Result<ActivityPermit, InstallInProgress>;
      pub fn try_begin_install(self: &Arc<Self>) -> Option<InstallGuard>; // Some only when active == 0 and not installing
      pub fn park_dictation(&self, permit: ActivityPermit);
      pub fn take_dictation(&self) -> Option<ActivityPermit>;
      pub fn drop_dictation(&self);
  }
  impl ActivityPermit { pub fn release_after(self, delay: Duration); } // drops on a spawned thread after `delay`
  ```

- [ ] **Step 1:** Write the failing tests. Run `cargo test activity_gate`. Expected: FAIL.

  ```rust
  #[test] fn install_refused_while_permit_held()      // acquire → try_begin_install is None
  #[test] fn install_allowed_after_permit_dropped()
  #[test] fn acquire_refused_while_installing()      // Review Focus 3
  #[test] fn install_guard_drop_reopens_gate()       // failed install must not wedge dictation
  #[test] fn parked_dictation_blocks_install_until_taken_and_dropped()
  #[test] fn release_after_holds_until_delay()       // 50 ms delay: blocked at 10 ms, free at 200 ms
  #[test] fn concurrent_acquire_and_install_never_both_succeed() // 8 threads × 1000 iterations; assert invariant
  ```
- [ ] **Step 2:** Implement it. Then run `cargo test activity_gate`. Expected: PASS.
- [ ] **Step 3:** Commit with the message `fork: ActivityGate for update-safe dictation`.

### Task 5: Route every transcription path through the gate

**Files:**
- Modify `src-tauri/src/transcription_coordinator.rs`, `fn start(app, binding_id, hotkey_string) -> bool`:
  - For transcribe bindings (`is_transcribe_binding`), call `gate.try_acquire()` before `action.start`.
  - On `Err`, emit the `recording-error` event with `error_type: "update_installing"` and return `false`.
  - On `Ok`, call `park_dictation`.
  - If recording did not begin, call `drop_dictation`.
- Modify `src-tauri/src/actions.rs`:
  - `TranscribeAction::stop` calls `take_dictation()` and moves the permit into the spawned task.
  - The task moves the permit into the `run_on_main_thread` paste closure. The permit drops after `utils::paste` returns.
  - When `settings.reliable_paste` is on, call `permit.release_after(paste_tx::RESTORE_TIMEOUT)` instead, because that paste settles asynchronously.
  - On early exits (empty transcription, error), the permit drops with the task.
- Modify `src-tauri/src/utils.rs`: `cancel_current_operation` calls `drop_dictation()`.
- Modify `src-tauri/src/commands/history.rs`: `retry_history_entry_transcription` takes a permit first, or returns `Err("An update is installing. Try again in a minute.")`.
- Modify `src/App.tsx`: add a branch for the `"update_installing"` error type, with a new i18n key `errors.updateInstalling` in `src/i18n/locales/en/translation.json`. Check that `bun run check:translations` passes.
- `paste_tx::RESTORE_TIMEOUT` is already `pub(crate)` at v0.9.8, so no change is needed there.

**Interfaces:**
- Consumes `ActivityGate` (Task 4) through `app.state::<Arc<ActivityGate>>()`.

- [ ] **Step 1:** Write the failing test in `transcription_coordinator.rs` tests: `start_refused_when_gate_installing_rolls_back_to_idle`.
  - Drive `CoordinatorState` with a start whose result is `false` because the gate is installing.
  - Assert `stage == Stage::Idle`.
  - Factor the gate check into `fn admit_start(gate: &Arc<ActivityGate>, binding_id: &str) -> Result<(), InstallInProgress>` so it is testable without an `AppHandle`.
- [ ] **Step 2:** Run `cargo test transcription_coordinator`. Expected: FAIL.
- [ ] **Step 3:** Make the edits listed above.
- [ ] **Step 4:** Run `cargo test`, `bun run lint` and `bun run check:translations`. Expected: all pass.
- [ ] **Step 5:** Manual check on the portable build:
  - With a debug-only command `debug_hold_install_gate` (registered only under `#[cfg(debug_assertions)]`) holding the gate for 20 s, Ctrl+Space shows the "update installing" toast and does not record.
  - After 20 s, dictation works.
  - A normal dictation still pastes.
- [ ] **Step 6:** Commit with the message `fork: dictation and history retry hold the activity gate`.

### Task 6: One updater construction path, self-test and manual install

**Files:**
- Create `src-tauri/src/fork_updater.rs`, with unit tests.
- Modify `src-tauri/src/cli.rs`: add `#[arg(long, value_name = "PATH")] pub fork_selftest: Option<PathBuf>`.
- Modify `src-tauri/src/lib.rs`:
  - add `mod fork_updater;`
  - add `fork_selftest.is_some()` to `headless_mode`
  - in the headless setup branch, handle it before the transcription path: call `fork_updater::write_selftest(&app_handle, &path)`, then `std::process::exit(code)`
  - register the `install_update_now` command in `collect_commands!`.
- Modify `src-tauri/capabilities/default.json`: replace `"updater:default"` with `"updater:allow-check"`.
- Modify `src/components/update-checker/UpdateChecker.tsx`: `installUpdate` calls `commands.installUpdateNow()` instead of `update.downloadAndInstall` and `relaunch`. Keep the portable branch.
- Regenerate `src/bindings.ts` with a debug build, the way upstream does it.

**Interfaces:**
- Produces:
  ```rust
  pub const FORK_ENDPOINT: &str = "https://github.com/jeremywho/Handy/releases/latest/download/latest.json";
  pub const FORK_PUBKEY: &str = include_str!("../../fork/updater.pub");      // trimmed at use
  pub enum Restart { Hidden, Normal }
  pub fn build_updater(app: &AppHandle, restart: Restart) -> Result<tauri_plugin_updater::Updater, String>;
      // endpoints(vec![FORK_ENDPOINT]) + pubkey(FORK_PUBKEY); Hidden adds .installer_arg("--start-hidden")
  pub fn selftest_report(app: &AppHandle) -> serde_json::Value;
      // {"endpoint": FORK_ENDPOINT, "pubkey": FORK_PUBKEY, "config_endpoints": [...], "config_pubkey": "...", "ok": bool}
  pub fn write_selftest(app: &AppHandle, path: &Path) -> i32;   // writes JSON, returns 0 if ok else 3
  #[tauri::command] #[specta::specta]
  pub async fn install_update_now(app: AppHandle) -> Result<(), String>;
      // check → download → gate.try_begin_install() (Err "Handy is busy" if None) → install (process exits)
  ```
- The self-test writes to a file, not stdout. Release builds use `windows_subsystem = "windows"` and have no console.

- [ ] **Step 1:** Write the failing tests, then run `cargo test fork_updater`. Expected: FAIL.

  ```rust
  #[test] fn fork_pubkey_matches_tauri_conf() // parse include_str!("../tauri.conf.json"); plugins.updater.pubkey == FORK_PUBKEY.trim()
  #[test] fn fork_endpoint_is_only_config_endpoint()
  #[test] fn report_not_ok_when_config_differs() // selftest_report logic factored into fn report(config_endpoints, config_pubkey) -> Value
  ```
- [ ] **Step 2:** Implement it. Run `cargo test`. Expected: PASS.
- [ ] **Step 3:** Build the portable release. Run `handy.exe --fork-selftest D:\...\_test\selftest.json` while the installed Handy is running.
  - Expected: exit code 0.
  - Expected: the JSON has `"ok": true` and the fork endpoint and key.
  - Expected: the running Handy is unaffected. The headless path skips the single-instance plugin.
- [ ] **Step 4:** Confirm the capability change took effect. In the portable build's devtools console, run `window.__TAURI_INTERNALS__.invoke('plugin:updater|download_and_install', ...)`. Expected: a permission error.
- [ ] **Step 5:** Commit with the message `fork: single updater construction path, self-test, gated manual install`.

### Task 7: Background update service

**Files:**
- Modify `src-tauri/src/fork_updater.rs`.
- Modify `src-tauri/Cargo.toml`: add `"Win32_UI_Input_KeyboardAndMouse"` and `"Win32_System_SystemInformation"` to the `windows` crate's features.
- Modify `src-tauri/src/lib.rs`: in the normal setup path, call `fork_updater::spawn_background(&app_handle)` after `initialize_core_logic`. Never call it in headless mode.

**Interfaces:**
- Produces:
  ```rust
  pub const CHECK_INTERVAL: Duration = Duration::from_secs(4 * 3600);
  pub const STARTUP_DELAY: Duration = Duration::from_secs(120);
  pub const REQUIRED_IDLE: Duration = Duration::from_secs(600);
  pub const IDLE_POLL: Duration = Duration::from_secs(30);
  pub fn service_enabled(settings: &AppSettings, portable: bool) -> bool;   // update_checks_effectively_enabled && !portable
  pub enum Step { WaitInterval, PollIdle, Install }
  pub fn next_step(downloaded: bool, check_failed: bool, idle: Duration, gate_free: bool) -> Step;
  pub fn input_idle() -> Duration;   // GetLastInputInfo vs GetTickCount; Duration::ZERO on error
  pub fn spawn_background(app: &AppHandle);
  ```
- The loop:
  1. Sleep for `STARTUP_DELAY`.
  2. Each cycle, skip if `!service_enabled`.
  3. Run `build_updater(app, Restart::Hidden)?.check()`.
  4. If there is an update, download it to memory and verify the signature (the plugin does this).
  5. Every `IDLE_POLL`, ask `next_step`. On `Install`, take `try_begin_install()`, re-check `input_idle() >= REQUIRED_IDLE`, save the settings store, then call `update.install(bytes)`. A successful install exits the process.
  6. On `Err` or a refused gate, drop the guard and keep polling.
  7. Any check or download error sends it back to `WaitInterval`.

- [ ] **Step 1:** Write the failing tests, then run `cargo test fork_updater`. Expected: FAIL.

  ```rust
  #[test] fn next_step_on_check_error_waits()                 // Review Focus 4
  #[test] fn next_step_waits_for_ten_minutes_idle()           // 599 s → PollIdle, 600 s + gate free → Install
  #[test] fn next_step_polls_when_gate_busy_even_if_idle()
  #[test] fn service_disabled_for_portable_or_opt_out()       // Review Focus 5, incl. HANDY env override path
  ```
- [ ] **Step 2:** Implement it. Run `cargo test`. Expected: PASS.
- [ ] **Step 3:** Commit with the message `fork: idle-gated background updater that restarts hidden`.
  - The end-to-end check that Handy really restarts hidden happens in Task 11. If the NSIS `/ARGS` forwarding does not carry `--start-hidden`, fall back to a marker file: write `fork-restart-hidden` in the app data directory before installing, and have startup read and delete it, treating it as `start_hidden`.

### Task 8: Release planning, signing and verification scripts

**Files:**
- Create `fork/scripts/plan.mjs`, `fork/scripts/manifest.mjs` and `fork/scripts/verify-sig.mjs`.
- Create tests for each, plus fixtures in `fork/scripts/fixtures/`.

**Interfaces:**
- `decide(state) -> Decision`. It is pure, with no I/O.

  The `state` argument:
  ```ts
  state = {
    base: {tag, sha},
    upstreamLatest: {tag, sha, confVersion},
    jwHead: sha,
    latestPublished: {version, sourceSha} | null,
    publicManifestVersion: string | null,  // version in releases/latest/download/latest.json
    drafts: [{id, tag, sourceSha}],
    forkTags: string[],
    upstreamWorkflowChanges: {added: string[], touchesForkRelease: bool},
    retagged: bool,
  }
  ```

  The `Decision` it returns:
  ```ts
  Decision =
    | {action: 'noop'}
    | {action: 'stop', reason: string}
    | {action: 'resume', draftId, version, sourceSha}
    | {action: 'rebase', onto: {tag, sha}, version}
    | {action: 'build', version}
  ```

  Rules, in order:
  1. `retagged` → stop.
  2. Upstream tag version ≠ `confVersion` → stop.
  3. A draft exists → resume it if its `sourceSha` equals `jwHead`, or equals the rebase candidate; otherwise stop and report the stale draft.
  4. `latestPublished` exists but `publicManifestVersion` ≠ its version (a published release with a broken public manifest) → build from `jwHead` with `nextVersion`. This is the spec's fix-forward to `N+1`.
  5. Upstream is newer than the base, and a workflow was added or `touchesForkRelease` → stop.
  6. Upstream is newer than the base → rebase, with version `nextVersion(newBase, forkTags)`.
  7. `jwHead` ≠ `latestPublished.sourceSha` → build.
  8. Otherwise → no-op.
- `rebaseChecks({mergesInRange: number, countBefore: number, countAfter: number}) -> string[]`. It returns the violations: merges present, or a dropped (emptied) commit.
- `buildManifest({version, url, signature, pubDate}) -> object`. It produces `latest.json` with both the `windows-x86_64` and `windows-x86_64-nsis` platform keys.
- `verifySig(fileBytes, sigFileText, pubkeyB64) -> boolean`.

  This is minisign verification using Node's crypto with no dependencies:
  - The pubkey and sig files are base64 of minisign text. Line 2 holds the payload.
  - Pubkey payload: algorithm (2 bytes) + key ID (8) + Ed25519 key (32).
  - Sig payload: algorithm `Ed` or `ED` + key ID (8) + signature (64). `ED` means the message is BLAKE2b-512 of the file (`crypto.createHash('blake2b512')`).
  - Check that the key IDs match.
  - Also verify the global signature (line 4) over `signature || trusted comment text`.
  - Use `crypto.verify(null, msg, KeyObject(ed25519 raw), sig)`.

- [ ] **Step 1:** Write the failing tests.
  - `plan.test.mjs`: one test per rule, using the fixtures:
    - `noop`, `jw-push`
    - `new-upstream`, `new-upstream-adds-workflow`
    - `tag-version-mismatch` (Review Focus 1)
    - `retagged`
    - `stale-draft-plus-new-upstream` (Review Focus 2): expect `stop`
    - `draft-matching-head`: expect `resume` with the draft's version.
    - `broken-public-manifest`: expect `build` with `N+1`.
  - `manifest.test.mjs`: both platform keys, the exact URL and the version.
  - `verify-sig.test.mjs`: a real signature passes, a flipped byte fails, a key from another file fails.
    - The fixtures `fixtures/sample.bin`, `.sig` and `.pub` come from signing with a throwaway key: `bun run tauri signer generate --ci -w fixtures/test.key` with no password, then `tauri signer sign`.
    - Commit the throwaway key; it is test-only.
- [ ] **Step 2:** Run `node --test fork/scripts/`. Expected: FAIL.
- [ ] **Step 3:** Implement the three scripts, plus thin CLI wrappers.
  - `node fork/scripts/plan.mjs` reads state from the GitHub API and git using `GH_TOKEN`, with 3 retries that honour `retry-after` and `x-ratelimit-reset`. It writes the decision JSON to `$GITHUB_OUTPUT`.
  - `node fork/scripts/verify-sig.mjs <file> <sig> <pubfile>` exits 0 on a valid signature and 1 otherwise.
- [ ] **Step 4:** Run `node --test fork/scripts/`. Expected: PASS.
- [ ] **Step 5:** Positive control: run `verify-sig.mjs` on the real stock asset, against the fork key.
  - Download `Handy_0.9.8_x64-setup.exe` and its signature from upstream's `latest.json`.
  - Expected: exit 1, because the fork key rejects stock.
  - Against upstream's pubkey from the v0.9.8 `tauri.conf.json`, expected: exit 0.
- [ ] **Step 6:** Commit with the message `fork: release planning, manifest and signature verification`.

### Task 9: `fork-release.yml`

**Files:**
- Create `.github/workflows/fork-release.yml`.

**Interfaces:**
- Consumes Tasks 2, 3 and 8 scripts by path. The decision JSON's fields become job outputs.

The workflow:
- **Triggers:** `schedule: cron '17 */6 * * *'`, `workflow_dispatch`, `push: branches: [jw]`.
- **Concurrency:** `group: fork-release`, `cancel-in-progress: false`.
- **Jobs:**
  1. **`admin`** (ubuntu, `actions: write`):
     - List the repo's workflows and disable every one whose path is not `.github/workflows/fork-release.yml`.
  2. **`plan`** (ubuntu, `contents: read`):
     - `fetch-depth: 0`.
     - Fetch upstream tags into `refs/upstream-tags/*`.
     - Run `plan.mjs`.
     - On `rebase`:
       - Run `git rebase --onto <sha> <base.sha> jw`. Check that `git rev-list --merges` over the range is empty beforehand.
       - Run `rebaseChecks`. Nothing rewrites `fork/base.json`; provenance records the base.
     - Write a git bundle of the candidate as an artifact, plus a `candidate.json` artifact: `{sha, version, baseTag, baseSha, decision}`.
     - On `stop`, fail with the reason. On `noop`, end green with `release=false`.
     - Put the upstream `build.yml` diff in the step summary when it changed.
  3. **`test`** (`windows-latest`, `contents: read`, `if: release`):
     - Unbundle, then check `git rev-parse HEAD == candidate.sha`.
     - Run `version.mjs stamp`.
     - Run `cargo test`, `bun run lint`, `bun run test:keyboard`, `bun run check:translations`, `bun run test:playwright` and `node --test fork/scripts/`.
  4. **`build`** (`windows-latest`, `contents: read`, `if: release`):
     - Unbundle, check the SHA, then stamp.
     - Run `check-config.mjs --version`.
     - Copy upstream `build.yml`'s Windows steps: `humbletim/install-vulkan-sdk`, the VC++ runtime staging, SPIRV-Headers, Bun and Rust setup.
     - Run `bun run tauri build --bundles nsis --no-sign`.
     - Extract `handy.exe` from the installer with 7-Zip and run `--fork-selftest selftest.json`. Require `ok: true`.
     - Check the installer's uninstall key values: the NSIS script defines `PUBLISHER=pais` and `PRODUCTNAME=Handy`; grep the compiled `installer.nsi` that `target/release/nsis/x64/` holds.
     - Upload the installer and its SHA-256 as an artifact.
  5. **`sign`** (ubuntu, `environment: release`, `contents: read`, `if: release && github.ref == 'refs/heads/jw' && contains('push schedule workflow_dispatch', github.event_name)`):
     - Download the artifact and check its hash.
     - Install the signer in a temp directory: `npm i --no-save --ignore-scripts @tauri-apps/cli@2.11.4`.
     - Run `tauri signer sign`.
     - Run `verify-sig.mjs` against `fork/updater.pub`.
     - Check that upstream's latest Windows signature fails against the fork key.
     - Run `buildManifest`.
     - Write `provenance.json`: candidate and base SHAs, version, the stamp script's SHA-256, the installer's SHA-256 and `run_id`.
  6. **`publish`** (ubuntu, no environment, `contents: write`, `needs: [sign, test]`):
     1. (Dropped by R30: no push of `jw`.)
     2. Create tag `vVERSION` on `jw`'s head (`preRebaseHead`) with `POST git/refs` and `GITHUB_TOKEN`; accept it if it already points there, fail if it points elsewhere.
     3. Create a draft release on that tag. Upload the installer, `.sig`, `latest.json` and `provenance.json`.
     4. Download them back and re-check the hashes and the signature.
     5. Promote the release with `draft=false`, `prerelease=false`, `make_latest=true`.
     6. Read the release back. Fetch the public `releases/latest/download/latest.json` and require its version to equal `VERSION`.
     - On a resume decision, skip to the step the draft reached.

- [ ] **Step 1:** Write the workflow.
  - Pin every `uses:` to a SHA with `gh api repos/<owner>/<action>/commits/<tag> --jq .sha`.
  - Run `actionlint .github/workflows/fork-release.yml` (install with `winget install rhysd.actionlint`). Expected: no errors.
- [ ] **Step 2:** Commit with the message `fork: release workflow`. Its real check is Task 11's first run.

### Task 10: Talon watch (dropped by the owner)

**Dropped.** The owner judged a monitor overkill; failures show in GitHub's failed-run emails and on the Actions page. Do not implement the steps below.

**Files:**
- Create `C:\Users\Jeremy\handy-fork-watch\watch.mjs`, `watch.test.mjs` and `fixtures\`.
- Register the Task Scheduler task "Handy Fork Watch".

**Interfaces:**
- Produces `evaluate({runs, latestRelease, installedVersion, now, lastChecked}) -> {alerts: string[]}`. It is pure, with no I/O.
- Data sources:
  - `runs`: `gh api repos/jeremywho/Handy/actions/workflows/fork-release.yml/runs?per_page=50`
  - the latest release: `gh api repos/jeremywho/Handy/releases/latest`
  - `installedVersion`: `DisplayVersion` from the uninstall key above, read with `reg query`.
- Copy the `notify()` helper pattern from `C:\Users\Jeremy\racknerd-watch\watch.mjs`: it pushes with `hactl.py call notify.mobile_app_iphone_jeremy` and falls back to `msg.exe`.
- A crash in the watch itself pushes "Handy fork watch is BROKEN".
- Flags: `--dry-run` and `--test-notify`. State is kept in `state.json`, which tracks `lastChecked`.

- [ ] **Step 1:** Write the failing tests, then run `node --test`. Expected: FAIL.

  ```js
  test('alerts when last success older than 36 h', ...);
  test('alerts on any failure or skipped-for-review since lastChecked', ...);
  test('alerts when installed lags latest release published > 24 h ago', ...);
  test('no alert when installed lags a release published 2 h ago', ...);
  test('no alerts on a healthy fixture', ...);
  ```
- [ ] **Step 2:** Implement it. Run `node --test`. Expected: PASS.
- [ ] **Step 3:** Register the task.
  - Command: `conhost.exe --headless "C:\nvm4w\nodejs\node.exe" "C:\Users\Jeremy\handy-fork-watch\watch.mjs"`
  - Schedule: daily at 9:41 AM Central, with `StartWhenAvailable`.
  - Run: `node watch.mjs --test-notify`. Expected: Jeremy confirms the push reached his phone.
- [ ] **Step 4:** Commit to a new local git repo in that folder.

### Task 11: Fork setup, first release, switch-over and end-to-end checks

**Steps that only Jeremy can do** are marked **(Jeremy)**. Each one comes to him as an exact command or click path.

- [ ] **Step 1:** Push `jw` and make it the default branch. The first push of `jw` triggers one `fork-release` run, which fails fast at the `sign` job until the `release` secrets exist; cancel it.
  - Run: `git push fork jw`
  - Run: `gh repo edit jeremywho/Handy --default-branch jw`
  - Run: `gh run list -R jeremywho/Handy`. Expected: exactly one `fork-release` run, from the push. Without the `release` secrets it fails at `sign` with "release environment secrets missing".
  - Cancel it: `gh run cancel <run-id> -R jeremywho/Handy`.
- [ ] **Step 2:** Disable every workflow except `fork-release.yml`, and make sure its schedule is active.
  - Run: `gh workflow list --all` then `gh workflow disable <id>` for each.
  - Expected: `gh workflow list` shows only `fork-release` active.
  - jeremywho/Handy is a GitHub fork, and GitHub may hold scheduled workflows in forks until they are enabled by hand. Run: `gh api repos/jeremywho/Handy/actions/workflows/fork-release.yml --jq .state`. Expected: `active`.
  - If it is not `active`, run: `gh workflow enable fork-release.yml -R jeremywho/Handy`, then run the `gh api` check again. Expected: `active`.
- [ ] **Step 3:** (Dropped: under R30 there is no personal access token.)
- [ ] **Step 4:** Create the environment `release` and set its secrets from 1Password with `op read`.
  - Run: `gh secret set --env release`.
  - Expected: `gh secret list --env release` shows 2.
- [ ] **Step 5:** Run `gh workflow run fork-release.yml --ref jw` and watch it with `gh run watch`.
  - Expected: green, and release `v0.9.8-jw.1` is marked latest.
  - Expected: the public `latest.json` says `0.9.8-jw.1`.
  - Fix any failure at the root. Re-runs go through the reconcile path.
- [ ] **Step 6: (Jeremy)** Switch over.
  1. Quit Handy from the tray.
  2. Back up the data. Run: `Copy-Item -Recurse $env:APPDATA\com.pais.handy D:\Backups\handy-<date>\`, plus the Hugging Face cache path from Handy's model settings.
  3. Download and run `Handy_0.9.8-jw.1_x64-setup.exe`. SmartScreen will warn: choose More info → Run anyway.
  4. Choose "uninstall before installing" and leave "delete app data" unticked.

  Then I check:
  - the About screen shows `0.9.8-jw.1`
  - the history and the model are present
  - `handy.exe --fork-selftest <path>` exits 0, and the JSON it writes to `<path>` has `ok: true`
  - dictation works.

  Restore procedure if anything is wrong: spec §Switch-over step 5.
- [ ] **Step 7:** End-to-end update test.
  - Push a trivial commit to `jw`, a `fork/patches.md` note. Expected: `v0.9.8-jw.2` is published.
  - Leave Talon idle for 10 minutes or more, within 4 hours. Or restart Handy to trigger the startup check: the check runs after 120 s, then waits for idle.
  - Expected: `DisplayVersion` becomes `0.9.8-jw.2`.
  - Expected: Handy is running, its window is not shown, and the tray icon is present.
  - Record whether SmartScreen appeared. That settles the spec's open question.
  - If Handy came back with its window open, apply the Task 7 marker fallback and repeat this step.
- [ ] **Step 8:** Confirm the schedule fires.
  - The cron runs every 6 hours, so about 6 hours after the first release in Step 5, run: `gh run list -R jeremywho/Handy --workflow fork-release.yml --event schedule`. Expected: at least one run. If none has appeared, re-run Step 2's check: `gh api repos/jeremywho/Handy/actions/workflows/fork-release.yml --jq .state` must print `active`.
- [ ] **Step 9:** Update the project memory and `fork/patches.md` with what Steps 5 to 7 showed.
