/**
 * infinity-harness — parallel scheduler.
 *
 * Picks which tasks can run now, respecting deps and the chosen
 * parallel granularity, then spawns isolated workers for them.
 * The main session never edits files; it only polls worker logs.
 */

import type { HarnessConfig, HandoffGranularity, Phase } from "./core/types.ts";
import { loadFeatureList, tasksForPhase, type FlatTask } from "./core/featureList.ts";
import { loadRouterConfig } from "./modelRouter.ts";
import { spawnIsolatedWorker, type SpawnWorkerResult } from "./worker.ts";
import { runIdFor } from "./runState.ts";

export type PickOpts = {
  targetDir: string;
  phase?: Phase | null;
  parallelAt?: HandoffGranularity;
  maxWorkers?: number;
  /** Keys already being worked (in_progress) or rework. */
  exclude?: Set<string>;
};

export function pickRunnableTasks(opts: PickOpts): FlatTask[] {
  const { list } = loadFeatureList(opts.targetDir);
  const phase = (opts.phase ?? null) as Phase | null;
  // Phase-filtered pool when phase given, else all tasks across phases.
  const { flattenTasks } = require("./core/featureList.ts");
  const all: FlatTask[] = phase ? tasksForPhase(list, phase) : (flattenTasks(list) as FlatTask[]);
  // Build key map for dep check
  const byKey = new Map<string, FlatTask>();
  for (const t of all) {
    byKey.set(t.compositeKey, t);
    byKey.set(t.id, t);
    if (t.key) byKey.set(t.key, t);
  }
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
  const results: SpawnWorkerResult[] = [];
  for (const t of tasks) {
    const prompt = opts.promptFor(t);
    const router = loadRouterConfig(targetDir);
    let modelHint: string | undefined;
    if (router.enabled) {
      try { modelHint = resolveModel({ projectDir: targetDir, task: { difficulty: (t as { difficulty?: string }).difficulty, id: t.id, key: t.compositeKey } }); } catch {}
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

export function executionPolicyOf(config: HarnessConfig): { parallelAt: HandoffGranularity; maxWorkers: number } {
  const e = (config.execution ?? {}) as Partial<{ parallelAt: unknown; maxWorkers: unknown }>;
  const at = typeof e.parallelAt === "string" && (["off","goal","phase","sprint","feature","task","subtask"] as const).includes(e.parallelAt as HandoffGranularity)
    ? (e.parallelAt as HandoffGranularity)
    : "task";
  const raw = typeof e.maxWorkers === "number" ? e.maxWorkers : 3;
  const maxWorkers = Math.max(1, Math.min(16, Math.floor(raw)));
  return { parallelAt: at, maxWorkers };
}
