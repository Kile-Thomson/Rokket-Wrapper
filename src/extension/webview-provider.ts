import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ClaudeCodeProvider } from "./provider/ClaudeCodeProvider";
import { fetchReleaseNotes } from "./update-checker";
import type { ExtensionToWebviewMessage } from "../shared/types";
import { TopicManager, type TopicManagerLogger } from "./telegram/topicManager";
import { TelegramApi, redactToken } from "./telegram/api";
import { loadTelegramConfig } from "./telegram/config";
import { TelegramBridge } from "./telegram/bridge";
import { TranscriptionError } from "./openai/transcribe";
import { transcribeWithProvider, validateApiKey, type TranscriptionProvider } from "./transcription/providers";
import { getTranscriptionApiKey, setTranscriptionApiKey, getVoiceProvider, getAzureRegion } from "./transcription/config";
import { AudioRecorder } from "./transcription/recorder";
import { getWebviewHtml } from "./html-generator";

// ============================================================
// WebviewProvider — manages one Claude Code session per webview panel/sidebar
// ============================================================

export interface StatusBarUpdate {
  isStreaming: boolean;
  model?: string;
  cost?: number;
}

interface SessionState {
  provider: ClaudeCodeProvider | null;
  webview: vscode.Webview | null;
  panel: vscode.WebviewPanel | null;
  isStreaming: boolean;
  accumulatedCost: number;
  messageHandlerDisposable: vscode.Disposable | null;
  launchPromise: Promise<void> | null;
}

function createSessionState(): SessionState {
  return {
    provider: null,
    webview: null,
    panel: null,
    isStreaming: false,
    accumulatedCost: 0,
    messageHandlerDisposable: null,
    launchPromise: null,
  };
}

function cleanupSessionState(session: SessionState): void {
  session.provider?.stop().catch(() => { /* best effort */ });
  session.provider = null;
  session.messageHandlerDisposable?.dispose();
  session.messageHandlerDisposable = null;
}

export class RokketWrapperWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "rokketWrapper.sidebarView";
  private webviewView?: vscode.WebviewView;
  private sessions: Map<string, SessionState> = new Map();
  private output: vscode.OutputChannel;
  private sessionCounter = 0;
  private sidebarSessionId: string | null = null;
  private statusCallback?: (status: StatusBarUpdate) => void;
  private lastStatus: StatusBarUpdate = { isStreaming: false };
  private tempDir: string | null = null;
  private topicManager: TopicManager | null = null;
  private bridge: TelegramBridge | null = null;
  private recorder = new AudioRecorder();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext
  ) {
    this.output = vscode.window.createOutputChannel("RokketWrapper");
  }

  // ----------------------------------------------------------------
  // Telegram integration
  // ----------------------------------------------------------------

  private async getOrCreateTopicManager(): Promise<TopicManager> {
    if (this.topicManager) return this.topicManager;

    const config = vscode.workspace.getConfiguration("rokketWrapper");
    const telegramConfig = await loadTelegramConfig(this.context.secrets, config);
    if (!telegramConfig) {
      throw new Error("Telegram not configured. Run Telegram Setup first.");
    }

    const api = new TelegramApi(telegramConfig.botToken);
    const logger: TopicManagerLogger = {
      info: (msg: string) => this.output.appendLine(`[telegram-topic] ${msg}`),
      warn: (msg: string) => this.output.appendLine(`[telegram-topic] WARN: ${msg}`),
    };
    this.topicManager = new TopicManager(api, telegramConfig.chatId, vscode.env.machineId, logger, this.context.globalState);

    const bridgeLogger: TopicManagerLogger = {
      info: (msg: string) => this.output.appendLine(`[telegram-bridge] ${msg}`),
      warn: (msg: string) => this.output.appendLine(`[telegram-bridge] WARN: ${msg}`),
    };
    this.bridge = new TelegramBridge(
      api,
      this.topicManager,
      (sessionId: string) => {
        const s = this.sessions.get(sessionId);
        if (!s) return undefined;
        // TODO: expose a lightweight client-like interface for the bridge
        return undefined;
      },
      bridgeLogger,
      telegramConfig.botToken,
      telegramConfig.chatId,
      async (audioBuffer: Buffer) => {
        const cfg = vscode.workspace.getConfiguration("rokketWrapper");
        const provider = getVoiceProvider(cfg);
        const apiKey = await getTranscriptionApiKey(this.context.secrets, provider);
        if (!apiKey) throw new TranscriptionError(`No API key set for voice provider "${provider}"`);
        const azureRegion = getAzureRegion(cfg);
        return transcribeWithProvider({ provider, apiKey, azureRegion }, audioBuffer, "voice.ogg");
      },
    );
    this.bridge.setStreamingGranularity(telegramConfig.streamingGranularity);
    this.bridge.setOnInboundMessage((sessionId, text, images) => {
      const session = this.sessions.get(sessionId);
      const webview = session?.webview;
      if (webview) {
        this.postToWebview(webview, {
          type: "telegram_user_message",
          text,
          images: images?.map(img => ({ type: "image" as const, data: img.data, mimeType: img.mimeType })),
        });
      }
    });
    this.bridge.setOnRestartRequest(async (sessionId) => {
      const session = this.sessions.get(sessionId);
      if (!session?.webview) return false;
      try {
        await this._doLaunchProvider(session.webview, sessionId);
        return true;
      } catch {
        return false;
      }
    });

    return this.topicManager;
  }

  async handleTelegramSyncToggle(sessionId: string, webview: vscode.Webview): Promise<void> {
    let tm: TopicManager;
    try {
      tm = await this.getOrCreateTopicManager();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[telegram-sync] Config error: ${msg}`);
      vscode.window.showInformationMessage(msg);
      return;
    }

    const existing = tm.getTopicForSession(sessionId);
    try {
      if (existing !== undefined) {
        await tm.syncOff(sessionId);
        this.postToWebview(webview, { type: "state", data: { telegramSyncActive: false } } as any);
        this.output.appendLine(`[telegram-sync] Sync off for session ${sessionId}`);
        if (this.bridge && tm.activeSessions.length === 0) {
          this.bridge.stopPolling();
        }
      } else {
        const folderName = vscode.workspace.workspaceFolders?.[0]?.name ?? "Untitled";
        await tm.syncOn(sessionId, folderName);
        this.postToWebview(webview, { type: "state", data: { telegramSyncActive: true } } as any);
        this.output.appendLine(`[telegram-sync] Sync on for session ${sessionId}`);
        if (this.bridge) {
          this.bridge.startPolling();
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const config = vscode.workspace.getConfiguration("rokketWrapper");
      const telegramConfig = await loadTelegramConfig(this.context.secrets, config);
      const redacted = telegramConfig ? redactToken(msg, telegramConfig.botToken) : msg;
      this.output.appendLine(`[telegram-sync] Error: ${redacted}`);
    }
  }

  // ----------------------------------------------------------------
  // Voice transcription
  // ----------------------------------------------------------------

  private async handleVoiceTranscription(audioBuffer: Buffer, webview: vscode.Webview): Promise<void> {
    try {
      const config = vscode.workspace.getConfiguration("rokketWrapper");
      const provider = getVoiceProvider(config);
      const apiKey = await getTranscriptionApiKey(this.context.secrets, provider);
      if (!apiKey) {
        this.postToWebview(webview, { type: "voice_error", message: `No API key set for ${provider}. Open voice settings to configure.` } as any);
        return;
      }
      const text = await transcribeWithProvider(
        { provider, apiKey, azureRegion: getAzureRegion(config) },
        audioBuffer,
      );
      this.postToWebview(webview, { type: "voice_transcription", text } as any);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[voice] Transcription error: ${msg}`);
      this.postToWebview(webview, { type: "voice_error", message: msg } as any);
    }
  }

  private async handleStartRecording(webview: vscode.Webview): Promise<void> {
    try {
      await this.recorder.start();
      this.postToWebview(webview, { type: "voice_recording_started" } as any);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[voice] Recording start error: ${msg}`);
      this.postToWebview(webview, { type: "voice_error", message: msg } as any);
    }
  }

  private async handleStopRecording(webview: vscode.Webview): Promise<void> {
    try {
      this.postToWebview(webview, { type: "voice_recording_stopped" } as any);
      const audioBuffer = await this.recorder.stop();
      await this.handleVoiceTranscription(audioBuffer, webview);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[voice] Recording stop error: ${msg}`);
      this.postToWebview(webview, { type: "voice_error", message: msg } as any);
    }
  }

  private async sendVoiceConfig(webview: vscode.Webview): Promise<void> {
    const config = vscode.workspace.getConfiguration("rokketWrapper");
    const provider = getVoiceProvider(config);
    const azureRegion = getAzureRegion(config);
    const [openaiKey, azureKey, xaiKey] = await Promise.all([
      getTranscriptionApiKey(this.context.secrets, "openai"),
      getTranscriptionApiKey(this.context.secrets, "azure"),
      getTranscriptionApiKey(this.context.secrets, "xai"),
    ]);
    this.postToWebview(webview, {
      type: "voice_config",
      provider,
      hasOpenaiKey: !!openaiKey,
      hasAzureKey: !!azureKey,
      hasXaiKey: !!xaiKey,
      azureRegion,
    } as any);
    const validations = await Promise.all([
      openaiKey ? validateApiKey("openai", openaiKey).catch(() => false) : Promise.resolve(undefined),
      azureKey ? validateApiKey("azure", azureKey, { azureRegion }).catch(() => false) : Promise.resolve(undefined),
      xaiKey ? validateApiKey("xai", xaiKey).catch(() => false) : Promise.resolve(undefined),
    ]);
    this.postToWebview(webview, {
      type: "voice_config",
      provider,
      hasOpenaiKey: !!openaiKey,
      hasAzureKey: !!azureKey,
      hasXaiKey: !!xaiKey,
      openaiKeyVerified: validations[0] as boolean | undefined,
      azureKeyVerified: validations[1] as boolean | undefined,
      xaiKeyVerified: validations[2] as boolean | undefined,
      azureRegion,
    } as any);
  }

  private async setVoiceProviderConfig(provider: string): Promise<void> {
    const config = vscode.workspace.getConfiguration("rokketWrapper");
    await config.update("voiceTranscriptionProvider", provider, vscode.ConfigurationTarget.Global);
  }

  private async setVoiceApiKeyConfig(provider: string, key: string): Promise<void> {
    await setTranscriptionApiKey(this.context.secrets, provider as TranscriptionProvider, key);
  }

  private async setVoiceRegionConfig(regionType: "azure", value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) return;
    const config = vscode.workspace.getConfiguration("rokketWrapper");
    await config.update("azureSpeechRegion", trimmed, vscode.ConfigurationTarget.Global);
  }

  // ----------------------------------------------------------------
  // Session management
  // ----------------------------------------------------------------

  private getSession(sessionId: string): SessionState {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = createSessionState();
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private cleanupSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.bridge?.clearStreamingState(sessionId);
      cleanupSessionState(session);
      this.sessions.delete(sessionId);
    }
  }

  // ----------------------------------------------------------------
  // vscode.WebviewViewProvider
  // ----------------------------------------------------------------

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.webviewView = webviewView;

    let sessionId: string;
    const existingProvider = this.sidebarSessionId ? this.getSession(this.sidebarSessionId).provider : null;
    if (this.sidebarSessionId && existingProvider?.isRunning()) {
      sessionId = this.sidebarSessionId;
      this.getSession(sessionId).webview = webviewView.webview;
      this._bindProviderListeners(existingProvider, webviewView.webview, sessionId);
      this.output.appendLine(`[${sessionId}] Sidebar re-resolved — reusing existing session`);
    } else {
      if (this.sidebarSessionId) this.cleanupSession(this.sidebarSessionId);
      sessionId = `sidebar-${++this.sessionCounter}`;
      this.sidebarSessionId = sessionId;
    }

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };
    webviewView.webview.html = getWebviewHtml(this.extensionUri, webviewView.webview, sessionId);
    this.setupWebviewMessageHandling(webviewView.webview, sessionId);
  }

  openInTab(): void {
    const sessionId = `panel-${++this.sessionCounter}`;
    const panel = vscode.window.createWebviewPanel(
      "rokketWrapperPanel", "RokketWrapper", vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
      }
    );
    this.getSession(sessionId).panel = panel;
    panel.webview.html = getWebviewHtml(this.extensionUri, panel.webview, sessionId);
    this.setupWebviewMessageHandling(panel.webview, sessionId);
    panel.onDidDispose(() => {
      this.getSession(sessionId).panel = null;
      this.cleanupSession(sessionId);
    });
  }

  focus(): void {
    if (this.webviewView) this.webviewView.show(true);
    this.broadcastToAll({ type: "config", useCtrlEnterToSend: this.getUseCtrlEnter(), theme: this.getTheme() } as ExtensionToWebviewMessage);
  }

  onConfigChanged(): void {
    this.broadcastToAll({ type: "config", useCtrlEnterToSend: this.getUseCtrlEnter(), theme: this.getTheme() } as ExtensionToWebviewMessage);
  }

  onStatusUpdate(callback: (status: StatusBarUpdate) => void): void {
    this.statusCallback = callback;
  }

  private emitStatus(update: Partial<StatusBarUpdate>): void {
    this.lastStatus = { ...this.lastStatus, ...update };
    this.statusCallback?.(this.lastStatus);
  }

  // ----------------------------------------------------------------
  // Provider launch and event binding
  // ----------------------------------------------------------------

  private launchProvider(webview: vscode.Webview, sessionId: string, cwd?: string): Promise<void> {
    const existing = this.getSession(sessionId).launchPromise;
    if (existing) return existing;
    const promise = this._doLaunchProvider(webview, sessionId, cwd).finally(() => {
      this.getSession(sessionId).launchPromise = null;
    });
    this.getSession(sessionId).launchPromise = promise;
    return promise;
  }

  private _bindProviderListeners(provider: ClaudeCodeProvider, webview: vscode.Webview, sessionId: string): void {
    // Remove any existing listeners to avoid duplicates on re-resolve
    provider.removeAllListeners();

    provider.on("log", (msg: string) => {
      this.output.appendLine(`[${sessionId}] ${msg}`);
    });

    provider.on("agent_start", () => {
      const wv = this.getSession(sessionId).webview ?? webview;
      this.getSession(sessionId).isStreaming = true;
      this.emitStatus({ isStreaming: true });
      this.postToWebview(wv, { type: "process_status", status: "running" } as ExtensionToWebviewMessage);
    });

    provider.on("message_chunk", (text: string) => {
      const wv = this.getSession(sessionId).webview ?? webview;
      // Forward as a streaming delta — webview assembles the full message
      this.postToWebview(wv, { type: "stream_chunk", delta: text } as any);
      this.bridge?.handleStreamingChunk(sessionId, text);
    });

    provider.on("message_end", () => {
      const wv = this.getSession(sessionId).webview ?? webview;
      this.postToWebview(wv, { type: "stream_end" } as any);
    });

    provider.on("tool_call", (tool: { name: string; input: unknown; id: string }) => {
      const wv = this.getSession(sessionId).webview ?? webview;
      this.postToWebview(wv, { type: "tool_call", tool } as any);
      this.bridge?.handleToolStart(sessionId, tool.id, tool.name, tool.input);
    });

    provider.on("tool_result", (result: { id: string; content: string; isError: boolean }) => {
      const wv = this.getSession(sessionId).webview ?? webview;
      this.postToWebview(wv, { type: "tool_result", result } as any);
      this.bridge?.handleToolEnd(result.id, result.isError, 0);
    });

    provider.on("agent_end", (stats: { durationMs: number; costUsd?: number }) => {
      const wv = this.getSession(sessionId).webview ?? webview;
      this.getSession(sessionId).isStreaming = false;
      if (stats.costUsd !== undefined) {
        this.getSession(sessionId).accumulatedCost += stats.costUsd;
      }
      this.emitStatus({ isStreaming: false, cost: this.getSession(sessionId).accumulatedCost });
      this.postToWebview(wv, { type: "agent_end", durationMs: stats.durationMs, costUsd: stats.costUsd } as any);
      this.bridge?.handleAgentEnd(sessionId);
    });

    provider.on("error", (err: Error) => {
      const wv = this.getSession(sessionId).webview ?? webview;
      this.output.appendLine(`[${sessionId}] Provider error: ${err.message}`);
      this.getSession(sessionId).isStreaming = false;
      this.emitStatus({ isStreaming: false });
      this.postToWebview(wv, {
        type: "process_exit",
        code: null,
        signal: null,
        detail: `Claude Code error: ${err.message}. Make sure 'claude' is installed and in your PATH.`,
      });
      this.postToWebview(wv, { type: "process_status", status: "crashed" } as ExtensionToWebviewMessage);
    });
  }

  private async _doLaunchProvider(webview: vscode.Webview, sessionId: string, cwd?: string): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workingDir = cwd || workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    const config = vscode.workspace.getConfiguration("rokketWrapper");
    const claudePath = config.get<string>("claudeCodePath", "") || "claude";

    this.postToWebview(webview, { type: "process_status", status: "starting" } as ExtensionToWebviewMessage);

    const provider = new ClaudeCodeProvider(claudePath);
    this._bindProviderListeners(provider, webview, sessionId);
    this.getSession(sessionId).provider = provider;

    try {
      await provider.start(workingDir);
      this.output.appendLine(`[${sessionId}] ClaudeCodeProvider started in ${workingDir}`);
      this.postToWebview(webview, { type: "process_status", status: "running" } as ExtensionToWebviewMessage);
      this.postToWebview(webview, {
        type: "state",
        data: { telegramSyncActive: this.topicManager?.getTopicForSession(sessionId) !== undefined },
      } as any);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.postToWebview(webview, {
        type: "process_exit",
        code: null,
        signal: null,
        detail: `Failed to start Claude Code: ${msg}. Make sure 'claude' is installed and in your PATH.`,
      });
      this.postToWebview(webview, { type: "process_status", status: "crashed" } as ExtensionToWebviewMessage);
    }
  }

  // ----------------------------------------------------------------
  // Webview message handling
  // ----------------------------------------------------------------

  private setupWebviewMessageHandling(webview: vscode.Webview, sessionId: string): void {
    this.getSession(sessionId).webview = webview;
    const prev = this.getSession(sessionId).messageHandlerDisposable;
    if (prev) prev.dispose();

    const disposable = webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
      await this.handleWebviewMessage(webview, sessionId, msg);
    });
    this.getSession(sessionId).messageHandlerDisposable = disposable;
  }

  private async handleWebviewMessage(webview: vscode.Webview, sessionId: string, msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case "ready": {
        await this.checkWhatsNew(webview);
        this.postToWebview(webview, {
          type: "config",
          useCtrlEnterToSend: this.getUseCtrlEnter(),
          theme: this.getTheme(),
        } as ExtensionToWebviewMessage);
        this.postToWebview(webview, {
          type: "state",
          data: { telegramSyncActive: this.topicManager?.getTopicForSession(sessionId) !== undefined },
        } as any);
        await this.sendVoiceConfig(webview);
        break;
      }

      case "launch": {
        const cwd = typeof msg.cwd === "string" ? msg.cwd : undefined;
        await this.launchProvider(webview, sessionId, cwd);
        break;
      }

      case "prompt": {
        const text = typeof msg.text === "string" ? msg.text : "";
        if (!text.trim()) break;
        const session = this.getSession(sessionId);
        if (!session.provider) {
          // Auto-launch if not running
          await this.launchProvider(webview, sessionId);
        }
        try {
          await session.provider!.prompt(text);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.output.appendLine(`[${sessionId}] Prompt error: ${errMsg}`);
          this.postToWebview(webview, { type: "voice_error", message: errMsg } as any);
        }
        break;
      }

      case "abort": {
        const session = this.getSession(sessionId);
        await session.provider?.abort();
        break;
      }

      case "stop": {
        const session = this.getSession(sessionId);
        await session.provider?.stop();
        session.provider = null;
        this.postToWebview(webview, { type: "process_status", status: "stopped" } as ExtensionToWebviewMessage);
        break;
      }

      case "telegram_sync_toggle":
        await this.handleTelegramSyncToggle(sessionId, webview);
        break;

      case "cancel_telegram_question":
        if (typeof msg.requestId === "string") {
          this.bridge?.cancelQuestion(msg.requestId);
        }
        break;

      case "start_recording":
        await this.handleStartRecording(webview);
        break;

      case "stop_recording":
        await this.handleStopRecording(webview);
        break;

      case "cancel_recording":
        this.recorder.cancel();
        break;

      case "get_voice_config":
        await this.sendVoiceConfig(webview);
        break;

      case "set_voice_provider":
        if (typeof msg.provider === "string") await this.setVoiceProviderConfig(msg.provider);
        break;

      case "set_voice_api_key":
        if (typeof msg.provider === "string" && typeof msg.key === "string") {
          await this.setVoiceApiKeyConfig(msg.provider, msg.key);
        }
        break;

      case "set_voice_region":
        if (msg.regionType === "azure" && typeof msg.value === "string") {
          await this.setVoiceRegionConfig("azure", msg.value);
        }
        break;

      case "cleanup_temp":
        this.cleanupTempFiles();
        break;

      default:
        this.output.appendLine(`[${sessionId}] Unknown webview message type: ${msg.type}`);
    }
  }

  // ----------------------------------------------------------------
  // Utility
  // ----------------------------------------------------------------

  private postToWebview(webview: vscode.Webview, message: ExtensionToWebviewMessage | Record<string, unknown>): void {
    webview.postMessage(message);
  }

  public broadcast(message: ExtensionToWebviewMessage): boolean {
    return this.broadcastToAll(message);
  }

  private broadcastToAll(message: ExtensionToWebviewMessage): boolean {
    let delivered = false;
    if (this.webviewView) { this.webviewView.webview.postMessage(message); delivered = true; }
    for (const [, session] of this.sessions) {
      if (session.panel) { session.panel.webview.postMessage(message); delivered = true; }
    }
    return delivered;
  }

  private getUseCtrlEnter(): boolean {
    return vscode.workspace.getConfiguration("rokketWrapper").get<boolean>("useCtrlEnterToSend", false);
  }

  private getTheme(): string {
    return vscode.workspace.getConfiguration("rokketWrapper").get<string>("theme", "forge");
  }

  private static readonly LAST_VERSION_KEY = "rokketWrapper.lastSeenVersion";

  private async checkWhatsNew(webview: vscode.Webview): Promise<void> {
    const ext = vscode.extensions.getExtension("rokketek.rokket-wrapper");
    const currentVersion = ext?.packageJSON?.version;
    if (!currentVersion) return;
    const lastVersion = this.context.globalState.get<string>(RokketWrapperWebviewProvider.LAST_VERSION_KEY);
    await this.context.globalState.update(RokketWrapperWebviewProvider.LAST_VERSION_KEY, currentVersion);
    if (lastVersion === currentVersion) return;
    try {
      const notes = await fetchReleaseNotes(currentVersion);
      if (notes) {
        this.postToWebview(webview, { type: "whats_new", version: currentVersion, notes } as ExtensionToWebviewMessage);
      }
    } catch { /* best-effort */ }
  }

  private ensureTempDir(): string {
    if (!this.tempDir) {
      this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rokket-wrapper-attach-"));
      this.output.appendLine(`Temp dir created: ${this.tempDir}`);
    }
    return this.tempDir;
  }

  private cleanupTempFiles(): void {
    if (this.tempDir) {
      try { fs.rmSync(this.tempDir, { recursive: true, force: true }); }
      catch { /* best effort */ }
      this.tempDir = null;
    }
  }

  async disposeAsync(): Promise<void> {
    this.bridge?.stopPolling();
    if (this.topicManager) {
      try {
        await Promise.race([
          this.topicManager.disposeAll(),
          new Promise<void>((_, reject) => setTimeout(() => reject(new Error("disposeAll timed out")), 4000)),
        ]);
      } catch (err) {
        this.output.appendLine(`[telegram-sync] dispose error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const [, session] of this.sessions) {
      cleanupSessionState(session);
      if (session.panel) session.panel.dispose();
    }
    this.sessions.clear();
    this.output.dispose();
    this.cleanupTempFiles();
  }

  dispose(): void {
    this.disposeAsync().catch((err: unknown) =>
      console.error(`[rokket-wrapper] dispose error: ${err instanceof Error ? err.message : String(err)}`)
    );
  }
}
