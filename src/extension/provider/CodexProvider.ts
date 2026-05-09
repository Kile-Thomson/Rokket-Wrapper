import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { IAgentProvider } from "./IAgentProvider";
import { resolveShellEnv, mergeShellEnv, getKnownBinDirs } from "../shell-env";

// ============================================================
// CodexProvider — @openai/codex CLI wrapper
// Uses `codex exec --json --full-auto` for the first turn, then
// `codex exec resume <threadId> --json --full-auto` for continuations.
// Each turn spawns a fresh process; Codex restores history via its
// on-disk session store (thread_id).
// ============================================================

interface CodexThreadStarted {
  type: "thread.started";
  thread_id: string;
}

interface CodexTurnStarted {
  type: "turn.started";
}

interface CodexAgentMessageItem {
  id: string;
  type: "agent_message";
  text: string;
}

interface CodexCommandExecutionItem {
  id: string;
  type: "command_execution";
  command: string;
  aggregated_output: string;
  exit_code: number | null;
  status: "in_progress" | "completed" | "failed";
}

type CodexItem = CodexAgentMessageItem | CodexCommandExecutionItem | { id: string; type: string };

interface CodexItemStarted {
  type: "item.started";
  item: CodexItem;
}

interface CodexItemCompleted {
  type: "item.completed";
  item: CodexItem;
}

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

interface CodexTurnCompleted {
  type: "turn.completed";
  usage?: CodexUsage;
}

interface CodexError {
  type: "error";
  message: string;
}

type CodexEvent =
  | CodexThreadStarted
  | CodexTurnStarted
  | CodexItemStarted
  | CodexItemCompleted
  | CodexTurnCompleted
  | CodexError;

export class CodexProvider extends IAgentProvider {
  private workingDir: string = process.cwd();
  private threadId: string | null = null;
  private activeProcess: ChildProcess | null = null;
  private lineBuffer = "";
  private _model: string | null = null;
  private _effort: string | null = null;
  private turnStartTime = 0;

  constructor(private readonly codexPath: string = process.platform === "win32" ? "codex.cmd" : "codex") {
    super();
  }

  override get model(): string | null { return this._model; }
  override set model(value: string | null) { this._model = value; }

  override get effort(): string | null { return this._effort; }
  override set effort(value: string | null) { this._effort = value; }

  async start(workingDir: string): Promise<void> {
    this.workingDir = workingDir;
    this.emit("log", `CodexProvider started in ${workingDir}`);
  }

  async prompt(text: string, images?: Array<{ data: string; mimeType: string }>): Promise<void> {
    // Write images to temp files; pass them via `-i <file>` flags which the codex CLI
    // forwards to the model as image attachments.
    const tempFiles: string[] = [];
    if (images && images.length > 0) {
      const tmpDir = os.tmpdir();
      const writes = images.map(async (img, i) => {
        const ext = (img.mimeType.split("/")[1] ?? "png").replace(/[^a-z0-9]/gi, "");
        const filePath = path.join(tmpDir, `codex-img-${Date.now()}-${i}.${ext}`);
        await fs.promises.writeFile(filePath, Buffer.from(img.data, "base64"));
        return filePath;
      });
      const newFiles = await Promise.all(writes);
      tempFiles.push(...newFiles);
      this.emit("log", `[codex] attaching ${tempFiles.length} image(s) via -i flags`);
    }

    this.emit("agent_start");
    this.turnStartTime = Date.now();

    const shellEnv = await resolveShellEnv();
    const env = mergeShellEnv(
      { ...process.env } as Record<string, string>,
      shellEnv,
      getKnownBinDirs(),
    );

    const args = this.buildArgs(tempFiles);
    this.emit("log", `[codex] spawning: ${this.codexPath} exec ... cwd=${this.workingDir}`);

    this.lineBuffer = "";
    const child = spawn(this.codexPath, args, {
      cwd: this.workingDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // .cmd files on Windows must be spawned via the shell
      shell: process.platform === "win32",
    });
    this.activeProcess = child;

    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      this.lineBuffer += chunk;
      const lines = this.lineBuffer.split("\n");
      this.lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) this.parseLine(trimmed);
      }
    });

    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      this.emit("log", chunk);
    });

    child.on("error", (err: Error) => {
      this.activeProcess = null;
      this.emit("error", err);
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.lineBuffer.trim()) {
        this.parseLine(this.lineBuffer.trim());
        this.lineBuffer = "";
      }
      this.activeProcess = null;
      // Clean up temp image files
      for (const f of tempFiles) {
        fs.unlink(f, () => {});
      }
      if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGKILL") {
        this.emit("error", new Error(`codex exited with code ${code}, signal ${signal}`));
      }
    });

    // Write prompt to stdin then close it — codex exec reads prompt from stdin
    const flushed = child.stdin!.write(text, "utf8");
    if (!flushed) {
      await new Promise<void>(resolve => child.stdin!.once("drain", resolve));
    }
    child.stdin!.end();
  }

  async abort(): Promise<void> {
    if (this.activeProcess) {
      this.activeProcess.kill("SIGTERM");
      this.activeProcess = null;
    }
  }

  async stop(): Promise<void> {
    await this.abort();
  }

  isRunning(): boolean {
    return this.activeProcess !== null;
  }

  override resetSession(): void {
    this.threadId = null;
    if (this.activeProcess) {
      this.activeProcess.kill("SIGTERM");
      this.activeProcess = null;
    }
    this.emit("log", "[codex] session reset — next prompt will start a new thread");
  }

  private buildArgs(imagePaths: string[] = []): string[] {
    const imageFlags: string[] = [];
    for (const p of imagePaths) {
      imageFlags.push("-i", p);
    }

    // Codex uses -c reasoning.effort=<low|medium|high> for reasoning control
    const reasoningFlag = this._effort ? ["-c", `reasoning.effort="${this._effort}"`] : [];

    if (this.threadId) {
      // Resume existing session — history is restored from disk
      const args = [
        "exec", "resume", this.threadId,
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        ...reasoningFlag,
        ...imageFlags,
        "-", // read prompt from stdin
      ];
      if (this._model) args.push("--model", this._model);
      return args;
    }

    // First turn — start a new session
    const args = [
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      ...reasoningFlag,
      ...imageFlags,
      "-", // read prompt from stdin
    ];
    if (this._model) args.push("--model", this._model);
    return args;
  }

  private parseLine(line: string): void {
    let event: CodexEvent;
    try {
      event = JSON.parse(line) as CodexEvent;
    } catch {
      this.emit("log", line);
      return;
    }

    switch (event.type) {
      case "thread.started":
        this.threadId = event.thread_id;
        this.emit("system_init", { sessionId: event.thread_id, model: this._model ?? "codex" });
        this.emit("log", `[codex] thread=${event.thread_id}`);
        break;

      case "turn.started":
        // No-op — agent_start was already emitted before spawning
        break;

      case "item.started":
        if (event.item.type === "command_execution") {
          const item = event.item as CodexCommandExecutionItem;
          this.emit("tool_call", {
            name: "shell",
            input: { command: item.command },
            id: item.id,
          });
        }
        break;

      case "item.completed": {
        const item = event.item;
        if (item.type === "agent_message") {
          const msg = item as CodexAgentMessageItem;
          if (msg.text) {
            this.emit("message_chunk", msg.text);
            this.emit("message_end");
          }
        } else if (item.type === "command_execution") {
          const cmd = item as CodexCommandExecutionItem;
          this.emit("tool_result", {
            id: cmd.id,
            content: cmd.aggregated_output,
            isError: cmd.exit_code !== 0 && cmd.exit_code !== null,
          });
        }
        break;
      }

      case "turn.completed": {
        const u = event.usage;
        this.emit("agent_end", {
          durationMs: Date.now() - this.turnStartTime,
          usage: u ? {
            input: u.input_tokens,
            output: u.output_tokens,
            cacheRead: u.cached_input_tokens,
            reasoningOutput: u.reasoning_output_tokens,
          } : undefined,
        });
        break;
      }

      case "error":
        this.emit("error", new Error(event.message));
        break;

      default:
        this.emit("log", `[codex] unknown event type: ${(event as { type: string }).type}`);
    }
  }
}
