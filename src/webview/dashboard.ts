import { state } from "./state";
import { scrollToBottom, escapeHtml } from "./helpers";
import type { DashboardData, DashboardSlice, MilestoneRegistryEntry } from "../shared/types";

// ============================================================
// Dashboard module
// ============================================================

export interface DashboardDeps {
  messagesContainer: HTMLElement;
  welcomeScreen: HTMLElement;
  welcomeProcess: HTMLElement;
  welcomeModel: HTMLElement;
  welcomeHints: HTMLElement;
}

let deps: DashboardDeps | null = null;

export function init(options: DashboardDeps): void {
  deps = options;
}

// ============================================================
// formatTokenCount
// ============================================================

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) {
    return (n / 1_000_000).toFixed(2) + "M";
  }
  if (n >= 1000) {
    return (n / 1000).toFixed(1) + "k";
  }
  return String(n);
}

// ============================================================
// renderDashboard
// ============================================================

export function renderDashboard(data: DashboardData | null): void {
  if (!deps) return;

  // Hide welcome screen
  deps.welcomeScreen.classList.add("gsd-hidden");

  // Remove existing dashboard
  const existing = deps.messagesContainer.querySelector(".gsd-dashboard");
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.className = "gsd-dashboard";

  if (!data || !data.hasProject || !data.hasMilestone) {
    el.innerHTML = renderEmptyState();
  } else {
    el.innerHTML = renderFullDashboard(data);
  }

  deps.messagesContainer.appendChild(el);
  scrollToBottom(deps.messagesContainer, true);
}

function renderEmptyState(): string {
  return `
    <div class="gsd-dashboard-empty">
      <p>No active project</p>
      <p>Start a conversation to begin</p>
    </div>
  `;
}

const VALID_PHASES = ["executing", "planning", "reviewing", "complete", "validate-milestone"] as const;
type ValidPhase = typeof VALID_PHASES[number];

function sanitizePhase(phase: string): ValidPhase | "unknown" {
  return (VALID_PHASES as readonly string[]).includes(phase) ? phase as ValidPhase : "unknown";
}

function renderPhaseLabel(phase: ValidPhase | "unknown"): string {
  switch (phase) {
    case "executing": return "Executing";
    case "planning": return "Planning";
    case "reviewing": return "Reviewing";
    case "complete": return "Complete";
    case "validate-milestone": return "Validating";
    default: return "Unknown";
  }
}

function renderProgressSection(progress: DashboardData["progress"]): string {
  const taskPct = progress.tasks.total > 0 ? Math.round((progress.tasks.done / progress.tasks.total) * 100) : 0;
  const slicePct = progress.slices.total > 0 ? Math.round((progress.slices.done / progress.slices.total) * 100) : 0;
  const msPct = progress.milestones.total > 0 ? Math.round((progress.milestones.done / progress.milestones.total) * 100) : 0;

  return `
    <div class="gsd-dashboard-progress">
      <div class="gsd-dashboard-progress-row">
        <span>Tasks</span>
        <span>${progress.tasks.done}/${progress.tasks.total}</span>
        <span>${taskPct}%</span>
      </div>
      <div class="gsd-dashboard-progress-row">
        <span>Slices</span>
        <span>${progress.slices.done}/${progress.slices.total}</span>
        <span>${slicePct}%</span>
      </div>
      <div class="gsd-dashboard-progress-row">
        <span>Milestones</span>
        <span>${progress.milestones.done}/${progress.milestones.total}</span>
        <span>${msPct}%</span>
      </div>
    </div>
  `;
}

function renderSlice(slice: DashboardSlice): string {
  const stateClass = slice.done ? "done" : slice.active ? "active" : "pending";
  const tasksHtml = (slice.active && slice.tasks.length > 0)
    ? `<div class="gsd-dash-tasks">${slice.tasks.map(t => {
        const tClass = t.done ? "done" : t.active ? "active" : "pending";
        return `<div class="gsd-dash-task ${tClass}">${escapeHtml(t.id)}: ${escapeHtml(t.title)}</div>`;
      }).join("")}</div>`
    : "";
  return `
    <div class="gsd-dash-slice ${stateClass}">
      <span>${escapeHtml(slice.id)}: ${escapeHtml(slice.title)}</span>
      ${tasksHtml}
    </div>
  `;
}

function renderMilestoneEntry(m: MilestoneRegistryEntry): string {
  const cls = m.done ? "done" : m.active ? "active" : "pending";
  return `<div class="gsd-dash-milestone ${cls}">${escapeHtml(m.id)}: ${escapeHtml(m.title)}</div>`;
}

function renderStats(stats: NonNullable<DashboardData["stats"]>): string {
  const cost = stats.cost !== undefined ? `$${stats.cost.toFixed(4)}` : null;
  const tokens = stats.tokens ? `${formatTokenCount(stats.tokens.total)} tokens` : null;
  const tools = stats.toolCalls !== undefined ? `${stats.toolCalls} tools` : null;
  const turns = stats.userMessages !== undefined ? `${stats.userMessages} turns` : null;

  return `
    <div class="gsd-dashboard-stats">
      <div class="gsd-dashboard-stats-header">Usage</div>
      ${cost ? `<div class="gsd-dashboard-stat"><span>Cost</span><span>${cost}</span></div>` : ""}
      ${tokens ? `<div class="gsd-dashboard-stat">${tokens}</div>` : ""}
      ${tools ? `<div class="gsd-dashboard-stat">${tools}</div>` : ""}
      ${turns ? `<div class="gsd-dashboard-stat">${turns}</div>` : ""}
    </div>
  `;
}

function renderFullDashboard(data: DashboardData): string {
  const phase = sanitizePhase(data.phase);
  const phaseLabel = renderPhaseLabel(phase);

  // Breadcrumb
  const parts: string[] = [];
  if (data.milestone) parts.push(data.milestone.id);
  if (data.slice) parts.push(data.slice.id);
  if (data.task) parts.push(data.task.id);
  const breadcrumb = parts.join("/");

  // Milestone info
  const milestoneHtml = data.milestone ? `
    <div class="gsd-dashboard-milestone">
      <span class="gsd-dash-milestone-id">${escapeHtml(data.milestone.id)}</span>
      <span class="gsd-dash-milestone-title">${escapeHtml(data.milestone.title)}</span>
      ${breadcrumb ? `<span class="gsd-dash-breadcrumb">${escapeHtml(breadcrumb)}</span>` : ""}
    </div>
  ` : "";

  // Slices
  const slicesHtml = data.slices.length > 0 ? `
    <div class="gsd-dashboard-slices">
      ${data.slices.map(renderSlice).join("")}
    </div>
  ` : "";

  // Milestone registry
  const registryHtml = data.milestoneRegistry.length > 0 ? `
    <div class="gsd-dashboard-milestones">
      <div class="gsd-dashboard-section-title">Milestones</div>
      ${data.milestoneRegistry.map(renderMilestoneEntry).join("")}
    </div>
  ` : "";

  // Blockers
  const blockersHtml = data.blockers.length > 0 ? `
    <div class="gsd-dashboard-blockers">
      <div class="gsd-dashboard-section-title">Blockers</div>
      ${data.blockers.map(b => `<div class="gsd-dash-blocker">${escapeHtml(b)}</div>`).join("")}
    </div>
  ` : "";

  // Next action
  const nextHtml = data.nextAction ? `
    <div class="gsd-dashboard-next">
      <span class="gsd-dashboard-next-label">Next</span>
      <span>${escapeHtml(data.nextAction)}</span>
    </div>
  ` : "";

  // Stats
  const statsHtml = data.stats ? renderStats(data.stats) : "";

  return `
    <div class="gsd-dashboard-header">
      <span class="gsd-dashboard-title">Dashboard</span>
      <span class="gsd-dashboard-phase ${phase}">${phaseLabel}</span>
    </div>
    ${milestoneHtml}
    ${renderProgressSection(data.progress)}
    ${slicesHtml}
    ${registryHtml}
    ${blockersHtml}
    ${nextHtml}
    ${statsHtml}
  `;
}

// ============================================================
// updateWelcomeScreen
// ============================================================

export function updateWelcomeScreen(): void {
  if (!deps) return;

  if (state.entries && state.entries.length > 0) {
    deps.welcomeScreen.classList.add("gsd-hidden");
    return;
  }

  deps.welcomeScreen.classList.remove("gsd-hidden");

  switch (state.processStatus) {
    case "starting":
    case "restarting":
      deps.welcomeProcess.textContent = "Starting Claude Code…";
      break;
    case "crashed":
      deps.welcomeProcess.textContent = state.lastExitDetail
        ? `Claude Code failed to start: ${state.lastExitDetail}`
        : "Claude Code failed to start";
      break;
    case "running":
      deps.welcomeProcess.textContent = "Type a message to start";
      break;
    default:
      deps.welcomeProcess.textContent = "Initializing…";
  }
}
