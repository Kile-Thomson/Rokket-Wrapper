import { state } from "./state";
import type { AutoProgressData, WorkerProgress } from "../shared/types";

// ============================================================
// Auto-Progress Widget
// ============================================================

let widgetEl: HTMLElement | null = null;
let staleInterval: ReturnType<typeof setInterval> | null = null;

const STALE_THRESHOLD_MS = 30_000;

export function init(): void {
  // Create the widget element and insert it into the DOM
  widgetEl = document.createElement("div");
  widgetEl.id = "autoProgressWidget";
  widgetEl.className = "gsd-auto-progress gsd-hidden";

  // Insert before .gsd-input-area if present, otherwise append to body
  const inputArea = document.querySelector(".gsd-input-area");
  if (inputArea && inputArea.parentElement) {
    inputArea.parentElement.insertBefore(widgetEl, inputArea);
  } else {
    document.body.appendChild(widgetEl);
  }

  // Start stale guard interval
  staleInterval = setInterval(() => {
    if (state.autoProgressLastUpdate > 0 && Date.now() - state.autoProgressLastUpdate > STALE_THRESHOLD_MS) {
      // Data is stale — could hide widget, but leave that to the caller
    }
  }, 5000);
}

export function dispose(): void {
  if (staleInterval !== null) {
    clearInterval(staleInterval);
    staleInterval = null;
  }
  if (widgetEl && widgetEl.parentElement) {
    widgetEl.parentElement.removeChild(widgetEl);
  }
  widgetEl = null;
}

export function update(data: AutoProgressData | null): void {
  state.autoProgress = data;
  if (data !== null) {
    state.autoProgressLastUpdate = Date.now();
  } else {
    state.autoProgressLastUpdate = 0;
  }

  if (!widgetEl) return;

  if (!data) {
    widgetEl.classList.add("gsd-hidden");
    widgetEl.classList.remove("gsd-auto-progress-discussion");
    widgetEl.innerHTML = "";
    return;
  }

  widgetEl.classList.remove("gsd-hidden");

  const isDiscussion = data.autoState === "paused" && data.phase === "needs-discussion";

  if (isDiscussion) {
    widgetEl.classList.add("gsd-auto-progress-discussion");
  } else {
    widgetEl.classList.remove("gsd-auto-progress-discussion");
  }

  widgetEl.innerHTML = renderWidget(data, isDiscussion);
}

// ============================================================
// Rendering helpers
// ============================================================

function modeIcon(data: AutoProgressData, isDiscussion: boolean): string {
  if (isDiscussion) return "💬";
  switch (data.autoState) {
    case "auto": return "⚡";
    case "next": return "▸";
    case "paused": return "⏸";
    default: return "⚡";
  }
}

function phaseLabel(phase: string, isDiscussion: boolean): string {
  if (isDiscussion) return "AWAITING DISCUSSION";
  switch (phase) {
    case "executing": return "EXECUTING";
    case "validate-milestone": return "✓ VALIDATING";
    case "planning": return "PLANNING";
    case "reviewing": return "REVIEWING";
    default: return phase.toUpperCase();
  }
}

function renderProgressBar(label: string, done: number, total: number): string {
  if (total === 0) return "";
  const pct = Math.round((done / total) * 100);
  return `
    <div class="gsd-auto-progress-bar-group">
      <span class="gsd-auto-progress-bar-label">${label}: ${done}/${total}</span>
      <div class="gsd-auto-progress-bar">
        <div class="gsd-auto-progress-bar-fill" style="width:${pct}%"></div>
      </div>
    </div>
  `;
}

function renderWorkerCard(w: WorkerProgress): string {
  const staleClass = w.stale ? " stale" : "";
  const staleLabel = w.stale ? `<span class="gsd-worker-stale-label">(stale)</span>` : "";
  const stateClass = `gsd-worker-state-${w.state}`;
  const stateLabel = w.state.charAt(0).toUpperCase() + w.state.slice(1);
  const unit = w.currentUnit
    ? `<span class="gsd-worker-unit">${w.currentUnit.type}: ${w.currentUnit.id}</span>`
    : "";
  const cost = `<span class="gsd-worker-cost">$${(w.cost ?? 0).toFixed(2)}</span>`;

  let budgetBar = "";
  if (w.budgetPercent !== null && w.budgetPercent !== undefined) {
    const pct = Math.min(w.budgetPercent, 100);
    const colorClass = w.budgetPercent >= 100 ? "gsd-budget-over" : w.budgetPercent >= 80 ? "gsd-budget-warn" : "gsd-budget-ok";
    budgetBar = `<div class="gsd-worker-budget"><div class="gsd-worker-budget-fill ${colorClass}" style="width:${pct}%"></div></div>`;
  }

  return `
    <div class="gsd-auto-progress-worker-card${staleClass}">
      <span class="gsd-worker-id">${w.id}</span>
      <span class="${stateClass}">${stateLabel}</span>
      ${unit}
      ${cost}
      ${budgetBar}
      ${staleLabel}
    </div>
  `;
}

function getHealthStatus(): "ok" | "warning" | "error" | null {
  const lines = state.widgetData?.get("gsd-health");
  if (!lines || lines.length === 0) return null;
  const line = lines[0];
  if (line.includes("✗")) return "error";
  if (line.includes("⚠")) return "warning";
  if (line.includes("●")) return "ok";
  return null;
}

function renderWidget(data: AutoProgressData, isDiscussion: boolean): string {
  const icon = modeIcon(data, isDiscussion);
  const phase = phaseLabel(data.phase, isDiscussion);

  // Current focus: task > slice > milestone
  let focusHtml = "";
  if (data.task) {
    focusHtml = `<span class="gsd-auto-progress-focus">${data.task.id}: ${data.task.title}</span>`;
  } else if (data.slice) {
    focusHtml = `<span class="gsd-auto-progress-focus">${data.slice.id}: ${data.slice.title}</span>`;
  } else if (data.milestone) {
    focusHtml = `<span class="gsd-auto-progress-focus">${data.milestone.title}</span>`;
  }

  // Progress bars
  const taskBar = data.tasks ? renderProgressBar("Tasks", data.tasks.done, data.tasks.total) : "";
  const sliceBar = data.slices ? renderProgressBar("Slices", data.slices.done, data.slices.total) : "";

  // Cost
  const costHtml = data.cost !== undefined
    ? `<span class="gsd-auto-progress-cost">$${data.cost.toFixed(2)}</span>`
    : "";

  // Model + health dot
  let modelHtml = "";
  if (data.model) {
    const healthStatus = getHealthStatus();
    const healthDot = healthStatus
      ? `<span class="gsd-auto-progress-health ${healthStatus}"></span>`
      : "";
    modelHtml = `<span class="gsd-auto-progress-model">${healthDot}${data.model.id}</span>`;
  }

  // Pulse (only when paused and NOT discussion)
  const pulse = (data.autoState === "paused" && !isDiscussion)
    ? `<span class="gsd-auto-progress-pulse"></span>`
    : "";

  // Hint for discussion
  const hintHtml = isDiscussion
    ? `<div class="gsd-auto-progress-hint">Type /gsd discuss to respond</div>`
    : "";

  // Capture badge
  const captureHtml = (data.pendingCaptures && data.pendingCaptures > 0)
    ? `<span class="gsd-auto-progress-captures">📌 ${data.pendingCaptures}</span>`
    : "";

  // Budget alert
  const budgetAlert = data.budgetAlert
    ? `<span class="gsd-auto-progress-budget-alert">⚠ Budget</span>`
    : "";

  // Worker cards
  const workerCards = (data.workers && data.workers.length > 0)
    ? data.workers.map(renderWorkerCard).join("")
    : "";

  return `
    <div class="gsd-auto-progress-header">
      <span class="gsd-auto-progress-icon">${icon}</span>
      <span class="gsd-auto-progress-phase">${phase}</span>
      ${pulse}
      ${captureHtml}
      ${budgetAlert}
    </div>
    <div class="gsd-auto-progress-body">
      ${focusHtml}
      ${taskBar}
      ${sliceBar}
      ${costHtml}
      ${modelHtml}
      ${workerCards}
    </div>
    ${hintHtml}
  `;
}
