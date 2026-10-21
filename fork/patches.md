# Fork patches

Carried on top of upstream cjpais/Handy v0.9.8 (see `base.json`).

- fix: close the settings window instead of hiding it — carried — a hidden settings window keeps its WebView2 renderer resident while Handy sits in the tray; not upstream at v0.9.8.
- fork: identity (endpoint, key, no Authenticode) and config guard — carried — the app must trust only the fork's releases.
- fork: ActivityGate, single updater path, idle-gated background updater — carried — self-updates must never interrupt dictation.
- fork: release scripts and fork-release.yml — carried — rebuilds and publishes on every upstream release.

First release `v0.9.8-jw.1` was installed over stock 0.9.8 on 2026-10-21 (backup in `D:\Backups\handy-2026-10-21`).

## Baseline at v0.9.8

Measured on `jw` with the patch above applied; it adds and removes no tests.

- `cargo test` (src-tauri): 274 passed; 0 failed; 0 ignored.
- `cargo fmt --check`: clean.
- `bun run lint`: clean.
- Release build warnings in upstream code: unused import `Emitter` (src/secure_input.rs:23); unused assignment `model_takes_initial_prompt` (src/managers/transcription.rs:1249).
