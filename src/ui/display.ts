/**
 * infinity-harness — display templates: what the surfaces actually draw.
 *
 * The plan has five levels, and shipping all five to everyone was the wrong
 * answer for the same reason shipping two was: two people watching the same
 * run want different things on screen. One works in sprints and never opens a
 * subtask. The next has no sprints at all and lives in the subtask list. A run
 * on a forty-task plan wants the shape; a run on one feature wants the detail.
 *
 * So the levels are a setting, three templates cover the common shapes, and
 * anything else is a template the person builds and names. The terminal widget
 * and the web dashboard read the same one, so what you configure once is what
 * you see in both.
 *
 * Templates live with the *person* — `~/.pi/agent/infinity-harness/` — because
 * how you like to read a plan does not change when you change project.
 */

import type { DisplayPolicy } from "../core/types.ts";
import { userDisplayPath } from "../core/paths.ts";
import { readJsonSafe, writeJsonAtomic, ensureDir } from "../core/fsx.ts";
import { dirname } from "node:path";

export type DisplayTemplate = {
  id: string;
  name: string;
  description: string;
  builtIn: boolean;
  policy: DisplayPolicy;
  savedAt?: string;
};

/** Everything on, at a size a terminal can hold. */
export function defaultDisplay(): DisplayPolicy {
  return {
    preset: "focus",
    levels: { goal: true, sprint: true, feature: true, task: true, subtask: "active" },
    counts: true,
    dependencies: true,
    rail: true,
    progress: true,
    alerts: true,
    criteria: true,
    taskWindow: 9,
  };
}

const focus: DisplayPolicy = defaultDisplay();

const everything: DisplayPolicy = {
  ...defaultDisplay(),
  preset: "everything",
  levels: { goal: true, sprint: true, feature: true, task: true, subtask: "all" },
  taskWindow: 14,
};

/**
 * The shape of the run, without the work.
 *
 * For a plan too big to read: goals and sprints and features with their
 * counts, and no tasks at all. You come here to see which branch is stuck.
 */
const overview: DisplayPolicy = {
  ...defaultDisplay(),
  preset: "overview",
  levels: { goal: true, sprint: true, feature: true, task: false, subtask: "none" },
  dependencies: false,
  criteria: false,
  taskWindow: 12,
};

/**
 * The work, and nothing else.
 *
 * For someone who already knows the plan and wants the next thing to do.
 * No grouping rows, no meters, no rail.
 */
const worklist: DisplayPolicy = {
  ...defaultDisplay(),
  preset: "worklist",
  levels: { goal: false, sprint: false, feature: false, task: true, subtask: "active" },
  counts: false,
  rail: false,
  progress: true,
  alerts: true,
  criteria: false,
  taskWindow: 12,
};

export const BUILTIN_DISPLAYS: DisplayTemplate[] = [
  {
    id: "focus",
    name: "focus",
    description: "The default: every level, with subtasks on the task being worked.",
    builtIn: true,
    policy: focus,
  },
  {
    id: "everything",
    name: "everything",
    description: "All five levels, every subtask on every task, and a taller window.",
    builtIn: true,
    policy: everything,
  },
  {
    id: "overview",
    name: "overview",
    description: "Goals, sprints and features with their counts. No tasks — the shape, not the work.",
    builtIn: true,
    policy: overview,
  },
  {
    id: "worklist",
    name: "worklist",
    description: "Tasks only. No grouping rows, no rail — for when you already know the plan.",
    builtIn: true,
    policy: worklist,
  },
];

export function builtInDisplay(id: string): DisplayTemplate | null {
  return BUILTIN_DISPLAYS.find((d) => d.id === id) ?? null;
}

// ── the saved store ─────────────────────────────────────────────────────────

type SavedStore = { version: string; displays: DisplayTemplate[] };

export function slugify(name: string): string {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function loadSavedDisplays(env?: NodeJS.ProcessEnv): DisplayTemplate[] {
  const store = readJsonSafe<SavedStore | null>(userDisplayPath(env), null);
  const list = Array.isArray(store?.displays) ? store.displays : [];
  return list
    .filter((d): d is DisplayTemplate => typeof d?.id === "string" && typeof d?.name === "string")
    .map((d) => ({ ...d, builtIn: false, policy: normalizeDisplay(d.policy) }));
}

export function listDisplays(env?: NodeJS.ProcessEnv): DisplayTemplate[] {
  return [...BUILTIN_DISPLAYS, ...loadSavedDisplays(env)];
}

export function findDisplay(id: string, env?: NodeJS.ProcessEnv): DisplayTemplate | null {
  return listDisplays(env).find((d) => d.id === id) ?? null;
}

export type SaveResult = { ok: boolean; error: string | null; template?: DisplayTemplate };

export function saveDisplay(
  input: { name: string; description?: string; policy: DisplayPolicy },
  env?: NodeJS.ProcessEnv,
): SaveResult {
  const name = String(input.name ?? "").trim();
  if (!name) return { ok: false, error: "A template needs a name." };
  const id = slugify(name);
  if (!id) return { ok: false, error: `"${name}" has no letters or digits in it.` };
  if (builtInDisplay(id)) {
    return { ok: false, error: `"${name}" is a built-in template. Pick another name.` };
  }

  const policy = { ...normalizeDisplay(input.policy), preset: id };
  const template: DisplayTemplate = {
    id,
    name,
    description: (input.description ?? "").trim() || describeDisplay(policy),
    builtIn: false,
    policy,
    savedAt: new Date().toISOString(),
  };

  const existing = loadSavedDisplays(env).filter((d) => d.id !== id);
  const path = userDisplayPath(env);
  try {
    ensureDir(dirname(path));
    writeJsonAtomic(path, { version: "1", displays: [...existing, template] } satisfies SavedStore);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, error: null, template };
}

export function deleteDisplay(id: string, env?: NodeJS.ProcessEnv): SaveResult {
  if (builtInDisplay(id)) return { ok: false, error: "Built-in templates cannot be deleted." };
  const remaining = loadSavedDisplays(env).filter((d) => d.id !== id);
  const path = userDisplayPath(env);
  try {
    ensureDir(dirname(path));
    writeJsonAtomic(path, { version: "1", displays: remaining } satisfies SavedStore);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, error: null };
}

// ── normalising ─────────────────────────────────────────────────────────────

const SUBTASK_MODES = new Set(["none", "active", "all"]);

/**
 * Repair a policy read from disk.
 *
 * Every field is read on every render, in a lifecycle hook, so a hand-edited
 * config with `levels: "yes"` in it must produce a widget rather than an
 * exception that takes the session down.
 */
export function normalizeDisplay(raw: unknown): DisplayPolicy {
  const base = defaultDisplay();
  if (typeof raw !== "object" || raw === null) return base;
  const r = raw as Partial<DisplayPolicy> & { levels?: Partial<DisplayPolicy["levels"]> };
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

  const window = typeof r.taskWindow === "number" && Number.isFinite(r.taskWindow) ? r.taskWindow : base.taskWindow;

  return {
    preset: typeof r.preset === "string" && r.preset.trim() ? r.preset.trim() : base.preset,
    levels: {
      goal: bool(r.levels?.goal, base.levels.goal),
      sprint: bool(r.levels?.sprint, base.levels.sprint),
      feature: bool(r.levels?.feature, base.levels.feature),
      task: bool(r.levels?.task, base.levels.task),
      subtask: SUBTASK_MODES.has(String(r.levels?.subtask))
        ? (r.levels?.subtask as DisplayPolicy["levels"]["subtask"])
        : base.levels.subtask,
    },
    counts: bool(r.counts, base.counts),
    dependencies: bool(r.dependencies, base.dependencies),
    rail: bool(r.rail, base.rail),
    progress: bool(r.progress, base.progress),
    alerts: bool(r.alerts, base.alerts),
    criteria: bool(r.criteria, base.criteria),
    // A window of zero is a widget with no plan in it, which nobody wants and
    // which a typo can produce.
    taskWindow: Math.max(3, Math.min(60, Math.round(window))),
  };
}

/** Which template a policy currently matches, if any. */
export function matchDisplay(policy: DisplayPolicy, env?: NodeJS.ProcessEnv): DisplayTemplate | null {
  const same = (a: DisplayPolicy, b: DisplayPolicy): boolean =>
    JSON.stringify({ ...normalizeDisplay(a), preset: "" }) ===
    JSON.stringify({ ...normalizeDisplay(b), preset: "" });
  return listDisplays(env).find((d) => same(d.policy, policy)) ?? null;
}

export function describeDisplay(policy: DisplayPolicy): string {
  const p = normalizeDisplay(policy);
  const on = (["goal", "sprint", "feature", "task"] as const).filter((k) => p.levels[k]);
  const subtasks =
    p.levels.subtask === "all" ? "all subtasks" : p.levels.subtask === "active" ? "active subtasks" : null;
  const shown = [...on, ...(subtasks ? [subtasks] : [])];
  return shown.length ? shown.join(" · ") : "nothing — every level is hidden";
}

/** One line for a menu row: `focus · goal · sprint · feature · task · active subtasks`. */
export function summarizeDisplay(policy: DisplayPolicy, env?: NodeJS.ProcessEnv): string {
  const p = normalizeDisplay(policy);
  const named = matchDisplay(p, env);
  const label = named ? named.name : `${p.preset} (edited)`;
  return `${label} · ${describeDisplay(p)}`;
}
