/**
 * infinity-harness — the goal loop, connected to the pipeline.
 *
 * `goalSpec`, `goalLoop` and `goalState` are a complete outer loop: state a
 * goal, do a pass of work, judge whether the goal is actually met, and go
 * round again if it is not, under iteration and wall-clock limits. Ported from
 * pi-long-task, 1,600 lines, fully typed, well tested.
 *
 * And nothing ever turned the crank. `createGoalLoopState` was called by its
 * own tests and by nothing else. The three modules were a state machine with
 * no driver — which is why the harness could finish a pipeline and declare
 * "complete" without anyone ever asking the only question that matters: is the
 * thing the human asked for actually done?
 *
 * This module is the driver, and the mapping it chooses is the whole design:
 *
 *   one goal iteration  =  one full pass of the phase pipeline
 *
 * DEFINE→SHIP produces work; the goal loop then asks whether that work met the
 * goal. If it did, the run is over. If it did not, the pipeline is rewound to
 * DEFINE with the remaining work named, and the next iteration begins. The
 * gate decides whether the *work* is done; the goal loop decides whether the
 * *goal* is done. They are different questions and the harness needed both.
 *
 * The reviewer's verdict comes from the agent, not from here. Whether a body
 * of work satisfies a stated goal is a judgement, and the harness's rule is
 * that judgements belong to the model while enforcement belongs to the gate.
 * What this module enforces is that the judgement is recorded, bounded, and
 * has consequences.
 */

import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  createGoalLoopState,
  startGoalIteration,
  recordGeneratedTodo,
  recordWorkerResult,
  recordReviewerResult,
  cancelGoalLoop,
  goalLoopStopReason,
  type GoalLoopState,
  type GoalReviewerDecision,
} from "./goalLoop.ts";
import { GoalStateStore, canonicalGoalSpecPath } from "./goalState.ts";
import { createGoalSpecification, type GoalSpecification } from "./goalSpec.ts";
import { loadConfig, saveConfig } from "./core/config.ts";
import { loadFeatureList, computeProgress } from "./core/featureList.ts";
import { writeTaskList } from "./taskList.ts";
import { harnessDir } from "./core/paths.ts";
import { readJsonSafe, writeJsonAtomic } from "./core/fsx.ts";
import { getPhaseOrder } from "./core/phases.ts";
import { PHASE_ROLE, type Phase } from "./core/types.ts";

/** Which goal run this project is on, so a new session can find it. */
export const GOAL_POINTER_FILE = "goal.json";

type GoalPointer = { goalRunId: string; goalRunDir: string; startedAt: string };

export function goalPointerPath(targetDir: string): string {
  return resolve(harnessDir(targetDir), GOAL_POINTER_FILE);
}

function readPointer(targetDir: string): GoalPointer | null {
  return readJsonSafe<GoalPointer | null>(goalPointerPath(targetDir), null);
}

function storeFor(targetDir: string, pointer: GoalPointer): GoalStateStore {
  return new GoalStateStore({
    cwd: targetDir,
    goalRunId: pointer.goalRunId,
    goalRunDir: pointer.goalRunDir,
  });
}

export type GoalView = {
  goal: string;
  goalRunId: string;
  status: GoalLoopState["status"];
  phase: GoalLoopState["phase"];
  iteration: number;
  maxIterations: number;
  /** What the last review said is still missing. */
  remainingWork: string[];
  /** Set once the loop reaches a terminal state. */
  completion: GoalLoopState["completion"];
  startedAt: string;
  deadlineAt?: string;
};

export function viewOf(state: GoalLoopState): GoalView {
  const last = state.iterations[state.iterations.length - 1];
  return {
    goal: state.goal,
    goalRunId: state.goalRunId,
    status: state.status,
    phase: state.phase,
    iteration: state.currentIteration,
    maxIterations: state.limits.maxIterations,
    remainingWork: last?.reviewerResult?.remainingWork ?? [],
    completion: state.completion,
    startedAt: state.startedAt,
    deadlineAt: state.deadlineAt,
  };
}

/** The goal run this project is on, or null. Never throws. */
export async function loadGoal(targetDir: string): Promise<GoalLoopState | null> {
  const pointer = readPointer(targetDir);
  if (!pointer) return null;
  try {
    return await storeFor(targetDir, pointer).loadState();
  } catch {
    return null;
  }
}

export type StartGoalOptions = {
  targetDir: string;
  goal: string;
  runId: string;
  maxIterations?: number;
  timeoutMs?: number;
  now?: Date;
};

/**
 * State a goal and open iteration 1.
 *
 * The goal specification is written to `harness/goals/GOAL_SPEC.json` — a
 * committed, human-readable statement of what this run is for — while the
 * loop's own state lives under `tmp/`, because it is run bookkeeping and
 * nobody wants it in a diff.
 */
export async function startGoal(options: StartGoalOptions): Promise<{ state: GoalLoopState; spec: GoalSpecification }> {
  const { targetDir, runId } = options;
  const goal = options.goal.trim();
  if (!goal) throw new Error("a goal needs to say something");

  const existing = await loadGoal(targetDir);
  if (existing && existing.status === "running") {
    throw new Error(
      `This project is already pursuing a goal: "${existing.goal}". ` +
        `Finish it or cancel it (/infinity:goal cancel) before starting another.`,
    );
  }

  const spec = createGoalSpecification({ goalRunId: runId, originalGoal: goal, now: () => options.now ?? new Date() });
  let state = createGoalLoopState({
    goal,
    goalRunId: runId,
    cwd: targetDir,
    maxIterations: options.maxIterations,
    timeoutMs: options.timeoutMs,
    now: () => options.now ?? new Date(),
  });
  state = startGoalIteration(state, { now: options.now });

  const store = new GoalStateStore({ cwd: targetDir, goalRunId: runId, goalRunDir: state.goalRunDir });
  await store.ensureRunDir();
  await store.saveGoalSpecificationWithCanonical(spec, targetDir);
  await store.saveState(state);
  writeJsonAtomic(goalPointerPath(targetDir), {
    goalRunId: runId,
    goalRunDir: state.goalRunDir,
    startedAt: state.startedAt,
  } satisfies GoalPointer);

  // The goal also becomes the pipeline's goal, so every brief carries it.
  rewindPipeline(targetDir, goal, [], 1, state.limits.maxIterations);
  return { state, spec };
}

/**
 * Record that the pipeline has produced a pass of work.
 *
 * Called when the phase pipeline completes. Moves the iteration through
 * `todo_generated` → `todo_executed`, which is what makes it reviewable.
 */
export async function recordPipelinePass(
  targetDir: string,
  summary: string,
  now?: Date,
): Promise<GoalLoopState | null> {
  const pointer = readPointer(targetDir);
  if (!pointer) return null;
  const store = storeFor(targetDir, pointer);
  let state: GoalLoopState;
  try {
    state = await store.loadState();
  } catch {
    return null;
  }
  if (state.status !== "running") return state;

  const iteration = state.currentIteration;
  const { list } = loadFeatureList(targetDir);
  const progress = computeProgress(list);
  const at = (now ?? new Date()).toISOString();

  if (state.phase === "goal_received") {
    state = recordGeneratedTodo(
      state,
      iteration,
      { todoPath: "harness/features/feature-list.json", summary: `${progress.tasksTotal} task(s) planned`, generatedAt: at },
      { now },
    );
  }
  if (state.phase === "todo_generated") {
    state = recordWorkerResult(
      state,
      iteration,
      {
        status: progress.tasksDone === progress.tasksTotal ? "done" : "partial",
        summary,
        totalTasks: progress.tasksTotal,
        completedTasks: progress.tasksDone,
        endedAt: at,
      },
      { now },
    );
  }
  await store.saveState(state);
  return state;
}

export type ReviewInput = {
  decision: GoalReviewerDecision;
  rationale: string;
  remainingWork?: string[];
  summary?: string;
};

export type ReviewOutcome = {
  state: GoalLoopState;
  /** True when the goal loop is finished, either way. */
  terminal: boolean;
  /** Set when another pass begins: the pipeline was rewound to here. */
  rewoundTo: Phase | null;
  message: string;
};

/**
 * Judge whether the work meets the goal, and act on the answer.
 *
 * A `complete` verdict ends the run. Anything else opens the next iteration
 * and rewinds the pipeline, because the harness has no other way to do more
 * work: the phase machine is forward-only, so a second pass means starting a
 * second pass, with the remaining work stated up front.
 */
export async function reviewGoal(
  targetDir: string,
  input: ReviewInput,
  now?: Date,
): Promise<ReviewOutcome> {
  const pointer = readPointer(targetDir);
  if (!pointer) throw new Error("No goal is being pursued in this project. Start one with /infinity:goal.");
  const store = storeFor(targetDir, pointer);
  let state = await store.loadState();

  if (state.status !== "running") {
    return { state, terminal: true, message: `The goal loop already finished: ${state.status}.`, rewoundTo: null };
  }

  const at = (now ?? new Date()).toISOString();
  const remainingWork = (input.remainingWork ?? []).map((s) => s.trim()).filter(Boolean);
  if (input.decision !== "complete" && remainingWork.length === 0) {
    // "Not done" with nothing named is not a review, it is a shrug — and the
    // next iteration would start with no more information than this one had.
    throw new Error(
      `A "${input.decision}" verdict must name what is still missing (remainingWork). ` +
        `The next pass is planned from that list.`,
    );
  }

  state = recordReviewerResult(
    state,
    state.currentIteration,
    {
      decision: input.decision,
      complete: input.decision === "complete",
      summary: input.summary?.trim() || input.rationale.trim(),
      rationale: input.rationale.trim(),
      remainingWork,
      reviewedAt: at,
    },
    { now },
  );

  if (state.status !== "running") {
    await store.saveState(state);
    await store.initializeResultIfMissing(state);
    return {
      state,
      terminal: true,
      rewoundTo: null,
      message:
        state.status === "done"
          ? `Goal met after ${state.iterations.length} pass(es): ${state.goal}`
          : `Goal loop ended ${state.status}: ${state.completion?.reason ?? input.rationale}`,
    };
  }

  // Not done, and not fatal: go round again — unless a limit says otherwise.
  const stop = goalLoopStopReason(state, { now });
  if (stop) {
    state = cancelGoalLoop(state, stop.message, { now });
    await store.saveState(state);
    await store.initializeResultIfMissing(state);
    return { state, terminal: true, rewoundTo: null, message: `Goal loop stopped: ${stop.message}` };
  }

  state = startGoalIteration(state, { now });
  await store.saveState(state);
  const phase = rewindPipeline(
    targetDir,
    state.goal,
    remainingWork,
    state.currentIteration,
    state.limits.maxIterations,
  );
  return {
    state,
    terminal: false,
    rewoundTo: phase,
    message:
      `Pass ${state.currentIteration - 1} did not meet the goal. Starting pass ${state.currentIteration} at ` +
      `${phase.toUpperCase()} with ${remainingWork.length} item(s) still to do:\n` +
      remainingWork.map((w) => `  - ${w}`).join("\n"),
  };
}

/** Stop pursuing the goal, on purpose. */
export async function cancelGoal(targetDir: string, reason: string, now?: Date): Promise<GoalLoopState | null> {
  const pointer = readPointer(targetDir);
  if (!pointer) return null;
  const store = storeFor(targetDir, pointer);
  let state: GoalLoopState;
  try {
    state = await store.loadState();
  } catch {
    return null;
  }
  if (state.status !== "running") return state;
  state = cancelGoalLoop(state, reason, { now });
  await store.saveState(state);
  await store.initializeResultIfMissing(state);
  return state;
}

/**
 * Point the pipeline at the goal and send it back to the first phase.
 *
 * The phase machine is forward-only by design — the agent must not be able to
 * decide it is bored of BUILD. Rewinding is therefore not something the agent
 * can do; it happens here, once, when a review says the goal is not met, and
 * it is recorded in the goal trace.
 */
function rewindPipeline(
  targetDir: string,
  goal: string,
  remainingWork: string[] = [],
  pass = 1,
  maxPasses = 1,
): Phase {
  // The goal belongs in the plan, not the config: `harness/features/feature-list.json`
  // is the single source of truth the brief, the widget and the dashboard all
  // read. Writing it anywhere else means a goal nothing displays.
  try {
    writeTaskList(targetDir, { goal });
  } catch {
    // A plan too broken to accept a goal is a problem the gate will report;
    // it must not stop the goal loop from being recorded.
  }

  const { config, ok } = loadConfig(targetDir);
  if (!ok) return "define";
  const order = getPhaseOrder(config.phases?.enabled);
  const first = order[0] ?? "define";
  config.currentPhase = first;
  config.currentRole = PHASE_ROLE[first];
  config.remainingWork = remainingWork;
  config.goalPass = pass;
  config.goalMaxPasses = maxPasses;
  // A new pass starts with fresh retry budgets. The old ones were spent on
  // work that turned out to be insufficient, not on work that was wrong.
  config.taskRetryCount = 0;
  config.featureRetryCount = 0;
  config.phaseRetryCount = 0;
  saveConfig(targetDir, config);
  return first;
}

/** The canonical goal specification, if one has been written. */
export function readGoalSpec(targetDir: string): GoalSpecification | null {
  const path = canonicalGoalSpecPath(targetDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as GoalSpecification;
  } catch {
    return null;
  }
}

/** One line for the widget and the status command. */
export function describeGoal(view: GoalView): string {
  if (view.status !== "running") {
    return `goal ${view.status}: ${view.goal}`;
  }
  return `goal pass ${view.iteration}/${view.maxIterations} · ${view.goal}`;
}
