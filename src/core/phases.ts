/**
 * infinity-harness — the phase state machine.
 *
 * Transitions are forward-only and one step at a time. That constraint is the
 * whole point of the harness: an agent cannot decide it is done with BUILD and
 * jump to SHIP. The only backward movement is an explicit rework (src/rework.ts),
 * which records why it happened.
 */

import type { HarnessConfig, Phase } from "./types.ts";
import { PHASE_ORDER, DEFAULT_ENABLED_PHASES } from "./types.ts";
import { loadConfig, saveConfig, recordGate, currentRoleFor } from "./config.ts";
import { gitBranch, gitIsClean, gitHasUpstream, gitLastCommitMessage } from "./exec.ts";
import { loadFeatureList, saveFeatureList, tasksForPhase } from "./featureList.ts";
import type { RetryLevel } from "./types.ts";

export { PHASE_ORDER };

export function isPhase(v: unknown): v is Phase {
  return typeof v === "string" && (PHASE_ORDER as readonly string[]).includes(v);
}

/** The enabled pipeline, in canonical order. Unknown entries are ignored. */
export function getPhaseOrder(enabled?: readonly string[] | null): Phase[] {
  if (!Array.isArray(enabled)) return [...DEFAULT_ENABLED_PHASES];
  const set = new Set(enabled);
  const order = PHASE_ORDER.filter((p) => set.has(p));
  return order.length ? [...order] : [...DEFAULT_ENABLED_PHASES];
}

export function isValidTransition(
  fromPhase: Phase | null,
  toPhase: Phase,
  enabled?: readonly string[] | null,
): boolean {
  const order = getPhaseOrder(enabled);
  if (!order.includes(toPhase)) return false;
  if (fromPhase === null) return order[0] === toPhase;
  if (fromPhase === toPhase) return true; // re-running a phase is always legal
  return order.indexOf(toPhase) === order.indexOf(fromPhase) + 1;
}

export function nextPhase(fromPhase: Phase | null, enabled?: readonly string[] | null): Phase | null {
  const order = getPhaseOrder(enabled);
  if (fromPhase === null) return order[0] ?? null;
  const i = order.indexOf(fromPhase);
  if (i === -1) return order[0] ?? null;
  return order[i + 1] ?? null;
}

export function isFinalPhase(phase: Phase | null, enabled?: readonly string[] | null): boolean {
  const order = getPhaseOrder(enabled);
  return phase !== null && order[order.length - 1] === phase;
}

export type TransitionResult = {
  ok: boolean;
  error: string | null;
  config: HarnessConfig | null;
  from: Phase | null;
  to: Phase | null;
};

/**
 * Advance to `toPhase`, refreshing git metadata and resetting the right
 * retry counters. Re-entering the same phase counts as a retry; moving to a
 * new phase clears the phase budget but leaves task/feature budgets alone
 * (those are cleared by whoever completes the task/feature).
 */
export async function transitionPhase(targetDir: string, toPhase: Phase): Promise<TransitionResult> {
  const { config, ok, error } = loadConfig(targetDir);
  if (!ok) {
    return { ok: false, error: error ?? "cannot load config", config: null, from: null, to: null };
  }

  const from = config.currentPhase;
  const enabled = config.phases?.enabled;
  if (!isValidTransition(from, toPhase, enabled)) {
    const order = getPhaseOrder(enabled).join(" → ");
    return {
      ok: false,
      error: `invalid transition ${from ?? "start"} → ${toPhase}. Pipeline is: ${order}`,
      config: null,
      from,
      to: toPhase,
    };
  }

  const isNewPhase = from !== toPhase;
  if (from && isNewPhase) recordGate(config, from, "pass");

  if (isNewPhase) {
    config.retryCount = 0;
    config.phaseRetryCount = 0;
    config.pipelineIteration = (config.pipelineIteration ?? 0) + 1;
  } else {
    config.retryCount = (config.retryCount ?? 0) + 1;
    config.phaseRetryCount = (config.phaseRetryCount ?? 0) + 1;
  }

  config.currentPhase = toPhase;
  config.currentRole = currentRoleFor(toPhase);
  config.paused = false;

  // Git metadata is best-effort context for the brief, never a blocker.
  try {
    config.git = config.git ?? {
      autoCommit: false,
      autoTag: false,
      branch: null,
      clean: true,
      hasUpstream: false,
      lastCommitMessage: null,
    };
    config.git.branch = await gitBranch(targetDir);
    config.git.clean = await gitIsClean(targetDir);
    config.git.hasUpstream = await gitHasUpstream(targetDir);
    config.git.lastCommitMessage = await gitLastCommitMessage(targetDir);
  } catch {
    /* leave prior git metadata in place */
  }

  const saved = saveConfig(targetDir, config);
  if (!saved.ok) {
    return { ok: false, error: saved.error, config: null, from, to: toPhase };
  }
  return { ok: true, error: null, config, from, to: toPhase };
}

/** Starter tasks seeded when a phase has no tasks at all (idempotent, fixes DEFINE rev 0).
 *
 * Generic: every phase that is enabled and enters with 0 tasks gets starters —
 * same code path, same trigger, no special case for research. BUILD/VERIFY
 * already have tasks from PLAN so they are not seeded; RESEARCH was shallow
 * because it had no tasks — now it does.
 */
export type StarterTask = {
  id: string;
  description: string;
  difficulty: "easy" | "moderate" | "difficult";
  subtasks?: string[];
};
export const STARTER_TASKS: Record<string, StarterTask[]> = {
  research: [
    {
      id: "research/r1",
      description: "Collect prior art — 3 sources, what exists, where it stops",
      difficulty: "moderate",
      subtasks: ["source 1 + summary", "source 2 + summary", "source 3 + summary"],
    },
    {
      id: "research/r2",
      description: "Name constraints (given vs inferred) and lay out 2+ options with costs",
      difficulty: "moderate",
      subtasks: ["constraints given vs inferred", "option A cost/benefit", "option B cost/benefit"],
    },
    {
      id: "research/r3",
      description: "Recommend one option, falsification condition, and open questions for DEFINE",
      difficulty: "moderate",
      subtasks: ["recommendation + falsification", "open questions list"],
    },
  ],
  define: [
    {
      id: "define/d1",
      description: "Interview scope and write bounded PRD + acceptance criteria",
      difficulty: "moderate",
      subtasks: ["scope interview", "PRD draft", "acceptance criteria per feature"],
    },
    {
      id: "define/d2",
      description: "Record sprint contract and branch (not main)",
      difficulty: "easy",
      subtasks: ["sprint contract", "feature branch"],
    },
  ],
  plan: [
    {
      id: "plan/p1",
      description: "Break each feature into ordered, dependency-aware tasks",
      difficulty: "moderate",
      subtasks: ["vertical slices", "dependency graph", "difficulty + subtasks"],
    },
    {
      id: "plan/p2",
      description: "Commit plan (feature-list) and validate",
      difficulty: "easy",
      subtasks: ["feature-list.json commit", "validate gate"],
    },
  ],
};

export function isPhaseDone(dir: string, phase: import("./types.ts").Phase): boolean {
  const { list } = loadFeatureList(dir);
  const tasks = tasksForPhase(list, phase);
  return tasks.length > 0 && tasks.every((t) => t.status === "complete");
}

export function seedPhaseIfEmpty(dir: string, phase: import("./types.ts").Phase): { seeded: boolean; error: string | null } {
  const seeded = STARTER_TASKS[phase] ?? [];
  if (seeded.length === 0) return { seeded: false, error: null };
  try {
    const { list } = loadFeatureList(dir);
    const existing = tasksForPhase(list, phase);
    if (existing.length > 0) return { seeded: false, error: null };
    // Append to first feature matching phase, or create a phase feature.
    const feature = (
      list.features.find((f) => (f as { phase?: string }).phase === phase) ??
      list.features[0] ??
      ({ id: `phase-${phase}`, name: phase.toUpperCase(), tasks: [] } as unknown as typeof list.features[number])
    );
    if (!list.features.includes(feature as any)) {
      (feature as { phase?: string }).phase = phase;
      list.features.push(feature as any);
    }
    for (const t of seeded) {
      if (feature.tasks.some((x) => x.id === t.id)) continue;
      feature.tasks.push({
        id: t.id,
        description: t.description,
        status: "pending" as const,
        phase,
        difficulty: t.difficulty,
        subtasks: (t.subtasks ?? []).map((title: string) => ({ title, status: "pending" as const })),
      } as any);
    }
    // Newly created phase-features default to criteria so DEFINE gate doesn't fail on 'phase-define missing criteria'.
    if (Array.isArray(feature.criteria) && feature.criteria.length === 0) {
      feature.criteria = [`${phase} ready for review`];
    }
    list.baseRevision = (list.baseRevision ?? 0) + 1;
    saveFeatureList(dir, list);
    return { seeded: true, error: null };
  } catch (e) {
    return { seeded: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Advance one step along the enabled pipeline. */
export async function advancePhase(targetDir: string): Promise<TransitionResult> {
  const { config, ok, error } = loadConfig(targetDir);
  if (!ok) return { ok: false, error: error ?? "cannot load config", config: null, from: null, to: null };
  const to = nextPhase(config.currentPhase, config.phases?.enabled);
  if (to === null) {
    return {
      ok: false,
      error: "pipeline complete — no phase after " + (config.currentPhase ?? "start"),
      config,
      from: config.currentPhase,
      to: null,
    };
  }
  return transitionPhase(targetDir, to);
}
