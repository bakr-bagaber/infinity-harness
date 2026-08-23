/**
 * infinity-harness — the escalation ladder, actually connected.
 *
 * `unstuck.ts` has always been able to choose what to do when a run stalls:
 * retry → reframe → consult → rework → replan → master, with budgets,
 * fingerprint dedup and a cooldown. It picks a strategy name and returns it.
 *
 * Nothing ever executed one. There was a chooser and no actuator, so
 * `chooseUnstuckStrategy` was called by its own tests and by nothing else,
 * and `/infinity:run` did the only thing it could when the gate kept failing:
 * count strikes and stop. A run that could have escalated to a stronger model,
 * reworked the task that poisoned everything downstream, or amended a plan
 * that turned out to be wrong instead sat there failing the same check three
 * times and gave up.
 *
 * This module is the actuator. It asks `unstuck` what to do, does the part
 * that is ours to do — flipping tasks to `rework`, naming the model to
 * escalate to — and returns an instruction the agent can act on for the part
 * that is the agent's.
 *
 * It deliberately does not implement `replan` itself. Inventing the tasks a
 * stuck plan is missing is a modelling job, not a control-flow job; the ladder
 * tells the agent to amend the plan and hands it `infinity_replan`.
 */

import { loadFeatureList, flattenTasks, type FlatTask } from "./core/featureList.ts";
import type { Phase } from "./core/types.ts";
import { chooseUnstuckStrategy, type UnstuckStrategy } from "./unstuck.ts";
import { shouldBounceToRework } from "./review.ts";
import { startRework, loadRework } from "./rework.ts";
import { loadReplanHistory } from "./replan.ts";
import { loadRouterConfig } from "./modelRouter.ts";

export type EscalationState = {
  /** How many times this run has consulted a stronger model. */
  consultedCount: number;
  /** MASTER is a one-shot. */
  masterUsed: boolean;
  /** ISO timestamp of the last escalation, for the cooldown. */
  lastUnstuckAt: string | null;
  /** Working-tree fingerprints already seen, for dedup. */
  fingerprints: string[];
  /** Rungs already taken during this stall, so the ladder climbs. */
  tried: UnstuckStrategy[];
};

export function emptyEscalationState(): EscalationState {
  return { consultedCount: 0, masterUsed: false, lastUnstuckAt: null, fingerprints: [], tried: [] };
}

export type Escalation = {
  strategy: UnstuckStrategy | null;
  /** Why this strategy, in words the human reading the log will understand. */
  reason: string;
  /** What the agent should now do. Null when nothing can be done. */
  instruction: string | null;
  /** The model to escalate to, for `consult` and `master`. */
  model: string | null;
  /** What this actually changed on disk, if anything. */
  applied: string | null;
  /** The state to carry into the next decision. */
  next: EscalationState;
};

export type EscalateOptions = {
  targetDir: string;
  runId: string;
  phase: Phase;
  /** The gate's failing checks, so the instruction can name them. */
  failures: string[];
  /** Whether the working tree moved since the last attempt. */
  fileDelta: boolean;
  /** Fingerprint of the current attempt. */
  fingerprint: string;
  state: EscalationState;
  now?: Date;
};

/** Fingerprints kept for dedup. Older ones tell us nothing. */
const FINGERPRINT_WINDOW = 12;

/**
 * Decide what to do about a stalled run, and do the part that is ours.
 *
 * Never throws: an escalation that fails is a run that continues without one,
 * not a run that dies. The failure is reported in `reason`, because a silent
 * fallback to "retry" would look exactly like a healthy ladder.
 */
export async function escalate(options: EscalateOptions): Promise<Escalation> {
  const { targetDir, phase, state } = options;
  const now = options.now ?? new Date();

  const carry = (strategy: UnstuckStrategy | null, over: Partial<EscalationState> = {}): EscalationState => ({
    ...state,
    ...over,
    lastUnstuckAt: now.toISOString(),
    fingerprints: [...state.fingerprints, options.fingerprint].slice(-FINGERPRINT_WINDOW),
    tried: strategy && !state.tried.includes(strategy) ? [...state.tried, strategy] : state.tried,
  });

  const { list } = loadFeatureList(targetDir);
  const tasks = flattenTasks(list);
  const task = currentTask(tasks);

  // REVIEW is its own decision before the general ladder. A failing review is
  // not the reviewer being stuck; it is the reviewer saying the work is wrong,
  // and the answer to that is going back to the work.
  if (phase === "review") {
    // `shouldBounceToRework` reads its own bounce count from rework.json,
    // which is the right source: bounces are reworks, not replans.
    const bounce = shouldBounceToRework({ projectDir: targetDir, fileDelta: options.fileDelta });
    if (bounce.shouldBounce && task) {
      const applied = await applyRework(options, task, "review bounce");
      return {
        strategy: "rework",
        reason: `review bounce: ${bounce.reason}`,
        instruction: reworkInstruction(task, applied.impacted, options.failures),
        model: null,
        applied: applied.detail,
        next: carry("rework"),
      };
    }
  }

  let choice;
  try {
    choice = chooseUnstuckStrategy({
      projectDir: targetDir,
      featureId: task?.featureId,
      taskId: task?.id,
      attemptFingerprints: state.fingerprints,
      currentFingerprint: options.fingerprint,
      fileDelta: options.fileDelta,
      tried: state.tried,
      // A stall is defined by the tree not having moved, so the delta guard —
      // which exists for review bounces — must not veto the rungs that exist
      // for exactly this situation.
      requireDeltaForRework: false,
      lastUnstuckAt: state.lastUnstuckAt ?? undefined,
      consultedCount: state.consultedCount,
      currentDifficulty: task?.difficulty ?? null,
      masterUsed: state.masterUsed,
    });
  } catch (e) {
    return {
      strategy: null,
      reason: `the escalation ladder could not run: ${message(e)}`,
      instruction: null,
      model: null,
      applied: null,
      next: carry(null),
    };
  }

  const failureList = options.failures.length
    ? options.failures.map((f) => `  - ${f}`).join("\n")
    : "  - (the gate reported no detail)";

  switch (choice.strategy) {
    case "retry":
      return {
        strategy: "retry",
        reason: choice.reason,
        instruction:
          `The ${phase.toUpperCase()} gate failed again and the working tree has not moved. One ` +
          `more attempt before this changes tack — go straight at the failure, and change ` +
          `something real this time:\n${failureList}`,
        model: null,
        applied: null,
        next: carry("retry"),
      };

    case "reframe":
      return {
        strategy: "reframe",
        reason: choice.reason,
        instruction:
          `STOP AND REFRAME. The same gate has now failed repeatedly with the same result, which ` +
          `means the approach is wrong, not incomplete. Before writing another line:\n` +
          `  1. State the assumption you have been working under.\n` +
          `  2. Say why the evidence contradicts it — quote the failure.\n` +
          `  3. Describe a different approach, and only then implement it.\n\n` +
          `Still failing:\n${failureList}`,
        model: null,
        applied: null,
        next: carry("reframe"),
      };

    case "consult": {
      const model = choice.nextModel ?? null;
      return {
        strategy: "consult",
        reason: choice.reason,
        instruction:
          `ESCALATE. Reframing did not shift this either, so it is going to a stronger model` +
          (model ? `: ${model}` : "") +
          `. Write down, precisely, what you have tried and what the failure actually says — ` +
          `that hand-off is the whole value of the escalation.\n\nStill failing:\n${failureList}`,
        model,
        applied: model ? `consulting ${model}` : null,
        next: carry("consult", { consultedCount: state.consultedCount + 1 }),
      };
    }

    case "rework": {
      if (!task) {
        return {
          strategy: null,
          reason: "rework was chosen but there is no actionable task to rework",
          instruction: null,
          model: null,
          applied: null,
          next: carry(null),
        };
      }
      const applied = await applyRework(options, task, `stuck on ${phase}`);
      if (applied.error) {
        return {
          strategy: null,
          reason: `rework failed: ${applied.error}`,
          instruction: null,
          model: null,
          applied: null,
          next: carry(null),
        };
      }
      return {
        strategy: "rework",
        reason: choice.reason,
        instruction: reworkInstruction(task, applied.impacted, options.failures),
        model: null,
        applied: applied.detail,
        next: carry("rework"),
      };
    }

    case "replan":
      return {
        strategy: "replan",
        reason: choice.reason,
        instruction:
          `THE PLAN IS WRONG. Retrying, reframing and reworking have all failed, which points at ` +
          `the plan rather than the work: something this needs was never planned. Call ` +
          `\`infinity_replan\` to add the missing sprints, features or tasks — do not invent them ` +
          `in code and leave the plan stale.\n\nStill failing:\n${failureList}`,
        model: null,
        applied: null,
        next: carry("replan"),
      };

    case "master": {
      const model = masterModel(targetDir);
      return {
        strategy: "master",
        reason: choice.reason,
        instruction:
          `LAST RESORT. Every other rung of the ladder is spent` +
          (model ? `, so this goes to the master model: ${model}` : "") +
          `. State the problem from scratch, as if to someone who has not seen any of the ` +
          `previous attempts, and include what has already been ruled out.\n\n` +
          `Still failing:\n${failureList}`,
        model,
        applied: model ? `escalated to master (${model})` : null,
        next: carry("master", { masterUsed: true }),
      };
    }

    default:
      return {
        strategy: null,
        reason: choice.reason || "no strategy available",
        instruction: null,
        model: null,
        applied: null,
        next: carry(null),
      };
  }
}

/**
 * The task the run is stuck on: whatever is in flight, else the first thing
 * that is not finished. `rework` needs a specific origin to walk out from.
 */
function currentTask(tasks: FlatTask[]): FlatTask | null {
  return (
    tasks.find((t) => t.status === "in_progress") ??
    tasks.find((t) => t.status === "rework") ??
    tasks.find((t) => t.status !== "complete") ??
    null
  );
}

async function applyRework(
  options: EscalateOptions,
  task: FlatTask,
  reason: string,
): Promise<{ impacted: string[]; detail: string | null; error?: string }> {
  try {
    const result = await startRework({
      projectDir: options.targetDir,
      featureId: task.featureId,
      taskId: task.id,
      key: task.key,
      reason,
      runId: options.runId,
    });
    const detail =
      `flipped ${task.compositeKey}` +
      (result.impacted.length ? ` and ${result.impacted.length} dependent task(s)` : "") +
      ` to rework (plan revision ${result.baseRevision})`;
    return { impacted: result.impacted, detail };
  } catch (e) {
    return { impacted: [], detail: null, error: message(e) };
  }
}

function reworkInstruction(task: FlatTask, impacted: string[], failures: string[]): string {
  const downstream = impacted.length
    ? `Everything that depends on it went with it: ${impacted.join(", ")}. ` +
      `They were built on the broken thing, so they are suspect until re-proved.`
    : `Nothing depends on it, so this is contained.`;
  return (
    `REWORK. This task has been flipped back to \`rework\` because the work built on it does not ` +
    `hold up:\n  ${task.compositeKey} — ${task.description}\n\n${downstream}\n\n` +
    `Fix the root task first, then re-prove the rest. Failing checks:\n` +
    (failures.length ? failures.map((f) => `  - ${f}`).join("\n") : "  - (no detail)")
  );
}

function masterModel(targetDir: string): string | null {
  try {
    const router = loadRouterConfig(targetDir);
    const master = (router as { master?: unknown }).master;
    return typeof master === "string" && master.trim() ? master.trim() : null;
  } catch {
    return null;
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A one-line summary for the widget, the log, and the human coming back. */
export function describeEscalation(e: Escalation): string {
  if (!e.strategy) return `no escalation available — ${e.reason}`;
  return `${e.strategy}: ${e.reason}${e.applied ? ` (${e.applied})` : ""}`;
}

/** Where the run currently sits on the ladder, for the status surfaces. */
export function escalationSummary(targetDir: string): { reworks: number; replans: number; returnTo: string | null } {
  let reworks = 0;
  let returnTo: string | null = null;
  try {
    const record = loadRework(targetDir);
    if (record) {
      returnTo = `${record.returnFeature}/${record.returnTask}`;
      reworks = 1;
    }
  } catch {
    /* absent is not an error */
  }
  let replans = 0;
  try {
    replans = loadReplanHistory(targetDir).length;
  } catch {
    /* absent is not an error */
  }
  return { reworks, replans, returnTo };
}
