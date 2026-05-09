# Changelog

All notable changes to RokketWrapper are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [0.1.12] — 2026-05-10

### Fixed
- Marketplace icon no longer 404s — corrected `repository.url` in `package.json` to match actual GitHub repo name (`Rokket-Wrapper`)
- README screenshot no longer renders with hardcoded dimensions — removed fixed `width`/`height` attributes so it scales responsively

---

## [0.1.9] — 2026-05-10

### Fixed
- CI test suite now passes cleanly — all 924 tests green across 43 test files
- Auto-progress widget DOM implementation restored (was a no-op stub)
- Dashboard rendering implementation restored (was a stub)
- Keyboard accessibility: `.gsd-settings-toggle` now has `:focus-visible` alongside `:hover`
- XSS: all user-controlled strings escaped in dashboard template interpolation
- XSS: `data.phase` validated against typed allowlist before use as CSS class name

### Added
- `getKnownBinDirs()` — fallback PATH injection for common CLI install locations (Homebrew, nvm, fnm, Volta, npm-global, Yarn, Snap) on macOS, Linux, and Windows
- nvm and fnm active-version detection via alias symlink resolution
- Windows support in `getKnownBinDirs()` (`%APPDATA%\npm`, Volta, nvm-windows)
- ENOENT errors now surface actionable install instructions per provider (e.g. `npm install -g @anthropic-ai/claude-code`)
- Codex detection falls back to binary PATH search when model cache doesn't exist yet

### Changed
- Shell env timeout increased from 5s to 10s to handle slow shell startup (oh-my-zsh, nvm)
- `ClaudeCodeProvider` spawns `claude.cmd` on Windows; passes `shell: true` for `.cmd` files
- PATH separator now correctly uses `;` on Windows throughout shell-env injection
- Extension ID renamed from `rokket-wrapper` to `rokketek-wrapper` to clear Marketplace reservation

---

## [0.1.0] — 2025-01-01

Initial public release.

### Added
- `IAgentProvider` interface as the normalised provider contract
- `ClaudeCodeProvider` — spawns `claude --print --output-format stream-json --verbose` and maps NDJSON output to provider events
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
- Extension commands namespaced under `rokketWrapper.*`
- Settings namespaced under `rokketWrapper.*`
- Image MIME type and data validated/escaped before innerHTML injection (security)
- Progress bar fills use `transform: scaleX()` instead of `transition: width` (GPU-composited)
- Telegram bridge retries now use exponential backoff with jitter instead of fixed 2s interval
- `persistConversation` errors now surface as a VS Code warning instead of being silently dropped
- `loadCodexModels` converted to async `fs.promises.readFile`; image writes parallelised via `Promise.all`
- Recording stop now polls async via `fs.promises.access` instead of blocking with `existsSync` + fixed `setTimeout`
- History store caches deserialized records to avoid repeated VS Code storage reads
- Removed unused `toGsdState` function and `RpcStateResult` type from `shared/types.ts`

### Removed
- All GSD workflow engine code (RPC client, auto-mode, worktree, captures, metrics)
- GSD-specific webview panels (dashboard, captures, roadmap)
