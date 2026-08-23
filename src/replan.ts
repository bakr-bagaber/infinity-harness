/**
 * infinity-harness — replan: mid-BUILD plan amendment.
 *
 * `amendPlan` is the additive counterpart to `taskList.writeTaskList`: it adds
 * sprints, features and tasks to the plan of record without asking the caller
 * to resubmit everything, then re-validates the whole dependency graph and
 * bumps `baseRevision`. A `maxReplansPerRun` budget keeps a stuck run from
 * replanning forever, and every amendment is appended to
 * `harness/replan.json`.
 *
 * Plan I/O, sidecar I/O, config reads, paths and locking all come from
 * `core/`. This module used to carry private copies of each, and they had
 * quietly drifted: the private plan loader did a raw `readFileSync` +
 * `JSON.parse`, so it neither normalised status aliases (a stored "done" never
 * compared equal to "complete", which `validateDeps` reads as an unresolved
 * dependency) nor fell back to the `.bak` after a corrupt write, and its saver
 * did a bare tmp+rename with no backup. The private lock helper wrapped
 * `proper-lockfile` on `<path>.lock` while the plan writer takes
 * `<path>.ilock`, so the two never actually excluded each other. One
 * implementation of each now, in `core/`.
 */

import { unlinkSync } from "node:fs";
import type { Feature, FeatureList, Subtask, Task, TaskStatus } from "./core/types.ts";
import { TASK_STATUSES } from "./core/types.ts";
import { detectCycle, flattenTasks, loadFeatureList, saveFeatureList } from "./core/featureList.ts";
import { fileExists, readJsonSafe, writeJsonAtomic } from "./core/fsx.ts";
import { loadConfig } from "./core/config.ts";
import { featureListPath, replanPath } from "./core/paths.ts";
import { withLockSync } from "./core/lock.ts";

/**
 * Repo-relative label for the sidecar, kept for callers that display it.
 * `core/paths.replanPath()` is what actually resolves the file.
 */
export const REPLAN_FILE = "harness/replan.json";

/** @deprecated The plan's location belongs to `core/paths.featureListPath()`. */
export const FEATURE_LIST = "harness/features/feature-list.json";

export const DEFAULT_MAX_REPLANS = 2;

/** One task as submitted to `amendPlan`. Stored fields are shaped by `toStoredTask`. */
export type ReplanTaskInput = {
  id: string;
  key?: string;
  description: string;
  status?: string;
  dependsOn?: string[];
  subtasks?: Array<{ id: string; title: string; status: string }>;
  difficulty?: string;
  modelHint?: string;
  acceptanceCriteria?: string[];
};

export interface AmendPlanOpts {
  projectDir?: string;
  reason?: string;
  addSprints?: Array<{ id: string; name: string; goalId?: string; difficulty?: string }>;
  addFeatures?: Array<{
    id: string;
    name: string;
    description?: string;
    sprintId?: string;
    goalId?: string;
    passes?: boolean;
    tasks?: ReplanTaskInput[];
    difficulty?: string;
  }>;
  addTasks?: Array<{ featureId: string; task: ReplanTaskInput }>;
}

export interface AmendPlanResult {
  baseRevision: number;
  added: { sprints: number; features: number; tasks: number };
}

/** One appended amendment. `harness/replan.json` is an array of these. */
export type ReplanHistoryEntry = {
  timestamp: string;
  reason: string;
  added: AmendPlanResult["added"];
  baseRevision: number;
};

function projectDirOf(p?: string): string {
  return p ?? process.cwd();
}

/** Identity used for dependency resolution: the stable `key` when set, else the id. */
function taskKey(t: Pick<Task, "id" | "key">): string {
  return t.key ?? t.id;
}

/**
 * Load the plan through the core loader.
 *
 * Keeps the "missing file" error this module has always thrown: amending a
 * project that was never planned is a caller mistake, not an empty plan to be
 * seeded.
 */
function loadPlan(projectDir: string): FeatureList {
  const { list, path, existed } = loadFeatureList(projectDir);
  if (!existed) throw new Error("feature-list.json missing: " + path);
  return list;
}

// ── validation ──────────────────────────────────────────────────────────────

/** The vocabulary lives in `core/types`; this only reports it. */
function validateStatus(status: string): void {
  if (!(TASK_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`invalid task status: ${status} (expected ${TASK_STATUSES.join("|")})`);
  }
}

type DepView = { key: string; dependsOn: string[]; status: string };

/**
 * Every dependency resolves, and nothing claims to be started or finished
 * while something it depends on is not complete.
 */
function validateDeps(tasks: DepView[]): void {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  for (const t of tasks) {
    for (const dep of t.dependsOn ?? []) {
      if (!byKey.has(dep)) throw new Error(`dependsOn references missing task ${dep} (from ${t.key})`);
    }
    if (t.status === "in_progress" || t.status === "complete") {
      const unresolved = (t.dependsOn ?? []).filter((d) => byKey.get(d)?.status !== "complete");
      if (unresolved.length > 0) {
        throw new Error(`${t.key} cannot be ${t.status} while dependencies are unresolved: ${unresolved.join(", ")}`);
      }
    }
  }
}

// ── sidecar: harness/replan.json ────────────────────────────────────────────

/** Read the history, tolerating the bare-array, `{ history }` and single-entry shapes. */
function readReplanHistory(projectDir: string): ReplanHistoryEntry[] {
  const raw = readJsonSafe<unknown>(replanPath(projectDir), null);
  if (Array.isArray(raw)) return raw as ReplanHistoryEntry[];
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as { history?: unknown; reason?: unknown };
  if (Array.isArray(obj.history)) return obj.history as ReplanHistoryEntry[];
  return obj.reason ? [raw as ReplanHistoryEntry] : [];
}

/** Append an amendment. Locked, because it is a read-modify-write of the sidecar. */
function appendReplanHistory(projectDir: string, entry: ReplanHistoryEntry): void {
  const path = replanPath(projectDir);
  withLockSync(path, () => {
    const history = readReplanHistory(projectDir);
    history.push(entry);
    writeJsonAtomic(path, history);
  });
}

function readMaxReplans(projectDir: string): number {
  const { config } = loadConfig(projectDir);
  const replan = config.replan as { maxReplans?: unknown; maxReplansPerRun?: unknown } | undefined;
  const budgets = config.budgets as { maxReplansPerRun?: unknown } | undefined;
  if (typeof replan?.maxReplans === "number") return replan.maxReplans;
  if (typeof replan?.maxReplansPerRun === "number") return replan.maxReplansPerRun;
  if (typeof budgets?.maxReplansPerRun === "number") return budgets.maxReplansPerRun;
  return DEFAULT_MAX_REPLANS;
}

// ── the amendment ───────────────────────────────────────────────────────────

/** Shape a submitted task into the stored form. One place, so the two add paths agree. */
function toStoredTask(t: ReplanTaskInput): Task {
  return {
    id: t.id,
    key: t.key,
    description: t.description,
    status: (t.status ?? "pending") as TaskStatus,
    dependsOn: t.dependsOn ?? [],
    subtasks: (t.subtasks ?? []) as Subtask[],
    difficulty: t.difficulty as Task["difficulty"],
    modelHint: t.modelHint,
    acceptanceCriteria: t.acceptanceCriteria ?? [],
  };
}

export async function amendPlan(opts: AmendPlanOpts): Promise<AmendPlanResult> {
  const projectDir = projectDirOf(opts.projectDir);
  const maxReplans = readMaxReplans(projectDir);
  const priorCount = readReplanHistory(projectDir).length;
  if (priorCount >= maxReplans) {
    throw new Error(`maxReplansPerRun exceeded: ${priorCount} >= ${maxReplans}`);
  }

  // Read, amend, validate, bump, write — one atomic section. Adding to the
  // plan is a read-apply-write over the same file every parallel worker edits.
  const result = withLockSync(featureListPath(projectDir), () => {
    const list = loadPlan(projectDir);

    let addedSprints = 0;
    let addedFeatures = 0;
    let addedTasks = 0;

    // `sprints` is optional on the type; loadFeatureList always normalises it
    // to an array, so bind it once rather than asserting at each use.
    const sprints = (list.sprints ??= []);
    for (const s of opts.addSprints ?? []) {
      if (!s.id || !s.name) throw new Error("sprint requires id and name");
      if (sprints.some((x) => x.id === s.id)) throw new Error(`duplicate sprint id: ${s.id}`);
      sprints.push({
        id: s.id,
        name: s.name,
        ...(s.goalId ? { goalId: s.goalId } : {}),
        ...(s.difficulty ? { difficulty: s.difficulty } : {}),
      });
      addedSprints++;
    }

    for (const f of opts.addFeatures ?? []) {
      if (!f.id || !f.name) throw new Error("feature requires id and name");
      if (list.features.some((x) => x.id === f.id)) throw new Error(`duplicate feature id: ${f.id}`);
      const feature: Feature = {
        id: f.id,
        name: f.name,
        description: f.description ?? "",
        passes: f.passes ?? false,
        sprintId: f.sprintId,
        goalId: f.goalId,
        difficulty: f.difficulty,
        tasks: (f.tasks ?? []).map(toStoredTask),
      };
      list.features.push(feature);
      addedFeatures++;
    }

    for (const at of opts.addTasks ?? []) {
      const feature = list.features.find((x) => x.id === at.featureId);
      if (!feature) throw new Error(`feature not found for addTasks: ${at.featureId}`);
      const t = at.task;
      if (!t.id || !t.description) throw new Error("task requires id and description");
      const key = taskKey(t);
      // Keys are the currency of `dependsOn`, so they are unique plan-wide;
      // ids only have to be unique inside their feature.
      const globalKeys = new Set(flattenTasks(list).map(taskKey));
      if (globalKeys.has(key)) throw new Error(`duplicate task key: ${key}`);
      if ((feature.tasks ?? []).some((x) => x.id === t.id)) {
        throw new Error(`duplicate task id in feature ${at.featureId}: ${t.id}`);
      }
      if (t.status) validateStatus(t.status);
      feature.tasks = feature.tasks ?? [];
      feature.tasks.push(toStoredTask(t));
      addedTasks++;
    }

    // Re-validate the whole graph, not just what was added: an amendment can
    // satisfy or break a dependency anywhere in the plan.
    const all = flattenTasks(list);
    const depView: DepView[] = all.map((t) => ({
      key: taskKey(t),
      dependsOn: t.dependsOn ?? [],
      status: t.status ?? "pending",
    }));
    validateDeps(depView);
    detectCycle(depView.map((t) => ({ compositeKey: t.key, dependsOn: t.dependsOn })));

    const hasChange = addedSprints > 0 || addedFeatures > 0 || addedTasks > 0;
    if (hasChange) list.baseRevision += 1;

    saveFeatureList(projectDir, list);
    return {
      baseRevision: list.baseRevision,
      added: { sprints: addedSprints, features: addedFeatures, tasks: addedTasks },
    };
  });

  appendReplanHistory(projectDir, {
    timestamp: new Date().toISOString(),
    reason: opts.reason ?? "amendPlan",
    added: result.added,
    baseRevision: result.baseRevision,
  });

  return result;
}

export function loadReplanHistory(projectDir?: string): ReplanHistoryEntry[] {
  return readReplanHistory(projectDirOf(projectDir));
}

export async function clearReplanHistory(projectDir?: string): Promise<void> {
  const path = replanPath(projectDirOf(projectDir));
  withLockSync(path, () => {
    if (!fileExists(path)) return;
    try {
      unlinkSync(path);
    } catch {
      /* already gone — the point is that it is not there afterwards */
    }
  });
}
