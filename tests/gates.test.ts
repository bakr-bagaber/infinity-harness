import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  areGatesEnabled,
  checkTaskCriteria,
  getPhaseCheckNames,
  parseCoveragePercent,
  runChecks,
} from "../src/core/gates.ts";
import { defaultConfig, loadConfig } from "../src/core/config.ts";
import type { CheckResult, FeatureList, HarnessConfig, Task, TaskStatus } from "../src/core/types.ts";

function mkTask(id: string, status: TaskStatus, extra: Record<string, unknown> = {}): Task {
  return { id, description: id.toUpperCase(), status, dependsOn: [], subtasks: [], ...extra };
}

function tmpProject(
  mutate: (c: HarnessConfig) => void = () => {},
  list: FeatureList | null = null,
): string {
  const d = mkdtempSync(join(tmpdir(), "pi-gates-"));
  mkdirSync(join(d, "harness", "features"), { recursive: true });
  const c = defaultConfig();
  mutate(c);
  writeFileSync(join(d, "harness", "config.json"), JSON.stringify(c, null, 2), "utf-8");
  if (list) {
    writeFileSync(join(d, "harness", "features", "feature-list.json"), JSON.stringify(list, null, 2), "utf-8");
  }
  return d;
}

function onePlan(taskStatus: TaskStatus, subtasks: Array<{ id: string; title: string; status: string }> = []): FeatureList {
  return {
    version: "2.0",
    baseRevision: 1,
    goals: [],
    sprints: [],
    features: [
      {
        id: "feature-001",
        name: "F",
        criteria: ["it works"],
        tasks: [mkTask("task-1", taskStatus, { subtasks })],
      },
    ],
  };
}

function byName(checks: readonly CheckResult[], name: string): CheckResult {
  const c = checks.find((x) => x.name === name);
  assert.ok(c, `expected a check named ${name}, got ${checks.map((x) => x.name).join(", ")}`);
  return c!;
}

// ── parseCoveragePercent ───────────────────────────────────────────────────
{
  assert.equal(parseCoveragePercent(""), null, "nothing to parse");
  assert.equal(parseCoveragePercent("tests passed, no numbers here"), null);
  assert.equal(parseCoveragePercent("coverage: 87%"), 87);
  assert.equal(parseCoveragePercent("coverage: 87.25%"), 87.25, "decimals survive");
  assert.equal(parseCoveragePercent("coverage: 87 %"), 87, "a space before the sign is fine");
  assert.equal(parseCoveragePercent("0%"), 0);
  assert.equal(parseCoveragePercent("100%"), 100);

  // Coverage tools print lines/branches/functions separately. Take the
  // pessimistic figure — an optimistic maximum would open the gate on a report
  // that says 40% of branches are untested.
  assert.equal(
    parseCoveragePercent("All files | 92.1% stmts | 78.4% branch | 88% funcs | 92.1% lines"),
    78.4,
    "the minimum wins",
  );
  assert.equal(parseCoveragePercent("first 10%\nsecond 90%"), 10, "across lines too");

  // Figures that cannot be percentages are noise, not coverage.
  assert.equal(parseCoveragePercent("speedup 150%"), null, "an out-of-range figure is not coverage");
  assert.equal(parseCoveragePercent("speedup 150% but coverage 42%"), 42, "…and does not drag the minimum down");
  assert.equal(parseCoveragePercent("999%"), null);
  console.log("✓ parseCoveragePercent takes the minimum and ignores impossible figures");
}

// ── gates.enabled:false short-circuits ─────────────────────────────────────
{
  const dir = tmpProject((c) => {
    c.gates.enabled = false;
    c.commands.test = "exit 1";
  }, onePlan("pending"));
  try {
    assert.equal(areGatesEnabled(dir), false);
    const gate = await runChecks(dir, "build");
    assert.equal(gate.overall, true, "with gates off, nothing is enforced");
    assert.deepEqual(gate.failures, []);
    assert.equal(gate.checks.length, 1, "no real check is even attempted");
    assert.equal(gate.checks[0]!.name, "gates-disabled");
    assert.equal(gate.checks[0]!.advisory, true);
    assert.match(gate.checks[0]!.detail, /disabled/);
    assert.deepEqual(loadConfig(dir).config.gateHistory, [], "a short-circuited gate records nothing");
    console.log("✓ gates.enabled:false short-circuits to pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── no phase at all ────────────────────────────────────────────────────────
{
  const dir = tmpProject(() => {}, onePlan("complete"));
  try {
    const gate = await runChecks(dir, null);
    assert.equal(gate.phase, "none");
    assert.equal(gate.overall, false, "there is nothing to validate against");
    assert.deepEqual(gate.failures, ["no-phase"]);
    assert.deepEqual(gate.checks, []);
    assert.equal(areGatesEnabled(dir), true, "gates are on by default");
    console.log("✓ runChecks with no phase");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── advisory checks never fail the gate ────────────────────────────────────
{
  const dir = tmpProject(() => {}, onePlan("complete"));
  try {
    const gate = await runChecks(dir, "build", { record: false });
    for (const name of ["lint", "tests", "coverage"]) {
      const c = byName(gate.checks, name);
      assert.equal(c.advisory, true, `${name} is advisory when it cannot run`);
      assert.equal(c.pass, true, `${name} must not fail the gate just because it is unconfigured`);
      assert.match(c.detail, /no .* command configured|coverage gate disabled/);
    }
    assert.equal(byName(gate.checks, "tasks-complete").pass, true);
    assert.equal(byName(gate.checks, "anti-placeholder").pass, true);
    assert.equal(gate.overall, true, "a gate made only of advisory skips and real passes opens");
    assert.deepEqual(gate.failures, []);

    // Advisory passes must not paper over a real failure.
    writeFileSync(
      join(dir, "harness", "features", "feature-list.json"),
      JSON.stringify(onePlan("pending"), null, 2),
      "utf-8",
    );
    const failing = await runChecks(dir, "build", { record: false });
    assert.equal(failing.overall, false);
    assert.deepEqual(failing.failures, ["tasks-complete"]);
    assert.equal(byName(failing.checks, "lint").pass, true, "the advisory checks are unchanged");
    assert.match(byName(failing.checks, "tasks-complete").detail, /1 task\(s\) still open/);
    console.log("✓ advisory checks do not fail the gate, and do not mask real failures");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── a configured command is a real, non-advisory check ─────────────────────
{
  const dir = tmpProject((c) => {
    c.commands.test = "exit 3";
    c.commands.lint = "echo all good";
  }, onePlan("complete"));
  try {
    const gate = await runChecks(dir, "build", { record: false });
    const tests = byName(gate.checks, "tests");
    assert.equal(tests.pass, false, "a failing test command fails the gate");
    assert.notEqual(tests.advisory, true, "a configured command is not advisory");
    const lint = byName(gate.checks, "lint");
    assert.equal(lint.pass, true);
    assert.notEqual(lint.advisory, true);
    assert.equal(gate.overall, false);
    assert.deepEqual(gate.failures, ["tests"]);
    console.log("✓ a configured command produces a real verdict");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── coverage threshold, end to end through parseCoveragePercent ────────────
{
  const dir = tmpProject((c) => {
    c.gates.coverage.enabled = true;
    c.gates.coverage.threshold = 80;
    c.commands.coverage = "echo 'All files | 91.2% stmts | 84% branch'";
  }, onePlan("complete"));
  try {
    const pass = await runChecks(dir, "build", { record: false });
    const cov = byName(pass.checks, "coverage");
    assert.equal(cov.pass, true, cov.detail);
    assert.match(cov.detail, /84% ≥ 80% threshold/, "the pessimistic figure is the one compared");

    const cfg = loadConfig(dir).config;
    cfg.gates.coverage.threshold = 90;
    writeFileSync(join(dir, "harness", "config.json"), JSON.stringify(cfg, null, 2), "utf-8");
    const fail = await runChecks(dir, "build", { record: false });
    const covFail = byName(fail.checks, "coverage");
    assert.equal(covFail.pass, false);
    assert.match(covFail.detail, /84% is below the 90% threshold/);
    assert.equal(fail.overall, false);
    console.log("✓ the coverage gate compares the parsed minimum against the threshold");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── task-scoped gates run only what is meaningful for one task ─────────────
{
  const plan: FeatureList = {
    version: "2.0",
    baseRevision: 1,
    goals: [],
    sprints: [],
    features: [
      {
        id: "feature-001",
        name: "F",
        criteria: ["it works"],
        tasks: [
          mkTask("task-1", "complete", { subtasks: [{ id: "st-1", title: "s", status: "complete" }] }),
          mkTask("task-2", "pending"),
        ],
      },
    ],
  };
  const dir = tmpProject(() => {}, plan);
  try {
    const gate = await runChecks(dir, "build", { feature: "feature-001", task: "task-1", record: false });
    assert.deepEqual(
      gate.checks.map((c) => c.name),
      ["lint", "tests", "coverage", "task-criteria"],
      "only task-scoped checks plus the task's own criteria",
    );
    assert.ok(
      !gate.checks.some((c) => c.name === "tasks-complete"),
      "validating one task must not demand the whole phase is finished",
    );
    assert.ok(!gate.checks.some((c) => c.name === "anti-placeholder"), "whole-tree checks are phase-scoped");
    assert.equal(gate.overall, true, "the task is done even though the phase is not");
    assert.equal(gate.feature, "feature-001", "the scope is reported back");
    assert.equal(gate.task, "task-1");

    // The unfinished sibling still fails when it is the one being validated.
    const sibling = await runChecks(dir, "build", { feature: "feature-001", task: "task-2", record: false });
    assert.equal(sibling.overall, false);
    assert.deepEqual(sibling.failures, ["task-criteria"]);

    // A phase-scoped run of the same plan sees the whole picture.
    const phaseWide = await runChecks(dir, "build", { record: false });
    assert.ok(phaseWide.checks.some((c) => c.name === "tasks-complete"));
    assert.equal(phaseWide.overall, false);
    assert.equal(phaseWide.feature, undefined, "an unscoped gate reports no scope");
    console.log("✓ task-scoped runChecks runs only task-scoped checks plus task-criteria");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── checkTaskCriteria ──────────────────────────────────────────────────────
{
  const complete = tmpProject(
    () => {},
    onePlan("complete", [
      { id: "st-1", title: "one", status: "complete" },
      { id: "st-2", title: "two", status: "complete" },
    ]),
  );
  const openSub = tmpProject(
    () => {},
    onePlan("complete", [
      { id: "st-1", title: "one", status: "complete" },
      { id: "st-2", title: "two", status: "pending" },
      { id: "st-3", title: "three", status: "in_progress" },
    ]),
  );
  const notDone = tmpProject(() => {}, onePlan("in_progress"));
  try {
    const ok = checkTaskCriteria(complete, "feature-001", "task-1");
    assert.equal(ok.pass, true, ok.detail);
    assert.equal(ok.name, "task-criteria");
    assert.match(ok.detail, /complete with all subtasks done/);

    // An open subtask means the work is not finished, whatever the task says.
    const sub = checkTaskCriteria(openSub, "feature-001", "task-1");
    assert.equal(sub.pass, false);
    assert.match(sub.detail, /2 subtask\(s\) still open on task-1/);

    // A task that is not complete cannot pass its own criteria — no agent
    // marks its own work done.
    const open = checkTaskCriteria(notDone, "feature-001", "task-1");
    assert.equal(open.pass, false);
    assert.match(open.detail, /task-1 is "in_progress", not complete/);

    // Unknown scopes fail loudly rather than passing vacuously.
    const noFeature = checkTaskCriteria(complete, "feature-999", "task-1");
    assert.equal(noFeature.pass, false);
    assert.match(noFeature.detail, /unknown feature feature-999/);
    const noTask = checkTaskCriteria(complete, "feature-001", "task-999");
    assert.equal(noTask.pass, false);
    assert.match(noTask.detail, /unknown task task-999/);
    console.log("✓ checkTaskCriteria: open subtasks, incomplete task, unknown scope");
  } finally {
    for (const d of [complete, openSub, notDone]) rmSync(d, { recursive: true, force: true });
  }
}

// ── the verdict is recorded unless the caller opts out ─────────────────────
{
  const dir = tmpProject(() => {}, onePlan("complete"));
  try {
    await runChecks(dir, "build", { record: false });
    assert.deepEqual(loadConfig(dir).config.gateHistory, [], "record:false leaves no trace");

    await runChecks(dir, "build");
    const history = loadConfig(dir).config.gateHistory;
    assert.equal(history.length, 1);
    assert.equal(history[0]!.phase, "build");
    assert.equal(history[0]!.result, "pass");
    assert.equal("feature" in history[0]!, false, "an unscoped gate records no scope");

    await runChecks(dir, "build", { feature: "feature-001", task: "task-1" });
    const scoped = loadConfig(dir).config.gateHistory;
    assert.equal(scoped.length, 2);
    assert.equal(scoped[1]!.feature, "feature-001");
    assert.equal(scoped[1]!.task, "task-1");
    console.log("✓ gate verdicts are recorded to gateHistory");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── phase → check mapping ──────────────────────────────────────────────────
{
  assert.deepEqual(getPhaseCheckNames("init"), ["gitrepo", "configexists"]);
  // Seeded tasks are visible as progress (dashboard + TUI lane) and block via phase-scoped tasks-complete
  // in the loop, not as a hard gate — so research remains researchdoc/doc, define stays featurecriteria+skillsload
  // and the synthetic converge walk is not frozen by pending seeded tasks.
  assert.match(getPhaseCheckNames("research").join(","), /researchdoc/);
  assert.deepEqual(getPhaseCheckNames("define"), ["featurecriteria", "skillsload"]);
  assert.ok(getPhaseCheckNames("review").includes("skillsload"), "review re-checks the skills too");
  assert.deepEqual(getPhaseCheckNames("build"), ["lint", "tests", "coverage", "noplaceholders", "taskscomplete"]);
  assert.ok(getPhaseCheckNames("ship").includes("tagged"), "shipping demands a tag");
  assert.ok(getPhaseCheckNames("ship").includes("changelog"));

  // DEFINE demands criteria before any code is written.
  const noCriteria: FeatureList = {
    version: "2.0",
    baseRevision: 0,
    goals: [],
    sprints: [],
    features: [{ id: "feature-001", name: "F", tasks: [] }],
  };
  const dir = tmpProject(() => {}, noCriteria);
  try {
    const gate = await runChecks(dir, "define", { record: false });
    assert.equal(gate.overall, false);
    assert.match(byName(gate.checks, "feature-criteria").detail, /without criteria: feature-001/);

    const planGate = await runChecks(dir, "plan", { record: false });
    assert.equal(planGate.overall, false, "PLAN must produce tasks");
    assert.ok(planGate.failures.includes("tasks-planned"));
    assert.ok(planGate.failures.includes("feature-criteria"));
    console.log("✓ phase → check mapping");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── a project with no config at all still gets a verdict ───────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "pi-gates-bare-"));
  try {
    assert.equal(areGatesEnabled(dir), true, "the default is to enforce");
    const gate = await runChecks(dir, "init");
    assert.ok(gate.checks.some((c) => c.name === "config-exists"));
    assert.equal(byName(gate.checks, "config-exists").pass, false, "there is no harness/config.json");
    assert.equal(gate.overall, false);
    console.log("✓ an uninitialised project fails the INIT gate rather than throwing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("All gates tests PASS");
