import assert from "node:assert/strict";
import {
  DEFAULT_GOAL_LOOP_LIMITS,
  GOAL_LOOP_STATE_SCHEMA_VERSION,
  createGoalLoopState,
  normalizeGoalLoopLimits,
  startGoalIteration,
  recordGeneratedTodo,
  recordWorkerResult,
  recordReviewerResult,
  failGoalLoop,
  cancelGoalLoop,
  goalLoopStopReason,
  validateGoalLoopState,
} from "../src/goalLoop.ts";

// --- normalizeGoalLoopLimits defaults ---
{
  const l = normalizeGoalLoopLimits();
  assert.equal(l.minIterations, 1);
  assert.equal(l.maxIterations, 50);
  assert.equal(l.timeoutMs, 172_800_000);
  assert.equal(l.iterationTimeoutMs, 10_800_000);
  assert.equal(l.reviewerTimeoutMs, 1_800_000);
  assert.deepEqual(DEFAULT_GOAL_LOOP_LIMITS, { minIterations: 1, maxIterations: 50, timeoutMs: 172_800_000, iterationTimeoutMs: 10_800_000, reviewerTimeoutMs: 1_800_000 });
  console.log("✓ normalize defaults");
}

// --- normalize respects min/max guards ---
{
  const l = normalizeGoalLoopLimits({ minIterations: 5, maxIterations: 3 });
  assert.ok(l.maxIterations >= l.minIterations, "max >= min");
  assert.equal(l.minIterations, 5);
  assert.equal(l.maxIterations, 5);
  const l2 = normalizeGoalLoopLimits({ maxIterations: 10 });
  assert.equal(l2.minIterations, 10, "when only max provided, min mirrors max per port");
  console.log("✓ normalize min/max guards");
}

// --- createGoalLoopState basic ---
{
  const now = new Date("2026-01-01T00:00:00.000Z");
  const s = createGoalLoopState({ goal: "  ship app  ", goalRunId: "run-1", now: () => now, cwd: "/tmp" });
  assert.equal(s.schemaVersion, GOAL_LOOP_STATE_SCHEMA_VERSION);
  assert.equal(s.goal, "ship app");
  assert.equal(s.status, "running");
  assert.equal(s.phase, "goal_received");
  assert.equal(s.currentIteration, 0);
  assert.equal(s.iterations.length, 0);
  assert.ok(s.deadlineAt);
  assert.ok(s.goalRunDir.includes("tmp/infinity-harness/goals/run-1"), "goalRunDir repointed to tmp/infinity-harness/goals");
  assert.ok(s.trace.length === 1 && s.trace[0].event === "goal_received");
  console.log("✓ createGoalLoopState basic + repointed path");
}

// --- validate rejects bad schema ---
{
  const s: any = createGoalLoopState({ goal: "hello", goalRunId: "run-1", cwd: "/tmp" });
  s.schemaVersion = 999;
  assert.throws(() => validateGoalLoopState(s), /schemaVersion/);
  console.log("✓ validate rejects bad schemaVersion");
}

// --- startGoalIteration lifecycle ---
{
  const now = new Date("2026-01-01T00:00:00.000Z");
  let s = createGoalLoopState({ goal: "g", goalRunId: "run-1", cwd: "/tmp", now: () => now });
  s = startGoalIteration(s, { now });
  assert.equal(s.currentIteration, 1);
  assert.equal(s.iterations.length, 1);
  assert.equal(s.iterations[0].status, "pending");
  assert.ok(s.iterations[0].deadlineAt);
  // recordGeneratedTodo
  s = recordGeneratedTodo(s, 1, { todoPath: "/tmp/todo.md", summary: "do things" }, { now });
  assert.equal(s.phase, "todo_generated");
  assert.equal(s.iterations[0].status, "todo_generated");
  assert.equal(s.iterations[0].generatedTodo?.todoPath, "/tmp/todo.md");
  // recordWorkerResult
  s = recordWorkerResult(s, 1, { status: "done", summary: "worker done", endedAt: now.toISOString() } as any, { now });
  assert.equal(s.phase, "todo_executed");
  assert.equal(s.iterations[0].status, "todo_executed");
  // recordReviewerResult incomplete -> stays running, phase reviewed
  s = recordReviewerResult(s, 1, { decision: "incomplete", complete: false, summary: "more work", rationale: "need iteration", remainingWork: ["task-2"], reviewedAt: now.toISOString() } as any, { now });
  assert.equal(s.phase, "reviewed");
  assert.equal(s.status, "running");
  assert.equal(s.iterations[0].status, "reviewed_incomplete");
  // next iteration allowed from reviewed
  s = startGoalIteration(s, { now });
  assert.equal(s.currentIteration, 2);
  assert.equal(s.iterations.length, 2);
  console.log("✓ iteration lifecycle pending->todo_generated->todo_executed->reviewed->next");
}

// --- reviewer complete -> terminal done ---
{
  const now = new Date("2026-01-01T00:00:00.000Z");
  let s = createGoalLoopState({ goal: "g", goalRunId: "run-2", cwd: "/tmp", now: () => now });
  s = startGoalIteration(s, { now });
  s = recordGeneratedTodo(s, 1, { todoPath: "/tmp/todo.md" }, { now });
  s = recordWorkerResult(s, 1, { status: "done", summary: "done", endedAt: now.toISOString() } as any, { now });
  s = recordReviewerResult(s, 1, { decision: "complete", complete: true, summary: "done", rationale: "all good", remainingWork: [], reviewedAt: now.toISOString() } as any, { now });
  assert.equal(s.status, "done");
  assert.equal(s.phase, "complete");
  assert.equal(s.iterations[0].status, "reviewed_complete");
  assert.ok(s.completion);
  console.log("✓ reviewer complete -> done terminal");
}

// --- reviewer blocked/failed map ---
{
  const now = new Date("2026-01-01T00:00:00.000Z");
  for (const [decision, expectedStatus] of [["blocked","blocked"],["failed","failed"]] as const) {
    let s = createGoalLoopState({ goal: "g", goalRunId: `run-${decision}`, cwd: "/tmp", now: () => now });
    s = startGoalIteration(s, { now });
    s = recordGeneratedTodo(s, 1, { todoPath: "/tmp/todo.md" }, { now });
    s = recordWorkerResult(s, 1, { status: "done", summary: "done", endedAt: now.toISOString() } as any, { now });
    s = recordReviewerResult(s, 1, { decision, complete: false, summary: decision, rationale: "reason", remainingWork: [], reviewedAt: now.toISOString() } as any, { now });
    assert.equal(s.status, expectedStatus);
    console.log(`✓ reviewer ${decision} -> ${expectedStatus}`);
  }
}

// --- cancellation ---
{
  const now = new Date("2026-01-01T00:00:00.000Z");
  let s = createGoalLoopState({ goal: "g", goalRunId: "run-c", cwd: "/tmp", now: () => now });
  s = startGoalIteration(s, { now });
  s = cancelGoalLoop(s, "user abort", { now });
  assert.equal(s.status, "cancelled");
  assert.equal(s.phase, "cancelled");
  assert.ok(s.cancellation.requested);
  const reason = goalLoopStopReason(s, { now });
  assert.ok(reason && reason.kind === "complete", "terminal already done -> stopReason complete");
  console.log("✓ cancellation -> cancelled + abort guard");
}

// --- timeout via deadlineAt ---
{
  const start = new Date("2026-01-01T00:00:00.000Z");
  let s = createGoalLoopState({ goal: "g", goalRunId: "run-timeout", cwd: "/tmp", now: () => start, timeoutMs: 1000 });
  // fast-forward past deadline
  const later = new Date(start.getTime() + 5000);
  const reason = goalLoopStopReason(s, { now: later });
  assert.ok(reason && reason.kind === "timeout");
  s = startGoalIteration(s, { now: later });
  // start with expired should transition to partial/failed via completeStateForStopReason
  assert.ok(s.status === "partial" || s.status === "failed" || s.status === "cancelled");
  console.log("✓ timeout -> stopReason timeout then terminal on start");
}

// --- max_iterations guard ---
{
  const now = new Date("2026-01-01T00:00:00.000Z");
  let s = createGoalLoopState({ goal: "g", goalRunId: "run-max", cwd: "/tmp", now: () => now, maxIterations: 1, minIterations: 1 });
  s = startGoalIteration(s, { now });
  s = recordGeneratedTodo(s, 1, { todoPath: "/tmp/t.md" }, { now });
  s = recordWorkerResult(s, 1, { status: "done", summary: "done", endedAt: now.toISOString() } as any, { now });
  s = recordReviewerResult(s, 1, { decision: "incomplete", complete: false, summary: "more", rationale: "more", remainingWork: ["x"], reviewedAt: now.toISOString() } as any, { now });
  // now at maxIterations with phase reviewed -> should report max_iterations
  const reason = goalLoopStopReason(s, { now });
  assert.ok(reason && reason.kind === "max_iterations", `expected max_iterations got ${reason?.kind}`);
  console.log("✓ max_iterations guard");
}

// --- failGoalLoop ---
{
  const now = new Date("2026-01-01T00:00:00.000Z");
  let s = createGoalLoopState({ goal: "g", goalRunId: "run-fail", cwd: "/tmp", now: () => now });
  s = failGoalLoop(s, "boom", { now });
  assert.equal(s.status, "failed");
  assert.equal(s.phase, "failed");
  console.log("✓ failGoalLoop -> failed");
}

// --- cannot start from wrong phase (e.g. todo_generated) ---
{
  const now = new Date("2026-01-01T00:00:00.000Z");
  let s = createGoalLoopState({ goal: "g", goalRunId: "run-wrong", cwd: "/tmp", now: () => now });
  s = startGoalIteration(s, { now });
  s = recordGeneratedTodo(s, 1, { todoPath: "/tmp/t.md" }, { now });
  assert.throws(() => startGoalIteration(s, { now }), /Cannot start/);
  console.log("✓ guard cannot start from wrong phase");
}

// --- abortSignal cancelled ---
{
  const now = new Date("2026-01-01T00:00:00.000Z");
  let s = createGoalLoopState({ goal: "g", goalRunId: "run-abort", cwd: "/tmp", now: () => now });
  const ac = new AbortController();
  ac.abort();
  const reason = goalLoopStopReason(s, { now, abortSignal: ac.signal });
  assert.ok(reason && reason.kind === "cancelled");
  console.log("✓ abortSignal -> cancelled");
}

console.log("All goalLoop tests PASS");
