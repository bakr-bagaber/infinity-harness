/**
 * The escalation ladder, connected.
 *
 * `unstuck.ts` could always choose what to do when a run stalled — retry,
 * reframe, consult, rework, replan, master — and nothing ever executed one.
 * It was a chooser with no actuator, so `/infinity:run` did the only thing it
 * could when the gate kept failing: count three strikes and stop. A run that
 * could have escalated to a stronger model or reworked the task that poisoned
 * everything downstream instead failed the same check three times and gave up.
 *
 * Wiring it in exposed three reasons it had never worked:
 *
 *   1. `reframe` had no budget, so it was eligible forever and shadowed every
 *      rung below it. The ladder could not climb past rung two.
 *   2. `rework` and `replan` were vetoed unless the working tree had moved —
 *      but a stall is *defined* by the tree not moving, so the two rungs that
 *      exist for exactly this situation could never fire in it.
 *   3. The budgets count effects on disk, which only appear if the agent acts.
 *      A stuck agent does not act, so the budget never moved and the ladder
 *      jammed, offering the same rung forever.
 *
 * These tests are the ones that would have caught all three.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initHarness } from "../src/core/init.ts";
import { loadConfig, saveConfig } from "../src/core/config.ts";
import { writeTaskList } from "../src/taskList.ts";
import { loadFeatureList, flattenTasks } from "../src/core/featureList.ts";
import { decideNext } from "../src/loop.ts";
import { escalate, emptyEscalationState, describeEscalation, escalationSummary } from "../src/escalate.ts";
import { chooseUnstuckStrategy } from "../src/unstuck.ts";
import { loadRework } from "../src/rework.ts";

/** A project whose gate cannot pass and whose tree never moves. */
function stuckProject(router?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-esc-"));
  initHarness(dir);
  const { config } = loadConfig(dir);
  config.currentPhase = "build";
  config.currentRole = "generator";
  config.commands.test = "exit 1";
  config.maxRetries = 999;
  config.retry = {
    tasks: { max: 999, count: 0 },
    features: { max: 999, count: 0 },
    phases: { max: 999, count: 0 },
  } as never;
  saveConfig(dir, config);
  if (router) writeFileSync(join(dir, "harness", "model-router.json"), JSON.stringify(router, null, 2));
  writeTaskList(dir, {
    features: [{ id: "feature-001", name: "F", criteria: ["it works"] }],
    tasks: [
      { key: "feature-001/task-001", subject: "the root task", status: "in_progress", difficulty: "moderate" },
      { key: "feature-001/task-002", subject: "built on the root", status: "pending", dependsOn: ["feature-001/task-001"] },
    ],
  });
  return dir;
}

const FULL_ROUTER = {
  enabled: true,
  byDifficulty: { easy: "small", moderate: "medium", difficult: "large" },
  master: "the-master-model",
  consultation: { enabled: true, maxPerTask: 1, oneStepOnly: true, requireExhaustion: true },
};

// ── the ladder climbs, and it ends ─────────────────────────────────────────
{
  const dir = stuckProject(FULL_ROUTER);
  const rungs: string[] = [];
  let stopped: { reason: string; detail: string } | null = null;

  for (let i = 0; i < 15; i++) {
    const { decision } = await decideNext({ targetDir: dir, runId: "run-1" });
    if (decision.action === "stop") {
      stopped = { reason: decision.reason, detail: decision.detail };
      break;
    }
    const m = /escalated: ([a-z]+):/.exec(decision.reason);
    if (m) rungs.push(m[1]!);
  }

  assert.deepEqual(
    rungs,
    ["retry", "reframe", "consult", "rework", "replan", "master"],
    `the ladder must climb every rung, in order — got ${rungs.join(" → ")}`,
  );
  assert.ok(stopped, "and then it must stop");
  assert.equal(stopped!.reason, "no-progress");
  assert.match(stopped!.detail, /retry → reframe → consult → rework → replan → master/);
  assert.match(stopped!.detail, /escalation ladder was spent first/);
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ the ladder climbs every rung and then lets the run stop");
}

// The old behaviour, and why it was wrong: reframe shadowed everything below.
{
  const first = chooseUnstuckStrategy({ strategies: ["reframe", "rework", "master"], fileDelta: false });
  assert.equal(first.strategy, "reframe");
  const second = chooseUnstuckStrategy({
    strategies: ["reframe", "rework", "master"],
    fileDelta: false,
    tried: ["reframe"],
    requireDeltaForRework: false,
  });
  assert.notEqual(second.strategy, "reframe", "a rung already taken must not be offered again");
  console.log("✓ a rung gets one turn per stall, so the ladder can climb past it");
}

// And why rework/replan could never fire when it mattered.
{
  const vetoed = chooseUnstuckStrategy({ strategies: ["rework"], fileDelta: false });
  assert.equal(vetoed.strategy, null, "the review-bounce delta guard vetoes rework by default");

  const allowed = chooseUnstuckStrategy({
    strategies: ["rework"],
    fileDelta: false,
    requireDeltaForRework: false,
  });
  assert.equal(allowed.strategy, "rework", "a stall must be allowed to reach the rung that fixes it");
  console.log("✓ the delta guard is a review-bounce policy, not a ladder policy");
}

// ── rework actually happens ────────────────────────────────────────────────
// The other rungs produce instructions; this one changes the plan. If it
// silently did nothing, every test above would still pass.
{
  const dir = stuckProject();
  let flipped = false;
  for (let i = 0; i < 10; i++) {
    const { decision } = await decideNext({ targetDir: dir, runId: "run-1" });
    if (decision.action !== "continue" && decision.action !== "advanced") break;
    const statuses = flattenTasks(loadFeatureList(dir).list).map((t) => t.status);
    if (statuses.every((s) => s === "rework")) {
      flipped = true;
      break;
    }
  }
  assert.ok(flipped, "rework must actually flip the task and its dependents");

  const record = loadRework(dir);
  assert.ok(record, "and record where the pipeline has to return to");
  assert.equal(record!.returnFeature, "feature-001");
  assert.deepEqual(record!.impacted, ["feature-001/task-002"], "the dependent went with it");

  const spent = escalationSummary(dir);
  assert.equal(spent.reworks, 1);
  assert.equal(spent.returnTo, "feature-001/task-001");
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ rework flips the task and everything downstream, and records the return point");
}

// ── the instruction is the product ─────────────────────────────────────────
// A rung that does not change what the agent is told is a rung that does
// nothing, because the message is the entire mechanism.
{
  const dir = stuckProject(FULL_ROUTER);
  let state = emptyEscalationState();
  const seen = new Map<string, string>();

  for (let i = 0; i < 8; i++) {
    const result = await escalate({
      targetDir: dir,
      runId: "run-1",
      phase: "build",
      failures: ["tests: exit 1"],
      fileDelta: false,
      fingerprint: "same-every-time",
      state,
    });
    state = result.next;
    if (!result.strategy) break;
    assert.ok(result.instruction, `${result.strategy} produced no instruction`);
    assert.ok(
      result.instruction!.includes("tests: exit 1"),
      `${result.strategy} did not tell the agent what is failing`,
    );
    seen.set(result.strategy, result.instruction!);
  }

  assert.ok(seen.size >= 5, `expected most of the ladder, saw ${[...seen.keys()].join(", ")}`);
  assert.equal(new Set(seen.values()).size, seen.size, "every rung must say something different");
  assert.match(seen.get("reframe")!, /REFRAME/);
  assert.match(seen.get("rework")!, /REWORK/);
  assert.match(seen.get("replan")!, /infinity_replan/, "replan must name the tool that does it");
  assert.match(seen.get("master")!, /LAST RESORT/);
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ every rung tells the agent something different, and names the failure");
}

// ── vendor neutrality ──────────────────────────────────────────────────────
// The last rung used to default to a specific third-party model, in a package
// that promises every routing slot ships empty.
{
  const bare = chooseUnstuckStrategy({ strategies: ["master"], fileDelta: true });
  assert.equal(bare.strategy, "master");
  assert.equal(bare.nextModel, null, "MASTER must not silently redirect work to someone's model");
  assert.match(bare.reason, /pi's current model/);

  const configured = chooseUnstuckStrategy({
    strategies: ["master"],
    fileDelta: true,
    projectDir: (() => {
      const d = mkdtempSync(join(tmpdir(), "pi-master-"));
      initHarness(d);
      writeFileSync(join(d, "harness", "model-router.json"), JSON.stringify({ master: "chosen-by-the-user" }));
      return d;
    })(),
  });
  assert.equal(configured.nextModel, "chosen-by-the-user", "and must use one when the user set one");
  console.log("✓ the last rung stays vendor-neutral unless the user chose a model");
}

// ── REVIEW bounces backwards instead of climbing ───────────────────────────
{
  const dir = stuckProject();
  const { config } = loadConfig(dir);
  config.currentPhase = "review";
  config.currentRole = "evaluator";
  saveConfig(dir, config);

  const result = await escalate({
    targetDir: dir,
    runId: "run-1",
    phase: "review",
    failures: ["rubric-content: missing"],
    fileDelta: true,
    fingerprint: "fp",
    state: emptyEscalationState(),
  });
  assert.equal(result.strategy, "rework", "a failing review sends the work back, it does not reframe");
  assert.match(result.reason, /review bounce/);
  assert.ok(loadRework(dir), "and records the bounce");
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ a failing REVIEW bounces the work back rather than climbing the ladder");
}

// ── it never takes the run down with it ────────────────────────────────────
{
  // A project with no plan at all: every module the ladder touches will fail.
  const dir = mkdtempSync(join(tmpdir(), "pi-esc-bare-"));
  initHarness(dir);
  const result = await escalate({
    targetDir: dir,
    runId: "run-1",
    phase: "build",
    failures: [],
    fileDelta: false,
    fingerprint: "fp",
    state: emptyEscalationState(),
  });
  assert.ok(typeof result.reason === "string" && result.reason.length > 0, "it explains itself");
  assert.ok(result.next, "and always returns usable state");
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ an escalation that cannot run degrades instead of killing the run");
}

// ── a new stall gets a fresh ladder ────────────────────────────────────────
{
  const dir = stuckProject();
  const one = await decideNext({ targetDir: dir, runId: "run-1" });
  assert.equal(one.decision.action, "continue");
  const two = await decideNext({ targetDir: dir, runId: "run-1" });
  assert.ok(two.state.escalation.tried.length > 0, "the first stall spent a rung");

  // The agent does something real. The fingerprint is the working tree plus
  // the plan, and a temp project is not a git repo, so the plan is the part
  // that can actually move here.
  writeTaskList(dir, {
    tasks: [
      { key: "feature-001/task-001", subject: "the root task", status: "in_progress" },
      { key: "feature-001/task-002", subject: "built on the root", status: "pending", dependsOn: ["feature-001/task-001"] },
      { key: "feature-001/task-003", subject: "genuinely new work", status: "pending" },
    ],
  });
  const three = await decideNext({ targetDir: dir, runId: "run-1" });
  assert.deepEqual(three.state.escalation.tried, [], "a moving tree resets the ladder");
  assert.equal(three.state.noProgressStreak, 0);
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ real progress resets the ladder; the budgets still bound the run");
}

{
  assert.match(describeEscalation({
    strategy: "rework", reason: "r", instruction: null, model: null,
    applied: "flipped 2 tasks", next: emptyEscalationState(),
  }), /rework: r \(flipped 2 tasks\)/);
  assert.match(describeEscalation({
    strategy: null, reason: "budgets exhausted", instruction: null, model: null,
    applied: null, next: emptyEscalationState(),
  }), /no escalation available/);
}

console.log("escalate.test.ts ✓");
