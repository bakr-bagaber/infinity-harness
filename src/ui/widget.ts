/**
 * infinity-harness — the plan widget.
 *
 * This is what the human watches while the loop runs unattended for hours. It
 * has to answer three questions in one glance, without scrolling:
 *
 *   Where are we?      the phase rail
 *   How far along?     the progress meter
 *   What is happening? the task window, centred on the active task
 *
 * Everything is derived from state on disk, so the widget is always truthful
 * even if the agent's own narration has drifted.
 */

import type { FeatureList, Phase, TaskStatus } from "../core/types.ts";
import { computeProgress, flattenTasks, type FlatTask } from "../core/featureList.ts";
import { getPhaseOrder } from "../core/phases.ts";
import {
  createStyler,
  detectGlyphs,
  padEnd,
  truncate,
  width,
  wrap,
  type GlyphSet,
  type Role,
  type Styler,
} from "./theme.ts";

export const DEFAULT_WIDTH = 76;
/** Task rows shown at once. Enough for context, short enough to stay glanceable. */
export const TASK_WINDOW = 9;
/** Completed rows kept above the active task so progress stays visible. */
export const COMPLETED_CONTEXT = 3;

export type WidgetState = {
  list: FeatureList;
  phase: Phase | null;
  enabledPhases?: readonly string[] | null;
  paused?: boolean;
  gate?: { overall: boolean; failures: string[] } | null;
  /** Shown in the header rule, e.g. "rev 42". */
  revision?: number;
  retries?: { task: number; max: number };
  /**
   * Which pass at the goal this is. A second pass looks identical to a first
   * one in every other part of the display, which is exactly when someone
   * walks away thinking the run is nearly done.
   */
  goalPass?: { current: number; max: number } | null;
  /** The last rung the escalation ladder took, and what it has spent. */
  escalation?: { strategy: string | null; reworks: number; replans: number } | null;
};

export type WidgetOptions = {
  width?: number;
  styler?: Styler;
  glyphs?: GlyphSet;
  /** Frame the widget in a box. Off when the host already draws a frame. */
  boxed?: boolean;
  /** Cap on task rows. Defaults to TASK_WINDOW. */
  taskWindow?: number;
};

const STATUS_ROLE: Record<TaskStatus, Role> = {
  pending: "pending",
  in_progress: "active",
  complete: "success",
  blocked: "blocked",
  rework: "rework",
};

export function statusGlyph(status: string, g: GlyphSet = detectGlyphs()): string {
  switch (status) {
    case "complete":
    case "done":
    case "closed":
    case "passed":
      return g.complete;
    case "in_progress":
    case "in-progress":
    case "active":
      return g.inProgress;
    case "blocked":
      return g.blocked;
    case "rework":
    case "waiting":
      return g.rework;
    default:
      return g.pending;
  }
}

function statusRole(status: string): Role {
  return STATUS_ROLE[status as TaskStatus] ?? "pending";
}

/**
 * Pick the slice of tasks to display: centred on the active task, biased so a
 * few completed rows stay visible above it. Clamps at both ends so the window
 * is always exactly `limit` rows when there are enough tasks.
 */
export function taskWindowBounds(
  tasks: Array<{ status: string }>,
  limit = TASK_WINDOW,
  context = COMPLETED_CONTEXT,
): { start: number; end: number } {
  const total = tasks.length;
  if (total <= limit) return { start: 0, end: total };

  let active = tasks.findIndex((t) => t.status === "in_progress");
  if (active === -1) active = tasks.findIndex((t) => t.status === "rework");
  if (active === -1) active = tasks.findIndex((t) => t.status === "blocked");
  if (active === -1) active = tasks.findIndex((t) => t.status === "pending");
  if (active === -1) active = total - 1; // everything done: show the tail

  if (active < limit - context) return { start: 0, end: limit };
  if (active >= total - (limit - context)) return { start: total - limit, end: total };

  const start = Math.max(0, Math.min(active - context, total - limit));
  return { start, end: start + limit };
}

/** `▰▰▰▰▱▱▱▱ 62%` — a fixed-width meter that never reflows the line. */
export function progressBar(percent: number, cells: number, g: GlyphSet, s: Styler): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * cells);
  const bar =
    s.fg("success", g.barFull.repeat(filled)) + s.fg("rule", g.barEmpty.repeat(Math.max(0, cells - filled)));
  return bar + " " + s.bold(String(clamped).padStart(3) + "%");
}

/**
 * `define ─ plan ─ ◉ BUILD ─ verify ─ review ─ ship`
 *
 * Collapses to just the current phase plus its neighbours when the terminal is
 * too narrow to hold the whole pipeline.
 */
export function phaseRail(
  current: Phase | null,
  enabled: readonly string[] | null | undefined,
  max: number,
  g: GlyphSet,
  s: Styler,
): string {
  const order = getPhaseOrder(enabled);
  const idx = current ? order.indexOf(current) : -1;

  const render = (phases: Phase[], elideLeft: boolean, elideRight: boolean): string => {
    const parts = phases.map((p) => {
      const i = order.indexOf(p);
      if (p === current) return s.bold(s.fg("accent", g.phaseCurrent + " " + p.toUpperCase()));
      if (idx >= 0 && i < idx) return s.fg("success", g.phaseDone + " " + p);
      return s.fg("muted", g.phaseTodo + " " + p);
    });
    const joiner = s.fg("rule", " " + g.rail + " ");
    const body = parts.join(joiner);
    const lead = elideLeft ? s.fg("rule", g.more + " ") : "";
    const tail = elideRight ? s.fg("rule", " " + g.more) : "";
    return lead + body + tail;
  };

  const full = render(order, false, false);
  if (width(full) <= max || idx === -1) return truncate(full, max);

  // Narrow: keep the current phase and one neighbour each side.
  const lo = Math.max(0, idx - 1);
  const hi = Math.min(order.length, idx + 2);
  const windowed = render(order.slice(lo, hi), lo > 0, hi < order.length);
  return truncate(windowed, max);
}

function depLabel(
  task: FlatTask,
  indexByKey: Map<string, number>,
  g: GlyphSet,
  s: Styler,
): string {
  const deps = task.dependsOn ?? [];
  if (deps.length === 0) return "";
  const nums = deps.map((d) => {
    const i = indexByKey.get(d);
    return i === undefined ? d : "#" + i;
  });
  return s.fg("muted", g.arrow + " " + nums.join(", "));
}

/**
 * Render the widget as terminal lines.
 *
 * Returns plain strings so the host can hand them straight to
 * `ctx.ui.setWidget`. Colour is embedded as ANSI when the styler is colouring.
 */
export function renderWidget(state: WidgetState, options: WidgetOptions = {}): string[] {
  const total = options.width ?? DEFAULT_WIDTH;
  const s = options.styler ?? createStyler();
  const g = options.glyphs ?? detectGlyphs();
  const boxed = options.boxed ?? false;
  const pad = boxed ? 2 : 0;
  const inner = Math.max(24, total - pad * 2);
  const limit = options.taskWindow ?? TASK_WINDOW;

  const out: string[] = [];
  const push = (line = ""): void => {
    out.push(line);
  };

  const progress = computeProgress(state.list);
  const tasks = flattenTasks(state.list);

  // -- header ---------------------------------------------------------------
  const brand = s.bold(s.fg("brand", "∞ INFINITY"));
  const phaseTag = state.paused
    ? s.fg("blocked", "PAUSED")
    : state.phase
      ? s.fg("accent", state.phase.toUpperCase())
      : s.fg("muted", "NOT STARTED");
  const revTag = state.revision === undefined ? "" : s.fg("muted", " rev " + state.revision);
  const headLeft = brand;
  const headRight = phaseTag + revTag;
  const gapW = inner - width(headLeft) - width(headRight);
  push(headLeft + (gapW > 1 ? s.fg("rule", " " + g.rail.repeat(gapW - 2) + " ") : " ") + headRight);

  // -- goal -----------------------------------------------------------------
  const goal = (state.list.goals ?? [])[0];
  if (goal?.title) {
    for (const line of wrap(goal.title, inner - 2)) {
      push(s.fg("muted", g.branch + " ") + s.fg("text", line));
    }
  }

  // -- phase rail -----------------------------------------------------------
  push();
  push(phaseRail(state.phase, state.enabledPhases, inner, g, s));

  // -- progress -------------------------------------------------------------
  const full =
    s.fg("muted", progress.tasksDone + "/" + progress.tasksTotal + " tasks") +
    s.fg("rule", " · ") +
    s.fg("muted", progress.featuresDone + "/" + progress.featuresTotal + " features");
  const compact = s.fg("muted", progress.tasksDone + "/" + progress.tasksTotal);

  // The meter has a floor of 8 cells plus "  NNN%" (6 columns). Below that the
  // long stat cannot fit, and padding it out would push the row past the
  // frame — so the row degrades to the task count alone, then to no stat.
  const METER_MIN = 8 + 6;
  let stats = full;
  if (inner - width(full) < METER_MIN) stats = compact;
  if (inner - width(stats) < METER_MIN) stats = "";

  const statsW = width(stats);
  const barCells = Math.max(8, Math.min(24, inner - statsW - 8));
  const bar = progressBar(progress.percent, barCells, g, s);
  push();
  const gap2 = inner - width(bar) - statsW;
  push(truncate(bar + (gap2 > 0 ? " ".repeat(gap2) : " ") + stats, inner));

  // -- alerts ---------------------------------------------------------------
  const alerts: string[] = [];
  if (progress.blocked > 0) alerts.push(s.fg("blocked", g.blocked + " " + progress.blocked + " blocked"));
  if (progress.rework > 0) alerts.push(s.fg("rework", g.rework + " " + progress.rework + " rework"));
  if (state.retries && state.retries.task > 0) {
    const role: Role = state.retries.task >= state.retries.max ? "blocked" : "active";
    alerts.push(s.fg(role, "retry " + state.retries.task + "/" + state.retries.max));
  }
  if (state.goalPass && state.goalPass.max > 1) {
    const role: Role = state.goalPass.current >= state.goalPass.max ? "blocked" : "active";
    alerts.push(s.fg(role, "pass " + state.goalPass.current + "/" + state.goalPass.max));
  }
  if (state.escalation?.strategy) {
    alerts.push(s.fg("rework", g.rework + " " + state.escalation.strategy));
  }
  if (state.gate && !state.gate.overall) {
    alerts.push(s.fg("blocked", "gate: " + state.gate.failures.slice(0, 3).join(", ")));
  }
  if (alerts.length) push(truncate(alerts.join(s.fg("rule", " · ")), inner));

  // -- tasks ----------------------------------------------------------------
  push();
  if (tasks.length === 0) {
    push(s.fg("muted", "  no tasks planned yet"));
    return frame(out, total, boxed, s, g);
  }

  const indexByKey = new Map<string, number>();
  for (const t of tasks) {
    indexByKey.set(t.compositeKey, t.index);
    indexByKey.set(t.id, t.index);
    if (t.key) indexByKey.set(t.key, t.index);
  }

  const bounds = taskWindowBounds(tasks, limit);
  const visible = tasks.slice(bounds.start, bounds.end);
  const hiddenBefore = bounds.start;
  const hiddenAfter = tasks.length - bounds.end;

  if (hiddenBefore > 0) {
    push(s.fg("rule", "  " + g.more + " " + hiddenBefore + " earlier"));
  }

  let lastFeature: string | null = null;
  const numW = String(tasks.length).length;

  for (const t of visible) {
    if (t.featureId !== lastFeature) {
      lastFeature = t.featureId;
      const label = t.featureId + s.fg("rule", " · ") + t.featureName;
      push(s.fg("muted", g.branch + " ") + truncate(label, inner - 2));
    }

    const role = statusRole(t.status);
    const icon = s.fg(role, statusGlyph(t.status, g));
    const num = s.fg("rule", String(t.index).padStart(numW));
    const dep = depLabel(t, indexByKey, g, s);
    const prefix = "  " + icon + " " + num + " ";
    const prefixW = width(prefix);
    const depW = dep ? width(dep) + 1 : 0;
    const titleMax = Math.max(8, inner - prefixW - depW);

    const isActive = t.status === "in_progress" || t.status === "rework";
    const titleLines = wrap(t.description || t.compositeKey, titleMax);
    const head = isActive ? s.bold(s.fg("text", titleLines[0]!)) : s.fg(role === "success" ? "muted" : "text", titleLines[0]!);

    let row = prefix + head;
    if (dep) {
      const rowW = width(row);
      const spacer = Math.max(1, inner - rowW - width(dep));
      row += " ".repeat(spacer) + dep;
    }
    push(row);
    for (const extra of titleLines.slice(1)) {
      push(" ".repeat(prefixW) + s.fg("muted", extra));
    }

    // Subtasks only for the task actually being worked — otherwise the window
    // fills with detail nobody is acting on.
    if (isActive) {
      for (const sub of t.subtasks ?? []) {
        const sIcon =
          sub.status === "complete"
            ? s.fg("success", g.subDone)
            : sub.status === "in_progress"
              ? s.fg("active", g.subActive)
              : s.fg("rule", g.subPending);
        const sTitle = truncate(sub.title, inner - prefixW - 4);
        push(" ".repeat(prefixW) + sIcon + " " + s.fg("muted", sTitle));
      }
    }
  }

  if (hiddenAfter > 0) {
    push(s.fg("rule", "  " + g.more + " " + hiddenAfter + " more"));
  }

  return frame(out, total, boxed, s, g);
}

function frame(lines: string[], total: number, boxed: boolean, s: Styler, g: GlyphSet): string[] {
  // Unboxed still has to honour the requested width: the caller sized the
  // widget to a terminal, and a row that overruns wraps and breaks the layout.
  if (!boxed) return lines.map((l) => truncate(l, total));
  const inner = total - 4;
  const top = s.fg("rule", "╭" + "─".repeat(total - 2) + "╮");
  const bottom = s.fg("rule", "╰" + "─".repeat(total - 2) + "╯");
  const side = s.fg("rule", "│");
  const body = lines.map((l) => side + " " + padEnd(truncate(l, inner), inner) + " " + side);
  return [top, ...body, bottom];
}

/** Compact one-liner for the status bar: `BUILD 13/21 ◐`. */
export function renderStatusLine(state: WidgetState, g: GlyphSet = detectGlyphs()): string {
  const p = computeProgress(state.list);
  if (state.paused) return "paused";
  if (p.tasksTotal === 0) return state.phase ?? "idle";
  const mark =
    p.blocked > 0
      ? g.blocked
      : p.inProgress > 0
        ? g.inProgress
        : p.tasksDone === p.tasksTotal
          ? g.complete
          : g.pending;
  const phase = state.phase ? state.phase + " " : "";
  return phase + p.tasksDone + "/" + p.tasksTotal + " " + mark;
}
