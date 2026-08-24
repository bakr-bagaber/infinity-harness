/**
 * The plan has five levels. All five must reach the screen.
 *
 * Goal → sprint → feature → task → subtask. Only two of them used to: the
 * widget drew features and tasks, goals were one title line, and sprints
 * appeared nowhere at all — so a plan organised into sprints looked, on
 * screen, exactly like a plan that was not.
 *
 * The rule that matters most here is that nothing is ever *dropped*. A feature
 * pointing at a goal that has since been deleted is still a feature with real
 * tasks in it, and a task nobody can see is a task that gets stuck forever.
 */

import assert from "node:assert/strict";

import { buildPlanRows, focusRowIndex, groupPlan } from "../src/ui/planTree.ts";
import type { FeatureList } from "../src/core/types.ts";

const FULL: FeatureList = {
  version: "2.0",
  baseRevision: 9,
  goals: [
    { id: "goal-001", title: "Reconcile payouts" },
    { id: "goal-002", title: "Then make it fast" },
  ],
  sprints: [
    { id: "sprint-001", name: "Foundations", goalId: "goal-001" },
    { id: "sprint-002", name: "Reporting", goalId: "goal-001" },
  ],
  features: [
    {
      id: "feature-001",
      name: "Ledger import",
      sprintId: "sprint-001",
      goalId: "goal-001",
      tasks: [
        { id: "task-001", description: "Parse the CSV", status: "complete", subtasks: [] },
        {
          id: "task-002",
          description: "Reject bad rows",
          status: "in_progress",
          dependsOn: ["feature-001/task-001"],
          subtasks: [
            { id: "s1", title: "define the tolerance", status: "complete" },
            { id: "s2", title: "write the failing test", status: "in_progress" },
          ],
        },
      ],
    },
    {
      id: "feature-002",
      name: "Audit report",
      sprintId: "sprint-002",
      goalId: "goal-001",
      tasks: [{ id: "task-003", description: "CSV export", status: "pending", subtasks: [] }],
    },
    // Under a goal, but in no sprint.
    {
      id: "feature-003",
      name: "Caching",
      goalId: "goal-002",
      tasks: [{ id: "task-004", description: "Memoise the FX table", status: "pending", subtasks: [] }],
    },
  ],
};

const titles = (list: FeatureList, active: string | null = null, options = {}) =>
  buildPlanRows(list, active, options).map((r) => r.title);

// ── grouping ───────────────────────────────────────────────────────────────
{
  const groups = groupPlan(FULL);
  assert.equal(groups.length, 2, "one group per goal");
  assert.equal(groups[0]?.goal?.id, "goal-001");
  assert.equal(groups[0]?.sprints.length, 2);
  assert.equal(groups[0]?.total, 3, "a goal counts every task beneath it");
  assert.equal(groups[0]?.done, 1);

  const second = groups[1]!;
  assert.equal(second.goal?.id, "goal-002");
  assert.equal(second.sprints.length, 1, "a feature with no sprint sits in a nameless sprint group");
  assert.equal(second.sprints[0]?.sprint, null);
  assert.equal(second.sprints[0]?.features[0]?.id, "feature-003");
  console.log("✓ groupPlan reproduces the plan's real shape, with counts at every level");
}

// ── nothing is dropped ─────────────────────────────────────────────────────
{
  const orphaned: FeatureList = {
    version: "2.0",
    baseRevision: 1,
    goals: [{ id: "goal-001", title: "Kept" }],
    sprints: [{ id: "sprint-001", name: "Ghost sprint", goalId: "goal-deleted" }],
    features: [
      { id: "f-a", name: "Under a deleted goal", goalId: "goal-gone", tasks: [{ id: "t1", description: "a", status: "pending", subtasks: [] }] },
      { id: "f-b", name: "Under a deleted sprint", sprintId: "sprint-gone", tasks: [{ id: "t2", description: "b", status: "pending", subtasks: [] }] },
      { id: "f-c", name: "Under nothing at all", tasks: [{ id: "t3", description: "c", status: "pending", subtasks: [] }] },
      { id: "f-d", name: "Under a ghost sprint", sprintId: "sprint-001", tasks: [{ id: "t4", description: "d", status: "pending", subtasks: [] }] },
    ],
  };

  const shown = titles(orphaned, null, { collapseTrivial: false });
  for (const name of [
    "Under a deleted goal",
    "Under a deleted sprint",
    "Under nothing at all",
    "Under a ghost sprint",
  ]) {
    assert.ok(shown.includes(name), `${name} vanished — a task nobody can see is a task that gets stuck`);
  }

  const everyTask = buildPlanRows(orphaned, null).filter((r) => r.level === "task");
  assert.equal(everyTask.length, 4, "every task reaches the screen exactly once");
  assert.deepEqual(
    everyTask.map((t) => t.index),
    [1, 2, 3, 4],
    "and they are numbered contiguously, so `← #3` means something",
  );
  console.log("✓ orphans and dangling parents are still drawn, exactly once each");
}

// ── the five levels ────────────────────────────────────────────────────────
{
  const rows = buildPlanRows(FULL, "feature-001/task-002", { expandSubtasks: true });
  const levels = new Set(rows.map((r) => r.level));
  for (const level of ["goal", "sprint", "feature", "task", "subtask"] as const) {
    assert.ok(levels.has(level), `${level} rows are missing`);
  }

  // Depth is what makes the shape readable without reading the ids.
  const goal = rows.find((r) => r.level === "goal")!;
  const sprint = rows.find((r) => r.level === "sprint")!;
  const feature = rows.find((r) => r.level === "feature")!;
  const task = rows.find((r) => r.id === "feature-001/task-002")!;
  const subtask = rows.find((r) => r.level === "subtask")!;
  assert.ok(goal.depth < sprint.depth);
  assert.ok(sprint.depth < feature.depth);
  assert.ok(feature.depth < task.depth);
  assert.ok(task.depth < subtask.depth);

  assert.equal(task.active, true, "the active task is marked so the surface can highlight it");
  assert.deepEqual(task.dependsOn, ["feature-001/task-001"]);
  assert.equal(subtask.parentId, "feature-001/task-002");
  console.log("✓ all five levels are emitted, nested, with the active task marked");
}

// ── grouping levels that say nothing are skipped ───────────────────────────
{
  const single: FeatureList = {
    version: "2.0",
    baseRevision: 1,
    goals: [{ id: "goal-001", title: "The only goal" }],
    sprints: [],
    features: [{ id: "f1", name: "F", tasks: [{ id: "t1", description: "a", status: "pending", subtasks: [] }] }],
  };
  // One goal is the run's headline; the surface draws it above the tree, so a
  // row repeating it is a wasted line out of nine.
  assert.ok(!titles(single).includes("The only goal"), "a lone goal is collapsed by default");
  assert.ok(titles(single, null, { collapseTrivial: false }).includes("The only goal"));

  const noSprints = buildPlanRows(FULL, null);
  assert.ok(
    noSprints.some((r) => r.level === "sprint"),
    "two goals and real sprints are structure, and structure is drawn",
  );

  const flat: FeatureList = {
    version: "2.0",
    baseRevision: 1,
    goals: [],
    sprints: [],
    features: [{ id: "f1", name: "F", tasks: [{ id: "t1", description: "a", status: "pending", subtasks: [] }] }],
  };
  assert.deepEqual(
    buildPlanRows(flat, null).map((r) => `${r.level}:${r.depth}`),
    ["feature:0", "task:1"],
    "a plan using two levels is not indented as though it used five",
  );
  console.log("✓ a grouping level with nothing to say costs no rows");
}

// ── subtasks appear where they are actionable ──────────────────────────────
{
  const idle = buildPlanRows(FULL, null);
  assert.ok(
    idle.some((r) => r.level === "subtask"),
    "the in-progress task's subtasks show even with no explicit active task",
  );

  const collapsed = buildPlanRows(
    { ...FULL, features: FULL.features.map((f) => ({ ...f, tasks: (f.tasks ?? []).map((t) => ({ ...t, status: "pending" as const })) })) },
    null,
  );
  assert.equal(
    collapsed.filter((r) => r.level === "subtask").length,
    0,
    "with nothing in progress, subtasks are detail nobody is acting on",
  );
  assert.ok(
    buildPlanRows(collapsed.length ? FULL : FULL, null, { expandSubtasks: true }).filter((r) => r.level === "subtask")
      .length > 0,
    "expanding shows them all",
  );
  console.log("✓ subtasks follow the work, and expand on request");
}

// ── where the window should sit ────────────────────────────────────────────
{
  const rows = buildPlanRows(FULL, "feature-001/task-002");
  const focus = focusRowIndex(rows);
  assert.equal(rows[focus]?.id, "feature-001/task-002", "the window follows the active task");

  const allDone: FeatureList = {
    version: "2.0",
    baseRevision: 1,
    goals: [],
    sprints: [],
    features: [{ id: "f1", name: "F", tasks: [{ id: "t1", description: "a", status: "complete", subtasks: [] }] }],
  };
  assert.equal(focusRowIndex(buildPlanRows(allDone, null)), buildPlanRows(allDone, null).length - 1);

  assert.equal(focusRowIndex([]), 0, "an empty plan does not produce a negative index");
  console.log("✓ the focus row is the work, or the tail when there is none");
}

// ── junk in, no throw out ──────────────────────────────────────────────────
{
  const junk = {
    version: "2.0",
    baseRevision: 0,
  } as unknown as FeatureList;
  assert.doesNotThrow(() => buildPlanRows(junk, null));
  assert.deepEqual(buildPlanRows(junk, null), []);
  assert.deepEqual(groupPlan(junk), []);
  console.log("✓ a plan missing every array renders as nothing rather than throwing");
}
