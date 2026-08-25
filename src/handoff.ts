/**
 * infinity-harness — session handoff.
 *
 * A harness that never starts a new pi session is a harness whose context
 * window only ever grows. By the tenth task the model is re-reading the whole
 * history of the first nine in order to do the tenth: it pays for those tokens
 * on every call, it compacts them into a lossy summary once the window fills,
 * and on a small model it simply drowns. That is the failure mode this module
 * exists to remove.
 *
 * The trick is that a handoff costs almost nothing here, because the harness
 * never kept its state in the conversation to begin with. The plan, the phase,
 * the gate history, the retry budgets and the escalation ladder are all files.
 * A new session needs one thing to carry on: the brief — which is what the
 * agent should have been working from anyway.
 *
 * What this module owns:
 *   - deciding *whether* a handoff is due (`shouldHandoff`)
 *   - writing down what the next session must be told (`requestHandoff`)
 *   - handing that to whoever starts it, exactly once (`takeHandoff`)
 *
 * What it deliberately does not own: starting the session. Only pi can do
 * that, only from a command handler, and the adapter is where pi lives.
 */

import type { HarnessConfig, HandoffGranularity, Phase, SessionPolicy } from "./core/types.ts";
import { pendingSessionPath } from "./core/paths.ts";
import { readJsonSafe, writeJsonAtomic, removeFile, fileExists } from "./core/fsx.ts";

/** Why a session is being replaced. Shown to the human and to the next agent. */
export type HandoffReason = HandoffGranularity | "context" | "goal-pass" | "manual";

export type PendingHandoff = {
  reason: HandoffReason;
  /** Human-readable one-liner: "BUILD → VERIFY", "context 78% full". */
  detail: string;
  /** The message the replacement session is started with. Usually the brief. */
  kickoff: string;
  /** A short note on what the session being replaced actually did. */
  carry: string | null;
  /** The run this handoff belongs to; a stale file from an old run is ignored. */
  runId: string;
  at: string;
};

export type HandoffSignals = {
  config: HarnessConfig;
  /** Phase before the loop's decision, and after it. */
  fromPhase: Phase | null;
  toPhase: Phase | null;
  /** Composite key of the task in focus before and after. */
  fromTask: string | null;
  toTask: string | null;
  /** IDs for the coarser plan levels (goal/feature/sprint/subtask). Null means "no active one". */
  fromGoal?: string | null;
  toGoal?: string | null;
  fromSprint?: string | null;
  toSprint?: string | null;
  fromFeature?: string | null;
  toFeature?: string | null;
  fromSubtask?: string | null;
  toSubtask?: string | null;
  /** Fraction of the context window in use, 0..1, or null when unknown. */
  contextRatio: number | null;
};

export type HandoffDecision = { handoff: false } | { handoff: true; reason: HandoffReason; detail: string };

const GRANULARITIES: readonly HandoffGranularity[] = ["off", "goal", "phase", "sprint", "feature", "task", "subtask"] as const;

export function isHandoffGranularity(v: unknown): v is HandoffGranularity {
  return typeof v === "string" && (GRANULARITIES as readonly string[]).includes(v);
}

export function defaultSessionPolicy(): SessionPolicy {
  return { handoff: "task", contextThreshold: 0.6, carryNotes: true };
}

function policyOf(config: HarnessConfig): SessionPolicy {
  const p = (config.session ?? {}) as Partial<SessionPolicy>;
  const handoff: HandoffGranularity = isHandoffGranularity(p.handoff) ? p.handoff : "task";
  // "goal" is an alias for the single-session behaviour; keep the storage
  // as "goal" so the wizard round-trips, but treat it as "off" here.
  const effective: HandoffGranularity = handoff === "goal" ? "off" : handoff;
  const raw = typeof p.contextThreshold === "number" ? p.contextThreshold : 0.6;
  return {
    handoff: effective,
    // A threshold of 1 or more can never fire and a negative one always would;
    // both are configuration mistakes, and clamping is kinder than either.
    contextThreshold: raw <= 0 ? 0 : Math.min(0.95, raw),
    carryNotes: p.carryNotes !== false,
  };
}

/**
 * Should the run continue in a fresh session?
 *
 * Order matters. Context pressure wins over everything, because a handoff that
 * arrives after compaction has already happened has arrived too late to be the
 * thing that prevented it.
 */
/** Coarsest → finest. Handoff fires at the chosen level and everything coarser. */
const LEVEL_ORDER: readonly HandoffGranularity[] = ["off", "goal", "phase", "sprint", "feature", "task", "subtask"] as const;

function rank(g: HandoffGranularity): number {
  const i = (LEVEL_ORDER as readonly string[]).indexOf(g);
  return i < 0 ? 5 : i;
}

export function shouldHandoff(signals: HandoffSignals): HandoffDecision {
  const policy = policyOf(signals.config);
  if (policy.handoff === "off") return { handoff: false };

  const ratio = signals.contextRatio;
  if (policy.contextThreshold > 0 && typeof ratio === "number" && ratio >= policy.contextThreshold) {
    return {
      handoff: true,
      reason: "context",
      detail: `context ${Math.round(ratio * 100)}% full (threshold ${Math.round(policy.contextThreshold * 100)}%)`,
    };
  }

  const lvl = rank(policy.handoff);

  // Hierarchy: off(0) < goal(1) < phase(2) < sprint(3) < feature(4) < task(5) < subtask(6).
  // Finer granularity implies coarser boundaries too (task change implies feature/sprint/phase
  // may have changed, but we check coarsest first so the reason reflects the highest level).
  // Only boundaries at or coarser than the configured granularity? No —
  // the knob is "how fine do you want to go". Choosing "task" means
  // phase/feature/sprint/goal AND task boundaries fire; choosing "phase"
  // means only phase (and coarser goal) fires. So a boundary fires iff
  // its rank <= chosen rank. task (5) should not fire when handoff is phase (2). Hence <= lvl.
  // Fine-grained choice: the wizard knob is the *coarsest* level that still
  // gets a fresh session. Picking "task" means every task gets its own
  // session (feature/sprint/phase do too, implicitly). So a boundary fires
  // iff chosenRank >= boundaryRank.
  // Phase always hands off (except off/goal) because phases are the harness
  // backbone; a phase change must never ride the old session's context.
  if (signals.toPhase && signals.fromPhase !== signals.toPhase && lvl >= 2) {
    return {
      handoff: true,
      reason: "phase",
      detail: `${(signals.fromPhase ?? "start").toUpperCase()} → ${signals.toPhase.toUpperCase()}`,
    };
  }
  // "goal/off" never fires here — off early-returned, "goal" was mapped to off.
  // Keep for completeness if rank comparison changes; guarded by lvl so it
  // doesn't resurrect. retain dead code removed check.
  void lvl;
  if (signals.fromSprint !== undefined || signals.toSprint !== undefined) {
    const sFrom = (signals.fromSprint ?? null)?.trim() || null;
    const sTo = (signals.toSprint ?? null)?.trim() || null;
    if (sFrom !== sTo && (sTo || sFrom) && lvl >= 3) {
      return { handoff: true, reason: "sprint" as HandoffReason, detail: `${sFrom ?? "no sprint"} → ${sTo ?? "no sprint"}` };
    }
  }
  if (signals.fromFeature !== undefined || signals.toFeature !== undefined) {
    const fFrom = (signals.fromFeature ?? null)?.trim() || null;
    const fTo = (signals.toFeature ?? null)?.trim() || null;
    if (fFrom !== fTo && (fTo || fFrom) && lvl >= 4) {
      return { handoff: true, reason: "feature" as HandoffReason, detail: `${fFrom ?? "no feature"} → ${fTo ?? "no feature"}` };
    }
  }
  if (lvl >= 5) {
    if ((signals.fromTask ?? null) !== (signals.toTask ?? null) && (signals.fromTask || signals.toTask)) {
      return {
        handoff: true,
        reason: "task",
        detail: `${signals.fromTask ?? "no task"} → ${signals.toTask ?? "no task"}`,
      };
    }
  }
  if (lvl >= 6) {
    const stFrom = (signals.fromSubtask ?? null)?.trim() || null;
    const stTo = (signals.toSubtask ?? null)?.trim() || null;
    if (stFrom !== stTo && (stTo || stFrom)) {
      return { handoff: true, reason: "subtask" as HandoffReason, detail: `${stFrom ?? "no subtask"} → ${stTo ?? "no subtask"}` };
    }
  }

  return { handoff: false };
}

/**
 * Record what the replacement session must be told.
 *
 * Written to disk rather than held in memory because the session that writes
 * it is, by definition, about to stop existing.
 */
export function requestHandoff(
  targetDir: string,
  handoff: Omit<PendingHandoff, "at">,
): PendingHandoff {
  const pending: PendingHandoff = { ...handoff, at: new Date().toISOString() };
  writeJsonAtomic(pendingSessionPath(targetDir), pending);
  return pending;
}

export function peekHandoff(targetDir: string): PendingHandoff | null {
  const raw = readJsonSafe<PendingHandoff | null>(pendingSessionPath(targetDir), null);
  if (!raw || typeof raw.kickoff !== "string" || !raw.kickoff.trim()) return null;
  return raw;
}

/**
 * Claim the pending handoff, clearing it.
 *
 * Clearing before returning is deliberate: if the replacement session dies
 * between claiming and sending, the run stalls where a human can see it,
 * rather than looping through handoffs forever on a stale file.
 */
export function takeHandoff(targetDir: string): PendingHandoff | null {
  const pending = peekHandoff(targetDir);
  clearHandoff(targetDir);
  return pending;
}

export function clearHandoff(targetDir: string): void {
  removeFile(pendingSessionPath(targetDir));
}

export function hasPendingHandoff(targetDir: string): boolean {
  return fileExists(pendingSessionPath(targetDir));
}

/**
 * The message the replacement session opens with.
 *
 * It is the brief, plus one paragraph explaining why the previous session
 * ended — because an agent that wakes up mid-run with no explanation tends to
 * spend its first turn investigating the harness instead of doing the work.
 */
export function composeKickoff(
  brief: string,
  reason: HandoffReason,
  detail: string,
  carry: string | null,
): string {
  const why: Record<string, string> = {
    phase: "The pipeline advanced, so the run continues in a clean session.",
    task: "The run moved to a different task, so it continues in a clean session.",
    sprint: "The active sprint changed, so the run continues in a clean session.",
    feature: "The active feature changed, so the run continues in a clean session.",
    goal: "The active goal changed, so the run continues in a clean session.",
    subtask: "The active subtask changed, so the run continues in a clean session.",
    context: "The previous session's context was filling up, so the run continues in a clean one.",
    off: "Session handoff is off.",
    "goal-pass": "A goal pass finished, so the next pass starts in a clean session.",
    manual: "A human asked for a fresh session.",
  };

  const lines = [
    `[infinity-harness] Continuing a run in a fresh session — ${detail}.`,
    why[reason],
    "",
    "Nothing is lost: the plan, the phase, the gate history and every retry budget",
    "live in `harness/` and are already loaded. Work from the brief below. Do not",
    "go looking for the previous conversation.",
  ];
  if (carry && carry.trim()) {
    lines.push("", "What the previous session did:", carry.trim());
  }
  lines.push("", brief);
  return lines.join("\n");
}

/** One-line summary of a handoff, for a notification or the run journal. */
export function describeHandoff(h: PendingHandoff): string {
  return `new session — ${h.reason}: ${h.detail}`;
}
