import { EventEmitter } from "events";

export interface AgentProviderEvents {
  message_chunk: (text: string) => void;
  message_end: () => void;
  agent_start: () => void;
  agent_end: (stats: { durationMs: number; costUsd?: number }) => void;
  tool_call: (tool: { name: string; input: unknown; id: string }) => void;
  tool_result: (result: { id: string; content: string; isError: boolean }) => void;
  error: (err: Error) => void;
  log: (msg: string) => void;
}

export abstract class IAgentProvider extends EventEmitter {
  abstract start(workingDir: string): Promise<void>;
  abstract prompt(text: string): Promise<void>;
  abstract abort(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract isRunning(): boolean;
}
