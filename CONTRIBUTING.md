# Contributing to RokketWrapper

Thanks for your interest in contributing. This document covers how to set up your dev environment, the branching strategy, and what we look for in pull requests.

## Development Setup

### Prerequisites

- Node.js 18+
- VS Code 1.80+
- Claude Code CLI installed and authenticated

### Getting Started

```bash
git clone <repo-url>
cd RokketWrapper
npm install
npm run watch
```

Press **F5** in VS Code to launch the Extension Development Host with your local build.

### Project Structure

```
src/
  extension/         ← Node.js extension host code
    provider/        ← IAgentProvider + concrete implementations
    telegram/        ← Telegram bot bridge
  webview/           ← Webview UI (vanilla DOM, no framework)
dist/                ← compiled output (committed for release builds)
```

## Branching Strategy

| Branch | Purpose |
|---|---|
| `main` | Stable, releasable |
| `feature/<name>` | New features |
| `fix/<name>` | Bug fixes |
| `chore/<name>` | Tooling, deps, docs |

Open all PRs against `main`.

## Pull Request Guidelines

- **One concern per PR** — don't mix a feature with a refactor
- **Build must pass** — run `npm run compile` before opening a PR
- **Tests** — add tests for new provider adapters and non-trivial logic
- **Commit messages** — write them as release notes: what changed and why, not what files you touched
  - ✅ `Add Codex provider with streaming tool call support`
  - ❌ `update ClaudeCodeProvider.ts and index.ts`

## Adding a New Provider

1. Implement `IAgentProvider` from `src/extension/provider/IAgentProvider.ts`
2. Register it in the provider factory in `webview-provider.ts`
3. Add corresponding settings in `package.json` contributes section
4. Add a test file under `src/test/provider/`

The interface contract:

```typescript
interface IAgentProvider extends EventEmitter {
  start(): Promise<void>
  prompt(text: string, options?: PromptOptions): Promise<void>
  abort(): Promise<void>
  dispose(): void
}
```

Events to emit: `message_chunk`, `message_end`, `agent_start`, `agent_end`, `tool_call`, `tool_result`, `error`, `log`.

## Code Style

- TypeScript strict mode — no `any` without a comment explaining why
- Vanilla DOM in the webview — no React, no framework
- No comments explaining *what* code does — name things well instead
- Comments only for non-obvious *why*: hidden constraints, workarounds, subtle invariants

## Reporting Issues

Use GitHub Issues. Include:
- VS Code version
- Extension version
- Provider being used (Claude Code / Codex)
- Steps to reproduce
- Expected vs actual behaviour
- Relevant output from the Output panel (RokketWrapper channel)
