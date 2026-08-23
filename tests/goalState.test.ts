import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GoalStateStore, canonicalGoalSpecPath, CANONICAL_GOAL_SPEC_DIR } from "../src/goalState.ts";
import { createGoalLoopState, startGoalIteration, recordGeneratedTodo } from "../src/goalLoop.ts";
import { createGoalSpecification } from "../src/goalSpec.ts";

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "pi-goal-state-"));
}

// --- paths repointed to tmp/infinity-harness/goals ---
{
  const store = new GoalStateStore({ cwd: "/tmp", goalRunId: "run-1" });
  assert.ok(store.paths.goalRunDir.includes("tmp/infinity-harness/goals/run-1"), `goalRunDir ${store.paths.goalRunDir} should contain tmp/infinity-harness/goals`);
  assert.ok(store.paths.statePath.endsWith("GOAL_STATE.json"));
  assert.ok(store.paths.tracePath.endsWith("GOAL_TRACE.jsonl"));
  assert.ok(store.paths.goalSpecPath.endsWith("GOAL_SPEC.json"));
  assert.ok(store.paths.iterationsDir.endsWith("iterations"));
  assert.equal(canonicalGoalSpecPath("/tmp/proj"), resolve("/tmp/proj", "harness/goals/GOAL_SPEC.json"));
  assert.equal(CANONICAL_GOAL_SPEC_DIR, "harness/goals");
  console.log("✓ paths repointed to tmp/infinity-harness/goals + canonical");
}

// --- ensureRunDir + saveState/loadState roundtrip ---
{
  const proj = tmpProject();
  try {
    const store = new GoalStateStore({ cwd: proj, goalRunId: "run-1" });
    await store.ensureRunDir();
    assert.ok(existsSync(store.paths.iterationsDir), "iterations dir created");

    const now = new Date("2026-01-01T00:00:00.000Z");
    const state = createGoalLoopState({ goal: "hello", goalRunId: "run-1", cwd: proj, now: () => now });
    await store.saveState(state);
    assert.ok(existsSync(store.paths.statePath), "state file exists");
    const loaded = await store.loadState();
    assert.equal(loaded.goalRunId, "run-1");
    assert.equal(loaded.goal, "hello");
    assert.equal(loaded.schemaVersion, 1);
    console.log("✓ saveState/loadState roundtrip");
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
}

// --- saveGoalSpecification / load + tryLoad missing ---
{
  const proj = tmpProject();
  try {
    const store = new GoalStateStore({ cwd: proj, goalRunId: "run-1" });
    const spec = createGoalSpecification({ goalRunId: "run-1", originalGoal: "build todo" });
    await store.saveGoalSpecification(spec);
    assert.ok(existsSync(store.paths.goalSpecPath));
    const loaded = await store.loadGoalSpecification();
    assert.equal(loaded.goalRunId, "run-1");
    assert.equal(loaded.originalGoal, "build todo");

    const store2 = new GoalStateStore({ cwd: proj, goalRunId: "run-missing" });
    const missing = await store2.tryLoadGoalSpecification();
    assert.equal(missing, undefined, "tryLoad returns undefined when missing");
    console.log("✓ saveGoalSpecification + tryLoad missing");
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
}

// --- appendTrace + durableTraceLength + appendNewTraceEvents ---
{
  const proj = tmpProject();
  try {
    const store = new GoalStateStore({ cwd: proj, goalRunId: "run-1" });
    const now = new Date("2026-01-01T00:00:00.000Z");
    let state = createGoalLoopState({ goal: "g", goalRunId: "run-1", cwd: proj, now: () => now });
    state = startGoalIteration(state, { now });
    await store.saveState(state);
    assert.equal(await store.durableTraceLength(), 0, "no trace file yet -> 0");
    await store.appendTrace(state.trace[0]);
    await store.appendTrace(state.trace[1]);
    assert.equal(await store.durableTraceLength(), 2);
    // appendNewTraceEvents incremental
    const before = await store.durableTraceLength();
    state = recordGeneratedTodo(state, 1, { todoPath: "/tmp/t.md" }, { now });
    await store.appendNewTraceEvents(before, state);
    assert.equal(await store.durableTraceLength(), 3);
    console.log("✓ appendTrace + durableTraceLength + appendNewTraceEvents");
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
}

// --- initializeResult + appendIterationResult + writeIterationSnapshot ---
{
  const proj = tmpProject();
  try {
    const store = new GoalStateStore({ cwd: proj, goalRunId: "run-1" });
    const now = new Date("2026-01-01T00:00:00.000Z");
    const state = createGoalLoopState({ goal: "g", goalRunId: "run-1", cwd: proj, now: () => now });
    await store.initializeResult(state);
    assert.ok(existsSync(store.paths.resultPath));
    const content = readFileSync(store.paths.resultPath, "utf8");
    assert.ok(content.includes("Pi Goal Task Result"));
    assert.ok(content.includes("run-1"));

    // idempotent
    const second = await store.initializeResultIfMissing(state);
    assert.equal(second, false, "second initializeResultIfMissing -> false");

    // writeIterationSnapshot
    let s2 = startGoalIteration(state, { now });
    const snapPath = await store.writeIterationSnapshot(s2.iterations[0]);
    assert.ok(existsSync(snapPath), "snapshot exists");
    assert.ok(snapPath.includes("iterations/01/ITERATION_STATE.json"), `snapPath ${snapPath}`);
    assert.equal(store.iterationDir(2), join(store.paths.iterationsDir, "02"));
    assert.equal(store.iterationDir(12), join(store.paths.iterationsDir, "12"));

    // appendIterationResult
    await store.appendIterationResult(s2.iterations[0]);
    const result2 = readFileSync(store.paths.resultPath, "utf8");
    assert.ok(result2.includes("Iteration 1"));
    console.log("✓ initializeResult + writeIterationSnapshot + iterationDir + appendIterationResult");
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
}

// --- canonical save with proper-lockfile concurrent writers serialized ---
{
  const proj = tmpProject();
  try {
    mkdirSync(join(proj, "harness", "goals"), { recursive: true });
    const store = new GoalStateStore({ cwd: proj, goalRunId: "run-1" });
    const spec1 = createGoalSpecification({ goalRunId: "spec-1", originalGoal: "goal one" });
    const spec2 = createGoalSpecification({ goalRunId: "spec-2", originalGoal: "goal two" });
    const spec3 = createGoalSpecification({ goalRunId: "spec-3", originalGoal: "goal three" });

    // concurrent saves to same canonical path
    await Promise.all([
      store.saveCanonicalGoalSpecification(spec1, proj),
      store.saveCanonicalGoalSpecification(spec2, proj),
      store.saveCanonicalGoalSpecification(spec3, proj),
    ]);
    // file should be valid JSON and one of the three
    const canonicalRaw = readFileSync(join(proj, "harness/goals/GOAL_SPEC.json"), "utf8");
    const parsed = JSON.parse(canonicalRaw);
    assert.ok(["spec-1","spec-2","spec-3"].includes(parsed.goalRunId), `canonical goalRunId ${parsed.goalRunId} should be one of 3`);
    // sequential save after concurrent should be deterministic
    await store.saveCanonicalGoalSpecification(spec2, proj);
    const after = JSON.parse(readFileSync(join(proj, "harness/goals/GOAL_SPEC.json"), "utf8"));
    assert.equal(after.goalRunId, "spec-2");
    console.log("✓ canonical concurrent writers serialized via proper-lockfile");
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
}

// --- saveGoalSpecificationWithCanonical mirrors to both locations + runDir isolated from harness/features ---
{
  const proj = tmpProject();
  try {
    mkdirSync(join(proj, "harness", "features"), { recursive: true });
    // seed feature-list to ensure not corrupted
    const flPath = join(proj, "harness/features/feature-list.json");
    const seed = JSON.stringify({ version: "0.1", baseRevision: 7, goals: [], sprints: [], features: [] }, null, 2);
    // use fs write
    const { writeFileSync: wfs } = await import("node:fs");
    wfs(flPath, seed, "utf8");

    const store = new GoalStateStore({ cwd: proj, goalRunId: "run-mirror" });
    const spec = createGoalSpecification({ goalRunId: "run-mirror", originalGoal: "mirror test" });
    await store.saveGoalSpecificationWithCanonical(spec, proj);

    assert.ok(existsSync(store.paths.goalSpecPath), "runDir spec exists");
    assert.ok(existsSync(join(proj, "harness/goals/GOAL_SPEC.json")), "canonical exists");
    const runRaw = JSON.parse(readFileSync(store.paths.goalSpecPath, "utf8"));
    const canRaw = JSON.parse(readFileSync(join(proj, "harness/goals/GOAL_SPEC.json"), "utf8"));
    assert.equal(runRaw.goalRunId, "run-mirror");
    assert.equal(canRaw.goalRunId, "run-mirror");
    // feature-list not corrupted
    const afterFl = JSON.parse(readFileSync(flPath, "utf8"));
    assert.equal(afterFl.baseRevision, 7, "baseRevision preserved");
    // tmp isolated: runDir under tmp/infinity-harness/goals not under harness
    assert.ok(store.paths.goalRunDir.includes("tmp/infinity-harness/goals"), "isolated runDir");
    assert.ok(!store.paths.goalRunDir.includes("harness/features"), "not in feature-list");
    console.log("✓ saveGoalSpecificationWithCanonical mirrors + baseRevision preserved + isolated");
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
}

// --- atomic tmp+rename for state and goalSpec (no partial files) ---
{
  const proj = tmpProject();
  try {
    const store = new GoalStateStore({ cwd: proj, goalRunId: "run-atomic" });
    const state = createGoalLoopState({ goal: "atomic", goalRunId: "run-atomic", cwd: proj });
    await store.saveState(state);
    // ensure no .tmp- leftover files in runDir
    const files = readdirSync(store.paths.goalRunDir);
    assert.ok(!files.some(f => f.includes(".tmp-")), `no tmp leftovers, got ${files.join(",")}`);
    const spec = createGoalSpecification({ goalRunId: "run-atomic", originalGoal: "atomic spec" });
    await store.saveGoalSpecification(spec);
    const files2 = readdirSync(store.paths.goalRunDir);
    assert.ok(!files2.some(f => f.includes(".tmp-")), "no tmp after spec");
    console.log("✓ atomic tmp+rename leaves no partials");
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
}

console.log("All goalState tests PASS");
