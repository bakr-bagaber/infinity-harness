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
