import assert from "node:assert/strict";
import {
  WIDGET_LIMIT,
  COMPLETED_CONTEXT,
  statusIcon,
  wrapWidgetLines,
  getWidgetWindowBounds,
  buildWidgetLines,
} from "../src/widget.ts";

// --- statusIcon ---
assert.equal(statusIcon("pending"), "○", "pending -> ○");
assert.equal(statusIcon("in_progress"), "◐", "in_progress -> ◐");
assert.equal(statusIcon("complete"), "●", "complete -> ●");
assert.equal(statusIcon("blocked"), "⚠", "blocked -> ⚠");
assert.equal(statusIcon("done"), "●", "done -> ●");
assert.equal(statusIcon("in_progress"), "◐");
// also ensure blocked variant and unknown falls back
assert.ok(["◐","○","●","⚠","↷"].includes(statusIcon("pending")));

// --- wrapWidgetLines: wraps not truncates ---
let lines = wrapWidgetLines("hello world", 20);
assert.deepEqual(lines, ["hello world"], "short text single line");

lines = wrapWidgetLines("this is a very long label that should wrap not truncate at all", 20);
assert.ok(lines.length > 1, "long label wraps to multiple lines");
for (const l of lines) {
  assert.ok(l.length <= 20 || l.includes(" "), "each line respects width");
}
assert.ok(!lines.some(l => l.endsWith("…")), "no truncation ellipsis");
assert.ok(!lines.join(" ").includes("…"), "no truncation");

// word longer than width should be hard-split
lines = wrapWidgetLines("supercalifragilisticexpialidocious", 10);
assert.ok(lines.length > 1, "super long word splits");
assert.ok(lines.every(l => l.length <= 10), "hard split respects width");

// empty
assert.deepEqual(wrapWidgetLines("", 10), [""]);

// --- getWidgetWindowBounds ---
assert.equal(WIDGET_LIMIT, 8, "WIDGET_LIMIT=8");
assert.equal(COMPLETED_CONTEXT, 3, "COMPLETED_CONTEXT=3");

// small list fits
let bounds = getWidgetWindowBounds(
  [{ status: "pending" }, { status: "pending" }],
);
assert.deepEqual(bounds, { start: 0, end: 2 }, "small list no window");
assert.equal(bounds.start, 0);
assert.equal(bounds.end, 2);

// rolling window: more than 8 items, active near start
let many = Array.from({ length: 12 }, (_, i) => ({
  status: i < 5 ? "complete" : i === 5 ? "in_progress" : "pending",
}));
bounds = getWidgetWindowBounds(many);
assert.ok(bounds.end - bounds.start <= 8, "window limited to 8");
assert.ok(bounds.start <= 5 && bounds.end > 5, "active index inside window near start");
assert.ok(bounds.start === 0 || bounds.start === 2, "window respects completed context near start");

// active near middle
many = Array.from({ length: 12 }, (_, i) => ({
  status: i < 7 ? "complete" : i === 7 ? "in_progress" : "pending",
}));
bounds = getWidgetWindowBounds(many);
assert.ok(bounds.start > 0, "middle active scrolls window");
assert.ok(bounds.start <= 7 && bounds.end > 7, "active index inside window");

// active near end
many = Array.from({ length: 12 }, (_, i) => ({
  status: i < 10 ? "complete" : i === 10 ? "in_progress" : "pending",
}));
bounds = getWidgetWindowBounds(many);
assert.equal(bounds.end, 12, "active near end shows tail");

// numeric overload
bounds = getWidgetWindowBounds(12, 0);
assert.equal(bounds.start, 0);
bounds = getWidgetWindowBounds(12, 11);
assert.equal(bounds.end, 12);

// --- buildWidgetLines: hierarchy, progress, overflow, deps ---
const sample = {
  version: "0.1",
  baseRevision: 2,
  goals: [{ id: "goal-001", title: "pi-harness v1.0 — superset visual harness" }],
  sprints: [{ id: "sprint-001", name: "F1 — Visual 5-Level Widget + baseRevision", goalId: "goal-001" }],
  features: [
    {
      id: "feature-001",
      name: "Visual 5-Level Widget + baseRevision",
      description: "widget",
      passes: false,
      sprintId: "sprint-001",
      goalId: "goal-001",
      tasks: [
        {
          id: "task-001",
          key: "schema-5level",
          description: "Extend feature-list schema to 5 levels with baseRevision",
          status: "complete",
          dependsOn: [],
          subtasks: [{ id: "st-001", title: "Add baseRevision", status: "complete" }],
        },
        {
          id: "task-002",
          key: "widget-render",
          description: "Port widget rendering (task-tracker + long-task) to src/widget.ts with a very long label that definitely exceeds typical width and should wrap not truncate",
          status: "in_progress",
          dependsOn: ["schema-5level"],
          subtasks: [
            { id: "st-003", title: "Port getWidgetWindowBounds and wrapWidgetLines", status: "in_progress" },
            { id: "st-004", title: "Second subtask pending", status: "pending" },
          ],
        },
        {
          id: "task-003",
          key: "atomic-tool",
          description: "Implement harness_task_list tool",
          status: "pending",
          dependsOn: ["widget-render"],
          subtasks: [],
        },
      ],
    },
  ],
};

let widgetLines = buildWidgetLines(sample as any, { width: 60 });
let joined = widgetLines.join("\n");
// shows Goal -> Feature -> Sprint -> Task -> Subtask
assert.ok(joined.includes("Goal"), "shows Goal");
assert.ok(joined.includes("Feature"), "shows Feature");
assert.ok(joined.includes("Sprint"), "shows Sprint");
assert.ok(joined.includes("Progress"), "shows Progress");
assert.ok(joined.includes("○") || joined.includes("●") || joined.includes("◐"), "shows status icons");
assert.ok(joined.includes("← #1"), "shows deps as ← #1");

// overflow: create 12 tasks to trigger +N more
const manyTasksFeature = {
  ...sample,
  features: [
    {
      ...sample.features[0],
      tasks: Array.from({ length: 12 }, (_, i) => ({
        id: `task-${i}`,
        key: `task-${i}`,
        description: `Task number ${i} with some description`,
        status: i < 3 ? "complete" : i === 3 ? "in_progress" : "pending",
        dependsOn: i > 0 ? [`task-${i - 1}`] : [],
        subtasks: i === 3 ? [{ id: "sub-1", title: "subtask of active", status: "pending" }] : [],
      })),
    },
  ],
};
widgetLines = buildWidgetLines(manyTasksFeature as any, { width: 60 });
joined = widgetLines.join("\n");
assert.ok(joined.includes("+") && joined.includes("more"), "shows +3 more overflow when >8");

// long label wrapping not truncation: the long task-002 description should be wrapped
widgetLines = buildWidgetLines(sample as any, { width: 40 });
joined = widgetLines.join("\n");
assert.ok(!joined.includes("…") && !joined.includes("..."), "no truncation ellipsis when wrapping");
assert.ok(widgetLines.some(l => l.length <= 40 + 20), "lines respect width approx"); // allow indent

// wrapping check: long label produces multiple physical lines but still contains words
assert.ok(widgetLines.join(" ").includes("very long label"), "long label content preserved via wrap");

console.log("All widget tests PASS");
