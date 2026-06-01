import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ClaudeCodeProvider } from "./provider/ClaudeCodeProvider";
import { CodexProvider } from "./provider/CodexProvider";
import type { IAgentProvider } from "./provider/IAgentProvider";

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
import { WorkflowFsWatcher } from "./workflow-fs-watcher";
import { ConversationHistory, generateConversationId, type ConversationRecord, type HistoryMessage } from "./history";
import { downloadAndInstallUpdate, dismissUpdateVersion } from "./update-checker";

// ============================================================
// WebviewProvider — manages one Claude Code session per webview panel/sidebar
// ============================================================

export interface StatusBarUpdate {
  isStreaming: boolean;
  model?: string;
  cost?: number;
}

interface SessionState {
  provider: IAgentProvider | null;
  webview: vscode.Webview | null;
  panel: vscode.WebviewPanel | null;
  isStreaming: boolean;
  accumulatedCost: number;
  messageHandlerDisposable: vscode.Disposable | null;
  launchPromise: Promise<void> | null;
  selectedModel: string | null;
  selectedBackend: "claude-code" | "codex";
  selectedEffort: string | null;
  activeModel: string | null;
  conversationId: string | null;
  conversationMessages: HistoryMessage[];
  currentAssistantText: string;
  lastUserMessage: string | null;
  /** Live workflow disk watcher — null until a claude-code provider launches. */
  workflowFsWatcher: WorkflowFsWatcher | null;
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
    selectedModel: null,
    selectedBackend: "claude-code",
    selectedEffort: null,
    activeModel: null,
    conversationId: null,
    conversationMessages: [],
    currentAssistantText: "",
    lastUserMessage: null,
    workflowFsWatcher: null,
  };
}

function cleanupSessionState(session: SessionState): void {
  session.provider?.stop().catch(() => { /* best effort */ });
  session.provider = null;
  session.messageHandlerDisposable?.dispose();
  session.messageHandlerDisposable = null;
  session.workflowFsWatcher?.dispose();
  session.workflowFsWatcher = null;
}

interface SelectableModel {
  id: string;
  name: string;
  provider: "Claude Code CLI" | "OpenAI";
  agentBackend: "claude-code" | "codex";
  reasoning: boolean;
  contextWindow: number;
}

const ANTHROPIC_MODELS: SelectableModel[] = [
  { id: "claude-opus-4-7",          name: "Claude Opus 4.7",  provider: "Claude Code CLI", agentBackend: "claude-code", reasoning: true,  contextWindow: 1_000_000 },
  { id: "claude-opus-4-6",          name: "Claude Opus 4.6",  provider: "Claude Code CLI", agentBackend: "claude-code", reasoning: true,  contextWindow: 1_000_000 },
  { id: "claude-sonnet-4-6",        name: "Claude Sonnet 4.6",provider: "Claude Code CLI", agentBackend: "claude-code", reasoning: true,  contextWindow: 200_000   },
  { id: "claude-haiku-4-5-20251001",name: "Claude Haiku 4.5", provider: "Claude Code CLI", agentBackend: "claude-code", reasoning: false, contextWindow: 200_000   },
];

interface CodexModelsCacheEntry {
  slug: string;
  display_name: string;
  default_reasoning_level?: string;
  supported_reasoning_levels?: unknown[];
  visibility?: string;
}

// Fallback model list shown when Codex is installed but hasn't populated its cache yet
// (i.e. has never been run). These are the canonical Codex models as of early 2025.
const CODEX_DEFAULT_MODELS: SelectableModel[] = [
  { id: "codex-mini-latest", name: "Codex Mini (Latest)", provider: "OpenAI", agentBackend: "codex", reasoning: true, contextWindow: 200_000 },
  { id: "o4-mini",           name: "o4-mini",             provider: "OpenAI", agentBackend: "codex", reasoning: true, contextWindow: 200_000 },
];

function isCodexBinaryAvailable(): boolean {
  const candidates = process.platform === "win32"
    ? ["codex.cmd", "codex"]
    : ["codex"];
  const searchDirs = (process.env.PATH || "").split(process.platform === "win32" ? ";" : ":");
  for (const bin of candidates) {
    for (const dir of searchDirs) {
      try {
        const full = path.join(dir, bin);
        if (fs.statSync(full).isFile()) return true;
      } catch { /* not there */ }
    }
  }
  return false;
}

async function loadCodexModels(): Promise<SelectableModel[]> {
  try {
    const cachePath = path.join(os.homedir(), ".codex", "models_cache.json");
    const raw = await fs.promises.readFile(cachePath, "utf-8");
    const cache = JSON.parse(raw) as { models: CodexModelsCacheEntry[] };
    return cache.models
      .filter(m => m.visibility !== "hide")
      .map(m => ({
        id: m.slug,
        name: m.display_name,
        provider: "OpenAI" as const,
        agentBackend: "codex" as const,
        reasoning: Array.isArray(m.supported_reasoning_levels) && m.supported_reasoning_levels.length > 1,
        contextWindow: 200_000,
      }));
  } catch {
    // Cache not yet populated (Codex installed but never run). Fall back to
    // binary detection so the model picker still shows Codex options.
    if (isCodexBinaryAvailable()) return CODEX_DEFAULT_MODELS;
    return [];
  }
}

async function getSelectableModels(): Promise<SelectableModel[]> {
  return [...ANTHROPIC_MODELS, ...(await loadCodexModels())];
}

function resolveModelInfo(id: string): SelectableModel {
  const found = ANTHROPIC_MODELS.find(m => m.id === id);
  if (found) return found;
  // Fallback for unknown IDs
  const claudeMatch = id.toLowerCase().match(/^claude-(\w+)-(\d+)-(\d+)(?:-.*)?$/);
  if (claudeMatch) {
    const family = claudeMatch[1].charAt(0).toUpperCase() + claudeMatch[1].slice(1);
    return { id, name: `Claude ${family} ${claudeMatch[2]}.${claudeMatch[3]}`, provider: "Claude Code CLI", agentBackend: "claude-code", reasoning: true, contextWindow: 200_000 };
  }
  // Unknown non-Claude ID — assume it's a Codex model
  return { id, name: id, provider: "OpenAI", agentBackend: "codex", reasoning: false, contextWindow: 200_000 };
}

function agentBackendForModel(modelId: string): "claude-code" | "codex" {
  return resolveModelInfo(modelId).agentBackend;
}

const THINKING_LEVELS = ["off", "low", "medium", "high", "xhigh"] as const;

const EFFORT_MAP: Record<string, string> = {
  off: "low",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
};

const CLAUDE_CODE_COMMANDS = [
  { name: "compact", description: "Compact conversation context", source: "claude-code" },
  { name: "help", description: "Show available commands", source: "claude-code" },
  { name: "status", description: "Show current session status", source: "claude-code" },
  { name: "clear", description: "Clear conversation history", source: "claude-code" },
  { name: "config", description: "View or change settings", source: "claude-code" },
  { name: "review", description: "Review code changes", source: "claude-code" },
  { name: "init", description: "Initialize CLAUDE.md for this project", source: "claude-code" },
  { name: "bug", description: "Report a bug", source: "claude-code" },
  { name: "doctor", description: "Check Claude Code health", source: "claude-code" },
];

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
  private history!: ConversationHistory;
  private resolvedExtensionVersion: string | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext,
    output?: vscode.OutputChannel
  ) {
    this.output = output ?? vscode.window.createOutputChannel("RokketWrapper");
    this.history = new ConversationHistory(this.context.globalState);
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
    this.topicManager = new TopicManager(
      api,
      telegramConfig.chatId,
      vscode.env.machineId,
      logger,
      this.context.globalState,
      async (newChatId: number) => {
        this.bridge?.setChatId(newChatId);
        try {
          await vscode.workspace
            .getConfiguration("rokketWrapper")
            .update("telegramGroupId", newChatId, vscode.ConfigurationTarget.Global);
          this.output.appendLine(`[telegram-topic] Persisted migrated group id ${newChatId}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.output.appendLine(`[telegram-topic] WARN: failed to persist migrated group id: ${msg}`);
        }
      },
    );

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
        return {
          client: s.provider ? {
            abort: () => s.provider!.abort(),
            prompt: (message: string, images?: import("./telegram/bridge").BridgeImage[]) =>
              s.provider!.prompt(message, images),
          } : null,
          isStreaming: s.isStreaming,
        };
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
    this.bridge.setOnInboundMessage((sessionId, text, images, opts) => {
      // General-topic messages are routed to the leader session but not mirrored
      // into its webview transcript (they aren't part of that conversation's view).
      if (opts?.isGeneralTopic) return;
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
        if (this.bridge) {
          // Reassign the General-topic leader to the next active session, or clear it.
          const remaining = tm.activeSessions;
          this.bridge.setGeneralSession(remaining.length > 0 ? remaining[0] : null);
          if (remaining.length === 0) {
            this.bridge.stopPolling();
          }
        }
      } else {
        const folderName = vscode.workspace.workspaceFolders?.[0]?.name ?? "Untitled";
        await tm.syncOn(sessionId, folderName);
        this.postToWebview(webview, { type: "state", data: { telegramSyncActive: true } } as any);
        this.output.appendLine(`[telegram-sync] Sync on for session ${sessionId}`);
        if (this.bridge) {
          this.bridge.startPolling();
          // First synced session becomes the General-topic leader.
          if (!this.bridge.getGeneralSessionId()) {
            this.bridge.setGeneralSession(sessionId);
          }
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
      this.output.appendLine(`[voice] Buffer received: ${audioBuffer.length} bytes`);
      if (audioBuffer.length < 1000) {
        this.output.appendLine(`[voice] Recording too short (${audioBuffer.length} bytes) — dropping`);
        this.postToWebview(webview, { type: "voice_error", message: "Recording too short — no audio captured." } as any);
        return;
      }
      const config = vscode.workspace.getConfiguration("rokketWrapper");
      const provider = getVoiceProvider(config);
      this.output.appendLine(`[voice] Transcribing with provider: ${provider}`);
      const apiKey = await getTranscriptionApiKey(this.context.secrets, provider);
      if (!apiKey) {
        this.output.appendLine(`[voice] No API key set for provider: ${provider}`);
        this.postToWebview(webview, { type: "voice_error", message: `No API key set for ${provider}. Open voice settings to configure.` } as any);
        return;
      }
      const text = await transcribeWithProvider(
        { provider, apiKey, azureRegion: getAzureRegion(config) },
        audioBuffer,
        "voice.wav",
      );
      if (!text.trim()) {
        this.postToWebview(webview, { type: "voice_error", message: "No speech detected. Try again." } as any);
        return;
      }
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
      this._bindProviderListeners(existingProvider, webviewView.webview, sessionId, this.getSession(sessionId).selectedBackend);
      this.output.appendLine(`[${sessionId}] Sidebar re-resolved — reusing existing session`);
    } else {
      if (this.sidebarSessionId) this.cleanupSession(this.sidebarSessionId);
      sessionId = `sidebar-${++this.sessionCounter}`;
      this.sidebarSessionId = sessionId;
    }

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist"), this.extensionUri],
    };
    webviewView.webview.html = getWebviewHtml(this.extensionUri, webviewView.webview, sessionId, this.getExtensionVersion());
    this.setupWebviewMessageHandling(webviewView.webview, sessionId);
    // The HTML rebuild above wipes any rendered live-workflow cards. Replay the
    // last snapshot of each tracked run into the fresh webview so in-flight and
    // completed cards survive a sidebar hide/show.
    this.getSession(sessionId).workflowFsWatcher?.rebindWebview(webviewView.webview);
  }

  openInTab(): void {
    const sessionId = `panel-${++this.sessionCounter}`;
    const panel = vscode.window.createWebviewPanel(
      "rokketWrapperPanel", "RokketWrapper", vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist"), this.extensionUri],
      }
    );
    this.getSession(sessionId).panel = panel;
    panel.webview.html = getWebviewHtml(this.extensionUri, panel.webview, sessionId, this.getExtensionVersion());
    this.setupWebviewMessageHandling(panel.webview, sessionId);
    panel.onDidDispose(() => {
      this.getSession(sessionId).panel = null;
      this.cleanupSession(sessionId);
    });
  }

  focus(): void {
    if (this.webviewView) this.webviewView.show(true);
    this.broadcastConfig();
  }

  onConfigChanged(): void {
    this.broadcastConfig();
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

  private _bindProviderListeners(provider: IAgentProvider, webview: vscode.Webview, sessionId: string, agentBackend: "claude-code" | "codex" = "claude-code"): void {
    // Remove any existing listeners to avoid duplicates on re-resolve
    provider.removeAllListeners();

    provider.on("log", (msg: string) => {
      this.output.appendLine(`[${sessionId}] ${msg}`);
    });

    provider.on("system_init", (info: { sessionId: string; model: string }) => {
      const session = this.getSession(sessionId);
      session.activeModel = info.model;
      const wv = session.webview ?? webview;
      const resolved = resolveModelInfo(info.model);
      this.postToWebview(wv, {
        type: "state",
        data: { model: resolved },
      } as any);
    });

    provider.on("agent_start", () => {
      const wv = this.getSession(sessionId).webview ?? webview;
      this.getSession(sessionId).isStreaming = true;
      this.emitStatus({ isStreaming: true });
      this.postToWebview(wv, { type: "agent_start" } as any);
    });

    provider.on("message_chunk", (text: string) => {
      const session = this.getSession(sessionId);
      session.currentAssistantText += text;
      const wv = session.webview ?? webview;
      this.postToWebview(wv, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: text },
      } as any);
      this.bridge?.handleStreamingChunk(sessionId, text);
    });

    provider.on("message_end", (usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }) => {
      const wv = this.getSession(sessionId).webview ?? webview;
      this.postToWebview(wv, {
        type: "message_end",
        message: {
          role: "assistant",
          ...(usage ? { usage } : {}),
        },
      } as any);
    });

    provider.on("tool_call", (tool: { name: string; input: unknown; id: string }) => {
      const wv = this.getSession(sessionId).webview ?? webview;
      this.postToWebview(wv, {
        type: "tool_execution_start",
        toolCallId: tool.id,
        toolName: tool.name,
        args: tool.input,
      } as any);
      this.bridge?.handleToolStart(sessionId, tool.id, tool.name, tool.input);
    });

    provider.on("tool_result", (result: { id: string; content: string; isError: boolean }) => {
      const wv = this.getSession(sessionId).webview ?? webview;
      this.postToWebview(wv, {
        type: "tool_execution_end",
        toolCallId: result.id,
        isError: result.isError,
        result: { content: [{ type: "text", text: result.content }] },
      } as any);
      this.bridge?.handleToolEnd(result.id, result.isError, 0);
    });

    provider.on("agent_end", (stats: { durationMs: number; costUsd?: number; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoningOutput?: number }; contextWindow?: number }) => {
      const session = this.getSession(sessionId);
      const wv = session.webview ?? webview;
      session.isStreaming = false;
      if (stats.costUsd !== undefined) {
        session.accumulatedCost += stats.costUsd;
      }
      this.emitStatus({ isStreaming: false, cost: session.accumulatedCost });

      if (stats.contextWindow) {
        this.postToWebview(wv, {
          type: "session_stats",
          data: { contextWindow: stats.contextWindow },
        } as any);
      }

      if (stats.usage || stats.costUsd !== undefined) {
        this.postToWebview(wv, {
          type: "cost_update",
          runId: sessionId,
          turnCost: stats.costUsd ?? 0,
          cumulativeCost: session.accumulatedCost,
          tokens: {
            input: stats.usage?.input ?? 0,
            output: stats.usage?.output ?? 0,
            cacheRead: stats.usage?.cacheRead ?? 0,
            cacheWrite: stats.usage?.cacheWrite ?? 0,
            reasoningOutput: stats.usage?.reasoningOutput,
          },
        } as any);
      }

      this.postToWebview(wv, { type: "agent_end", durationMs: stats.durationMs, costUsd: stats.costUsd } as any);
      this.bridge?.handleAgentEnd(sessionId);

      // Save assistant response to history
      if (session.currentAssistantText.trim()) {
        session.conversationMessages.push({
          role: "assistant",
          text: session.currentAssistantText,
          timestamp: Date.now(),
        });
        session.currentAssistantText = "";
        this.persistConversation(session).catch((err: unknown) => {
          console.error("[rokket] Failed to persist conversation:", err);
          void vscode.window.showWarningMessage("RokketWrapper: Failed to save conversation history.");
        });
      }
    });

    provider.on("error", (err: Error) => {
      const wv = this.getSession(sessionId).webview ?? webview;
      this.output.appendLine(`[${sessionId}] Provider error: ${err.message}`);
      this.getSession(sessionId).isStreaming = false;
      this.emitStatus({ isStreaming: false });
      // Process crashed/exited — retract any still-visible live workflow cards so
      // a dead run doesn't leave a stuck "running" panel in the conversation.
      this.getSession(sessionId).workflowFsWatcher?.onProcessExit();
      const providerName = agentBackend === "codex" ? "Codex" : "Claude Code";
      const providerCmd = agentBackend === "codex" ? "codex" : "claude";
      const installHint = agentBackend === "codex"
        ? "Install with: npm install -g @openai/codex"
        : "Install with: npm install -g @anthropic-ai/claude-code";
      const isNotFound = err.message.includes("ENOENT") || err.message.includes("not found");
      const isExitCode = err.message.includes("exited with code");
      const detail = isNotFound
        ? `${providerName} CLI not found. ${installHint}. Then restart VS Code.`
        : isExitCode
          ? `${providerName} crashed. ${err.message}`
          : `${providerName} error: ${err.message}. Make sure '${providerCmd}' is installed and in your PATH.`;
      this.postToWebview(wv, {
        type: "process_exit",
        code: null,
        signal: null,
        detail,
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

    const session = this.getSession(sessionId);
    // Relaunch (session switch / restart / cold start): retract any live cards
    // from the previous provider and tear down its watcher before starting fresh,
    // so a stale "running" card can't strand and timers don't leak.
    session.workflowFsWatcher?.onProcessExit();
    session.workflowFsWatcher = null;
    // Re-derive backend from model at launch time — session.selectedBackend may lag behind
    // if set_model hasn't arrived yet when a prompt auto-triggers launch.
    // Fall back to globalState so we never launch the wrong provider on cold start.
    const resolvedModel = session.selectedModel
      ?? this.context.globalState.get<string>(RokketWrapperWebviewProvider.LAST_MODEL_KEY)
      ?? null;
    if (resolvedModel && !session.selectedModel) {
      session.selectedModel = resolvedModel;
    }
    const agentBackend = resolvedModel
      ? agentBackendForModel(resolvedModel)
      : session.selectedBackend;
    session.selectedBackend = agentBackend;
    let provider: IAgentProvider;
    if (agentBackend === "codex") {
      const codexBase = config.get<string>("codexPath", "") || (process.platform === "win32" ? "codex.cmd" : "codex");
      const cp = new CodexProvider(codexBase);
      cp.model = resolvedModel;
      provider = cp;
    } else {
      const cp = new ClaudeCodeProvider(claudePath);
      cp.model = resolvedModel;
      cp.effort = session.selectedEffort;
      provider = cp;
    }
    this._bindProviderListeners(provider, webview, sessionId, agentBackend);
    session.provider = provider;

    this.output.appendLine(`[${sessionId}] _doLaunchProvider: model=${resolvedModel ?? "null"} resolvedBackend=${agentBackend}`);
    try {
      await provider.start(workingDir);
      this.output.appendLine(`[${sessionId}] ${agentBackend} provider started in ${workingDir}`);
      this.postToWebview(webview, { type: "process_status", status: "running" } as ExtensionToWebviewMessage);
      this.postToWebview(webview, {
        type: "state",
        data: { telegramSyncActive: this.topicManager?.getTopicForSession(sessionId) !== undefined },
      } as any);

      // Live workflow visibility: tail the on-disk journal for Claude Code
      // `Workflow` fan-outs. Codex writes no Claude workflow journal, so gate it
      // off there. The watcher only needs the project cwd to derive the slug.
      if (agentBackend !== "codex") {
        const fsWatcher = new WorkflowFsWatcher(sessionId, webview, this.output, workingDir);
        session.workflowFsWatcher = fsWatcher;
        fsWatcher.start();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const providerName = agentBackend === "codex" ? "Codex" : "Claude Code";
      const providerCmd = agentBackend === "codex" ? "codex" : "claude";
      const installHint = agentBackend === "codex"
        ? "Install with: npm install -g @openai/codex"
        : "Install with: npm install -g @anthropic-ai/claude-code";
      const isNotFound = msg.includes("ENOENT") || msg.includes("not found");
      const detail = isNotFound
        ? `${providerName} CLI not found. ${installHint}. Then restart VS Code.`
        : `Failed to start ${providerName}: ${msg}. Make sure '${providerCmd}' is installed and in your PATH.`;
      this.postToWebview(webview, {
        type: "process_exit",
        code: null,
        signal: null,
        detail,
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
        this.postToWebview(webview, {
          type: "config",
          useCtrlEnterToSend: this.getUseCtrlEnter(),
          theme: this.getTheme(),
          extensionVersion: this.getExtensionVersion(),
        } as ExtensionToWebviewMessage);
        this.checkWhatsNew(webview).catch(() => {});
        const readySession = this.getSession(sessionId);
        const availableModels = await getSelectableModels();
        let persistedModel = readySession.selectedModel
          ?? this.context.globalState.get<string>(RokketWrapperWebviewProvider.LAST_MODEL_KEY) ?? null;
        // If the persisted model is a known Codex model slug that no longer exists in the cache, clear it.
        if (persistedModel && agentBackendForModel(persistedModel) === "codex" &&
            !availableModels.find(m => m.id === persistedModel)) {
          persistedModel = availableModels.find(m => m.agentBackend === "codex")?.id ?? null;
          this.context.globalState.update(RokketWrapperWebviewProvider.LAST_MODEL_KEY, persistedModel);
        }
        const currentModel = persistedModel;
        const persistedThinking = this.context.globalState.get<string>(RokketWrapperWebviewProvider.LAST_THINKING_KEY) ?? null;
        if (currentModel && !readySession.selectedModel) {
          readySession.selectedModel = currentModel;
          readySession.selectedBackend = agentBackendForModel(currentModel);
          if (readySession.provider) readySession.provider.model = currentModel;
        }
        if (persistedThinking && !readySession.selectedEffort) {
          const effort = EFFORT_MAP[persistedThinking] || null;
          readySession.selectedEffort = persistedThinking === "off" ? null : effort;
          if (readySession.provider) readySession.provider.effort = readySession.selectedEffort;
        }
        this.postToWebview(webview, {
          type: "state",
          data: {
            telegramSyncActive: this.topicManager?.getTopicForSession(sessionId) !== undefined,
            ...(currentModel ? { model: resolveModelInfo(currentModel) } : {}),
            ...(persistedThinking ? { thinkingLevel: persistedThinking } : {}),
          },
        } as any);
        await this.sendVoiceConfig(webview);
        break;
      }

      case "launch": {
        const cwd = typeof msg.cwd === "string" ? msg.cwd : undefined;
        await this.launchProvider(webview, sessionId, cwd);
        break;
      }

      case "get_commands": {
        this.postToWebview(webview, { type: "commands", commands: CLAUDE_CODE_COMMANDS } as any);
        break;
      }

      case "prompt": {
        const text = typeof msg.text === "string" ? msg.text : typeof msg.message === "string" ? msg.message : "";
        const hasImages = Array.isArray(msg.images) && msg.images.length > 0;
        if (!text.trim() && !hasImages) break;
        const session = this.getSession(sessionId);
        if (!session.provider) {
          await this.launchProvider(webview, sessionId);
        }

        // Initialize conversation on first prompt
        if (!session.conversationId) {
          session.conversationId = generateConversationId();
          session.conversationMessages = [];
          session.currentAssistantText = "";
        }

        // Record user message
        session.conversationMessages.push({
          role: "user",
          text,
          timestamp: Date.now(),
        });
        session.lastUserMessage = text;

        const images = Array.isArray(msg.images) ? msg.images : undefined;
        try {
          await session.provider!.prompt(text, images);
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
      case "voice_start_recording":
        await this.handleStartRecording(webview);
        break;

      case "stop_recording":
      case "voice_stop_recording":
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

      case "set_telegram_bot_token":
        if (typeof msg.token === "string" && msg.token.trim()) {
          await this.context.secrets.store("gsd.telegramBotToken", msg.token.trim());
        }
        break;

      case "launch_gsd": {
        const cwd = typeof msg.cwd === "string" ? msg.cwd : undefined;
        await this.launchProvider(webview, sessionId, cwd);
        break;
      }

      case "get_available_models": {
        this.postToWebview(webview, { type: "available_models", models: await getSelectableModels() } as any);
        break;
      }

      case "set_model": {
        const modelId = typeof msg.modelId === "string" ? msg.modelId : null;
        const session = this.getSession(sessionId);
        const newBackend = modelId ? agentBackendForModel(modelId) : "claude-code";
        const backendChanged = newBackend !== session.selectedBackend;
        session.selectedModel = modelId;
        session.selectedBackend = newBackend;
        if (session.provider) {
          if (backendChanged) {
            // Provider type changed — stop existing provider; next prompt will create a new one.
            // Also clear its model so if ensureProcess fires on the stale object it won't spawn
            // with a mismatched model (handles the resolveShellEnv async race).
            session.provider.model = null;
            session.provider.stop().catch(() => { /* best effort */ });
            session.provider = null;
          } else {
            session.provider.model = modelId;
          }
        }
        this.context.globalState.update(RokketWrapperWebviewProvider.LAST_MODEL_KEY, modelId);
        this.output.appendLine(`[${sessionId}] Model set to: ${modelId} (backend: ${newBackend})`);
        if (modelId) {
          this.postToWebview(webview, {
            type: "state",
            data: {
              model: resolveModelInfo(modelId),
            },
          } as any);
        }
        break;
      }

      case "set_thinking_level": {
        const level = typeof msg.level === "string" ? msg.level : "off";
        const session = this.getSession(sessionId);
        const effort = EFFORT_MAP[level] || null;
        session.selectedEffort = level === "off" ? null : effort;
        if (session.provider) {
          session.provider.effort = session.selectedEffort;
        }
        this.context.globalState.update(RokketWrapperWebviewProvider.LAST_THINKING_KEY, level);
        this.output.appendLine(`[${sessionId}] Thinking level set to: ${level} (effort: ${effort})`);
        this.postToWebview(webview, { type: "thinking_level_changed", level } as any);
        break;
      }

      case "cycle_thinking_level": {
        const session = this.getSession(sessionId);
        const currentEffort = session.selectedEffort;
        const currentIdx = THINKING_LEVELS.findIndex(l => EFFORT_MAP[l] === currentEffort);
        const nextIdx = (currentIdx + 1) % THINKING_LEVELS.length;
        const nextLevel = THINKING_LEVELS[nextIdx];
        const effort = EFFORT_MAP[nextLevel] || null;
        session.selectedEffort = nextLevel === "off" ? null : effort;
        if (session.provider) {
          session.provider.effort = session.selectedEffort;
        }
        this.context.globalState.update(RokketWrapperWebviewProvider.LAST_THINKING_KEY, nextLevel);
        this.output.appendLine(`[${sessionId}] Thinking cycled to: ${nextLevel} (effort: ${effort})`);
        this.postToWebview(webview, { type: "thinking_level_changed", level: nextLevel } as any);
        break;
      }

      case "new_conversation": {
        const session = this.getSession(sessionId);
        session.provider?.resetSession();
        session.conversationId = null;
        session.conversationMessages = [];
        session.currentAssistantText = "";
        session.lastUserMessage = null;
        // Retract prior cards and advance the admission watermark so a previous
        // conversation's journals can't re-surface as fresh runs.
        session.workflowFsWatcher?.onNewConversation();
        break;
      }

      case "get_session_list": {
        const sessions = this.history.list();
        this.postToWebview(webview, { type: "session_list", sessions } as any);
        break;
      }

      case "switch_session": {
        const targetId = typeof msg.path === "string" ? msg.path : "";
        if (!targetId) break;
        const record = this.history.get(targetId);
        if (!record) {
          this.postToWebview(webview, { type: "session_list_error", message: "Session not found" } as any);
          break;
        }

        const session = this.getSession(sessionId);
        // Stop current provider
        if (session.provider) {
          await session.provider.stop();
          session.provider = null;
        }

        // Set up for continuation
        session.conversationId = record.id;
        session.conversationMessages = [...record.messages];
        session.currentAssistantText = "";
        session.lastUserMessage = null;

        // Convert history messages to AgentMessage format for display
        const agentMessages = record.messages.map(m => ({
          role: m.role as "user" | "assistant",
          content: m.text,
          timestamp: m.timestamp,
        }));

        this.postToWebview(webview, {
          type: "session_switched",
          state: {
            model: session.selectedModel ? resolveModelInfo(session.selectedModel) : null,
            isStreaming: false,
            isCompacting: false,
            sessionId: record.id,
            sessionName: record.title,
            messageCount: record.messages.length,
            autoCompactionEnabled: false,
            thinkingLevel: "off",
            sessionFile: null,
          },
          messages: agentMessages,
        } as any);

        // Relaunch provider and inject summary for context
        await this.launchProvider(webview, sessionId);
        const refreshed = this.getSession(sessionId);
        if (refreshed.provider) {
          const summary = this.history.buildSummaryPrompt(record);
          try {
            await refreshed.provider.prompt(summary);
          } catch {
            // Best effort — the conversation is still displayed
          }
        }
        break;
      }

      case "delete_session": {
        const deleteId = typeof msg.path === "string" ? msg.path : "";
        if (deleteId) {
          await this.history.delete(deleteId);
          const session = this.getSession(sessionId);
          if (session.conversationId === deleteId) {
            session.conversationId = null;
            session.conversationMessages = [];
          }
        }
        break;
      }

      case "rename_session": {
        const newName = typeof msg.name === "string" ? msg.name : "";
        const session = this.getSession(sessionId);
        if (newName && session.conversationId) {
          await this.history.rename(session.conversationId, newName);
        }
        break;
      }

      case "get_session_stats":
        break;

      case "update_install": {
        const downloadUrl = typeof msg.downloadUrl === "string" ? msg.downloadUrl : "";
        if (downloadUrl) {
          await downloadAndInstallUpdate(downloadUrl, this.context);
        }
        break;
      }

      case "update_dismiss": {
        const dismissVersion = typeof msg.version === "string" ? msg.version : "";
        if (dismissVersion) {
          await dismissUpdateVersion(dismissVersion, this.context);
        }
        break;
      }

      case "cleanup_temp":
        this.cleanupTempFiles();
        break;

      case "open_url": {
        const rawUrl = (msg as { url?: string }).url ?? "";
        let parsed: URL;
        try { parsed = new URL(rawUrl); } catch { break; }
        if (["https:", "http:", "mailto:"].includes(parsed.protocol)) {
          void vscode.env.openExternal(vscode.Uri.parse(rawUrl));
        }
        break;
      }

      default:
        this.output.appendLine(`[${sessionId}] Unknown webview message type: ${msg.type}`);
    }
  }

  // ----------------------------------------------------------------
  // Utility
  // ----------------------------------------------------------------

  private async persistConversation(session: SessionState): Promise<void> {
    if (!session.conversationId || session.conversationMessages.length === 0) return;
    const firstUserMsg = session.conversationMessages.find(m => m.role === "user");
    const title = firstUserMsg
      ? (firstUserMsg.text.length > 80 ? firstUserMsg.text.slice(0, 80) + "..." : firstUserMsg.text)
      : "Untitled";
    const record: ConversationRecord = {
      id: session.conversationId,
      title,
      model: session.activeModel,
      messages: session.conversationMessages,
      created: session.conversationMessages[0]?.timestamp ?? Date.now(),
      modified: Date.now(),
    };
    await this.history.save(record);
  }

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

  private getExtensionVersion(): string {
    if (this.resolvedExtensionVersion !== null) return this.resolvedExtensionVersion;

    const candidates = [
      this.context.extension?.packageJSON?.version,
      this.context.extension?.id
        ? vscode.extensions.getExtension(this.context.extension.id)?.packageJSON?.version
        : undefined,
      vscode.extensions.getExtension("rokketek.rokketek-wrapper")?.packageJSON?.version,
      vscode.extensions.getExtension("rokketek.rokket-wrapper")?.packageJSON?.version,
      this.readPackageJsonVersion(),
    ];

    const version = candidates.find((candidate): candidate is string =>
      typeof candidate === "string" && candidate.trim().length > 0
    );
    this.resolvedExtensionVersion = version ?? "";
    return this.resolvedExtensionVersion;
  }

  private readPackageJsonVersion(): string | undefined {
    try {
      const packagePath = path.join(this.extensionUri.fsPath, "package.json");
      const raw = fs.readFileSync(packagePath, "utf8");
      const parsed = JSON.parse(raw) as { version?: unknown };
      return typeof parsed.version === "string" ? parsed.version : undefined;
    } catch {
      return undefined;
    }
  }

  private broadcastConfig(): boolean {
    return this.broadcastToAll({
      type: "config",
      useCtrlEnterToSend: this.getUseCtrlEnter(),
      theme: this.getTheme(),
      extensionVersion: this.getExtensionVersion(),
    } as ExtensionToWebviewMessage);
  }

  private static readonly LAST_VERSION_KEY = "rokketWrapper.lastSeenVersion";
  private static readonly LAST_MODEL_KEY = "rokketWrapper.lastModel";
  private static readonly LAST_THINKING_KEY = "rokketWrapper.lastThinkingLevel";

  private async checkWhatsNew(webview: vscode.Webview): Promise<void> {
    const currentVersion = this.getExtensionVersion();
    if (!currentVersion) return;
    const lastVersion = this.context.globalState.get<string>(RokketWrapperWebviewProvider.LAST_VERSION_KEY);
    await this.context.globalState.update(RokketWrapperWebviewProvider.LAST_VERSION_KEY, currentVersion);
    if (lastVersion === currentVersion) return;
    this.postToWebview(webview, { type: "whats_new", version: currentVersion, notes: "" } as ExtensionToWebviewMessage);
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
