import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeProgress,
  detectCycle,
  emptyFeatureList,
  findFeature,
  findTask,
  flattenTasks,
  isDone,
  loadFeatureList,
  nextActionableTask,
  normalizeStatus,
  normalizeSubtaskStatus,
  saveFeatureList,
  validateKey,
} from "../src/core/featureList.ts";
import { ValidationError, type FeatureList, type Task, type TaskStatus } from "../src/core/types.ts";

function tmpProject(): string {
  const d = mkdtempSync(join(tmpdir(), "pi-featurelist-"));
  mkdirSync(join(d, "harness", "features"), { recursive: true });
  return d;
}

function planFile(dir: string): string {
  return join(dir, "harness", "features", "feature-list.json");
}

function mkTask(id: string, status: TaskStatus, extra: Record<string, unknown> = {}): Task {
  return { id, description: id.toUpperCase(), status, dependsOn: [], subtasks: [], ...extra };
}

function listOf(features: FeatureList["features"], extra: Record<string, unknown> = {}): FeatureList {
  return { version: "2.0", baseRevision: 0, goals: [], sprints: [], features, ...extra };
}

function assertValidation(fn: () => unknown, match: RegExp): void {
  try {
    fn();
  } catch (e) {
    const err = e as Error;
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${err?.name}`);
    assert.match(err.message, match);
    return;
  }
  assert.fail(`expected ValidationError matching ${match}`);
}

// ── normalizeStatus ────────────────────────────────────────────────────────
{
  for (const alias of ["complete", "completed", "done", "closed", "passed", "DONE", "  Done  "]) {
    assert.equal(normalizeStatus(alias), "complete", `${JSON.stringify(alias)} → complete`);
  }
  for (const alias of ["in_progress", "in-progress", "inprogress", "active", "IN-PROGRESS"]) {
    assert.equal(normalizeStatus(alias), "in_progress", `${JSON.stringify(alias)} → in_progress`);
  }
  for (const alias of ["pending", "todo", "TODO"]) {
    assert.equal(normalizeStatus(alias), "pending");
  }
  assert.equal(normalizeStatus("blocked"), "blocked");
  assert.equal(normalizeStatus("rework"), "rework");

  // Junk is rejected loudly: silently coercing an unknown status is how a plan
  // starts lying about itself.
  for (const junk of ["", "  ", "nearly-done", "cancelled", null, undefined, 42, {}]) {
    assertValidation(() => normalizeStatus(junk), /unknown status/);
  }

  // Subtasks have a narrower vocabulary; the two extra states collapse.
  assert.equal(normalizeSubtaskStatus("complete"), "complete");
  assert.equal(normalizeSubtaskStatus("done"), "complete");
  assert.equal(normalizeSubtaskStatus("pending"), "pending");
  assert.equal(normalizeSubtaskStatus(undefined), "pending", "an absent subtask status defaults to pending");
  assert.equal(normalizeSubtaskStatus("blocked"), "in_progress", "subtasks cannot be blocked");
  assert.equal(normalizeSubtaskStatus("rework"), "in_progress", "subtasks cannot be in rework");
  assertValidation(() => normalizeSubtaskStatus("nonsense"), /unknown status/);

  assert.equal(isDone("complete"), true);
  for (const s of ["pending", "in_progress", "blocked", "rework"] as TaskStatus[]) {
    assert.equal(isDone(s), false, `${s} is not done`);
  }
  console.log("✓ normalizeStatus aliases and junk rejection");
}

// ── validateKey ────────────────────────────────────────────────────────────
{
  assert.equal(validateKey("task-1", "k"), "task-1");
  assert.equal(validateKey("  task_1.a  ", "k"), "task_1.a", "keys are trimmed");
  assert.equal(validateKey("feature-001/task-1", "k"), "feature-001/task-1");
  assert.equal(validateKey(" feature-001 / task-1 ", "k"), "feature-001/task-1", "segments are trimmed");
  assertValidation(() => validateKey("", "k"), /non-empty/);
  assertValidation(() => validateKey("a/b/c", "k"), /composite key must be/);
  assertValidation(() => validateKey("has space", "k"), /must be 1-64 chars/);
  assertValidation(() => validateKey("-leading", "k"), /must be 1-64 chars/);
  assertValidation(() => validateKey("a".repeat(65), "k"), /must be 1-64 chars/);
  console.log("✓ validateKey");
}

// ── flattenTasks ───────────────────────────────────────────────────────────
{
  const list = listOf([
    {
      id: "feature-001",
      name: "First",
      tasks: [mkTask("task-1", "complete"), mkTask("task-2", "pending", { key: "explicit-key" })],
    },
    { id: "feature-002", name: "Second", tasks: [mkTask("task-3", "pending")] },
    { id: "feature-003", name: "Empty", tasks: [] },
  ]);

  const flat = flattenTasks(list);
  assert.equal(flat.length, 3, "every task across every feature, in plan order");
  assert.deepEqual(
    flat.map((t) => t.compositeKey),
    ["feature-001/task-1", "explicit-key", "feature-002/task-3"],
    "compositeKey is the explicit key when set, else featureId/taskId",
  );
  assert.deepEqual(flat.map((t) => t.index), [1, 2, 3], "index is 1-based and runs across features");
  assert.deepEqual(flat.map((t) => t.featureId), ["feature-001", "feature-001", "feature-002"]);
  assert.deepEqual(flat.map((t) => t.featureName), ["First", "First", "Second"]);
  assert.equal(flat[0]!.description, "TASK-1", "the underlying task fields come along");

  assert.deepEqual(flattenTasks(emptyFeatureList()), []);
  assert.deepEqual(flattenTasks({ version: "2.0", baseRevision: 0, features: [] }), []);

  // Lookup by any of the three names a task answers to.
  assert.equal(findTask(list, "task-1")?.task.id, "task-1");
  assert.equal(findTask(list, "feature-001/task-1")?.task.id, "task-1");
  assert.equal(findTask(list, "explicit-key")?.task.id, "task-2");
  assert.equal(findTask(list, "task-1")?.feature.id, "feature-001");
  assert.equal(findTask(list, "nope"), null);
  assert.equal(findTask(list, ""), null);
  assert.equal(findFeature(list, "feature-002")?.name, "Second");
  assert.equal(findFeature(list, "nope"), null);
  console.log("✓ flattenTasks composite keys and 1-based index");
}

// ── computeProgress ────────────────────────────────────────────────────────
{
  const list = listOf([
    {
      id: "feature-001",
      name: "Done feature",
      tasks: [mkTask("a", "complete"), mkTask("b", "complete")],
    },
    {
      id: "feature-002",
      name: "Mixed feature",
      tasks: [
        mkTask("c", "complete"),
        mkTask("d", "in_progress"),
        mkTask("e", "blocked"),
        mkTask("f", "rework"),
        mkTask("g", "pending"),
      ],
    },
    { id: "feature-003", name: "Unplanned", tasks: [] },
  ]);

  assert.deepEqual(computeProgress(list), {
    tasksDone: 3,
    tasksTotal: 7,
    featuresDone: 1,
    featuresTotal: 3,
    blocked: 1,
    inProgress: 1,
    rework: 1,
    percent: 43,
  });

  const empty = computeProgress(emptyFeatureList());
  assert.deepEqual(empty, {
    tasksDone: 0,
    tasksTotal: 0,
    featuresDone: 0,
    featuresTotal: 0,
    blocked: 0,
    inProgress: 0,
    rework: 0,
    percent: 0,
  });

  // A feature with no tasks is not "done" — it is unplanned, and counting it as
  // complete would let an empty plan report 100%.
  const unplanned = listOf([{ id: "f", name: "F", tasks: [] }]);
  assert.equal(computeProgress(unplanned).featuresDone, 0);
  assert.equal(computeProgress(unplanned).percent, 0);

  const all = listOf([{ id: "f", name: "F", tasks: [mkTask("a", "complete")] }]);
  assert.equal(computeProgress(all).percent, 100);
  assert.equal(computeProgress(all).featuresDone, 1);
  console.log("✓ computeProgress counts, including blocked/rework/percent");
}

// ── nextActionableTask ─────────────────────────────────────────────────────
{
  // in_progress wins over everything, even an earlier rework row.
  const inProgress = listOf([
    {
      id: "f",
      name: "F",
      tasks: [mkTask("a", "rework"), mkTask("b", "in_progress"), mkTask("c", "pending")],
    },
  ]);
  assert.equal(nextActionableTask(inProgress)?.id, "b", "finish what is already started");

  // Then rework — a bounced task is more urgent than new work.
  const rework = listOf([
    { id: "f", name: "F", tasks: [mkTask("a", "pending"), mkTask("b", "rework"), mkTask("c", "pending")] },
  ]);
  assert.equal(nextActionableTask(rework)?.id, "b", "rework outranks fresh pending work");

  // Then the first pending task whose dependencies are all complete.
  const deps = listOf([
    {
      id: "f",
      name: "F",
      tasks: [
        mkTask("a", "complete"),
        mkTask("b", "pending", { dependsOn: ["c"] }),
        mkTask("c", "pending", { dependsOn: ["a"] }),
        mkTask("d", "pending"),
      ],
    },
  ]);
  assert.equal(nextActionableTask(deps)?.id, "c", "b is blocked on c, so c goes first");

  // Dependencies resolve through any of the names a task answers to.
  const byComposite = listOf([
    {
      id: "feature-001",
      name: "F",
      tasks: [mkTask("a", "complete"), mkTask("b", "pending", { dependsOn: ["feature-001/a"] })],
    },
  ]);
  assert.equal(nextActionableTask(byComposite)?.id, "b", "a composite dependency reference resolves");

  // Everything left is dependency-blocked → nothing is actionable.
  const stuck = listOf([
    {
      id: "f",
      name: "F",
      tasks: [mkTask("a", "blocked"), mkTask("b", "pending", { dependsOn: ["a"] })],
    },
  ]);
  assert.equal(nextActionableTask(stuck), null, "a pending task behind a blocked one is not actionable");

  // A dependency on a task that does not exist is unmet, not ignored.
  const dangling = listOf([{ id: "f", name: "F", tasks: [mkTask("a", "pending", { dependsOn: ["ghost"] })] }]);
  assert.equal(nextActionableTask(dangling), null, "an unresolvable dependency blocks the task");

  // Everything done → nothing to do.
  const done = listOf([{ id: "f", name: "F", tasks: [mkTask("a", "complete")] }]);
  assert.equal(nextActionableTask(done), null);
  assert.equal(nextActionableTask(emptyFeatureList()), null);
  console.log("✓ nextActionableTask priority and dependency blocking");
}

// ── detectCycle ────────────────────────────────────────────────────────────
{
  // A DAG passes, including a diamond and a disconnected component.
  assert.doesNotThrow(() =>
    detectCycle([
      { compositeKey: "a" },
      { compositeKey: "b", dependsOn: ["a"] },
      { compositeKey: "c", dependsOn: ["a"] },
      { compositeKey: "d", dependsOn: ["b", "c"] },
      { compositeKey: "island" },
    ]),
  );
  // References that are not tasks in the set are somebody else's problem.
  assert.doesNotThrow(() => detectCycle([{ compositeKey: "a", dependsOn: ["not-a-task"] }]));
  assert.doesNotThrow(() => detectCycle([]));

  const cycleOf = (tasks: Array<{ compositeKey: string; dependsOn?: string[] }>): string => {
    try {
      detectCycle(tasks);
    } catch (e) {
      assert.ok(e instanceof ValidationError);
      return (e as Error).message;
    }
    assert.fail("expected a cycle");
  };

  // The error names the path, not just the fact — a bare "cycle detected" is
  // useless when the plan has forty tasks.
  assert.equal(
    cycleOf([
      { compositeKey: "a", dependsOn: ["b"] },
      { compositeKey: "b", dependsOn: ["a"] },
    ]),
    "dependency cycle: a → b → a",
  );
  assert.equal(cycleOf([{ compositeKey: "a", dependsOn: ["a"] }]), "dependency cycle: a → a");
  assert.equal(
    cycleOf([
      { compositeKey: "a", dependsOn: ["c"] },
      { compositeKey: "b", dependsOn: ["a"] },
      { compositeKey: "c", dependsOn: ["b"] },
    ]),
    "dependency cycle: a → c → b → a",
  );
  // A cycle hidden behind an acyclic prefix is still found.
  assert.match(
    cycleOf([
      { compositeKey: "root" },
      { compositeKey: "a", dependsOn: ["root", "b"] },
      { compositeKey: "b", dependsOn: ["a"] },
    ]),
    /dependency cycle: a → b → a/,
  );
  console.log("✓ detectCycle reports the cycle path and passes a DAG");
}

// ── loadFeatureList: missing, empty, corrupt ───────────────────────────────
{
  const dir = tmpProject();
  try {
    const missing = loadFeatureList(dir);
    assert.equal(missing.existed, false, "no plan on disk yet");
    assert.equal(missing.path, planFile(dir));
    assert.deepEqual(missing.list, emptyFeatureList(), "callers get a usable empty plan");

    // A corrupt plan with no backup degrades to empty rather than throwing.
    writeFileSync(planFile(dir), "{ broken", "utf-8");
    let corrupt!: ReturnType<typeof loadFeatureList>;
    assert.doesNotThrow(() => {
      corrupt = loadFeatureList(dir);
    });
    assert.equal(corrupt.existed, true, "the file is there, it just cannot be read");
    assert.deepEqual(corrupt.list, emptyFeatureList());

    // With a backup beside it, the backup is preferred over losing the plan.
    writeFileSync(
      planFile(dir) + ".bak",
      JSON.stringify(listOf([{ id: "f", name: "F", tasks: [mkTask("a", "complete")] }], { baseRevision: 9 })),
      "utf-8",
    );
    const recovered = loadFeatureList(dir);
    assert.equal(recovered.existed, true);
    assert.equal(recovered.list.baseRevision, 9, "the prior good revision is recovered");
    assert.equal(recovered.list.features[0]!.tasks[0]!.id, "a");

    // The corrupt file is not overwritten by the read.
    assert.equal(existsSync(planFile(dir)), true);
    console.log("✓ loadFeatureList: missing, corrupt and backup recovery");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── loadFeatureList normalises what it reads ───────────────────────────────
{
  const dir = tmpProject();
  try {
    writeFileSync(
      planFile(dir),
      JSON.stringify({
        features: [
          {
            id: "f",
            name: "F",
            tasks: [
              { id: "a", description: "A", status: "done" },
              { id: "b", description: "B", status: "in-progress" },
              { id: "c", description: "C", status: "who-knows" },
            ],
          },
        ],
      }),
      "utf-8",
    );
    const { list } = loadFeatureList(dir);
    assert.equal(list.version, "2.0", "a missing version is filled in");
    assert.equal(list.baseRevision, 0, "a missing baseRevision starts at zero");
    assert.deepEqual(list.goals, []);
    assert.deepEqual(list.sprints, []);
    const tasks = list.features[0]!.tasks;
    assert.equal(tasks[0]!.status, "complete", "legacy aliases are canonicalised on read");
    assert.equal(tasks[1]!.status, "in_progress");
    assert.equal(tasks[2]!.status, "pending", "an unreadable status degrades to pending, it does not throw");
    assert.deepEqual(tasks[0]!.dependsOn, [], "missing collections are filled in");
    assert.deepEqual(tasks[0]!.subtasks, []);
    console.log("✓ loadFeatureList normalises statuses and collections");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── save → load round-trip preserves fields nobody here understands ────────
{
  const dir = tmpProject();
  try {
    const original = listOf(
      [
        {
          id: "feature-001",
          name: "Feature one",
          description: "a feature",
          passes: false,
          sprintId: "sprint-001",
          goalId: "goal-001",
          criteria: ["it works"],
          futureFeatureField: { shape: "unknown" },
          tasks: [
            mkTask("task-1", "complete", {
              key: "explicit-key",
              difficulty: "difficult",
              modelHint: "big-model",
              criteria: ["passes the gate"],
              subtasks: [{ id: "st-1", title: "sub one", status: "complete" }],
              // Fields a later version of the harness might add.
              owner: "alice",
              estimateHours: 3.5,
              tags: ["infra", "risky"],
              nested: { deep: { value: true } },
              nullish: null,
            }),
            mkTask("task-2", "rework", { dependsOn: ["explicit-key"] }),
          ],
        },
      ],
      {
        baseRevision: 12,
        goals: [{ id: "goal-001", title: "Ship it", description: "d" }],
        sprints: [{ id: "sprint-001", name: "S1", goalId: "goal-001" }],
        futureTopLevelField: ["a", "b"],
      },
    );

    saveFeatureList(dir, original);
    const { list, existed } = loadFeatureList(dir);
    assert.equal(existed, true);
    assert.deepEqual(list, original, "a round-trip through disk changes nothing at all");

    const t = list.features[0]!.tasks[0]! as Record<string, unknown>;
    assert.equal(t.owner, "alice", "an unknown string field survives");
    assert.equal(t.estimateHours, 3.5, "an unknown numeric field survives");
    assert.deepEqual(t.tags, ["infra", "risky"], "an unknown array field survives");
    assert.deepEqual(t.nested, { deep: { value: true } }, "an unknown nested object survives");
    assert.equal(t.nullish, null, "an explicit null survives");
    assert.equal(t.difficulty, "difficult");
    assert.equal(t.modelHint, "big-model");
    assert.deepEqual(list.features[0]!.futureFeatureField, { shape: "unknown" });
    assert.deepEqual(list.futureTopLevelField, ["a", "b"]);
    assert.equal(list.baseRevision, 12, "the revision is not disturbed by a save");

    // The second save keeps the prior revision beside the file.
    saveFeatureList(dir, { ...list, baseRevision: 13 });
    assert.equal(existsSync(planFile(dir) + ".bak"), true);
    assert.equal(loadFeatureList(dir).list.baseRevision, 13);
    console.log("✓ saveFeatureList → loadFeatureList preserves unknown fields");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("All featureList tests PASS");
