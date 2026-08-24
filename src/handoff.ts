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

import type { HarnessConfig, Phase, SessionPolicy } from "./core/types.ts";
import { pendingSessionPath } from "./core/paths.ts";
import { readJsonSafe, writeJsonAtomic, removeFile, fileExists } from "./core/fsx.ts";

/** Why a session is being replaced. Shown to the human and to the next agent. */
export type HandoffReason = "phase" | "task" | "context" | "goal-pass" | "manual";

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
  /** Fraction of the context window in use, 0..1, or null when unknown. */
  contextRatio: number | null;
};

export type HandoffDecision = { handoff: false } | { handoff: true; reason: HandoffReason; detail: string };

export function defaultSessionPolicy(): SessionPolicy {
  return { handoff: "phase", contextThreshold: 0.7, carryNotes: true };
}

function policyOf(config: HarnessConfig): SessionPolicy {
  const p = (config.session ?? {}) as Partial<SessionPolicy>;
  const handoff = p.handoff === "off" || p.handoff === "task" || p.handoff === "phase" ? p.handoff : "phase";
  const raw = typeof p.contextThreshold === "number" ? p.contextThreshold : 0.7;
  return {
    handoff,
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

  if (signals.toPhase && signals.fromPhase !== signals.toPhase) {
    return {
      handoff: true,
      reason: "phase",
      detail: `${(signals.fromPhase ?? "start").toUpperCase()} → ${signals.toPhase.toUpperCase()}`,
    };
  }

  if (policy.handoff === "task" && signals.toTask && signals.fromTask !== signals.toTask) {
    return {
      handoff: true,
      reason: "task",
      detail: `${signals.fromTask ?? "no task"} → ${signals.toTask}`,
    };
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
  const why: Record<HandoffReason, string> = {
    phase: "The pipeline advanced, so the run continues in a clean session.",
    task: "The run moved to a different task, so it continues in a clean session.",
    context: "The previous session's context was filling up, so the run continues in a clean one.",
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
