<p align="center">
  <img src="resources/rokket-icon.png" alt="Rokketek" width="128" />
</p>

A VS Code extension that provides a rich GUI for Claude Code CLI and Codex CLI — with Telegram remote control, push-to-talk voice input, and a polished webview interface.

<img alt="RokketWrapper" src="https://github.com/user-attachments/assets/bb94a03e-3db9-48c7-b2f8-12e3b355c7fc" style="max-width:100%" />

## Features

- **Claude Code & Codex support** — switchable provider backends, both using their native streaming JSON APIs
- **Telegram remote control** — send prompts, receive responses, and monitor agent activity from your phone
- **Push-to-talk voice input** — hold the mic button to record, release to transcribe and send (OpenAI, Azure, or xAI)
- **Streaming responses** — real-time token streaming with tool call visibility
- **Tool call tracking** — see each tool call as it runs with inline result summaries
- **Thinking/effort levels** — set reasoning depth (off / low / medium / high / xhigh) per model
- **Session history** — persistent conversation history with rename and delete support
- **Image input** — attach images directly to prompts
- **Cost tracking** — live token usage and cost displayed in the status bar
- **Themes** — Classic, Phosphor, Clarity, Forge
- **Flexible layout** — open as a sidebar view or a full panel/tab

## Requirements

- VS Code 1.80+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude --version`)
- [Codex CLI](https://github.com/openai/codex) installed and authenticated on device
- Node.js 18+
- Optional: Telegram bot token for remote control
- Optional: API key for voice transcription (OpenAI, Azure, or xAI)

## Getting Started

1. Install the extension from the VS Code Marketplace
2. Open the RokketWrapper panel from the Activity Bar (or via `Ctrl+Shift+G`)
3. Configure your provider in Settings (`Ctrl+,` → search `rokketWrapper`)
4. Start a conversation

### Telegram Setup

1. Create a bot via [@BotFather](https://t.me/botfather) and copy the bot token
2. Add the bot to a **Supergroup** — regular groups won't work (convert via Group Settings → Advanced → Topics if needed)
3. Type `/telegram` in the chat input — the setup wizard walks through token entry, group detection, and admin verification (also accessible via the VS Code Command Palette as **RokketWrapper: Telegram Setup**). The bot token is entered through the wizard and held in VS Code secret storage — there is no token setting to edit by hand
4. Use the **Sync** button in the panel header to link the current session to your Telegram group

## Configuration

| Setting | Description | Default |
|---|---|---|
| `rokketWrapper.agentProvider` | Active provider: `claude-code` or `codex` | `claude-code` |
| `rokketWrapper.claudeCodePath` | Path to `claude` binary (auto-detected if omitted) | `""` |
| `rokketWrapper.codexPath` | Path to `codex` binary (auto-detected if omitted) | `""` |
| `rokketWrapper.preferredLocation` | Where to open: `sidebar` or `panel` | `panel` |
| `rokketWrapper.theme` | UI theme: `classic`, `phosphor`, `clarity`, `forge` | `forge` |
| `rokketWrapper.useCtrlEnterToSend` | Use Ctrl/Cmd+Enter to send (Enter inserts newline) | `false` |
| `rokketWrapper.autoUpdate` | Check for new versions automatically | `true` |
| `rokketWrapper.githubToken` | GitHub token for update checks (or use `GH_TOKEN` env var) | `""` |
| `rokketWrapper.telegramGroupId` | Telegram group chat ID (set automatically by setup wizard) | `0` |
| `rokketWrapper.telegramChatTitle` | Telegram group chat title (set automatically) | `""` |
| `rokketWrapper.telegramBotUsername` | Telegram bot username (set automatically) | `""` |
| `rokketWrapper.telegramStreamingGranularity` | How responses stream to Telegram: `off`, `throttled`, `final-only` | `throttled` |
| `rokketWrapper.voiceTranscriptionProvider` | Voice provider: `openai`, `azure`, `xai` | `openai` |
| `rokketWrapper.azureSpeechRegion` | Azure Speech Services region | `eastus` |

## Architecture

```
src/
  extension/
    provider/
      IAgentProvider.ts        ← provider interface (events + methods)
      ClaudeCodeProvider.ts    ← claude --output-format stream-json adapter
      CodexProvider.ts         ← codex exec adapter
    telegram/
      bridge.ts                ← Telegram bot ↔ provider bridge
      setup.ts                 ← 3-step setup wizard
    transcription/
      providers.ts             ← OpenAI / Azure / xAI voice transcription
      recorder.ts              ← push-to-talk audio capture
    webview-provider.ts        ← VS Code WebviewPanel host
  webview/
    index.ts                   ← webview UI (vanilla DOM)
```

The provider interface emits 8 normalised events: `message_chunk`, `message_end`, `agent_start`, `agent_end`, `tool_call`, `tool_result`, `error`, `log`. All UI code works against these events — switching providers requires no UI changes.

## Development

```bash
npm install
npm run watch        # incremental build
# Press F5 in VS Code to launch Extension Development Host
```

### Building

```bash
npm run compile      # single build
npm run package      # vsce package → .vsix
```

### Testing

```bash
npm test
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
