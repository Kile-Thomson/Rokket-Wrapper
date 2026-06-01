# Changelog

All notable changes to RokketWrapper are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [0.1.21] — 2026-06-01

### Added
- Telegram owner gate: the bot can now be locked to a single Telegram user. Set your user id via the **Telegram** field in the settings menu, by re-running Telegram Setup (which captures the sender of the detection message automatically), or via the `rokketWrapper.telegramOwnerId` setting. Send **/whoami** in the group at any time to have the bot reply with your Telegram user id
- **/whoami** command — replies with the sender's Telegram user id (and `@username` when available). Handled before the owner gate, so anyone can use it to discover their id
- Friendly "Topics not enabled" guidance: when you try to sync a session to a supergroup that doesn't have Topics (forum mode) turned on, the bridge now surfaces an actionable warning (open the group → Edit → enable "Topics") instead of a raw Telegram 400 error (new `TelegramNotForumError`)

### Changed
- **Breaking for existing Telegram users:** once upgraded, the bot only acts on messages from the configured owner. Until an owner id is set, every inbound message is answered with a one-line ⛔ hint explaining how to set it (send /whoami, then save the id in the Telegram settings) and is otherwise ignored. Re-running Telegram Setup captures the owner automatically. `/whoami` and `/telegram` always remain reachable. Inline-button taps (questions, restart) are not gated, matching the upstream behaviour

## [0.1.20] — 2026-06-01

### Added
- Telegram General-topic routing: messages sent in the supergroup's **General** topic (the default thread, which has no per-session forum topic) now route to the first synced session instead of being silently dropped. The first session you sync becomes the General leader; if no session is synced, the bridge replies with a hint to turn on sync. Responses, the typing indicator, tool-status messages, and streamed edits all tolerate the General topic by omitting `message_thread_id`

### Changed
- Telegram outbound routing now resolves a per-delivery response thread (`getResponseThread`) instead of assuming every session has a forum topic, so the bridge can reply into either a specific topic or the General topic. Existing per-topic behaviour is unchanged

### Fixed
- The "🔄 Restart GSD" button now works when the session is the General-topic leader. Previously the restart callback looked up a forum topic the General leader doesn't have, so tapping the button silently did nothing; `getResponseThread` now treats the General leader's thread as General (no `message_thread_id`), and the restart status messages omit the thread id accordingly
- Pending-question and active-tool thread ids are stored as `number | null` rather than coercing the General topic to `0`, so follow-up message edits in General never send an invalid `message_thread_id: 0`

---

## [0.1.19] — 2026-06-01

### Added
- Telegram supergroup migration self-healing: when a group is upgraded to a supergroup (its chat id changes), forum-topic creation now detects the `migrate_to_chat_id` response, retries once against the new chat id, retargets the bridge, and persists the new group id to settings. Only topic creation self-heals — other Telegram API calls still surface the migration error

### Fixed
- Telegram setup persisted/read its config (group id, chat title, etc.) under the legacy `gsd` settings namespace while the runtime reads `rokketWrapper`, so saved values were unreachable; setup now uses `rokketWrapper`, matching the declared settings schema and the migration callback

---

## [0.1.18] — 2026-06-01

### Added
- `LICENSE` file (MIT) so the Marketplace listing and packaged VSIX declare a license

### Changed
- CI/release workflows upgraded to `actions/checkout@v5` and `actions/setup-node@v5` (Node 24 action runtime) ahead of GitHub's June 16, 2026 Node 20 deprecation; build/test Node version bumped 20 → 24
- Hardened workflow checkout with `persist-credentials: false` so `GITHUB_TOKEN` is no longer left in the runner's git config; the release tag push now authenticates via an explicit token URL

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
