// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { buildItems } from "../slash-menu";

describe("slash-menu buildItems", () => {
  it("includes 'new' item", () => {
    const items = buildItems();
    const item = items.find((i) => i.name === "new");
    expect(item).toBeDefined();
    expect(item!.description).toBe("Start a new conversation");
  });

  it("includes 'export' item", () => {
    const items = buildItems();
    const item = items.find((i) => i.name === "export");
    expect(item).toBeDefined();
    expect(item!.description).toBe("Export current conversation as HTML file");
  });

  it("includes 'config' item", () => {
    const items = buildItems();
    const item = items.find((i) => i.name === "config");
    expect(item).toBeDefined();
  });
});
