import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_WALL_CLOCK_MS,
  DEFAULT_NO_PROGRESS_LIMIT,
  budgetFrom,
  decideNext,
  describeDecision,
  fingerprint,
  loadLoopState,
  loopStatePath,
  newLoopState,
  saveLoopState,
  stopFilePath,
  type LoopState,
} from "../src/loop.ts";
import { defaultConfig, loadConfig } from "../src/core/config.ts";
import type { FeatureList, HarnessConfig, Task, TaskStatus } from "../src/core/types.ts";

function mkTask(id: string, status: TaskStatus): Task {
  return { id, description: `Do ${id}`, status, dependsOn: [], subtasks: [] };
}

function plan(tasks: Task[], baseRevision = 1): FeatureList {
  return {
    version: "2.0",
    baseRevision,
    goals: [{ id: "goal-001", title: "Ship it" }],
    sprints: [],
    features: [{ id: "feature-001", name: "F", criteria: ["works"], tasks }],
  };
}

function tmpProject(mutate: (c: HarnessConfig) => void = () => {}, list: FeatureList | null = plan([mkTask("task-1", "pending")])): string {
  const d = mkdtempSync(join(tmpdir(), "pi-loop-"));
  mkdirSync(join(d, "harness", "features"), { recursive: true });
  const c = defaultConfig();
  c.currentPhase = "build";
  mutate(c);
  writeFileSync(join(d, "harness", "config.json"), JSON.stringify(c, null, 2), "utf-8");
  if (list) writeFileSync(join(d, "harness", "features", "feature-list.json"), JSON.stringify(list, null, 2), "utf-8");
  return d;
}

function writePlan(dir: string, list: FeatureList): void {
  writeFileSync(join(dir, "harness", "features", "feature-list.json"), JSON.stringify(list, null, 2), "utf-8");
}

const RUN = "run-under-test";

// ── paths and state bookkeeping ────────────────────────────────────────────
{
  const dir = tmpProject();
  try {
    assert.equal(loopStatePath(dir), join(dir, "harness", "loop-state.json"));
    assert.equal(stopFilePath(dir), join(dir, "harness", "STOP"));

    const now = new Date("2026-01-01T00:00:00.000Z");
    const fresh = newLoopState(RUN, now);
    assert.deepEqual(fresh, {
      runId: RUN,
      startedAt: "2026-01-01T00:00:00.000Z",
      iterations: 0,
      lastFingerprint: null,
      noProgressStreak: 0,
      lastPhase: null,
      lastDecision: null,
      stoppedAt: null,
      stopReason: null,
      escalation: { consultedCount: 0, masterUsed: false, lastUnstuckAt: null, fingerprints: [], tried: [] },
      perLevelEscalation: {},
      escalations: [],
    });

    // Nothing on disk yet: a fresh state is synthesised.
    assert.deepEqual(loadLoopState(dir, RUN, now), fresh);

    const used: LoopState = { ...fresh, iterations: 12, noProgressStreak: 2, lastFingerprint: "abc" };
    saveLoopState(dir, used);
    assert.deepEqual(loadLoopState(dir, RUN, now), used, "state round-trips through disk");

    // A different run must not inherit the previous run's budget.
    const other = loadLoopState(dir, "some-other-run", now);
    assert.equal(other.iterations, 0);
    assert.equal(other.runId, "some-other-run");

    // A corrupt state file is not worth aborting a run over.
    writeFileSync(loopStatePath(dir), "{ not json", "utf-8");
    assert.equal(loadLoopState(dir, RUN, now).iterations, 0, "a corrupt loop state restarts the budget");
    console.log("✓ loop state paths, defaults and persistence");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── budgetFrom ─────────────────────────────────────────────────────────────
{
  assert.deepEqual(budgetFrom(defaultConfig()), {
    maxIterations: DEFAULT_MAX_ITERATIONS,
    maxWallClockMs: DEFAULT_MAX_WALL_CLOCK_MS,
    noProgressLimit: DEFAULT_NO_PROGRESS_LIMIT,
  });

  const c = defaultConfig();
  c.loop = { maxIterations: 7, maxWallClockMs: 60_000, noProgressLimit: 2 };
  assert.deepEqual(budgetFrom(c), { maxIterations: 7, maxWallClockMs: 60_000, noProgressLimit: 2 });

  // Nonsense never silently disables a guard.
  for (const bad of [0, -1, "10", null, Number.NaN, Number.POSITIVE_INFINITY] as unknown[]) {
    const junk = defaultConfig();
    // Deliberately ill-typed: this is what a hand-edited config can contain.
    junk.loop = { maxIterations: bad, maxWallClockMs: bad, noProgressLimit: bad } as HarnessConfig["loop"];
    assert.deepEqual(
      budgetFrom(junk),
      {
        maxIterations: DEFAULT_MAX_ITERATIONS,
        maxWallClockMs: DEFAULT_MAX_WALL_CLOCK_MS,
        noProgressLimit: DEFAULT_NO_PROGRESS_LIMIT,
      },
      `${JSON.stringify(bad)} falls back to the default budget`,
    );
  }
  console.log("✓ budgetFrom defaults and validation");
}

// ── fingerprint ────────────────────────────────────────────────────────────
{
  const dir = tmpProject();
  try {
    const a = await fingerprint(dir);
    assert.match(a, /^[0-9a-f]{16}$/, "a short stable hex digest");
    assert.equal(await fingerprint(dir), a, "an unchanged tree fingerprints the same");

    // The plan revision is part of the fingerprint: a task edit leaves no file
    // trace in the working tree, but it is still progress.
    writePlan(dir, plan([mkTask("task-1", "pending")], 2));
    const b = await fingerprint(dir);
    assert.notEqual(b, a, "a changed baseRevision changes the fingerprint");

    // So is the shape of the plan itself.
    writePlan(dir, plan([mkTask("task-1", "in_progress")], 2));
    const c = await fingerprint(dir);
    assert.notEqual(c, b, "a changed task status changes the fingerprint");

    writePlan(dir, plan([mkTask("task-1", "pending")], 2));
    assert.equal(await fingerprint(dir), b, "reverting the change reverts the fingerprint");
    console.log("✓ fingerprint tracks the plan revision and task statuses");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── human brakes: the stop file wins over everything ───────────────────────
{
  const dir = tmpProject();
  try {
    writeFileSync(stopFilePath(dir), "", "utf-8");
    const { decision, state } = await decideNext({ targetDir: dir, runId: RUN });
    assert.equal(decision.action, "stop");
    assert.equal(decision.reason, "stop-file");
    assert.match((decision as { detail: string }).detail, /harness\/STOP exists — delete it to resume/);
    assert.equal(state.stopReason, "stop-file");
    assert.ok(state.stoppedAt, "the stop is timestamped");

    // The stop is persisted so the next process sees why the run ended.
    const persisted = JSON.parse(readFileSync(loopStatePath(dir), "utf-8"));
    assert.equal(persisted.stopReason, "stop-file");
    assert.equal(persisted.lastDecision, "stop");
    console.log("✓ the stop file stops the loop");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── the stop file is checked before the config is even read ────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "pi-loop-bare-"));
  try {
    mkdirSync(join(dir, "harness"), { recursive: true });
    writeFileSync(stopFilePath(dir), "", "utf-8");
    const { decision } = await decideNext({ targetDir: dir, runId: RUN });
    assert.equal(decision.reason, "stop-file", "a human brake outranks every other condition");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // …and with no stop file, a project with no config stops rather than guessing.
  const bare = mkdtempSync(join(tmpdir(), "pi-loop-noconfig-"));
  try {
    const { decision } = await decideNext({ targetDir: bare, runId: RUN });
    assert.equal(decision.action, "stop");
    assert.equal(decision.reason, "no-config");
    assert.match((decision as { detail: string }).detail, /config.json is missing or unreadable/);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }

  // A corrupt config is the same story: stop, do not run blind.
  const corrupt = mkdtempSync(join(tmpdir(), "pi-loop-corrupt-"));
  try {
    mkdirSync(join(corrupt, "harness"), { recursive: true });
    writeFileSync(join(corrupt, "harness", "config.json"), "{ broken", "utf-8");
    const { decision } = await decideNext({ targetDir: corrupt, runId: RUN });
    assert.equal(decision.action, "stop");
    assert.equal(decision.reason, "no-config");
  } finally {
    rmSync(corrupt, { recursive: true, force: true });
  }
  console.log("✓ missing or unreadable config stops the loop");
}

// ── paused waits rather than stops ─────────────────────────────────────────
{
  const dir = tmpProject((c) => {
    c.paused = true;
  });
  try {
    const { decision, state } = await decideNext({ targetDir: dir, runId: RUN });
    assert.equal(decision.action, "wait", "a pause is resumable, so it is a wait and not a stop");
    assert.equal(decision.reason, "paused");
    assert.match((decision as { detail: string }).detail, /paused/i);
    assert.equal(state.stopReason, null, "waiting does not end the run");
    assert.equal(state.stoppedAt, null);
    console.log("✓ paused waits");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── terminal: the pipeline finished ────────────────────────────────────────
{
  const dir = tmpProject((c) => {
    c.currentPhase = "ship";
  }, plan([mkTask("task-1", "complete"), mkTask("task-2", "complete")]));
  try {
    const { decision } = await decideNext({ targetDir: dir, runId: RUN });
    assert.equal(decision.action, "stop");
    assert.equal(decision.reason, "complete");
    assert.match((decision as { detail: string }).detail, /Pipeline complete: 2\/2 tasks across 1 feature\(s\)/);
    console.log("✓ a finished pipeline stops");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── the retry budget ends the run ──────────────────────────────────────────
{
  const dir = tmpProject((c) => {
    c.maxRetries = 5;
    c.taskRetryCount = 5;
  });
  try {
    const { decision } = await decideNext({ targetDir: dir, runId: RUN });
    assert.equal(decision.action, "stop");
    assert.equal(decision.reason, "retry-budget");
    assert.match((decision as { detail: string }).detail, /The task retry budget is exhausted/);
    assert.match((decision as { detail: string }).detail, /A human needs to look at this/);
    console.log("✓ an exhausted retry budget stops the loop");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── the iteration ceiling ends the run ─────────────────────────────────────
{
  const dir = tmpProject((c) => {
    c.loop = { ...c.loop, maxIterations: 10 };
  });
  try {
    saveLoopState(dir, { ...newLoopState(RUN), iterations: 10 });
    const { decision, state } = await decideNext({ targetDir: dir, runId: RUN });
    assert.equal(decision.action, "stop");
    assert.equal(decision.reason, "max-iterations");
    assert.match((decision as { detail: string }).detail, /Reached the 10-iteration ceiling/);
    assert.equal(state.iterations, 11, "the iteration that tripped the ceiling is still counted");

    // One under the ceiling, the loop keeps going.
    saveLoopState(dir, { ...newLoopState(RUN), iterations: 8 });
    const under = await decideNext({ targetDir: dir, runId: RUN });
    assert.notEqual(under.decision.reason, "max-iterations", "9 of 10 is not the ceiling");
    console.log("✓ the iteration ceiling stops the loop");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── the wall-clock budget ends the run ─────────────────────────────────────
{
  const dir = tmpProject();
  try {
    const old = newLoopState(RUN, new Date(Date.now() - 48 * 60 * 60 * 1000));
    saveLoopState(dir, old);
    const { decision } = await decideNext({ targetDir: dir, runId: RUN });
    assert.equal(decision.action, "stop");
    assert.equal(decision.reason, "max-wall-clock");
    assert.match((decision as { detail: string }).detail, /Run exceeded its 24.0h wall-clock budget/);

    // A run that started an hour ago is well inside the default budget.
    saveLoopState(dir, newLoopState(RUN, new Date(Date.now() - 60 * 60 * 1000)));
    const fresh = await decideNext({ targetDir: dir, runId: RUN });
    assert.notEqual(fresh.decision.reason, "max-wall-clock");

    // A shorter configured budget bites sooner.
    const cfg = loadConfig(dir).config;
    cfg.loop = { ...cfg.loop, maxWallClockMs: 30 * 60 * 1000 };
    writeFileSync(join(dir, "harness", "config.json"), JSON.stringify(cfg, null, 2), "utf-8");
    saveLoopState(dir, newLoopState(RUN, new Date(Date.now() - 60 * 60 * 1000)));
    const tight = await decideNext({ targetDir: dir, runId: RUN });
    assert.equal(tight.decision.reason, "max-wall-clock");
    assert.match((tight.decision as { detail: string }).detail, /0.5h wall-clock budget/);
    console.log("✓ the wall-clock budget stops the loop");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── no phase yet ───────────────────────────────────────────────────────────
{
  const dir = tmpProject((c) => {
    c.currentPhase = null;
  });
  try {
    const { decision } = await decideNext({ targetDir: dir, runId: RUN });
    assert.equal(decision.action, "wait");
    assert.equal(decision.reason, "not-started");
    assert.match((decision as { detail: string }).detail, /Initialise the harness before running the loop/);
    console.log("✓ an un-started harness waits");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── no-progress detection ──────────────────────────────────────────────────
//
// `skipEscalation` throughout: this block is about the base loop's stall
// detection, and the escalation ladder deliberately interrupts a stall to try
// something different. Both behaviours matter, so they are tested apart —
// escalate.test.ts covers what happens when the ladder is left switched on.
{
  // The gate cannot pass and the tree never changes: the agent is spinning.
  const dir = tmpProject((c) => {
    c.commands.test = "exit 1";
    c.loop = { ...c.loop, noProgressLimit: 3 };
  });
  try {
    // The first failing iteration establishes the baseline: there is nothing
    // to compare against yet, so it cannot count as a stall.
    const first = await decideNext({ targetDir: dir, runId: RUN, skipEscalation: true });
    assert.equal(first.decision.action, "continue", "the first failure is just a failure");
    assert.equal(first.decision.reason, "gate failed");
    assert.match((first.decision as { message: string }).message, /BUILD gate did not pass/);
    assert.match((first.decision as { message: string }).message, /x tests:/, "the failing check is named");
    assert.equal(first.state.noProgressStreak, 0, "no baseline yet, so no stall yet");
    assert.ok(first.state.lastFingerprint, "the tree is fingerprinted for next time");

    const second = await decideNext({ targetDir: dir, runId: RUN, skipEscalation: true });
    assert.equal(second.decision.action, "continue");
    assert.equal(second.state.noProgressStreak, 1, "first confirmed no-change observation");
    assert.equal(second.state.lastFingerprint, first.state.lastFingerprint, "the tree really is unchanged");

    const third = await decideNext({ targetDir: dir, runId: RUN, skipEscalation: true });
    assert.equal(third.decision.action, "continue");
    assert.equal(third.state.noProgressStreak, 2, "the streak grows while nothing changes");

    const fourth = await decideNext({ targetDir: dir, runId: RUN, skipEscalation: true });
    assert.equal(fourth.decision.action, "stop", "spinning is not working");
    assert.equal(fourth.decision.reason, "no-progress");
    const detail = (fourth.decision as { detail: string }).detail;
    assert.match(detail, /failed 3 times in a row with no change to the working tree/);
    assert.match(detail, /looping without making progress: tests/, "the reason the gate failed is carried through");
    assert.match(detail, /Stopping so a human can intervene/);
    assert.equal(fourth.state.stopReason, "no-progress");

    // Each failing iteration charges a phase retry, so a configured phase
    // budget bounds the run even when the tree does keep changing.
    assert.ok(loadConfig(dir).config.phaseRetryCount >= 2, "failing iterations burn phase retries");
    console.log("✓ no-progress detection stops a spinning loop");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── real progress resets the streak ────────────────────────────────────────
{
  const dir = tmpProject((c) => {
    c.commands.test = "exit 1";
    c.loop = { ...c.loop, noProgressLimit: 3 };
  });
  try {
    const one = await decideNext({ targetDir: dir, runId: RUN, skipEscalation: true });
    assert.equal(one.state.noProgressStreak, 0, "baseline iteration");
    const two = await decideNext({ targetDir: dir, runId: RUN, skipEscalation: true });
    assert.equal(two.state.noProgressStreak, 1);

    // The agent actually changed something between iterations.
    writePlan(dir, plan([mkTask("task-1", "pending")], 99));

    const three = await decideNext({ targetDir: dir, runId: RUN, skipEscalation: true });
    assert.equal(three.decision.action, "continue", "a moving tree is not a stuck loop");
    assert.equal(three.state.noProgressStreak, 0, "progress resets the streak");
    assert.notEqual(three.state.lastFingerprint, two.state.lastFingerprint);

    // …and the streak starts climbing again once it stalls.
    const four = await decideNext({ targetDir: dir, runId: RUN, skipEscalation: true });
    assert.equal(four.state.noProgressStreak, 1);
    console.log("✓ a change to the tree resets the no-progress streak");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── a passing gate advances the phase ──────────────────────────────────────
{
  const dir = tmpProject((c) => {
    c.currentPhase = "build";
  }, plan([mkTask("task-1", "complete")]));
  try {
    const { decision, state } = await decideNext({ targetDir: dir, runId: RUN });
    assert.equal(decision.action, "advanced", JSON.stringify(decision));
    assert.equal((decision as { toPhase: string }).toPhase, "verify");
    assert.match((decision as { reason: string }).reason, /gate passed on build/);
    assert.match((decision as { message: string }).message, /NEXT STEP · VERIFY/, "the next brief comes with it");
    assert.equal(loadConfig(dir).config.currentPhase, "verify", "the advance is persisted");
    assert.equal(state.noProgressStreak, 0);
    // A new phase starts with no baseline: the first failure of the *next*
    // phase must not be read as a stall against a fingerprint taken before
    // the agent was asked to do anything.
    assert.equal(state.lastFingerprint, null);

    // Passing the gate on the final phase is the end of the run.
    const cfg = loadConfig(dir).config;
    cfg.currentPhase = "ship";
    writeFileSync(join(dir, "harness", "config.json"), JSON.stringify(cfg, null, 2), "utf-8");
    // On the final phase with every task done, the terminal check fires before
    // the gate is ever run — that ordering is what stops a finished run from
    // burning another lint/test cycle.
    const done = await decideNext({ targetDir: dir, runId: RUN });
    assert.equal(done.decision.action, "stop");
    assert.equal(done.decision.reason, "complete");
    console.log("✓ a passing gate advances the phase and issues the next brief");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── skipGate hands the decision to the caller's verdict ──
// (escalation off: this is about the guards, not the ladder)──────────────────
{
  const dir = tmpProject((c) => {
    c.loop = { ...c.loop, noProgressLimit: 2 };
  });
  try {
    const first = await decideNext({ targetDir: dir, runId: RUN, skipGate: true, skipEscalation: true });
    assert.equal(first.decision.action, "continue");
    assert.match((first.decision as { message: string }).message, /\(gate not run\)/);
    assert.equal(first.state.noProgressStreak, 0, "baseline iteration");
    const second = await decideNext({ targetDir: dir, runId: RUN, skipGate: true, skipEscalation: true });
    assert.equal(second.decision.action, "continue");
    assert.equal(second.state.noProgressStreak, 1);
    const third = await decideNext({ targetDir: dir, runId: RUN, skipGate: true, skipEscalation: true });
    assert.equal(third.decision.action, "stop", "the no-progress guard still applies without a gate");
    assert.equal(third.decision.reason, "no-progress");
    assert.ok(!(third.decision as { detail: string }).detail.includes("undefined"));
    assert.equal(loadConfig(dir).config.gateHistory.length, 0, "skipping the gate records no verdict");
    console.log("✓ skipGate skips the gate but not the guards");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── describeDecision ───────────────────────────────────────────────────────
{
  assert.equal(describeDecision({ action: "continue", message: "m", reason: "gate failed" }), "continuing — gate failed");
  assert.equal(
    describeDecision({ action: "advanced", toPhase: "verify", message: "m", reason: "r" }),
    "advanced to verify",
  );
  assert.equal(describeDecision({ action: "wait", reason: "paused", detail: "it is paused" }), "waiting — it is paused");
  assert.equal(describeDecision({ action: "stop", reason: "stop-file", detail: "STOP exists" }), "stopped — STOP exists");
  console.log("✓ describeDecision");
}

// ── every decision leaves the loop state readable on disk ──────────────────
{
  const dir = tmpProject();
  try {
    await decideNext({ targetDir: dir, runId: RUN });
    assert.ok(existsSync(loopStatePath(dir)));
    const state = JSON.parse(readFileSync(loopStatePath(dir), "utf-8"));
    assert.equal(state.runId, RUN);
    assert.equal(state.iterations, 1);
    assert.equal(state.lastPhase, "build", "the state remembers where the run was");
    assert.ok(state.lastDecision);
    console.log("✓ every decision persists the loop state");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("All loop tests PASS");
