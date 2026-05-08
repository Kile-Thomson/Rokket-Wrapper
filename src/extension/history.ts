// ============================================================
// Conversation History — persists conversations to VS Code globalState
// ============================================================

import type * as vscode from "vscode";
import type { SessionListItem } from "../shared/types";

const HISTORY_KEY = "rokketWrapper.conversationHistory";
const MAX_HISTORY = 50;
const MAX_MESSAGES_PER_CONVERSATION = 200;

export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

export interface ConversationRecord {
  id: string;
  title: string;
  model: string | null;
  messages: HistoryMessage[];
  created: number;
  modified: number;
}

export class ConversationHistory {
  constructor(private globalState: vscode.Memento) {}

  private getAll(): ConversationRecord[] {
    return this.globalState.get<ConversationRecord[]>(HISTORY_KEY) ?? [];
  }

  private async saveAll(records: ConversationRecord[]): Promise<void> {
    await this.globalState.update(HISTORY_KEY, records);
  }

  async save(record: ConversationRecord): Promise<void> {
    const all = this.getAll();
    const idx = all.findIndex(r => r.id === record.id);

    const trimmed = { ...record };
    if (trimmed.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
      trimmed.messages = trimmed.messages.slice(-MAX_MESSAGES_PER_CONVERSATION);
    }

    if (idx >= 0) {
      all[idx] = trimmed;
    } else {
      all.unshift(trimmed);
    }

    if (all.length > MAX_HISTORY) {
      all.length = MAX_HISTORY;
    }

    await this.saveAll(all);
  }

  get(id: string): ConversationRecord | undefined {
    return this.getAll().find(r => r.id === id);
  }

  list(): SessionListItem[] {
    return this.getAll().map(r => ({
      path: r.id,
      id: r.id,
      name: r.title,
      firstMessage: r.messages[0]?.text ?? "",
      created: new Date(r.created).toISOString(),
      modified: new Date(r.modified).toISOString(),
      messageCount: r.messages.length,
    }));
  }

  async delete(id: string): Promise<void> {
    const all = this.getAll().filter(r => r.id !== id);
    await this.saveAll(all);
  }

  async rename(id: string, name: string): Promise<void> {
    const all = this.getAll();
    const record = all.find(r => r.id === id);
    if (record) {
      record.title = name;
      await this.saveAll(all);
    }
  }

  buildSummaryPrompt(record: ConversationRecord): string {
    const lines: string[] = [];
    lines.push("[Previous conversation context]");
    lines.push(`Topic: ${record.title}`);
    if (record.model) lines.push(`Model used: ${record.model}`);
    lines.push("");

    const messages = record.messages;
    const maxSummary = 10;

    if (messages.length <= maxSummary) {
      for (const m of messages) {
        const role = m.role === "user" ? "User" : "Assistant";
        const text = m.text.length > 500 ? m.text.slice(0, 500) + "..." : m.text;
        lines.push(`${role}: ${text}`);
      }
    } else {
      // First 2 messages for context
      for (const m of messages.slice(0, 2)) {
        const role = m.role === "user" ? "User" : "Assistant";
        const text = m.text.length > 300 ? m.text.slice(0, 300) + "..." : m.text;
        lines.push(`${role}: ${text}`);
      }
      lines.push(`[... ${messages.length - maxSummary} messages omitted ...]`);
      // Last messages for recency
      for (const m of messages.slice(-(maxSummary - 2))) {
        const role = m.role === "user" ? "User" : "Assistant";
        const text = m.text.length > 300 ? m.text.slice(0, 300) + "..." : m.text;
        lines.push(`${role}: ${text}`);
      }
    }

    lines.push("[End of previous conversation]");
    lines.push("");
    lines.push("Continue from where we left off. The user is resuming this conversation.");
    return lines.join("\n");
  }
}

let counter = 0;

export function generateConversationId(): string {
  return `conv-${Date.now()}-${++counter}`;
}
