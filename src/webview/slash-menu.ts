// ============================================================
// Slash Menu — command palette triggered by typing /
// ============================================================

import { state } from "./state";
import { escapeHtml } from "./helpers";

// ============================================================
// Types
// ============================================================

interface SlashMenuItem {
  name: string;
  description: string;
  insertText: string;
  source?: string;
  /** When true, selecting this item sends it as a prompt immediately */
  sendOnSelect?: boolean;
}

// ============================================================
// Module state
// ============================================================

let slashMenuVisible = false;
let slashMenuIndex = 0;
let filteredItems: SlashMenuItem[] = [];
let _cachedItems: SlashMenuItem[] | null = null;
let _cachedCommandsRef: unknown = null;

// ============================================================
// Dependencies injected via init()
// ============================================================

let slashMenuEl: HTMLElement;
let promptInput: HTMLTextAreaElement;
let vscode: { postMessage(msg: unknown): void };

/** Callbacks back into the main module */
let onAutoResize: () => void;
let onShowModelPicker: () => void;
let onNewConversation: () => void;
let onSendMessage: () => void;
let onShowHistory: (() => void) | undefined;
let onCopyLast: (() => void) | undefined;
let onToggleAutoCompact: (() => void) | undefined;
let onToggleAutoRetry: (() => void) | undefined;
let onShowSettings: (() => void) | undefined;

// ============================================================
// Public API
// ============================================================

export function isVisible(): boolean {
  return slashMenuVisible;
}

export function getIndex(): number {
  return slashMenuIndex;
}

export function getFilteredItems(): SlashMenuItem[] {
  return filteredItems;
}

let _triggerEl: HTMLElement | null = null;

export function show(filter: string): void {
  if (!slashMenuVisible) {
    _triggerEl = document.activeElement as HTMLElement | null;
  }
  if (!state.commandsLoaded) {
    vscode.postMessage({ type: "get_commands" });
  }
  const q = filter.toLowerCase();
  if (!_cachedItems || _cachedCommandsRef !== state.commands) {
    _cachedItems = buildItems();
    _cachedCommandsRef = state.commands;
  }
  const allItems = _cachedItems;
  filteredItems = allItems.filter(
    (item) => item.name.toLowerCase().includes(q) || item.description.toLowerCase().includes(q)
  );
  if (filteredItems.length === 0) {
    hide();
    return;
  }
  slashMenuIndex = 0;
  slashMenuVisible = true;
  render();
}

export function hide(): void {
  slashMenuVisible = false;
  slashMenuEl.classList.add("gsd-hidden");
  slashMenuEl.innerHTML = "";
  promptInput?.removeAttribute("aria-activedescendant");
  // Restore focus to prompt input (slash menu is always triggered from input)
  promptInput?.focus();
  _triggerEl = null;
}

export function navigateDown(): void {
  slashMenuIndex = Math.min(slashMenuIndex + 1, filteredItems.length - 1);
  render();
}

export function navigateUp(): void {
  slashMenuIndex = Math.max(slashMenuIndex - 1, 0);
  render();
}

export function selectCurrent(): void {
  selectCommand(slashMenuIndex);
}

// ============================================================
// Internal
// ============================================================

/** @internal — exported for testing */
export function buildItems(): SlashMenuItem[] {
  const items: SlashMenuItem[] = [];

  for (const cmd of state.commands) {
    items.push({
      name: cmd.name,
      description: cmd.description || "",
      insertText: `/${cmd.name} `,
      source: cmd.source,
    });
  }

  items.push(
    { name: "new", description: "Start a new conversation", insertText: "", source: "webview" },
    { name: "copy", description: "Copy last assistant message to clipboard", insertText: "", source: "webview" },
    { name: "export", description: "Export current conversation as HTML file", insertText: "", source: "webview" },
    { name: "telegram", description: "Start Telegram streaming — opens setup and connects", insertText: "", source: "webview" },
    { name: "telegram-stop", description: "Stop Telegram streaming — kills relay and disconnects", insertText: "", source: "webview" },
    { name: "telegram voice", description: "Set OpenAI API key for voice transcription", insertText: "", source: "webview" },
    { name: "config", description: "Open settings panel", insertText: "", source: "webview" },
  );

  return items;
}

function render(): void {
  slashMenuEl.classList.remove("gsd-hidden");
  slashMenuEl.setAttribute("role", "listbox");
  slashMenuEl.setAttribute("aria-label", "Slash commands");
  slashMenuEl.innerHTML = filteredItems.map((item, i) => `
    <div class="gsd-slash-item ${i === slashMenuIndex ? "active" : ""}" role="option" aria-selected="${i === slashMenuIndex}" id="gsd-slash-opt-${i}" data-idx="${i}">
      <span class="gsd-slash-name">/${escapeHtml(item.name)}</span>
      <span class="gsd-slash-desc">${escapeHtml(item.description)}</span>
    </div>
  `).join("") + (!state.commandsLoaded ? `
    <div class="gsd-slash-item disabled" role="option" aria-disabled="true">
      <span class="gsd-slash-name"><span class="gsd-tool-spinner"></span></span>
      <span class="gsd-slash-desc">Loading commands\u2026</span>
    </div>
  ` : "");

  // Link active option to input for screen reader announcement
  if (filteredItems.length > 0 && slashMenuIndex >= 0) {
    promptInput.setAttribute("aria-activedescendant", `gsd-slash-opt-${slashMenuIndex}`);
  } else {
    promptInput.removeAttribute("aria-activedescendant");
  }

  slashMenuEl.querySelectorAll(".gsd-slash-item").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = parseInt((el as HTMLElement).dataset.idx!);
      selectCommand(idx);
    });
  });

  const activeEl = slashMenuEl.querySelector(".gsd-slash-item.active");
  if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
}

function sendSlashCommand(payload: object): void {
  promptInput.value = "";
  onAutoResize();
  vscode.postMessage(payload);
}

function selectCommand(idx: number): void {
  const item = filteredItems[idx];
  if (!item) { hide(); return; }

  if (item.source === "webview") {
    hide();
    switch (item.name) {
      case "compact":
        vscode.postMessage({ type: "compact_context" });
        promptInput.value = "";
        onAutoResize();
        break;
      case "export":
        vscode.postMessage({ type: "export_html" });
        promptInput.value = "";
        onAutoResize();
        break;
      case "model":
        promptInput.value = "";
        onAutoResize();
        onShowModelPicker();
        break;
      case "thinking": {
        // Only cycle if there is a current model, and either:
        // - models are not loaded yet (allow optimistically), or
        // - the loaded model metadata says reasoning is supported.
        const supportsReasoning = state.model
          ? (!state.modelsLoaded ||
              state.availableModels.some(
                (m) => m.id === state.model!.id && m.provider === state.model!.provider && m.reasoning
              ))
          : false;
        if (supportsReasoning) {
          vscode.postMessage({ type: "cycle_thinking_level" });
        }
        promptInput.value = "";
        onAutoResize();
        break;
      }
      case "new":
        promptInput.value = "";
        onAutoResize();
        onNewConversation();
        break;
      case "history":
        promptInput.value = "";
        onAutoResize();
        onShowHistory?.();
        break;
      case "copy":
        promptInput.value = "";
        onAutoResize();
        onCopyLast?.();
        break;
      case "resume":
        promptInput.value = "";
        onAutoResize();
        vscode.postMessage({ type: "resume_last_session" });
        break;
      case "auto-compact":
        promptInput.value = "";
        onAutoResize();
        onToggleAutoCompact?.();
        break;
      case "auto-retry":
        promptInput.value = "";
        onAutoResize();
        onToggleAutoRetry?.();
        break;
      case "telegram":
        sendSlashCommand({ type: "telegram_setup" });
        break;
      case "telegram-stop":
        sendSlashCommand({ type: "telegram_sync_toggle", forceOff: true });
        break;
      case "telegram voice":
        sendSlashCommand({ type: "set_openai_api_key" });
        break;
      case "config":
        promptInput.value = "";
        onAutoResize();
        onShowSettings?.();
        break;
    }
    promptInput.focus();
    return;
  }

  if (item.sendOnSelect) {
    // Block sending during compaction
    if (state.isCompacting) { hide(); return; }
    // Execute immediately — set the text and trigger send
    promptInput.value = item.insertText.trimEnd();
    onAutoResize();
    hide();
    onSendMessage();
    promptInput.focus();
  } else {
    // Fill input for further editing (command takes arguments)
    promptInput.value = item.insertText;
    onAutoResize();
    promptInput.focus();
    hide();
  }
}

// ============================================================
// Init — wire up dependencies and input listener
// ============================================================

export interface SlashMenuDeps {
  slashMenuEl: HTMLElement;
  promptInput: HTMLTextAreaElement;
  vscode: { postMessage(msg: unknown): void };
  onAutoResize: () => void;
  onShowModelPicker: () => void;
  onNewConversation: () => void;
  onSendMessage: () => void;
  onShowHistory?: () => void;
  onCopyLast?: () => void;
  onToggleAutoCompact?: () => void;
  onToggleAutoRetry?: () => void;
  onShowSettings?: () => void;
}

export function init(deps: SlashMenuDeps): void {
  slashMenuEl = deps.slashMenuEl;
  promptInput = deps.promptInput;
  vscode = deps.vscode;
  onAutoResize = deps.onAutoResize;
  onShowModelPicker = deps.onShowModelPicker;
  onNewConversation = deps.onNewConversation;
  onSendMessage = deps.onSendMessage;
  onShowHistory = deps.onShowHistory;
  onCopyLast = deps.onCopyLast;
  onToggleAutoCompact = deps.onToggleAutoCompact;
  onToggleAutoRetry = deps.onToggleAutoRetry;
  onShowSettings = deps.onShowSettings;
}
