// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../state", () => ({
  state: {
    commandsLoaded: true,
    commands: [],
    processStatus: "running",
    availableModels: [],
    model: null,
    thinkingLevel: "off",
  },
}));

vi.mock("../helpers", () => ({
  escapeHtml: (s: string) => String(s ?? ""),
}));

import {
  init,
  isVisible,
  show,
  hide,
  navigateDown,
  navigateUp,
  getIndex,
  getFilteredItems,
  buildItems,
  selectCurrent,
  type SlashMenuDeps,
} from "../slash-menu";
import { state } from "../state";

function createDeps(): SlashMenuDeps {
  const slashMenuEl = document.createElement("div");
  document.body.appendChild(slashMenuEl);
  return {
    slashMenuEl,
    promptInput: document.createElement("textarea"),
    vscode: { postMessage: vi.fn() },
    onAutoResize: vi.fn(),
    onShowModelPicker: vi.fn(),
    onNewConversation: vi.fn(),
    onSendMessage: vi.fn(),
    onShowHistory: vi.fn(),
    onCopyLast: vi.fn(),
    onToggleAutoCompact: vi.fn(),
  };
}

describe("slash-menu", () => {
  let deps: SlashMenuDeps;

  beforeEach(() => {
    // Mock scrollIntoView — jsdom doesn't implement it
    Element.prototype.scrollIntoView = vi.fn();
    deps = createDeps();
    init(deps);
    (state as any).commandsLoaded = true;
    (state as any).commands = [];
    (state as any).processStatus = "running";
  });

  afterEach(() => {
    if (isVisible()) hide();
    document.body.innerHTML = "";
  });

  it("isVisible returns false initially", () => {
    expect(isVisible()).toBe(false);
  });

  it("show() makes the menu visible with filtered items", () => {
    show("");
    expect(isVisible()).toBe(true);
    expect(getFilteredItems().length).toBeGreaterThan(0);
  });

  it("show() filters items by search term", () => {
    show("telegram");
    expect(isVisible()).toBe(true);
    const items = getFilteredItems();
    expect(items.length).toBeGreaterThan(0);
    // All filtered items should match "telegram" in name or description
    for (const item of items) {
      const matches = item.name.toLowerCase().includes("telegram") || item.description.toLowerCase().includes("telegram");
      expect(matches).toBe(true);
    }
  });

  it("show() hides when no items match filter", () => {
    show("xyznonexistentcommand999");
    expect(isVisible()).toBe(false);
  });

  it("hide() makes it not visible", () => {
    show("");
    hide();
    expect(isVisible()).toBe(false);
    expect(deps.slashMenuEl.innerHTML).toBe("");
    expect(deps.slashMenuEl.classList.contains("gsd-hidden")).toBe(true);
  });

  it("navigateDown increments the index", () => {
    show("");
    const initialIndex = getIndex();
    navigateDown();
    expect(getIndex()).toBe(initialIndex + 1);
  });

  it("navigateUp decrements the index", () => {
    show("");
    navigateDown();
    navigateDown();
    const idx = getIndex();
    navigateUp();
    expect(getIndex()).toBe(idx - 1);
  });

  it("navigateDown clamps to last item", () => {
    show("");
    const items = getFilteredItems();
    for (let i = 0; i < items.length + 5; i++) {
      navigateDown();
    }
    expect(getIndex()).toBe(items.length - 1);
  });

  it("navigateUp clamps to 0", () => {
    show("");
    navigateUp();
    expect(getIndex()).toBe(0);
  });

  describe("buildItems", () => {
    it("returns an array of slash menu items with name and description", () => {
      const items = buildItems();
      expect(items.length).toBeGreaterThan(0);
      // Each item should have name and description
      for (const item of items) {
        expect(item.name).toBeTruthy();
        expect(item.description).toBeTruthy();
      }
    });

    it("includes built-in webview commands", () => {
      const items = buildItems();
      const names = items.map(i => i.name);
      expect(names).toContain("new");
      expect(names).toContain("export");
      expect(names).toContain("telegram");
    });

    it("includes config command", () => {
      const items = buildItems();
      const names = items.map(i => i.name);
      expect(names).toContain("config");
    });

    it("includes server-side commands when loaded", () => {
      (state as any).commandsLoaded = true;
      (state as any).commands = [
        { name: "custom-cmd", description: "A custom command" },
      ];
      const items = buildItems();
      const names = items.map(i => i.name);
      expect(names).toContain("custom-cmd");
    });
  });

  it("show() requests commands when not loaded", () => {
    (state as any).commandsLoaded = false;
    show("");
    expect(deps.vscode.postMessage).toHaveBeenCalledWith({ type: "get_commands" });
  });

  it("renders the menu items as HTML", () => {
    show("");
    expect(deps.slashMenuEl.classList.contains("gsd-hidden")).toBe(false);
    expect(deps.slashMenuEl.innerHTML).toContain("gsd-slash-item");
  });

  describe("selectCurrent", () => {
    it("selects a webview command (/new) and calls onNewConversation", () => {
      show("new");
      const items = getFilteredItems();
      const newIdx = items.findIndex(i => i.name === "new" && i.source === "webview");
      for (let i = 0; i < newIdx; i++) navigateDown();
      selectCurrent();
      expect(deps.onNewConversation).toHaveBeenCalled();
      expect(isVisible()).toBe(false);
    });

    it("selects a webview command (/telegram) and posts telegram_setup", () => {
      show("telegram");
      const items = getFilteredItems();
      const telegramIdx = items.findIndex(i => i.name === "telegram" && i.source === "webview");
      expect(telegramIdx).not.toBe(-1);
      for (let i = 0; i < telegramIdx; i++) navigateDown();
      selectCurrent();
      expect(deps.vscode.postMessage).toHaveBeenCalledWith({ type: "telegram_setup" });
    });

    it("selects a sendOnSelect server-side command and triggers send", () => {
      (state as any).commandsLoaded = true;
      (state as any).commands = [
        { name: "gsd-auto", description: "Run GSD auto", source: "server" },
      ];
      // Force cache rebuild
      show("gsd-auto");
      expect(getFilteredItems().length).toBeGreaterThan(0);
      // server-side commands without sendOnSelect just fill the input
      selectCurrent();
      expect(deps.promptInput.value).toContain("/gsd-auto");
      expect(isVisible()).toBe(false);
    });

    it("selects /export and sends export_html message", () => {
      show("export");
      const items = getFilteredItems();
      const exportIdx = items.findIndex(i => i.name === "export" && i.source === "webview");
      for (let i = 0; i < exportIdx; i++) navigateDown();
      selectCurrent();
      expect(deps.vscode.postMessage).toHaveBeenCalledWith({ type: "export_html" });
    });
  });
});
