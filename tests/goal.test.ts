/**
 * The goal loop, connected.
 *
 * `goalSpec`, `goalLoop` and `goalState` are 1,600 lines of complete,
 * well-tested outer loop — state a goal, do a pass, judge whether the goal is
 * actually met, go round again if it is not, under limits. And nothing ever
 * turned the crank, which meant the harness could finish a pipeline and
 * declare "complete" without anyone ever asking whether the thing the human
 * asked for was done.
 *
 * The mapping this driver chooses is the design: one goal iteration is one
 * full pass of the phase pipeline. The gate decides whether the WORK is done.
 * The goal loop decides whether the GOAL is done. They are different
 * questions, and a harness meant to run for days needs both.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initHarness } from "../src/core/init.ts";
import { loadConfig, saveConfig } from "../src/core/config.ts";
import { loadFeatureList } from "../src/core/featureList.ts";
import { buildBrief, renderBrief } from "../src/core/brief.ts";
import { writeTaskList } from "../src/taskList.ts";
import {
  startGoal,
  loadGoal,
  reviewGoal,
  cancelGoal,
  recordPipelinePass,
  readGoalSpec,
  viewOf,
  describeGoal,
  goalPointerPath,
} from "../src/goal.ts";

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-goal-"));
  initHarness(dir);
  return dir;
}

/** Walk the config to the last phase with every task done. */
function finishPipeline(dir: string): void {
  writeTaskList(dir, {
    features: [{ id: "feature-001", name: "F", criteria: ["it works"] }],
    tasks: [{ key: "feature-001/task-001", subject: "the work", status: "complete" }],
  });
  const { config } = loadConfig(dir);
  config.currentPhase = "ship";
  config.currentRole = "evaluator";
  saveConfig(dir, config);
}

// ── stating a goal ─────────────────────────────────────────────────────────
{
  const dir = project();
  const { state, spec } = await startGoal({
    targetDir: dir,
    goal: "Ship the payments rewrite behind a flag",
    runId: "goal-1",
  });

  assert.equal(state.status, "running");
  assert.equal(state.currentIteration, 1, "stating a goal opens pass 1");
  assert.equal(spec.originalGoal, "Ship the payments rewrite behind a flag");
  assert.ok(existsSync(goalPointerPath(dir)), "a new session can find the run");

  // The specification is committed, human-readable, and traceable to what was
  // actually asked for.
  const onDisk = readGoalSpec(dir);
  assert.ok(onDisk, "the goal specification is written where a human can read it");
  assert.equal(onDisk!.traceability.originalUserGoal, "Ship the payments rewrite behind a flag");

  // And it reaches the brief, because the goal lives in the plan — the one
  // source of truth the brief, widget and dashboard all read.
  assert.equal(loadFeatureList(dir).list.goals?.[0]?.title, "Ship the payments rewrite behind a flag");
  const brief = await buildBrief(dir);
  assert.match(renderBrief(brief), /GOAL     Ship the payments rewrite behind a flag/);

  rmSync(dir, { recursive: true, force: true });
  console.log("✓ a goal is stated once and shows up everywhere that reads the plan");
}

// One at a time: two live goals means neither is the goal.
{
  const dir = project();
  await startGoal({ targetDir: dir, goal: "First", runId: "goal-1" });
  await assert.rejects(
    () => startGoal({ targetDir: dir, goal: "Second", runId: "goal-2" }),
    /already pursuing a goal/,
  );
  await cancelGoal(dir, "changed my mind");
  const after = await startGoal({ targetDir: dir, goal: "Second", runId: "goal-2" });
  assert.equal(after.state.goal, "Second", "cancelling frees it");
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ one goal at a time, and cancelling releases it");
}

{
  const dir = project();
  await assert.rejects(() => startGoal({ targetDir: dir, goal: "   ", runId: "g" }), /needs to say something/);
  assert.equal(await loadGoal(dir), null, "a project with no goal says so rather than throwing");
  rmSync(dir, { recursive: true, force: true });
}

// ── the review is the point ────────────────────────────────────────────────
{
  const dir = project();
  await startGoal({ targetDir: dir, goal: "Make the thing good", runId: "goal-1" });
  finishPipeline(dir);
  const recorded = await recordPipelinePass(dir, "one pass done");
  assert.ok(recorded, "a finished pipeline is recorded against the goal");
  assert.equal(recorded!.phase, "todo_executed", "and becomes reviewable");

  // "Not done" with nothing named is a shrug, and the next pass would start no
  // better informed than this one.
  await assert.rejects(
    () => reviewGoal(dir, { decision: "incomplete", rationale: "not there yet" }),
    /must name what is still missing/,
  );

  const outcome = await reviewGoal(dir, {
    decision: "incomplete",
    rationale: "the flag is missing and nothing is measured",
    remainingWork: ["put it behind a feature flag", "add the latency metric"],
  });
  assert.equal(outcome.terminal, false);
  assert.equal(outcome.rewoundTo, "define", "another pass starts at the first phase");
  assert.match(outcome.message, /Starting pass 2/);

  // The pipeline really moved, and the retry budgets came back with it.
  const { config } = loadConfig(dir);
  assert.equal(config.currentPhase, "define");
  assert.equal(config.currentRole, "planner");
  assert.equal(config.phaseRetryCount, 0, "a new pass gets fresh budgets");

  // And the next brief says what is left, so the agent does not re-plan the
  // whole goal from scratch and rebuild what the review already accepted.
  const brief = await buildBrief(dir);
  const text = renderBrief(brief);
  assert.match(text, /judged not yet met/);
  assert.match(text, /put it behind a feature flag/);
  assert.match(text, /add the latency metric/);

  rmSync(dir, { recursive: true, force: true });
  console.log("✓ an unmet goal rewinds the pipeline and carries the remaining work into the brief");
}

// A met goal ends the run.
{
  const dir = project();
  await startGoal({ targetDir: dir, goal: "Make the thing good", runId: "goal-1" });
  finishPipeline(dir);
  await recordPipelinePass(dir, "done");
  const outcome = await reviewGoal(dir, {
    decision: "complete",
    rationale: "every acceptance criterion is met and proved",
  });
  assert.equal(outcome.terminal, true);
  assert.equal(outcome.state.status, "done");
  assert.match(outcome.message, /Goal met after 1 pass/);

  const view = viewOf(outcome.state);
  assert.match(describeGoal(view), /goal done/);
  assert.ok(existsSync(join(outcome.state.goalRunDir, "GOAL_RESULT.md")), "the run leaves a result behind");

  // Reviewing a finished loop is a no-op, not a second ending.
  const again = await reviewGoal(dir, { decision: "complete", rationale: "again" });
  assert.match(again.message, /already finished/);
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ a met goal ends the run and writes its result");
}

// ── it is bounded ──────────────────────────────────────────────────────────
// An outer loop with no ceiling is how a harness runs for days and produces
// nothing.
{
  const dir = project();
  await startGoal({ targetDir: dir, goal: "Chase it forever", runId: "goal-1", maxIterations: 2 });
  for (let pass = 1; pass <= 3; pass++) {
    finishPipeline(dir);
    await recordPipelinePass(dir, `pass ${pass}`);
    const outcome = await reviewGoal(dir, {
      decision: "incomplete",
      rationale: "still not right",
      remainingWork: ["more work"],
    });
    if (pass < 2) {
      assert.equal(outcome.terminal, false, `pass ${pass} should continue`);
    } else {
      assert.equal(outcome.terminal, true, "the iteration ceiling ends it");
      assert.match(outcome.message, /maxIterations|stopped/);
      break;
    }
  }
  const final = await loadGoal(dir);
  assert.notEqual(final!.status, "running", "and the loop really is over");
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ the goal loop stops at its iteration ceiling instead of chasing forever");
}

// A blocked verdict ends it too — that is what blocked means.
{
  const dir = project();
  await startGoal({ targetDir: dir, goal: "Needs something I cannot get", runId: "goal-1" });
  finishPipeline(dir);
  await recordPipelinePass(dir, "pass");
  const outcome = await reviewGoal(dir, {
    decision: "blocked",
    rationale: "the upstream API does not exist yet",
    remainingWork: ["wait for the API"],
  });
  assert.equal(outcome.terminal, true);
  assert.equal(outcome.state.status, "blocked");
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ blocked ends the loop rather than looping on something that cannot move");
}

// ── no goal, no interference ───────────────────────────────────────────────
{
  const dir = project();
  assert.equal(await recordPipelinePass(dir, "x"), null, "no goal means nothing to record");
  await assert.rejects(() => reviewGoal(dir, { decision: "complete", rationale: "x" }), /No goal is being pursued/);
  assert.equal(await cancelGoal(dir, "x"), null);
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ a project with no goal is left entirely alone");
}


// ── reviewing early ────────────────────────────────────────────────────────
// Found by running the shipped package against a real project, not by any of
// the tests above: they all recorded a pipeline pass first, so none of them
// ever asked what happens when a review arrives before one. The answer was
// `GoalLoopStateError: Cannot update goal iteration 2 from status pending` —
// an internal phase name thrown at whoever called the tool.
//
// Reviewing early is legitimate. You can see a pass will not meet the goal
// well before the pipeline agrees, and waiting for a doomed pipeline to finish
// first is theatre.
{
  const dir = project();
  await startGoal({ targetDir: dir, goal: "Do the thing properly", runId: "goal-1", maxIterations: 3 });

  // Straight to a verdict, with no pipeline pass recorded at all.
  const first = await reviewGoal(dir, {
    decision: "incomplete",
    rationale: "this approach was never going to work",
    remainingWork: ["start again with the other approach"],
  });
  assert.equal(first.terminal, false);
  assert.match(first.message, /Starting pass 2/);

  // And again on the fresh pass, which is the exact sequence that threw.
  const second = await reviewGoal(dir, {
    decision: "incomplete",
    rationale: "still not right",
    remainingWork: ["one more thing"],
  });
  assert.equal(second.terminal, false);
  assert.match(second.message, /Starting pass 3/);

  const third = await reviewGoal(dir, { decision: "complete", rationale: "done at last" });
  assert.equal(third.terminal, true);
  assert.equal(third.state.status, "done");
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ a review that arrives before the pipeline finishes is answered, not thrown at");
}

console.log("goal.test.ts ✓");
