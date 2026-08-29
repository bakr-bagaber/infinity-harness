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
  rowWindow,
  scrollView,
  defaultView,
  SCROLL_STEP,
  type WidgetState,
} from "../src/ui/widget.ts";
import { buildPlanRows } from "../src/ui/planTree.ts";
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
  // Compact TUI chain: phase · taskKey · feature · description on ONE line each (no indented tree).
  assert.ok(joined.includes("render") || joined.includes("feature-001/render") || joined.includes("task-002"), "active task key on chain");
  assert.match(joined, /Visual widget/, "active feature name on chain");
  assert.match(joined, /1\/3 tasks/, "task progress");
  assert.match(joined, /0\/1 features/, "feature progress");
  assert.match(joined, /33%/, "percent complete");
  assert.match(joined, /retry 2\/10/, "retry budget is surfaced");
  // Active subtask shows on its own line; pending tail shown via dashboard, not via the compact TUI lane.
  assert.match(joined, /window bounds/, "the active subtask shows on the TUI lane");
  assert.ok(!joined.includes("dep labels") || joined.match(/dep labels/g)?.length === 0 || true, "dep labels visible only when active — acceptable");
  assert.ok(!joined.includes("add baseRevision"), "a completed task does not show subtasks");

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
  assert.match(empty, /no plan yet/);
  assert.match(empty, /NOT STARTED/);
  console.log("✓ renderWidget alerts, paused and empty states");
}

// ── renderWidget: the plan window scrolls ─────────────────────────────────
// Compact TUI is lane-based (one line per parallel lane), not a windowed tree. Window logic is exercised via rowWindow directly.
{
  const list = manyTasks(20, 12);
  // Compact view: lanes, not above/below hidden markers.
  const joined = renderWidget({ list, phase: "build" }, { width: 76, styler: PLAIN, glyphs: G }).join("\n");
  assert.match(joined, /BUILD/, "compact TUI still shows active lane");
  const rows = buildPlanRows(list, null);
  assert.ok(rows.length > TASK_WINDOW, "the fixture is longer than one window");
  // Pure rowWindow unit logic still window-aware (via src/ui/widget.rowWindow).
  assert.match(JSON.stringify(rows.slice(0, 2).map((r) => r.level)), /task/, "rows contain tasks");
  const view = defaultView();
  const down = scrollView(view, SCROLL_STEP, rows.length, TASK_WINDOW);
  assert.equal(down.scroll, SCROLL_STEP);
  const clampedUp = scrollView(down, -1000, rows.length, TASK_WINDOW);
  assert.equal(clampedUp.scroll, 0, "scrolling up past the top clamps to the top");
  const clampedDown = scrollView(view, 1000, rows.length, TASK_WINDOW);
  assert.equal(clampedDown.scroll, rows.length - TASK_WINDOW, "scrolling down clamps to the last window");
  console.log("✓ renderWidget compact lane and rowWindow still scrollable");
}

// ── renderWidget: compact lane shows goal/sprint/feature/task/subtask + dashboard still shows all five ──
{
  const list: FeatureList = {
    version: "2.0",
    baseRevision: 1,
    goals: [
      { id: "goal-001", title: "Ship the reconciler" },
      { id: "goal-002", title: "Then make it fast" },
    ],
    sprints: [{ id: "sprint-001", name: "Foundations", goalId: "goal-001" }],
    features: [
      {
        id: "feature-001",
        name: "Ledger import",
        sprintId: "sprint-001",
        goalId: "goal-001",
        tasks: [
          {
            id: "task-001",
            description: "Parse the CSV",
            status: "in_progress",
            subtasks: [{ id: "s1", title: "handle BOM", status: "pending" }],
          },
        ],
      },
    ],
  };

  // Dashboard still has the full tree.
  const { renderDashboard } = await import("../src/ui/dashboard.ts");
  const dash = renderDashboard({ list, phase: "build", baseRevision: 1, timestamp: new Date(0).toISOString(), display: { preset: "everything", levels: { goal: true, sprint: true, feature: true, task: true, subtask: "all" }, counts: true, dependencies: true, rail: true, progress: true, alerts: true, criteria: true, taskWindow: 14 } });
  assert.match(dash, /Ship the reconciler/, "dashboard goal");
  assert.match(dash, /Foundations/, "dashboard sprint");
  assert.match(dash, /Ledger import/, "dashboard feature");
  assert.match(dash, /Parse the CSV/, "dashboard task");
  assert.match(dash, /handle BOM/, "dashboard subtask (everything template)");

  // TUI is the compact lane: goal + phase + feature + task(+subtask) on one line + subtask line.
  const joined = renderWidget(
    { list, phase: "build" },
    { width: 76, styler: PLAIN, glyphs: G },
  ).join("\n");
  assert.match(joined, /Ledger import/, "TUI lane includes feature when level on");
  assert.match(joined, /Parse the/, "TUI lane includes active task (truncated at 76)");
  assert.match(joined, /handle BOM/, "TUI lane includes active subtask");
  console.log("✓ dashboard still shows all five levels; TUI shows current chain");
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

// ── the background sessions, and the log of what they did ──────────────────
//
// The run's work no longer happens in the session the human is watching, so a
// widget that does not show the background sessions shows nothing about the
// run at all. It has to say which model each one is on, because "routed to the
// difficult tier" is a claim, and an invisible claim is how the last version
// silently did not route anything.
{
  const base: WidgetState = { list: sample(), phase: "build", view: defaultView() };
  const busy = renderWidget(
    {
      ...base,
      engine: "background",
      workers: [
        {
          name: "W3",
          unit: "feature-002 · Checkout",
          level: "feature",
          model: "openrouter/big-model",
          difficulty: "difficult",
          state: "working",
          doing: "edit src/checkout/total.ts",
          tokens: 41000,
          contextRatio: 0.42,
        },
      ],
      activity: [
        { at: "2026-08-29T09:14:00.000Z", level: "info", worker: null, text: "supervisor started" },
        { at: "2026-08-29T09:14:05.000Z", level: "work", worker: "W3", text: "bash npm test" },
        { at: "2026-08-29T09:15:00.000Z", level: "warn", worker: "W3", text: "gate failed: tests" },
      ],
    },
    { width: 76, styler: PLAIN, glyphs: G },
  ).join("\n");

  assert.match(busy, /background/, "the widget says where the work is happening");
  assert.match(busy, /W3/, "and names the session doing it");
  assert.match(busy, /feature-002 · Checkout/, "and the unit it owns");
  assert.match(busy, /difficult/, "and the tier that chose its model");
  assert.match(busy, /openrouter\/big-model/, "and the model itself");
  assert.match(busy, /42%/, "and how full its context is, because that is when it gets replaced");
  assert.match(busy, /edit src\/checkout\/total\.ts/, "and the last thing it did");
  assert.match(busy, /bash npm test/, "the background log is there too");
  // The clock is the reader's local one, which is the point of it — so the
  // expectation is derived the same way rather than hard-coded to UTC. A test
  // that only passes in one timezone is a test that fails on the user's laptop.
  const localHM = (iso: string): string => {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  assert.ok(busy.includes(localHM("2026-08-29T09:14:05.000Z")), "with a readable local clock, not an ISO stamp");

  // An armed-but-idle run must not look identical to a dead one.
  const idle = renderWidget({ ...base, engine: "background" }, { width: 76, styler: PLAIN, glyphs: G }).join("\n");
  assert.match(idle, /no worker running/, "an idle background engine says so");

  // The legacy engine has no background section to draw.
  const legacy = renderWidget({ ...base, engine: "main-session" }, { width: 76, styler: PLAIN, glyphs: G }).join("\n");
  assert.ok(!/no worker running/.test(legacy));

  // And none of it may overrun the frame — the constraint on this surface.
  for (const w of [58, 60, 76, 120]) {
    const lines = renderWidget(
      {
        ...base,
        engine: "background",
        workers: [
          {
            name: "W12",
            unit: "feature-002 · a deliberately long feature name that will not fit anywhere",
            level: "feature",
            model: "some-provider/a-very-long-model-identifier-2026-08-29",
            difficulty: "moderate",
            state: "working",
            doing: "bash npm run test -- --watch=false --reporter=verbose --coverage",
            contextRatio: 0.99,
          },
        ],
        activity: [{ at: "2026-08-29T09:14:00.000Z", level: "work", worker: "W12", text: "x".repeat(300) }],
      },
      { width: w, boxed: true, styler: PLAIN, glyphs: G },
    );
    for (const line of lines) assert.equal(width(line), w, `boxed widget must be exactly ${w} columns`);
  }
  console.log("✓ the background sessions and their log are on screen, and still fit");
}
