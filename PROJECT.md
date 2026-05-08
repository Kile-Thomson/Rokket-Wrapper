# RokketWrapper

## What It Is

RokketWrapper is a VS Code extension that provides a polished IDE GUI for Claude Code CLI and OpenAI Codex CLI. It is a fork of RokketGSD with all GSD/pi-specific infrastructure removed, retaining the webview UI, Telegram bridge, and voice input as provider-agnostic features.

**Target users:** Developers who love the RokketGSD frontend (webview chat, Telegram bridge, voice input) but don't use GSD/pi as their agent runner.

---

## Current Status

The initial codebase has been set up:

- Forked from `RokketGSD/gsd-vscode` at `telegram-ux-improvements` (includes push-to-talk voice, Telegram UX improvements, phantom tool tracking)
- All GSD/pi-specific code stripped — RPC client, auto-mode, worktree management, metrics, session watchdogs, captures, dashboard
- **Kept intact:** Webview UI, Telegram bridge, voice transcription, update checker, HTML generator
- **New:** `IAgentProvider` interface + `ClaudeCodeProvider` skeleton added at `src/extension/provider/`
- **Known gap:** Telegram bridge still expects the old GSD client shape — needs wiring to `provider.prompt()` (M001 S02)

Next step: finish wiring `ClaudeCodeProvider` end-to-end and validate VS Code chat → Claude Code CLI → response in webview.

---

## What Gets Kept from RokketGSD

| Component | Keep? | Notes |
|---|---|---|
| Webview UI (chat, tool rendering) | ✅ | Provider-agnostic already |
| Telegram bridge | ✅ | Works against normalised event layer |
| Voice input (push-to-talk) | ✅ | Webview-level feature |
| CSP/nonce security model | ✅ | Required for webview safety |
| Design token / theming | ✅ | |
| `GsdRpcClient` / pi spawner | ❌ | Replace with provider abstraction |
| GSD event mappings (`rpc-events.ts`) | ❌ | Replace with per-provider adapters |
| Auto-mode / worktree UI | ❌ | GSD-specific |
| GSD cost tracking | ⚠️ | Reimplement from Claude Code's `result` event |

---

## Provider Architecture

### Interface: `IAgentProvider`

```ts
interface IAgentProvider {
  // Lifecycle
  start(): Promise<void>;
  dispose(): void;

  // Interaction
  prompt(text: string, options?: PromptOptions): void;
  followUp(text: string): void;
  abort(): void;

  // Events (EventEmitter)
  on(event: 'agent_start',      listener: () => void): this;
  on(event: 'agent_end',        listener: (data: AgentEndData) => void): this;
  on(event: 'message_update',   listener: (data: MessageChunk) => void): this;
  on(event: 'message_end',      listener: () => void): this;
  on(event: 'tool_call',        listener: (data: ToolCallData) => void): this;
  on(event: 'tool_result',      listener: (data: ToolResultData) => void): this;
  on(event: 'error',            listener: (err: Error) => void): this;
  on(event: 'cost_update',      listener: (data: CostData) => void): this;
}
```

### Providers

| Provider | CLI | Protocol |
|---|---|---|
| `ClaudeCodeProvider` | `claude --print --output-format stream-json --verbose` | NDJSON over stdout |
| `CodexProvider` | `codex` | TBD — OpenAI streaming API |

### Claude Code Event Mapping

| Claude Code NDJSON event | Internal event |
|---|---|
| `system` (init) | `agent_start` |
| `assistant` (text delta) | `message_update` |
| `assistant` (tool_use block) | `tool_call` |
| `assistant` (tool_result block) | `tool_result` |
| `result` (final) | `message_end` + `agent_end` + `cost_update` |

---

## Settings

```json
{
  "rokketWrapper.provider": "claude-code" | "codex",
  "rokketWrapper.claudeCode.model": "claude-opus-4-7",
  "rokketWrapper.claudeCode.binaryPath": "",
  "rokketWrapper.codex.apiKey": "",
  "rokketWrapper.codex.model": "codex-mini-latest",
  "rokketWrapper.telegram.botToken": "",
  "rokketWrapper.telegram.allowedChatIds": []
}
```

---

## Milestones

### M001 — Provider Abstraction + ClaudeCode Adapter
- Extract `IAgentProvider` interface
- Rename/strip `GsdRpcClient` → keep only the process-spawn + event-emit pattern
- Implement `ClaudeCodeProvider` against `--output-format stream-json`
- Wire provider factory in `webview-provider.ts`
- Settings: provider selection + Claude Code config

### M002 — Codex Provider
- Research Codex CLI protocol
- Implement `CodexProvider`
- Settings: Codex API key + model

### M003 — Branding + Publish
- Remove all GSD/pi references from UI strings
- New extension name, icon, publisher ID
- Marketplace listing

---

## Source Fork

Fork from: `RokketGSD - VS Code Plugin/gsd-vscode`
Fork point: after `telegram-ux-improvements` branch is merged to main

---

## References

- Claude Code `--output-format stream-json` — documented in Obsidian vault (BC Pricelist + RokketDocs notes)
- RokketGSD architecture — `G:/Dropbox/Rocket Social/Rokketek/Knowledge/Architecture.md`
