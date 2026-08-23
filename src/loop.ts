/**
 * infinity-harness — the continuous run driver.
 *
 * This is what lets the harness work for hours or days without a human at the
 * keyboard. After the agent goes idle, `decideNext` looks at the state on disk
 * and answers one question: keep going, advance, wait, or stop.
 *
 * The hard part is not continuing — it is knowing when to *stop*. A loop that
 * always continues will burn a weekend of tokens re-running a failing gate
 * against an unchanged tree. Every guard here exists because that is the
 * default failure mode of an autonomous loop paired with a weak model:
 *
 *   - a wall-clock budget, so a forgotten run ends on its own
 *   - an iteration ceiling, independent of time
 *   - a *no-progress* detector: if the gate fails repeatedly and the working
 *     tree fingerprint has not moved, the agent is spinning, not working
 *   - a retry budget per task, so one impossible task cannot consume the run
 *   - an explicit human brake (`paused`, or a stop file) checked every tick
 *
 * The loop never silently gives up: every stop carries a reason the human
 * reads when they come back.
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { HarnessConfig, Phase } from "./core/types.ts";
import { loadConfig, saveConfig, isRetryExhausted, incrementPhaseRetry } from "./core/config.ts";
import { loadFeatureList, computeProgress, nextActionableTask } from "./core/featureList.ts";
import { runChecks } from "./core/gates.ts";
import { advancePhase, isFinalPhase, nextPhase } from "./core/phases.ts";
import { buildBrief, renderBrief } from "./core/brief.ts";
import { harnessDir } from "./core/paths.ts";
import { readJsonSafe, writeJsonAtomic, fileExists } from "./core/fsx.ts";
import { run } from "./core/exec.ts";

export const LOOP_STATE_FILE = "loop-state.json";
export const STOP_FILE = "STOP";

export const DEFAULT_MAX_ITERATIONS = 2000;
export const DEFAULT_MAX_WALL_CLOCK_MS = 24 * 60 * 60 * 1000; // 24h
/** Consecutive gate failures with an unchanged tree before we call it stuck. */
export const DEFAULT_NO_PROGRESS_LIMIT = 3;

export type LoopState = {
  runId: string;
  startedAt: string;
  iterations: number;
  lastFingerprint: string | null;
  /** Consecutive failures where the tree fingerprint did not move. */
  noProgressStreak: number;
  lastPhase: string | null;
  lastDecision: string | null;
  stoppedAt: string | null;
  stopReason: string | null;
};

export type LoopBudget = {
  maxIterations: number;
  maxWallClockMs: number;
  noProgressLimit: number;
};

export type LoopDecision =
  | { action: "continue"; message: string; reason: string }
  | { action: "advanced"; toPhase: Phase; message: string; reason: string }
  | { action: "stop"; reason: string; detail: string }
  | { action: "wait"; reason: string; detail: string };

export function loopStatePath(targetDir: string): string {
  return resolve(harnessDir(targetDir), LOOP_STATE_FILE);
}

export function stopFilePath(targetDir: string): string {
  return resolve(harnessDir(targetDir), STOP_FILE);
}

export function newLoopState(runId: string, now = new Date()): LoopState {
  return {
    runId,
    startedAt: now.toISOString(),
    iterations: 0,
    lastFingerprint: null,
    noProgressStreak: 0,
    lastPhase: null,
    lastDecision: null,
    stoppedAt: null,
    stopReason: null,
  };
}

export function loadLoopState(targetDir: string, runId: string, now = new Date()): LoopState {
  const stored = readJsonSafe<LoopState | null>(loopStatePath(targetDir), null);
  if (stored && stored.runId === runId) return stored;
  return newLoopState(runId, now);
}

export function saveLoopState(targetDir: string, state: LoopState): void {
  try {
    writeJsonAtomic(loopStatePath(targetDir), state);
  } catch {
    // Loop bookkeeping is not worth aborting a run over. Worst case the
    // budget restarts, and the wall-clock guard still bounds it.
  }
}

export function budgetFrom(config: HarnessConfig): LoopBudget {
  const loop = (config.loop ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
  return {
    maxIterations: num(loop.maxIterations, DEFAULT_MAX_ITERATIONS),
    maxWallClockMs: num(loop.maxWallClockMs, DEFAULT_MAX_WALL_CLOCK_MS),
    noProgressLimit: num(loop.noProgressLimit, DEFAULT_NO_PROGRESS_LIMIT),
  };
}

/**
 * A cheap fingerprint of the working tree plus the plan.
 *
 * Used only to answer "did anything change since the last failed gate?".
 * `git status --porcelain` covers edits, and the plan revision covers task
 * updates that leave no file trace. Outside a git repo we fall back to the
 * plan alone, which still catches the common spin.
 */
export async function fingerprint(targetDir: string): Promise<string> {
  const parts: string[] = [];
  const r = await run("git status --porcelain", { cwd: targetDir, timeoutMs: 15_000 });
  if (r.ok) parts.push(r.stdout);
  const head = await run("git rev-parse HEAD", { cwd: targetDir, timeoutMs: 10_000 });
  if (head.ok) parts.push(head.stdout);
  try {
    const { list } = loadFeatureList(targetDir);
    parts.push(String(list.baseRevision));
    parts.push(
      (list.features ?? [])
        .flatMap((f) => (f.tasks ?? []).map((t) => `${t.id}:${t.status}`))
        .join(","),
    );
  } catch {
    /* plan unreadable — the git half still fingerprints */
  }
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

export type DecideOptions = {
  targetDir: string;
  runId: string;
  now?: Date;
  /** Skip the gate run. Used by callers that already have a verdict. */
  skipGate?: boolean;
};

/**
 * Decide what happens after the agent settles.
 *
 * Order matters: human brakes first, then terminal conditions, then budgets,
 * then the gate. A paused run must stop even if the gate would pass.
 */
export async function decideNext(options: DecideOptions): Promise<{ decision: LoopDecision; state: LoopState }> {
  const { targetDir, runId } = options;
  const now = options.now ?? new Date();
  const state = loadLoopState(targetDir, runId, now);
  state.iterations += 1;

  const finish = (decision: LoopDecision): { decision: LoopDecision; state: LoopState } => {
    state.lastDecision = decision.action;
    if (decision.action === "stop") {
      state.stoppedAt = now.toISOString();
      state.stopReason = decision.reason;
    }
    saveLoopState(targetDir, state);
    return { decision, state };
  };

  // -- human brakes ---------------------------------------------------------
  if (fileExists(stopFilePath(targetDir))) {
    return finish({
      action: "stop",
      reason: "stop-file",
      detail: `harness/${STOP_FILE} exists — delete it to resume.`,
    });
  }

  const { config, ok } = loadConfig(targetDir);
  if (!ok) {
    return finish({
      action: "stop",
      reason: "no-config",
      detail: "harness/config.json is missing or unreadable.",
    });
  }
  if (config.paused) {
    return finish({
      action: "wait",
      reason: "paused",
      detail: "The pipeline is paused. Unpause to continue.",
    });
  }

  state.lastPhase = config.currentPhase;

  // -- terminal conditions --------------------------------------------------
  const { list } = loadFeatureList(targetDir);
  const progress = computeProgress(list);
  const allTasksDone = progress.tasksTotal > 0 && progress.tasksDone === progress.tasksTotal;

  if (isFinalPhase(config.currentPhase, config.phases?.enabled) && allTasksDone) {
    return finish({
      action: "stop",
      reason: "complete",
      detail: `Pipeline complete: ${progress.tasksDone}/${progress.tasksTotal} tasks across ${progress.featuresTotal} feature(s).`,
    });
  }

  const exhausted = isRetryExhausted(config);
  if (exhausted.exhausted) {
    return finish({
      action: "stop",
      reason: "retry-budget",
      detail: `The ${exhausted.which} retry budget is exhausted. A human needs to look at this.`,
    });
  }

  // -- budgets --------------------------------------------------------------
  const budget = budgetFrom(config);
  if (state.iterations > budget.maxIterations) {
    return finish({
      action: "stop",
      reason: "max-iterations",
      detail: `Reached the ${budget.maxIterations}-iteration ceiling for this run.`,
    });
  }
  const elapsed = now.getTime() - new Date(state.startedAt).getTime();
  if (elapsed > budget.maxWallClockMs) {
    const hours = (budget.maxWallClockMs / 3_600_000).toFixed(1);
    return finish({
      action: "stop",
      reason: "max-wall-clock",
      detail: `Run exceeded its ${hours}h wall-clock budget.`,
    });
  }

  // -- the gate -------------------------------------------------------------
  const phase = config.currentPhase;
  if (!phase) {
    return finish({
      action: "wait",
      reason: "not-started",
      detail: "No current phase. Initialise the harness before running the loop.",
    });
  }

  const gate = options.skipGate ? null : await runChecks(targetDir, phase, { record: true });

  if (gate && gate.overall) {
    state.noProgressStreak = 0;
    state.lastFingerprint = await fingerprint(targetDir);

    const upcoming = nextPhase(phase, config.phases?.enabled);
    if (upcoming === null) {
      return finish({
        action: "stop",
        reason: "complete",
        detail: `Gate passed on the final phase (${phase}).`,
      });
    }

    const moved = await advancePhase(targetDir);
    if (!moved.ok) {
      return finish({
        action: "wait",
        reason: "advance-failed",
        detail: moved.error ?? "phase advance failed",
      });
    }

    const brief = await buildBrief(targetDir);
    return finish({
      action: "advanced",
      toPhase: upcoming,
      message: renderBrief(brief, moved.config ?? undefined),
      reason: `gate passed on ${phase}`,
    });
  }

  // Gate failed (or was skipped). Is the agent actually making progress?
  //
  // The first failure of a run has no baseline to compare against, so it is
  // never counted as a stall: the streak starts only once we have seen the
  // tree twice and it did not move. Capture the previous fingerprint before
  // overwriting it, or the comparison is always against itself.
  const previous = state.lastFingerprint;
  const fp = await fingerprint(targetDir);
  state.lastFingerprint = fp;

  if (previous === null || previous !== fp) {
    state.noProgressStreak = 0;
  } else {
    state.noProgressStreak += 1;
  }

  if (state.noProgressStreak >= budget.noProgressLimit) {
    return finish({
      action: "stop",
      reason: "no-progress",
      detail:
        `The gate has failed ${state.noProgressStreak} times in a row with no change to the working tree ` +
        `or the plan. The agent is looping without making progress` +
        (gate ? `: ${gate.failures.join(", ")}` : "") +
        `. Stopping so a human can intervene.`,
    });
  }

  // Charge a phase retry so the configured budget still bounds the run even
  // when the tree keeps changing but the gate never opens.
  const fresh = loadConfig(targetDir);
  if (fresh.ok) {
    incrementPhaseRetry(fresh.config);
    saveConfig(targetDir, fresh.config);
  }

  const brief = await buildBrief(targetDir);
  const failures = gate
    ? gate.checks
        .filter((c) => !c.pass)
        .map((c) => `  x ${c.name}: ${c.detail}`)
        .join("\n")
    : "(gate not run)";

  const task = nextActionableTask(list);
  const focus = task ? `\nCurrent task: ${task.compositeKey} — ${task.description}` : "";

  return finish({
    action: "continue",
    reason: "gate failed",
    message:
      `The ${phase.toUpperCase()} gate did not pass. Fix exactly these, then stop talking — ` +
      `the harness will re-validate automatically.\n\n${failures}${focus}\n\n` +
      renderBrief(brief, fresh.ok ? fresh.config : undefined),
  });
}

/** Human-readable one-liner for the status bar / notify. */
export function describeDecision(d: LoopDecision): string {
  switch (d.action) {
    case "continue":
      return `continuing — ${d.reason}`;
    case "advanced":
      return `advanced to ${d.toPhase}`;
    case "wait":
      return `waiting — ${d.detail}`;
    case "stop":
      return `stopped — ${d.detail}`;
  }
}
