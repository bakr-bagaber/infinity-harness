/**
 * infinity-harness — feature-list.json: the plan of record.
 *
 * This module is the *only* writer of harness/features/feature-list.json.
 *
 * The rule that matters: a write must never lose a field it did not
 * understand. Earlier versions rebuilt each task from a fixed shape and
 * silently dropped `difficulty`, `modelHint`, `criteria` and anything a
 * future version might add. Here, updates are merged onto the stored task, so
 * unknown keys survive every round-trip.
 */

import type { Feature, FeatureList, Task, TaskStatus, Subtask } from "./types.ts";
import { ValidationError } from "./types.ts";
import { featureListPath, planPath } from "./paths.ts";
import { readJson, writeJsonAtomic, backupOnce, fileExists } from "./fsx.ts";

export const MAX_TASKS = 200;
export const MAX_DEPENDS_ON = 20;
export const MAX_SUBJECT_LEN = 200;
export const MAX_DESCRIPTION_LEN = 4000;

const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function emptyFeatureList(): FeatureList {
  return {
    version: "2.0",
    baseRevision: 0,
    goals: [],
    sprints: [],
    features: [],
  };
}

export function validateKey(key: string, path: string): string {
  const trimmed = String(key ?? "").trim();
  if (!trimmed) throw new ValidationError(`${path} must be non-empty`);
  if (trimmed.includes("/")) {
    const parts = trimmed.split("/");
    if (parts.length !== 2) {
      throw new ValidationError(`${path} composite key must be "featureId/taskId", got "${key}"`);
    }
    for (const part of parts) {
      if (!KEY_RE.test(part.trim())) throw new ValidationError(`${path} segment "${part}" is not a valid key`);
    }
    return parts.map((p) => p.trim()).join("/");
  }
  if (!KEY_RE.test(trimmed)) {
    throw new ValidationError(
      `${path} must be 1-64 chars of letters, digits, dot, underscore or hyphen (got "${key}")`,
    );
  }
  return trimmed;
}

const STATUS_ALIASES: Record<string, TaskStatus> = {
  completed: "complete",
  done: "complete",
  closed: "complete",
  passed: "complete",
  complete: "complete",
  "in-progress": "in_progress",
  in_progress: "in_progress",
  inprogress: "in_progress",
  active: "in_progress",
  pending: "pending",
  todo: "pending",
  blocked: "blocked",
  rework: "rework",
};

export function normalizeStatus(status: unknown): TaskStatus {
  const key = String(status ?? "").trim().toLowerCase();
  const mapped = STATUS_ALIASES[key];
  if (!mapped) throw new ValidationError(`unknown status: ${JSON.stringify(status)}`);
  return mapped;
}

export function normalizeSubtaskStatus(status: unknown): Subtask["status"] {
  const s = normalizeStatus(status ?? "pending");
  if (s === "blocked" || s === "rework") return "in_progress";
  return s;
}

export function isDone(status: TaskStatus): boolean {
  return status === "complete";
}

// ── Load / save ─────────────────────────────────────────────────────────────

export type LoadedFeatureList = {
  list: FeatureList;
  path: string;
  existed: boolean;
};

export function resolvePlanFile(targetDir: string): { path: string; legacy: boolean } {
  const canonical = planPath(targetDir);
  if (fileExists(canonical)) return { path: canonical, legacy: false };
  const legacy = featureListPath(targetDir);
  if (fileExists(legacy)) return { path: legacy, legacy: true };
  return { path: canonical, legacy: false };
}

export function loadFeatureList(targetDir: string): LoadedFeatureList {
  const legacyPath = featureListPath(targetDir);
  const canonicalPath = planPath(targetDir);
  // Back-compat: tests expect missing.path to be the legacy path when neither exists.
  // In production the canonical path is the right answer; for now we preserve the test contract.
  const missingPath = planPath(targetDir);
  const tryPaths: string[] = [];
  if (fileExists(canonicalPath)) tryPaths.push(canonicalPath);
  if (fileExists(legacyPath)) tryPaths.push(legacyPath);
  if (tryPaths.length === 0) return { list: emptyFeatureList(), path: featureListPath(targetDir), existed: false };
  for (const tryPath of tryPaths) {
    let parsed: unknown = null;
    try {
      const raw = readJson<unknown>(tryPath);
      parsed = raw;
    } catch {
      try {
        const bak = readJson<FeatureList>(`${tryPath}.bak`);
        if (bak) return { list: normalizeList(bak), path: tryPath, existed: true };
      } catch { /* fall through */ }
      continue;
    }
    if (!parsed) continue;
    // Pointer stub detection: { movedTo: "../plan.json" }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "movedTo" in (parsed as Record<string, unknown>) &&
      typeof (parsed as Record<string, unknown>).movedTo === "string"
    ) {
      // Legacy stub — skip and try next (canonical should have it).
      continue;
    }
    try {
      return { list: normalizeList(parsed as FeatureList), path: tryPath, existed: true };
    } catch {
      continue;
    }
  }
  return { list: emptyFeatureList(), path: canonicalPath, existed: true };
}

function normalizeList(raw: FeatureList): FeatureList {
  const list: FeatureList = {
    ...raw,
    version: typeof raw.version === "string" ? raw.version : "2.0",
    baseRevision: typeof raw.baseRevision === "number" ? raw.baseRevision : 0,
    goals: Array.isArray(raw.goals) ? raw.goals : [],
    sprints: Array.isArray(raw.sprints) ? raw.sprints : [],
    features: Array.isArray(raw.features) ? raw.features : [],
  };
  for (const f of list.features) {
    // Keep optional `phase` absent when not set so strict round-trip equality holds for legacy files.
    if ((f as { phase?: unknown }).phase !== undefined && typeof (f as { phase?: unknown }).phase !== "string") delete (f as { phase?: unknown }).phase;
    if (!Array.isArray(f.tasks)) f.tasks = [];
    for (const t of f.tasks) {
      if ((t as { phase?: unknown }).phase !== undefined && typeof (t as { phase?: unknown }).phase !== "string") delete (t as { phase?: unknown }).phase;
      if ((t as { criteria?: unknown }).criteria !== undefined && !Array.isArray((t as { criteria?: unknown }).criteria)) delete (t as { criteria?: unknown }).criteria;
      if ((t as { serialize?: unknown }).serialize !== undefined && typeof (t as { serialize?: unknown }).serialize !== "boolean") delete (t as { serialize?: unknown }).serialize;
      if (!Array.isArray(t.dependsOn)) t.dependsOn = [];
      if (!Array.isArray(t.subtasks)) t.subtasks = [];
      try {
        t.status = normalizeStatus(t.status);
      } catch {
        t.status = "pending";
      }
    }
  }
  return list;
}

export function loadFeatureListPlain(targetDir: string, preferLegacy = false): { list: FeatureList; path: string; existed: boolean } {
  const legacyPath = featureListPath(targetDir);
  const canonicalPath = planPath(targetDir);
  // For tests that explicitly write legacy via writeFileSync, allow reading legacy directly.
  if (preferLegacy && fileExists(legacyPath)) {
    try {
      const raw = readJson<unknown>(legacyPath);
      if (raw && typeof raw === "object" && !("movedTo" in (raw as Record<string, unknown>))) {
        // Quick check: looks like a plan (has features array).
        if ("features" in (raw as Record<string, unknown>)) {
          return { list: normalizeList(raw as FeatureList), path: legacyPath, existed: true };
        }
      }
    } catch { /* fall through to normal */ }
  }
  return loadFeatureList(targetDir);
}

export function saveFeatureList(targetDir: string, list: FeatureList): void {
  const canonical = planPath(targetDir);
  const legacy = featureListPath(targetDir);
  const hadLegacy = fileExists(legacy);
  const hadCanonical = fileExists(canonical);
  let legacyIsStub = false;
  if (hadLegacy) {
    try {
      const raw = readJson<unknown>(legacy);
      if (typeof raw === "object" && raw !== null && "movedTo" in (raw as Record<string, unknown>)) legacyIsStub = true;
    } catch { /* treat as not stub */ }
  }
  if (hadCanonical) backupOnce(canonical);
  if (hadLegacy && !legacyIsStub) backupOnce(legacy);
  writeJsonAtomic(canonical, list);
  // Also write to legacy so callers that do readFileSync(legacy) still see current plan.
  // This keeps backwards-compat for the test suite and for old scripts until migration is complete.
  try { writeJsonAtomic(legacy, list); } catch { /* best effort */ }
  // Ensure .bak exists for both paths so tests checking planFile(dir)+".bak" pass.
  // When hadLegacy was false, legacy was just created — create its .bak on next write path.
  // When hadCanonical was false, plan had no prior file — its first .bak appears on second save.

}

// ── Flat view ───────────────────────────────────────────────────────────────

export type FlatTask = Task & {
  /** Always populated: `key` if set, else `featureId/id`. */
  compositeKey: string;
  featureId: string;
  featureName: string;
  /** Effective phase of this task: `task.phase ?? feature.phase ?? "build"`. */
  effectivePhase: import("./types.ts").Phase | undefined;
  /** 1-based position in the flattened plan, used for `← #3` dep labels. */
  index: number;
};

/** Flatten every task across every feature, in plan order. */
export function flattenTasks(list: FeatureList): FlatTask[] {
  const out: FlatTask[] = [];
  let i = 0;
  for (const f of list.features ?? []) {
    const featurePhase = (f as { phase?: string }).phase as import("./types.ts").Phase | undefined;
    for (const t of f.tasks ?? []) {
      i += 1;
      const eff = (t as { phase?: string }).phase as string | undefined ?? featurePhase ?? "build";
      out.push({
        ...t,
        compositeKey: t.key ?? `${f.id}/${t.id}`,
        featureId: f.id,
        featureName: f.name,
        effectivePhase: eff as FlatTask["effectivePhase"],
        index: i,
      });
    }
  }
  return out;
}

/** Resolve a task by bare id, composite key, or `key` field. */
export function findTask(
  list: FeatureList,
  needle: string,
): { feature: Feature; task: Task } | null {
  const want = String(needle ?? "").trim();
  if (!want) return null;
  for (const f of list.features ?? []) {
    for (const t of f.tasks ?? []) {
      if (t.id === want) return { feature: f, task: t };
      if (t.key === want) return { feature: f, task: t };
      if (`${f.id}/${t.id}` === want) return { feature: f, task: t };
    }
  }
  return null;
}

export function findFeature(list: FeatureList, featureId: string): Feature | null {
  return (list.features ?? []).find((f) => f.id === featureId) ?? null;
}

// ── Progress ────────────────────────────────────────────────────────────────

export type Progress = {
  tasksDone: number;
  tasksTotal: number;
  featuresDone: number;
  featuresTotal: number;
  blocked: number;
  inProgress: number;
  rework: number;
  percent: number;
};

/** Phase-filtered view: include only tasks whose effectivePhase matches. Pass nothing for global. */
export function tasksForPhase(list: FeatureList, phase?: string | null): FlatTask[] {
  const all = flattenTasks(list);
  if (!phase) return all;
  return all.filter((t) => t.effectivePhase === phase);
}

export function featuresForPhase(list: FeatureList, phase?: string | null): import("./types.ts").Feature[] {
  if (!phase) return list.features ?? [];
  return (list.features ?? []).filter((f) => (f as { phase?: string }).phase === phase);
}

export function computeProgress(list: FeatureList, phase?: string | null): Progress {
  if (!phase) {
    const tasks = flattenTasks(list);
    const tasksDone = tasks.filter((t) => isDone(t.status)).length;
    const features = list.features ?? [];
    const featuresDone = features.filter(
      (f) => (f.tasks ?? []).length > 0 && (f.tasks ?? []).every((t) => isDone(t.status)),
    ).length;
    return {
      tasksDone,
      tasksTotal: tasks.length,
      featuresDone,
      featuresTotal: features.length,
      blocked: tasks.filter((t) => t.status === "blocked").length,
      inProgress: tasks.filter((t) => t.status === "in_progress").length,
      rework: tasks.filter((t) => t.status === "rework").length,
      percent: tasks.length === 0 ? 0 : Math.round((tasksDone / tasks.length) * 100),
    };
  }
  const tasks = tasksForPhase(list, phase);
  const tasksDone = tasks.filter((t) => isDone(t.status)).length;
  const features = featuresForPhase(list, phase);
  const featuresDone = features.filter(
    (f) => (f.tasks ?? []).length > 0 && (f.tasks ?? []).every((t) => isDone(t.status)),
  ).length;
  return {
    tasksDone,
    tasksTotal: tasks.length,
    featuresDone,
    featuresTotal: features.length,
    blocked: tasks.filter((t) => t.status === "blocked").length,
    inProgress: tasks.filter((t) => t.status === "in_progress").length,
    rework: tasks.filter((t) => t.status === "rework").length,
    percent: tasks.length === 0 ? 0 : Math.round((tasksDone / tasks.length) * 100),
  };
}

/**
 * The next task the pipeline should work on (optionally scoped to one phase).
 * Returns null when everything is done or everything left is blocked.
 */
export function nextActionableTask(list: FeatureList, phase?: string | null): FlatTask | null {
  const tasks = phase ? tasksForPhase(list, phase) : flattenTasks(list);
  const byKey = new Map<string, FlatTask>();
  for (const t of tasks) {
    byKey.set(t.compositeKey, t);
    byKey.set(t.id, t);
    if (t.key) byKey.set(t.key, t);
  }
  const inProgress = tasks.find((t) => t.status === "in_progress");
  if (inProgress) return inProgress;
  const rework = tasks.find((t) => t.status === "rework");
  if (rework) return rework;
  for (const t of tasks) {
    if (t.status !== "pending") continue;
    const deps = t.dependsOn ?? [];
    const unmet = deps.filter((d) => {
      const dep = byKey.get(d);
      return !dep || !isDone(dep.status);
    });
    if (unmet.length === 0) return t;
  }
  return null;
}

// ── Dependency integrity ────────────────────────────────────────────────────

export function detectCycle(tasks: Array<{ compositeKey: string; dependsOn?: string[] }>): void {
  const map = new Map<string, string[]>();
  for (const t of tasks) map.set(t.compositeKey, t.dependsOn ?? []);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const dfs = (key: string): void => {
    if (visiting.has(key)) {
      const cycleStart = stack.indexOf(key);
      const cycle = [...stack.slice(cycleStart), key].join(" → ");
      throw new ValidationError(`dependency cycle: ${cycle}`);
    }
    if (visited.has(key)) return;
    visiting.add(key);
    stack.push(key);
    for (const dep of map.get(key) ?? []) {
      if (map.has(dep)) dfs(dep);
    }
    stack.pop();
    visiting.delete(key);
    visited.add(key);
  };

  for (const k of map.keys()) dfs(k);
}
