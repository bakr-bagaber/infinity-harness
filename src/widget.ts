/**
 * Widget rendering — port of task-tracker/rendering.ts + pi-long-task sidebar + rpiv/99people display
 * Provides: statusIcon, wrapWidgetLines, getWidgetWindowBounds, buildWidgetLines, WIDGET_LIMIT, COMPLETED_CONTEXT
 */

import stringWidth from "string-width";

// ── constants ───────────────────────────────────────────────────────────────
export const WIDGET_LIMIT = 8;
export const COMPLETED_CONTEXT = 3;

// ── statusIcon ──────────────────────────────────────────────────────────────
export function statusIcon(status: string): string {
  switch (status) {
    case "pending":
      return "○";
    case "in_progress":
      return "◐";
    case "complete":
    case "done":
    case "closed":
    case "passed":
      return "●";
    case "blocked":
      return "⚠";
    case "waiting":
      return "↷";
    // checkbox variants from spec
    case "☐":
      return "○";
    case "☑":
      return "●";
    case "◐":
      return "◐";
    case "⚠":
      return "⚠";
    default:
      // treat unknown as pending
      if (status === "in_progress") return "◐";
      if (status === "complete") return "●";
      if (status === "blocked") return "⚠";
      return "○";
  }
}

/** Legacy checkbox alias map used by pi-long-task */
export function checkboxIcon(status: string): string {
  return statusIcon(status);
}

// ── Text helper (task-tracker/Text) ───────────────────────────────────────
export function Text(content: string): string {
  return content;
}

// ── wrapWidgetLines ─────────────────────────────────────────────────────────
export function wrapWidgetLines(text: string, width: number): string[] {
  if (width <= 0) return [text];
  if (text === "") return [""];
  if (stringWidth(text) <= width) return [text];

  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";

  for (const word of words) {
    const wWidth = stringWidth(word);
    if (wWidth > width) {
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      // hard-split overly long word
      let chunk = "";
      let chunkW = 0;
      for (const ch of [...word]) {
        const cw = stringWidth(ch);
        if (chunkW + cw > width) {
          lines.push(chunk);
          chunk = ch;
          chunkW = cw;
        } else {
          chunk += ch;
          chunkW += cw;
        }
      }
      if (chunk) {
        cur = chunk;
      }
      continue;
    }

    if (!cur) {
      cur = word;
    } else if (stringWidth(cur + " " + word) <= width) {
      cur += " " + word;
    } else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

// ── getWidgetWindowBounds ──────────────────────────────────────────────────
// Supports two calling conventions:
//   getWidgetWindowBounds(items: Array<{status:string}>, limit?, context?)
//   getWidgetWindowBounds(total: number, activeIndex: number, limit?, context?)

export function getWidgetWindowBounds(
  itemsOrTotal: Array<{ status: string }> | number,
  activeOrLimit?: number,
  limitMaybe?: number,
  contextMaybe?: number,
): { start: number; end: number } {
  // numeric overload: (total, activeIndex, limit?, context?)
  if (typeof itemsOrTotal === "number") {
    const total = itemsOrTotal;
    const activeIdx = typeof activeOrLimit === "number" ? activeOrLimit : 0;
    const limit = typeof limitMaybe === "number" ? limitMaybe : WIDGET_LIMIT;
    const ctx = typeof contextMaybe === "number" ? contextMaybe : COMPLETED_CONTEXT;

    if (total <= limit) return { start: 0, end: total };
    if (activeIdx < limit - ctx) return { start: 0, end: limit };
    if (activeIdx >= total - (limit - ctx)) return { start: total - limit, end: total };
    const start = activeIdx - ctx;
    return { start, end: start + limit };
  }

  // array overload
  const items = itemsOrTotal as Array<{ status: string }>;
  const limit = typeof activeOrLimit === "number" ? activeOrLimit : WIDGET_LIMIT;
  const ctx = typeof limitMaybe === "number" ? limitMaybe : COMPLETED_CONTEXT;

  const total = items.length;
  if (total <= limit) return { start: 0, end: total };

  // Find active index: first in_progress, else first pending/blocked, else tail
  let activeIdx = items.findIndex((it) => it.status === "in_progress");
  if (activeIdx === -1) activeIdx = items.findIndex((it) => it.status === "pending");
  if (activeIdx === -1) activeIdx = items.findIndex((it) => it.status === "blocked");
  if (activeIdx === -1) {
    // all complete -> show tail (most recent) to preserve progress visibility
    activeIdx = total - 1;
  }

  // rolling window with completed context
  if (activeIdx < limit - ctx) return { start: 0, end: limit };
  if (activeIdx >= total - (limit - ctx)) return { start: total - limit, end: total };

  let start = activeIdx - ctx;
  let end = start + limit;

  // blockedBefore visible: if there is a blocked item immediately before window, shift to include it
  // (ensure at least one blocked task before active is visible)
  // Check up to 2 positions before start for blocked status
  for (let i = start - 1; i >= Math.max(0, start - 2); i--) {
    if (items[i]?.status === "blocked") {
      // shift window left by 1 to include blocked
      if (start > 0) {
        start -= 1;
        end -= 1;
      }
      break;
    }
  }

  // clamp
  if (start < 0) {
    end += -start;
    start = 0;
  }
  if (end > total) {
    start -= end - total;
    end = total;
    if (start < 0) start = 0;
  }

  return { start, end };
}

// ── deps formatting (99people ← #1) ────────────────────────────────────────
export function formatDeps(
  dependsOn: string[],
  keyToIndex: Map<string, number>,
): string {
  if (!dependsOn || dependsOn.length === 0) return "";
  const nums: string[] = [];
  for (const dep of dependsOn) {
    const idx = keyToIndex.get(dep);
    if (idx !== undefined) nums.push(`#${idx}`);
    else nums.push(`${dep}`);
  }
  // spec: deps shown as ← #1 (single) or ← #1, #2
  return `← ${nums.join(", ")}`;
}

// ── types for widget data ───────────────────────────────────────────────────
export type Subtask = {
  id: string;
  title: string;
  status: string;
};

export type Task = {
  id: string;
  key?: string;
  description: string;
  status: string;
  dependsOn?: string[];
  subtasks?: Subtask[];
};

export type Feature = {
  id: string;
  name: string;
  description?: string;
  passes?: boolean;
  sprintId?: string;
  goalId?: string;
  tasks: Task[];
};

export type Sprint = {
  id: string;
  name: string;
  goalId?: string;
};

export type Goal = {
  id: string;
  title: string;
  description?: string;
};

export type FeatureList = {
  version: string;
  baseRevision?: number;
  goals?: Goal[];
  sprints?: Sprint[];
  features: Feature[];
};

// ── buildWidgetLines ────────────────────────────────────────────────────────
// Renders 5-level hierarchy: Goal → Feature → Sprint → Task → Subtask
// Includes Progress: x/y, Todos (x/y), +N more overflow, deps ← #1, and wrapping

export function buildWidgetLines(
  data: FeatureList,
  opts?: { width?: number },
): string[] {
  const width = opts?.width ?? 80;
  const lines: string[] = [];

  const goals = data.goals ?? [];
  const sprints = data.sprints ?? [];
  const features = data.features ?? [];

  // Goal level
  if (goals.length) {
    const g = goals[0];
    const label = `Goal: ${g.title}${g.description ? " — " + g.description : ""}`;
    const wrapped = wrapWidgetLines(label, width - 2);
    lines.push(`▸ ${wrapped[0]}`);
    for (let i = 1; i < wrapped.length; i++) lines.push(`  ${wrapped[i]}`);
  }

  if (!features.length) {
    lines.push("Progress: 0/0");
    return lines;
  }

  for (const feature of features) {
    // Feature level
    const fLabel = `Feature: ${feature.name}`;
    const fWrapped = wrapWidgetLines(fLabel, width - 2);
    lines.push(`▸ ${fWrapped[0]}`);
    for (let i = 1; i < fWrapped.length; i++) lines.push(`  ${fWrapped[i]}`);

    // Sprint level
    const sprint = sprints.find((s) => s.id === feature.sprintId) ?? sprints[0];
    if (sprint) {
      const sLabel = `Sprint: ${sprint.name}`;
      const sWrapped = wrapWidgetLines(sLabel, width - 2);
      lines.push(`▸ ${sWrapped[0]}`);
      for (let i = 1; i < sWrapped.length; i++) lines.push(`  ${sWrapped[i]}`);
    }

    const tasks = feature.tasks ?? [];
    const total = tasks.length;
    const done = tasks.filter(
      (t) => t.status === "complete" || t.status === "done",
    ).length;

    // Progress + Todos heading (rpiv-todo style "Todos (2/7)" + pi-long-task "Progress: x/y")
    lines.push(`Progress: ${done}/${total}  Todos (${done}/${total})`);

    if (total === 0) {
      lines.push("  (no tasks)");
      continue;
    }

    // Build key->index map for deps
    const keyToIndex = new Map<string, number>();
    tasks.forEach((t, idx) => {
      const n = idx + 1;
      if (t.key) keyToIndex.set(t.key, n);
      keyToIndex.set(t.id, n);
    });

    // Rolling window
    const bounds = getWidgetWindowBounds(tasks);
    const visible = tasks.slice(bounds.start, bounds.end);
    const hiddenCount = total - visible.length;

    // Optionally indicate hidden before (for completeness)
    // Spec says blockedBefore visible, +3 more
    // We render visible tasks
    for (const task of visible) {
      const icon = statusIcon(task.status);
      const depStr = formatDeps(task.dependsOn ?? [], keyToIndex);
      const title = task.description || task.key || task.id;
      const base = `${icon} ${title}${depStr ? " " + depStr : ""}`;
      const wrapped = wrapWidgetLines(base, width - 2);
      lines.push(wrapped[0]);
      for (let i = 1; i < wrapped.length; i++) {
        lines.push(`  ${wrapped[i]}`);
      }

      // Subtasks level
      const subtasks = task.subtasks ?? [];
      for (const sub of subtasks) {
        const sIcon = statusIcon(sub.status);
        const sBase = `${sIcon} ${sub.title}`;
        const sWrapped = wrapWidgetLines(sBase, width - 4);
        lines.push(`  ${sWrapped[0]}`);
        for (let i = 1; i < sWrapped.length; i++) {
          lines.push(`    ${sWrapped[i]}`);
        }
      }
    }

    // Overflow indicator
    if (hiddenCount > 0) {
      lines.push(`+${hiddenCount} more`);
      // Also include detailed hidden counts for accessibility
      // e.g., "+3 more (hidden before: X, after: Y)" is not required by spec, keep simple
    }

    // Section separator between features
    // (only if multiple features)
  }

  return lines;
}

// Alias: renderWidget lines for extensions/harness-enforcer
export function renderWidget(
  data: FeatureList,
  opts?: { width?: number },
): string[] {
  return buildWidgetLines(data, opts);
}

// Re-export helper for extension usage
export function getWidgetLines(
  data: FeatureList,
  opts?: { width?: number },
): string[] {
  return buildWidgetLines(data, opts);
}

// For Pi enforcer widget integration via ctx.ui.setWidget
export function createWidgetRenderer(
  getData: () => FeatureList,
  opts?: { width?: number },
): () => string {
  return () => {
    const data = getData();
    return buildWidgetLines(data, opts).join("\n");
  };
}
