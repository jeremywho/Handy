# jeremywho/Handy: personal fork that tracks upstream and updates itself

Date: 2026-10-20 (US Central). Status: revised after Codex review rounds 1
and 2 (final).

## Intent

Jeremy uses Handy (cjpais/Handy, MIT) every day for offline dictation into
Claude Code on one Windows 11 x64 machine. He wants a personal fork that
carries his own changes, now and in the future, on top of upstream Handy.
The fork follows each upstream release automatically and keeps his installed
copy current without manual steps. The first carried change is commit
2e3b3c0, "fix: close the settings window instead of hiding it". It was
written against upstream `main`, not a release tag. He has decided not to
send it upstream.

Success: upstream ships vX.Y.Z. Usually within hours, and with no action from
Jeremy, the fork publishes a release with his commits on top. His running
Handy then installs that release by itself and keeps working. When anything
goes wrong, nothing is published and the run fails on GitHub.

## Goals

1. Detect new upstream releases (not commits on upstream `main`).
2. Replay the fork's own commits onto the new upstream release tag, build the
   Windows x64 installer, and publish it as a fork release.
3. Pushing a new commit to the fork's branch also builds and publishes, so
   his changes do not wait for upstream.
4. The installed app finds updates on the fork's releases only, and installs
   them without a click, only when no dictation is in flight.
5. Fail loudly. A failed replay, test, build or publish leaves the last good
   release as the update target and fails the run.

## Non-goals

- macOS, Linux and Windows ARM builds.
- Authenticode code signing. It needs cjpais's Azure account, so fork
  installers are unsigned.
- Sending changes upstream.
- Tracking upstream `main` between releases.
- Automated GUI tests on CI runners.

## Anti-goals (a failure even if it technically works)

- The installed app trusting or installing stock upstream Handy and silently
  losing the fork's commits.
- Publishing a build whose commits only partly applied, one that failed
  tests, or one whose source is not the tested commit.
- An update interrupting a recording, a transcription, or a paste in
  progress.
- Losing settings, models or history on the switch from stock to fork, or on
  any update.
- Upstream workflows running in the fork, or getting at the signing key.

## Facts read from the source (upstream `main` 93c9ee0 and tag v0.9.8)

- `src-tauri/tauri.conf.json`:
  - `identifier` `com.pais.handy` and `version` `0.9.8` (lines 3 to 5)
  - `createUpdaterArtifacts: true` (line 28)
  - the Windows `signCommand` runs `trusted-signing-cli` against cjpais's
    Azure account (line 73)
  - the updater endpoint is cjpais's `releases/latest/download/latest.json`,
    with his `pubkey` (lines 81 to 85).
- `src-tauri/tauri.windows.conf.json` is a Windows overlay. It currently sets
  only bundle resources, but Tauri merges it over the base config, so a
  future upstream change there could override updater settings.
- The version is also set in `src-tauri/Cargo.toml` line 3 and
  `package.json` line 4.
- The custom NSIS installer (`src-tauri/nsis/installer.nsi`, lines 285 to
  312) compares semver against the installed `DisplayVersion` and treats a
  lower version as a downgrade.
- Upstream workflows (`.github/workflows/`):
  - `release.yml` is `workflow_dispatch` only. It creates a draft release
    and calls `build.yml` for seven platforms with `sign-binaries: true`.
  - `pr-test-build.yml` also passes `sign-binaries: true` and
    `secrets: inherit`, and builds `refs/pull/N/merge`.
  - `build.yml` gives `TAURI_SIGNING_PRIVATE_KEY` to
    `tauri-apps/tauri-action@v0` only when `sign-binaries` is true. It checks
    out `inputs.ref` itself. On Windows it requires an MSI to exist (around
    lines 785 to 788). It sets up the VC++ runtime and SPIRV-Headers (around
    lines 306 to 335 and 372 to 380).
  - Other workflows: `build-test`, `code-quality` (translations, model
    languages, catalog, keyboard tests, lint, format), `main-build`,
    `nix-check`, `playwright`, `test` (`cargo test`).
- Updates (`src/components/update-checker/UpdateChecker.tsx`):
  - The frontend calls `check()` when the settings page mounts, when update
    checks become enabled, and on a `check-for-updates` event.
  - `downloadAndInstall()` and `relaunch()` run only from the install
    button.
  - There is no Rust-side periodic check.
  - `update_checks_effectively_enabled` (`src-tauri/src/settings.rs`) adds
    an environment override.
  - Portable installs are excluded from self-update.
  - The updater plugin is already registered (`src-tauri/src/lib.rs`).
- Dictation finishes asynchronously. `FinishGuard` marks processing finished
  when the transcription task ends (`src-tauri/src/actions.rs`). The paste is
  then queued with `run_on_main_thread` without waiting, and reliable paste
  returns before clipboard restore and auto-submit complete
  (`src-tauri/src/clipboard.rs`, `src-tauri/src/paste_tx/windows.rs`).
- `v0.9.8..main` differs in 124 files, including the transcription engine
  dependencies.

## Measured on Jeremy's machine (2026-10-20, this session)

Logs are in `D:\Data\Repos\.worktrees\Handy\`: `build-free-hidden.log`,
`build-revert.log`, `build-final.log` and `cargo-test.log`.

- A Windows release build (`bun run tauri build --no-bundle`, Vulkan) took
  11m12s cold and 7 to 8 minutes incremental. It needs CMake and the Vulkan
  SDK.
- Building from `C:\Data\...`, which is a junction to `D:\Data\...`, failed
  in Vite's HTML step. Building from `D:\` worked.
- `cargo test` at 2e3b3c0: 287 passed, 0 failed, 18 ignored.
- The installed copy is stock 0.9.8 from the winget NSIS setup
  (`Handy_0.9.8_x64-setup.exe`), at `%LOCALAPPDATA%\Handy\handy.exe`, with
  data in `%APPDATA%\com.pais.handy`. The selected model was found there.

## Decisions (Jeremy's)

- The fork exists to carry his own changes going forward.
- The installed Handy updates itself.
- Automatic installs wait for 10 minutes without keyboard or mouse input,
  and restart Handy hidden in the tray.
- Codex review of this design (requested).

## Decisions (designer's, open to override)

### Branches, base record, versions

- **`jw`** is the fork's default branch.
- **Base record:** a tracked file `fork/base.json` on `jw` records the
  current base: upstream repo, tag, and peeled commit SHA.
- **Patch inventory:** `fork/patches.md` lists each carried commit's purpose
  and status (`carried`, or `absorbed upstream`).
- **Upstream tags** are fetched into their own namespace
  (`refs/upstream-tags/*`), so fork tags can never be mistaken for a base.
- **Bootstrap.** Create `jw` from upstream tag `v0.9.8`, which is
  upstream's latest release today. Add:
  1. the fork identity commit (below)
  2. the `fork/` records
  3. 2e3b3c0 re-applied onto v0.9.8
  4. the background updater change

  Commits from upstream `main` must never be carried.
- **Fork identity commit:**
  - the updater endpoint becomes
    `https://github.com/jeremywho/Handy/releases/latest/download/latest.json`
  - the updater `pubkey` becomes the fork's key
  - the Windows `signCommand` is removed
  - the portable-mode fallback link
    (`src/components/update-checker/portableInstaller.ts`) points at the
    fork's releases
  - `fork-release.yml` and the guard scripts are added
- **Re-basing onto a new release:** `git rebase --onto <new-tag> <old-tag>
  jw`.
  - Merge commits on `jw` are rejected.
  - A commit that ends up empty stops the run for review. An empty diff
    does not prove upstream absorbed the behaviour. A person checks it and
    updates `fork/patches.md` before the next run.
  - The run stops if the recorded base tag now peels to a different SHA,
    meaning upstream re-tagged.
  - The run stops if the new tag's `tauri.conf.json` version does not match
    the tag name.
- **Versions** are `X.Y.Z-jw.N`:
  - The version is not committed. A deterministic stamp script writes it
    into `tauri.conf.json`, `Cargo.toml` and `package.json`.
  - The stamp script is applied identically in the test job and the build
    job, and recorded in the release's provenance.
  - One script computes the version once. A guard asserts that the app
    version, installer version, manifest version and release tag all match.
  - `N` comes from existing `v<base>-jw.*` tags and drafts, under the
    workflow's concurrency lock.
  - Bad releases are fixed forward with a higher `N`. Pointing "latest" back
    at an older release does not roll back clients that already updated.
- **Windows bundle:** NSIS only (`--bundles nsis`). MSI rejects non-numeric
  prerelease versions.

### Effective-config guard (blocks any release)

After the version is written and before building, a script resolves the
effective configuration: the base config plus `tauri.windows.conf.json`
merged over it. The build stops unless all of these hold:
- the updater endpoint list is exactly the fork's URL
- the `pubkey` is the fork's key
- `identifier` is `com.pais.handy` and `productName` is `Handy`
- there is no `signCommand`
- the version equals the computed version.

Config files alone do not prove what the running app trusts. Tauri compiles
the config into the executable, and Rust code can override the updater
endpoint and key when it builds the updater. So the guard has three layers:
1. **One construction path.** The fork has a single function that builds
   the updater, used by both the background service and the manual install
   command. It sets the endpoint and key from the compiled config and never
   overrides them. A unit test asserts both equal the fork's constants.
2. **Self-test of the shipped binary.** A headless CLI flag
   (`handy --fork-selftest`) builds the updater through that same function,
   prints the effective endpoint and public key, and exits with no window.
   CI extracts `handy.exe` from the built installer, runs the flag with no
   signing credentials, and fails unless the output is the fork's endpoint
   and key.
3. **Stock is rejected.** CI verifies upstream's current `latest.json`
   Windows signature against the fork's public key and requires it to fail.
   This proves the fork's key is not upstream's.

A source check also fails the build if any file under `src/` or `src-tauri/`
other than docs contains `cjpais/Handy/releases`.

### Workflow `fork-release.yml`

- **Triggers:** a daily schedule (09:17 UTC), `workflow_dispatch`, and `push` to
  `jw`.
- **Concurrency:** one group, `cancel-in-progress: false`, so runs never
  overlap and a publish is never cut off partway.
- **Which runs publish:** a run publishes only when all of these hold:
  - the ref is `refs/heads/jw`
  - the event is `push`, `schedule` or `workflow_dispatch`
  - the plan job's outcome is "release needed".

  Every other path ends in an explicit skip or failure state on the
  Actions page.
- **No push (R30):** the workflow never pushes `jw` and never creates a ref
  to a new commit. Each run takes the fork's commits
  `fork/base.json.sha..jw`. If upstream's latest release is newer than
  `fork/base.json`, it rebases them in the runner onto that release's tag;
  otherwise the candidate is `jw`'s head as it is. It tests, builds, signs
  and publishes that candidate. `jw` and `fork/base.json` move only when
  Jeremy pushes from his machine.
- **Plan job** (Linux, read-only token):
  - Authenticated API calls, with bounded retries that respect rate-limit
    headers. "No change" is an explicit outcome, separate from an error.
  - **Reconcile first.** Read the latest published fork release's
    provenance and any draft fork releases. If a draft or tag matches a
    candidate that never finished, resume it with its existing version
    before doing anything else. A rebased draft's source commit existed
    only in the runner that built it, so a resume repeats the rebase.
  - Fetch upstream release tags into the upstream namespace and read
    upstream's latest non-draft, non-prerelease release.
  - Decide:
    - **No-op** only when the latest published release's `preRebaseHead`
      equals `jw`'s head and its `baseSha` equals upstream's latest
      release.
    - **Rebase** when upstream's latest release is newer than
      `fork/base.json`, with `N` counted on upstream's version.
    - **Build `jw`'s head** otherwise, with `N` counted on
      `fork/base.json`'s version.
  - For a rebase, do it in the runner and stop on conflict.
  - Output a git bundle of the candidate, its SHA, and the computed version.
    Every later job verifies the bundle's SHA before using it.
  - `jw` is never advanced, neither to move the candidate between jobs nor
    after publishing.
- **Workflow allowlist:**
  - A separate admin job holds `actions: write` and runs no candidate code.
  - Each run, it disables every workflow other than `fork-release.yml`
    through the Actions API.
  - A rebase stops the run for review only if it adds a new workflow file
    or touches `fork-release.yml`.
  - Edits to existing upstream workflows don't stop it, because the admin
    job keeps them disabled. Seven of the last eight upstream releases
    edited an existing workflow, so stopping on those would mean a manual
    step on nearly every release.
  - When the rebase changes upstream `build.yml`, the run summary shows its
    diff. The fork's build job copies that file's Windows steps, so the
    diff flags drift worth bringing over. A real break shows up as a failed
    build.
- **Test job** (`windows-latest`, no secrets):
  - Apply the version stamp to the candidate, then run:
    - `cargo test` in `src-tauri`
    - `bun run lint`
    - the `code-quality` checks that apply to the frontend
    - the Playwright tests
    - the fork's own tests: updater construction and install-gate races.
- **Build job** (`windows-latest`, no secrets):
  - Steps are copied from upstream `build.yml`'s Windows path: Vulkan SDK,
    VC++ runtime, SPIRV-Headers.
  - Apply the same version stamp, check the effective config, and build
    with `--bundles nsis --no-sign`. That skips updater signing, which
    happens later in the sign job.
  - Extract `handy.exe` and run `--fork-selftest`.
  - Upload the unsigned-for-update installer and its hash as an artifact.
- **Sign job** (`environment: release`):
  - The signing key and password are secrets of the GitHub environment
    `release`. This is the only job that references that environment, and
    it runs only when the publish predicate holds.
  - It runs no candidate code. It uses pinned Tauri CLI signer tooling,
    installed from a lockfile in the workflow, not the candidate's
    `package.json` scripts.
  - Download the artifact, check its hash, and produce the updater `.sig`.
  - Build `latest.json` itself (not `tauri-action`), with:
    - the `windows-x86_64` platform entry
    - the exact version
    - the immutable asset URL
      `https://github.com/jeremywho/Handy/releases/download/vX.Y.Z-jw.N/<file>`
    - the signature content.
  - Verify the signature against the fork's public key.
  - Check that upstream's current Windows signature fails against the fork's
    key (guard layer 3).
  - Write `provenance.json` containing:
    - the candidate SHA (`sourceSha`), `jw`'s head (`preRebaseHead`), and
      the upstream base tag and SHA the candidate was built on
    - the version
    - the stamp script hash
    - the installer hash
    - the run ID.
- **Publish job**, in order:
  1. Create the tag `vX.Y.Z-jw.N` on `jw`'s head (`preRebaseHead`), a
     commit already in the repo, through the API with `GITHUB_TOKEN`. A tag
     that already points there, as on a resume, is accepted; one that
     points elsewhere stops the run. Then create the release as a draft
     bound to that tag. The tag marks the fork source; `provenance.json`
     names the built candidate.
  2. Upload the installer, `.sig`, `latest.json` and `provenance.json`.
     Download them back and re-verify the hashes and the signature.
  3. Promote the release: not a draft, not a prerelease, `make_latest`.
  4. Read the release back from the API, then fetch
     `releases/latest/download/latest.json` and check that it is this
     version.
- **Run state and recovery:**
  - The release's `provenance.json` is the transaction record. The next
    run's reconcile step reads it, along with any drafts.
  - A promote call that times out counts as unknown until the release has
    been read back.
  - If the public `latest.json` check fails after promotion, the run
    fails and the next run publishes a fixed-forward `N+1` on the newer of
    `fork/base.json` and the published release's base.
- **Pinning and permissions:**
  - Third-party actions are pinned by commit SHA.
  - Permissions are set per job, because GitHub has no per-step
    permissions:
    - plan, test and build: `contents: read`
    - admin: `actions: write`
    - sign: `contents: read` plus the `release` environment
    - publish: `contents: write`
  - No personal access token. The only ref the workflow writes is the
    release tag, on a commit already in the repo, with `GITHUB_TOKEN`.

### Fork setup order (once)

1. Push `jw` from the bootstrap and make it the default branch. Workflows
   register in the Actions API only once their files are on the default
   branch, so they can't be disabled before this.
   - Actions is already enabled on the fork, checked 2026-10-20.
   - No upstream workflow triggers on pushes to `jw`; they are push-to-`main`,
     pull-request or manual.
2. Disable every workflow except `fork-release.yml` through the Actions API.
3. Only then create the `release` environment and add the signing secrets.
   Until this step there is no key that any workflow could reach.
4. Run `fork-release.yml` by hand to produce `0.9.8-jw.1`.

Nothing that can run upstream workflow code ever has access to the key. The
upstream `pr-test-build.yml` stays disabled, and the key is not a
repository-level secret that `secrets: inherit` could pass on.

### Secrets

- The updater key pair comes from `bun run tauri signer generate`.
- The private key and password are secrets of the fork's `release`
  environment, used by the sign job only.
- A backup goes in Jeremy's 1Password vault "Private". The backup is checked
  once by signing a test file with it.
- **Changing the key** (after a leak, or as a precaution):
  1. Generate a new pair.
  2. Ship a transition release signed with the old key that embeds the new
     `pubkey`.
  3. Switch the sign job to the new key only after the installed app's
     `DisplayVersion` shows that transition release.
- **If the old key is lost,** Jeremy reinstalls once by hand.

### Monitoring

There is no separate monitor: GitHub's own failed-run emails and the
Actions page are where failures show, and Jeremy judged a monitor overkill.

### In-app automatic update (carried change on `jw`)

A Rust background service, started only in the normal app lifecycle (not
headless or CLI mode), using `tauri-plugin-updater`'s Rust API:
- **When it runs:** only when `update_checks_effectively_enabled` is true and
  the install is not portable. It checks at startup and then every 4 hours.
- **Download first:** the update downloads while dictation keeps working.
- **Install gate:** installing needs a backend gate shared with the manual
  install button. The button calls a new backend command that goes through
  the same gate.
  - The frontend loses the updater plugin's install permissions in
    `src-tauri/capabilities/default.json`. It keeps check only, so nothing
    can install around the gate.
  - Every entry point that runs inference or post-processing takes an
    activity permit:
    - recordings, through the transcription coordinator
    - history re-transcription (`src-tauri/src/commands/history.rs`)
    - any others found while building.
  - The gate is taken atomically, and only when no permit is held, nothing
    is queued, and no paste is pending, including clipboard restore and
    auto-submit.
  - While the gate is held, new permits are refused with a short message
    until the installer starts.
  - Backend tests cover admission, cancellation and paste-completion races.
- **Quiet moment (Jeremy's choice):** an automatic install also waits until
  there has been no keyboard or mouse input for 10 minutes. On Windows that
  is `GetLastInputInfo`. The idle condition is re-checked when the gate is
  taken. Manual installs from the button skip the idle wait.
- **Comes back hidden (Jeremy's choice):** after an automatic update, Handy
  restarts to the tray without opening the settings window, whatever the
  `start_hidden` setting says. It does this whether the restart comes from
  the installer's restart path or a startup marker the service writes
  before handing over. A manual update from the button reopens the window
  as today.
- **Shutdown:** before handing over to the installer, the service finishes
  history writes and settings persistence. The Windows updater starts the
  installer and exits the process straight away, so no cleanup can run
  after that point.
- **Restart:** the installer's own success path restarts Handy. It does
  nothing if the installer fails or never launches.
  - The updater ignores the result of the launch call and exits anyway.
  - The design accepts manual recovery for that rare case rather than adding
    a watchdog helper.

### Switch-over from stock (once, by hand, guided)

1. Stop Handy. Back up `%APPDATA%\com.pais.handy` and the Hugging Face model
   cache it uses.
2. Install the first fork release.
   - Its `0.9.8-jw.1` is lower than stock `0.9.8`, so the NSIS page offers
     to uninstall the newer version first.
   - Take the uninstall, and leave "delete app data" unticked.
   - Alternatively, wait for the next upstream release, so the fork's
     version is higher than stock's.
3. Check:
   - settings, history and the model are present
   - the About screen shows `0.9.8-jw.1`
   - `handy --fork-selftest` prints the fork's endpoint and key.
4. Before relying on the setup, test `jw.1` to `jw.2` on the machine. Push a
   trivial commit, then watch the app update itself.
5. **Restore,** if anything is wrong:
   - stop Handy
   - uninstall the fork without deleting app data
   - restore the backed-up `%APPDATA%\com.pais.handy` and model cache
   - reinstall stock `Handy_0.9.8_x64-setup.exe`.

Before the first install, the guard also checks that the installer's
manufacturer, product name and uninstall registry key match stock's, so the
fork replaces stock rather than installing alongside it.

## Left to the builder

- Which mechanism carries "restart hidden" across the update: an installer
  argument or a startup marker.
- The exact merge rules the config guard uses, matched to Tauri's own merge
  behaviour.
- Caching (the Rust cache, the Vulkan SDK) in the build job.
- Whether the test and build jobs share one runner to reuse compilation.
- The wording of the "update installing, try again" message.

## Unverified (check during build)

- Whether an update installed by the in-app updater shows a SmartScreen
  prompt for the unsigned installer.
- Whether the workflow's own releases reset GitHub's 60-day schedule
  inactivity timer. If they do not, the schedule can be disabled with no
  alert; a push to `jw` still runs the workflow.
- Whether `GITHUB_TOKEN` can create the release tag on a `jw` head whose
  commits change `.github/workflows/`. The first release that follows such
  a push settles it.
- Whether 2e3b3c0 applies cleanly to v0.9.8. If it does not, re-apply it by
  hand and re-run the same Windows verification that passed on `main`.
