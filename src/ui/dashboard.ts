/**
 * infinity-harness — the web dashboard.
 *
 * Same information design as src/ui/widget.ts, rendered for a browser. The
 * harness runs unattended for hours; this page is what a human leaves open on a
 * second monitor and glances at. It must answer four questions without
 * interaction: where in the pipeline are we, how far along, what is being worked
 * on right now, and is anything stuck.
 *
 * Two constraints shape everything below.
 *
 *   1. Every value on this page originates in model output or project files, so
 *      every interpolation goes through `escapeHtml`. There is no templating
 *      engine to catch a miss — the discipline is the mitigation.
 *   2. The document is served from a localhost HTTP server with no asset routes,
 *      so it is entirely self-contained: no CDN, no web fonts, no remote images,
 *      no network at all beyond re-fetching itself.
 */

import type {
  CheckResult,
  Feature,
  FeatureList,
  GateResult,
  Goal,
  Phase,
  Subtask,
  Task,
  TaskStatus,
} from "../core/types.ts";
import {
  computeProgress,
  flattenTasks,
  normalizeStatus,
  normalizeSubtaskStatus,
  type FlatTask,
} from "../core/featureList.ts";
import { getPhaseOrder } from "../core/phases.ts";
import { statusGlyph } from "./widget.ts";
import { UNICODE_GLYPHS } from "./theme.ts";
import { groupPlan, type PlanGoalGroup, type PlanSprintGroup } from "./planTree.ts";

export type DashboardState = {
  list: FeatureList;
  phase: Phase | null;
  enabledPhases?: readonly string[] | null;
  paused?: boolean;
  gate?: GateResult | null;
  baseRevision: number;
  timestamp: string;
  retries?: { task: number; max: number };
  /** Model-router config. Opaque here — rendered as a badge, never interpreted. */
  router?: unknown;
  /** Rework record. Opaque here — rendered as a badge, never interpreted. */
  rework?: unknown;
  /** A phase whose gate passed and which is waiting for a human signature. */
  awaitingApproval?: string | null;
  /** How many pi sessions this run has spent, when handoff is on. */
  sessions?: number | null;
  /** Which goal pass this is, out of how many. */
  goalPass?: { current: number; max: number } | null;
};

// ── escaping ────────────────────────────────────────────────────────────────

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escape for both element text and double/single-quoted attribute values.
 *
 * `String(s)` is not redundant: the type says `string`, but the values reaching
 * this function come from `JSON.parse` of files the harness does not control,
 * so a number or `null` can arrive at runtime past the type system.
 */
export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** Escape anything, including values the type system says cannot be here. */
function esc(v: unknown): string {
  if (v === null || v === undefined) return "";
  return escapeHtml(typeof v === "string" ? v : String(v));
}

// ── status normalisation ────────────────────────────────────────────────────

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "pending",
  in_progress: "in progress",
  complete: "complete",
  blocked: "blocked",
  rework: "rework",
};

/** CSS class suffix per status; keeps the palette mapping in one place. */
const STATUS_CLASS: Record<TaskStatus, string> = {
  pending: "pending",
  in_progress: "active",
  complete: "complete",
  blocked: "blocked",
  rework: "rework",
};

/**
 * `normalizeStatus` throws on junk, which is right for a writer and wrong for a
 * renderer — a monitoring page must never 500 because one task has a typo'd
 * status. Unknown values degrade to `pending`.
 */
function safeStatus(v: unknown): TaskStatus {
  try {
    return normalizeStatus(v);
  } catch {
    return "pending";
  }
}

function safeSubtaskStatus(v: unknown): Subtask["status"] {
  try {
    return normalizeSubtaskStatus(v);
  } catch {
    return "pending";
  }
}

/**
 * remote.ts reads feature-list.json raw, without the normalisation
 * `loadFeatureList` applies, so legacy aliases ("done", "in-progress") reach us
 * intact. `computeProgress` compares against the canonical spelling only, so a
 * page rendered from raw data would show a task as complete in the task list and
 * still count it as outstanding in the meter. Normalising once, up front, is
 * what keeps every number on the page agreeing with every other one.
 */
function normalizeForRender(list: FeatureList): FeatureList {
  const features = Array.isArray(list?.features) ? list.features : [];
  return {
    ...list,
    features: features.map((f) => ({
      ...f,
      tasks: (Array.isArray(f?.tasks) ? f.tasks : []).map((t) => ({
        ...t,
        status: safeStatus(t?.status),
        subtasks: (Array.isArray(t?.subtasks) ? t.subtasks : []).map((s) => ({
          ...s,
          status: safeSubtaskStatus(s?.status),
        })),
      })),
    })),
  };
}

type StatusCounts = Record<TaskStatus, number>;

function countByStatus(tasks: readonly Task[]): StatusCounts {
  const counts: StatusCounts = { pending: 0, in_progress: 0, complete: 0, blocked: 0, rework: 0 };
  for (const t of tasks) counts[t.status] += 1;
  return counts;
}

// ── numeric helpers ─────────────────────────────────────────────────────────

/** Percentages are interpolated into `style="width:…"`, so they must be finite. */
function pct(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
  return Math.max(0, Math.min(100, (part / whole) * 100));
}

function widthStyle(value: number): string {
  return value <= 0 ? "" : ` style="width:${value.toFixed(3)}%"`;
}

// ── opaque badges (router / rework) ─────────────────────────────────────────

type Badge = { label: string; note: string | null };

function readString(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * `router` and `rework` are declared `unknown` on purpose — this module has no
 * business knowing their schemas, and they change independently of the UI. But
 * "truthy" alone is the wrong test: remote.ts emits `{ active: false }` and
 * `{ enabled: false }` sentinels rather than null, so a naive check would leave
 * both badges permanently lit. Honour an explicit off-switch, then show whatever
 * one short detail we can recognise, and nothing more.
 */
function readBadge(value: unknown, label: string): Badge | null {
  if (!value) return null;
  if (typeof value !== "object") return { label, note: null };

  const rec = value as Record<string, unknown>;
  if (rec.enabled === false || rec.active === false) return null;

  const impacted = rec.impactedCount;
  if (typeof impacted === "number" && impacted > 0) {
    return { label, note: `${impacted} impacted` };
  }
  const note = readString(rec, "returnTask") ?? readString(rec, "default");
  return { label, note };
}

// ── components ──────────────────────────────────────────────────────────────

const GLYPHS = UNICODE_GLYPHS;

/** Stacked meter: outstanding work is visible as colour, not just as absence. */
function meter(counts: StatusCounts, total: number, extraClass = ""): string {
  const order: TaskStatus[] = ["complete", "in_progress", "rework", "blocked"];
  const segments = order
    .filter((s) => counts[s] > 0)
    .map((s) => {
      const w = pct(counts[s], total);
      return `<span class="seg seg-${STATUS_CLASS[s]}"${widthStyle(w)}></span>`;
    })
    .join("");
  const done = Math.round(pct(counts.complete, total));
  const cls = extraClass ? ` ${extraClass}` : "";
  return (
    `<div class="meter${cls}" role="img" aria-label="${esc(String(done))} percent complete">` +
    segments +
    `</div>`
  );
}

function renderMasthead(
  phase: Phase | null,
  paused: boolean,
  percent: number,
  baseRevision: number,
  badges: readonly Badge[],
): string {
  const phaseTag = paused
    ? `<span class="tag tag-blocked">paused</span>`
    : phase
      ? `<span class="tag tag-accent">${esc(phase)}</span>`
      : `<span class="tag tag-pending">not started</span>`;

  const badgeHtml = badges
    .map(
      (b) =>
        `<span class="chip chip-brand" title="${esc(b.label)}">${esc(b.label)}` +
        (b.note ? `<span class="chip-note">${esc(b.note)}</span>` : "") +
        `</span>`,
    )
    .join("");

  return `<header class="masthead">
  <div class="masthead-id">
    <span class="brand" aria-hidden="true">&#8734;</span>
    <span class="brand-name">infinity&#8209;harness</span>
    ${phaseTag}
    ${badgeHtml}
  </div>
  <div class="masthead-live">
    <span class="pct-inline">${esc(String(percent))}%</span>
    <span class="rev mono">rev ${esc(String(baseRevision))}</span>
    <span id="conn" class="conn is-live"><span class="conn-dot"></span><span class="conn-label">live</span> &middot; <span id="age">just now</span></span>
  </div>
</header>`;
}

function renderGoals(goals: readonly Goal[]): string {
  if (goals.length === 0) return "";
  const [first, ...rest] = goals;
  if (!first) return "";

  const extras = rest.length
    ? `<ul class="goal-more">` +
      rest.map((g) => `<li>${esc(g.title ?? g.id ?? "")}</li>`).join("") +
      `</ul>`
    : "";

  return `<section class="card goal" aria-label="Goal">
  <div class="label">Goal</div>
  <h1 class="goal-title">${esc(first.title ?? first.id ?? "")}</h1>
  ${first.description && first.description !== first.title ? `<p class="goal-desc">${esc(first.description)}</p>` : ""}
  ${extras}
</section>`;
}

/**
 * The pipeline as a rail. A phase that is not part of the enabled pipeline
 * (`init`, or a phase disabled after the run began) is still where the harness
 * actually is, so it is prepended rather than dropped — a rail that cannot show
 * the current phase is worse than a rail with an extra node.
 */
function renderRail(phase: Phase | null, enabled: readonly string[] | null | undefined, paused: boolean): string {
  const order = getPhaseOrder(enabled);
  const steps: Phase[] = phase && !order.includes(phase) ? [phase, ...order] : order;
  const current = phase ? steps.indexOf(phase) : -1;

  const items = steps
    .map((p, i) => {
      const state =
        current >= 0 && i < current
          ? "is-done"
          : i === current
            ? paused
              ? "is-current is-paused"
              : "is-current"
            : "is-todo";
      const mark =
        current >= 0 && i < current
          ? GLYPHS.phaseDone
          : i === current
            ? GLYPHS.phaseCurrent
            : GLYPHS.phaseTodo;
      return `<li class="step ${state}">
      <span class="track"><span class="dot" aria-hidden="true"></span></span>
      <span class="step-name">${esc(p)}</span>
      <span class="sr-only">${esc(mark)}</span>
    </li>`;
    })
    .join("");

  return `<nav class="card rail-wrap" aria-label="Pipeline">
  <ol class="rail">${items}</ol>
</nav>`;
}

function renderProgress(counts: StatusCounts, total: number, featuresDone: number, featuresTotal: number): string {
  const percent = Math.round(pct(counts.complete, total));

  const legendOrder: TaskStatus[] = ["complete", "in_progress", "rework", "blocked", "pending"];
  const legend = legendOrder
    .map((s) => {
      const zero = counts[s] === 0 ? " is-zero" : "";
      return `<li class="legend-item legend-${STATUS_CLASS[s]}${zero}">
      <span class="legend-dot" aria-hidden="true"></span>
      <span class="legend-n">${esc(String(counts[s]))}</span>
      <span class="legend-label">${esc(STATUS_LABEL[s])}</span>
    </li>`;
    })
    .join("");

  return `<section class="card progress" aria-label="Progress">
  <div class="progress-head">
    <div>
      <div class="label">Overall</div>
      <div class="pct">${esc(String(percent))}<span class="pct-sign">%</span></div>
    </div>
    <div class="progress-counts">
      <div><span class="count">${esc(String(counts.complete))}</span><span class="count-of"> / ${esc(String(total))}</span> tasks</div>
      <div><span class="count">${esc(String(featuresDone))}</span><span class="count-of"> / ${esc(String(featuresTotal))}</span> features</div>
    </div>
  </div>
  ${meter(counts, total, "meter-lg")}
  <ul class="legend">${legend}</ul>
</section>`;
}

type Alert = { tone: string; text: string };

/**
 * The strip only exists when it has something to say. An always-present "0
 * blocked" row trains the eye to skip the exact region that matters on the one
 * day it is not zero.
 */
function renderAlerts(
  counts: StatusCounts,
  paused: boolean,
  retries: DashboardState["retries"],
  gate: GateResult | null,
  extra: {
    awaitingApproval?: string | null;
    sessions?: number | null;
    goalPass?: { current: number; max: number } | null;
  } = {},
): string {
  const alerts: Alert[] = [];

  if (paused) alerts.push({ tone: "blocked", text: "run paused" });
  // A run parked for a signature looks, from every other indicator, exactly
  // like a run that has stopped. Saying so is the difference between someone
  // coming back to a finished phase and someone coming back to a dead run.
  if (extra.awaitingApproval) {
    alerts.push({
      tone: "active",
      text: `${String(extra.awaitingApproval).toUpperCase()} is waiting for your approval`,
    });
  }
  if (extra.goalPass && extra.goalPass.max > 1) {
    alerts.push({
      tone: extra.goalPass.current >= extra.goalPass.max ? "blocked" : "active",
      text: `goal pass ${extra.goalPass.current} / ${extra.goalPass.max}`,
    });
  }
  if (counts.blocked > 0) {
    alerts.push({ tone: "blocked", text: `${counts.blocked} blocked ${counts.blocked === 1 ? "task" : "tasks"}` });
  }
  if (counts.rework > 0) {
    alerts.push({ tone: "rework", text: `${counts.rework} in rework` });
  }
  if (retries && retries.task > 0) {
    const spent = retries.max > 0 && retries.task >= retries.max;
    alerts.push({
      tone: spent ? "blocked" : "active",
      text: `retry budget ${retries.task} / ${retries.max}${spent ? " — exhausted" : ""}`,
    });
  }
  if (typeof extra.sessions === "number" && extra.sessions > 1) {
    alerts.push({ tone: "quiet", text: `${extra.sessions} sessions this run` });
  }
  if (gate && gate.overall === false) {
    const failures = Array.isArray(gate.failures) ? gate.failures : [];
    const head = failures.slice(0, 3).join(", ");
    const more = failures.length > 3 ? ` +${failures.length - 3} more` : "";
    alerts.push({ tone: "blocked", text: `gate failing${head ? ": " + head : ""}${more}` });
  }

  if (alerts.length === 0) return "";

  const items = alerts
    .map(
      (a) =>
        `<li class="alert alert-${esc(a.tone)}"><span class="alert-dot" aria-hidden="true"></span>${esc(a.text)}</li>`,
    )
    .join("");
  return `<ul class="alerts" role="status" aria-label="Alerts">${items}</ul>`;
}

function checkState(c: CheckResult): { key: string; label: string } {
  if (c.pass) return { key: "complete", label: "pass" };
  if (c.advisory) return { key: "active", label: "advisory" };
  return { key: "blocked", label: "fail" };
}

function renderGate(gate: GateResult | null): string {
  if (!gate) return "";
  const checks = Array.isArray(gate.checks) ? gate.checks : [];
  const failures = Array.isArray(gate.failures) ? gate.failures : [];
  const passed = gate.overall !== false;

  const scope = [gate.feature, gate.task].filter((v): v is string => typeof v === "string" && v !== "");

  const rows = checks.length
    ? checks
        .map((c) => {
          const st = checkState(c);
          return `<li class="check check-${st.key}">
        <span class="check-state">${esc(st.label)}</span>
        <span class="check-name mono">${esc(c.name ?? "")}</span>
        <span class="check-detail">${esc(c.detail ?? "")}</span>
      </li>`;
        })
        .join("")
    : `<li class="check check-empty">No checks ran for this gate.</li>`;

  const summary =
    !passed && failures.length
      ? `<p class="gate-summary">Blocking: ${esc(failures.join(", "))}</p>`
      : "";

  return `<section class="card gate ${passed ? "gate-pass" : "gate-fail"}" aria-label="Gate result">
  <div class="gate-head">
    <div>
      <div class="label">Gate</div>
      <div class="gate-phase">${esc(gate.phase ?? "")}${scope.length ? `<span class="gate-scope mono">${esc(scope.join(" · "))}</span>` : ""}</div>
    </div>
    <span class="verdict verdict-${passed ? "pass" : "fail"}">${passed ? "passed" : "failed"}</span>
  </div>
  ${summary}
  <ul class="checks">${rows}</ul>
</section>`;
}

function depLabel(task: FlatTask, indexByKey: ReadonlyMap<string, number>): string {
  const deps = Array.isArray(task.dependsOn) ? task.dependsOn : [];
  if (deps.length === 0) return "";
  // Unresolvable dependencies print verbatim — a dangling reference is a real
  // planning bug and hiding it would make the plan look sounder than it is.
  const refs = deps.map((d) => {
    const i = indexByKey.get(d);
    return i === undefined ? esc(d) : `#${esc(String(i))}`;
  });
  return `<span class="deps mono" title="depends on">${esc(GLYPHS.arrow)} ${refs.join(", ")}</span>`;
}

/**
 * Every subtask, on every task.
 *
 * The terminal widget shows these only for the task being worked, because it
 * has nine rows and a job to do with them. The dashboard has a whole page and
 * a scrollbar: the reason to open it is precisely to see the detail the widget
 * cannot fit, so hiding four of the five plan levels here made it a worse copy
 * of the widget rather than the place you go for the full picture.
 */
function renderSubtasks(task: FlatTask): string {
  const subs = Array.isArray(task.subtasks) ? task.subtasks : [];
  if (subs.length === 0) return "";
  const items = subs
    .map((s) => {
      const glyph =
        s.status === "complete" ? GLYPHS.subDone : s.status === "in_progress" ? GLYPHS.subActive : GLYPHS.subPending;
      const cls = s.status === "complete" ? "complete" : s.status === "in_progress" ? "active" : "pending";
      return `<li class="sub sub-${cls}"><span class="sub-glyph" aria-hidden="true">${esc(glyph)}</span>${esc(s.title ?? "")}</li>`;
    })
    .join("");
  return `<ul class="subs">${items}</ul>`;
}

function renderTaskRow(task: FlatTask, indexByKey: ReadonlyMap<string, number>): string {
  const status = task.status;
  const cls = STATUS_CLASS[status];
  const isActive = status === "in_progress" || status === "rework";
  const difficulty =
    typeof task.difficulty === "string" ? `<span class="chip chip-quiet">${esc(task.difficulty)}</span>` : "";

  return `<tr class="row row-${cls}${isActive ? " is-active" : ""}">
    <td class="cell-n">
      <span class="glyph glyph-${cls}" aria-hidden="true">${esc(statusGlyph(status, GLYPHS))}</span>
      <span class="n mono">${esc(String(task.index))}</span>
    </td>
    <td class="cell-task">
      <div class="task-line">
        <span class="task-desc">${esc(task.description || task.compositeKey)}</span>
        ${difficulty}
        ${depLabel(task, indexByKey)}
      </div>
      ${renderSubtasks(task)}
    </td>
    <td class="cell-status"><span class="pill pill-${cls}">${esc(STATUS_LABEL[status])}</span></td>
  </tr>`;
}

function renderFeature(
  feature: Feature,
  tasks: readonly FlatTask[],
  indexByKey: ReadonlyMap<string, number>,
  sprintName: string | null,
  goalName: string | null,
): string {
  const counts = countByStatus(tasks);
  const total = tasks.length;
  const complete = total > 0 && counts.complete === total;

  const chips = [
    sprintName ? `<span class="chip chip-quiet">${esc(sprintName)}</span>` : "",
    goalName ? `<span class="chip chip-quiet">${esc(goalName)}</span>` : "",
    feature.passes === true ? `<span class="chip chip-complete">verified</span>` : "",
  ].join("");

  const body = total
    ? `<div class="table-wrap">
      <table class="tasks">
        <thead><tr><th scope="col" class="cell-n">#</th><th scope="col">Task</th><th scope="col" class="cell-status">Status</th></tr></thead>
        <tbody>${tasks.map((t) => renderTaskRow(t, indexByKey)).join("")}</tbody>
      </table>
    </div>`
    : `<p class="empty-inline">No tasks planned for this feature yet.</p>`;

  return `<section class="card feature${complete ? " is-complete" : ""}">
  <div class="feature-head">
    <div class="feature-id">
      <h2 class="feature-name">${esc(feature.name ?? feature.id ?? "")}</h2>
      <span class="mono faint">${esc(feature.id ?? "")}</span>
      ${chips}
    </div>
    <div class="feature-progress">
      <span class="feature-count mono">${esc(String(counts.complete))}/${esc(String(total))}</span>
      ${meter(counts, total)}
    </div>
  </div>
  ${feature.description ? `<p class="feature-desc">${esc(feature.description)}</p>` : ""}
  ${body}
</section>`;
}

/**
 * A goal, its sprints, and their features — one collapsible section per level.
 *
 * `<details open>` is deliberate: everything is visible on load, and a human
 * reading a 60-task plan can fold away the parts they are not looking at
 * without the page needing a line of state management.
 */
function renderGoalGroup(
  group: PlanGoalGroup,
  tasksByFeature: ReadonlyMap<string, FlatTask[]>,
  indexByKey: ReadonlyMap<string, number>,
  show: { showGoal: boolean; showSprints: boolean },
): string {
  const sprints = group.sprints
    .map((sg) => renderSprintGroup(sg, tasksByFeature, indexByKey, show.showSprints))
    .join("");

  if (!show.showGoal || !group.goal) return sprints;

  return `<details class="tier tier-goal" open>
  <summary class="tier-head">
    <span class="tier-kind">goal</span>
    <span class="tier-name">${esc(group.goal.title ?? group.goal.id ?? "")}</span>
    <span class="mono faint">${esc(group.goal.id ?? "")}</span>
    <span class="tier-count mono">${esc(String(group.done))}/${esc(String(group.total))}</span>
  </summary>
  <div class="tier-body">${sprints}</div>
</details>`;
}

function renderSprintGroup(
  group: PlanSprintGroup,
  tasksByFeature: ReadonlyMap<string, FlatTask[]>,
  indexByKey: ReadonlyMap<string, number>,
  showSprints: boolean,
): string {
  const features = group.features
    .map((f) => renderFeature(f, tasksByFeature.get(f.id) ?? [], indexByKey, null, null))
    .join("");

  if (!showSprints || !group.sprint) return features;

  return `<details class="tier tier-sprint" open>
  <summary class="tier-head">
    <span class="tier-kind">sprint</span>
    <span class="tier-name">${esc(group.sprint.name ?? group.sprint.id ?? "")}</span>
    <span class="mono faint">${esc(group.sprint.id ?? "")}</span>
    <span class="tier-count mono">${esc(String(group.done))}/${esc(String(group.total))}</span>
  </summary>
  <div class="tier-body">${features}</div>
</details>`;
}

function renderEmptyPlan(phase: Phase | null): string {
  const where = phase ? `The harness is in ${esc(phase)}.` : "The harness has not started a phase yet.";
  return `<section class="card empty">
  <div class="empty-mark" aria-hidden="true">${esc(GLYPHS.pending)}</div>
  <h2>No plan yet</h2>
  <p>${where} Features and tasks appear here once DEFINE and PLAN have produced a feature list.</p>
  <p class="faint">This page refreshes itself every few seconds — leave it open.</p>
</section>`;
}

// ── styles ──────────────────────────────────────────────────────────────────

/**
 * Palette note: `--c-*` are the canonical semantic hues, byte-identical to
 * PALETTE in src/ui/theme.ts, and are used for fills, glyphs and rules. Small
 * text needs a second set: #D98A00 on white is 2.8:1 and #D64545 on the dark
 * ground is 4.1:1, both below AA. `--t-*` keep the same hue and shift luminance
 * per theme so status text stays readable in both.
 */
const STYLES = `
*,*::before,*::after{box-sizing:border-box}

:root{
  --bg:#F6F7F9;
  --surface:#FFFFFF;
  --surface-2:#F1F3F6;
  --border:#E3E6EB;
  --border-strong:#CDD2DA;
  --text:#13161B;
  --muted:#59606B;
  --faint:#8A909B;
  --shadow:0 1px 2px rgba(17,22,32,.05),0 8px 20px rgba(17,22,32,.04);
  --ring:rgba(0,184,212,.20);

  --c-complete:#2E9E5B;
  --c-active:#D98A00;
  --c-pending:#8A8F98;
  --c-blocked:#D64545;
  --c-rework:#B36BD4;
  --c-brand:#7C5CFF;
  --c-accent:#00B8D4;

  --rgb-complete:46,158,91;
  --rgb-active:217,138,0;
  --rgb-pending:138,143,152;
  --rgb-blocked:214,69,69;
  --rgb-rework:179,107,212;
  --rgb-brand:124,92,255;
  --rgb-accent:0,184,212;

  --t-complete:#1E7A43;
  --t-active:#8F5C11;
  --t-pending:#616772;
  --t-blocked:#B12F2F;
  --t-rework:#8843AB;
  --t-brand:#5A3EE0;
  --t-accent:#0A7386;
}

@media (prefers-color-scheme:dark){
  :root{
    --bg:#0B0D11;
    --surface:#14171C;
    --surface-2:#191D24;
    --border:#242A33;
    --border-strong:#333A45;
    --text:#E7EAEF;
    --muted:#98A0AC;
    --faint:#6C7480;
    --shadow:0 1px 2px rgba(0,0,0,.36),0 10px 28px rgba(0,0,0,.30);
    --ring:rgba(0,184,212,.26);

    --t-complete:#5DC98A;
    --t-active:#F0AE3C;
    --t-pending:#9AA1AC;
    --t-blocked:#F08281;
    --t-rework:#CF9AE4;
    --t-brand:#A492FF;
    --t-accent:#4FD8ED;
  }
}

html{-webkit-text-size-adjust:100%}
body{
  margin:0;
  background:var(--bg);
  color:var(--text);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Ubuntu,Cantarell,"Noto Sans",sans-serif;
  font-variant-numeric:tabular-nums;
  -webkit-font-smoothing:antialiased;
}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:.92em}
.faint{color:var(--faint)}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}

.page{max-width:1120px;margin:0 auto;padding:0 20px 72px}
.card{
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:12px;
  padding:16px 18px;
  margin:14px 0;
  box-shadow:var(--shadow);
}
.label{
  font-size:10.5px;text-transform:uppercase;letter-spacing:.09em;
  color:var(--faint);font-weight:600;margin-bottom:6px;
}

/* -- masthead ------------------------------------------------------------- */
.masthead{
  position:sticky;top:0;z-index:20;
  display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;justify-content:space-between;
  padding:14px 0 12px;margin-bottom:2px;
  background:var(--bg);
  border-bottom:1px solid var(--border);
}
.masthead-id,.masthead-live{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.brand{color:var(--c-brand);font-size:19px;line-height:1}
.brand-name{font-weight:650;letter-spacing:-.01em}
.pct-inline{font-weight:650;font-variant-numeric:tabular-nums}
.rev{color:var(--faint)}

.tag{
  font-size:11px;font-weight:650;letter-spacing:.07em;text-transform:uppercase;
  padding:3px 8px;border-radius:999px;border:1px solid transparent;
}
.tag-accent{color:var(--t-accent);background:rgba(var(--rgb-accent),.12);border-color:rgba(var(--rgb-accent),.32)}
.tag-blocked{color:var(--t-blocked);background:rgba(var(--rgb-blocked),.12);border-color:rgba(var(--rgb-blocked),.34)}
.tag-pending{color:var(--t-pending);background:rgba(var(--rgb-pending),.12);border-color:rgba(var(--rgb-pending),.30)}

/* Chips carry model-supplied names (sprints, router defaults). inline-block
   rather than inline-flex so text-overflow can actually clip an absurd one
   instead of pushing the masthead past the viewport. */
.chip{
  display:inline-block;
  font-size:11px;padding:2px 7px;border-radius:6px;
  border:1px solid var(--border);background:var(--surface-2);color:var(--muted);
  white-space:nowrap;max-width:min(100%,26ch);overflow:hidden;text-overflow:ellipsis;
  vertical-align:baseline;
}
.chip-brand{color:var(--t-brand);background:rgba(var(--rgb-brand),.10);border-color:rgba(var(--rgb-brand),.28)}
.chip-complete{color:var(--t-complete);background:rgba(var(--rgb-complete),.12);border-color:rgba(var(--rgb-complete),.30)}
.chip-quiet{font-size:10.5px}
.chip-note{color:var(--faint);font-size:10.5px;margin-left:5px}

.conn{display:inline-flex;align-items:center;gap:6px;color:var(--faint);font-size:12px}
.conn-dot{width:7px;height:7px;border-radius:50%;background:var(--c-pending);flex:none}
.conn.is-live .conn-dot{background:var(--c-complete)}
.conn.is-live .conn-label{color:var(--t-complete)}
.conn.is-stale .conn-dot{background:var(--c-active)}
.conn.is-stale .conn-label{color:var(--t-active)}

/* -- goal ----------------------------------------------------------------- */
.goal-title{font-size:17px;font-weight:600;margin:0;line-height:1.35;overflow-wrap:anywhere}
.goal-desc{margin:8px 0 0;color:var(--muted);overflow-wrap:anywhere}
.goal-more{margin:10px 0 0;padding-left:18px;color:var(--muted);font-size:13px;overflow-wrap:anywhere}

/* -- phase rail ----------------------------------------------------------- */
.rail-wrap{overflow-x:auto;padding:18px 18px 14px}
.rail{display:flex;list-style:none;margin:0;padding:0;min-width:520px}
.step{flex:1 1 0;min-width:76px;text-align:center;position:relative}
.track{display:block;position:relative;height:14px}
.track::before,.track::after{content:"";position:absolute;top:50%;height:2px;background:var(--border-strong);transform:translateY(-50%)}
.track::before{left:0;right:50%}
.track::after{left:50%;right:0}
.step:first-child .track::before,.step:last-child .track::after{display:none}
.dot{
  position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  width:11px;height:11px;border-radius:50%;
  background:var(--surface);border:2px solid var(--border-strong);z-index:1;
}
.step-name{
  display:block;margin-top:9px;font-size:12px;color:var(--faint);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 4px;
}
.step.is-done .dot{background:var(--c-complete);border-color:var(--c-complete)}
.step.is-done .track::before,.step.is-done .track::after,.step.is-current .track::before{background:var(--c-complete)}
.step.is-done .step-name{color:var(--t-complete)}
.step.is-current .dot{
  background:var(--c-accent);border-color:var(--c-accent);
  width:13px;height:13px;box-shadow:0 0 0 4px var(--ring);
  animation:pulse 2.6s ease-in-out infinite;
}
.step.is-current .step-name{color:var(--t-accent);font-weight:650;letter-spacing:.02em}
.step.is-current.is-paused .dot{background:var(--c-blocked);border-color:var(--c-blocked);box-shadow:0 0 0 4px rgba(var(--rgb-blocked),.20);animation:none}
.step.is-current.is-paused .step-name{color:var(--t-blocked)}
@keyframes pulse{0%,100%{box-shadow:0 0 0 3px var(--ring)}50%{box-shadow:0 0 0 7px rgba(var(--rgb-accent),.06)}}

/* -- progress ------------------------------------------------------------- */
.progress-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap}
.pct{font-size:38px;line-height:1;font-weight:640;letter-spacing:-.02em}
.pct-sign{font-size:19px;font-weight:500;color:var(--faint);margin-left:2px}
.progress-counts{text-align:right;color:var(--muted);font-size:13px;line-height:1.7}
.count{font-weight:650;color:var(--text)}
.count-of{color:var(--faint)}

.meter{
  display:flex;height:6px;border-radius:999px;overflow:hidden;
  background:var(--surface-2);border:1px solid var(--border);
}
.meter-lg{height:10px;margin:14px 0 12px}
.seg{display:block;height:100%}
.seg-complete{background:var(--c-complete)}
.seg-active{background:var(--c-active)}
.seg-rework{background:var(--c-rework)}
.seg-blocked{background:var(--c-blocked)}

.legend{display:flex;flex-wrap:wrap;gap:6px 18px;list-style:none;margin:0;padding:0;font-size:12px}
.legend-item{display:flex;align-items:center;gap:6px;color:var(--muted)}
.legend-item.is-zero{opacity:.42}
.legend-dot{width:8px;height:8px;border-radius:2px;flex:none}
.legend-n{font-weight:650;color:var(--text);font-variant-numeric:tabular-nums}
.legend-complete .legend-dot{background:var(--c-complete)}
.legend-active .legend-dot{background:var(--c-active)}
.legend-rework .legend-dot{background:var(--c-rework)}
.legend-blocked .legend-dot{background:var(--c-blocked)}
.legend-pending .legend-dot{background:var(--c-pending)}

/* -- alerts --------------------------------------------------------------- */
.alerts{display:flex;flex-wrap:wrap;gap:8px;list-style:none;margin:14px 0;padding:0}
.alert{
  display:inline-flex;align-items:center;gap:7px;
  font-size:12.5px;font-weight:550;padding:5px 11px;border-radius:8px;border:1px solid transparent;
  max-width:100%;overflow-wrap:anywhere;
}
.alert-dot{width:7px;height:7px;border-radius:50%;flex:none;background:currentColor}
.alert-blocked{color:var(--t-blocked);background:rgba(var(--rgb-blocked),.10);border-color:rgba(var(--rgb-blocked),.30)}
.alert-rework{color:var(--t-rework);background:rgba(var(--rgb-rework),.10);border-color:rgba(var(--rgb-rework),.28)}
.alert-active{color:var(--t-active);background:rgba(var(--rgb-active),.10);border-color:rgba(var(--rgb-active),.28)}
.alert-quiet{color:var(--muted);background:var(--surface-2);border-color:var(--border)}

/* -- gate ----------------------------------------------------------------- */
.gate-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.gate-phase{font-size:15px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;overflow-wrap:anywhere}
.gate-scope{margin-left:10px;color:var(--faint);font-weight:400;text-transform:none;letter-spacing:0}
.gate-fail{border-color:rgba(var(--rgb-blocked),.45);box-shadow:var(--shadow),inset 3px 0 0 var(--c-blocked)}
.verdict{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:4px 10px;border-radius:999px}
.verdict-pass{color:var(--t-complete);background:rgba(var(--rgb-complete),.12)}
.verdict-fail{color:#fff;background:var(--c-blocked)}
.gate-summary{margin:10px 0 0;color:var(--t-blocked);font-weight:550;overflow-wrap:anywhere}
.checks{list-style:none;margin:12px 0 0;padding:0;display:flex;flex-direction:column;gap:1px}
.check{
  display:grid;grid-template-columns:74px minmax(110px,190px) 1fr;gap:12px;align-items:baseline;
  padding:8px 10px;border-radius:7px;background:var(--surface-2);
}
.check-state{font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.check-name{overflow-wrap:anywhere}
.check-detail{color:var(--muted);overflow-wrap:anywhere}
.check-complete .check-state{color:var(--t-complete)}
.check-active .check-state{color:var(--t-active)}
.check-blocked{background:rgba(var(--rgb-blocked),.10);box-shadow:inset 2px 0 0 var(--c-blocked)}
.check-blocked .check-state{color:var(--t-blocked)}
.check-blocked .check-name{font-weight:650}
.check-empty{display:block;color:var(--muted)}

/* -- features ------------------------------------------------------------- */
.feature-head{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}
.feature-id{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;min-width:0;overflow-wrap:anywhere}
.feature-name{font-size:15px;font-weight:640;margin:0;overflow-wrap:anywhere}
.feature-progress{display:flex;align-items:center;gap:10px;flex:0 1 220px;min-width:150px}
.feature-count{color:var(--muted);white-space:nowrap}
.feature-progress .meter{flex:1}
.feature.is-complete .feature-name{color:var(--muted)}
.feature-desc{margin:8px 0 0;color:var(--muted);font-size:13px;overflow-wrap:anywhere}
.empty-inline{color:var(--faint);font-size:13px;margin:12px 0 2px}

.table-wrap{overflow-x:auto;margin:12px -18px -16px;padding:0 18px 4px}
table.tasks{width:100%;border-collapse:collapse;min-width:480px}
table.tasks th{
  font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--faint);
  font-weight:600;text-align:left;padding:6px 8px;border-bottom:1px solid var(--border);
}
table.tasks td{padding:8px;border-bottom:1px solid var(--border);vertical-align:top}
table.tasks tr:last-child td{border-bottom:0}
.cell-n{width:1%;white-space:nowrap;padding-left:10px}
.cell-status{width:1%;white-space:nowrap;text-align:right}
.glyph{margin-right:6px}
.glyph-complete{color:var(--t-complete)}
.glyph-active{color:var(--t-active)}
.glyph-pending{color:var(--t-pending)}
.glyph-blocked{color:var(--t-blocked)}
.glyph-rework{color:var(--t-rework)}
.n{color:var(--faint)}
.task-line{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px}
.task-desc{overflow-wrap:anywhere}
.row-complete .task-desc{color:var(--muted)}
.row.is-active{background:rgba(var(--rgb-active),.07)}
.row.is-active .task-desc{font-weight:600}
.row.is-active .cell-n{box-shadow:inset 2px 0 0 var(--c-active)}
.row-rework.is-active{background:rgba(var(--rgb-rework),.08)}
.row-rework.is-active .cell-n{box-shadow:inset 2px 0 0 var(--c-rework)}
.row-blocked{background:rgba(var(--rgb-blocked),.07)}
.row-blocked .cell-n{box-shadow:inset 2px 0 0 var(--c-blocked)}
.deps{color:var(--faint);white-space:nowrap}
.pill{
  font-size:10.5px;font-weight:600;letter-spacing:.04em;padding:2px 8px;border-radius:999px;
  border:1px solid transparent;white-space:nowrap;
}
.pill-complete{color:var(--t-complete);background:rgba(var(--rgb-complete),.11);border-color:rgba(var(--rgb-complete),.26)}
.pill-active{color:var(--t-active);background:rgba(var(--rgb-active),.12);border-color:rgba(var(--rgb-active),.28)}
.pill-pending{color:var(--t-pending);background:rgba(var(--rgb-pending),.10);border-color:rgba(var(--rgb-pending),.24)}
.pill-blocked{color:var(--t-blocked);background:rgba(var(--rgb-blocked),.12);border-color:rgba(var(--rgb-blocked),.30)}
.pill-rework{color:var(--t-rework);background:rgba(var(--rgb-rework),.12);border-color:rgba(var(--rgb-rework),.28)}

.subs{list-style:none;margin:7px 0 2px;padding:0 0 0 2px;display:flex;flex-direction:column;gap:3px}
.sub{font-size:12.5px;color:var(--muted);display:flex;gap:8px;align-items:baseline;overflow-wrap:anywhere}
.sub-glyph{flex:none;width:12px;text-align:center;color:var(--t-pending)}
.sub-complete .sub-glyph{color:var(--t-complete)}
.sub-active .sub-glyph{color:var(--t-active)}
.sub-active{color:var(--text)}

/* -- empty / footer ------------------------------------------------------- */
.empty{text-align:center;padding:44px 24px}
.empty-mark{font-size:26px;color:var(--faint);margin-bottom:10px}
.empty h2{margin:0 0 8px;font-size:16px;font-weight:600}
.empty p{margin:0 auto;max-width:46ch;color:var(--muted)}
.empty p.faint{margin-top:10px;font-size:12.5px}
.section-label{
  margin:26px 2px 2px;font-size:10.5px;text-transform:uppercase;letter-spacing:.09em;
  color:var(--faint);font-weight:600;
}

/* -- plan tiers: goal > sprint > feature ---------------------------------- */
/* Depth is carried by a left rule rather than indentation, so a 60-task plan
   does not walk off the right edge of a phone. */
.tier{margin:18px 0 0}
.tier-head{
  display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;cursor:pointer;
  padding:7px 2px;list-style:none;border-radius:8px;
}
.tier-head::-webkit-details-marker{display:none}
.tier-head:hover{background:var(--surface-2)}
.tier-head:focus-visible{outline:2px solid var(--c-accent);outline-offset:2px}
.tier-kind{
  font-size:10px;text-transform:uppercase;letter-spacing:.1em;font-weight:700;
  padding:2px 7px;border-radius:999px;border:1px solid var(--border);color:var(--faint);
}
.tier-goal>.tier-head .tier-kind{color:var(--t-brand);border-color:var(--c-brand)}
.tier-sprint>.tier-head .tier-kind{color:var(--t-accent);border-color:var(--c-accent)}
.tier-name{font-size:15px;font-weight:650;overflow-wrap:anywhere}
.tier-goal>.tier-head .tier-name{font-size:17px}
.tier-count{margin-left:auto;color:var(--muted);font-size:13px;flex:none}
.tier-body{
  margin-left:5px;padding-left:14px;border-left:2px solid var(--border);
}
.tier-goal>.tier-body{border-left-color:var(--c-brand)}
.tier-sprint>.tier-body{border-left-color:var(--c-accent)}
.tier[open]>.tier-head .tier-kind{opacity:.85}
.tier:not([open])>.tier-head{opacity:.72}
.foot{
  display:flex;flex-wrap:wrap;gap:6px 14px;justify-content:space-between;
  margin-top:22px;padding-top:14px;border-top:1px solid var(--border);
  color:var(--faint);font-size:12px;
}
.foot a{color:var(--t-accent);text-decoration:none}
.foot a:hover{text-decoration:underline}

@media (max-width:640px){
  .page{padding:0 14px 56px}
  .card{padding:14px;border-radius:10px}
  .pct{font-size:30px}
  .progress-counts{text-align:left}
  .feature-progress{flex:1 1 100%}
  .table-wrap{margin:12px -14px -14px;padding:0 14px 4px}
  .check{grid-template-columns:64px 1fr;row-gap:2px}
  .check-detail{grid-column:1/-1;font-size:12.5px}
}

@media (prefers-reduced-motion:reduce){
  *{animation:none!important;transition:none!important}
}
`;

// ── refresh script ──────────────────────────────────────────────────────────

/**
 * Poll-and-swap rather than a websocket: the server is a plain read-only GET
 * endpoint and the page must survive it restarting. Only the contents of #app
 * are replaced, so this script (which lives outside it) keeps running across
 * refreshes and never re-registers its timers.
 *
 * Written without template literals — this string is itself embedded in one.
 */
const SCRIPT = `
(function () {
  var BASE = 5000, MAX = 60000, TIMEOUT = 4000;
  var delay = BASE, lastOk = Date.now(), timer = null;

  function mark(state) {
    var el = document.getElementById("conn");
    if (!el) return;
    el.className = "conn " + (state === "live" ? "is-live" : "is-stale");
    var label = el.querySelector(".conn-label");
    if (label) label.textContent = state === "live" ? "live" : "reconnecting";
  }

  function ago() {
    var el = document.getElementById("age");
    if (!el) return;
    var s = Math.max(0, Math.round((Date.now() - lastOk) / 1000));
    el.textContent = s < 3 ? "just now" : s < 90 ? s + "s ago" : Math.round(s / 60) + "m ago";
  }

  function schedule(ms) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(refresh, ms);
  }

  function opts() {
    var o = { cache: "no-store", credentials: "same-origin", headers: { "Accept": "text/html" } };
    // Without a deadline a half-open socket stalls the whole loop.
    try { if (window.AbortSignal && AbortSignal.timeout) o.signal = AbortSignal.timeout(TIMEOUT); } catch (e) {}
    return o;
  }

  function refresh() {
    // A hidden tab is not being read; skip the work but keep the loop alive.
    if (document.hidden) { schedule(BASE); return; }
    fetch(location.pathname + location.search, opts())
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, "text/html");
        var next = doc.getElementById("app");
        var cur = document.getElementById("app");
        if (next && cur) {
          var x = window.scrollX, y = window.scrollY;
          // innerHTML from a parsed document never executes scripts, and the
          // server already escaped every value it interpolated.
          cur.innerHTML = next.innerHTML;
          window.scrollTo(x, y);
        }
        if (doc.title) document.title = doc.title;
        lastOk = Date.now();
        delay = BASE;
        mark("live");
        ago();
      })
      .catch(function () {
        // Back off instead of hammering a server that is restarting mid-run.
        delay = Math.min(MAX, Math.round(delay * 1.7));
        mark("stale");
      })
      .then(function () { schedule(delay); });
  }

  setInterval(ago, 1000);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) { delay = BASE; schedule(0); }
  });
  schedule(BASE);
})();
`;

// ── document ────────────────────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

export function renderDashboard(state: DashboardState): string {
  const list = normalizeForRender(state.list ?? { version: "0", baseRevision: 0, features: [] });
  const features = list.features ?? [];
  const goals = Array.isArray(list.goals) ? list.goals : [];
  const sprints = Array.isArray(list.sprints) ? list.sprints : [];
  const paused = state.paused === true;
  const gate = state.gate ?? null;

  const progress = computeProgress(list);
  const tasks = flattenTasks(list);
  const counts = countByStatus(tasks);

  // Dependency labels reference the flattened plan position (`← #3`), matching
  // the terminal widget, so the two views can be read side by side.
  const indexByKey = new Map<string, number>();
  for (const t of tasks) {
    indexByKey.set(t.compositeKey, t.index);
    indexByKey.set(t.id, t.index);
    if (t.key) indexByKey.set(t.key, t.index);
  }

  const tasksByFeature = new Map<string, FlatTask[]>();
  for (const t of tasks) {
    const bucket = tasksByFeature.get(t.featureId);
    if (bucket) bucket.push(t);
    else tasksByFeature.set(t.featureId, [t]);
  }

  const sprintNames = new Map<string, string>();
  for (const s of sprints) if (s?.id) sprintNames.set(s.id, s.name ?? s.id);
  const goalNames = new Map<string, string>();
  for (const g of goals) if (g?.id) goalNames.set(g.id, g.title ?? g.id);

  const badges = [readBadge(state.router, "router"), readBadge(state.rework, "rework")].filter(
    (b): b is Badge => b !== null,
  );

  // The plan is five levels deep, and it is drawn five levels deep: goals hold
  // sprints hold features hold tasks hold subtasks. Rendering it flat — which
  // is what this page used to do, with the goal and sprint reduced to two
  // chips on a feature card — throws away the only structure that tells you
  // whether the run is nearly done with something or scattered across
  // everything.
  const groups = groupPlan(list);
  const body = features.length
    ? groups
        .map((group) =>
          renderGoalGroup(group, tasksByFeature, indexByKey, {
            showGoal: goals.length > 0,
            showSprints: sprints.length > 0,
          }),
        )
        .join("")
    : renderEmptyPlan(state.phase);

  const titleBits: string[] = [];
  if (paused) titleBits.push("PAUSED");
  titleBits.push(state.phase ? state.phase.toUpperCase() : "IDLE");
  if (progress.tasksTotal > 0) titleBits.push(`${progress.percent}%`);
  const title = `${titleBits.join(" · ")} · infinity-harness`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<!-- Empty data URI: suppresses the /favicon.ico request the harness server would 404. -->
<link rel="icon" href="data:,">
<title>${esc(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<div id="app">
<div class="page">
${renderMasthead(state.phase, paused, progress.percent, state.baseRevision, badges)}
${renderGoals(goals)}
${renderRail(state.phase, state.enabledPhases, paused)}
${renderAlerts(counts, paused, state.retries, gate, {
  awaitingApproval: state.awaitingApproval ?? null,
  sessions: state.sessions ?? null,
  goalPass: state.goalPass ?? null,
})}
${renderProgress(counts, progress.tasksTotal, progress.featuresDone, progress.featuresTotal)}
${renderGate(gate)}
${body}
<footer class="foot">
  <span>state as of <span class="mono">${esc(formatTimestamp(state.timestamp))}</span></span>
  <span><a href="/api/harness">/api/harness</a> &middot; <a href="/api/health">/api/health</a></span>
</footer>
</div>
</div>
<script>${SCRIPT}</script>
</body>
</html>`;
}
