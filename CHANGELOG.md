# Changelog

All notable changes to RokketWrapper are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [0.1.18] — 2026-06-01

### Added
- `LICENSE` file (MIT) so the Marketplace listing and packaged VSIX declare a license

### Changed
- CI/release workflows upgraded to `actions/checkout@v5` and `actions/setup-node@v5` (Node 24 action runtime) ahead of GitHub's June 16 2026 Node 20 deprecation; build/test Node version bumped 20 → 24

---

## [0.1.17] — 2026-06-01

### Added
- Live workflow visibility: when a Claude Code `Workflow` fans out sub-agents, an inline card appears in the conversation the moment the run starts, ticking each agent running → done in real time and persisting as a transcript record afterward. Driven by a disk watcher that tails the run's `journal.jsonl`, independent of the turn lifecycle (Codex backend excluded — it writes no Claude workflow journal)
- `rokketWrapper.workflowLivePanel` setting (default on) to toggle the live card
- `rokketWrapper.workflowDiagnostics` setting (default off) — opt-in overlay for troubleshooting live-card delivery

### Fixed
- Live workflow watcher: a tick whose disk reads were in flight when the process crashed could resume and re-post a live card the (already-stopped) poll loop would never retract, stranding a stale "running" panel. The poll now bails on teardown after each await

---

## [0.1.16] — 2026-05-22

### Added
- Extension version displayed in the webview header
- Telegram bridge drains queued inbound user messages sequentially, preempting ongoing streams via abort
- Auto-update from GitHub releases with secure token resolution and native VS Code install flow

### Fixed
- Claude Code CLI models now appear under "Claude Code CLI" in the model picker (were mislabelled "Anthropic", making them look like API-key models)
- Windows: `claude.cmd` hardcoded path replaced with `claude` — works regardless of how the CLI is installed
- Crash error messages now show the actual failure reason instead of the generic "Make sure 'claude' is installed" hint

---

## [0.1.13] — 2026-05-10

### Fixed
- Corrected `repository.url` in `package.json` to match actual GitHub repo name
- README screenshot renders responsively (removed hardcoded dimensions)

---

## [0.1.12] — 2026-05-10

### Fixed
- Marketplace icon no longer 404s — replaced white-on-transparent logo with visible black icon, upscaled to 256x256

---

## [0.1.10] — 2026-05-10

### Changed
- Extension ID renamed from `rokket-wrapper` to `rokketek-wrapper` to clear Marketplace reservation

---

## [0.1.9] — 2026-05-10

### Fixed
- CI test suite restored to green (924 tests passing)
- XSS: all user-controlled strings escaped in dashboard and auto-progress templates
- XSS: phase value validated against allowlist before CSS class interpolation
- Keyboard accessibility: `.gsd-settings-toggle` focus-visible targets nested input directly
- Release workflow uses explicit token for version bump push

### Added
- `getKnownBinDirs()` — fallback PATH injection for common CLI install locations (Homebrew, nvm, fnm, Volta, npm-global, Yarn, Snap) on macOS/Linux; `%APPDATA%\npm`, Volta, nvm-windows on Windows
- nvm and fnm active-version detection via alias symlink resolution
- ENOENT errors now surface actionable install instructions per provider
- Codex detection falls back to binary PATH search when model cache doesn't exist

### Changed
- Shell env timeout increased from 5s to 10s for slow shell startup (oh-my-zsh, nvm)
- Windows PATH separator uses `;` throughout shell-env injection

---

## [0.1.4] — 2026-05-10

### Added
- CI: publish to VS Code Marketplace on release workflow

### Changed
- Display name and description updated to include Codex

---

## [0.1.3] — 2026-05-09

### Fixed
- Telegram `resolveSession` implemented so messages from the bot actually reach the agent

---

## [0.1.1] — 2026-05-09

### Added
- Telegram supergroup setup instructions in README
- Bot token configurable via VS Code Settings
- CI: release and CI GitHub Actions workflows
- Rokketek logo replaces ASCII splash screen

---

## [0.1.0] — 2026-05-08

Initial public release.

### Added
- `IAgentProvider` interface as the normalised provider contract
- `ClaudeCodeProvider` — spawns Claude Code CLI and maps NDJSON output to provider events
- `CodexProvider` — OpenAI Responses API adapter with streaming support
- Push-to-talk voice input: hold mic button to record, release to transcribe and send
- Telegram bridge for remote prompt/response over bot API
- Webview UI with streaming token display and tool call visibility
- `open_url` message handler with protocol allowlist (`https:`, `http:`, `mailto:`)
- Session history with rename and delete support
- Image input support
- Cost and token usage tracking in status bar
- Four UI themes: Classic, Phosphor, Clarity, Forge

### Changed
- Forked from RokketGSD — all GSD/pi-specific code removed
- Extension commands and settings namespaced under `rokketWrapper.*`
