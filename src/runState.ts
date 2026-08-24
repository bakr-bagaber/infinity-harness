/**
 * infinity-harness — is a continuous run armed, and which run is it?
 *
 * This used to be a `let loopEnabled = false` inside the extension closure,
 * which meant the answer died with the pi session that held it. That was fine
 * while the harness lived in exactly one session forever, and wrong the moment
 * it did not:
 *
 *   - a fresh session per handoff (the whole point of `src/handoff.ts`) starts
 *     a new extension instance, and the run it was continuing was over
 *   - `/reload`, `/new`, `/resume` and a crash all did the same thing
 *   - the run id was a `randomUUID()` per session, so `loadLoopState` saw a
 *     different run each time and reset the iteration count, the wall-clock
 *     budget, the no-progress streak and the escalation ladder — every budget
 *     that exists to stop a runaway run
 *
 * A run is a property of the project, not of the terminal window that started
 * it. It lives on disk.
 */

import { runStatePath } from "./core/paths.ts";
import { readJsonSafe, writeJsonAtomic, removeFile } from "./core/fsx.ts";

export type RunState = {
  /** Whether the loop should keep driving. Read on every session start. */
  armed: boolean;
  /** Stable across every session this run spans. */
  runId: string;
  startedAt: string;
  /** How many pi sessions this run has used. Shown in the widget. */
  sessions: number;
  /** Why the run last stopped, so a returning human is not left guessing. */
  stoppedAt: string | null;
  stopReason: string | null;
};

export function newRunState(runId: string, now = new Date()): RunState {
  return {
    armed: true,
    runId,
    startedAt: now.toISOString(),
    sessions: 1,
    stoppedAt: null,
    stopReason: null,
  };
}

export function loadRunState(targetDir: string): RunState | null {
  const raw = readJsonSafe<Partial<RunState> | null>(runStatePath(targetDir), null);
  if (!raw || typeof raw.runId !== "string" || !raw.runId) return null;
  return {
    armed: raw.armed === true,
    runId: raw.runId,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : new Date(0).toISOString(),
    sessions: typeof raw.sessions === "number" && raw.sessions > 0 ? raw.sessions : 1,
    stoppedAt: typeof raw.stoppedAt === "string" ? raw.stoppedAt : null,
    stopReason: typeof raw.stopReason === "string" ? raw.stopReason : null,
  };
}

export function saveRunState(targetDir: string, state: RunState): void {
  try {
    writeJsonAtomic(runStatePath(targetDir), state);
  } catch {
    // Losing the file costs the run its cross-session budgets, which is bad,
    // but throwing here would kill the session, which is worse.
  }
}

/** Arm a run. Reuses the existing run id when one is already armed. */
export function armRun(targetDir: string, runId: string, now = new Date()): RunState {
  const existing = loadRunState(targetDir);
  const state =
    existing && existing.armed
      ? { ...existing, stoppedAt: null, stopReason: null }
      : newRunState(runId, now);
  saveRunState(targetDir, state);
  return state;
}

export function disarmRun(targetDir: string, reason: string, now = new Date()): RunState | null {
  const existing = loadRunState(targetDir);
  if (!existing) return null;
  const state: RunState = {
    ...existing,
    armed: false,
    stoppedAt: now.toISOString(),
    stopReason: reason,
  };
  saveRunState(targetDir, state);
  return state;
}

/** Count one more pi session against this run. Called from `session_start`. */
export function countSession(targetDir: string): RunState | null {
  const existing = loadRunState(targetDir);
  if (!existing) return null;
  const state = { ...existing, sessions: existing.sessions + 1 };
  saveRunState(targetDir, state);
  return state;
}

export function clearRunState(targetDir: string): void {
  try {
    removeFile(runStatePath(targetDir));
  } catch {
    /* nothing to clear */
  }
}

/**
 * The run id the loop should use.
 *
 * An armed run keeps its id so `loadLoopState` finds the same budgets after a
 * handoff. With nothing armed, the caller's session id is the run id — an
 * ad-hoc `/infinity:validate` should not inherit a finished run's strikes.
 */
export function runIdFor(targetDir: string, fallback: string): string {
  const state = loadRunState(targetDir);
  return state && state.armed ? state.runId : fallback;
}
