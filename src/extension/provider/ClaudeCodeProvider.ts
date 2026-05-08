import { spawn, ChildProcess } from "child_process";
import { IAgentProvider } from "./IAgentProvider";
import { resolveShellEnv, mergeShellEnv } from "../shell-env";

// ============================================================
// ClaudeCodeProvider — persistent interactive Claude process
// Uses `-p --input-format stream-json --output-format stream-json`
// One long-running process per conversation; messages piped via stdin.
// ============================================================

interface ClaudeSystemEvent {
  type: "system";
  subtype: "init";
  session_id: string;
  tools: unknown[];
  model: string;
  permissionMode: string;
}

interface ClaudeTextContent {
  type: "text";
  text: string;
}

interface ClaudeToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

interface ClaudeToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ClaudeAssistantEvent {
  type: "assistant";
  session_id: string;
  message: {
    content: Array<ClaudeTextContent | ClaudeToolUseContent>;
    usage?: ClaudeUsage;
  };
}

interface ClaudeUserEvent {
  type: "user";
  session_id: string;
  message: {
    role: "user";
    content: Array<ClaudeToolResultContent>;
  };
}

interface ClaudeModelUsageEntry {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  contextWindow?: number;
  costUSD?: number;
}

interface ClaudeResultEvent {
  type: "result";
  subtype: "success" | "error";
  duration_ms: number;
  is_error: boolean;
  result: string;
  session_id: string;
  total_cost_usd?: number;
  usage?: ClaudeUsage;
  modelUsage?: Record<string, ClaudeModelUsageEntry>;
}

type ClaudeEvent = ClaudeSystemEvent | ClaudeAssistantEvent | ClaudeUserEvent | ClaudeResultEvent;

export class ClaudeCodeProvider extends IAgentProvider {
  private process: ChildProcess | null = null;
  private workingDir: string = process.cwd();
  private lineBuffer = "";
  private _model: string | null = null;
  private _effort: string | null = null;
  private initReceived = false;

  constructor(private readonly claudePath: string = "claude") {
    super();
  }

  get model(): string | null { return this._model; }
  set model(value: string | null) { this._model = value; }

  get effort(): string | null { return this._effort; }
  set effort(value: string | null) { this._effort = value; }

  async start(workingDir: string): Promise<void> {
    this.workingDir = workingDir;
    this.emit("log", `ClaudeCodeProvider started in ${workingDir}`);
    // Process is spawned lazily on first prompt
  }

  private async ensureProcess(): Promise<ChildProcess> {
    if (this.process) return this.process;

    const shellEnv = await resolveShellEnv();
    const env = mergeShellEnv(
      { ...process.env } as Record<string, string>,
      shellEnv,
    );

    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ];
    if (this._model) {
      args.push("--model", this._model);
    }
    if (this._effort) {
      args.push("--effort", this._effort);
    }

    this.emit("log", `[claude] spawning persistent process: ${this.claudePath} ${args.join(" ")}`);

    this.lineBuffer = "";
    this.initReceived = false;
    this.process = spawn(this.claudePath, args, {
      cwd: this.workingDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.process.stdout!.setEncoding("utf8");
    this.process.stdout!.on("data", (chunk: string) => {
      this.lineBuffer += chunk;
      const lines = this.lineBuffer.split("\n");
      this.lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) this.parseLine(trimmed);
      }
    });

    this.process.stderr!.setEncoding("utf8");
    this.process.stderr!.on("data", (chunk: string) => {
      this.emit("log", chunk);
    });

    this.process.on("error", (err: Error) => {
      this.process = null;
      this.emit("error", err);
    });

    this.process.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.lineBuffer.trim()) {
        this.parseLine(this.lineBuffer.trim());
        this.lineBuffer = "";
      }
      this.process = null;
      if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGKILL") {
        this.emit("error", new Error(`claude exited with code ${code}, signal ${signal}`));
      }
    });

    return this.process;
  }

  async prompt(text: string, images?: Array<{ data: string; mimeType: string }>): Promise<void> {
    const child = await this.ensureProcess();

    this.emit("agent_start");

    const content: Array<Record<string, unknown>> = [];
    if (text) {
      content.push({ type: "text", text });
    }
    if (images && images.length > 0) {
      this.emit("log", `[claude] Sending prompt with ${images.length} image(s), text length=${text.length}`);
      for (const img of images) {
        content.push({
          type: "image",
          source: { type: "base64", media_type: img.mimeType, data: img.data },
        });
      }
    }

    const msg = JSON.stringify({
      type: "user",
      message: { role: "user", content },
    });

    this.emit("log", `[claude] sending message (${msg.length} bytes)`);
    const stdin = child.stdin!;
    const flushed = stdin.write(msg + "\n", "utf8");
    if (!flushed) {
      await new Promise<void>(resolve => stdin.once("drain", resolve));
    }
    // stdin stays open — process is persistent
  }

  async abort(): Promise<void> {
    // Kill the process to stop the current response.
    // A new process will be spawned on the next prompt (conversation history is lost).
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
  }

  async stop(): Promise<void> {
    await this.abort();
  }

  isRunning(): boolean {
    return this.process !== null;
  }

  override resetSession(): void {
    // Kill the persistent process so a fresh one spawns on next prompt
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
  }

  private parseLine(line: string): void {
    let event: ClaudeEvent;
    try {
      event = JSON.parse(line) as ClaudeEvent;
    } catch {
      this.emit("log", line);
      return;
    }

    switch (event.type) {
      case "system":
        this.emit("log", `[claude] session=${event.session_id} model=${event.model}`);
        if (!this.initReceived) {
          this.initReceived = true;
          this.emit("system_init", { sessionId: event.session_id, model: event.model });
        }
        break;

      case "assistant": {
        let hasText = false;
        for (const item of event.message.content) {
          if (item.type === "text") {
            hasText = true;
            this.emit("message_chunk", item.text);
          } else if (item.type === "tool_use") {
            this.emit("tool_call", { name: item.name, input: item.input, id: item.id });
          }
        }
        if (hasText) {
          const u = event.message.usage;
          const usage = u ? {
            input: u.input_tokens,
            output: u.output_tokens,
            cacheRead: u.cache_read_input_tokens,
            cacheWrite: u.cache_creation_input_tokens,
          } : undefined;
          this.emit("message_end", usage);
        }
        break;
      }

      case "user": {
        for (const item of event.message.content) {
          if (item.type === "tool_result") {
            this.emit("tool_result", {
              id: item.tool_use_id,
              content: typeof item.content === "string" ? item.content : JSON.stringify(item.content),
              isError: false,
            });
          }
        }
        break;
      }

      case "result": {
        let contextWindow: number | undefined;
        let totalUsage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined;
        if (event.modelUsage) {
          const first = Object.values(event.modelUsage)[0];
          if (first) {
            contextWindow = first.contextWindow;
            totalUsage = {
              input: first.inputTokens,
              output: first.outputTokens,
              cacheRead: first.cacheReadInputTokens,
              cacheWrite: first.cacheCreationInputTokens,
            };
          }
        }
        this.emit("agent_end", {
          durationMs: event.duration_ms,
          costUsd: event.total_cost_usd,
          usage: totalUsage,
          contextWindow,
        });
        break;
      }

      default:
        this.emit("log", `[claude] unknown event type: ${(event as { type: string }).type}`);
    }
  }
}
