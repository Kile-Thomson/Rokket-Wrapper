# Codebase Map

Generated: 2026-05-08T06:56:21Z | Files: 120 | Described: 0/120
<!-- gsd:codebase-meta {"generatedAt":"2026-05-08T06:56:21Z","fingerprint":"704319317751530d4f83af1ed667d94a8418e836","fileCount":120,"truncated":false} -->

### (root)/
- `eslint.config.mjs`
- `package.json`
- `PROJECT.md`
- `tsconfig.json`
- `vitest.config.ts`

### src/extension/
- `src/extension/html-generator.test.ts`
- `src/extension/html-generator.ts`
- `src/extension/index.ts`
- `src/extension/shell-env.ts`
- `src/extension/update-checker.test.ts`
- `src/extension/update-checker.ts`
- `src/extension/webview-provider.ts`

### src/extension/openai/
- `src/extension/openai/config.ts`
- `src/extension/openai/transcribe.ts`

### src/extension/provider/
- `src/extension/provider/ClaudeCodeProvider.ts`
- `src/extension/provider/IAgentProvider.ts`

### src/extension/telegram/
- `src/extension/telegram/api.test.ts`
- `src/extension/telegram/api.ts`
- `src/extension/telegram/bridge.test.ts`
- `src/extension/telegram/bridge.ts`
- `src/extension/telegram/config.test.ts`
- `src/extension/telegram/config.ts`
- `src/extension/telegram/formatter.test.ts`
- `src/extension/telegram/formatter.ts`
- `src/extension/telegram/integration.test.ts`
- `src/extension/telegram/poller-client.ts`
- `src/extension/telegram/poller-coordinator.ts`
- `src/extension/telegram/poller-ipc.ts`
- `src/extension/telegram/poller-server.ts`
- `src/extension/telegram/setup.test.ts`
- `src/extension/telegram/setup.ts`
- `src/extension/telegram/topicManager.test.ts`
- `src/extension/telegram/topicManager.ts`

### src/extension/transcription/
- `src/extension/transcription/config.ts`
- `src/extension/transcription/providers.ts`
- `src/extension/transcription/recorder.ts`

### src/shared/
- `src/shared/constants.ts`
- `src/shared/errors.ts`
- `src/shared/types.ts`

### src/webview/
- *(25 files: 25 .ts)*

### src/webview/__tests__/
- *(25 files: 25 .ts)*

### src/webview/handlers/
- `src/webview/handlers/handler-state.ts`
- `src/webview/handlers/state-handlers.ts`
- `src/webview/handlers/streaming-handlers.ts`
- `src/webview/handlers/tool-execution-handlers.ts`
- `src/webview/handlers/ui-notification-handlers.ts`

### src/webview/handlers/__tests__/
- `src/webview/handlers/__tests__/state-handlers.test.ts`
- `src/webview/handlers/__tests__/streaming-handlers.test.ts`
- `src/webview/handlers/__tests__/tool-execution-handlers.test.ts`
- `src/webview/handlers/__tests__/ui-notification-handlers.test.ts`

### src/webview/render/
- `src/webview/render/batches.ts`
- `src/webview/render/html-builders.ts`
- `src/webview/render/streaming.ts`

### src/webview/render/__tests__/
- `src/webview/render/__tests__/html-builders.test.ts`
- `src/webview/render/__tests__/stale-echo.test.ts`
- `src/webview/render/__tests__/streaming.test.ts`

### src/webview/styles/
- `src/webview/styles/auto-progress.css`
- `src/webview/styles/base.css`
- `src/webview/styles/dashboard.css`
- `src/webview/styles/entries.css`
- `src/webview/styles/footer.css`
- `src/webview/styles/input.css`
- `src/webview/styles/layout.css`
- `src/webview/styles/misc.css`
- `src/webview/styles/overlays.css`
- `src/webview/styles/parallel.css`
- `src/webview/styles/toasts.css`
- `src/webview/styles/tokens.css`
- `src/webview/styles/tools.css`

### src/webview/styles/themes/
- `src/webview/styles/themes/clarity.css`
- `src/webview/styles/themes/forge.css`
- `src/webview/styles/themes/phosphor.css`
