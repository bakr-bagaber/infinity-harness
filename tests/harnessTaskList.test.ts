import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  atomicApply,
  ValidationError,
  makeState,
  harnessStateFromFile,
  fileFromHarnessState,
  applyToFile,
  loadHarnessState,
} from "../src/harnessTaskList.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────
function stateWith(tasks: Array<{ key: string; subject: string; status: string; dependsOn?: string[] }>, revision = 0) {
  return makeState(
    revision,
    tasks.map((t) => ({
      key: t.key,
      subject: t.subject,
      status: t.status,
      dependsOn: t.dependsOn ?? [],
      subtasks: [],
    })),
  );
}

function assertThrowsValidation(fn: () => any, msgMatch?: string) {
  let threw = false;
  try {
    fn();
  } catch (e: any) {
    threw = true;
    assert.ok(e instanceof ValidationError || e.name === "ValidationError", `expected ValidationError, got ${e}`);
    if (msgMatch) assert.match(e.message, new RegExp(msgMatch), `error message should match ${msgMatch}: got ${e.message}`);
    return e;
  }
  assert.fail("expected ValidationError to be thrown");
}

// ── 1. baseRevision check ───────────────────────────────────────────────────
{
  const cur = stateWith([{ key: "a", subject: "A", status: "pending" }], 2);
  // stale should throw, no mutation
  const before = JSON.stringify(cur);
  assertThrowsValidation(() => atomicApply(cur, { baseRevision: 1, tasks: [{ key: "a", subject: "A", status: "complete" }] }), "stale");
  assert.equal(JSON.stringify(cur), before, "state must not mutate on stale revision");
  // correct revision succeeds and increments
  const res = atomicApply(cur, { baseRevision: 2, tasks: [{ key: "a", subject: "A", status: "complete" }] });
  assert.equal(res.revision, 3, "revision increments on change");
  // no change preserves revision
  const res2 = atomicApply(res, { baseRevision: 3, tasks: [{ key: "a", subject: "A", status: "complete" }] });
  assert.equal(res2.revision, 3, "no-op preserves revision");
  console.log("✓ baseRevision check");
}

// ── 2. omission = deletion ──────────────────────────────────────────────────
{
  const cur = stateWith(
    [
      { key: "a", subject: "A", status: "complete" },
      { key: "b", subject: "B", status: "pending" },
      { key: "c", subject: "C", status: "pending" },
    ],
    0,
  );
  const res = atomicApply(cur, {
    tasks: [
      { key: "a", subject: "A", status: "complete" },
      // omit b -> should be deleted
      { key: "c", subject: "C", status: "pending" },
    ],
  });
  assert.equal(res.tasks.length, 2);
  assert.ok(!res.tasks.find((t) => t.key === "b"), "omitted b should be deleted");
  assert.deepEqual(res.change.removed, ["b"]);
  assert.ok(res.change.reordered || res.tasks.length !== cur.tasks.length);

  // omission that deletes a completed task that is still dependency of pending should be handled?
  // Our semantics: if completed task is deleted and pending depends on it, missing dep will reject unless we prune?
  // But spec says completed→completed soft prune only; pending→missing should reject.
  // Test that omitting a completed task that pending depends on is rejected
  const cur2 = stateWith([
    { key: "a", subject: "A", status: "complete" },
    { key: "b", subject: "B", status: "pending", dependsOn: ["a"] },
  ]);
  assertThrowsValidation(() => atomicApply(cur2, { tasks: [{ key: "b", subject: "B", status: "pending", dependsOn: ["a"] }] }), "missing");
  // But if b is complete and depends on a (completed), omitting a should prune and succeed
  const cur3 = stateWith([
    { key: "a", subject: "A", status: "complete" },
    { key: "b", subject: "B", status: "complete", dependsOn: ["a"] },
  ]);
  const res3 = atomicApply(cur3, { tasks: [{ key: "b", subject: "B", status: "complete", dependsOn: ["a"] }] });
  assert.equal(res3.tasks.length, 1);
  assert.equal(res3.tasks[0].dependsOn.length, 0, "completed→completed dep should be pruned when target deleted");

  // tasks: [] clears plan
  const res4 = atomicApply(cur, { tasks: [] });
  assert.equal(res4.tasks.length, 0, "empty tasks clears plan");
  console.log("✓ omission=deletion");
}

// ── 3. cycle / missing dep check ────────────────────────────────────────────
{
  const cur = stateWith([], 0);
  // missing dep
  assertThrowsValidation(
    () =>
      atomicApply(cur, {
        tasks: [{ key: "a", subject: "A", status: "pending", dependsOn: ["missing"] }],
      }),
    "missing",
  );

  // cycle: a→b, b→a
  assertThrowsValidation(
    () =>
      atomicApply(cur, {
        tasks: [
          { key: "a", subject: "A", status: "pending", dependsOn: ["b"] },
          { key: "b", subject: "B", status: "pending", dependsOn: ["a"] },
        ],
      }),
    "cycle",
  );

  // longer cycle a→b→c→a
  assertThrowsValidation(
    () =>
      atomicApply(cur, {
        tasks: [
          { key: "a", subject: "A", status: "pending", dependsOn: ["c"] },
          { key: "b", subject: "B", status: "pending", dependsOn: ["a"] },
          { key: "c", subject: "C", status: "pending", dependsOn: ["b"] },
        ],
      }),
    "cycle",
  );

  // self-cycle
  assertThrowsValidation(
    () =>
      atomicApply(cur, {
        tasks: [{ key: "a", subject: "A", status: "pending", dependsOn: ["a"] }],
      }),
    "cycle",
  );

  console.log("✓ cycle/missing dep check");
}

// ── 4. in_progress needs deps completed, all-or-nothing ────────────────────
{
  const cur = stateWith(
    [
      { key: "a", subject: "A", status: "pending" },
      { key: "b", subject: "B", status: "pending" },
    ],
    0,
  );

  // in_progress with uncompleted dep should reject
  assertThrowsValidation(
    () =>
      atomicApply(cur, {
        tasks: [
          { key: "a", subject: "A", status: "pending" },
          { key: "b", subject: "B", status: "in_progress", dependsOn: ["a"] },
        ],
      }),
    "unresolved",
  );

  // but if dep is completed, it should succeed
  const cur2 = stateWith([
    { key: "a", subject: "A", status: "complete" },
    { key: "b", subject: "B", status: "pending", dependsOn: ["a"] },
  ]);
  const res = atomicApply(cur2, {
    tasks: [
      { key: "a", subject: "A", status: "complete" },
      { key: "b", subject: "B", status: "in_progress", dependsOn: ["a"] },
    ],
  });
  assert.equal(res.tasks.find((t) => t.key === "b")?.status, "in_progress");

  // completed also requires deps completed
  assertThrowsValidation(
    () =>
      atomicApply(cur, {
        tasks: [
          { key: "a", subject: "A", status: "pending" },
          { key: "b", subject: "B", status: "complete", dependsOn: ["a"] },
        ],
      }),
    "unresolved",
  );

  // all-or-nothing: one valid, one invalid -> no partial mutation
  const before = JSON.stringify(cur);
  try {
    atomicApply(cur, {
      tasks: [
        { key: "a", subject: "A", status: "complete" }, // valid
        { key: "b", subject: "B", status: "in_progress", dependsOn: ["a"] }, // valid if a complete, but let's make missing dep on b
        { key: "c", subject: "C", status: "pending", dependsOn: ["missing"] }, // invalid missing
      ],
    });
    assert.fail("should throw");
  } catch (e: any) {
    assert.ok(e instanceof ValidationError);
    assert.equal(JSON.stringify(cur), before, "current state must not mutate on failed atomic");
  }

  console.log("✓ in_progress needs deps completed, all-or-nothing");
}

// ── 5. hidden custom checkpoint semantics via atomic result shape ───────────
{
  // Successful result must contain rev and tasks for toolResult.details
  const cur = stateWith([{ key: "a", subject: "A", status: "pending" }], 5);
  const res = atomicApply(cur, { baseRevision: 5, tasks: [{ key: "a", subject: "A", status: "complete" }] });
  assert.equal(res.revision, 6);
  assert.equal(res.tasks.length, 1);
  assert.equal(res.tasks[0].status, "complete");
  // change tracking
  assert.deepEqual(res.change.added, []);
  assert.deepEqual(res.change.updated, ["a"]);
  assert.deepEqual(res.change.removed, []);
  console.log("✓ toolResult.details shape (rev, tasks)");
}

// ── 6. file helpers: harnessStateFromFile ↔ fileFromHarnessState ────────────
{
  const file: any = {
    version: "0.1",
    baseRevision: 3,
    goals: [{ id: "goal-001", title: "G" }],
    sprints: [{ id: "sprint-001", name: "S" }],
    features: [
      {
        id: "feature-001",
        name: "F",
        passes: false,
        tasks: [
          { id: "task-001", key: "schema-5level", description: "Task A", status: "complete", dependsOn: [], subtasks: [] },
          { id: "task-002", key: "widget-render", description: "Task B", status: "pending", dependsOn: ["schema-5level"], subtasks: [{ id: "st-1", title: "sub", status: "pending" }] },
        ],
      },
    ],
  };
  const state = harnessStateFromFile(file);
  assert.equal(state.revision, 3);
  assert.equal(state.tasks.length, 2);
  assert.equal(state.tasks[0].key, "schema-5level");
  assert.equal(state.tasks[1].dependsOn[0], "schema-5level");
  assert.equal(state.tasks[1].subtasks[0].title, "sub");

  const nextState = makeState(4, [
    { key: "schema-5level", subject: "Task A", status: "complete", dependsOn: [], subtasks: [] },
    { key: "widget-render", subject: "Task B updated", status: "in_progress", dependsOn: ["schema-5level"], subtasks: [] },
    { key: "atomic-tool", subject: "New task", status: "pending", dependsOn: [], subtasks: [] },
  ]);
  const nextFile = fileFromHarnessState(file, nextState as any);
  assert.equal(nextFile.baseRevision, 4);
  assert.equal(nextFile.goals?.length, 1, "goals preserved");
  assert.equal(nextFile.sprints?.length, 1, "sprints preserved");
  assert.equal(nextFile.features[0].tasks.length, 3);
  assert.equal(nextFile.features[0].tasks[1].description, "Task B updated");
  console.log("✓ file helpers preserve 5-level fields");
}

// ── 7. applyToFile: atomic file persistence, omission, revision increment ───
{
  const tmp = mkdtempSync(join(tmpdir(), "harness-test-"));
  try {
    const projectDir = tmp;
    const featureListPath = join(projectDir, "harness", "features", "feature-list.json");
    mkdirSync(join(projectDir, "harness", "features"), { recursive: true });
    const initial: any = {
      version: "0.1",
      baseRevision: 1,
      goals: [{ id: "goal-001", title: "G" }],
      sprints: [{ id: "sprint-001", name: "S" }],
      features: [
        {
          id: "feature-001",
          name: "F",
          passes: false,
          tasks: [
            { id: "a", key: "a", description: "A", status: "complete", dependsOn: [], subtasks: [] },
            { id: "b", key: "b", description: "B", status: "pending", dependsOn: ["a"], subtasks: [] },
          ],
        },
      ],
    };
    writeFileSync(featureListPath, JSON.stringify(initial, null, 2), "utf-8");

    // stale should throw and not mutate file
    const before = readFileSync(featureListPath, "utf-8");
    assertThrowsValidation(() => applyToFile(projectDir, { baseRevision: 0, tasks: [{ key: "a", subject: "A", status: "complete" }] }), "stale");
    assert.equal(readFileSync(featureListPath, "utf-8"), before, "file not mutated on stale");

    // omission deletion + status update should increment revision and persist
    const res = applyToFile(projectDir, {
      baseRevision: 1,
      tasks: [
        { key: "a", subject: "A", status: "complete" },
        { key: "b", subject: "B", status: "in_progress", dependsOn: ["a"] },
      ],
    });
    assert.equal(res.revision, 2);
    const after = JSON.parse(readFileSync(featureListPath, "utf-8"));
    assert.equal(after.baseRevision, 2);
    assert.equal(after.features[0].tasks.length, 2);
    assert.equal(after.features[0].tasks.find((t: any) => t.key === "b").status, "in_progress");
    assert.equal(after.goals.length, 1, "goals preserved after file write");

    // cycle should be rejected and file untouched
    const before2 = readFileSync(featureListPath, "utf-8");
    assertThrowsValidation(
      () =>
        applyToFile(projectDir, {
          baseRevision: 2,
          tasks: [
            { key: "a", subject: "A", status: "pending", dependsOn: ["b"] },
            { key: "b", subject: "B", status: "pending", dependsOn: ["a"] },
          ],
        }),
      "cycle",
    );
    assert.equal(readFileSync(featureListPath, "utf-8"), before2);

    // in_progress with incomplete dep rejected, file untouched
    assertThrowsValidation(
      () =>
        applyToFile(projectDir, {
          baseRevision: 2,
          tasks: [
            { key: "a", subject: "A", status: "pending" },
            { key: "b", subject: "B", status: "in_progress", dependsOn: ["a"] },
          ],
        }),
      "unresolved",
    );
    assert.equal(readFileSync(featureListPath, "utf-8"), before2);

    // all-or-nothing: mixed valid+invalid should not partially write
    assertThrowsValidation(
      () =>
        applyToFile(projectDir, {
          baseRevision: 2,
          tasks: [
            { key: "a", subject: "A", status: "complete" },
            { key: "c", subject: "C", status: "pending", dependsOn: ["missing"] },
          ],
        }),
      "missing",
    );
    assert.equal(readFileSync(featureListPath, "utf-8"), before2);

    // new task requires subject/status
    assertThrowsValidation(
      () =>
        applyToFile(projectDir, {
          baseRevision: 2,
          tasks: [
            { key: "a", subject: "A", status: "complete" },
            { key: "b", subject: "B", status: "in_progress", dependsOn: ["a"] },
            { key: "new-key", status: "pending" as any }, // missing subject
          ],
        }),
      "subject",
    );

    // duplicate key rejected
    assertThrowsValidation(
      () =>
        applyToFile(projectDir, {
          baseRevision: 2,
          tasks: [
            { key: "a", subject: "A", status: "complete" },
            { key: "a", subject: "A dup", status: "pending" },
          ],
        }),
      "duplicated",
    );

    // omission deletion clears task
    const res2 = applyToFile(projectDir, {
      baseRevision: 2,
      tasks: [{ key: "a", subject: "A", status: "complete" }], // omit b
    });
    assert.equal(res2.tasks.length, 1);
    assert.equal(JSON.parse(readFileSync(featureListPath, "utf-8")).features[0].tasks.length, 1);
    assert.equal(JSON.parse(readFileSync(featureListPath, "utf-8")).baseRevision, 3);

    console.log("✓ applyToFile atomic file persistence");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 8. Widget survives via file + state replay (file is SSOT but replay supplies branch correct) ──
{
  // Simulate that extension reconstructs state from file + toolResult.details
  // For now, just ensure loadHarnessState reflects file after applyToFile
  const tmp = mkdtempSync(join(tmpdir(), "harness-replay-"));
  try {
    mkdirSync(join(tmp, "harness", "features"), { recursive: true });
    writeFileSync(
      join(tmp, "harness", "features", "feature-list.json"),
      JSON.stringify({
        version: "0.1",
        baseRevision: 0,
        features: [{ id: "feature-001", name: "F", passes: false, tasks: [{ id: "a", key: "a", description: "A", status: "pending", dependsOn: [] }] }],
      }),
      "utf-8",
    );
    applyToFile(tmp, { baseRevision: 0, tasks: [{ key: "a", subject: "A", status: "complete" }] });
    const { state } = loadHarnessState(tmp);
    assert.equal(state.revision, 1);
    assert.equal(state.tasks[0].status, "complete");
    // Simulate compaction: after compaction, file still has rev 1, but hidden checkpoint would replay same
    // Ensure file survives
    assert.equal(JSON.parse(readFileSync(join(tmp, "harness", "features", "feature-list.json"), "utf-8")).baseRevision, 1);
    console.log("✓ widget survives via file replay");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("All harnessTaskList tests PASS");
