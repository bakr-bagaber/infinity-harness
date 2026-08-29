/**
 * infinity-harness — modelRouter: which model for which unit (Core, pi-free).
 *
 * Pure decision: difficulty + tiers + baseModel -> asked {provider,id}.
 * Never verifies — tier preflight + servedModel + budget live in the Daemon.
 *
 * Tiers live in `config.tiers` (A/B/C/D/X). Legacy `harness/model-router.json`
 * is still migrated on read for one release (byDifficulty Master ladder).
 */

import type { TierMap, TierSpec, HarnessConfig, FeatureList, Phase, Difficulty } from "./types.ts";
import { loadConfig } from "./config.ts";

export type ThinkingLevel = import("./types.ts").ThinkingLevel;
export type TierId = import("./types.ts").TierId;

const DIFF_TO_TIER: Record<Difficulty, import("./types.ts").TierId> = {
  easy: "B",
  moderate: "C",
  difficult: "D",
};

function effectiveDifficultyForUnitFromTasks(tasks: Array<{ difficulty?: Difficulty }>): Difficulty | undefined {
  const rank: Record<string, number> = { easy: 1, moderate: 2, difficult: 3 };
  let best: Difficulty | undefined;
  let bestRank = -1;
  for (const t of tasks) {
    const d = t.difficulty;
    if (!d) continue;
    const r = rank[d] ?? -1;
    if (r > bestRank) { bestRank = r; best = d as Difficulty; }
  }
  return best;
}

function tiersOf(config: HarnessConfig): TierMap {
  const t = (config as unknown as { tiers?: TierMap }).tiers;
  if (t && typeof t === "object") return t;
  return {};
}

function baseModelOf(runState: { baseModel?: { provider: string; id: string } | string | null } | null | undefined): { provider: string; id: string } | null {
  if (!runState?.baseModel) return null;
  const bm: unknown = runState.baseModel;
  if (typeof bm === "string") {
    const parts = String(bm).split("/");
    if (parts.length >= 2) return { provider: parts[0]!, id: parts.slice(1).join("/") };
    return { provider: "anthropic", id: String(bm) };
  }
  if (typeof bm === "object" && bm !== null && typeof (bm as { provider: unknown }).provider === "string" && typeof (bm as { id: unknown }).id === "string") {
    return { provider: String((bm as { provider: unknown }).provider), id: String((bm as { id: unknown }).id) };
  }
  return null;
}

export type RouteInput = {
  difficulty?: Difficulty | string;
  tiers?: TierMap;
  baseModel?: { provider: string; id: string } | string | null;
  // Convenience: pass config + runState instead of tiers+baseModel
  config?: HarnessConfig;
  runState?: { baseModel?: { provider: string; id: string } | string | null } | null;
};

export type RouteResult = { provider: string; id: string; tier: TierId; askedTier: import("./types.ts").TierId | null };

/**
 * Resolve the asked model for one unit.
 * Empty slot -> baseModel, never pi's default. Throws when no model can be resolved.
 */
export function routeModel(input: RouteInput): RouteResult {
  const tiers: TierMap = input.tiers ?? (input.config ? tiersOf(input.config) : {});
  const base = baseModelOf(input.runState ?? (input.baseModel ? { baseModel: input.baseModel } : null));
  const diff = (input.difficulty as Difficulty | undefined) ?? undefined;
  let tier: TierId | null = null;
  if (diff && diff in DIFF_TO_TIER) tier = DIFF_TO_TIER[diff as Difficulty];
  if (!tier) tier = "A"; // general work -> A
  const spec: TierSpec | undefined = (tiers as Record<string, TierSpec | undefined>)[tier];
  if (spec && spec.provider && spec.id) return { provider: spec.provider, id: spec.id, tier: tier!, askedTier: tier };
  if (base) return { provider: base.provider, id: base.id, tier: tier!, askedTier: null };
  throw new Error(`no model for tier ${tier}: tiers empty and no baseModel`);
}

/**
 * Unit-level difficulty for handoff buckets.
 * When handoff is coarser than `task`, the bucket's hardest difficulty wins.
 */
export function effectiveDifficultyForTask(
  plan: FeatureList,
  taskId: string | { id?: string; key?: string; compositeKey?: string },
  handoff?: string,
): Difficulty | undefined {
  const needle = typeof taskId === "string" ? taskId : (taskId?.key ?? taskId?.compositeKey ?? taskId?.id ?? "");
  const hh = (handoff ?? "task") as string;
  // Find the task and its feature
  let target: { task: import("./types.ts").Task; featureId: string; effectivePhase?: string } | null = null;
  for (const f of plan.features ?? []) {
    for (const t of f.tasks ?? []) {
      const comp = t.key ?? `${f.id}/${t.id}`;
      if (t.id === needle || t.key === needle || comp === needle) {
        const featPhase = (f as { phase?: string }).phase as string | undefined;
        const taskPhase = (t as { phase?: string }).phase as string | undefined;
        const eff = taskPhase ?? featPhase ?? "build";
        target = { task: t, featureId: f.id, effectivePhase: eff };
        break;
      }
    }
    if (target) break;
  }
  if (!target) {
    // Fallback: global hardest when target not found and handoff is coarse
    if (hh === "off") return effectiveDifficultyForUnitFromTasks((plan.features ?? []).flatMap(f => f.tasks ?? []) as Array<{ difficulty?: Difficulty }>);
    return undefined;
  }
  const own = (target.task as { difficulty?: Difficulty }).difficulty;
  if (hh === "task" || hh === "subtask" || hh === "off") {
    if (hh === "off") {
      const all = (plan.features ?? []).flatMap(f => f.tasks ?? []) as Array<{ difficulty?: Difficulty }>;
      return effectiveDifficultyForUnitFromTasks(all) ?? own;
    }
    return own;
  }
  let bucket: Array<{ difficulty?: Difficulty }> = [];
  const all = (plan.features ?? []).flatMap(f => f.tasks ?? []) as Array<{ difficulty?: Difficulty } & { effectivePhase?: string; featureId?: string }>;
  if (hh === "phase") {
    const phase = target.effectivePhase ?? "build";
    for (const f of plan.features ?? []) {
      const fp = (f as { phase?: string }).phase as string | undefined;
      for (const t of f.tasks ?? []) {
        const tp = (t as { phase?: string }).phase as string | undefined;
        const eff = tp ?? fp ?? "build";
        if (eff === phase) bucket.push(t as { difficulty?: Difficulty });
      }
    }
  } else if (hh === "feature") {
    const feat = plan.features.find(f => f.id === target!.featureId);
    bucket = (feat?.tasks ?? []) as Array<{ difficulty?: Difficulty }>;
  } else if (hh === "sprint") {
    const feat = plan.features.find(f => f.id === target!.featureId) as { sprintId?: string } | undefined;
    const sid = feat?.sprintId;
    if (!sid) return own;
    for (const f of plan.features ?? []) if ((f as { sprintId?: string }).sprintId === sid) bucket.push(...((f.tasks ?? []) as Array<{ difficulty?: Difficulty }>));
  } else if (hh === "goal") {
    // Simplify: goal = global hardest (goals span features via sprint)
    const all2 = (plan.features ?? []).flatMap(f => f.tasks ?? []) as Array<{ difficulty?: Difficulty }>;
    return effectiveDifficultyForUnitFromTasks(all2) ?? own;
  }
  return effectiveDifficultyForUnitFromTasks(bucket) ?? own;
}

/**
 * Legacy helper: migrate harness/model-router.json into tiers.
 * Kept for one release; logs when it runs.
 */
export function tiersFromLegacyModelRouter(projectDir: string): TierMap | null {
  try {
    const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs");
    const p = `${projectDir}/harness/model-router.json`;
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    const bd: Record<string, string> = raw?.byDifficulty ?? {};
    const tiers: TierMap = {};
    const labels: Record<string, TierId> = { easy: "B", moderate: "C", difficult: "D" };
    for (const [diff, tier] of Object.entries(labels)) {
      const v = bd[diff];
      if (typeof v === "string" && v.trim()) {
        const parts = v.split("/");
        tiers[tier] = parts.length >= 2 ? { provider: parts[0]!, id: parts.slice(1).join("/") } : { provider: "anthropic", id: v.trim() };
      }
    }
    if (typeof raw.master === "string" && raw.master.trim()) {
      const v = raw.master as string;
      const parts = v.split("/");
      tiers.X = parts.length >= 2 ? { provider: parts[0]!, id: parts.slice(1).join("/") } : { provider: "anthropic", id: v.trim() };
    }
    return tiers;
  } catch { return null; }
}
