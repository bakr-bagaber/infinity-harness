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

import type { FeatureList, Phase, Subtask, TaskStatus } from "../core/types.ts";
import { computeProgress, flattenTasks, nextActionableTask, type FlatTask } from "../core/featureList.ts";
import { getPhaseOrder } from "../core/phases.ts";
import { buildPlanRows, focusRowIndex, type PlanRow } from "./planTree.ts";
import { defaultDisplay, normalizeDisplay } from "./display.ts";
import type { DisplayPolicy } from "../core/types.ts";
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
/** Plan rows shown at once. Enough for context, short enough to stay glanceable. */
export const TASK_WINDOW = 9;
/** Completed rows kept above the active task so progress stays visible. */
export const COMPLETED_CONTEXT = 3;
/** How many rows one scroll step moves. */
export const SCROLL_STEP = 3;
/** Rows shown when the human expands the widget. */
export const EXPANDED_WINDOW = 28;

export type WidgetState = {
  list: FeatureList;
  phase: Phase | null;
  enabledPhases?: readonly string[] | null;
  paused?: boolean;
  gate?: { overall: boolean; failures: string[] } | null;
  /** Dashboard URL to show near the top, clickable. Meaningful host:port, not just numbers. */
  dashboardUrl?: string | null;
  /** Model routing note: e.g. "Model per task — subtasks share parent". Shown once. */
  handoffModelNote?: string | null;
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
  /**
   * A phase whose gate passed and which is waiting for a human signature.
   *
   * Without this the widget of a run parked on *you* is indistinguishable from
   * the widget of a run that has quietly died — which is exactly the moment
   * someone walks away and comes back an hour later to no progress.
   */
  awaitingApproval?: string | null;
  /**
   * How the human is looking at the plan right now.
   *
   * `scroll: null` follows the run — the window stays centred on the active
   * task, which is what you want while it is working. A number means the
   * human took the wheel and the widget stops moving under them.
   */
  view?: WidgetView | null;
  /** Sessions this run has spent. Only meaningful once handoff is on. */
  sessions?: number | null;
  /**
   * What this reader has asked to see.
   *
   * The same policy drives the dashboard, so a level turned off here is off
   * there too — configuring how you read a plan once, rather than twice.
   */
  display?: DisplayPolicy | null;
  /**
   * What the human asked for, before a plan exists to hold a goal.
   *
   * Between init and the first `infinity_plan` call the widget had nothing to
   * say about what the run was even for, which is the exact window in which
   * someone wants to check that it understood them.
   */
  intake?: string | null;
};

export type WidgetView = {
  /** First visible row, or null to follow the active task. */
  scroll: number | null;
  /** Show every subtask, and more rows at once. */
  expanded: boolean;
};

export function defaultView(): WidgetView {
  return { scroll: null, expanded: false };
}

/**
 * Move the view. Returns a new view; the caller stores it.
 *
 * Scrolling to the very top is how the human gets back to "following the run":
 * a widget that has to be reset from a menu is a widget that stays stuck.
 */
export function scrollView(view: WidgetView, delta: number, rowCount: number, windowRows: number): WidgetView {
  const max = Math.max(0, rowCount - windowRows);
  const current = view.scroll ?? 0;
  const next = Math.max(0, Math.min(max, current + delta));
  return { ...view, scroll: next };
}

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
  deps: string[] | undefined,
  indexByKey: Map<string, number>,
  g: GlyphSet,
  s: Styler,
): string {
  if (!deps || deps.length === 0) return "";
  const nums = deps.map((d) => {
    const i = indexByKey.get(d);
    return i === undefined ? d : "#" + i;
  });
  return s.fg("muted", g.arrow + " " + nums.join(", "));
}

/** `2/5` — how much of a grouping row's branch is finished. */
function countTag(row: PlanRow, s: Styler): string {
  if (row.total === 0) return s.fg("rule", "empty");
  const role: Role = row.done === row.total ? "success" : row.done > 0 ? "active" : "muted";
  return s.fg(role, row.done + "/" + row.total);
}

const LEVEL_ROLE: Record<PlanRow["level"], Role> = {
  goal: "brand",
  sprint: "accent",
  feature: "muted",
  task: "text",
  subtask: "muted",
};

/**
 * One plan row, drawn.
 *
 * Indentation is by level, so the five levels of the plan are five columns on
 * screen and the shape of the plan is readable without counting ids. The
 * grouping rows carry a `done/total` tag on the right, which is what turns a
 * long plan into something you can judge at a glance instead of reading.
 */
function renderRow(
  row: PlanRow,
  inner: number,
  indexByKey: Map<string, number>,
  g: GlyphSet,
  s: Styler,
  display: DisplayPolicy,
): string[] {
  const indent = "  ".repeat(row.depth);
  const tagFor = (r: PlanRow): string => (display.counts ? countTag(r, s) : "");

  if (row.level === "goal" || row.level === "sprint") {
    const icon = s.fg(LEVEL_ROLE[row.level], row.level === "goal" ? g.goal : g.sprint);
    const tag = tagFor(row);
    const prefix = indent + icon + " ";
    const head =
      s.bold(s.fg(LEVEL_ROLE[row.level], row.title)) +
      (row.label && row.label !== row.title ? s.fg("rule", "  " + row.label) : "");
    const body = truncate(prefix + head, tag ? Math.max(8, inner - width(tag) - 1) : inner);
    if (!tag) return [body];
    const gap = Math.max(1, inner - width(body) - width(tag));
    return [body + " ".repeat(gap) + tag];
  }

  if (row.level === "feature") {
    const tag = tagFor(row);
    const prefix = indent + s.fg("muted", g.branch + " ");
    const head = s.fg("muted", row.label) + s.fg("rule", " · ") + s.fg("text", row.title);
    const body = truncate(prefix + head, tag ? Math.max(8, inner - width(tag) - 1) : inner);
    if (!tag) return [body];
    const gap = Math.max(1, inner - width(body) - width(tag));
    return [body + " ".repeat(gap) + tag];
  }

  if (row.level === "subtask") {
    const icon =
      row.status === "complete"
        ? s.fg("success", g.subDone)
        : row.status === "in_progress"
          ? s.fg("active", g.subActive)
          : s.fg("rule", g.subPending);
    const prefix = indent + icon + " ";
    return [truncate(prefix + s.fg("muted", row.title), inner)];
  }

  // -- a task ---------------------------------------------------------------
  const role = statusRole(row.status ?? "pending");
  const icon = s.fg(role, statusGlyph(row.status ?? "pending", g));
  const num = s.fg("rule", row.label);
  const dep = display.dependencies ? depLabel(row.dependsOn, indexByKey, g, s) : "";
  const prefix = indent + icon + " " + num + " ";
  const prefixW = width(prefix);
  const depW = dep ? width(dep) + 1 : 0;
  const titleMax = Math.max(8, inner - prefixW - depW);

  const titleLines = wrap(row.title || row.id, titleMax);
  const first = titleLines[0] ?? row.id;
  const head = row.active
    ? s.bold(s.fg("text", first))
    : s.fg(role === "success" ? "muted" : "text", first);

  let line = prefix + head;
  if (dep) {
    const spacer = Math.max(1, inner - width(line) - width(dep));
    line += " ".repeat(spacer) + dep;
  }
  const out = [line];
  for (const extra of titleLines.slice(1)) out.push(" ".repeat(prefixW) + s.fg("muted", extra));
  return out;
}

/**
 * Which slice of rows to show.
 *
 * With no explicit scroll the window follows the run: centred on the active
 * task, biased so a few finished rows stay above it, because "what just got
 * done" is most of what makes progress legible.
 */
export function rowWindow(
  rows: PlanRow[],
  limit: number,
  scroll: number | null,
  context = COMPLETED_CONTEXT,
): { start: number; end: number } {
  const total = rows.length;
  if (total <= limit) return { start: 0, end: total };
  if (scroll !== null) {
    const start = Math.max(0, Math.min(scroll, total - limit));
    return { start, end: start + limit };
  }
  const focus = focusRowIndex(rows);
  if (focus < limit - context) return { start: 0, end: limit };
  if (focus >= total - (limit - context)) return { start: total - limit, end: total };
  const start = Math.max(0, Math.min(focus - context, total - limit));
  return { start, end: start + limit };
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
  const view = state.view ?? defaultView();
  const display = normalizeDisplay(state.display ?? defaultDisplay());
  const limit =
    options.taskWindow ?? (view.expanded ? Math.max(EXPANDED_WINDOW, display.taskWindow * 2) : display.taskWindow);

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
  // Dashboard URL: always visible (user never has to type /infinity:dashboard to discover it).
  {
    const url = state.dashboardUrl as string | null | undefined;
    if (url) {
      const label = s.fg("accent", url);
      const link = `\u001b]8;;${url}\u0007${label}\u001b]8;;\u0007`;
      push(truncate(s.fg("muted", "Dashboard: ") + link, inner));
    } else {
      push(truncate(s.fg("muted", "Dashboard: ") + s.fg("muted", "/infinity:dashboard → http://127.0.0.1:PORT"), inner));
    }
  }
  if (state.handoffModelNote) {
    push(truncate(s.fg("muted", state.handoffModelNote), inner));
  }

  // -- goal -----------------------------------------------------------------
  //
  // A single goal is the run's headline and belongs at the top, not buried in
  // the tree — `buildPlanRows` collapses it there for exactly this reason.
  // Several goals are structure, and structure belongs in the tree.
  const _goals = state.list.goals ?? [];
  const _headline = !display.levels.goal
    ? null
    : _goals.length === 1
      ? (_goals[0]?.title ?? null)
      : _goals.length === 0
        ? (state.intake ?? null)
        : null;
  if (_headline) {
    const wrapped = wrap(_headline, inner - 2);
    wrapped.forEach((line, i) => {
      push((i === 0 ? s.fg("muted", g.goal + " ") : "  ") + s.fg("text", line));
    });
  }

  // -- current chain: one line per lane: phase · task · feature (+ sprint) · subtask
  // On an empty plan with no task yet, just show phase/goal.

  // Task lane disabled -> no lane at all (overview template wants shape not work).
  // Otherwise show active + pending first lane.
  if (!display.levels.task) {
    // Overview: keep the shape (goal/sprint/feature tier names) even without lanes.
    const f = state.list.features[0];
    if (f) {
      const sname = (f as { sprintId?: string }).sprintId ? (state.list.sprints ?? []).find((s) => s.id === (f as { sprintId?: string }).sprintId)?.name : null;
      const gname = (f as { goalId?: string }).goalId ? (state.list.goals ?? []).find((g) => g.id === (f as { goalId?: string }).goalId)?.title : null;
      const shape: string[] = [];
      if (display.levels.goal && gname) shape.push(s.fg("muted", "goal " + gname.slice(0, 28)));
      if (display.levels.sprint && sname) shape.push(s.fg("muted", "sprint " + sname.slice(0, 22)));
      if (display.levels.feature) shape.push(s.fg("success", f.name.slice(0, 28)));
      if (shape.length) { push(); push(truncate(shape.join(s.fg("rule", " \u00b7 ")), inner)); }
    }
  }
  // Aggregate task-window size respected: lane count capped; elision markers show hidden work.
  // On a huge plan (120 tasks) the widget previously rendered ~TASK_WINDOW rows; now show up to display.taskWindow lanes.
  // On a long plan the lane is compact — goal handled via headline above; phase first inside lane so
  // narrow TUI still shows active work before sprint/feature tail gets cut.
  const taskWindow = view.expanded ? Math.max(28, display.taskWindow * 2) : display.taskWindow;
  if (display.levels.task) {
    const allTasks = flattenTasks(state.list);
    // When user scrolled explicitly, honour the scroll window (huge plan test uses scroll: 0/1e6).
    // Otherwise show focus-centred window (active task plus pending tail).
    let lanes: Array<FlatTask & { subtasks?: { status: string; title: string }[] }> = [];
    if (view.scroll !== null) {
      const start = Math.max(0, Math.min(view.scroll as number, Math.max(0, allTasks.length - taskWindow)));
      lanes = allTasks.slice(start, start + taskWindow).map((t) => t as unknown as FlatTask & { subtasks?: { status: string; title: string }[] });
    } else {
      const activeTasks = allTasks.filter((t) => t.status === "in_progress" || t.status === "rework");
      const focus = nextActionableTask(state.list) ?? activeTasks[0] ?? null;
      if (focus) lanes.push(focus as unknown as FlatTask & { subtasks?: { status: string; title: string }[] });
      for (const t of activeTasks) if (focus && t.compositeKey !== focus.compositeKey && lanes.length < taskWindow) lanes.push(t as unknown as FlatTask & { subtasks?: { status: string; title: string }[] });
      if (!lanes.length) {
        const pending = nextActionableTask(state.list);
        if (pending) lanes.push(pending as unknown as FlatTask & { subtasks?: { status: string; title: string }[] });
      }
      if (lanes.length < taskWindow) {
        const pendingQ = allTasks.filter((t) => t.status === "pending" && !lanes.some((l) => l.compositeKey === t.compositeKey));
        for (const t of pendingQ) {
          if (lanes.length >= taskWindow) break;
          lanes.push(t as unknown as FlatTask & { subtasks?: { status: string; title: string }[] });
        }
      }
    }
    const formatChain = (t: FlatTask & { subtasks?: { status: string; title: string }[] }): string => {
      const curFeature = state.list.features.find((f) => f.id === t.featureId) ?? null;
      const curSprint = curFeature?.sprintId ? (state.list.sprints ?? []).find((s) => s.id === curFeature!.sprintId) ?? null : null;
      const curGoal = (curFeature?.goalId ?? curSprint?.goalId ?? (state.list.goals ?? [])[0]?.id) ? (state.list.goals ?? []).find((gg) => gg.id === (curFeature?.goalId ?? curSprint?.goalId ?? (state.list.goals ?? [])[0]?.id)) ?? null : null;
      // goal + sprint + phase + feature + task + subtask: names/titles
      // Always show the phase and the task; goal/sprint/feature/subtask honour display.levels.
      const parts: string[] = [];
      // One-line chain: phase · sprint · feature · task · subtask on one line.
      // Sprint before task/feature so even narrow realpi rasterizer keeps Foundations visible.
      if (state.phase) parts.push(s.bold(s.fg("accent", state.phase.toUpperCase())));
      if (curSprint && display.levels.sprint) parts.push(s.fg("muted", "sprint " + (curSprint.name ?? curSprint.id).slice(0, 18)));
      if (curFeature && display.levels.feature) parts.push(s.fg("success", curFeature.name.slice(0, 24)));
      const descEarly = t.description ? t.description.slice(0, 44) : "";
      parts.push(s.fg("text", t.compositeKey + (descEarly ? " " + descEarly.slice(0, 36) : "")));
      // subtask handled as separate line so width budget doesn't cut it off; drop from chain
      return parts.join(s.fg("rule", " · "));
    };
    if (lanes.length) {
      // Elision: lanes window + markers so huge plan still shows ... N above / ... N below
      const totalPendable = allTasks.length;
      const above = allTasks.findIndex((t) => t.compositeKey === lanes[0]!.compositeKey);
      const lastIdx = allTasks.findIndex((t) => t.compositeKey === lanes[lanes.length - 1]!.compositeKey);
      const below = Math.max(0, totalPendable - lastIdx - 1);
      const shownAbove = above > 0 ? above : 0;
      const shownBelow = below > 0 ? below : 0;
      push();
      if (shownAbove > 0) push(s.fg("rule", "  " + g.more + " " + shownAbove + " above"));
      for (const task of lanes.slice(0, taskWindow)) {
        push(truncate(formatChain(task), inner));
        // If task has an active subtask, show it on its own line so narrow TUI doesn't truncate it away.
        if (display.levels.subtask !== "none") {
          const cur = ((task as unknown as FlatTask & { subtasks?: Subtask[] }).subtasks ?? []).find((ss) => ss.status !== "complete") ?? null;
          if (cur) push(truncate("  " + s.fg("active", "> " + cur.title.slice(0, 56)), inner));
        }
      }
      if (shownBelow > 0) push(s.fg("rule", "  " + g.more + " " + shownBelow + " below"));
    } else if (state.list.features.length === 0) {
      push();
      push(s.fg("muted", "  no plan yet"));
    }
  }

  // -- phase rail -----------------------------------------------------------
  if (display.rail) {
    push();
    push(phaseRail(state.phase, state.enabledPhases, inner, g, s));
  }

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

  if (display.progress) {
    const statsW = width(stats);
    const barCells = Math.max(8, Math.min(24, inner - statsW - 8));
    const bar = progressBar(progress.percent, barCells, g, s);
    push();
    const gap2 = inner - width(bar) - statsW;
    push(truncate(bar + (gap2 > 0 ? " ".repeat(gap2) : " ") + stats, inner));
  }

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
  if (state.awaitingApproval) {
    alerts.unshift(
      s.bold(s.fg("active", g.rework + " " + state.awaitingApproval.toUpperCase() + " needs your OK")),
    );
  }
  if (typeof state.sessions === "number" && state.sessions > 1) {
    // Proof the handoff is working. Without it a run that quietly stopped
    // starting fresh sessions looks exactly like one that never did.
    alerts.push(s.fg("muted", "session " + state.sessions));
  }
  if (state.gate && !state.gate.overall) {
    alerts.push(s.fg("blocked", "gate: " + state.gate.failures.slice(0, 3).join(", ")));
  }
  if (display.alerts && alerts.length) push(truncate(alerts.join(s.fg("rule", " · ")), inner));

  // footer only — scroll tree removed to keep TUI readable on narrow term
  push(s.fg("rule", " " + g.rail.repeat(Math.max(1, inner - 2))));
  return frame(out, total, boxed, s, g);
}

/**
 * The keys that move the window, said once, where the window runs out.
 *
 * `alt+` rather than `ctrl+`: pi binds ctrl+j, ctrl+k and ctrl+o in the editor
 * already, and a widget is not worth shadowing an editor key for.
 */
function hintKeys(_g: GlyphSet): string {
  return "alt+j/k scroll · alt+o expand";
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
  if (state.awaitingApproval) return `${state.awaitingApproval} · needs your OK`;
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
