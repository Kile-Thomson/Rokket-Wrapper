# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| Latest release | ✅ |
| Previous minor | ✅ (critical fixes only) |
| Older | ❌ |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email **kile.bantick@gmail.com** with:

1. A description of the vulnerability
2. Steps to reproduce
3. Potential impact
4. Any suggested mitigations

You'll receive an acknowledgement within 48 hours and a status update within 7 days.

## Scope

The following are in scope:

- **Credential exposure** — API keys, bot tokens, or chat IDs leaking to logs, disk, or the network
- **Telegram authorization bypass** — sending prompts to the extension without being the authorised chat ID
- **Command injection** — unsanitised input reaching the Claude Code / Codex CLI invocation
- **Webview CSP bypass** — content security policy violations in the extension webview
- **Arbitrary code execution** — any path that lets a crafted response from an AI provider execute code outside the intended provider boundary

## Out of Scope

- Vulnerabilities in Claude Code CLI, Codex CLI, or the Telegram platform itself
- Social engineering or phishing attacks
- Issues requiring physical access to the machine

## Security Design Notes

### Credentials

- API keys and bot tokens are stored in VS Code's `SecretStorage` (OS keychain), never in `globalState` or settings JSON
- Telegram chat ID is validated on every inbound message — unknown senders are silently dropped

### Telegram Bridge

- The bot only responds to the single authorised `chatId` configured in settings
- Slash commands from Telegram are validated against an allowlist before dispatch
- Voice messages are transcribed locally via Whisper; no audio is sent to third-party services beyond what the configured AI provider requires

### Webview

- The webview runs with a strict Content Security Policy
- All data passed from the extension host to the webview is serialised through `postMessage` — no `eval`, no `innerHTML` with unsanitised content
- Nonces are regenerated per webview panel instantiation

### AI Provider Output

- Responses from Claude Code / Codex are treated as untrusted content in the webview (rendered as text, not HTML)
- Tool call results are displayed as plain text summaries, not executed
