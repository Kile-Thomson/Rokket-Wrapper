import { state } from "./state";

let welcomeProcess: HTMLElement | null = null;

export function init(options: Record<string, HTMLElement>): void {
  welcomeProcess = options.welcomeProcess ?? null;
}

export function renderDashboard(_data: unknown): void {}

export function updateWelcomeScreen(): void {
  if (!welcomeProcess) return;
  switch (state.processStatus) {
    case "starting":
    case "restarting":
      welcomeProcess.textContent = "Starting Claude Code…";
      break;
    case "crashed":
      welcomeProcess.textContent = state.lastExitDetail
        ? `Claude Code failed to start: ${state.lastExitDetail}`
        : "Claude Code failed to start";
      break;
    case "running":
      welcomeProcess.textContent = "Type a message to start";
      break;
    default:
      welcomeProcess.textContent = "Initializing…";
  }
}
