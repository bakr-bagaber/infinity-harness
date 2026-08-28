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
/** Depth: Standard(3 tasks/9 subtasks) < Deep(5/15) < Comprehensive(10/30+). Default deep. */
export type ResearchDepth = "standard" | "deep" | "comprehensive";
export const STARTER_TASKS_BY_DEPTH: Record<ResearchDepth, StarterTask[]> = {
  standard: [
    { id: "research/r1", description: "Collect prior art — 3 primary sources with URLs, what exists, where it stops", difficulty: "moderate", subtasks: ["source 1 + URL + summary", "source 2 + URL + summary", "source 3 + URL + summary"] },
    { id: "research/r2", description: "Name constraints (given vs inferred) and lay out 2+ options with costs", difficulty: "moderate", subtasks: ["constraints given vs inferred table", "option A cost/benefit", "option B cost/benefit"] },
    { id: "research/r3", description: "Recommend one option, falsification condition, and open questions for DEFINE", difficulty: "moderate", subtasks: ["recommendation + falsification", "open questions list (≥5)"] },
  ],
  deep: [
    { id: "research/r1", description: "Prior art: ≥5 primary sources with URLs (docs/specs/repos), what each gets right and where it stops", difficulty: "moderate", subtasks: ["sources 1-3 + URLs + summaries", "sources 4-5 + URLs + gap analysis", "comparison table: feature × prior art"] },
    { id: "research/r2", description: "Constraints & domain model: given vs inferred, glossary terms, actors & data", difficulty: "moderate", subtasks: ["constraints given vs inferred (table)", "domain glossary + actors", "data & platform constraints"] },
    { id: "research/r3", description: "Options: ≥3 genuine alternatives with architecture, cost, risk and trade-offs", difficulty: "difficult", subtasks: ["option A: arch + cost + risk", "option B: arch + cost + risk", "option C / hybrid + trade-off matrix"] },
    { id: "research/r4", description: "Recommendation with falsification: what must be true, what would prove it wrong", difficulty: "moderate", subtasks: ["recommendation + rationale", "falsification condition + experiment"] },
    { id: "research/r5", description: "Open questions for DEFINE: ranked questions only a human can answer", difficulty: "easy", subtasks: ["open questions (≥8) ranked", "DEFINE interview agenda"] },
  ],
  comprehensive: [
    { id: "research/r1", description: "Literature sweep: ≥15 primary sources — papers, RFCs, repos, postmortems — annotated", difficulty: "difficult", subtasks: ["sources 1-5 annotated", "sources 6-10 annotated", "sources 11-15 annotated", "citation map + gaps in literature"] },
    { id: "research/r2", description: "Domain & constraints synthesis: glossary, actors, data, regulatory & platform limits", difficulty: "difficult", subtasks: ["constraints given vs inferred (full table)", "domain glossary + bounded contexts", "actors, data flows & invariants"] },
    { id: "research/r3", description: "Benchmark prior work: reproduce or reason about 3+ approaches on a toy case", difficulty: "difficult", subtasks: ["approach A benchmark", "approach B benchmark", "approach C benchmark + comparison matrix"] },
    { id: "research/r4", description: "Architecture options: ≥3 with diagrams, cost model, risk register, team & time", difficulty: "difficult", subtasks: ["option A: diagram + cost + risk", "option B: diagram + cost + risk", "option C: diagram + cost + risk", "trade-off matrix + decision criteria"] },
    { id: "research/r5", description: "Recommendation as a decision record + what falsifies it", difficulty: "moderate", subtasks: ["ADR: recommendation + alternatives rejected", "falsification condition + experiment design"] },
    { id: "research/r6", description: "Risk & unknowns register: known unknowns, unknown unknowns, mitigations", difficulty: "moderate", subtasks: ["risk register", "mitigations + owners", "open unknowns vs knowns"] },
    { id: "research/r7", description: "DEFINE handoff: ranked open questions (≥12) + interview agenda + glossary delta", difficulty: "easy", subtasks: ["open questions (≥12) ranked", "DEFINE interview agenda", "glossary delta for DOMAIN.md"] },
  ],
};
// Back-compat: default deep
const DEFAULT_RESEARCH_DEPTH: ResearchDepth = "deep";
export const STARTER_TASKS: Record<string, StarterTask[]> = {
  get research(): StarterTask[] { return STARTER_TASKS_BY_DEPTH[DEFAULT_RESEARCH_DEPTH]; },
  set research(v: StarterTask[]) { (STARTER_TASKS_BY_DEPTH as Record<string, StarterTask[]>)[DEFAULT_RESEARCH_DEPTH] = v; },

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

function startersForPhase(dir: string, phase: string): StarterTask[] {
  if (phase !== "research") return STARTER_TASKS[phase] ?? [];
  try {
    const { config } = loadConfig(dir);
    const depth = (config as { researchDepth?: ResearchDepth }).researchDepth;
    if (depth && STARTER_TASKS_BY_DEPTH[depth]) return STARTER_TASKS_BY_DEPTH[depth];
  } catch {}
  return STARTER_TASKS_BY_DEPTH[DEFAULT_RESEARCH_DEPTH] ?? [];
}

export function ensurePhaseSeeded(dir: string, phase: import("./types.ts").Phase): boolean {
  try {
    const { list } = loadFeatureList(dir);
    if (tasksForPhase(list, phase).length > 0) return false;
    const r = seedPhaseIfEmpty(dir, phase);
    return r.seeded;
  } catch { return false; }
}

export function seedPhaseIfEmpty(dir: string, phase: import("./types.ts").Phase): { seeded: boolean; error: string | null } {
  const seeded = startersForPhase(dir, phase);
  if (seeded.length === 0) return { seeded: false, error: null };
  try {
    const { list } = loadFeatureList(dir);
    const existing = tasksForPhase(list, phase);
    if (existing.length > 0) return { seeded: false, error: null };
    // Each phase gets its own feature (phase-<name>) so per-phase tabs/groups isolate correctly.
    // Never append a "define" task to a "research" feature — the feature.phase is the grouping key.
    const match = list.features.find((f) => (f as { phase?: string }).phase === phase);
    const feature: typeof list.features[number] = match ?? ({ id: `phase-${phase}`, name: phase.toUpperCase(), tasks: [] } as unknown as typeof list.features[number]);
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
