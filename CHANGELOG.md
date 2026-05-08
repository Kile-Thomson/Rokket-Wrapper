# Changelog

All notable changes to RokketWrapper are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Added
- `IAgentProvider` interface as the normalised provider contract
- `ClaudeCodeProvider` — spawns `claude --print --output-format stream-json --verbose` and maps NDJSON output to provider events
- Push-to-talk voice input: hold mic button to record, release to transcribe and send
- Telegram bridge for remote prompt/response over bot API
- Webview UI with streaming token display and tool call visibility

### Changed
- Forked from RokketGSD — all GSD/pi-specific code removed
- Extension commands namespaced under `rokketWrapper.*`
- Settings namespaced under `rokketWrapper.*`

### Removed
- All GSD workflow engine code (RPC client, auto-mode, worktree, captures, metrics)
- GSD-specific webview panels (dashboard, captures, roadmap)

---

## [0.1.0] — TBD

Initial public release.

- Claude Code provider (M001)
- Codex provider (M002)
- Telegram bridge
- Push-to-talk voice input
- VS Code Marketplace listing
