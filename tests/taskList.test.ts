import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyTaskList, writeTaskList, summarizeApply } from "../src/taskList.ts";
import { ValidationError, type FeatureList, type Task, type TaskStatus } from "../src/core/types.ts";

function mkTask(id: string, status: TaskStatus, extra: Record<string, unknown> = {}): Task {
  return {
    id,
    key: id,
    description: id.toUpperCase(),
    status,
    dependsOn: [],
    subtasks: [],
    ...extra,
  };
}

function listWith(tasks: Task[], baseRevision = 0): FeatureList {
  return {
    version: "2.0",
    baseRevision,
    goals: [{ id: "goal-001", title: "G" }],
    sprints: [{ id: "sprint-001", name: "S" }],
    features: [{ id: "feature-001", name: "F", passes: false, tasks }],
  };
}

function tmpProject(): string {
  const d = mkdtempSync(join(tmpdir(), "pi-tasklist-"));
  mkdirSync(join(d, "harness", "features"), { recursive: true });
  return d;
}

function featureListFile(dir: string): string {
  return join(dir, "harness", "features", "feature-list.json");
}

function assertValidation(fn: () => unknown, match: RegExp): void {
  try {
    fn();
  } catch (e) {
    const err = e as Error;
    assert.ok(
      err instanceof ValidationError || err.name === "ValidationError",
      `expected ValidationError, got ${err?.name}: ${err?.message}`,
    );
    assert.match(err.message, match);
    return;
  }
  assert.fail(`expected ValidationError matching ${match}`);
}

// ── baseRevision is the concurrency guard ───────────────────────────────────
{
  const cur = listWith([mkTask("a", "pending")], 2);
  const before = JSON.stringify(cur);

  assertValidation(
    () => applyTaskList(cur, { baseRevision: 1, tasks: [{ key: "a", subject: "A", status: "complete" }] }),
    /stale baseRevision/,
  );
  assert.equal(JSON.stringify(cur), before, "a rejected apply must not mutate the input list");

  const res = applyTaskList(cur, { baseRevision: 2, tasks: [{ key: "a", subject: "A", status: "complete" }] });
  assert.equal(res.revision, 3, "a real change bumps the revision");
  assert.equal(res.changed, true);
  assert.equal(JSON.stringify(cur), before, "a successful apply is pure w.r.t. the input list");

  // An omitted baseRevision opts out of the check entirely.
  const noCheck = applyTaskList(cur, { tasks: [{ key: "a", subject: "A", status: "complete" }] });
  assert.equal(noCheck.revision, 3);

  // Resubmitting the same content is a no-op: the revision must not move.
  const same = applyTaskList(res.list, { baseRevision: 3, tasks: [{ key: "a", subject: "A", status: "complete" }] });
  assert.equal(same.changed, false);
  assert.equal(same.revision, 3, "a no-op submission does not move the revision");
  assert.deepEqual(same.change, { added: [], updated: [], removed: [], reordered: false });
  console.log("✓ baseRevision guard, purity, and no-op detection");
}

// ── omission means deletion ────────────────────────────────────────────────
{
  const cur = listWith(
    [mkTask("a", "complete"), mkTask("b", "pending"), mkTask("c", "pending")],
    0,
  );
  const res = applyTaskList(cur, {
    tasks: [
      { key: "a", subject: "A", status: "complete" },
      { key: "c", subject: "C", status: "pending" },
    ],
  });
  assert.equal(res.tasks.length, 2);
  assert.deepEqual(res.change.removed, ["b"], "the omitted task is deleted");
  assert.ok(!res.tasks.some((t) => t.compositeKey === "b"));

  // Clearing the plan is legal and expressed the same way.
  const cleared = applyTaskList(cur, { tasks: [] });
  assert.equal(cleared.tasks.length, 0);
  assert.equal(summarizeApply(cleared), `Plan cleared (revision ${cleared.revision}).`);
  console.log("✓ omission = deletion");
}

// ── dangling vs satisfied dependencies ─────────────────────────────────────
{
  // Deleting a task something still depends on is a planning error.
  const pendingDep = listWith([mkTask("a", "pending"), mkTask("b", "pending", { dependsOn: ["a"] })]);
  assertValidation(
    () => applyTaskList(pendingDep, { tasks: [{ key: "b", subject: "B", status: "pending", dependsOn: ["a"] }] }),
    /unknown task "a"/,
  );

  // Deleting a *completed* task is housekeeping: the dependency is satisfied,
  // so it is pruned rather than treated as dangling.
  const doneDep = listWith([mkTask("a", "complete"), mkTask("b", "complete", { dependsOn: ["a"] })]);
  const pruned = applyTaskList(doneDep, {
    tasks: [{ key: "b", subject: "B", status: "complete", dependsOn: ["a"] }],
  });
  assert.equal(pruned.tasks.length, 1);
  assert.deepEqual(pruned.tasks[0]!.dependsOn, [], "dep on a deleted completed task is pruned");
  console.log("✓ dangling deps rejected, satisfied deps pruned");
}

// ── cycles ─────────────────────────────────────────────────────────────────
{
  const empty = listWith([]);
  assertValidation(
    () =>
      applyTaskList(empty, {
        tasks: [
          { key: "a", subject: "A", status: "pending", dependsOn: ["b"] },
          { key: "b", subject: "B", status: "pending", dependsOn: ["a"] },
        ],
      }),
    /dependency cycle/,
  );
  assertValidation(
    () => applyTaskList(empty, { tasks: [{ key: "a", subject: "A", status: "pending", dependsOn: ["a"] }] }),
    /dependency cycle/,
  );
  assertValidation(
    () =>
      applyTaskList(empty, {
        tasks: [
          { key: "a", subject: "A", status: "pending", dependsOn: ["c"] },
          { key: "b", subject: "B", status: "pending", dependsOn: ["a"] },
          { key: "c", subject: "C", status: "pending", dependsOn: ["b"] },
        ],
      }),
    /dependency cycle/,
  );
  // A diamond is a DAG, not a cycle.
  const dag = applyTaskList(empty, {
    tasks: [
      { key: "a", subject: "A", status: "pending" },
      { key: "b", subject: "B", status: "pending", dependsOn: ["a"] },
      { key: "c", subject: "C", status: "pending", dependsOn: ["a"] },
      { key: "d", subject: "D", status: "pending", dependsOn: ["b", "c"] },
    ],
  });
  assert.equal(dag.tasks.length, 4);
  console.log("✓ cycles rejected, DAG accepted");
}

// ── a task cannot start before its dependencies finish ─────────────────────
{
  const cur = listWith([mkTask("a", "pending"), mkTask("b", "pending")]);
  for (const status of ["in_progress", "complete"]) {
    assertValidation(
      () =>
        applyTaskList(cur, {
          tasks: [
            { key: "a", subject: "A", status: "pending" },
            { key: "b", subject: "B", status, dependsOn: ["a"] },
          ],
        }),
      /cannot be "(in_progress|complete)" while these are incomplete: a/,
    );
  }
  const ok = applyTaskList(cur, {
    tasks: [
      { key: "a", subject: "A", status: "complete" },
      { key: "b", subject: "B", status: "in_progress", dependsOn: ["a"] },
    ],
  });
  assert.equal(ok.tasks.find((t) => t.compositeKey === "b")?.status, "in_progress");
  console.log("✓ status/dependency consistency");
}

// ── input validation ───────────────────────────────────────────────────────
{
  const cur = listWith([mkTask("a", "pending")]);
  assertValidation(
    () =>
      applyTaskList(cur, {
        tasks: [
          { key: "a", subject: "A", status: "pending" },
          { key: "a", subject: "dup", status: "pending" },
        ],
      }),
    /duplicated/,
  );
  assertValidation(() => applyTaskList(cur, { tasks: [{ key: "brand-new", status: "pending" }] }), /subject is required/);
  assertValidation(() => applyTaskList(cur, { tasks: [{ key: "brand-new", subject: "N" }] }), /status is required/);
  assertValidation(() => applyTaskList(cur, { tasks: [{ key: "", subject: "N", status: "pending" }] }), /non-empty/);
  assertValidation(
    () => applyTaskList(cur, { tasks: [{ key: "bad key!", subject: "N", status: "pending" }] }),
    /not|must be/,
  );
  assertValidation(
    () => applyTaskList(cur, { tasks: [{ key: "a", subject: "A", status: "nonsense" }] }),
    /status is invalid/,
  );
  // Status aliases are accepted and normalised.
  const aliased = applyTaskList(cur, { tasks: [{ key: "a", subject: "A", status: "done" }] });
  assert.equal(aliased.tasks[0]!.status, "complete");
  console.log("✓ input validation");
}

// ── unknown fields on a stored task survive an update ──────────────────────
{
  const cur = listWith([
    mkTask("a", "pending", {
      difficulty: "difficult",
      modelHint: "big-model",
      criteria: ["it works"],
      ownerNote: "written by a future version",
      estimate: 42,
    }),
  ]);
  const res = applyTaskList(cur, { tasks: [{ key: "a", subject: "A", status: "in_progress" }] });
  const t = res.tasks[0]!;
  assert.equal(t.status, "in_progress");
  assert.equal(t.difficulty, "difficult", "difficulty survives");
  assert.equal(t.modelHint, "big-model", "modelHint survives");
  assert.deepEqual(t.criteria, ["it works"], "criteria survive");
  assert.equal(t.ownerNote, "written by a future version", "unknown field survives");
  assert.equal(t.estimate, 42, "unknown numeric field survives");
  // View-only fields from flattenTasks must never be persisted onto the task.
  const stored = res.list.features[0]!.tasks[0]! as Record<string, unknown>;
  for (const view of ["index", "compositeKey", "featureId", "featureName"]) {
    assert.equal(view in stored, false, `${view} must not be persisted`);
  }
  console.log("✓ unknown fields survive a merge");
}

// ── composite keys route tasks to their feature ────────────────────────────
{
  const cur = listWith([mkTask("a", "pending")]);
  const res = applyTaskList(cur, {
    tasks: [
      { key: "a", subject: "A", status: "pending" },
      { key: "feature-002/task-9", subject: "Elsewhere", status: "pending" },
    ],
  });
  assert.equal(res.list.features.length, 2, "an unseen feature id creates the feature");
  const created = res.list.features.find((f) => f.id === "feature-002");
  assert.ok(created);
  assert.equal(created!.tasks[0]!.id, "task-9");
  assert.equal(res.tasks[1]!.compositeKey, "feature-002/task-9");
  assert.equal(res.tasks[1]!.index, 2, "index is 1-based across the whole plan");
  console.log("✓ composite keys create/route features");
}

// ── feature.passes is derived, never asserted by the agent ─────────────────
{
  const cur = listWith([mkTask("a", "pending"), mkTask("b", "pending")]);
  const half = applyTaskList(cur, {
    tasks: [
      { key: "a", subject: "A", status: "complete" },
      { key: "b", subject: "B", status: "pending" },
    ],
  });
  assert.equal(half.list.features[0]!.passes, false);
  const all = applyTaskList(half.list, {
    tasks: [
      { key: "a", subject: "A", status: "complete" },
      { key: "b", subject: "B", status: "complete" },
    ],
  });
  assert.equal(all.list.features[0]!.passes, true, "feature passes once every task is complete");
  console.log("✓ feature.passes derived from task statuses");
}

// ── writeTaskList: persistence, metadata, and the no-op path ───────────────
{
  const dir = tmpProject();
  try {
    // No file on disk yet: the plan is seeded from empty.
    const first = writeTaskList(dir, { tasks: [{ key: "a", subject: "A", status: "pending" }] });
    assert.equal(first.revision, 1);
    const onDisk = JSON.parse(readFileSync(featureListFile(dir), "utf-8"));
    assert.equal(onDisk.baseRevision, 1);
    assert.equal(onDisk.features[0].tasks.length, 1);

    // Metadata the editor knows nothing about is carried through a write.
    onDisk.goals = [{ id: "goal-001", title: "G" }];
    onDisk.sprints = [{ id: "sprint-001", name: "S" }];
    onDisk.features[0].criteria = ["ships"];
    onDisk.features[0].tasks[0].ownerNote = "keep me";
    writeFileSync(featureListFile(dir), JSON.stringify(onDisk, null, 2), "utf-8");

    const second = writeTaskList(dir, {
      baseRevision: 1,
      tasks: [
        { key: "a", subject: "A", status: "complete" },
        { key: "b", subject: "B", status: "pending", dependsOn: ["a"] },
      ],
    });
    assert.equal(second.revision, 2);
    const after = JSON.parse(readFileSync(featureListFile(dir), "utf-8"));
    assert.equal(after.baseRevision, 2);
    assert.equal(after.goals.length, 1, "goals preserved through a write");
    assert.equal(after.sprints.length, 1, "sprints preserved through a write");
    assert.deepEqual(after.features[0].criteria, ["ships"], "feature criteria preserved");
    assert.equal(after.features[0].tasks[0].ownerNote, "keep me", "unknown task field preserved on disk");

    // A stale write is rejected and leaves the file untouched.
    const before = readFileSync(featureListFile(dir), "utf-8");
    assertValidation(
      () => writeTaskList(dir, { baseRevision: 0, tasks: [{ key: "a", subject: "A", status: "complete" }] }),
      /stale baseRevision/,
    );
    assert.equal(readFileSync(featureListFile(dir), "utf-8"), before, "file untouched after a rejected write");

    // A no-op write does not move the revision on disk.
    const noop = writeTaskList(dir, {
      baseRevision: 2,
      tasks: [
        { key: "a", subject: "A", status: "complete" },
        { key: "b", subject: "B", status: "pending", dependsOn: ["a"] },
      ],
    });
    assert.equal(noop.changed, false);
    assert.equal(JSON.parse(readFileSync(featureListFile(dir), "utf-8")).baseRevision, 2);
    console.log("✓ writeTaskList persists, preserves metadata, rejects stale writes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── summarizeApply ─────────────────────────────────────────────────────────
{
  const cur = listWith([mkTask("a", "pending"), mkTask("b", "pending")]);
  const res = applyTaskList(cur, {
    tasks: [
      { key: "a", subject: "A", status: "complete" },
      { key: "c", subject: "Cee", status: "pending" },
    ],
  });
  const text = summarizeApply(res);
  assert.match(text, new RegExp(`Plan revision ${res.revision}`));
  assert.match(text, /\+1/, "one added");
  assert.match(text, /~1/, "one updated");
  assert.match(text, /-1/, "one removed");
  assert.match(text, /1\. \[complete\] a: A/);
  assert.match(text, /2\. \[pending\] c: Cee/);
  console.log("✓ summarizeApply");
}

console.log("All taskList tests PASS");

// ── feature metadata ───────────────────────────────────────────────────────
// Features are derived from task keys, which left no way to give one a name or
// its acceptance criteria — and the DEFINE gate requires criteria on every
// feature. The first gate in the pipeline was unpassable through the tools.
{
  const dir = tmpProject();

  // DEFINE: criteria exist before tasks do, so this submits no `tasks` field.
  const defined = writeTaskList(dir, {
    goal: "Ship the thing",
    features: [{ id: "feature-001", name: "Checkout", criteria: ["it charges once", "it refunds"] }],
  });
  assert.ok(defined.changed, "writing criteria is a change");
  assert.equal(defined.list.features[0]!.name, "Checkout");
  assert.deepEqual(defined.list.features[0]!.criteria, ["it charges once", "it refunds"]);
  assert.equal(defined.list.goals?.[0]?.title, "Ship the thing");
  assert.deepEqual(defined.list.features[0]!.tasks, [], "a feature may exist before its tasks");

  // PLAN: tasks arrive, and must not wipe the criteria written in DEFINE.
  const planned = writeTaskList(dir, {
    baseRevision: defined.revision,
    tasks: [{ key: "feature-001/task-001", subject: "charge the card", status: "pending" }],
  });
  assert.deepEqual(planned.list.features[0]!.criteria, ["it charges once", "it refunds"]);
  assert.equal(planned.list.features[0]!.name, "Checkout", "and the name survives too");
  assert.equal(planned.list.features[0]!.tasks.length, 1);

  // Omitting a feature leaves it alone — it is a merge, not a submission.
  const more = writeTaskList(dir, {
    baseRevision: planned.revision,
    features: [{ id: "feature-002", name: "Refunds", criteria: ["money goes back"] }],
  });
  assert.equal(more.list.features.length, 2);
  assert.equal(more.list.features[0]!.name, "Checkout", "feature-001 was not touched");
  assert.equal(more.list.features[0]!.tasks.length, 1, "and kept its tasks");

  // An unchanged resubmission does not move the revision.
  const noop = writeTaskList(dir, {
    baseRevision: more.revision,
    features: [{ id: "feature-002", name: "Refunds", criteria: ["money goes back"] }],
  });
  assert.equal(noop.changed, false);
  assert.equal(noop.revision, more.revision);

  rmSync(dir, { recursive: true, force: true });
  console.log("✓ features carry names and criteria, merged rather than resubmitted");
}

// Absent tasks means "leave them"; an empty array still means "delete them".
{
  const dir = tmpProject();
  const seeded = writeTaskList(dir, {
    tasks: [
      { key: "feature-001/task-001", subject: "a", status: "pending" },
      { key: "feature-001/task-002", subject: "b", status: "pending" },
    ],
  });
  assert.equal(seeded.tasks.length, 2);

  const metaOnly = writeTaskList(dir, {
    baseRevision: seeded.revision,
    features: [{ id: "feature-001", criteria: ["c"] }],
  });
  assert.equal(metaOnly.tasks.length, 2, "a metadata write must not delete the plan");

  const emptied = writeTaskList(dir, { baseRevision: metaOnly.revision, tasks: [] });
  assert.equal(emptied.tasks.length, 0, "an explicit empty list still clears it");
  assert.deepEqual(emptied.list.features[0]?.criteria, ["c"], "without losing the criteria");
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ omitting tasks is not the same as sending none");
}

// Bad input is refused with something the model can act on.
{
  const dir = tmpProject();
  assert.throws(() => writeTaskList(dir, {}), /nothing submitted/);
  assert.throws(
    () => writeTaskList(dir, { features: [{ id: "feature-001", tasks: [] } as never] }),
    /top-level "tasks" array/,
  );
  assert.throws(
    () => writeTaskList(dir, { features: [{ id: "feature-001", criteria: ["ok", ""] }] }),
    /must be non-empty/,
  );
  assert.throws(
    () => writeTaskList(dir, { features: [{ id: "", criteria: ["x"] }] }),
    /features\[0\]\.id/,
  );
  assert.throws(
    () => writeTaskList(dir, { features: [{ id: "f", criteria: Array(41).fill("x") }] }),
    /at most 40/,
  );
  // Duplicates in one submission collapse rather than being stored twice.
  const ok = writeTaskList(dir, { features: [{ id: "feature-001", criteria: ["same", "same"] }] });
  assert.deepEqual(ok.list.features[0]!.criteria, ["same"]);
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ malformed feature metadata is refused with a message that says the fix");
}
