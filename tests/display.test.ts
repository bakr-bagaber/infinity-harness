/**
 * Display templates: what the surfaces actually draw.
 *
 * Shipping all five plan levels to everyone was the wrong answer for the same
 * reason shipping two was. One person works in sprints and never opens a
 * subtask; the next has no sprints and lives in the subtask list. So it is a
 * setting, with templates for the common shapes.
 *
 * The rule worth defending: **hiding a level must not hide what is under it**.
 * Turning off sprints on a plan organised into sprints has to show the
 * features one indent shallower, not delete half the plan from view. A task
 * nobody can see is a task that gets stuck forever.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  BUILTIN_DISPLAYS,
  builtInDisplay,
  defaultDisplay,
  deleteDisplay,
  describeDisplay,
  findDisplay,
  listDisplays,
  loadSavedDisplays,
  matchDisplay,
  normalizeDisplay,
  saveDisplay,
  summarizeDisplay,
} from "../src/ui/display.ts";
import { buildPlanRows } from "../src/ui/planTree.ts";
import { renderWidget } from "../src/ui/widget.ts";
import { renderDashboard } from "../src/ui/dashboard.ts";
import { createStyler, UNICODE_GLYPHS, width } from "../src/ui/theme.ts";
import { userDisplayPath } from "../src/core/paths.ts";
import type { FeatureList } from "../src/core/types.ts";

const PLAN: FeatureList = {
  version: "2.0",
  baseRevision: 4,
  goals: [
    { id: "goal-001", title: "Reconcile payouts" },
    { id: "goal-002", title: "Then make it fast" },
  ],
  sprints: [{ id: "sprint-001", name: "Foundations", goalId: "goal-001" }],
  features: [
    {
      id: "feature-001",
      name: "Ledger import",
      sprintId: "sprint-001",
      goalId: "goal-001",
      criteria: ["refunds reconcile against the ledger"],
      tasks: [
        {
          id: "task-001",
          description: "Parse the payout CSV",
          status: "in_progress",
          dependsOn: [],
          subtasks: [{ id: "s1", title: "handle the BOM", status: "pending" }],
        },
      ],
    },
    {
      id: "feature-002",
      name: "Caching",
      goalId: "goal-002",
      tasks: [{ id: "task-002", description: "Memoise the FX table", status: "pending", subtasks: [] }],
    },
  ],
};

const PLAIN = createStyler("none");
const widgetText = (policy = defaultDisplay()): string =>
  renderWidget(
    { list: PLAN, phase: "build", display: policy, view: { scroll: 0, expanded: false } },
    { width: 76, styler: PLAIN, glyphs: UNICODE_GLYPHS },
  ).join("\n");

const dashboardText = (policy = defaultDisplay()): string =>
  renderDashboard({
    list: PLAN,
    phase: "build",
    baseRevision: 4,
    timestamp: new Date(0).toISOString(),
    display: policy,
  });

function sandbox(): { env: NodeJS.ProcessEnv; clean: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "display-store-"));
  return { env: { PI_CODING_AGENT_DIR: dir }, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

// ── the built-in templates ─────────────────────────────────────────────────
{
  assert.ok(BUILTIN_DISPLAYS.length >= 3, "at least three ship with the package");
  for (const t of BUILTIN_DISPLAYS) {
    assert.ok(t.builtIn);
    assert.ok(t.description.length > 20, `${t.id} says what it is for`);
    assert.equal(t.policy.preset, t.id, "a template's policy names the template");
    assert.deepEqual(normalizeDisplay(t.policy), t.policy, `${t.id} is already normalised`);
  }
  assert.equal(builtInDisplay("focus")?.policy.levels.subtask, "active");
  assert.equal(builtInDisplay("everything")?.policy.levels.subtask, "all");
  assert.equal(builtInDisplay("overview")?.policy.levels.task, false);
  assert.equal(builtInDisplay("worklist")?.policy.levels.feature, false);
  assert.equal(builtInDisplay("nope"), null);
  console.log("✓ the templates ship, differ from each other, and explain themselves");
}

// ── both surfaces obey the same policy ─────────────────────────────────────
{
  for (const t of BUILTIN_DISPLAYS) {
    const widget = widgetText(t.policy);
    const dashboard = dashboardText(t.policy);

    // Dashboard renders the full tree (goal→feature→task→subtask) — it must respect every level.
    for (const [level, needle] of [
      ["goal", "Reconcile payouts"],
      ["sprint", "Foundations"],
      ["feature", "Ledger import"],
      ["task", "Parse the payout CSV"],
    ] as const) {
      const wanted = t.policy.levels[level];
      assert.equal(
        dashboard.includes(needle),
        wanted,
        `${t.id}: the dashboard should ${wanted ? "show" : "hide"} ${level}`,
      );
    }
    const wantsSubtasksDashboard = t.policy.levels.subtask !== "none" && t.policy.levels.task;
    assert.equal(dashboard.includes("handle the BOM"), wantsSubtasksDashboard, `${t.id}: dashboard subtasks`);

    assert.equal(
      dashboard.includes("refunds reconcile against the ledger"),
      t.policy.criteria && t.policy.levels.feature,
      `${t.id}: acceptance criteria`,
    );

    // Widget is the compact TUI: goal/sprint/feature/subtask honour the policy as above, but:
    // - tasks emit the lane only when display.levels.task == true (overview suppresses lane).
    // - on narrow TUI (76 cols) the lane truncates — needles must allow truncation.
    if (t.policy.levels.task) {
      // Full task description truncated to key+desc(36) inside the chain — needle fits at 76 as compositeKey or prefix.
      const laneHasTask = widget.includes("Parse the") || widget.includes("feature-001/task-001");
      assert.equal(laneHasTask, true, `${t.id}: widget shows active task (lane)`);
      assert.equal(widget.includes("handle the BOM"), t.policy.levels.subtask !== "none", `${t.id}: widget subtasks on chain`);
    } else {
      // overview hides tasks entirely — widget lane is suppressed
      assert.ok(!widget.includes("Parse the payout"), `${t.id}: widget hides task when task level off`);
    }
  }
  console.log("✓ what you configure once is what both the widget and the dashboard draw");
}

// ── hiding a level never hides what is under it ────────────────────────────
// Dashboard is the authoritative tree; widget is the compact TUI (single-lane chain).
// So we assert dashboard for hierarchy, widget only for task visibility.
{
  const noSprints = normalizeDisplay({ ...defaultDisplay(), levels: { ...defaultDisplay().levels, sprint: false } });
  assert.ok(!dashboardText(noSprints).includes("Foundations"), "the sprint row is gone (dashboard)");
  assert.ok(dashboardText(noSprints).includes("Ledger import"), "and its feature is still there (dashboard)");
  assert.ok(dashboardText(noSprints).includes("Parse the payout CSV"), "and so is the task under that (dashboard)");

  const noFeatures = normalizeDisplay({
    ...defaultDisplay(),
    levels: { ...defaultDisplay().levels, feature: false },
  });
  assert.ok(!dashboardText(noFeatures).includes("Ledger import"), "feature row gone (dashboard)");
  assert.ok(dashboardText(noFeatures).includes("Parse the payout CSV"), "tasks survive a hidden feature (dashboard)");
  // Widget chain keeps compositeKey lane even when feature hidden — that is the minimal identifier for that lane.
  assert.ok(widgetText(noFeatures).includes("Parse the payout CSV"), "TUI lane still shows task when feature hidden");

  // Numbering has to keep meaning the same task whatever is on screen, or
  // `← #3` points at the wrong row.
  const hidden = buildPlanRows(PLAN, null, { levels: { feature: false, sprint: false, goal: false } });
  const shown = buildPlanRows(PLAN, null);
  assert.deepEqual(
    hidden.filter((r) => r.level === "task").map((r) => r.index),
    shown.filter((r) => r.level === "task").map((r) => r.index),
    "task numbers do not shift when a grouping level is hidden",
  );
  console.log("✓ hiding a level hides the row, never the work beneath it");
}

// ── the chrome is optional too ─────────────────────────────────────────────
{
  const bare = normalizeDisplay({
    ...defaultDisplay(),
    rail: false,
    progress: false,
    alerts: false,
    counts: false,
    dependencies: false,
  });
  const text = widgetText(bare);
  assert.ok(!/define ─|◉ BUILD/.test(text), "no phase rail");
  assert.ok(!/▰|▱/.test(text), "no progress meter");
  assert.ok(text.includes("Ledger import"), "and the plan is still there");
  assert.ok(!/\d+\/\d+$/m.test(text.replace(/\s+$/gm, "")), "no counts hanging off the right edge");

  // Every combination has to render, at every width, without overrunning.
  for (const t of [...BUILTIN_DISPLAYS.map((d) => d.policy), bare]) {
    for (const w of [24, 40, 58, 76, 120]) {
      const lines = renderWidget(
        { list: PLAN, phase: "build", display: t },
        { width: w, styler: PLAIN, glyphs: UNICODE_GLYPHS, boxed: true },
      );
      for (const l of lines) {
        assert.equal(width(l), w, `${t.preset} at ${w} columns produced a ${width(l)}-column line`);
      }
    }
  }
  console.log("✓ the rail, the meter, the alerts and the counts are each optional, at every width");
}

// ── saving, reusing, deleting ──────────────────────────────────────────────
{
  const box = sandbox();
  assert.deepEqual(loadSavedDisplays(box.env), []);

  const policy = normalizeDisplay({
    ...defaultDisplay(),
    levels: { goal: false, sprint: true, feature: true, task: true, subtask: "all" },
  });
  const saved = saveDisplay({ name: "Sprint view", policy }, box.env);
  assert.equal(saved.ok, true, saved.error ?? "");
  assert.equal(saved.template?.id, "sprint-view");
  assert.equal(saved.template?.policy.preset, "sprint-view", "the saved policy names itself");
  assert.ok(saved.template!.description.length > 0);

  assert.equal(findDisplay("sprint-view", box.env)?.name, "Sprint view");
  assert.equal(listDisplays(box.env).length, BUILTIN_DISPLAYS.length + 1);
  assert.equal(deleteDisplay("sprint-view", box.env).ok, true);
  assert.equal(loadSavedDisplays(box.env).length, 0);

  assert.equal(saveDisplay({ name: "focus", policy }, box.env).ok, false, "a built-in name is taken");
  assert.equal(deleteDisplay("focus", box.env).ok, false, "and a built-in cannot be deleted");
  box.clean();
  console.log("✓ a template can be saved under a name and reused, and built-ins are protected");
}

// ── junk in, a widget out ──────────────────────────────────────────────────
{
  // Every field is read on every render, inside a pi lifecycle hook, so a
  // hand-edited config has to produce a widget rather than kill the session.
  const junk = normalizeDisplay({ levels: "yes", counts: "sure", taskWindow: -12, preset: 42 });
  assert.equal(junk.levels.goal, true);
  assert.equal(junk.counts, true);
  assert.ok(junk.taskWindow >= 3, "a window of -12 would be a widget with no plan in it");
  assert.equal(junk.preset, defaultDisplay().preset);

  assert.deepEqual(normalizeDisplay(null), defaultDisplay());
  assert.deepEqual(normalizeDisplay(undefined), defaultDisplay());
  assert.equal(normalizeDisplay({ taskWindow: 10_000 }).taskWindow, 60, "and an absurd one is capped");
  assert.equal(normalizeDisplay({ levels: { subtask: "sometimes" } }).levels.subtask, "active");
  assert.doesNotThrow(() => widgetText(junk));

  const box = sandbox();
  const path = userDisplayPath(box.env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{not json", "utf-8");
  assert.deepEqual(loadSavedDisplays(box.env), [], "a corrupt store leaves the built-ins");
  box.clean();
  console.log("✓ a nonsense policy is repaired rather than thrown");
}

// ── describing ─────────────────────────────────────────────────────────────
{
  const box = sandbox();
  assert.match(describeDisplay(defaultDisplay()), /goal/);
  assert.match(describeDisplay(builtInDisplay("worklist")!.policy), /^task/);
  assert.match(
    describeDisplay(
      normalizeDisplay({
        levels: { goal: false, sprint: false, feature: false, task: false, subtask: "none" },
      }),
    ),
    /every level is hidden/,
    "an empty display says so rather than rendering an empty string",
  );

  assert.equal(matchDisplay(builtInDisplay("overview")!.policy, box.env)?.id, "overview");
  assert.match(summarizeDisplay(builtInDisplay("overview")!.policy, box.env), /^overview ·/);

  const drifted = { ...builtInDisplay("overview")!.policy, counts: false };
  assert.equal(matchDisplay(drifted, box.env), null);
  assert.match(summarizeDisplay(drifted, box.env), /\(edited\)/, "a hand-edited policy stops claiming the name");
  box.clean();
  console.log("✓ a display can be read at a glance, and says when it has drifted off its template");
}
