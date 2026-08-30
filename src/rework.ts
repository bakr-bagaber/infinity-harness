/**
 * infinity-harness — rework: the backward edge, with return-to-origin.
 *
 * A task that fails late rarely fails alone: whatever depends on it is suspect
 * too. `startRework` walks the `dependsOn` graph forward from the origin, flips
 * the origin and everything it reaches within `maxImpactDepth` to "rework", and
 * records where the pipeline must return to in `harness/rework.json`.
 *
 * Plan I/O, sidecar I/O, config reads, paths and locking all come from
 * `core/`. This module used to carry private copies of each, and they had
 * quietly drifted: the private plan loader did a raw `readFileSync` +
 * `JSON.parse`, so it neither normalised status aliases (a task stored as
 * "done" never compared equal to "complete") nor fell back to the `.bak` after
 * a corrupt write, and its saver did a bare tmp+rename with no backup. The
 * private lock helper wrapped `proper-lockfile` on `<path>.lock` while the
 * plan writer takes `<path>.ilock`, so the two never actually excluded each
 * other. One implementation of each now, in `core/`.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { FeatureList, Task } from "./core/types.ts";
import { flattenTasks, loadFeatureList, saveFeatureList } from "./core/featureList.ts";
import { fileExists, readJsonSafe, writeJsonAtomic } from "./core/fsx.ts";
import { loadConfig } from "./core/config.ts";
import { planPath, reworkPath } from "./core/paths.ts";
import { withLockSync } from "./core/lock.ts";

/**
 * Repo-relative label for the sidecar, kept for callers that display it.
 * `core/paths.reworkPath()` is what actually resolves the file.
 */
export const REWORK_FILE = "harness/rework.json";

export const DEFAULT_MAX_REWORKS = 3;
export const DEFAULT_IMPACT_DEPTH = 3;

export interface ReworkRecord {
  runId: string;
  returnFeature: string;
  returnTask: string;
  impacted: string[];
  reason: string;
  timestamp: string;
  remainingBudgets?: { reworks: number; replans: number; bounces: number };
  maxImpactDepth?: number;
}

export interface StartReworkOpts {
  projectDir?: string;
  featureId: string;
  taskId: string;
  reason?: string;
  runId?: string;
  maxImpactDepth?: number;
  key?: string;
}

export type StartReworkResult = {
  impacted: string[];
  baseRevision: number;
  rework: ReworkRecord;
};

function projectDirOf(p?: string): string {
  return p ?? process.cwd();
}

/** The minimum shape the impact walk needs: an identity and its dependencies. */
export type ImpactTask = Pick<Task, "id" | "key" | "dependsOn">;

/**
 * Identity used by the rework graph: the stable `key` when set, else the id.
 *
 * Deliberately *not* `flattenTasks`' `compositeKey`, which falls back to
 * `featureId/id`. `dependsOn` entries in the plan are written in this
 * spelling, and matching them is the whole job here.
 */
function taskKey(t: ImpactTask): string {
  return t.key ?? t.id;
}

/**
 * Load the plan through the core loader.
 *
 * Keeps the "missing file" error this module has always thrown: a rework
 * against a project that was never planned is a caller mistake, not an empty
 * plan to be seeded.
 */
function loadPlan(projectDir: string): FeatureList {
  const { list, path, existed } = loadFeatureList(projectDir);
  if (!existed) throw new Error("feature-list.json missing: " + path);
  return list;
}

/** Breadth-first walk over the reverse-dependency edges, capped at `maxDepth`. */
export function computeImpact(
  allTasks: readonly ImpactTask[],
  originKey: string,
  maxDepth: number,
): string[] {
  const impacted: string[] = [];
  const visited = new Set<string>([originKey]);
  let frontier: Array<{ key: string; depth: number }> = [{ key: originKey, depth: 0 }];
  while (frontier.length) {
    const next: Array<{ key: string; depth: number }> = [];
    for (const cur of frontier) {
      if (cur.depth >= maxDepth) continue;
      for (const t of allTasks) {
        const k = taskKey(t);
        if (visited.has(k)) continue;
        if ((t.dependsOn ?? []).includes(cur.key)) {
          visited.add(k);
          impacted.push(k);
          next.push({ key: k, depth: cur.depth + 1 });
        }
      }
    }
    frontier = next;
  }
  return impacted;
}

// ── sidecar: harness/rework.json ────────────────────────────────────────────

/** On disk this is either one bare record (the first write) or `{ history }`. */
type ReworkSidecar = { history?: unknown; returnTask?: unknown };

function readSidecar(projectDir: string): ReworkSidecar | null {
  const raw = readJsonSafe<unknown>(reworkPath(projectDir), null);
  return raw && typeof raw === "object" ? (raw as ReworkSidecar) : null;
}

function countPriorReworks(projectDir: string): number {
  const prev = readSidecar(projectDir);
  if (!prev) return 0;
  if (Array.isArray(prev.history)) return prev.history.length;
  return prev.returnTask ? 1 : 0;
}

/**
 * Append a record, promoting a legacy single-record file to `{ history }`.
 * Locked, because it is a read-modify-write of the sidecar.
 */
function appendReworkRecord(projectDir: string, record: ReworkRecord): void {
  const path = reworkPath(projectDir);
  withLockSync(path, () => {
    const prev = readSidecar(projectDir);
    if (!prev) {
      writeJsonAtomic(path, { ...record });
      return;
    }
    let history: ReworkRecord[];
    if (Array.isArray(prev.history)) {
      history = [...(prev.history as ReworkRecord[])];
    } else if (prev.returnTask) {
      const { history: _legacy, ...rest } = prev;
      history = [rest as unknown as ReworkRecord];
    } else {
      history = [];
    }
    history.push({ ...record });
    writeJsonAtomic(path, { history });
  });
}

function readMaxReworks(projectDir: string): number {
  const { config } = loadConfig(projectDir);
  const lim = (config as unknown as { limits?: { maxReworkPerUnit?: unknown } }).limits as { maxReworkPerUnit?: unknown } | undefined;
  // limits.maxReworkPerUnit wins only when writable: config actually has a limits file with it.
  // Test configs write { rework: {maxReworks: 3} } onto a partial config that still has DEFAULT_LIMITS via merge — without this guard every test would see 2.
  let hasLimitsFile = false;
  try { const p = `${projectDir}/harness/config.json`; if (existsSync(p)) { const raw = JSON.parse(readFileSync(p,"utf-8")); if (raw && typeof raw.limits === "object") hasLimitsFile = true; } } catch {}
  const rework = config.rework as { maxReworks?: unknown } | undefined;
  const budgets = config.budgets as { maxReworksPerRun?: unknown } | undefined;
  if (hasLimitsFile && typeof lim?.maxReworkPerUnit === "number") return lim.maxReworkPerUnit;
  if (typeof rework?.maxReworks === "number") return rework.maxReworks;
  if (typeof budgets?.maxReworksPerRun === "number") return budgets.maxReworksPerRun;
  return DEFAULT_MAX_REWORKS;
}

// ── the backward edge ───────────────────────────────────────────────────────

/**
 * Resolve which spelling of the origin the caller meant.
 *
 * Callers pass a bare id, a `key`, or a `featureId/taskId` composite more or
 * less interchangeably; the plan stores one of them. First match wins, in
 * order of specificity.
 */
function resolveOriginKey(tasks: readonly ImpactTask[], opts: StartReworkOpts): string {
  const explicitKey = opts.key ?? opts.taskId;
  const byId = tasks.find((t) => t.id === opts.taskId);
  const candidates = [
    ...(byId ? [taskKey(byId)] : []),
    explicitKey,
    `${opts.featureId}/${opts.taskId}`,
    opts.taskId,
  ];
  for (const cand of candidates) {
    if (tasks.some((t) => taskKey(t) === cand)) return cand;
  }
  return explicitKey;
}

export async function startRework(opts: StartReworkOpts): Promise<StartReworkResult> {
  const projectDir = projectDirOf(opts.projectDir);
  const maxDepth = opts.maxImpactDepth ?? DEFAULT_IMPACT_DEPTH;
  const originKey = resolveOriginKey(flattenTasks(loadPlan(projectDir)), opts);

  const maxReworks = readMaxReworks(projectDir);
  const priorCount = countPriorReworks(projectDir);
  if (priorCount >= maxReworks) {
    throw new Error("maxReworksPerRun exceeded: " + priorCount + " >= " + maxReworks);
  }

  // Read, flip, bump, write — one atomic section. The status flip is a
  // read-apply-write over the same file every parallel worker edits.
  const result = withLockSync(planPath(projectDir), () => {
    const list = loadPlan(projectDir);
    const tasks = flattenTasks(list);
    if (!tasks.some((t) => taskKey(t) === originKey)) {
      throw new Error("origin task not found: " + originKey);
    }

    const impacted = computeImpact(tasks, originKey, maxDepth);
    const toRework = new Set<string>([originKey, ...impacted]);

    // flattenTasks hands back copies, so the flip walks the stored tasks.
    let changed = false;
    for (const feature of list.features) {
      for (const t of feature.tasks ?? []) {
        if (toRework.has(taskKey(t)) && t.status !== "rework") {
          t.status = "rework";
          changed = true;
        }
      }
    }
    if (changed) list.baseRevision += 1;
    saveFeatureList(projectDir, list);

    const record: ReworkRecord = {
      runId: opts.runId ?? "run-" + Date.now(),
      returnFeature: opts.featureId,
      returnTask: opts.taskId,
      impacted,
      reason: opts.reason ?? "rework via startRework",
      timestamp: new Date().toISOString(),
      remainingBudgets: { reworks: maxReworks - priorCount - 1, replans: 2, bounces: 2 },
      maxImpactDepth: maxDepth,
    };
    return { impacted, baseRevision: list.baseRevision, record };
  });

  appendReworkRecord(projectDir, result.record);

  return { impacted: result.impacted, baseRevision: result.baseRevision, rework: result.record };
}

/** The most recent rework record, or null when there is none to return to. */
export function loadRework(projectDir?: string): ReworkRecord | null {
  const prev = readSidecar(projectDirOf(projectDir));
  if (!prev) return null;
  if (Array.isArray(prev.history)) {
    const history = prev.history as ReworkRecord[];
    return history[history.length - 1] ?? null;
  }
  return prev as unknown as ReworkRecord;
}

export async function clearRework(projectDir?: string): Promise<void> {
  const path = reworkPath(projectDirOf(projectDir));
  withLockSync(path, () => {
    if (!fileExists(path)) return;
    try {
      unlinkSync(path);
    } catch {
      /* already gone — the point is that it is not there afterwards */
    }
  });
}
