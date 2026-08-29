/**
 * infinity-harness — parallel scheduler.
 *
 * Picks which tasks can run now, respecting deps and the chosen
 * parallel granularity, then spawns isolated workers for them.
 * The main session never edits files; it only polls worker logs.
 */

import type { HarnessConfig, HandoffGranularity, Phase } from "./core/types.ts";
import { loadFeatureList, tasksForPhase, type FlatTask, flattenTasks } from "./core/featureList.ts";
import { loadRouterConfig } from "./modelRouter.ts";
import { spawnIsolatedWorker, type SpawnWorkerResult } from "./worker.ts";
import { runIdFor } from "./runState.ts";
import { loadConfig } from "./core/config.ts";

/** Difficulty ranking — higher wins when collapsing a bucket to its hardest. */
const DIFFICULTY_RANK: Record<string, number> = { easy: 1, moderate: 2, difficult: 3 };

function hardestDifficulty(tasks: Array<{ difficulty?: string }>): string | undefined {
  let best: string | undefined;
  let bestRank = -1;
  for (const t of tasks) {
    const d = (t as { difficulty?: string }).difficulty;
    if (!d) continue;
    const r = DIFFICULTY_RANK[d] ?? -1;
    if (r > bestRank) { bestRank = r; best = d; }
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
 * Shown in wizard + dashboard so the user knows the trade-off.
 */
export function effectiveDifficultyForTask(
  task: FlatTask,
  handoff: HandoffGranularity,
  list: import("./core/types.ts").FeatureList,
): string | undefined {
  const own = (task as { difficulty?: string }).difficulty;
  if (handoff === "task" || handoff === "subtask" || handoff === "off") {
    // task/subtask: subtasks are not separate tasks, so they inherit the task
    // off: one session for whole run — hardest in whole plan (most conservative)
    if (handoff === "off") {
      const globalHardest = hardestDifficulty(flattenTasks(list) as unknown as Array<{ difficulty?: string }>);
      return globalHardest ?? own;
    }
    return own;
  }
  let bucket: FlatTask[] = [];
  const all = flattenTasks(list);
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

/** Snapshot a worker's attempt dir for the widget/dashboard. */
export type WorkerSnapshot = {
  featureId: string;
  taskId: string;
  compositeKey: string;
  attemptDir: string;
  attempt: number;
  state: "running" | "done" | "failed";
  outputTail: string;
  askedAt?: string;
};

/** Tail a worker attempt's output.log (best-effort, never throws). */
export function tailWorkerOutput(attemptDir: string, bytes = 3000): string {
  try {
    const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
    const p = (require("node:path") as typeof import("node:path")).join(attemptDir, "output.log");
    if (!existsSync(p)) return "";
    const raw = readFileSync(p, "utf-8") as string;
    return raw.slice(-bytes);
  } catch { return ""; }
}

export function listWorkers(targetDir: string, runId?: string): WorkerSnapshot[] {
  try {
    const { readdirSync, existsSync } = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const root = path.resolve(targetDir, "tmp/infinity-harness", runId ?? "");
    const roots: string[] = [];
    if (runId) {
      roots.push(path.resolve(targetDir, "tmp/infinity-harness", runId));
    } else {
      // all runs under tmp/infinity-harness
      const base = path.resolve(targetDir, "tmp/infinity-harness");
      if (existsSync(base)) for (const e of readdirSync(base,{ withFileTypes: true } as any)) if((e as any).isDirectory()) roots.push(path.join(base,(e as any).name));
    }
    const out: WorkerSnapshot[] = [];
    for (const run of roots) {
      if (!existsSync(run)) continue;
      // run/feature/task/attempt-N as created by worker.ts
      for (const f of readdirSync(run,{withFileTypes:true} as any) as any[]) {
        if(!f.isDirectory()) continue;
        const feat = path.join(run, f.name);
        for (const t of readdirSync(feat,{withFileTypes:true} as any) as any[]) {
          if(!t.isDirectory()) continue;
          const taskRoot = path.join(feat, t.name);
          const attempts = readdirSync(taskRoot,{withFileTypes:true} as any) as any[];
          for (const a of attempts) {
            if(!a.isDirectory() || !a.name.startsWith("attempt-")) continue;
            const attemptDir = path.join(taskRoot, a.name);
            const n = Number.parseInt(a.name.replace("attempt-",""),10) || 0;
            const tail = tailWorkerOutput(attemptDir, 800);
            out.push({
              featureId: f.name,
              taskId: t.name,
              compositeKey: `${f.name}/${t.name}`,
              attemptDir,
              attempt: n,
              state: "running",
              outputTail: tail,
            });
          }
        }
      }
    }
    return out;
  } catch { return []; }
}

export function nextModelForTask(targetDir: string, difficulty?: string, taskId?: string, key?: string): { model?: string; thinking?: string } {
  try {
    const { resolveModel, resolveThinking } = require("./modelRouter.ts") as typeof import("./modelRouter.ts");
    return {
      model: resolveModel({ projectDir: targetDir, task: { difficulty: difficulty as any, id: taskId, key } }),
      thinking: resolveThinking({ projectDir: targetDir, task: { difficulty: difficulty as any, id: taskId, key } }),
    };
  } catch { return {}; }
}

export function pickRunnableTasks(opts: PickOpts): FlatTask[] {
  const { list } = loadFeatureList(opts.targetDir);
  const phase = (opts.phase ?? null) as Phase | null;
  const all: FlatTask[] = phase ? tasksForPhase(list, phase) : (flattenTasks(list) as FlatTask[]); // imported above
  const byKey = new Map<string, FlatTask>();
  for (const t of all) {
    byKey.set(t.compositeKey, t);
    byKey.set(t.id, t);
    if (t.key) byKey.set(t.key, t);
  }
  const hasSerialize = all.some((t) => (t as { serialize?: unknown }).serialize === true && (t.status === "pending" || t.status === "in_progress" || t.status === "rework"));
  if (hasSerialize) {
    const serializeTask = all.find((t) => (t as { serialize?: unknown }).serialize === true && t.status === "pending" && (t.dependsOn ?? []).every((d) => { const dep = byKey.get(d); return dep && dep.status === "complete"; }) && !opts.exclude?.has(t.compositeKey) && !opts.exclude?.has(t.id));
    if (serializeTask) return [serializeTask];
    // A serialize task is running — nothing else is runnable alongside it.
    if (all.some((t) => (t as { serialize?: unknown }).serialize === true && (t.status === "in_progress" || t.status === "rework"))) return [];
  }
  // Budget admission — do not pick more than the run can pay for (tokenCost check is fallible; skip when unknown).
  const budgetFull = (()=>{ try { const { loadRunState } = require("./core/runState.ts") as typeof import("./core/runState.ts"); const rs = loadRunState(opts.targetDir); if (!rs?.budget) return false; const { isCapExceeded } = require("./daemon/budget.ts") as typeof import("./daemon/budget.ts"); return isCapExceeded(rs.budget as never).exceeded; } catch { return false; }})();
  if (budgetFull) return [];
  const eligible = all.filter((t) => {
    if (t.status !== "pending") return false;
    if (opts.exclude?.has(t.compositeKey) || opts.exclude?.has(t.id)) return false;
    const deps = t.dependsOn ?? [];
    return deps.every((d) => {
      const dep = byKey.get(d);
      return dep && dep.status === "complete";
    });
  });

  // Group by granularity to enforce breadth limit.
  const level = opts.parallelAt ?? "off";
  if (level === "off" || level === "goal") {
    // one task at a time (or one goal pipeline)
    return eligible.slice(0, 1);
  }
  const keyFor = (t: FlatTask): string => {
    // Resolve sprints/goals via feature list lookups when needed.
    if (level === "task" || level === "subtask") return t.compositeKey;
    if (level === "feature") return t.featureId;
    if (level === "sprint") {
      const feat = list.features.find((f) => f.id === t.featureId);
      return (feat as { sprintId?: string } | undefined)?.sprintId ?? t.featureId;
    }
    if (level === "phase") return t.effectivePhase ?? "build";
    return t.compositeKey;
  };
  const groups = new Map<string, FlatTask[]>();
  for (const t of eligible) {
    const k = keyFor(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(t);
  }
  // Take one per group breadth-first, up to maxWorkers.
  const max = Math.max(1, Math.min(16, opts.maxWorkers ?? 3));
  const out: FlatTask[] = [];
  const iters = groups.values();
  // Round-robin one per group.
  const groupArrays = [...groups.values()];
  let idx = 0;
  while (out.length < max && groupArrays.some((g) => g.length > 0)) {
    const g = groupArrays[idx % groupArrays.length]!;
    if (g.length > 0) {
      const task = g.shift()!;
      out.push(task);
    }
    idx++;
    if (idx > max * groupArrays.length + 10) break;
  }
  return out.slice(0, max);
}

export async function spawnWorkers(
  targetDir: string,
  tasks: FlatTask[],
  opts: { runId?: string; promptFor: (t: FlatTask) => string; command?: string } = { promptFor: () => "" },
): Promise<SpawnWorkerResult[]> {
  const { resolveModel } = await import("./modelRouter.ts");
  const runId = opts?.runId ?? runIdFor(targetDir, "sched");
  // handoff bucket determines effective difficulty — read once
  let handoff: HandoffGranularity = "task";
  try { handoff = (loadConfig(targetDir).config.session?.handoff as HandoffGranularity) ?? "task"; } catch {}
  const allList = (()=>{ try{ return loadFeatureList(targetDir).list; }catch{ return null as unknown as import("./core/types.ts").FeatureList; } })();
  const results: SpawnWorkerResult[] = [];
  for (const t of tasks) {
    const prompt = opts.promptFor(t);
    const router = loadRouterConfig(targetDir);
    let modelHint: string | undefined;
    if (router.enabled) {
      try {
        const effDiff = allList ? effectiveDifficultyForTask(t, handoff, allList) : (t as { difficulty?: string }).difficulty;
        modelHint = resolveModel({ projectDir: targetDir, task: { difficulty: effDiff as string | undefined, id: t.id, key: t.compositeKey } });
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
  // Anything but the explicit legacy value means background: a config written
  // before this setting existed should get the new behaviour, not the bug.
  const engine: import("./core/types.ts").ExecutionEngine = e.engine === "main-session" ? "main-session" : "background";
  const at = typeof e.parallelAt === "string" && (["off","goal","phase","sprint","feature","task","subtask"] as const).includes(e.parallelAt as HandoffGranularity)
    ? (e.parallelAt as HandoffGranularity)
    : "task";
  const raw = typeof e.maxWorkers === "number" ? e.maxWorkers : 3;
  const maxWorkers = Math.max(1, Math.min(16, Math.floor(raw)));
  return { engine, parallelAt: at, maxWorkers };
}
