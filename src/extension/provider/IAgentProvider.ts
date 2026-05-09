import { EventEmitter } from "events";

export interface UsageInfo {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoningOutput?: number;
}

export interface AgentEndStats {
  durationMs: number;
  costUsd?: number;
  usage?: UsageInfo;
  contextWindow?: number;
}

export interface AgentProviderEvents {
  message_chunk: (text: string) => void;
  message_end: (usage?: UsageInfo) => void;
  agent_start: () => void;
  agent_end: (stats: AgentEndStats) => void;
  tool_call: (tool: { name: string; input: unknown; id: string }) => void;
  tool_result: (result: { id: string; content: string; isError: boolean }) => void;
  error: (err: Error) => void;
  log: (msg: string) => void;
  system_init: (info: { sessionId: string; model: string }) => void;
}

export abstract class IAgentProvider extends EventEmitter {
  abstract start(workingDir: string): Promise<void>;
  abstract prompt(text: string, images?: Array<{ data: string; mimeType: string }>): Promise<void>;
  abstract abort(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract isRunning(): boolean;
  resetSession(): void {}

  /** Optional model override — providers that support model selection should override. */
  get model(): string | null { return null; }
  set model(_value: string | null) { /* no-op unless overridden */ }

  /** Optional reasoning effort level — Claude Code specific; no-op on other providers. */
  get effort(): string | null { return null; }
  set effort(_value: string | null) { /* no-op unless overridden */ }
}
