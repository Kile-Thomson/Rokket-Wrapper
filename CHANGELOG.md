# Changelog

All notable changes to RokketWrapper are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Added
- `IAgentProvider` interface as the normalised provider contract
- `ClaudeCodeProvider` — spawns `claude --print --output-format stream-json --verbose` and maps NDJSON output to provider events
- `CodexProvider` — OpenAI Responses API adapter with streaming support
- Push-to-talk voice input: hold mic button to record, release to transcribe and send
- Telegram bridge for remote prompt/response over bot API
- Webview UI with streaming token display and tool call visibility
- `open_url` message handler with protocol allowlist (`https:`, `http:`, `mailto:`)

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

---

## [0.1.0] — TBD

Initial public release.

- Claude Code provider
- Codex provider
- Telegram bridge
- Push-to-talk voice input
- VS Code Marketplace listing
