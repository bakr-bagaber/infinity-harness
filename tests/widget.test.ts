import assert from "node:assert/strict";
import {
  DEFAULT_WIDTH,
  TASK_WINDOW,
  COMPLETED_CONTEXT,
  statusGlyph,
  taskWindowBounds,
  progressBar,
  phaseRail,
  renderWidget,
  renderStatusLine,
  type WidgetState,
} from "../src/ui/widget.ts";
import {
  ASCII_GLYPHS,
  UNICODE_GLYPHS,
  createStyler,
  stripAnsi,
  width,
} from "../src/ui/theme.ts";
import type { FeatureList, TaskStatus } from "../src/core/types.ts";

const PLAIN = createStyler("none");
const G = UNICODE_GLYPHS;

function statuses(list: string[]): Array<{ status: string }> {
  return list.map((status) => ({ status }));
}

function sample(): FeatureList {
  return {
    version: "2.0",
    baseRevision: 4,
    goals: [{ id: "goal-001", title: "Ship the infinity harness" }],
    sprints: [{ id: "sprint-001", name: "S1", goalId: "goal-001" }],
    features: [
      {
        id: "feature-001",
        name: "Visual widget",
        passes: false,
        sprintId: "sprint-001",
        tasks: [
          {
            id: "task-001",
            key: "schema",
            description: "Extend the feature-list schema",
            status: "complete",
            dependsOn: [],
            subtasks: [{ id: "st-1", title: "add baseRevision", status: "complete" }],
          },
          {
            id: "task-002",
            key: "render",
            description:
              "Port widget rendering to src/ui/widget.ts with a deliberately long description that has to wrap rather than be cut off",
            status: "in_progress",
            dependsOn: ["schema"],
            subtasks: [
              { id: "st-2", title: "window bounds", status: "in_progress" },
              { id: "st-3", title: "dep labels", status: "pending" },
            ],
          },
          {
            id: "task-003",
            key: "atomic",
            description: "Implement the atomic task-list tool",
            status: "pending",
            dependsOn: ["render"],
            subtasks: [],
          },
        ],
      },
    ],
  };
}

function manyTasks(n: number, activeAt: number): FeatureList {
  return {
    version: "2.0",
    baseRevision: 1,
    goals: [],
    sprints: [],
    features: [
      {
        id: "feature-001",
        name: "Big feature",
        passes: false,
        tasks: Array.from({ length: n }, (_, i) => ({
          id: `task-${i}`,
          key: `task-${i}`,
          description: `Task number ${i}`,
          status: (i < activeAt ? "complete" : i === activeAt ? "in_progress" : "pending") as TaskStatus,
          dependsOn: i > 0 ? [`task-${i - 1}`] : [],
          subtasks: [],
        })),
      },
    ],
  };
}

// ── statusGlyph ────────────────────────────────────────────────────────────
{
  assert.equal(statusGlyph("pending", G), G.pending);
  assert.equal(statusGlyph("in_progress", G), G.inProgress);
  assert.equal(statusGlyph("complete", G), G.complete);
  assert.equal(statusGlyph("blocked", G), G.blocked);
  assert.equal(statusGlyph("rework", G), G.rework);
  // Legacy aliases the plan file may still carry.
  for (const alias of ["done", "closed", "passed"]) assert.equal(statusGlyph(alias, G), G.complete);
  for (const alias of ["in-progress", "active"]) assert.equal(statusGlyph(alias, G), G.inProgress);
  assert.equal(statusGlyph("waiting", G), G.rework);
  assert.equal(statusGlyph("who-knows", G), G.pending, "unknown status degrades to pending");
  // The ASCII set is a complete substitution, never a mix.
  assert.equal(statusGlyph("complete", ASCII_GLYPHS), ASCII_GLYPHS.complete);
  assert.equal(statusGlyph("blocked", ASCII_GLYPHS), "!");
  console.log("✓ statusGlyph mapping and aliases");
}

// ── taskWindowBounds ───────────────────────────────────────────────────────
{
  assert.equal(TASK_WINDOW, 9);
  assert.equal(COMPLETED_CONTEXT, 3);

  // Everything fits: no window at all.
  assert.deepEqual(taskWindowBounds(statuses(["pending", "pending"])), { start: 0, end: 2 });
  assert.deepEqual(taskWindowBounds(statuses(new Array(TASK_WINDOW).fill("pending"))), {
    start: 0,
    end: TASK_WINDOW,
  });

  // Active near the start: the window stays anchored at the top.
  const nearStart = taskWindowBounds(
    statuses([...new Array(2).fill("complete"), "in_progress", ...new Array(17).fill("pending")]),
  );
  assert.deepEqual(nearStart, { start: 0, end: 9 });

  // Active in the middle: the window scrolls but keeps COMPLETED_CONTEXT rows above.
  const middle = taskWindowBounds(
    statuses([...new Array(10).fill("complete"), "in_progress", ...new Array(9).fill("pending")]),
  );
  assert.equal(middle.end - middle.start, 9, "window is exactly the limit");
  assert.equal(middle.start, 7, "three completed rows stay visible above the active task");
  assert.ok(middle.start <= 10 && middle.end > 10, "the active task is inside the window");

  // Active near the end: clamp to the tail rather than running past it.
  const nearEnd = taskWindowBounds(statuses([...new Array(19).fill("complete"), "in_progress"]));
  assert.deepEqual(nearEnd, { start: 11, end: 20 });

  // Everything done: show the tail.
  const allDone = taskWindowBounds(statuses(new Array(20).fill("complete")));
  assert.deepEqual(allDone, { start: 11, end: 20 });

  // The fallback chain: rework, then blocked, then pending.
  const rework = taskWindowBounds(
    statuses([...new Array(10).fill("complete"), "rework", ...new Array(9).fill("pending")]),
  );
  assert.equal(rework.start, 7, "rework counts as the active row when nothing is in progress");
  const blocked = taskWindowBounds(
    statuses([...new Array(10).fill("complete"), "blocked", ...new Array(9).fill("pending")]),
  );
  assert.equal(blocked.start, 7, "blocked counts as the active row when nothing is in progress or rework");

  // A custom limit/context is honoured.
  assert.deepEqual(taskWindowBounds(statuses(new Array(10).fill("pending")), 4, 1), { start: 0, end: 4 });
  console.log("✓ taskWindowBounds windowing");
}

// ── progressBar ────────────────────────────────────────────────────────────
{
  const half = progressBar(50, 10, G, PLAIN);
  assert.equal(half, `${G.barFull.repeat(5)}${G.barEmpty.repeat(5)}  50%`);
  assert.equal(width(half), 10 + 1 + 4, "the meter is fixed-width so the line never reflows");
  assert.equal(progressBar(0, 10, G, PLAIN), `${G.barEmpty.repeat(10)}   0%`);
  assert.equal(progressBar(100, 10, G, PLAIN), `${G.barFull.repeat(10)} 100%`);
  // Nonsense percentages are clamped rather than drawn.
  assert.equal(progressBar(-20, 10, G, PLAIN), progressBar(0, 10, G, PLAIN));
  assert.equal(progressBar(1000, 10, G, PLAIN), progressBar(100, 10, G, PLAIN));
  for (const cells of [8, 16, 24]) {
    assert.equal(width(progressBar(37, cells, G, PLAIN)), cells + 5);
  }
  console.log("✓ progressBar is fixed-width and clamped");
}

// ── phaseRail ──────────────────────────────────────────────────────────────
{
  const full = phaseRail("build", null, 100, G, PLAIN);
  assert.match(full, /BUILD/, "the current phase is shouted");
  assert.match(full, new RegExp(`${G.phaseCurrent} BUILD`));
  assert.match(full, new RegExp(`${G.phaseDone} define`), "earlier phases are marked done");
  assert.match(full, new RegExp(`${G.phaseTodo} ship`), "later phases are marked todo");
  assert.ok(!full.includes(G.more), "no elision when the rail fits");
  assert.ok(width(full) <= 100);

  // Narrow: the current phase survives, the rest elides.
  const narrow = phaseRail("build", null, 28, G, PLAIN);
  assert.ok(width(narrow) <= 28, `narrow rail is ${width(narrow)} columns`);
  assert.match(narrow, /BUILD/, "the current phase is never the thing that gets dropped");
  assert.ok(narrow.includes(G.more), "elision is signalled");

  // A disabled phase never appears on the rail.
  const short = phaseRail("build", ["define", "build", "ship"], 100, G, PLAIN);
  assert.ok(!short.includes("verify"), "disabled phases are not drawn");
  assert.match(short, /define/);
  assert.match(short, /ship/);

  // No current phase: everything is todo, nothing is highlighted.
  const none = phaseRail(null, null, 100, G, PLAIN);
  assert.ok(!none.includes(G.phaseCurrent));
  assert.ok(!none.includes(G.phaseDone));
  console.log("✓ phaseRail marks position and degrades when narrow");
}

// ── renderWidget: the whole panel ──────────────────────────────────────────
{
  const state: WidgetState = {
    list: sample(),
    phase: "build",
    enabledPhases: null,
    revision: 4,
    retries: { task: 2, max: 10 },
  };
  const lines = renderWidget(state, { width: 76, styler: PLAIN, glyphs: G });
  const joined = lines.join("\n");

  assert.match(joined, /∞ INFINITY/, "brand");
  assert.match(joined, /BUILD/, "current phase");
  assert.match(joined, /rev 4/, "plan revision");
  assert.match(joined, /Ship the infinity harness/, "goal");
  assert.match(joined, /feature-001/, "feature id");
  assert.match(joined, /Visual widget/, "feature name");
  assert.match(joined, /1\/3 tasks/, "task progress");
  assert.match(joined, /0\/1 features/, "feature progress");
  assert.match(joined, /33%/, "percent complete");
  assert.match(joined, /retry 2\/10/, "retry budget is surfaced");
  assert.match(joined, new RegExp(`${G.arrow} #1`), "dependencies render as ← #index");
  assert.match(joined, /Implement the atomic task-list tool/, "pending tasks are listed");

  // Subtasks belong to the task being worked, and nowhere else.
  assert.match(joined, /window bounds/, "the active task shows its subtasks");
  assert.match(joined, /dep labels/);
  assert.ok(!joined.includes("add baseRevision"), "a completed task does not show subtasks");

  // The long description wraps onto a continuation row; it is never cut off.
  assert.match(joined, /a deliberately +← #1\n/, "the row breaks at a word boundary");
  assert.match(joined, /long description that has to wrap rather than be cut off/, "the tail survives");
  assert.ok(!joined.includes("…"), "wrapping, not truncation");

  for (const l of lines) {
    assert.ok(width(l) <= 76, `line exceeds the widget width (${width(l)}): ${JSON.stringify(l)}`);
  }
  console.log("✓ renderWidget content and width discipline");
}

// ── renderWidget: alerts, paused, empty ────────────────────────────────────
{
  const list = sample();
  list.features[0]!.tasks[2]!.status = "blocked";
  const alerted = renderWidget(
    { list, phase: "build", gate: { overall: false, failures: ["tests", "lint"] } },
    { width: 76, styler: PLAIN, glyphs: G },
  ).join("\n");
  assert.match(alerted, /1 blocked/);
  assert.match(alerted, /gate: tests, lint/);

  const paused = renderWidget(
    { list: sample(), phase: "build", paused: true },
    { width: 76, styler: PLAIN, glyphs: G },
  );
  assert.match(paused[0]!, /PAUSED/, "the header tag reads PAUSED");
  assert.ok(!paused[0]!.includes("BUILD"), "PAUSED replaces the phase tag in the header");
  assert.match(paused.join("\n"), new RegExp(`${G.phaseCurrent} BUILD`), "the rail still shows where the run is parked");

  const empty = renderWidget(
    { list: { version: "2.0", baseRevision: 0, features: [] }, phase: null },
    { width: 76, styler: PLAIN, glyphs: G },
  ).join("\n");
  assert.match(empty, /no tasks planned yet/);
  assert.match(empty, /NOT STARTED/);
  console.log("✓ renderWidget alerts, paused and empty states");
}

// ── renderWidget: overflow markers ─────────────────────────────────────────
{
  const lines = renderWidget(
    { list: manyTasks(20, 12), phase: "build" },
    { width: 76, styler: PLAIN, glyphs: G },
  );
  const joined = lines.join("\n");
  assert.match(joined, /earlier/, "hidden rows above the window are counted");
  assert.match(joined, /more/, "hidden rows below the window are counted");
  const shown = lines.filter((l) => /^ {2}[○◐●⚠↷] /.test(l));
  assert.equal(shown.length, TASK_WINDOW, "exactly one window of task rows is drawn");
  console.log("✓ renderWidget windows a long plan");
}

// ── renderWidget: boxed frame and colour parity ────────────────────────────
{
  const state: WidgetState = { list: sample(), phase: "build", revision: 4 };
  const boxed = renderWidget(state, { width: 60, styler: PLAIN, glyphs: G, boxed: true });
  for (const l of boxed) {
    assert.equal(width(l), 60, `boxed line is not exactly 60 columns: ${JSON.stringify(l)}`);
  }
  assert.ok(boxed[0]!.startsWith("╭") && boxed[0]!.endsWith("╮"));
  assert.ok(boxed[boxed.length - 1]!.startsWith("╰"));

  // Colour is decoration: stripping it must reproduce the plain layout exactly.
  const colored = renderWidget(state, { width: 60, styler: createStyler("truecolor"), glyphs: G, boxed: true });
  assert.ok(colored.join("").includes("["), "the truecolor styler emits ANSI");
  assert.deepEqual(colored.map(stripAnsi), boxed, "layout is identical with and without colour");
  console.log("✓ renderWidget boxed frame and ANSI-transparent layout");
}

// ── renderStatusLine ───────────────────────────────────────────────────────
{
  assert.equal(renderStatusLine({ list: sample(), phase: "build" }, G), `build 1/3 ${G.inProgress}`);
  assert.equal(renderStatusLine({ list: sample(), phase: "build", paused: true }, G), "paused");
  assert.equal(
    renderStatusLine({ list: { version: "2.0", baseRevision: 0, features: [] }, phase: "define" }, G),
    "define",
  );
  assert.equal(renderStatusLine({ list: { version: "2.0", baseRevision: 0, features: [] }, phase: null }, G), "idle");
  assert.equal(renderStatusLine({ list: manyTasks(3, 3), phase: "ship" }, G), `ship 3/3 ${G.complete}`);
  const blockedList = manyTasks(3, 1);
  blockedList.features[0]!.tasks[2]!.status = "blocked";
  assert.equal(renderStatusLine({ list: blockedList, phase: "build" }, G), `build 1/3 ${G.blocked}`);
  console.log("✓ renderStatusLine");
}

assert.equal(DEFAULT_WIDTH, 76);
console.log("All widget tests PASS");

// ── the outer loop is visible ──────────────────────────────────────────────
// A second pass at a goal looks identical to a first one in every other part
// of the display — which is exactly when someone glances at the terminal,
// sees a half-full progress bar, and walks away thinking it is nearly done.
{
  const base: WidgetState = {
    list: {
      version: "2.0",
      baseRevision: 3,
      goals: [{ id: "goal-001", title: "Ship the rewrite" }],
      sprints: [],
      features: [
        {
          id: "feature-001",
          name: "F",
          tasks: [{ id: "task-001", description: "work", status: "in_progress" }],
        },
      ],
    },
    phase: "build",
  };

  const plain = renderWidget(base, { width: 76 }).join("\n");
  assert.ok(!/pass \d+\//.test(plain), "no goal loop, no pass counter");

  const second = renderWidget({ ...base, goalPass: { current: 2, max: 5 } }, { width: 76 }).join("\n");
  assert.match(second, /pass 2\/5/, "a second pass says so");

  // A single-pass goal is just a run; a counter would be noise.
  const single = renderWidget({ ...base, goalPass: { current: 1, max: 1 } }, { width: 76 }).join("\n");
  assert.ok(!/pass 1\/1/.test(single));

  const escalating = renderWidget(
    { ...base, escalation: { strategy: "rework", reworks: 1, replans: 0 } },
    { width: 76 },
  ).join("\n");
  assert.match(escalating, /rework/, "the last rung of the ladder is visible");

  // It still fits, which is the whole constraint on this surface.
  for (const w of [58, 60, 76, 120]) {
    const lines = renderWidget(
      { ...base, goalPass: { current: 3, max: 9 }, escalation: { strategy: "replan", reworks: 2, replans: 1 } },
      { width: w, boxed: true },
    );
    for (const line of lines) {
      assert.equal(width(line), w, `boxed widget must be exactly ${w} columns`);
    }
  }
  console.log("✓ the goal pass and the last escalation are visible, and still fit");
}
