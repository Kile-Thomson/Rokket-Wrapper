import { spawn, ChildProcess } from "child_process";
import { IAgentProvider } from "./IAgentProvider";
import { resolveShellEnv, mergeShellEnv } from "../shell-env";

// ============================================================
// ClaudeCodeProvider — wraps `claude --print --output-format stream-json`
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

interface ClaudeAssistantEvent {
  type: "assistant";
  session_id: string;
  message: {
    content: Array<ClaudeTextContent | ClaudeToolUseContent>;
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

interface ClaudeResultEvent {
  type: "result";
  subtype: "success" | "error";
  duration_ms: number;
  is_error: boolean;
  result: string;
  session_id: string;
  total_cost_usd?: number;
}

type ClaudeEvent = ClaudeSystemEvent | ClaudeAssistantEvent | ClaudeUserEvent | ClaudeResultEvent;

export class ClaudeCodeProvider extends IAgentProvider {
  private process: ChildProcess | null = null;
  private workingDir: string = process.cwd();
  private lineBuffer = "";

  constructor(private readonly claudePath: string = "claude") {
    super();
  }

  async start(workingDir: string): Promise<void> {
    this.workingDir = workingDir;
    // start() just records the working dir; processes are spawned per-prompt
    this.emit("log", `ClaudeCodeProvider ready, workingDir=${workingDir}`);
  }

  async prompt(text: string): Promise<void> {
    if (this.process) {
      await this.abort();
    }

    const shellEnv = await resolveShellEnv();
    const env = mergeShellEnv(
      { ...process.env } as Record<string, string>,
      shellEnv,
    );

    const args = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ];

    this.lineBuffer = "";
    this.process = spawn(this.claudePath, args, {
      cwd: this.workingDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.emit("agent_start");

    // Write prompt to stdin then close it so claude knows input is done
    this.process.stdin!.write(text, "utf8");
    this.process.stdin!.end();

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
      // Flush any remaining buffered line
      if (this.lineBuffer.trim()) {
        this.parseLine(this.lineBuffer.trim());
        this.lineBuffer = "";
      }
      this.process = null;
      if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGKILL") {
        this.emit("error", new Error(`claude exited with code ${code}, signal ${signal}`));
      }
    });
  }

  async abort(): Promise<void> {
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

  private parseLine(line: string): void {
    let event: ClaudeEvent;
    try {
      event = JSON.parse(line) as ClaudeEvent;
    } catch {
      // Non-JSON line — treat as log
      this.emit("log", line);
      return;
    }

    switch (event.type) {
      case "system":
        this.emit("log", `[claude] session=${event.session_id} model=${event.model}`);
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
          this.emit("message_end");
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

      case "result":
        this.emit("agent_end", {
          durationMs: event.duration_ms,
          costUsd: event.total_cost_usd,
        });
        break;

      default:
        // Unknown event type — log for debugging
        this.emit("log", `[claude] unknown event type: ${(event as { type: string }).type}`);
    }
  }
}
