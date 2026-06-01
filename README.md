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

Remote control streams each Claude session into its own **forum topic** in a Telegram supergroup, so the chat must be set up correctly first. The steps below get you from zero to a connected bot.

**Prerequisites:**

- A **Telegram bot** created via [@BotFather](https://t.me/botfather) — you'll need the bot token
- A **Telegram supergroup with Topics (forum mode) enabled** — the bridge creates one topic per session so conversations don't mix
- The bot added to that supergroup as an **administrator** with the **Manage Topics** permission
- Optional, for voice messages: an API key for your chosen transcription provider (OpenAI, Azure, or xAI)

#### 1. Create a bot

1. Open Telegram and start a chat with [@BotFather](https://t.me/botfather)
2. Send `/newbot`
3. Give it a **display name** (anything, e.g. "My RokketWrapper Bot")
4. Give it a **username** — it must end in `bot` (e.g. `my_rokket_bot`)
5. BotFather replies with a **token** like `123456789:ABCdefGHI...` — copy it; you'll paste it in step 4

#### 2. Create the right kind of chat — a supergroup with Topics

A plain group will **not** work. The extension creates one forum topic per session, which requires a **supergroup with Topics (forum mode) enabled**.

1. In Telegram, create a **New Group** and add your bot as a member
2. Open the group, tap/click the group name to open **group info**, then **Edit** (pencil icon)
3. Turn on the **Topics** toggle and save — Telegram automatically upgrades the group to a supergroup
   - On some clients the toggle lives under **Edit → Group Type** or **Manage Group**
   - The upgrade changes the group's internal chat ID; the extension self-heals this automatically, so you don't need to re-run setup if it happens after connecting

#### 3. Make the bot an admin with Manage Topics

The bot must be an **administrator** to read group messages and create/close topics.

1. Group info → **Administrators** → **Add Admin** → select your bot
2. Ensure the **Manage Topics** permission is enabled (it's on by default for admins) — without it the bot can't create per-session topics

#### 4. Connect the token

Set the bot token one of two ways — either is fine, and both store the token in VS Code **secret storage** (never an editable setting):

- **Settings menu** — open the panel's settings menu (the gear icon), paste the token into the **Telegram** field, and click **Save**
- **Setup wizard** — type `/telegram` in the chat input (also available via the Command Palette as **RokketWrapper: Telegram Setup**). The wizard walks through bot creation, validates the token, listens for a message to auto-detect your group, and verifies the bot's admin status

#### 5. (Optional) Lock the bot to you

By default the bot is **open** — anyone in the chat can drive it. If you'd rather lock it down, set an **owner**: once an owner id is configured, only that person's messages are forwarded and everyone else's are silently ignored. Leaving the owner unset keeps the bot open.

- The **setup wizard** captures the owner automatically: whoever sends the detection message in step 4 becomes the owner. (On manual setup it asks for your user id, which you can skip.)
- To set or change it yourself, send **`/whoami`** in the group — the bot replies with your numeric Telegram user id — then paste that id into the **Telegram** field's **user ID** box in the settings menu (gear icon) and click **Save**. You can also set `rokketWrapper.telegramOwnerId` directly.

`/whoami` and `/telegram` always work regardless of the owner setting, so you can always recover your id.

#### 6. Link a session

Use the **Sync** button in the panel header to link the current session to your Telegram group. A new forum topic is created for that session, and the bot posts a confirmation message in the group. If the group doesn't have Topics enabled, the extension warns you and leaves sync off until you enable Topics (step 2).

#### How it works

Once connected, the bridge:

- Creates a new **forum topic** per session, so each conversation stays in its own thread
- Routes messages you send in the supergroup's **General** topic (the default thread, which has no per-session topic) to your first synced session, so you can chat without picking a topic; if no session is synced it replies with a hint to turn on sync
- Forwards your Telegram messages to the active session and streams responses back as edited messages (controlled by `rokketWrapper.telegramStreamingGranularity`)
- Shows **tool execution status** inline (`⏳` in-progress → `✅` done / `❌` error, with elapsed time)
- Shows a **typing indicator** while the agent is working
- Presents the agent's multiple-choice questions as **inline Telegram buttons**
- **Optionally locks the bot to an owner** — the owner gate is opt-in: with no owner set the bot is open to anyone in the chat; once you set an owner id (via `/whoami` → settings) only that person's messages are forwarded. `/whoami` (get your id) and `/telegram` (setup) are always allowed

#### Voice messages

Send a voice message in the group and the bridge downloads the audio, transcribes it with your configured provider (`rokketWrapper.voiceTranscriptionProvider` — `openai`, `azure`, or `xai`), and feeds the transcript to the agent as a normal prompt. You'll see a `🎙️ Transcribing…` status while it works. If no provider key is set, voice messages are ignored with a prompt to configure one.

#### Photo support

Photos sent to the group are downloaded and injected directly into the prompt as image attachments.

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
| `rokketWrapper.telegramOwnerId` | Telegram user id allowed to drive the bot (send `/whoami` to find yours; `0` = no owner set, bot stays open to anyone) | `0` |
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
