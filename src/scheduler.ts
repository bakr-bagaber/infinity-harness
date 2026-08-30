/**
 * infinity-harness — parallel scheduler.
 *
 * Picks which tasks can run now, respecting deps and the chosen
 * parallel granularity, then spawns isolated workers for them.
 * The main session never edits files; it only polls worker logs.
 */

import type { HarnessConfig, HandoffGranularity, Phase } from "./core/types.ts";
import { loadFeatureList, tasksForPhase, type FlatTask, flattenTasks } from "./core/featureList.ts";
import { loadRouterConfig, resolveModel } from "./modelRouter.ts";
import { spawnIsolatedWorker, type SpawnWorkerResult } from "./worker.ts";
import { runIdFor } from "./runState.ts";
import { loadConfig } from "./core/config.ts";
import { loadRunState } from "./core/runState.ts";
import { isCapExceeded } from "./daemon/budget.ts";

/** Difficulty ranking — higher wins when collapsing a bucket to its hardest. */
const DIFFICULTY_RANK: Record<string, number> = { easy: 1, moderate: 2, difficult: 3 };

function hardestDifficulty(tasks: Array<{ difficulty?: string }>): string | undefined {
  let best: string | undefined;
  let bestRank = -1;
  for (const t of tasks) {
    const d = t.difficulty;
    if (!d) continue;
    const r = DIFFICULTY_RANK[d] ?? -1;
    if (r > bestRank) {
      bestRank = r;
      best = d;
    }
  }
  return best;
}

function goalIdForTask(task: FlatTask, list: import("./core/types.ts").FeatureList): string | null {
  const feat = list.features.find((f) => f.id === task.featureId) as { goalId?: string; sprintId?: string } | undefined;
  if (!feat) return (list.goals?.[0]?.id ?? null) as string | null;
  if (feat.goalId) return feat.goalId;
  if (feat.sprintId) {
    const spr = (list.sprints ?? []).find((s) => s.id === feat.sprintId) as { goalId?: string } | undefined;
    if (spr?.goalId) return spr.goalId;
  }
  return (list.goals?.[0]?.id ?? null) as string | null;
}

/**
 * Effective difficulty for a task given the session handoff granularity.
 *
 * Design choice (Option A): the handoff bucket is the model bucket.
 * Everything finer than the handoff shares the hardest model in that bucket:
 *   - handoff phase  → all tasks in that phase share one model (hardest in phase)
 *   - handoff feature → tasks in feature share hardest in feature
 *   - handoff task   → subtasks share their parent task's model
 */
export function effectiveDifficultyForTask(
  task: FlatTask,
  handoff: HandoffGranularity,
  list: import("./core/types.ts").FeatureList,
): string | undefined {
  const own = (task as { difficulty?: string }).difficulty;
  if (handoff === "task" || handoff === "subtask" || handoff === "off") {
    if (handoff === "off") {
      const globalHardest = hardestDifficulty(flattenTasks(list) as unknown as Array<{ difficulty?: string }>);
      return globalHardest ?? own;
    }
    return own;
  }
  const all = flattenTasks(list);
  let bucket: FlatTask[] = [];
  if (handoff === "phase") {
    const phase = (task as { effectivePhase?: string }).effectivePhase ?? "build";
    bucket = all.filter((t) => (t as { effectivePhase?: string }).effectivePhase === phase);
  } else if (handoff === "feature") {
    bucket = all.filter((t) => t.featureId === task.featureId);
  } else if (handoff === "sprint") {
    const feat = list.features.find((f) => f.id === task.featureId) as { sprintId?: string } | undefined;
    const sid = feat?.sprintId;
    if (!sid) return own;
    bucket = all.filter((t) => {
      const f = list.features.find((ff) => ff.id === t.featureId) as { sprintId?: string } | undefined;
      return f?.sprintId === sid;
    });
  } else if (handoff === "goal") {
    const gid = goalIdForTask(task, list);
    if (!gid) return own;
    bucket = all.filter((t) => goalIdForTask(t, list) === gid);
  } else {
    return own;
  }
  return hardestDifficulty(bucket as unknown as Array<{ difficulty?: string }>) ?? own;
}

export function handoffModelNote(handoff: HandoffGranularity): string {
  switch (handoff) {
    case "off":
    case "goal":
      return "Model per run (off/goal) — the whole run shares its hardest model; finer per-task routing requires task/subtask handoff";
    case "phase":
      return "Model per phase — tasks & subtasks in a phase share the hardest model in that phase";
    case "sprint":
      return "Model per sprint — tasks & subtasks in a sprint share the hardest model in that sprint";
    case "feature":
      return "Model per feature — tasks & subtasks in a feature share the hardest model in that feature";
    case "task":
      return "Model per task — subtasks share their parent task's model";
    case "subtask":
      return "Model per subtask — each subtask may use its own model (needs subtask difficulty)";
    default:
      return "";
  }
}

export type PickOpts = {
  targetDir: string;
  phase?: Phase | null;
  parallelAt?: HandoffGranularity;
  maxWorkers?: number;
  /** Keys already being worked (in_progress) or rework. */
  exclude?: Set<string>;
};

// ── pick helpers ────────────────────────────────────────────────────────────

function isBudgetFull(targetDir: string): boolean {
  try {
    const rs = loadRunState(targetDir);
    if (!rs?.budget) return false;
    return isCapExceeded(rs.budget as never).exceeded;
  } catch {
    return false;
  }
}

function hasSerializeTask(tasks: FlatTask[]): boolean {
  return tasks.some(
    (t) => (t as { serialize?: unknown }).serialize === true && (t.status === "pending" || t.status === "in_progress" || t.status === "rework"),
  );
}

function pickSerializeTask(tasks: FlatTask[], byKey: Map<string, FlatTask>, exclude?: Set<string>): FlatTask | null {
  const serializeTask = tasks.find(
    (t) =>
      (t as { serialize?: unknown }).serialize === true &&
      t.status === "pending" &&
      (t.dependsOn ?? []).every((d) => {
        const dep = byKey.get(d);
        return dep !== undefined && dep.status === "complete";
      }) &&
      !exclude?.has(t.compositeKey) &&
      !exclude?.has(t.id),
  );
  return serializeTask ?? null;
}

function isSerializeBlocked(tasks: FlatTask[]): boolean {
  return tasks.some((t) => (t as { serialize?: unknown }).serialize === true && (t.status === "in_progress" || t.status === "rework"));
}

function eligibleTasks(tasks: FlatTask[], byKey: Map<string, FlatTask>, exclude?: Set<string>): FlatTask[] {
  return tasks.filter((t) => {
    if (t.status !== "pending") return false;
    if (exclude?.has(t.compositeKey) || exclude?.has(t.id)) return false;
    const deps = t.dependsOn ?? [];
    return deps.every((d) => {
      const dep = byKey.get(d);
      return dep !== undefined && dep.status === "complete";
    });
  });
}

function groupKeyFor(task: FlatTask, level: HandoffGranularity, list: import("./core/types.ts").FeatureList): string {
  if (level === "task" || level === "subtask") return task.compositeKey;
  if (level === "feature") return task.featureId;
  if (level === "sprint") {
    const feat = list.features.find((f) => f.id === task.featureId);
    return (feat as { sprintId?: string } | undefined)?.sprintId ?? task.featureId;
  }
  if (level === "phase") return task.effectivePhase ?? "build";
  return task.compositeKey;
}

function roundRobin(groups: Map<string, FlatTask[]>, max: number): FlatTask[] {
  const out: FlatTask[] = [];
  const groupArrays = [...groups.values()];
  let idx = 0;
  while (out.length < max && groupArrays.some((g) => g.length > 0)) {
    const g = groupArrays[idx % groupArrays.length]!;
    if (g.length > 0) out.push(g.shift()!);
    idx++;
    if (idx > max * groupArrays.length + 10) break;
  }
  return out.slice(0, max);
}

export function pickRunnableTasks(opts: PickOpts): FlatTask[] {
  const { list } = loadFeatureList(opts.targetDir);
  const phase = (opts.phase ?? null) as Phase | null;
  const all: FlatTask[] = phase ? tasksForPhase(list, phase) : (flattenTasks(list) as FlatTask[]);
  const byKey = new Map<string, FlatTask>();
  for (const t of all) {
    byKey.set(t.compositeKey, t);
    byKey.set(t.id, t);
    if (t.key) byKey.set(t.key, t);
  }

  if (hasSerializeTask(all)) {
    const serializeTask = pickSerializeTask(all, byKey, opts.exclude);
    if (serializeTask) return [serializeTask];
    if (isSerializeBlocked(all)) return [];
  }

  if (isBudgetFull(opts.targetDir)) return [];

  const eligible = eligibleTasks(all, byKey, opts.exclude);
  const level = opts.parallelAt ?? "off";
  if (level === "off" || level === "goal") return eligible.slice(0, 1);

  const groups = new Map<string, FlatTask[]>();
  for (const t of eligible) {
    const k = groupKeyFor(t, level, list);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(t);
  }
  const max = Math.max(1, Math.min(16, opts.maxWorkers ?? 3));
  return roundRobin(groups, max);
}

export async function spawnWorkers(
  targetDir: string,
  tasks: FlatTask[],
  opts: { runId?: string; promptFor: (t: FlatTask) => string; command?: string } = { promptFor: () => "" },
): Promise<SpawnWorkerResult[]> {
  const runId = opts?.runId ?? runIdFor(targetDir, "sched");
  let handoff: HandoffGranularity = "task";
  try {
    handoff = (loadConfig(targetDir).config.session?.handoff as HandoffGranularity) ?? "task";
  } catch {}
  let allList: import("./core/types.ts").FeatureList | null = null;
  try {
    allList = loadFeatureList(targetDir).list;
  } catch {
    allList = null;
  }
  const results: SpawnWorkerResult[] = [];
  for (const t of tasks) {
    const prompt = opts.promptFor(t);
    const router = loadRouterConfig(targetDir);
    let modelHint: string | undefined;
    if (router.enabled && allList) {
      try {
        const effDiff = effectiveDifficultyForTask(t, handoff, allList);
        modelHint = resolveModel({ projectDir: targetDir, task: { difficulty: effDiff as string | undefined, id: t.id, key: t.compositeKey } });
      } catch {}
    } else if (router.enabled) {
      try {
        modelHint = resolveModel({ projectDir: targetDir, task: { difficulty: (t as { difficulty?: string }).difficulty as string | undefined, id: t.id, key: t.compositeKey } });
      } catch {}
    }
    const res = await spawnIsolatedWorker({
      projectDir: targetDir,
      runId,
      featureId: t.featureId,
      taskId: t.id,
      prompt,
      command: opts.command,
      model: modelHint,
    });
    results.push(res);
  }
  return results;
}

export function executionPolicyOf(config: HarnessConfig): {
  engine: import("./core/types.ts").ExecutionEngine;
  parallelAt: HandoffGranularity;
  maxWorkers: number;
} {
  const e = (config.execution ?? {}) as Partial<{ engine: unknown; parallelAt: unknown; maxWorkers: unknown }>;
  const engine: import("./core/types.ts").ExecutionEngine = e.engine === "main-session" ? "main-session" : "background";
  const at =
    typeof e.parallelAt === "string" && (["off", "goal", "phase", "sprint", "feature", "task", "subtask"] as const).includes(e.parallelAt as HandoffGranularity)
      ? (e.parallelAt as HandoffGranularity)
      : "task";
  const raw = typeof e.maxWorkers === "number" ? e.maxWorkers : 3;
  const maxWorkers = Math.max(1, Math.min(16, Math.floor(raw)));
  return { engine, parallelAt: at, maxWorkers };
}
