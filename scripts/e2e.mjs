#!/usr/bin/env node
/**
 * infinity-harness — the end-to-end suite.
 *
 * `npm test` proves each module keeps its own contract. This proves the
 * product: real temp projects, real git repos, real child processes, real
 * sockets, driven through the same calls the pi extension makes. Nothing here
 * is mocked — if a scenario passes, the flow it describes actually works on a
 * filesystem.
 *
 * Eleven scenarios:
 *   pipeline      define → plan → build → verify → review → ship, gate by gate
 *   convergence   decideNext drives a satisfiable project to "complete" alone
 *   stops         every stop condition fires, from real state
 *   crash         SIGKILL mid-phase, reload from disk, and .bak recovery
 *   concurrency   parallel child processes writing the same plan
 *   roundtrip     task fields survive repeated plan edits
 *   dashboard     the HTTP server, and proof it never writes
 *   widget        rendering across empty / huge / long / CJK / ASCII / narrow
 *   edges         adversarial plans and inputs
 *   extension     the pi adapter's own tools, commands and lifecycle hooks
 *   live          one real model call — probed, and skipped when unreachable
 *
 * Usage:
 *   node scripts/e2e.mjs                 every scenario
 *   node scripts/e2e.mjs --only pipeline one scenario
 *   node scripts/e2e.mjs --verbose       timings and extra detail
 *   node scripts/e2e.mjs --list          names only
 *   node scripts/e2e.mjs --no-live       skip the optional model leg
 *
 * On `.ts` imports: Node 22.18+ strips types by default, so this `.mjs` file
 * imports the project's `.ts` modules directly. On an older Node 22 the
 * bootstrap below re-execs with `--experimental-strip-types`, which is why
 * every src import is a top-level `await import` rather than a static one —
 * static imports would be linked before the bootstrap could run.
 */

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── bootstrap ───────────────────────────────────────────────────────────────

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SELF), "..");

if (!process.features.typescript) {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", SELF, ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  process.exit(r.status ?? 1);
}

const src = (rel) => import(pathToFileURL(join(REPO_ROOT, "src", rel)).href);

const { defaultConfig, loadConfig, saveConfig, isHarnessProject, getRetryConfig } = await src("core/config.ts");
const { configPath, featureListPath, architecturePath, decisionsPath, rubricPath } = await src("core/paths.ts");
const { advancePhase, transitionPhase, getPhaseOrder, isValidTransition, isFinalPhase } = await src("core/phases.ts");
const { runChecks, checkTaskCriteria, parseCoveragePercent } = await src("core/gates.ts");
const {
  loadFeatureList,
  saveFeatureList,
  computeProgress,
  flattenTasks,
  nextActionableTask,
  findTask,
} = await src("core/featureList.ts");
const { buildBrief, renderBrief } = await src("core/brief.ts");
const { withLock } = await src("core/lock.ts");
const { writeTaskList, applyTaskList, summarizeApply } = await src("taskList.ts");
const { decideNext, loopStatePath, stopFilePath, newLoopState, saveLoopState } = await src("loop.ts");
const { createRemoteServer, buildRemoteState, buildApiPayload, buildHtml } = await src("remote.ts");
const { renderWidget, renderStatusLine, scrollView, defaultView, SCROLL_STEP, TASK_WINDOW } =
  await src("ui/widget.ts");
const { buildPlanRows, groupPlan } = await src("ui/planTree.ts");
const { initHarness } = await src("core/init.ts");
const { createStyler, detectGlyphs, UNICODE_GLYPHS, ASCII_GLYPHS, width, stripAnsi } = await src("ui/theme.ts");

const assert = (await import("node:assert/strict")).default;

// ── cli ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? null);
};

const VERBOSE = flag("--verbose") || flag("-v");
const LIST_ONLY = flag("--list");
const NO_LIVE = flag("--no-live");
const ONLY = value("--only");

// ── reporting ───────────────────────────────────────────────────────────────

const RULE = "─".repeat(72);
const out = (s = "") => process.stdout.write(s + "\n");
const indent = (text, n) =>
  String(text)
    .replace(/\s+$/, "")
    .split("\n")
    .map((l) => " ".repeat(n) + l)
    .join("\n");

let stepsPassed = 0;

/** One assertion group. A failure aborts its scenario — later steps assume it. */
async function step(label, fn) {
  const t0 = Date.now();
  try {
    await fn();
  } catch (e) {
    out(`  ✗ ${label}`);
    out(indent(e?.stack ?? String(e), 6));
    const wrapped = new Error(label);
    wrapped.__stepFailure = true;
    throw wrapped;
  }
  stepsPassed += 1;
  out(`  ✓ ${label}${VERBOSE ? `  ${Date.now() - t0}ms` : ""}`);
}

const note = (msg) => {
  if (VERBOSE) out(`    · ${msg}`);
};

/** A measured finding worth seeing whether or not --verbose is on. */
const warn = (msg) => out(`    ! ${msg}`);

// ── resource tracking ───────────────────────────────────────────────────────

const TEMP_DIRS = new Set();
/** Every dir ever created, so the final sweep can prove none survived. */
const ALL_TEMP_DIRS = new Set();
const CHILDREN = new Set();
const SERVERS = new Set();

function cleanupSync() {
  for (const c of CHILDREN) {
    try {
      if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  CHILDREN.clear();
  for (const d of TEMP_DIRS) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  TEMP_DIRS.clear();
}

async function closeServers() {
  for (const s of SERVERS) {
    try {
      await s.close();
    } catch {
      /* closing a dead server is fine */
    }
  }
  SERVERS.clear();
}

process.on("exit", cleanupSync);

// ── filesystem / git fixtures ───────────────────────────────────────────────

function mkTempDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), `infinity-e2e-${prefix}-`));
  TEMP_DIRS.add(d);
  ALL_TEMP_DIRS.add(d);
  return d;
}

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitInit(dir) {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "e2e@infinity.invalid"]);
  git(dir, ["config", "user.name", "infinity e2e"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

function gitCommitAll(dir, message) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", message]);
}

function gitIsDirty(dir) {
  return git(dir, ["status", "--porcelain"]).trim() !== "";
}

function put(dir, rel, contents) {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, contents, "utf-8");
  return p;
}

function sha(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Body prose long enough to clear a doc gate's minimum-content threshold. */
function prose(minChars) {
  const sentence =
    "The harness records the reasoning behind each decision so a later reader can follow it without guessing. ";
  let s = "";
  while (s.length < minChars + 20) s += sentence;
  return s;
}

/**
 * A project with a git repo, a harness dir, and harness state gitignored —
 * the same arrangement the real repo uses, so the harness writing gate history
 * does not dirty the tree a git-clean gate is about to inspect.
 */
function mkProject(prefix, mutateConfigFn = () => {}) {
  const dir = mkTempDir(prefix);
  mkdirSync(join(dir, "harness", "features"), { recursive: true });
  gitInit(dir);
  put(dir, ".gitignore", "harness/\nnode_modules/\ntmp/\n");
  const c = defaultConfig();
  mutateConfigFn(c);
  writeFileSync(configPath(dir), JSON.stringify(c, null, 2) + "\n", "utf-8");
  gitCommitAll(dir, "chore: initial commit");
  return dir;
}

function editConfig(dir, fn) {
  const { config } = loadConfig(dir);
  fn(config);
  const r = saveConfig(dir, config);
  assert.equal(r.ok, true, `saveConfig failed: ${r.error}`);
  return config;
}

function cfg(dir) {
  return loadConfig(dir).config;
}

function writePlanFile(dir, list) {
  writeFileSync(featureListPath(dir), JSON.stringify(list, null, 2) + "\n", "utf-8");
}

function planOf(dir) {
  return loadFeatureList(dir).list;
}

function revisionOf(dir) {
  return planOf(dir).baseRevision;
}

/** Submit the whole plan as the agent would, from whatever is on disk now. */
function submit(dir, mutateTasks) {
  const list = planOf(dir);
  const tasks = flattenTasks(list).map((t) => ({
    key: t.compositeKey,
    subject: t.description,
    status: t.status,
    dependsOn: [...(t.dependsOn ?? [])],
  }));
  const next = mutateTasks ? (mutateTasks(tasks) ?? tasks) : tasks;
  return writeTaskList(dir, { baseRevision: list.baseRevision, tasks: next });
}

function gateFailures(gate) {
  return [...gate.failures].sort();
}

function checkNamed(gate, name) {
  const c = gate.checks.find((x) => x.name === name);
  assert.ok(c, `gate has no check named "${name}" (has: ${gate.checks.map((x) => x.name).join(", ")})`);
  return c;
}

// ── scripts run as real child processes ─────────────────────────────────────

const SRC_URL = (rel) => JSON.stringify(pathToFileURL(join(REPO_ROOT, "src", rel)).href);

/**
 * One parallel plan writer. Reads the plan, stamps its own task, and submits
 * the complete list under the same lock the extension's infinity_plan uses.
 * A stale revision is retried, never forced.
 */
const CONCURRENT_WRITER = `
import { loadFeatureList, flattenTasks } from ${SRC_URL("core/featureList.ts")};
import { featureListPath } from ${SRC_URL("core/paths.ts")};
import { withLock } from ${SRC_URL("core/lock.ts")};
import { writeTaskList } from ${SRC_URL("taskList.ts")};

const [dir, key, stamp] = process.argv.slice(2);
const revisions = [];
let stale = 0;
let lockedCount = 0;
let error = null;

for (let attempt = 0; attempt < 60; attempt++) {
  const { list } = loadFeatureList(dir);
  const tasks = flattenTasks(list).map((t) => ({
    key: t.compositeKey,
    subject: t.compositeKey === key ? stamp : t.description,
    status: t.status,
    dependsOn: [...(t.dependsOn ?? [])],
  }));
  try {
    const { value: result, locked } = await withLock(featureListPath(dir), () =>
      writeTaskList(dir, { baseRevision: list.baseRevision, tasks }),
    );
    if (locked) lockedCount += 1;
    revisions.push(result.revision);
    error = null;
    break;
  } catch (e) {
    if (String(e?.message ?? e).includes("stale baseRevision")) {
      stale += 1;
      error = String(e.message);
      await new Promise((r) => setTimeout(r, 2 + Math.floor(Math.random() * 8)));
      continue;
    }
    error = String(e?.message ?? e);
    break;
  }
}

process.stdout.write(JSON.stringify({ key, revisions, stale, lockedCount, error }));
`;

/**
 * The same writer with the lock removed. Not a product path — the extension
 * always locks — but it measures what the lock is actually buying.
 */
const UNLOCKED_WRITER = `
import { loadFeatureList, saveFeatureList, flattenTasks } from ${SRC_URL("core/featureList.ts")};
import { applyTaskList } from ${SRC_URL("taskList.ts")};

// Deliberately composes the primitives by hand — read, apply, save — with no
// mutual exclusion, which is exactly what writeTaskList used to do. This is
// the control: it shows the race is real, and therefore that the lock inside
// writeTaskList is load-bearing rather than decorative.
const writeTaskList = (dir, input) => {
  const { list } = loadFeatureList(dir);
  const result = applyTaskList(list, input);
  if (result.changed) saveFeatureList(dir, result.list);
  return result;
};

const [dir, key, stamp] = process.argv.slice(2);
const revisions = [];
let stale = 0;
let error = null;

for (let attempt = 0; attempt < 60; attempt++) {
  const { list } = loadFeatureList(dir);
  const tasks = flattenTasks(list).map((t) => ({
    key: t.compositeKey,
    subject: t.compositeKey === key ? stamp : t.description,
    status: t.status,
    dependsOn: [...(t.dependsOn ?? [])],
  }));
  try {
    revisions.push(writeTaskList(dir, { baseRevision: list.baseRevision, tasks }).revision);
    error = null;
    break;
  } catch (e) {
    if (String(e?.message ?? e).includes("stale baseRevision")) {
      stale += 1;
      await new Promise((r) => setTimeout(r, 2 + Math.floor(Math.random() * 8)));
      continue;
    }
    error = String(e?.message ?? e);
    break;
  }
}

process.stdout.write(JSON.stringify({ key, revisions, stale, lockedCount: 0, error }));
`;

/** Sets up real state, takes the plan lock, then hangs waiting to be killed. */
const CRASH_VICTIM = `
import { advancePhase } from ${SRC_URL("core/phases.ts")};
import { featureListPath } from ${SRC_URL("core/paths.ts")};
import { withLock } from ${SRC_URL("core/lock.ts")};
import { writeTaskList } from ${SRC_URL("taskList.ts")};

const dir = process.argv[2];
await advancePhase(dir); // → define
await advancePhase(dir); // → plan
await advancePhase(dir); // → build

writeTaskList(dir, {
  baseRevision: 0,
  tasks: [
    { key: "feature-001/task-001", subject: "wire the ledger reconciler", status: "complete",
      difficulty: "moderate", criteria: ["reconciles split tenders"] },
    { key: "feature-001/task-002", subject: "emit the refund webhook", status: "in_progress",
      dependsOn: ["feature-001/task-001"], modelHint: "big-model" },
  ],
});

await withLock(featureListPath(dir), async () => {
  // A bare pending promise would let Node's event loop drain and exit cleanly;
  // this process has to be alive for the parent to actually kill it.
  const keepAlive = setInterval(() => {}, 250);
  process.stdout.write("READY\\n");
  await new Promise(() => {});
  clearInterval(keepAlive);
});
`;

function writeRunner(runnerDir, name, source) {
  return put(runnerDir, name, source);
}

function spawnChild(script, args, opts = {}) {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", script, ...args],
    { stdio: ["ignore", "pipe", "pipe"], ...opts },
  );
  CHILDREN.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d.toString();
  });
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });
  const done = new Promise((res) => {
    child.on("close", (code, signal) => {
      CHILDREN.delete(child);
      res({ code, signal, stdout, stderr });
    });
  });
  return {
    child,
    done,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 1 — the full pipeline walkthrough
// ═══════════════════════════════════════════════════════════════════════════

async function scenarioPipeline() {
  const dir = mkProject("pipeline");

  await step("a fresh project sits before the first phase, and a phaseless gate fails", async () => {
    assert.equal(isHarnessProject(dir), true);
    assert.equal(cfg(dir).currentPhase, null);
    const g = await runChecks(dir, null, { record: false });
    assert.equal(g.overall, false);
    assert.deepEqual(g.failures, ["no-phase"]);

    const b = await buildBrief(dir);
    assert.equal(b.phase, null);
    assert.equal(b.complete, false);
    assert.equal(b.progress.tasksTotal, 0);
  });

  await step("the pipeline is forward-only: you cannot start at ship", async () => {
    const jump = await transitionPhase(dir, "ship");
    assert.equal(jump.ok, false);
    assert.match(jump.error, /invalid transition start → ship/);
    assert.match(jump.error, /define → plan → build → verify → review → ship/);
    assert.equal(cfg(dir).currentPhase, null, "a refused transition changes nothing");
  });

  await step("DEFINE opens only once every feature carries acceptance criteria", async () => {
    const first = await advancePhase(dir);
    assert.equal(first.ok, true);
    assert.equal(first.to, "define");
    assert.equal(cfg(dir).currentPhase, "define");
    assert.equal(cfg(dir).currentRole, "planner");

    let g = await runChecks(dir, "define", { record: true });
    assert.equal(g.overall, false);
    assert.equal(checkNamed(g, "feature-criteria").detail, "no features planned yet");

    writePlanFile(dir, {
      version: "2.0",
      baseRevision: 0,
      goals: [{ id: "goal-001", title: "Ship the payments rewrite behind a flag" }],
      sprints: [],
      features: [{ id: "feature-001", name: "Checkout flow", passes: false, tasks: [] }],
    });
    g = await runChecks(dir, "define", { record: true });
    assert.equal(g.overall, false);
    assert.match(checkNamed(g, "feature-criteria").detail, /features without criteria: feature-001/);

    const list = planOf(dir);
    list.features[0].criteria = [
      "a split-tender refund reconciles to the ledger",
      "the flag defaults to off",
    ];
    saveFeatureList(dir, list);

    g = await runChecks(dir, "define", { record: true });
    assert.equal(g.overall, true, JSON.stringify(g.failures));
    assert.deepEqual(g.failures, []);
  });

  await step("advancing resets the phase retry budget but keeps the task budget", async () => {
    editConfig(dir, (c) => {
      c.phaseRetryCount = 4;
      c.retryCount = 4;
      c.taskRetryCount = 2;
      c.featureRetryCount = 1;
    });
    const before = cfg(dir).pipelineIteration;

    const moved = await advancePhase(dir);
    assert.equal(moved.ok, true);
    assert.equal(moved.from, "define");
    assert.equal(moved.to, "plan");

    const c = cfg(dir);
    assert.equal(c.currentPhase, "plan");
    assert.equal(c.phaseRetryCount, 0, "a new phase clears the phase budget");
    assert.equal(c.retryCount, 0);
    assert.equal(c.taskRetryCount, 2, "the task budget belongs to the task, not the phase");
    assert.equal(c.featureRetryCount, 1);
    assert.equal(c.pipelineIteration, before + 1);
    assert.equal(c.git.branch, "main", "git metadata is refreshed on transition");
  });

  await step("re-entering the same phase counts as a retry rather than progress", async () => {
    const again = await transitionPhase(dir, "plan");
    assert.equal(again.ok, true);
    const c = cfg(dir);
    assert.equal(c.phaseRetryCount, 1);
    assert.equal(c.retryCount, 1);
    editConfig(dir, (x) => {
      x.phaseRetryCount = 0;
      x.retryCount = 0;
    });
  });

  await step("PLAN opens only once the plan has tasks", async () => {
    let g = await runChecks(dir, "plan", { record: true });
    assert.equal(g.overall, false);
    assert.deepEqual(gateFailures(g), ["tasks-planned"]);
    assert.equal(checkNamed(g, "feature-criteria").pass, true);

    const result = writeTaskList(dir, {
      baseRevision: revisionOf(dir),
      tasks: [
        {
          key: "feature-001/task-001",
          subject: "validate cart totals against catalogue prices",
          status: "pending",
          difficulty: "easy",
          criteria: ["totals match the catalogue to the cent"],
        },
        {
          key: "feature-001/task-002",
          subject: "apply stacked discount codes with precedence rules",
          status: "pending",
          dependsOn: ["feature-001/task-001"],
          difficulty: "difficult",
          modelHint: "large",
          subtasks: [{ title: "precedence table", status: "pending" }],
        },
        {
          key: "feature-001/task-003",
          subject: "handle partial refunds across split tenders",
          status: "pending",
          dependsOn: ["feature-001/task-002"],
          difficulty: "moderate",
        },
      ],
    });
    assert.equal(result.changed, true);
    assert.equal(result.revision, 1);
    assert.deepEqual(result.change.added, [
      "feature-001/task-001",
      "feature-001/task-002",
      "feature-001/task-003",
    ]);

    g = await runChecks(dir, "plan", { record: true });
    assert.equal(g.overall, true, JSON.stringify(g.failures));
    assert.match(checkNamed(g, "tasks-planned").detail, /3 task\(s\) planned/);

    const b = await buildBrief(dir);
    assert.equal(b.task.key, "feature-001/task-001", "the brief names the first actionable task");
    assert.deepEqual(b.criteria, ["totals match the catalogue to the cent"]);
    assert.equal(b.goal, "Ship the payments rewrite behind a flag");

    const moved = await advancePhase(dir);
    assert.equal(moved.to, "build");
    assert.equal(cfg(dir).currentPhase, "build");
    assert.equal(cfg(dir).currentRole, "generator");
  });

  await step("BUILD fails on tests, coverage, placeholders and open tasks", async () => {
    put(dir, "run-tests.js", 'console.error("2 failing"); process.exit(1);\n');
    put(dir, "coverage.js", 'console.log("All files | 41.2 % | 38.0 %");\n');
    put(dir, "src/app.js", "export function refund() {\n  // TODO: implement split tender refunds\n}\n");
    editConfig(dir, (c) => {
      c.commands.lint = `${JSON.stringify(process.execPath)} --check src/app.js`;
      c.commands.test = `${JSON.stringify(process.execPath)} run-tests.js`;
      c.commands.coverage = `${JSON.stringify(process.execPath)} coverage.js`;
      c.gates.coverage.enabled = true;
      c.gates.coverage.threshold = 80;
    });

    const g = await runChecks(dir, "build", { record: true });
    assert.equal(g.overall, false);
    assert.deepEqual(gateFailures(g), ["anti-placeholder", "coverage", "tasks-complete", "tests"]);
    assert.equal(checkNamed(g, "lint").pass, true, "lint is configured and passes");
    assert.equal(checkNamed(g, "coverage").detail, "38% is below the 80% threshold");
    assert.match(checkNamed(g, "anti-placeholder").detail, /src\/app\.js/);
    assert.match(checkNamed(g, "tasks-complete").detail, /3 task\(s\) still open/);
  });

  await step("BUILD opens once the work is real: tests green, coverage up, no placeholders", async () => {
    put(dir, "run-tests.js", 'console.log("12 passing"); process.exit(0);\n');
    put(dir, "coverage.js", 'console.log("All files | 93.5 % | 88.1 %");\n');
    put(
      dir,
      "src/app.js",
      [
        "export function refund(tenders, amount) {",
        "  let left = amount;",
        "  return tenders.map((t) => {",
        "    const take = Math.min(t.captured, left);",
        "    left -= take;",
        "    return { tender: t.id, refunded: take };",
        "  });",
        "}",
        "",
      ].join("\n"),
    );

    let g = await runChecks(dir, "build", { record: true });
    assert.equal(g.overall, false);
    assert.deepEqual(gateFailures(g), ["tasks-complete"], "only the plan is still open");
    assert.equal(checkNamed(g, "coverage").detail, "88.1% ≥ 80% threshold");

    // The gate is the referee, so the plan has to say the work is done.
    const done = submit(dir, (tasks) => tasks.map((t) => ({ ...t, status: "complete" })));
    assert.equal(done.changed, true);
    assert.equal(computeProgress(planOf(dir)).tasksDone, 3);
    assert.equal(planOf(dir).features[0].passes, true, "a feature passes when all its tasks do");

    g = await runChecks(dir, "build", { record: true });
    assert.equal(g.overall, true, JSON.stringify(g.failures));

    assert.equal(gitIsDirty(dir), true, "BUILD does not demand a clean tree — VERIFY does");

    const moved = await advancePhase(dir);
    assert.equal(moved.to, "verify");
    assert.equal(cfg(dir).currentRole, "evaluator");
  });

  await step("VERIFY demands a clean tree, and opens once the work is committed", async () => {
    let g = await runChecks(dir, "verify", { record: true });
    assert.equal(g.overall, false);
    assert.deepEqual(gateFailures(g), ["git-clean"]);
    assert.match(checkNamed(g, "git-clean").detail, /uncommitted changes/);

    gitCommitAll(dir, "feat: split tender refunds");
    assert.equal(gitIsDirty(dir), false);

    g = await runChecks(dir, "verify", { record: true });
    assert.equal(g.overall, true, JSON.stringify(g.failures));

    const moved = await advancePhase(dir);
    assert.equal(moved.to, "review", "SIMPLIFY is opt-in and disabled, so VERIFY leads to REVIEW");
  });

  await step("REVIEW wants real documents, not empty ones", async () => {
    let g = await runChecks(dir, "review", { record: true });
    assert.equal(g.overall, false);
    assert.deepEqual(gateFailures(g), ["architecture-doc", "decisions-logged", "readme", "rubric-content"]);

    const upstream = checkNamed(g, "branch-up-to-date");
    assert.equal(upstream.advisory, true, "a check that cannot run is advisory, never a blocker");
    assert.equal(upstream.pass, true);
    assert.ok(!g.failures.includes("branch-up-to-date"));

    // Headings alone are not content: the gate strips them before measuring.
    put(dir, "README.md", "# Payments\n\n## Usage\n\n### Notes\n");
    g = await runChecks(dir, "review", { record: false });
    assert.match(checkNamed(g, "readme").detail, /essentially empty/);

    put(dir, "README.md", `# Payments\n\n${prose(260)}\n`);
    put(dir, "harness/evaluator-rubric.md", `# Rubric\n\n${prose(140)}\n`);
    put(dir, "harness/docs/ARCHITECTURE.md", `# Architecture\n\n${prose(260)}\n`);
    put(dir, "harness/docs/DECISIONS.md", `# Decisions\n\n${prose(140)}\n`);

    g = await runChecks(dir, "review", { record: true });
    assert.equal(g.overall, true, JSON.stringify(g.failures));
    assert.equal(existsSync(rubricPath(dir)) && existsSync(architecturePath(dir)) && existsSync(decisionsPath(dir)), true);

    const moved = await advancePhase(dir);
    assert.equal(moved.to, "ship");
  });

  await step("SHIP wants a clean, tagged, documented tree with no empty corners", async () => {
    mkdirSync(join(dir, "src", "scratch"), { recursive: true });

    let g = await runChecks(dir, "ship", { record: true });
    assert.equal(g.overall, false);
    assert.deepEqual(gateFailures(g), ["changelog", "git-clean", "license", "no-empty-dirs", "tagged"]);
    assert.match(checkNamed(g, "no-empty-dirs").detail, /src\/scratch/);

    rmSync(join(dir, "src", "scratch"), { recursive: true, force: true });
    put(dir, "CHANGELOG.md", `# Changelog\n\n## 0.1.0\n\n${prose(140)}\n`);
    put(dir, "LICENSE", "MIT License\n\nPermission is hereby granted, free of charge, to any person...\n");
    gitCommitAll(dir, "docs: readme, changelog and licence");

    g = await runChecks(dir, "ship", { record: true });
    assert.equal(g.overall, false);
    assert.deepEqual(gateFailures(g), ["tagged"], "everything but the tag is in place");

    git(dir, ["tag", "-a", "v0.1.0", "-m", "first release"]);
    g = await runChecks(dir, "ship", { record: true });
    assert.equal(g.overall, true, JSON.stringify(g.failures));
  });

  await step("the pipeline is traversed: ship is final, and the run reports complete", async () => {
    const c = cfg(dir);
    assert.equal(c.currentPhase, "ship");
    assert.equal(isFinalPhase("ship", c.phases.enabled), true);
    assert.equal(c.pipelineIteration, 6, "six transitions: define, plan, build, verify, review, ship");

    const past = await advancePhase(dir);
    assert.equal(past.ok, false);
    assert.match(past.error, /pipeline complete — no phase after ship/);
    assert.equal(cfg(dir).currentPhase, "ship", "a refused advance leaves the phase alone");

    const b = await buildBrief(dir);
    assert.equal(b.complete, true);
    assert.match(renderBrief(b, cfg(dir)), /PIPELINE COMPLETE/);

    const { decision } = await decideNext({ targetDir: dir, runId: "pipeline-walkthrough" });
    assert.equal(decision.action, "stop");
    assert.equal(decision.reason, "complete");
    assert.match(decision.detail, /3\/3 tasks across 1 feature\(s\)/);

    const history = cfg(dir).gateHistory;
    const phases = new Set(history.map((h) => h.phase));
    for (const p of ["define", "plan", "build", "verify", "review", "ship"]) {
      assert.ok(phases.has(p), `gate history records ${p}`);
    }
    assert.ok(
      history.some((h) => h.result === "fail") && history.some((h) => h.result === "pass"),
      "the history is honest about both verdicts",
    );
    assert.ok(history.every((h) => !Number.isNaN(Date.parse(h.timestamp))), "every entry is timestamped");
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 2 — continuous-run convergence
// ═══════════════════════════════════════════════════════════════════════════

/** Everything a full pipeline asks for, already true. Nothing left to do but walk. */
function mkSatisfiableProject(prefix, mutate = () => {}) {
  const dir = mkProject(prefix, (c) => {
    c.currentPhase = "define";
    c.currentRole = "planner";
    c.commands.lint = "exit 0";
    c.commands.test = "exit 0";
    mutate(c);
  });

  writePlanFile(dir, {
    version: "2.0",
    baseRevision: 3,
    goals: [{ id: "goal-001", title: "Converge without a human" }],
    sprints: [],
    features: [
      {
        id: "feature-001",
        name: "Reconciler",
        passes: true,
        criteria: ["the ledger balances"],
        tasks: [
          { id: "task-001", key: "feature-001/task-001", description: "read the ledger", status: "complete", dependsOn: [], subtasks: [] },
          { id: "task-002", key: "feature-001/task-002", description: "balance the ledger", status: "complete", dependsOn: ["feature-001/task-001"], subtasks: [] },
        ],
      },
    ],
  });

  put(dir, "src/index.js", "export const balance = (rows) => rows.reduce((n, r) => n + r.amount, 0);\n");
  put(dir, "README.md", `# Reconciler\n\n${prose(260)}\n`);
  put(dir, "CHANGELOG.md", `# Changelog\n\n## 1.0.0\n\n${prose(140)}\n`);
  put(dir, "LICENSE", "MIT License\n\nPermission is hereby granted, free of charge...\n");
  put(dir, "harness/evaluator-rubric.md", `# Rubric\n\n${prose(140)}\n`);
  put(dir, "harness/docs/ARCHITECTURE.md", `# Architecture\n\n${prose(260)}\n`);
  put(dir, "harness/docs/DECISIONS.md", `# Decisions\n\n${prose(140)}\n`);
  gitCommitAll(dir, "feat: a project that is already finished");
  git(dir, ["tag", "-a", "v1.0.0", "-m", "release"]);
  return dir;
}

async function scenarioConvergence() {
  const dir = mkSatisfiableProject("converge");
  const runId = "converge-" + randomUUID();
  const seen = [];

  await step("decideNext walks define → ship and stops on its own", async () => {
    for (let i = 0; i < 25; i++) {
      const { decision } = await decideNext({ targetDir: dir, runId });
      seen.push(decision.action === "advanced" ? `advanced:${decision.toPhase}` : `${decision.action}:${decision.reason}`);
      if (decision.action === "stop") break;
      assert.notEqual(decision.action, "wait", `the loop stalled: ${JSON.stringify(decision)}`);
    }
    note(seen.join(" → "));
    assert.deepEqual(seen, [
      "advanced:plan",
      "advanced:build",
      "advanced:verify",
      "advanced:review",
      "advanced:ship",
      "stop:complete",
    ]);
    assert.equal(cfg(dir).currentPhase, "ship");
    assert.equal(cfg(dir).paused, false);
  });

  await step("the loop-state file records the run honestly", async () => {
    const state = JSON.parse(readFileSync(loopStatePath(dir), "utf-8"));
    assert.equal(state.runId, runId);
    assert.equal(state.iterations, seen.length, "every decision is counted, none invented");
    assert.equal(state.lastDecision, "stop");
    assert.equal(state.stopReason, "complete");
    assert.ok(state.stoppedAt && !Number.isNaN(Date.parse(state.stoppedAt)));
    assert.ok(!Number.isNaN(Date.parse(state.startedAt)));
    assert.ok(Date.parse(state.stoppedAt) >= Date.parse(state.startedAt));
    assert.equal(state.lastPhase, "ship");
    assert.equal(state.noProgressStreak, 0, "a run that kept advancing never stalled");
    // A run that ended by advancing off the end of the pipeline holds no
    // baseline: each advance clears it so the first failure of the next phase
    // is not read as a stall against a fingerprint taken before the agent was
    // asked to do anything.
    assert.ok(
      state.lastFingerprint === null || /^[0-9a-f]{16}$/.test(state.lastFingerprint),
      `lastFingerprint should be null or a hash, got ${JSON.stringify(state.lastFingerprint)}`,
    );
  });

  await step("a finished run stays finished when the loop is asked again", async () => {
    const before = JSON.parse(readFileSync(loopStatePath(dir), "utf-8"));
    const { decision } = await decideNext({ targetDir: dir, runId });
    assert.equal(decision.action, "stop");
    assert.equal(decision.reason, "complete");
    assert.equal(cfg(dir).currentPhase, "ship", "no phase moved after the stop");
    const after = JSON.parse(readFileSync(loopStatePath(dir), "utf-8"));
    assert.equal(after.iterations, before.iterations + 1);
    assert.equal(after.stopReason, "complete");
  });

  await step("a new run id starts a fresh budget rather than inheriting one", async () => {
    const other = "converge-second-" + randomUUID();
    await decideNext({ targetDir: dir, runId: other });
    const state = JSON.parse(readFileSync(loopStatePath(dir), "utf-8"));
    assert.equal(state.runId, other);
    assert.equal(state.iterations, 1);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 3 — every stop condition, driven from real state
// ═══════════════════════════════════════════════════════════════════════════

function mkStopProject(prefix, mutate = () => {}) {
  const dir = mkProject(prefix, (c) => {
    c.currentPhase = "build";
    c.currentRole = "generator";
    mutate(c);
  });
  writePlanFile(dir, {
    version: "2.0",
    baseRevision: 1,
    goals: [{ id: "goal-001", title: "Stop safely" }],
    sprints: [],
    features: [
      {
        id: "feature-001",
        name: "Guards",
        criteria: ["stops with a reason"],
        tasks: [{ id: "task-001", key: "feature-001/task-001", description: "keep going", status: "pending", dependsOn: [], subtasks: [] }],
      },
    ],
  });
  return dir;
}

async function scenarioStops() {
  await step("stop-file: the human brake outranks everything and holds", async () => {
    const dir = mkStopProject("stop-file");
    writeFileSync(stopFilePath(dir), "", "utf-8");
    const runId = "stops-file";
    const first = await decideNext({ targetDir: dir, runId });
    assert.equal(first.decision.action, "stop");
    assert.equal(first.decision.reason, "stop-file");
    assert.match(first.decision.detail, /harness\/STOP exists — delete it to resume/);
    assert.equal(cfg(dir).gateHistory.length, 0, "the loop stopped before doing any work");

    const second = await decideNext({ targetDir: dir, runId });
    assert.equal(second.decision.reason, "stop-file", "it does not continue past the stop");
    assert.equal(cfg(dir).currentPhase, "build", "nothing advanced");

    rmSync(stopFilePath(dir));
    const resumed = await decideNext({ targetDir: dir, runId });
    assert.notEqual(resumed.decision.reason, "stop-file", "deleting the file resumes the run");
  });

  await step("paused: the loop waits, and never advances while it waits", async () => {
    const dir = mkStopProject("stop-paused", (c) => {
      c.paused = true;
    });
    const runId = "stops-paused";
    for (let i = 0; i < 3; i++) {
      const { decision, state } = await decideNext({ targetDir: dir, runId });
      assert.equal(decision.action, "wait", "a pause is resumable, so it waits rather than stops");
      assert.equal(decision.reason, "paused");
      assert.match(decision.detail, /paused/i);
      assert.equal(state.stopReason, null);
    }
    assert.equal(cfg(dir).currentPhase, "build");
    assert.equal(cfg(dir).gateHistory.length, 0, "a paused loop runs no gates");
  });

  await step("retry budget: an impossible task ends the run instead of eating it", async () => {
    const dir = mkStopProject("stop-retry", (c) => {
      c.maxRetries = 4;
      c.taskRetryCount = 4;
    });
    const runId = "stops-retry";
    const eff = getRetryConfig(cfg(dir));
    assert.equal(eff.tasks.enabled, true);
    assert.equal(eff.tasks.max, 4);

    const first = await decideNext({ targetDir: dir, runId });
    assert.equal(first.decision.action, "stop");
    assert.equal(first.decision.reason, "retry-budget");
    assert.match(first.decision.detail, /The task retry budget is exhausted/);
    assert.equal(cfg(dir).gateHistory.length, 0);

    const second = await decideNext({ targetDir: dir, runId });
    assert.equal(second.decision.reason, "retry-budget");
    assert.equal(cfg(dir).currentPhase, "build");
  });

  await step("max-iterations: a runaway loop under the clock still ends", async () => {
    const dir = mkStopProject("stop-iters", (c) => {
      c.loop = { maxIterations: 6 };
    });
    const runId = "stops-iters";
    saveLoopState(dir, { ...newLoopState(runId), iterations: 6 });
    const { decision, state } = await decideNext({ targetDir: dir, runId });
    assert.equal(decision.action, "stop");
    assert.equal(decision.reason, "max-iterations");
    assert.match(decision.detail, /Reached the 6-iteration ceiling/);
    assert.equal(state.iterations, 7, "the tripping iteration is still counted");
    assert.equal(cfg(dir).gateHistory.length, 0);

    const again = await decideNext({ targetDir: dir, runId });
    assert.equal(again.decision.reason, "max-iterations");
  });

  await step("max-wall-clock: a run you forgot about ends on its own", async () => {
    const dir = mkStopProject("stop-clock", (c) => {
      c.loop = { maxWallClockMs: 30 * 60 * 1000 };
    });
    const runId = "stops-clock";
    saveLoopState(dir, newLoopState(runId, new Date(Date.now() - 3 * 60 * 60 * 1000)));
    const { decision } = await decideNext({ targetDir: dir, runId });
    assert.equal(decision.action, "stop");
    assert.equal(decision.reason, "max-wall-clock");
    assert.match(decision.detail, /Run exceeded its 0\.5h wall-clock budget/);
    assert.equal(cfg(dir).gateHistory.length, 0);

    const again = await decideNext({ targetDir: dir, runId });
    assert.equal(again.decision.reason, "max-wall-clock");
  });

  await step("no-progress: a failing gate against a frozen tree is spinning, not working", async () => {
    const dir = mkStopProject("stop-spin", (c) => {
      c.commands.test = "exit 1";
      c.loop = { noProgressLimit: 3 };
    });
    const runId = "stops-spin";

    // `skipEscalation` throughout: this leg is about the guard that ends a
    // spinning run. The escalation ladder deliberately interrupts a stall to
    // try something else first, and it has its own scenario.

    const first = await decideNext({ targetDir: dir, runId, skipEscalation: true });
    assert.equal(first.decision.action, "continue", "the first failure has no baseline to compare against");
    assert.equal(first.state.noProgressStreak, 0);

    const second = await decideNext({ targetDir: dir, runId, skipEscalation: true });
    assert.equal(second.state.noProgressStreak, 1);
    assert.equal(second.state.lastFingerprint, first.state.lastFingerprint, "the tree really did not move");

    const third = await decideNext({ targetDir: dir, runId, skipEscalation: true });
    assert.equal(third.state.noProgressStreak, 2);

    const fourth = await decideNext({ targetDir: dir, runId, skipEscalation: true });
    assert.equal(fourth.decision.action, "stop");
    assert.equal(fourth.decision.reason, "no-progress");
    assert.match(fourth.decision.detail, /failed 3 times in a row with no change to the working tree/);
    assert.match(fourth.decision.detail, /looping without making progress: tests/);
    assert.equal(cfg(dir).currentPhase, "build", "a stuck loop never advanced the phase");
    assert.ok(cfg(dir).phaseRetryCount >= 2, "failing iterations charge the phase budget");

    const fifth = await decideNext({ targetDir: dir, runId, skipEscalation: true });
    assert.equal(fifth.decision.reason, "no-progress", "it does not continue past the stop");

    // Real work resets the streak — the guard catches stalling, not slowness.
    put(dir, "src/fix.js", "export const fixed = true;\n");
    const moved = await decideNext({ targetDir: dir, runId, skipEscalation: true });
    assert.equal(moved.decision.action, "continue");
    assert.equal(moved.state.noProgressStreak, 0);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 4 — crash and restart
// ═══════════════════════════════════════════════════════════════════════════

async function scenarioCrash() {
  const dir = mkProject("crash");
  writePlanFile(dir, {
    version: "2.0",
    baseRevision: 0,
    goals: [{ id: "goal-001", title: "Survive a kill -9" }],
    sprints: [],
    features: [{ id: "feature-001", name: "Ledger", passes: false, criteria: ["survives a crash"], tasks: [] }],
  });

  const runnerDir = mkTempDir("crash-runner");
  const victimScript = writeRunner(runnerDir, "victim.mjs", CRASH_VICTIM);

  let victim;
  await step("a real child process drives the harness into BUILD, then is SIGKILLed mid-phase", async () => {
    victim = spawnChild(victimScript, [dir]);
    const ready = await Promise.race([
      new Promise((res) => {
        const t = setInterval(() => {
          if (victim.stdout.includes("READY")) {
            clearInterval(t);
            res(true);
          }
        }, 20);
        setTimeout(() => {
          clearInterval(t);
          res(false);
        }, 20_000);
      }),
      victim.done.then(() => false),
    ]);
    assert.equal(ready, true, `child never reached READY: ${victim.stderr}`);

    victim.child.kill("SIGKILL");
    const exit = await victim.done;
    assert.equal(exit.signal, "SIGKILL", "the flow really was killed, not asked politely");
  });

  await step("reloading from disk resumes with the plan and the phase intact", async () => {
    const c = cfg(dir);
    assert.equal(c.currentPhase, "build", "the phase survived the crash");
    assert.equal(c.currentRole, "generator");

    const list = planOf(dir);
    assert.equal(list.baseRevision, 1);
    const tasks = flattenTasks(list);
    assert.equal(tasks.length, 2);
    assert.deepEqual(
      tasks.map((t) => `${t.compositeKey}:${t.status}`),
      ["feature-001/task-001:complete", "feature-001/task-002:in_progress"],
    );
    assert.equal(tasks[0].difficulty, "moderate", "task metadata survived");
    assert.deepEqual(tasks[0].criteria, ["reconciles split tenders"]);
    assert.equal(tasks[1].modelHint, "big-model");

    const b = await buildBrief(dir);
    assert.equal(b.phase, "build");
    assert.equal(b.task.key, "feature-001/task-002", "the brief picks up exactly where the crash left off");
    assert.equal(b.progress.tasksDone, 1);
    assert.equal(b.progress.tasksTotal, 2);
    assert.match(renderBrief(b, cfg(dir)), /NEXT STEP · BUILD/);
  });

  await step("a lock left behind by a dead process does not deadlock the next writer", async () => {
    assert.equal(existsSync(featureListPath(dir) + ".lock"), true, "the crashed holder left its lock");

    const t0 = Date.now();
    const { value: result, locked } = await withLock(featureListPath(dir), () =>
      writeTaskList(dir, {
        baseRevision: revisionOf(dir),
        tasks: [
          { key: "feature-001/task-001", subject: "wire the ledger reconciler", status: "complete" },
          { key: "feature-001/task-002", subject: "emit the refund webhook", status: "complete", dependsOn: ["feature-001/task-001"] },
        ],
      }),
    );
    note(`lock contention resolved in ${Date.now() - t0}ms (locked=${locked})`);
    assert.equal(locked, false, "the crashed holder's lock could not be taken");
    assert.equal(result.revision, 2, "the write proceeds unlocked rather than deadlocking the run");
    assert.equal(computeProgress(planOf(dir)).tasksDone, 2);
  });

  await step("a corrupt plan recovers the previous good revision from .bak", async () => {
    const fresh = mkProject("crash-bak");
    writePlanFile(fresh, {
      version: "2.0",
      baseRevision: 0,
      goals: [],
      sprints: [],
      features: [{ id: "feature-001", name: "F", passes: false, criteria: ["c"], tasks: [] }],
    });

    writeTaskList(fresh, {
      baseRevision: 0,
      tasks: [{ key: "feature-001/task-001", subject: "the good revision", status: "pending", difficulty: "easy" }],
    });
    writeTaskList(fresh, {
      baseRevision: 1,
      tasks: [
        { key: "feature-001/task-001", subject: "the good revision", status: "pending" },
        { key: "feature-001/task-002", subject: "the newest revision", status: "pending" },
      ],
    });
    assert.equal(revisionOf(fresh), 2);
    assert.equal(existsSync(featureListPath(fresh) + ".bak"), true);

    writeFileSync(featureListPath(fresh), '{"features": [ this is not json', "utf-8");

    const { list, existed } = loadFeatureList(fresh);
    assert.equal(existed, true);
    assert.equal(list.baseRevision, 1, "the .bak holds the revision before the corrupt write");
    const tasks = flattenTasks(list);
    assert.equal(tasks.length, 1, "the previous good plan came back, not an empty one");
    assert.equal(tasks[0].description, "the good revision");
    assert.equal(tasks[0].difficulty, "easy");

    // …and with no backup at all, an empty plan is the documented fallback.
    const bare = mkProject("crash-nobak");
    writeFileSync(featureListPath(bare), "}{ garbage", "utf-8");
    const bareLoad = loadFeatureList(bare);
    assert.equal(bareLoad.existed, true);
    assert.deepEqual(bareLoad.list.features, []);
    assert.equal(bareLoad.list.baseRevision, 0);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 5 — concurrency
// ═══════════════════════════════════════════════════════════════════════════

const WRITERS = 6;

function seedFanOutPlan(dir, n, startRevision) {
  const tasks = Array.from({ length: n }, (_, i) => ({
    id: `task-${i + 1}`,
    key: `feature-001/task-${i + 1}`,
    description: `original description ${i + 1}`,
    status: "pending",
    dependsOn: [],
    subtasks: [],
    owner: `worker-${i + 1}`,
  }));
  writePlanFile(dir, {
    version: "2.0",
    baseRevision: startRevision,
    goals: [{ id: "goal-001", title: "Parallel workers cannot corrupt the plan" }],
    sprints: [],
    features: [{ id: "feature-001", name: "Fan-out", passes: false, criteria: ["no lost updates"], tasks }],
  });
  return tasks;
}

/** Run `n` writers at once while watching the file the whole time. */
async function fanOut(dir, script, n) {
  const poll = { reads: 0, parseFailures: 0, revisions: [] };
  let polling = true;
  const poller = (async () => {
    while (polling) {
      try {
        const parsed = JSON.parse(readFileSync(featureListPath(dir), "utf-8"));
        poll.reads += 1;
        poll.revisions.push(parsed.baseRevision);
      } catch (e) {
        if (e instanceof SyntaxError) poll.parseFailures += 1;
      }
      await new Promise((r) => setTimeout(r, 1));
    }
  })();

  const children = Array.from({ length: n }, (_, i) =>
    spawnChild(script, [dir, `feature-001/task-${i + 1}`, `claimed by worker ${i + 1}`]),
  );
  const finished = await Promise.all(children.map((c) => c.done));
  polling = false;
  await poller;

  const results = finished.map((f, i) => {
    assert.equal(f.code, 0, `writer ${i + 1} exited ${f.code}: ${f.stderr}`);
    return JSON.parse(f.stdout);
  });
  return { results, poll };
}

function lostUpdates(dir, n) {
  const final = flattenTasks(planOf(dir));
  const lost = [];
  for (let i = 0; i < n; i++) {
    const t = final.find((x) => x.compositeKey === `feature-001/task-${i + 1}`);
    if (!t || t.description !== `claimed by worker ${i + 1}`) lost.push(`task-${i + 1}`);
  }
  return lost;
}

async function scenarioConcurrency() {
  const dir = mkProject("concurrency");
  seedFanOutPlan(dir, WRITERS, 10);

  const startRevision = revisionOf(dir);
  const runnerDir = mkTempDir("conc-runner");
  const writerScript = writeRunner(runnerDir, "writer.mjs", CONCURRENT_WRITER);
  const unlockedScript = writeRunner(runnerDir, "unlocked.mjs", UNLOCKED_WRITER);

  let results = [];
  let poll = { reads: 0, parseFailures: 0, revisions: [] };

  await step(`${WRITERS} real child processes write the same plan at the same time`, async () => {
    ({ results, poll } = await fanOut(dir, writerScript, WRITERS));
    const failed = results.filter((r) => r.error !== null);
    assert.deepEqual(failed, [], "every writer eventually landed its edit");
    assert.equal(
      results.reduce((n, r) => n + r.lockedCount, 0),
      WRITERS,
      "a writer wrote without the lock — every guarantee below rests on holding it",
    );
    note(
      `stale rejections observed: ${results.reduce((n, r) => n + r.stale, 0)}; ` +
        `lock acquisitions: ${results.reduce((n, r) => n + r.lockedCount, 0)}/${WRITERS}`,
    );
  });

  await step("no lost updates: every writer's edit is present in the final plan", async () => {
    const final = flattenTasks(planOf(dir));
    assert.equal(final.length, WRITERS);
    assert.deepEqual(lostUpdates(dir, WRITERS), [], "an edit went missing under the lock");
    for (let i = 0; i < WRITERS; i++) {
      const t = final.find((x) => x.compositeKey === `feature-001/task-${i + 1}`);
      assert.equal(t.owner, `worker-${i + 1}`, "an unknown field survived the whole fan-out");
    }
  });

  await step("baseRevision is monotonic: one bump per landed write, no reuse", async () => {
    const landed = results.flatMap((r) => r.revisions).sort((a, b) => a - b);
    assert.equal(landed.length, WRITERS);
    assert.deepEqual(
      landed,
      Array.from({ length: WRITERS }, (_, i) => startRevision + 1 + i),
      "revisions are exactly startRevision+1..+N — no two writers shared one",
    );
    assert.equal(revisionOf(dir), startRevision + WRITERS);

    for (let i = 1; i < poll.revisions.length; i++) {
      assert.ok(
        poll.revisions[i] >= poll.revisions[i - 1],
        `the revision went backwards on disk: ${poll.revisions[i - 1]} → ${poll.revisions[i]}`,
      );
    }
  });

  await step("the plan file is valid JSON at every instant, not just at the end", async () => {
    assert.ok(poll.reads > 20, `the poller only managed ${poll.reads} reads`);
    assert.equal(poll.parseFailures, 0, "an atomic write is never observed half-finished");
    assert.doesNotThrow(() => JSON.parse(readFileSync(featureListPath(dir), "utf-8")));
  });

  await step("a stale revision is rejected, never silently applied", async () => {
    const before = readFileSync(featureListPath(dir), "utf-8");
    const stale = revisionOf(dir) - 3;
    assert.throws(
      () =>
        writeTaskList(dir, {
          baseRevision: stale,
          tasks: [{ key: "feature-001/task-1", subject: "clobbered by a stale writer", status: "pending" }],
        }),
      (e) => {
        assert.equal(e.name, "ValidationError");
        assert.match(e.message, new RegExp(`stale baseRevision: you sent ${stale}, the plan is at ${revisionOf(dir)}`));
        assert.match(e.message, /Re-read the plan and resubmit/);
        return true;
      },
    );
    assert.equal(readFileSync(featureListPath(dir), "utf-8"), before, "the rejected write touched nothing");

    // The same submission with the current revision is accepted — proving the
    // rejection was about staleness, not about the payload.
    const okWrite = writeTaskList(dir, {
      baseRevision: revisionOf(dir),
      tasks: flattenTasks(planOf(dir)).map((t) => ({
        key: t.compositeKey,
        subject: t.compositeKey === "feature-001/task-1" ? "accepted at the current revision" : t.description,
        status: t.status,
      })),
    });
    assert.equal(okWrite.revision, startRevision + WRITERS + 1);
  });

  /**
   * The control experiment.
   *
   * `writeTaskList` now takes an exclusive lock across the whole
   * read-apply-write. To show that the lock is what makes the fan-out safe —
   * rather than luck, or `baseRevision` doing more than it can — this runs the
   * same six writers against the primitives composed by hand, with no lock.
   *
   * The race outcome itself is timing-dependent, so it is measured and
   * reported rather than asserted. What IS asserted is the contrast: the
   * locked path above lost nothing, and any loss here is attributable to the
   * missing lock alone, since every other ingredient is identical.
   */
  await step("the lock is load-bearing: the same fan-out composed by hand can lose updates", async () => {
    const bare = mkProject("concurrency-unlocked");
    seedFanOutPlan(bare, WRITERS, 10);
    const { results: raw, poll: bpoll } = await fanOut(bare, unlockedScript, WRITERS);

    assert.deepEqual(raw.filter((r) => r.error !== null), [], "every unlocked writer still reported success");
    assert.equal(bpoll.parseFailures, 0, "a single write is atomic with or without the lock");
    assert.ok(revisionOf(bare) <= 10 + WRITERS, "an unlocked run can lose revisions but never invent them");

    const lost = lostUpdates(bare, WRITERS);
    const landed = raw.flatMap((r) => r.revisions);
    const reused = landed.length - new Set(landed).size;
    let regressions = 0;
    for (let i = 1; i < bpoll.revisions.length; i++) {
      if (bpoll.revisions[i] < bpoll.revisions[i - 1]) regressions += 1;
    }

    if (lost.length || reused || regressions) {
      warn(
        `unlocked: lost ${lost.length}/${WRITERS} update(s), ${reused} duplicate revision(s), ` +
          `${regressions} backwards step(s) — the locked path above lost none of these`,
      );
    } else {
      warn(`unlocked: this run did not interleave — the race is timing-dependent, the lock is not`);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 6 — data preservation under round-trip
// ═══════════════════════════════════════════════════════════════════════════

async function scenarioRoundTrip() {
  const dir = mkProject("roundtrip");

  const exotic = {
    difficulty: "difficult",
    modelHint: "some-large-model",
    criteria: ["handles ¥ and €", 'quotes: "double" and \'single\''],
    // Fields no version of the harness knows about. They must still be here
    // at the end: this regression cost a plan once.
    owner: "alice",
    estimateHours: 13.5,
    labels: ["payments", "risk"],
    provenance: { source: "spec.md#L42", addedBy: "planner", nested: { deep: true } },
    "weird.key-name": "kept",
  };

  writePlanFile(dir, {
    version: "2.0",
    baseRevision: 5,
    goals: [{ id: "goal-001", title: "Nothing is silently dropped" }],
    sprints: [{ id: "sprint-001", name: "S1", goalId: "goal-001" }],
    features: [
      {
        id: "feature-001",
        name: "Preservation",
        passes: false,
        criteria: ["fields survive"],
        sprintId: "sprint-001",
        tasks: [
          {
            id: "task-001",
            key: "feature-001/task-001",
            description: "carry every field through",
            status: "pending",
            dependsOn: [],
            subtasks: [{ id: "st-1", title: "keep unknown keys", status: "pending" }],
            ...exotic,
          },
          {
            id: "task-002",
            key: "feature-001/task-002",
            description: "a plain neighbour",
            status: "pending",
            dependsOn: [],
            subtasks: [],
          },
        ],
      },
    ],
  });

  const assertExotic = (where) => {
    const t = findTask(planOf(dir), "feature-001/task-001").task;
    for (const [k, v] of Object.entries(exotic)) {
      assert.deepEqual(t[k], v, `${where}: field "${k}" was lost or altered`);
    }
    return t;
  };

  await step("a minimal edit that never mentions the extras keeps all of them", async () => {
    const r = writeTaskList(dir, {
      baseRevision: 5,
      tasks: [
        { key: "feature-001/task-001", status: "in_progress" },
        { key: "feature-001/task-002", status: "pending" },
      ],
    });
    assert.equal(r.revision, 6);
    const t = assertExotic("status-only edit");
    assert.equal(t.status, "in_progress");
    assert.equal(t.description, "carry every field through", "the subject came from the stored task");
  });

  await step("reordering, renaming and adding tasks does not disturb the extras", async () => {
    submit(dir, (tasks) => [
      { key: "feature-001/task-002", subject: "a plain neighbour, reworded", status: "pending" },
      ...tasks.filter((t) => t.key === "feature-001/task-001"),
      { key: "feature-001/task-003", subject: "a brand new task", status: "pending" },
    ]);
    assert.equal(revisionOf(dir), 7);
    assert.deepEqual(
      flattenTasks(planOf(dir)).map((t) => t.compositeKey),
      ["feature-001/task-002", "feature-001/task-001", "feature-001/task-003"],
    );
    assertExotic("after reorder");
  });

  await step("deleting a neighbour by omission does not take the extras with it", async () => {
    writeTaskList(dir, {
      baseRevision: revisionOf(dir),
      tasks: [
        { key: "feature-001/task-001", status: "in_progress" },
        { key: "feature-001/task-003", subject: "a brand new task", status: "pending" },
      ],
    });
    const keys = flattenTasks(planOf(dir)).map((t) => t.compositeKey);
    assert.deepEqual(keys, ["feature-001/task-001", "feature-001/task-003"], "omission means deletion");
    assertExotic("after deletion by omission");
  });

  await step("subtasks survive when unmentioned and are replaced when submitted", async () => {
    let t = findTask(planOf(dir), "feature-001/task-001").task;
    assert.equal(t.subtasks.length, 1);
    assert.equal(t.subtasks[0].title, "keep unknown keys");

    writeTaskList(dir, {
      baseRevision: revisionOf(dir),
      tasks: [
        {
          key: "feature-001/task-001",
          status: "in_progress",
          subtasks: [
            { title: "precedence table", status: "complete" },
            { title: "audit log entries", status: "pending" },
          ],
        },
        { key: "feature-001/task-003", subject: "a brand new task", status: "pending" },
      ],
    });
    t = assertExotic("after a subtask rewrite");
    assert.deepEqual(
      t.subtasks.map((s) => `${s.title}:${s.status}`),
      ["precedence table:complete", "audit log entries:pending"],
    );
  });

  await step("an explicit new value replaces the old one — preservation is not stickiness", async () => {
    writeTaskList(dir, {
      baseRevision: revisionOf(dir),
      tasks: [
        { key: "feature-001/task-001", status: "in_progress", difficulty: "easy", modelHint: "small", criteria: ["replaced"] },
        { key: "feature-001/task-003", subject: "a brand new task", status: "pending" },
      ],
    });
    const t = findTask(planOf(dir), "feature-001/task-001").task;
    assert.equal(t.difficulty, "easy");
    assert.equal(t.modelHint, "small");
    assert.deepEqual(t.criteria, ["replaced"]);
    assert.equal(t.owner, "alice", "the fields nobody mentioned are still untouched");
    assert.deepEqual(t.provenance, exotic.provenance);
    assert.equal(t["weird.key-name"], "kept");
  });

  await step("feature and list metadata outside the tasks is preserved too", async () => {
    const list = planOf(dir);
    assert.equal(list.version, "2.0");
    assert.deepEqual(list.sprints, [{ id: "sprint-001", name: "S1", goalId: "goal-001" }]);
    assert.deepEqual(list.goals, [{ id: "goal-001", title: "Nothing is silently dropped" }]);
    assert.equal(list.features[0].sprintId, "sprint-001");
    assert.deepEqual(list.features[0].criteria, ["fields survive"]);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 7 — the dashboard, end to end
// ═══════════════════════════════════════════════════════════════════════════

const LIVE_TASK_TEXT = 'reconcile <script>alert("xss")</script> & the "nightly" ledger — 日本語 🚀';

async function scenarioDashboard() {
  const dir = mkProject("dashboard", (c) => {
    c.currentPhase = "build";
    c.currentRole = "generator";
    c.taskRetryCount = 3;
    c.gateHistory = [
      { phase: "plan", result: "pass", timestamp: new Date(Date.now() - 60_000).toISOString() },
      { phase: "build", result: "fail", timestamp: new Date().toISOString(), feature: "feature-001", task: "feature-001/task-002" },
    ];
  });

  writePlanFile(dir, {
    version: "2.0",
    baseRevision: 42,
    goals: [{ id: "goal-001", title: "Watch the run from a browser" }],
    sprints: [],
    features: [
      {
        id: "feature-001",
        name: "Nightly reconciliation",
        passes: false,
        criteria: ["the ledger balances"],
        tasks: [
          { id: "task-001", key: "feature-001/task-001", description: "read the ledger", status: "complete", dependsOn: [], subtasks: [] },
          { id: "task-002", key: "feature-001/task-002", description: LIVE_TASK_TEXT, status: "in_progress", dependsOn: ["feature-001/task-001"], subtasks: [{ id: "s1", title: "cover partial captures", status: "pending" }] },
        ],
      },
    ],
  });

  const before = { config: sha(configPath(dir)), plan: sha(featureListPath(dir)) };
  let server;

  await step("the server binds to loopback on an ephemeral port", async () => {
    server = await createRemoteServer({ projectDir: dir, host: "127.0.0.1", port: 0 });
    SERVERS.add(server);
    assert.equal(server.host, "127.0.0.1");
    assert.ok(server.port > 0);
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    note(server.url);
  });

  await step("GET / serves the live plan behind a tight CSP", async () => {
    const res = await fetch(server.url + "/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/html; charset=utf-8$/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("cache-control"), "no-store");

    const csp = res.headers.get("content-security-policy");
    assert.ok(csp, "the page ships a CSP");
    assert.match(csp, /default-src 'none'/);
    assert.ok(!/script-src[^;]*https?:/.test(csp), "no remote script origin is allowed");

    const html = await res.text();
    assert.match(html, /^<!doctype html>/);
    assert.ok(html.includes("Nightly reconciliation"), "the feature name is on the page");
    assert.ok(html.includes("Watch the run from a browser"), "the goal is on the page");
    assert.ok(html.includes("日本語"), "the live task text is rendered, unicode and all");
    assert.ok(html.includes("🚀"));
    assert.ok(
      html.includes("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"),
      "model-authored text is escaped, not executed",
    );
    assert.ok(!html.includes('<script>alert("xss")'), "the raw tag never reaches the document");
  });

  await step("GET /api/harness returns the plan as JSON", async () => {
    const res = await fetch(server.url + "/api/harness");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    const body = await res.json();
    assert.equal(body.baseRevision, 42);
    assert.equal(body.phase, "build");
    assert.equal(body.paused, false);
    assert.deepEqual(body.progress, {
      tasksDone: 1,
      tasksTotal: 2,
      featuresDone: 0,
      featuresTotal: 1,
      blocked: 0,
      inProgress: 1,
      rework: 0,
      percent: 50,
    });
    assert.deepEqual(body.retries, { task: 3, max: 10 });
    assert.equal(body.features[0].tasks[1].description, LIVE_TASK_TEXT, "JSON carries the text verbatim");
    assert.deepEqual(body.features[0].tasks[1].dependsOn, ["feature-001/task-001"]);
    assert.equal(body.gate.phase, "build");
    assert.equal(body.gate.overall, false, "the last recorded verdict is reported");
    assert.equal(body.goals[0].title, "Watch the run from a browser");
  });

  await step("GET /api/health answers, unknown paths 404, and writes are refused 405", async () => {
    const health = await fetch(server.url + "/api/health");
    assert.equal(health.status, 200);
    const hb = await health.json();
    assert.equal(hb.ok, true);
    assert.ok(!Number.isNaN(Date.parse(hb.timestamp)));

    const missing = await fetch(server.url + "/does/not/exist");
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), "not found");

    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await fetch(server.url + "/api/harness", {
        method,
        body: method === "DELETE" ? undefined : JSON.stringify({ baseRevision: 0, tasks: [] }),
        headers: { "content-type": "application/json" },
      });
      assert.equal(res.status, 405, `${method} should be refused`);
      assert.equal(res.headers.get("allow"), "GET, HEAD");
    }

    const head = await fetch(server.url + "/", { method: "HEAD" });
    assert.equal(head.status, 200);
  });

  await step("read-only means read-only: the state files are byte-identical afterwards", async () => {
    for (const path of ["/", "/api/harness", "/api/health", "/nope", "/api/harness?x=1"]) {
      await fetch(server.url + path);
    }
    assert.equal(sha(configPath(dir)), before.config, "harness/config.json changed while the dashboard was open");
    assert.equal(sha(featureListPath(dir)), before.plan, "the plan changed while the dashboard was open");
    assert.equal(revisionOf(dir), 42, "opening the dashboard never bumps baseRevision");
    assert.equal(existsSync(featureListPath(dir) + ".bak"), false, "nothing wrote, so nothing was backed up");
  });

  await step("a non-loopback bind is refused unless it is asked for explicitly", async () => {
    const saved = process.env.INFINITY_HARNESS_ALLOW_REMOTE;
    delete process.env.INFINITY_HARNESS_ALLOW_REMOTE;
    try {
      await assert.rejects(
        () => createRemoteServer({ projectDir: dir, host: "0.0.0.0", port: 0 }),
        /refusing to bind the dashboard to 0\.0\.0\.0/,
      );
    } finally {
      if (saved !== undefined) process.env.INFINITY_HARNESS_ALLOW_REMOTE = saved;
    }
  });

  await step("closing the server releases the port", async () => {
    const url = server.url;
    await server.close();
    SERVERS.delete(server);
    await server.close(); // idempotent
    await assert.rejects(() => fetch(url + "/api/health"), "the port is really gone");
  });

  await step("the same view renders offline, straight from disk", async () => {
    const state = buildRemoteState(dir);
    assert.equal(state.baseRevision, 42);
    assert.equal(buildApiPayload(state).progress.percent, 50);
    assert.ok(buildHtml(state).includes("Nightly reconciliation"));
    assert.equal(sha(featureListPath(dir)), before.plan, "building the view is still read-only");
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 8 — widget rendering across shapes
// ═══════════════════════════════════════════════════════════════════════════

const PLAIN = createStyler("none");

function shapePlan(n, { descChars = 44, cjk = false, activeAt = 2 } = {}) {
  const body = cjk
    ? "検証：カート合計とカタログ価格の照合 🧾 партии 日本語テキスト "
    : "validate cart totals against catalogue prices and stacked discounts ";
  const desc = body.repeat(Math.ceil(descChars / body.length) + 1).slice(0, descChars);
  const statusFor = (i) => {
    if (i < activeAt) return "complete";
    if (i === activeAt) return "in_progress";
    if (i === activeAt + 1) return "blocked";
    if (i === activeAt + 2) return "rework";
    return "pending";
  };
  return {
    version: "2.0",
    baseRevision: 7,
    goals: [{ id: "goal-001", title: cjk ? "決済リライトを機能フラグの背後で出荷する 🚀" : "Ship the payments rewrite behind a flag" }],
    sprints: [],
    features: [
      {
        id: "feature-001",
        name: cjk ? "チェックアウト 💳" : "Checkout flow",
        passes: false,
        tasks: Array.from({ length: n }, (_, i) => ({
          id: `task-${i + 1}`,
          key: `task-${i + 1}`,
          description: `${desc} #${i + 1}`,
          status: statusFor(i),
          dependsOn: i > 0 ? [`task-${i}`] : [],
          subtasks:
            i === activeAt
              ? [
                  { id: `st-${i}-a`, title: cjk ? "テンダー分割の単体テスト" : "unit tests for tender split", status: "complete" },
                  { id: `st-${i}-b`, title: "integration test against sandbox", status: "in_progress" },
                ]
              : [],
        })),
      },
    ],
  };
}

const EMPTY_PLAN = { version: "2.0", baseRevision: 0, goals: [], sprints: [], features: [] };

/**
 * Widths at and above the ~58-column floor the README promises. Below 40 the
 * unboxed progress line can overrun; see the report.
 */
const SUPPORTED_WIDTHS = [58, 76, 120];

async function scenarioWidget() {
  const shapes = [
    ["an empty plan", { list: EMPTY_PLAN, phase: null }],
    ["a normal plan", { list: shapePlan(6), phase: "build", revision: 7, retries: { task: 2, max: 10 } }],
    ["a huge plan (120 tasks)", { list: shapePlan(120, { activeAt: 60 }), phase: "build", revision: 7 }],
    ["long task text", { list: shapePlan(3, { descChars: 250 }), phase: "verify" }],
    [
      "CJK and emoji",
      {
        list: shapePlan(7, { cjk: true, descChars: 90 }),
        phase: "build",
        retries: { task: 9, max: 10 },
        gate: { overall: false, failures: ["tests", "lint", "coverage"] },
      },
    ],
    ["a paused run", { list: shapePlan(5), phase: "build", paused: true, revision: 7 }],
    ["a single task with no goal", { list: { ...shapePlan(1), goals: [] }, phase: "ship" }],
  ];

  await step("nothing throws on any shape, at any supported width, in either glyph set", async () => {
    let renders = 0;
    for (const [, state] of shapes) {
      for (const w of SUPPORTED_WIDTHS) {
        for (const glyphs of [UNICODE_GLYPHS, ASCII_GLYPHS]) {
          for (const boxed of [false, true]) {
            const lines = renderWidget(state, { width: w, glyphs, styler: PLAIN, boxed });
            assert.ok(Array.isArray(lines) && lines.length > 0);
            renders += 1;
          }
        }
      }
      assert.equal(typeof renderStatusLine(state, UNICODE_GLYPHS), "string");
      assert.equal(typeof renderStatusLine(state, ASCII_GLYPHS), "string");
    }
    note(`${renders} renders`);
  });

  await step("no rendered line exceeds the requested width, on any shape", async () => {
    for (const [label, state] of shapes) {
      for (const w of SUPPORTED_WIDTHS) {
        for (const glyphs of [UNICODE_GLYPHS, ASCII_GLYPHS]) {
          for (const lines of [
            renderWidget(state, { width: w, glyphs, styler: PLAIN }),
            renderWidget(state, { width: w, glyphs, styler: createStyler("truecolor") }),
          ]) {
            for (const l of lines) {
              assert.ok(
                width(l) <= w,
                `${label} at width ${w}: line is ${width(l)} columns — ${JSON.stringify(stripAnsi(l))}`,
              );
            }
          }
        }
      }
    }
  });

  await step("a boxed widget is exactly the requested width, every line, down to 24 columns", async () => {
    for (const [label, state] of shapes) {
      for (const w of [24, 40, ...SUPPORTED_WIDTHS]) {
        const lines = renderWidget(state, { width: w, glyphs: UNICODE_GLYPHS, styler: PLAIN, boxed: true });
        for (const l of lines) {
          assert.equal(width(l), w, `${label} at boxed width ${w}: ${JSON.stringify(l)}`);
        }
        assert.ok(lines[0].startsWith("╭") && lines[0].endsWith("╮"));
        assert.ok(lines.at(-1).startsWith("╰") && lines.at(-1).endsWith("╯"));
      }
    }
  });

  await step("an empty plan says so instead of drawing an empty frame", async () => {
    const lines = renderWidget({ list: EMPTY_PLAN, phase: null }, { width: 76, styler: PLAIN });
    const joined = lines.join("\n");
    assert.match(joined, /no plan yet/);
    assert.match(joined, /NOT STARTED/);
    assert.match(joined, /0\/0 tasks/);
    assert.equal(renderStatusLine({ list: EMPTY_PLAN, phase: null }, UNICODE_GLYPHS), "idle");
  });

  await step("a huge plan is windowed, with both elisions counted", async () => {
    const plan = shapePlan(120, { activeAt: 60 });
    const lines = renderWidget({ list: plan, phase: "build" }, { width: 76, styler: PLAIN });
    const joined = lines.join("\n");
    assert.match(joined, /⋯ \d+ above/, "rows scrolled off the top are counted");
    assert.match(joined, /⋯ \d+ below/, "rows below the window are counted");
    assert.ok(lines.length < 30, `120 tasks must not render 120 rows (got ${lines.length} lines)`);
    assert.match(joined, /60\/120 tasks/);
    assert.match(joined, /◐ 61 /, "the window is centred on the active task, not on row 1");

    const above = Number(/⋯ (\d+) above/.exec(joined)[1]);
    const below = Number(/⋯ (\d+) below/.exec(joined)[1]);
    // Count rows the way the widget does: subtasks of the active task are part
    // of the window, so a row set built without it would not add up.
    const drawn = buildPlanRows(plan, nextActionableTask(plan)?.compositeKey ?? null).length;
    const shown = drawn - above - below;
    assert.equal(shown, TASK_WINDOW, "exactly one window of plan rows is drawn");
    assert.ok(above > 0 && below > 0, "the plan really scrolled");
    assert.equal(above + shown + below, drawn, "the elisions and the window account for every row");
  });

  await step("the window is scrollable, and clamps at both ends", async () => {
    const plan = shapePlan(120, { activeAt: 60 });
    const rows = buildPlanRows(plan, nextActionableTask(plan)?.compositeKey ?? null).length;

    const top = renderWidget(
      { list: plan, phase: "build", view: { scroll: 0, expanded: false } },
      { width: 76, styler: PLAIN },
    ).join("\n");
    assert.doesNotMatch(top, /above/, "at the top nothing is above");
    assert.match(top, /below/, "at the top there is still more below");

    const bottom = renderWidget(
      { list: plan, phase: "build", view: { scroll: 1e6, expanded: false } },
      { width: 76, styler: PLAIN },
    ).join("\n");
    assert.match(bottom, /above/);
    assert.doesNotMatch(bottom, /below/, "scrolling past the end clamps rather than emptying the widget");

    let view = defaultView();
    view = scrollView(view, SCROLL_STEP, rows, TASK_WINDOW);
    assert.equal(view.scroll, SCROLL_STEP);
    assert.equal(scrollView(view, -1e6, rows, TASK_WINDOW).scroll, 0);
    assert.equal(scrollView(view, 1e6, rows, TASK_WINDOW).scroll, rows - TASK_WINDOW);
  });

  await step("all five plan levels reach the screen", async () => {
    const plan = {
      version: "2.0",
      baseRevision: 3,
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
              dependsOn: [],
              subtasks: [{ id: "s1", title: "handle the BOM", status: "pending" }],
            },
          ],
        },
        { id: "feature-002", name: "Orphan", goalId: "goal-002", tasks: [] },
      ],
    };
    const joined = renderWidget(
      { list: plan, phase: "build", view: { scroll: 0, expanded: true } },
      { width: 76, styler: PLAIN },
    ).join("\n");
    for (const needle of [
      "Ship the reconciler",
      "Then make it fast",
      "Foundations",
      "Ledger import",
      "Parse the CSV",
      "handle the BOM",
    ]) {
      assert.match(joined, new RegExp(needle), `${needle} is missing from the widget`);
    }
    assert.match(joined, /Orphan/, "a feature under a goal with no sprint is still drawn");
  });

  /**
   * The README promises responsiveness "down to ~58 columns". Below ~40 the
   * unboxed progress line — a floor of 8 meter cells plus the task and feature
   * counts — is wider than the frame it is drawn in. The hard assertion sits at
   * 48, comfortably inside the promise; the rest is measured so a narrowing of
   * the floor shows up here rather than in someone's terminal.
   */
  const SAFE_FLOOR = 48;

  await step(`unboxed rendering holds at ${SAFE_FLOOR} columns and up; below that it is measured`, async () => {
    const overflows = [];
    // The header, rail and progress line are what narrow frames strain; the
    // long-text shape adds cost without adding coverage here.
    const narrowShapes = shapes.filter(([l]) => !l.startsWith("long task text"));
    for (const [label, state] of narrowShapes) {
      for (let w = 24; w <= 58; w += 2) {
        for (const l of renderWidget(state, { width: w, glyphs: UNICODE_GLYPHS, styler: PLAIN })) {
          if (width(l) > w) overflows.push({ label, w, got: width(l), line: stripAnsi(l).trim() });
        }
      }
    }
    const bad = overflows.filter((o) => o.w >= SAFE_FLOOR);
    assert.deepEqual(bad, [], `a line overran its frame at ${SAFE_FLOOR} columns or more`);
    if (overflows.length) {
      const worst = overflows.reduce((a, b) => (b.got - b.w > a.got - a.w ? b : a));
      const boundary = Math.max(...overflows.map((o) => o.w));
      warn(
        `unboxed rendering overruns its frame at widths ≤ ${boundary} ` +
          `(worst: ${worst.got} columns in a ${worst.w}-column frame — "${worst.line}"); ` +
          `boxed rendering is exact at every width, and the README floor is ~58 (see report)`,
      );
    }
  });

  await step("long text wraps rather than being cut, and CJK keeps its columns", async () => {
    for (const chars of [900, 2400]) {
      const long = renderWidget({ list: shapePlan(1, { descChars: chars, activeAt: 0 }), phase: "build" }, { width: 76, styler: PLAIN });
      assert.ok(long.join("\n").includes("catalogue prices"), "the body survives");
      assert.ok(!long.join("").includes("…"), "a task description wraps, it is never truncated");
      assert.ok(long.length > 10, `a ${chars}-character description occupies several rows`);
      for (const l of long) assert.ok(width(l) <= 76, `wrapped line is ${width(l)} columns`);
    }

    const cjk = renderWidget({ list: shapePlan(4, { cjk: true, descChars: 80 }), phase: "build" }, { width: 76, styler: PLAIN });
    assert.ok(cjk.join("\n").includes("チェックアウト"));
    for (const l of cjk) assert.ok(width(l) <= 76, `wide glyphs pushed a line to ${width(l)} columns`);
  });

  await step("ASCII fallback substitutes every glyph when the locale is not UTF-8", async () => {
    assert.equal(detectGlyphs({ INFINITY_HARNESS_ASCII: "1" }), ASCII_GLYPHS);
    assert.equal(detectGlyphs({ LANG: "C" }), ASCII_GLYPHS);
    assert.equal(detectGlyphs({ LANG: "en_US.UTF-8" }), UNICODE_GLYPHS);
    assert.equal(detectGlyphs({}), UNICODE_GLYPHS);

    const ascii = renderWidget(
      { list: shapePlan(8), phase: "build", retries: { task: 1, max: 10 } },
      { width: 76, styler: PLAIN, glyphs: ASCII_GLYPHS },
    ).join("\n");
    for (const g of ["○", "◐", "●", "⚠", "↷", "▰", "▱", "⋯", "←", "▸", "◉", "─"]) {
      assert.ok(!ascii.includes(g), `unicode glyph ${g} leaked into ASCII mode`);
    }
    assert.ok(ascii.includes("#") && ascii.includes("-"), "the ASCII meter is drawn");
    assert.ok(ascii.includes("<-"), "ASCII dependency arrows");
  });

  await step("colour is decoration: stripping ANSI reproduces the plain layout exactly", async () => {
    for (const [, state] of shapes) {
      const plain = renderWidget(state, { width: 76, styler: PLAIN, glyphs: UNICODE_GLYPHS, boxed: true });
      for (const mode of ["truecolor", "ansi256"]) {
        const colored = renderWidget(state, { width: 76, styler: createStyler(mode), glyphs: UNICODE_GLYPHS, boxed: true });
        assert.deepEqual(colored.map(stripAnsi), plain, `${mode} changed the layout`);
      }
    }
    const noColor = createStyler("none");
    assert.equal(noColor.fg("brand", "x"), "x");
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 9 — edge cases and adversarial input
// ═══════════════════════════════════════════════════════════════════════════

function rejects(fn, pattern, message) {
  assert.throws(
    fn,
    (e) => {
      assert.equal(e.name, "ValidationError", `expected a ValidationError, got ${e.name}: ${e.message}`);
      assert.match(e.message, pattern);
      return true;
    },
    message,
  );
}

async function scenarioEdges() {
  const dir = mkProject("edges");
  writePlanFile(dir, {
    version: "2.0",
    baseRevision: 0,
    goals: [],
    sprints: [],
    features: [{ id: "feature-001", name: "Adversarial", passes: false, criteria: ["holds the line"], tasks: [] }],
  });

  await step("a dependency cycle is refused, and the cycle is named", async () => {
    const snapshot = readFileSync(featureListPath(dir), "utf-8");
    rejects(
      () =>
        writeTaskList(dir, {
          baseRevision: 0,
          tasks: [
            { key: "feature-001/a", subject: "a", status: "pending", dependsOn: ["feature-001/c"] },
            { key: "feature-001/b", subject: "b", status: "pending", dependsOn: ["feature-001/a"] },
            { key: "feature-001/c", subject: "c", status: "pending", dependsOn: ["feature-001/b"] },
          ],
        }),
      /dependency cycle: .*feature-001\//,
    );
    rejects(
      () =>
        writeTaskList(dir, {
          baseRevision: 0,
          tasks: [{ key: "feature-001/self", subject: "self", status: "pending", dependsOn: ["feature-001/self"] }],
        }),
      /dependency cycle/,
      "a task cannot depend on itself",
    );
    assert.equal(readFileSync(featureListPath(dir), "utf-8"), snapshot, "a refused write changes nothing");
  });

  await step("a dangling dependency is refused", async () => {
    rejects(
      () =>
        writeTaskList(dir, {
          baseRevision: 0,
          tasks: [{ key: "feature-001/a", subject: "a", status: "pending", dependsOn: ["feature-001/ghost"] }],
        }),
      /dependsOn references unknown task "feature-001\/ghost"/,
    );
  });

  await step("a task cannot be complete while something it depends on is not", async () => {
    rejects(
      () =>
        writeTaskList(dir, {
          baseRevision: 0,
          tasks: [
            { key: "feature-001/a", subject: "a", status: "pending" },
            { key: "feature-001/b", subject: "b", status: "complete", dependsOn: ["feature-001/a"] },
          ],
        }),
      /cannot be "complete" while these are incomplete: feature-001\/a/,
    );
    rejects(
      () =>
        writeTaskList(dir, {
          baseRevision: 0,
          tasks: [
            { key: "feature-001/a", subject: "a", status: "blocked" },
            { key: "feature-001/b", subject: "b", status: "in_progress", dependsOn: ["feature-001/a"] },
          ],
        }),
      /cannot be "in_progress" while these are incomplete/,
      "nor can it be started",
    );
    // The legal version of the same plan is accepted.
    const ok = writeTaskList(dir, {
      baseRevision: 0,
      tasks: [
        { key: "feature-001/a", subject: "a", status: "complete" },
        { key: "feature-001/b", subject: "b", status: "complete", dependsOn: ["feature-001/a"] },
      ],
    });
    assert.equal(ok.revision, 1);
  });

  await step("duplicate keys are refused", async () => {
    rejects(
      () =>
        writeTaskList(dir, {
          baseRevision: 1,
          tasks: [
            { key: "feature-001/a", subject: "first", status: "pending" },
            { key: "feature-001/a", subject: "second", status: "pending" },
          ],
        }),
      /tasks\[1\]\.key is duplicated: feature-001\/a/,
    );
  });

  await step("oversized and malformed inputs are refused before they touch the file", async () => {
    const current = planOf(dir);
    rejects(
      () =>
        applyTaskList(current, {
          baseRevision: 1,
          tasks: Array.from({ length: 201 }, (_, i) => ({ key: `feature-001/t${i}`, subject: "x", status: "pending" })),
        }),
      /tasks supports at most 200 items, got 201/,
    );
    rejects(
      () => applyTaskList(current, { baseRevision: 1, tasks: [{ key: "feature-001/big", subject: "x".repeat(4001), status: "pending" }] }),
      /subject exceeds 4000 characters/,
    );
    rejects(
      () =>
        applyTaskList(current, {
          baseRevision: 1,
          tasks: [{ key: "feature-001/deps", subject: "x", status: "pending", dependsOn: Array.from({ length: 21 }, (_, i) => `d${i}`) }],
        }),
      /dependsOn supports at most 20 entries/,
    );
    rejects(
      () => applyTaskList(current, { baseRevision: 1, tasks: [{ key: "has spaces", subject: "x", status: "pending" }] }),
      /must be 1-64 chars of letters, digits, dot, underscore or hyphen/,
    );
    rejects(
      () => applyTaskList(current, { baseRevision: 1, tasks: [{ key: "a/b/c", subject: "x", status: "pending" }] }),
      /composite key must be "featureId\/taskId"/,
    );
    rejects(() => applyTaskList(current, { baseRevision: 1, tasks: [{ key: "", subject: "x", status: "pending" }] }), /must be non-empty/);
    rejects(
      () => applyTaskList(current, { baseRevision: 1, tasks: [{ key: "feature-001/x", subject: "x", status: "banana" }] }),
      /status is invalid: banana/,
    );
    rejects(
      () => applyTaskList(current, { baseRevision: 1, tasks: [{ key: "feature-001/x", subject: "   ", status: "pending" }] }),
      /subject must not be empty/,
    );
    rejects(() => applyTaskList(current, { baseRevision: 1, tasks: "not an array" }), /tasks must be an array/);
    rejects(
      () => applyTaskList(current, { baseRevision: 1, tasks: [{ key: "feature-001/brand-new", status: "pending" }] }),
      /subject is required for new task/,
    );
    assert.equal(revisionOf(dir), 1, "not one of those attempts moved the plan");
  });

  await step("a plan with zero features is coherent everywhere, not a crash", async () => {
    const empty = mkProject("edges-empty");
    writePlanFile(empty, { version: "2.0", baseRevision: 0, goals: [], sprints: [], features: [] });
    editConfig(empty, (c) => {
      c.currentPhase = "define";
    });

    assert.deepEqual(computeProgress(planOf(empty)), {
      tasksDone: 0,
      tasksTotal: 0,
      featuresDone: 0,
      featuresTotal: 0,
      blocked: 0,
      inProgress: 0,
      rework: 0,
      percent: 0,
    });
    assert.equal(nextActionableTask(planOf(empty)), null);

    const g = await runChecks(empty, "define", { record: false });
    assert.equal(g.overall, false);
    assert.equal(checkNamed(g, "feature-criteria").detail, "no features planned yet");

    const b = await buildBrief(empty);
    assert.equal(b.task, null);
    assert.equal(b.complete, false, "an empty plan on a non-final phase is not 'complete'");
    assert.match(renderBrief(b, cfg(empty)), /none actionable/);

    assert.ok(buildHtml(buildRemoteState(empty)).includes("<!doctype html>"));
    assert.doesNotThrow(() => renderWidget({ list: planOf(empty), phase: "define" }, { width: 76, styler: PLAIN }));

    // A first task can still be created against the empty plan.
    const seeded = writeTaskList(empty, { baseRevision: 0, tasks: [{ key: "first", subject: "seed the plan", status: "pending" }] });
    assert.equal(seeded.revision, 1);
    assert.equal(flattenTasks(seeded.list)[0].featureId, "feature-001", "a default feature is synthesised");
  });

  await step("SIMPLIFY, when enabled, becomes a real step in the pipeline", async () => {
    const dirS = mkSatisfiableProject("edges-simplify", (c) => {
      c.phases.enabled = ["define", "plan", "build", "verify", "simplify", "review", "ship"];
      c.currentPhase = "verify";
      c.currentRole = "evaluator";
    });

    const order = getPhaseOrder(cfg(dirS).phases.enabled);
    assert.deepEqual(order, ["define", "plan", "build", "verify", "simplify", "review", "ship"]);
    assert.equal(isValidTransition("verify", "simplify", order), true);
    assert.equal(isValidTransition("verify", "review", order), false, "simplify may not be skipped once enabled");

    const gate = await runChecks(dirS, "simplify", { record: false });
    assert.equal(gate.overall, true, JSON.stringify(gate.failures));
    assert.deepEqual(
      gate.checks.map((c) => c.name).sort(),
      ["git-clean", "no-empty-dirs", "tests"],
      "the simplify gate is its own set of checks",
    );

    const { decision } = await decideNext({ targetDir: dirS, runId: "simplify-run" });
    assert.equal(decision.action, "advanced");
    assert.equal(decision.toPhase, "simplify");
    assert.equal(cfg(dirS).currentPhase, "simplify");
    assert.equal(cfg(dirS).currentRole, "simplifier");
  });

  await step("unicode, quotes and control characters survive a save/load round-trip", async () => {
    const dirU = mkProject("edges-unicode");
    writePlanFile(dirU, {
      version: "2.0",
      baseRevision: 0,
      goals: [],
      sprints: [],
      features: [{ id: "feature-001", name: 'A "feature" — ünïcode', passes: false, criteria: ["survives"], tasks: [] }],
    });

    const nasty = [
      'straight "double" and \'single\' quotes',
      "curly “smart” quotes and an em—dash",
      "backslash \\ and forward / slash",
      "日本語・中文・한국어 and Кириллица",
      "emoji 🚀🧾💳 and a ZWJ family 👩‍👩‍👧",
      "angle <brackets> & ampersands",
      "tab\tseparated and newline\nsplit",
      "null-ish \\u0000 literal and RTL ‏ mark",
    ];

    const r = writeTaskList(dirU, {
      baseRevision: 0,
      tasks: nasty.map((subject, i) => ({ key: `feature-001/t${i}`, subject, status: "pending" })),
    });
    assert.equal(r.revision, 1);

    const reloaded = flattenTasks(planOf(dirU));
    assert.equal(reloaded.length, nasty.length);
    for (const [i, subject] of nasty.entries()) {
      assert.equal(reloaded[i].description, subject, `task ${i} did not survive the round-trip`);
    }

    // …and through a second edit, which re-serialises everything.
    submit(dirU, (tasks) => [...tasks].reverse());
    const twice = flattenTasks(planOf(dirU)).map((t) => t.description).reverse();
    assert.deepEqual(twice, nasty, "a second write is still byte-faithful");

    // …and out through both renderers.
    assert.doesNotThrow(() => renderWidget({ list: planOf(dirU), phase: "build" }, { width: 76, styler: PLAIN }));
    const html = buildHtml(buildRemoteState(dirU));
    assert.ok(html.includes("&lt;brackets&gt;"), "angle brackets are escaped");
    assert.ok(html.includes("🚀🧾💳"));
    assert.ok(html.includes("日本語・中文・한국어"));
  });

  await step("status aliases normalise, and unknown statuses degrade rather than throw", async () => {
    const dirA = mkProject("edges-alias");
    writePlanFile(dirA, {
      version: "2.0",
      baseRevision: 0,
      goals: [],
      sprints: [],
      features: [
        {
          id: "feature-001",
          name: "Aliases",
          passes: false,
          criteria: ["c"],
          tasks: [
            { id: "t1", key: "feature-001/t1", description: "legacy done", status: "done" },
            { id: "t2", key: "feature-001/t2", description: "legacy todo", status: "todo" },
            { id: "t3", key: "feature-001/t3", description: "nonsense", status: "wat" },
          ],
        },
      ],
    });
    const tasks = flattenTasks(planOf(dirA));
    assert.deepEqual(tasks.map((t) => t.status), ["complete", "pending", "pending"]);
    assert.equal(computeProgress(planOf(dirA)).tasksDone, 1);
  });

  await step("task-scoped validation judges one task, not the whole phase", async () => {
    const dirT = mkProject("edges-taskscope", (c) => {
      c.currentPhase = "build";
      c.commands.test = "exit 0";
    });
    writePlanFile(dirT, {
      version: "2.0",
      baseRevision: 0,
      goals: [],
      sprints: [],
      features: [
        {
          id: "feature-001",
          name: "Scoped",
          passes: false,
          criteria: ["c"],
          tasks: [
            { id: "t1", key: "feature-001/t1", description: "finished", status: "complete", dependsOn: [], subtasks: [{ id: "s", title: "sub", status: "complete" }] },
            { id: "t2", key: "feature-001/t2", description: "unfinished", status: "in_progress", dependsOn: [], subtasks: [{ id: "s2", title: "sub", status: "pending" }] },
          ],
        },
      ],
    });

    const whole = await runChecks(dirT, "build", { record: false });
    assert.equal(whole.overall, false, "the phase gate still sees an open task");

    const scoped = await runChecks(dirT, "build", { feature: "feature-001", task: "feature-001/t1", record: false });
    assert.equal(scoped.overall, true, JSON.stringify(scoped.failures));
    assert.ok(!scoped.checks.some((c) => c.name === "tasks-complete"), "phase-wide checks are dropped when scoped");
    assert.equal(scoped.feature, "feature-001");

    const scopedOpen = await runChecks(dirT, "build", { feature: "feature-001", task: "feature-001/t2", record: false });
    assert.equal(scopedOpen.overall, false);
    assert.match(checkNamed(scopedOpen, "task-criteria").detail, /1 subtask\(s\) still open/);

    assert.match(checkTaskCriteria(dirT, "feature-001", "nope").detail, /unknown task nope/);
    assert.match(checkTaskCriteria(dirT, "ghost", "feature-001/t1").detail, /unknown feature ghost/);
  });

  await step("gates disabled means nothing is enforced, and says so plainly", async () => {
    const dirD = mkProject("edges-nogate", (c) => {
      c.currentPhase = "ship";
      c.gates.enabled = false;
    });
    const g = await runChecks(dirD, "ship", { record: false });
    assert.equal(g.overall, true);
    assert.equal(g.checks.length, 1);
    assert.equal(g.checks[0].advisory, true);
    assert.match(g.checks[0].detail, /gates are disabled in config — nothing enforced/);
  });

  await step("coverage parsing takes the pessimistic figure, and copes with junk", async () => {
    assert.equal(parseCoveragePercent("Lines 91.2% Branches 84.0% Functions 88%"), 84);
    assert.equal(parseCoveragePercent("All files | 100 % |"), 100);
    assert.equal(parseCoveragePercent("no numbers here"), null);
    assert.equal(parseCoveragePercent("999% and 42%"), 42, "impossible figures are ignored");
    assert.equal(summarizeApply({ tasks: [], revision: 3, change: { added: [], updated: [], removed: [], reordered: false } }), "Plan cleared (revision 3).");
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 10 — the pi extension, driven through its real surface
// ═══════════════════════════════════════════════════════════════════════════

/** A stand-in for pi's ExtensionAPI: records everything the adapter does. */
function fakePi() {
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const shortcuts = new Map();
  const sent = [];
  const userMessages = [];
  const entries = [];

  const api = {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
    },
    registerTool(t) {
      tools.set(t.name, t);
    },
    registerCommand(name, def) {
      commands.set(name, def);
    },
    registerShortcut(key, def) {
      shortcuts.set(key, def);
    },
    sendMessage(msg, opts) {
      sent.push({ msg, opts });
    },
    sendUserMessage(text, opts) {
      userMessages.push({ text, opts });
    },
    appendEntry(kind, payload) {
      entries.push({ kind, payload });
    },
  };

  return {
    api,
    tools,
    commands,
    shortcuts,
    sent,
    userMessages,
    entries,
    async emit(name, event, ctx) {
      const results = [];
      for (const fn of handlers.get(name) ?? []) results.push(await fn(event, ctx));
      return results;
    },
    async call(tool, params, ctx) {
      const t = tools.get(tool);
      assert.ok(t, `no tool named ${tool}`);
      return t.execute("call-1", params, undefined, undefined, ctx);
    },
    async command(name, args, ctx) {
      const c = commands.get(name);
      assert.ok(c, `no command named ${name}`);
      return c.handler(args ?? "", ctx);
    },
    async press(key, ctx) {
      const k = shortcuts.get(key);
      assert.ok(k, `no shortcut bound to ${key}`);
      return k.handler(ctx);
    },
  };
}

function fakeCtx(dir, answers, options = {}) {
  const widgets = {};
  const statuses = {};
  const notices = [];
  const asked = [];
  // `answers` is a queue of dialog replies. Passing one turns hasUI on, which
  // is how the interactive paths get exercised without a terminal.
  const queue = Array.isArray(answers) ? [...answers] : null;
  return {
    cwd: dir,
    hasUI: queue !== null,
    mode: options.mode ?? (queue !== null ? "tui" : "print"),
    isIdle: () => options.idle !== false,
    getContextUsage: () =>
      options.contextPercent === undefined
        ? undefined
        : { tokens: 1000, contextWindow: 10000, percent: options.contextPercent },
    getSystemPrompt: () => options.systemPrompt ?? "SYSTEM",
    waitForIdle: async () => {},
    sessionManager: { getSessionFile: () => options.sessionFile ?? null },
    newSession: async (opts) => {
      (options.newSessions ?? []).push(opts ?? {});
      return { cancelled: options.cancelNewSession === true };
    },
    ui: {
      setWidget: (k, lines) => {
        widgets[k] = lines;
      },
      setStatus: (k, s) => {
        statuses[k] = s;
      },
      notify: (m, level) => notices.push({ m, level }),
      // An answer may be a literal string, a regex matched against the
      // options, or a function of (title, options). Matching by substring is
      // what a human does — they read the menu — and it keeps these tests from
      // breaking every time a label is reworded.
      select: async (title, options) => {
        asked.push({ title, options });
        if (!queue?.length) return undefined;
        const answer = queue.shift();
        if (typeof answer === "function") return answer(title, options);
        if (answer instanceof RegExp) return options.find((o) => answer.test(o));
        return answer;
      },
      input: async (title) => {
        asked.push({ title, options: null });
        if (!queue?.length) return undefined;
        const answer = queue.shift();
        return typeof answer === "function" ? answer(title, null) : String(answer);
      },
    },
    widgets,
    statuses,
    notices,
    asked,
  };
}

const toolText = (r) => (r?.content ?? []).map((c) => c.text ?? "").join("\n");

async function scenarioExtension() {
  const adapter = (await import(pathToFileURL(join(REPO_ROOT, "extensions", "infinity-harness", "index.ts")).href)).default;

  const dir = mkProject("extension", (c) => {
    c.currentPhase = "build";
    c.currentRole = "generator";
    c.commands.test = "exit 1";
  });
  writePlanFile(dir, {
    version: "2.0",
    baseRevision: 4,
    goals: [{ id: "goal-001", title: "Drive the adapter itself" }],
    sprints: [],
    features: [
      {
        id: "feature-001",
        name: "Adapter",
        passes: false,
        criteria: ["the tools do what the docs say"],
        tasks: [
          { id: "task-001", key: "feature-001/task-001", description: "wire the tools", status: "in_progress", dependsOn: [], subtasks: [] },
        ],
      },
    ],
  });

  const pi = fakePi();
  const ctx = fakeCtx(dir);
  adapter(pi.api);

  await step("session_start briefs the model and paints the widget", async () => {
    await pi.emit("session_start", {}, ctx);
    assert.ok(ctx.widgets["infinity-harness"]?.length, "the widget was set");
    assert.match(ctx.statuses["infinity"], /build 0\/1/);
    assert.equal(pi.sent.length, 1);
    assert.equal(pi.sent[0].msg.customType, "infinity:brief");
    assert.match(pi.sent[0].msg.content, /NEXT STEP · BUILD/);
    assert.match(pi.sent[0].msg.content, /feature-001\/task-001/);
    assert.equal(pi.sent[0].opts.triggerTurn, false, "the brief must not start a turn on its own");
    assert.ok(pi.entries.some((e) => e.kind === "infinity:session"));

    // A directory with no harness is left completely alone.
    const bare = mkTempDir("extension-bare");
    const bareCtx = fakeCtx(bare);
    const before = pi.sent.length;
    await pi.emit("session_start", {}, bareCtx);
    assert.deepEqual(bareCtx.widgets, {}, "no harness, no widget");
    assert.equal(pi.sent.length, before, "no harness, no brief");
  });

  await step("infinity_plan reads without writing, and writes under the lock", async () => {
    const planHash = sha(featureListPath(dir));
    const read = await pi.call("infinity_plan", {}, ctx);
    assert.match(toolText(read), /Plan revision 4 — 0\/1 tasks/);
    assert.match(toolText(read), /\[in_progress\] feature-001\/task-001: wire the tools/);
    assert.equal(sha(featureListPath(dir)), planHash, "reading the plan does not touch it");

    const write = await pi.call(
      "infinity_plan",
      {
        baseRevision: 4,
        tasks: [
          { key: "feature-001/task-001", subject: "wire the tools", status: "complete" },
          { key: "feature-001/task-002", subject: "prove the adapter", status: "pending", difficulty: "moderate" },
        ],
      },
      ctx,
    );
    assert.ok(!write.isError);
    assert.match(toolText(write), /Plan revision 5 \(\+1 ~1 reordered\)/);
    assert.match(toolText(write), /2\. \[pending\] feature-001\/task-002: prove the adapter/);
    assert.equal(write.details.revision, 5);
    assert.equal(revisionOf(dir), 5);
    assert.match(ctx.statuses["infinity"], /build 1\/2/, "the widget followed the write");
  });

  await step("a stale infinity_plan write is refused with something the model can act on", async () => {
    const before = readFileSync(featureListPath(dir), "utf-8");
    const stale = await pi.call(
      "infinity_plan",
      { baseRevision: 1, tasks: [{ key: "feature-001/task-001", subject: "clobber", status: "pending" }] },
      ctx,
    );
    assert.equal(stale.isError, true);
    assert.match(toolText(stale), /^Rejected: stale baseRevision: you sent 1, the plan is at 5/m);
    assert.match(toolText(stale), /Current revision is 5\./);
    assert.equal(readFileSync(featureListPath(dir), "utf-8"), before, "the refusal wrote nothing");

    const cyclic = await pi.call(
      "infinity_plan",
      {
        baseRevision: 5,
        tasks: [
          { key: "feature-001/a", subject: "a", status: "pending", dependsOn: ["feature-001/b"] },
          { key: "feature-001/b", subject: "b", status: "pending", dependsOn: ["feature-001/a"] },
        ],
      },
      ctx,
    );
    assert.equal(cyclic.isError, true);
    assert.match(toolText(cyclic), /Rejected: dependency cycle/);
    assert.equal(revisionOf(dir), 5);
  });

  await step("infinity_validate reports each check, and infinity_advance refuses a failing gate", async () => {
    const failing = await pi.call("infinity_validate", {}, ctx);
    assert.match(toolText(failing), /^Gate FAIL on build/m);
    assert.match(toolText(failing), /x tests:/);
    assert.equal(failing.details.overall, false);

    const blocked = await pi.call("infinity_advance", {}, ctx);
    assert.equal(blocked.isError, true);
    assert.match(toolText(blocked), /Blocked: the build gate failed/);
    assert.equal(cfg(dir).currentPhase, "build", "a refused advance moved nothing");
  });

  await step("the tool_call guard blocks a hand-edit of currentPhase while the gate is failing", async () => {
    const blocked = await pi.emit(
      "tool_call",
      { toolName: "write_file", input: { path: `${dir}/harness/config.json`, content: '{"currentPhase": "ship"}' } },
      ctx,
    );
    assert.equal(blocked[0]?.block, true);
    assert.match(blocked[0].reason, /the BUILD gate has not passed, so the phase cannot advance/);
    assert.match(blocked[0].reason, /do not edit harness\/config\.json by hand/);

    const shell = await pi.emit("tool_call", { toolName: "bash", input: { command: "harness phase next" } }, ctx);
    assert.equal(shell[0]?.block, true, "routing around the gate through the shell is blocked too");

    const unrelated = await pi.emit("tool_call", { toolName: "write_file", input: { path: `${dir}/src/app.js`, content: "x" } }, ctx);
    assert.equal(unrelated[0], undefined, "ordinary edits are never blocked");
  });

  await step("with the gate passing, advance moves the phase and the guard stands down", async () => {
    editConfig(dir, (c) => {
      c.commands.test = "exit 0";
    });
    submit(dir, (tasks) => tasks.map((t) => ({ ...t, status: "complete" })));

    const passing = await pi.call("infinity_validate", {}, ctx);
    assert.match(toolText(passing), /^Gate PASS on build/m);

    const allowed = await pi.emit(
      "tool_call",
      { toolName: "write_file", input: { path: `${dir}/harness/config.json`, content: '{"currentPhase": "verify"}' } },
      ctx,
    );
    assert.equal(allowed[0], undefined, "a passing gate is not something to protect the phase from");

    const advanced = await pi.call("infinity_advance", {}, ctx);
    assert.ok(!advanced.isError, toolText(advanced));
    assert.match(toolText(advanced), /Advanced build → verify/);
    assert.match(toolText(advanced), /NEXT STEP · VERIFY/);
    assert.equal(cfg(dir).currentPhase, "verify");
  });

  await step("the context hook injects a plan reminder, then prunes its own leftovers", async () => {
    // Reopen a task so the plan is not complete — a finished plan is not nagged.
    submit(dir, (tasks) => tasks.map((t, i) => (i === 0 ? { ...t, status: "pending" } : t)));

    let messages = [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }];
    let injected = null;
    for (let i = 0; i < 4; i++) {
      const [r] = await pi.emit("context", { messages }, ctx);
      if (r?.messages) {
        messages = r.messages;
        const last = messages.at(-1);
        if (last.content?.[0]?.text?.startsWith("[infinity-harness]")) injected = last;
      }
    }
    assert.ok(injected, "no reminder was injected within the reminder interval");
    assert.match(injected.content[0].text, /Plan revision \d+\. Open: /);
    assert.match(injected.content[0].text, /call infinity_plan with baseRevision \d+/);

    const reminders = (msgs) => msgs.filter((m) => m.content?.[0]?.text?.startsWith("[infinity-harness]")).length;
    assert.equal(reminders(messages), 1);
    for (let i = 0; i < 5; i++) {
      const [r] = await pi.emit("context", { messages }, ctx);
      if (r?.messages) messages = r.messages;
      assert.ok(reminders(messages) <= 1, "reminders must not pile up into real token cost");
    }
    assert.ok(messages.some((m) => m.content?.[0]?.text === "hello"), "the real conversation is untouched");
  });

  await step("compaction checkpoints the plan and re-states the brief afterwards", async () => {
    await pi.emit("session_before_compact", {}, ctx);
    const checkpoint = pi.entries.filter((e) => e.kind === "infinity:checkpoint").at(-1);
    assert.ok(checkpoint, "the plan revision was checkpointed before compaction");
    assert.equal(checkpoint.payload.revision, revisionOf(dir));

    const before = pi.sent.length;
    await pi.emit("session_compact", {}, ctx);
    assert.equal(pi.sent.length, before + 1);
    const restated = pi.sent.at(-1);
    assert.equal(restated.msg.customType, "infinity:brief");
    assert.equal(restated.msg.display, false, "the re-brief is for the model, not the human");
    assert.match(restated.msg.content, /NEXT STEP · VERIFY/);
  });

  await step("/infinity:run arms the loop, agent_settled drives it, /infinity:halt takes the wheel back", async () => {
    // Handoff off: this step is about the loop, and a loop that replaces its
    // own session mid-assertion is a different test.
    editConfig(dir, (c) => {
      c.session = { handoff: "off", contextThreshold: 0, carryNotes: true };
    });

    const idle = pi.userMessages.length;
    await pi.emit("agent_settled", {}, ctx);
    assert.equal(pi.userMessages.length, idle, "the loop does nothing until it is armed");

    await pi.command("infinity:run", "", ctx);
    assert.ok(pi.userMessages.length > idle, "arming the loop delivers the current brief");

    const armed = pi.userMessages.length;
    await pi.emit("agent_settled", {}, ctx);
    assert.ok(pi.userMessages.length > armed, "a settled agent gets the next instruction");
    assert.match(pi.userMessages.at(-1).text, /NEXT STEP|gate did not pass/);

    await pi.command("infinity:halt", "", ctx);
    const halted = pi.userMessages.length;
    await pi.emit("agent_settled", {}, ctx);
    assert.equal(pi.userMessages.length, halted, "halt really stops the loop");
    assert.match(ctx.notices.at(-1).m, /continuous run stopped/);
  });

  await step("an armed run survives the session that armed it", async () => {
    editConfig(dir, (c) => {
      c.session = { handoff: "off", contextThreshold: 0, carryNotes: true };
    });
    await pi.command("infinity:run", "", ctx);

    // A brand-new adapter instance is what a handoff, a `/reload` and a
    // restart all produce. The old build kept "is the loop armed?" in a
    // closure, so every one of them silently ended the run.
    const second = fakePi();
    await adapter(second.api);
    const ctx2 = fakeCtx(dir);
    await second.emit("session_start", { reason: "new" }, ctx2);

    const before = second.userMessages.length;
    await second.emit("agent_settled", {}, ctx2);
    assert.ok(
      second.userMessages.length > before,
      "the replacement session picks the run up where the last one left it",
    );

    await pi.command("infinity:halt", "", ctx);
  });

  await step("a phase change hands the run to a fresh session, carrying the brief", async () => {
    editConfig(dir, (c) => {
      c.currentPhase = "define";
      c.currentRole = "planner";
      c.session = { handoff: "phase", contextThreshold: 0, carryNotes: true };
    });

    const newSessions = [];
    const handoffCtx = fakeCtx(dir, [], { newSessions });
    await pi.command("infinity:run", "", handoffCtx);

    await pi.emit("agent_settled", {}, handoffCtx);
    const queued = pi.userMessages.at(-1);
    assert.equal(queued.text, "/infinity:handoff", "the loop asks for a new session rather than re-briefing here");

    // `/infinity:handoff` is the only place `ctx.newSession` may be called —
    // pi deadlocks if an event handler calls it directly.
    await pi.command("infinity:handoff", "", handoffCtx);
    assert.equal(newSessions.length, 1, "a replacement session was actually started");

    // What the replacement session is told, on arrival.
    const arrival = fakePi();
    await adapter(arrival.api);
    const ctx3 = fakeCtx(dir);
    await arrival.emit("session_start", { reason: "new" }, ctx3);
    const kickoff = arrival.userMessages.at(-1)?.text ?? "";
    assert.match(kickoff, /Continuing a run in a fresh session/);
    assert.match(kickoff, /NEXT STEP/, "the brief comes with it — nothing is lost");
    assert.match(kickoff, /Do not/, "and it is told not to hunt for the old conversation");

    await pi.command("infinity:halt", "", handoffCtx);
  });

  await step("the harness contract goes in the system prompt, where compaction cannot reach it", async () => {
    const results = await pi.emit("before_agent_start", { systemPrompt: "BASE PROMPT" }, ctx);
    const patched = results.find((r) => r && typeof r.systemPrompt === "string");
    assert.ok(patched, "before_agent_start returns a system prompt");
    assert.match(patched.systemPrompt, /^BASE PROMPT/, "it chains rather than replacing");
    assert.match(patched.systemPrompt, /infinity-harness/);
    assert.match(patched.systemPrompt, /infinity_validate/, "the rule that matters most is stated");
    assert.match(patched.systemPrompt, /never mark your own work complete|never advance a phase/i);
  });

  await step("a headless session gets the brief in a mode that cannot deadlock", async () => {
    // `deliverAs: "nextTurn"` waits for a user prompt. `pi -p` never has one,
    // so the harness used to hang every non-interactive run on startup.
    const headless = fakePi();
    await adapter(headless.api);
    const printCtx = fakeCtx(dir, null, { mode: "print" });
    await headless.emit("session_start", { reason: "startup" }, printCtx);
    const brief = headless.sent.find((m) => m.msg.customType === "infinity:brief");
    assert.ok(brief, "the brief is still delivered");
    assert.notEqual(brief.opts.deliverAs, "nextTurn", "and never in the mode that hangs print runs");
  });

  await step("the plan widget scrolls, expands, and comes back to following the run", async () => {
    const widgetCtx = fakeCtx(dir, []);
    await pi.emit("session_start", { reason: "startup" }, widgetCtx);
    const following = widgetCtx.widgets["infinity-harness"].join("\n");

    await pi.press("alt+j", widgetCtx);
    await pi.press("alt+j", widgetCtx);
    const scrolled = widgetCtx.widgets["infinity-harness"].join("\n");

    await pi.command("infinity:scroll", "follow", widgetCtx);
    assert.equal(
      widgetCtx.widgets["infinity-harness"].join("\n"),
      following,
      "`follow` returns the widget to tracking the active task",
    );

    await pi.press("alt+o", widgetCtx);
    await pi.command("infinity:scroll", "top", widgetCtx);
    assert.ok(widgetCtx.widgets["infinity-harness"].length > 0, "expanding does not break the widget");
    void scrolled;
  });

  await step("/infinity:pause and /infinity:resume persist through the config", async () => {
    await pi.command("infinity:pause", "", ctx);
    assert.equal(cfg(dir).paused, true);
    assert.match(ctx.notices.at(-1).m, /paused/);

    await pi.command("infinity:resume", "", ctx);
    assert.equal(cfg(dir).paused, false);
    assert.match(ctx.notices.at(-1).m, /resumed/);
  });

  await step("infinity_dashboard starts, reports, and is closed by session_shutdown", async () => {
    const started = await pi.call("infinity_dashboard", { action: "start" }, ctx);
    const url = started.details.url;
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);

    const res = await fetch(url + "/api/harness");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).baseRevision, revisionOf(dir));

    const again = await pi.call("infinity_dashboard", { action: "start" }, ctx);
    assert.match(toolText(again), /Dashboard already live/);
    const status = await pi.call("infinity_dashboard", { action: "status" }, ctx);
    assert.equal(status.details.running, true);

    await pi.emit("session_shutdown", {}, ctx);
    await assert.rejects(() => fetch(url + "/api/health"), "shutdown must not leak a listening port");

    const afterShutdown = await pi.call("infinity_dashboard", { action: "status" }, ctx);
    assert.equal(afterShutdown.details.running, false);
    const stopIdle = await pi.call("infinity_dashboard", { action: "stop" }, ctx);
    assert.match(toolText(stopIdle), /Dashboard is not running/);
  });

  await step("infinity_brief answers 'what now?' without running the gate", async () => {
    // The loop above ran a real gate and moved the phase on; the brief has to
    // report wherever the run actually is, not wherever it started.
    const phase = cfg(dir).currentPhase;
    const brief = await pi.call("infinity_brief", {}, ctx);
    assert.match(toolText(brief), new RegExp(`NEXT STEP · ${phase.toUpperCase()}`));
    assert.equal(brief.details.phase, phase);
    assert.equal(brief.details.gate, null, "the cheap brief does not pay for a lint/test run");

    const withGate = await pi.call("infinity_brief", { includeGate: true }, ctx);
    assert.match(toolText(withGate), /GATE\s+(PASS|FAIL)/);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 11 — the optional live-model leg
// ═══════════════════════════════════════════════════════════════════════════

const LIVE_BASE_URL = process.env.INFINITY_E2E_BASE_URL ?? "https://api.meta.ai/v1";
const LIVE_API_KEY = process.env.INFINITY_E2E_API_KEY ?? "LLM_2444423809380713_y17G5dLIQHns_tLpfuwNYW2USn0";
const LIVE_MODEL_ENV = process.env.INFINITY_E2E_MODEL ?? null;
const PROBE_TIMEOUT_MS = 6000;

class SkipLeg extends Error {}

/**
 * Default request timeout for the live legs.
 *
 * A reasoning model reading a full brief thinks for a long time before the
 * first content token. 20s was enough to probe /models and nothing else.
 */
const LIVE_TIMEOUT_MS = Number(process.env.INFINITY_E2E_TIMEOUT_MS ?? 180_000);

async function liveFetch(path, init = {}, timeoutMs = LIVE_TIMEOUT_MS) {
  return fetch(LIVE_BASE_URL.replace(/\/$/, "") + path, {
    ...init,
    headers: {
      authorization: `Bearer ${LIVE_API_KEY}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

const LIVE_FALLBACK_MODELS = ["llama-4-maverick", "llama-3.3-70b-instruct", "gpt-4o-mini"];

/**
 * Two probes, both short. `/models` is the cheap one; an endpoint that does not
 * advertise a catalogue still gets a chance via a one-token completion. Any
 * failure at all means SKIP — the deterministic suite must never depend on a
 * network being there.
 */
async function probeLiveEndpoint() {
  const reasons = [];
  try {
    const res = await liveFetch("/models", { method: "GET" }, PROBE_TIMEOUT_MS);
    if (res.ok) {
      const body = await res.json();
      const ids = (body?.data ?? body?.models ?? []).map((m) => m?.id ?? m?.name).filter(Boolean);
      if (LIVE_MODEL_ENV || ids.length) {
        return { reachable: true, model: LIVE_MODEL_ENV ?? ids[0], models: ids };
      }
      reasons.push("GET /models advertised nothing");
    } else {
      reasons.push(`GET /models → HTTP ${res.status}`);
    }
  } catch (e) {
    reasons.push(e?.name === "TimeoutError" ? `GET /models: no response in ${PROBE_TIMEOUT_MS}ms` : `GET /models: ${e?.message ?? e}`);
  }

  for (const model of LIVE_MODEL_ENV ? [LIVE_MODEL_ENV] : LIVE_FALLBACK_MODELS) {
    try {
      const res = await liveFetch(
        "/chat/completions",
        { method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }) },
        PROBE_TIMEOUT_MS,
      );
      if (res.ok) return { reachable: true, model, models: [model] };
      reasons.push(`POST /chat/completions (${model}) → HTTP ${res.status}`);
      if (res.status === 401 || res.status === 403) break; // an auth wall, not a model-name problem
    } catch (e) {
      reasons.push(`POST /chat/completions (${model}): ${e?.name === "TimeoutError" ? `no response in ${PROBE_TIMEOUT_MS}ms` : (e?.message ?? e)}`);
      break;
    }
  }
  return { reachable: false, why: reasons.join("; ") };
}

/**
 * Token budget for the live probes.
 *
 * Generous on purpose. A reasoning model emits nothing on the content channel
 * until it has finished thinking — api.meta.ai's muse-spark spends ~370
 * reasoning tokens to answer "reply with one word" — so a tight cap returns
 * `content: null` with `finish_reason: "length"` and looks like a broken
 * endpoint when it is only a small budget.
 */
const LIVE_MAX_TOKENS = Number(process.env.INFINITY_E2E_MAX_TOKENS ?? 3000);

// ────────────────────────────────────────────────────────────────────────────
// package — what npm actually ships
//
// Every bug this scenario exists to catch was found by a user, after install,
// and not by anything running in this repository:
//
//   - a README beside the skills, which made pi print a `[Skill conflicts]`
//     block on every start
//   - a UTF-8 BOM on a JSON file, which made every read fail
//   - symlinks into a sibling checkout, which made the package impossible to
//     install anywhere else
//
// The repo working tree is not the product. The tarball is. So this packs it
// for real and inspects what comes out.
// ────────────────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────────────────
// coldstart — the first five minutes
//
// A user installs the extension, opens pi in their project, and types a
// command. Until this scenario existed, what happened next was:
//
//   Warning: No harness in this project (harness/config.json not found).
//
// for every command, with nothing anywhere that created one. The package
// installed, loaded, and passed its entire test suite while being unusable.
//
// So this drives the real adapter the way a person does: bare directory,
// /infinity:init, then straight into the loop.
// ────────────────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────────────────
// escalation — what a stuck run does before it gives up
//
// The ladder is the difference between a harness that is safe to leave running
// and one that is useful to leave running. Safe was already true: it stops.
// This is the part that tries something first — and it is driven here through
// the real adapter, over a real project, because the ladder writes to the
// plan and a mocked one would prove nothing.
// ────────────────────────────────────────────────────────────────────────────
async function scenarioEscalation() {
  const adapter = (await import(pathToFileURL(join(REPO_ROOT, "extensions", "infinity-harness", "index.ts")).href))
    .default;
  const { decideNext } = await import(pathToFileURL(join(REPO_ROOT, "src", "loop.ts")).href);
  const { loadRework } = await import(pathToFileURL(join(REPO_ROOT, "src", "rework.ts")).href);
  const { loadReplanHistory } = await import(pathToFileURL(join(REPO_ROOT, "src", "replan.ts")).href);

  const dir = mkProject("escalation", (c) => {
    c.currentPhase = "build";
    c.currentRole = "generator";
    c.commands.test = "exit 1";
    c.retry = { tasks: { max: 999, count: 0 }, features: { max: 999, count: 0 }, phases: { max: 999, count: 0 } };
  });
  writeFileSync(
    join(dir, "harness", "model-router.json"),
    JSON.stringify({
      enabled: true,
      byDifficulty: { easy: "small", moderate: "medium", difficult: "large" },
      master: "the-master-model",
      consultation: { enabled: true, maxPerTask: 1, oneStepOnly: true, requireExhaustion: true },
    }),
  );
  writePlanFile(dir, {
    version: "2.0",
    baseRevision: 1,
    goals: [{ id: "goal-001", title: "Prove the ladder climbs" }],
    sprints: [],
    features: [
      {
        id: "feature-001",
        name: "Ladder",
        passes: false,
        criteria: ["it escalates"],
        tasks: [
          { id: "task-001", key: "feature-001/task-001", description: "the root", status: "in_progress", difficulty: "moderate", dependsOn: [], subtasks: [] },
          { id: "task-002", key: "feature-001/task-002", description: "built on the root", status: "pending", dependsOn: ["feature-001/task-001"], subtasks: [] },
        ],
      },
    ],
  });

  const pi = fakePi();
  const ctx = fakeCtx(dir);
  adapter(pi.api);

  const rungs = [];
  let stop = null;
  await step("a stalled run climbs the whole ladder before it stops", async () => {
    for (let i = 0; i < 16; i++) {
      const { decision } = await decideNext({ targetDir: dir, runId: "e2e-run" });
      if (decision.action === "stop") {
        stop = decision;
        break;
      }
      const m = /escalated: ([a-z]+):/.exec(decision.reason ?? "");
      if (m) rungs.push(m[1]);
    }
    assert.deepEqual(rungs, ["retry", "reframe", "consult", "rework", "replan", "master"], rungs.join(" → "));
    assert.ok(stop, "and then it stops");
    assert.equal(stop.reason, "no-progress");
    assert.match(stop.detail, /retry → reframe → consult → rework → replan → master/);
  });

  await step("rework really moved the plan, not just the message", async () => {
    const record = loadRework(dir);
    assert.ok(record, "the return point is recorded");
    assert.equal(record.returnFeature, "feature-001");
    assert.deepEqual(record.impacted, ["feature-001/task-002"], "the dependent went with it");
    const plan = JSON.parse(readFileSync(join(dir, "harness", "features", "feature-list.json"), "utf-8"));
    const statuses = plan.features[0].tasks.map((t) => t.status);
    assert.deepEqual(statuses, ["rework", "rework"], "both tasks are back in rework");
  });

  await step("infinity_unstuck reports the ladder without acting on it", async () => {
    const before = readFileSync(join(dir, "harness", "features", "feature-list.json"), "utf-8");
    const result = await pi.call("infinity_unstuck", {}, ctx);
    assert.match(toolText(result), /ladder has nothing left|Next rung/);
    assert.equal(
      readFileSync(join(dir, "harness", "features", "feature-list.json"), "utf-8"),
      before,
      "asking what to do next must not do it",
    );
  });

  await step("infinity_replan adds what the plan was missing", async () => {
    const result = await pi.call(
      "infinity_replan",
      {
        reason: "the ladder said the plan was wrong",
        addTasks: [
          {
            featureId: "feature-001",
            task: { id: "task-003", key: "feature-001/task-003", description: "the thing nobody planned", status: "pending" },
          },
        ],
      },
      ctx,
    );
    assert.ok(!result.isError, toolText(result));
    assert.match(toolText(result), /\+1 task/);
    const plan = JSON.parse(readFileSync(join(dir, "harness", "features", "feature-list.json"), "utf-8"));
    assert.equal(plan.features[0].tasks.length, 3);
    assert.equal(loadReplanHistory(dir).length, 1, "and the amendment is on the record");
  });

  await step("infinity_rework refuses a task that does not exist", async () => {
    const bad = await pi.call("infinity_rework", { task: "feature-009/task-404" }, ctx);
    assert.ok(bad.isError);
    assert.match(toolText(bad), /No task matches/);
  });

  await step("a worker attempt is recorded even with nothing to run", async () => {
    const result = await pi.call(
      "infinity_spawn_worker",
      { task: "feature-001/task-003", prompt: "do the thing nobody planned" },
      ctx,
    );
    assert.ok(!result.isError, toolText(result));
    assert.match(toolText(result), /recorded only/);
    const attemptDir = result.details.attemptDir;
    assert.ok(existsSync(join(attemptDir, "prompt.md")), "the prompt is on disk for the next attempt to compare");
    assert.ok(existsSync(join(attemptDir, "fingerprint.json")));
  });

  await step("a worker that runs something reports what happened", async () => {
    const result = await pi.call(
      "infinity_spawn_worker",
      {
        task: "feature-001/task-003",
        prompt: "echo test",
        command: "cat {promptfile}",
        timeoutMs: 20_000,
      },
      ctx,
    );
    assert.ok(!result.isError, toolText(result));
    assert.equal(result.details.exitCode, 0);
    assert.match(toolText(result), /do the thing nobody planned|echo test/);
    assert.equal(result.details.attempt, 2, "attempts are numbered, not overwritten");
  });

  rmSync(dir, { recursive: true, force: true });
}

// ────────────────────────────────────────────────────────────────────────────
// goal — the outer loop, over a real pipeline
// ────────────────────────────────────────────────────────────────────────────
async function scenarioGoal() {
  const adapter = (await import(pathToFileURL(join(REPO_ROOT, "extensions", "infinity-harness", "index.ts")).href))
    .default;
  const { decideNext } = await import(pathToFileURL(join(REPO_ROOT, "src", "loop.ts")).href);

  const dir = mkProject("goal", (c) => {
    c.currentPhase = "ship";
    c.currentRole = "evaluator";
    c.phases = { enabled: ["define", "plan", "build", "verify", "review", "ship"] };
  });
  writePlanFile(dir, {
    version: "2.0",
    baseRevision: 1,
    goals: [],
    sprints: [],
    features: [
      {
        id: "feature-001",
        name: "Done work",
        passes: true,
        criteria: ["it works"],
        tasks: [{ id: "task-001", key: "feature-001/task-001", description: "the work", status: "complete", dependsOn: [], subtasks: [] }],
      },
    ],
  });

  const pi = fakePi();
  const ctx = fakeCtx(dir);
  adapter(pi.api);

  await step("with no goal, a finished pipeline is simply finished", async () => {
    const { decision } = await decideNext({ targetDir: dir, runId: "goal-e2e" });
    assert.equal(decision.action, "stop");
    assert.equal(decision.reason, "complete");
  });

  await step("/infinity:goal states the goal and rewinds the pipeline", async () => {
    await pi.command("infinity:goal", "Ship the payments rewrite behind a flag", ctx);
    const said = ctx.notices.map((n) => n.m).join("\n");
    assert.match(said, /Goal set: Ship the payments rewrite behind a flag/);
    const config = JSON.parse(readFileSync(join(dir, "harness", "config.json"), "utf-8"));
    assert.equal(config.currentPhase, "define", "a goal starts at the beginning");
    assert.ok(existsSync(join(dir, "harness", "goals", "GOAL_SPEC.json")), "the specification is committed");
    assert.ok(pi.userMessages.length >= 1, "and the model gets the new brief");
  });

  await step("a finished pipeline now asks whether the GOAL is met", async () => {
    // Put the pipeline back at the end, with the work done.
    const config = JSON.parse(readFileSync(join(dir, "harness", "config.json"), "utf-8"));
    config.currentPhase = "ship";
    writeFileSync(join(dir, "harness", "config.json"), JSON.stringify(config, null, 2));

    const { decision } = await decideNext({ targetDir: dir, runId: "goal-e2e" });
    assert.equal(decision.action, "continue", "the run does not end just because the plan did");
    assert.equal(decision.reason, "goal review");
    assert.match(decision.message, /THE PIPELINE IS DONE. THE GOAL MAY NOT BE/);
    assert.match(decision.message, /Ship the payments rewrite behind a flag/);
    assert.match(decision.message, /Do not mark it complete to end the run/);
  });

  await step("an honest 'not yet' starts another pass with the work named", async () => {
    const vague = await pi.call(
      "infinity_goal",
      { action: "review", decision: "incomplete", rationale: "not there" },
      ctx,
    );
    assert.ok(vague.isError, "a verdict with nothing named is a shrug");
    assert.match(toolText(vague), /must name what is still missing/);

    const real = await pi.call(
      "infinity_goal",
      {
        action: "review",
        decision: "incomplete",
        rationale: "the flag is missing and nothing measures the rollout",
        remainingWork: ["put it behind a feature flag", "add the latency metric"],
      },
      ctx,
    );
    assert.ok(!real.isError, toolText(real));
    assert.match(toolText(real), /Starting pass 2/);

    const config = JSON.parse(readFileSync(join(dir, "harness", "config.json"), "utf-8"));
    assert.equal(config.currentPhase, "define", "another pass starts at the beginning");
    assert.deepEqual(config.remainingWork, ["put it behind a feature flag", "add the latency metric"]);

    const brief = await pi.call("infinity_brief", {}, ctx);
    assert.match(toolText(brief), /judged not yet met/);
    assert.match(toolText(brief), /put it behind a feature flag/);
  });

  await step("a met goal ends the run and leaves a result", async () => {
    const status = await pi.call("infinity_goal", { action: "status" }, ctx);
    assert.match(toolText(status), /pass 2/);

    const config = JSON.parse(readFileSync(join(dir, "harness", "config.json"), "utf-8"));
    config.currentPhase = "ship";
    writeFileSync(join(dir, "harness", "config.json"), JSON.stringify(config, null, 2));
    await decideNext({ targetDir: dir, runId: "goal-e2e" });

    const done = await pi.call(
      "infinity_goal",
      { action: "review", decision: "complete", rationale: "flag is in, metric is live, both proved" },
      ctx,
    );
    assert.ok(!done.isError, toolText(done));
    assert.match(toolText(done), /Goal met after 2 pass/);
    assert.ok(existsSync(join(done.details.goalRunId ? dir : dir, "harness", "goal.json")));

    // And with the goal met, the pipeline finishing really is the end.
    const after = await decideNext({ targetDir: dir, runId: "goal-e2e" });
    assert.equal(after.decision.action, "stop");
    assert.equal(after.decision.reason, "complete");
  });

  rmSync(dir, { recursive: true, force: true });
}

async function scenarioColdStart() {
  const adapter = (await import(pathToFileURL(join(REPO_ROOT, "extensions", "infinity-harness", "index.ts")).href))
    .default;
  const { isHarnessProject } = await import(
    pathToFileURL(join(REPO_ROOT, "src", "core", "config.ts")).href
  );

  const dir = mkTempDir("coldstart");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "cold", scripts: { test: "node --test", lint: "eslint ." } }, null, 2),
  );

  const pi = fakePi();
  adapter(pi.api);

  await step("before init, every command says what to do instead of dead-ending", async () => {
    const ctx = fakeCtx(dir);
    await pi.emit("session_start", {}, ctx);
    assert.equal(pi.sent.length, 0, "a project with no harness is left completely alone");
    assert.equal(pi.userMessages.length, 0, "and is not spoken to at all");
    assert.deepEqual(ctx.widgets, {}, "and gets no widget");

    // Every command that needs a harness. `/infinity:next` used to print a
    // full page of pipeline instructions for a pipeline that did not exist,
    // and `/infinity:scroll` said nothing at all.
    for (const command of [
      "infinity:status",
      "infinity:next",
      "infinity:validate",
      "infinity:run",
      "infinity:halt",
      "infinity:pause",
      "infinity:resume",
      "infinity:config",
      "infinity:approve",
      "infinity:handoff",
      "infinity:scroll",
      "infinity:dashboard",
      "infinity:goal",
      "infinity:unstuck",
      "infinity:rework",
    ]) {
      ctx.notices.length = 0;
      await pi.command(command, "", ctx);
      const said = ctx.notices.map((n) => n.m).join("\n");
      assert.match(said, /No harness in this project yet/, `${command} said nothing useful`);
      assert.match(said, /\/infinity:init/, `${command} did not say how to fix it`);
    }
  });

  await step("/infinity:init asks what is being built before it starts building", async () => {
    // The bug this replaces: picking a mode was the *only* question, so
    // "autopilot" started a run with no idea and no scope, and the harness
    // invented a project. The wizard now asks for the goal whatever the
    // workflow.
    const ctx = fakeCtx(dir, [
      /^yes$/,
      /^copilot/,
      "reconcile Stripe payouts against the ledger",
      /every phase/,
      /no \u2014 use pi/,  // routing: off for this harness
      /^focus/,
      /start with these settings/,
    ]);
    await pi.command("infinity:init", "", ctx);

    assert.ok(isHarnessProject(dir), "the harness exists now");
    assert.match(ctx.asked[0].title, /Create a harness here\?/);
    assert.match(ctx.asked[0].title, /Node/, "and said what it detected");

    const titles = ctx.asked.map((a) => a.title).join("\n");
    assert.match(titles, /which phases, and which of them stop for you/);
    assert.match(titles, /What are you building/, "the goal is asked for, not assumed");
    assert.match(titles, /fresh session/);
    assert.match(titles, /How much of the plan/);

    const said = ctx.notices.map((n) => n.m).join("\n");
    assert.match(said, /infinity-harness ready/);
    assert.match(said, /npm run test/, "the detected commands are reported");
    assert.match(said, /DEFINE/);

    const config = cfg(dir);
    assert.equal(config.mode, "copilot");
    assert.equal(config.intake.brief, "reconcile Stripe payouts against the ledger");
    assert.equal(config.workflow?.id, "copilot", "the config records which workflow it came from");
    assert.deepEqual(
      { define: config.phaseModes.define, plan: config.phaseModes.plan, build: config.phaseModes.build },
      { define: "copilot", plan: "copilot", build: "autopilot" },
      "copilot signs the thinking phases and leaves the building alone",
    );
    assert.equal(config.display.preset, "focus", "and which display template");

    assert.ok(ctx.widgets["infinity-harness"]?.length, "the widget appears immediately");
    assert.equal(pi.userMessages.length, 1, "the session that created the harness gets the first brief");
    assert.match(pi.userMessages[0].text, /NEXT STEP · DEFINE/);
    assert.match(pi.userMessages[0].text, /reconcile Stripe payouts/, "and the goal it was given");
  });

  await step("a built-in workflow can put the checkpoint anywhere in the pipeline", async () => {
    const late = mkTempDir("coldstart-late");
    writeFileSync(join(late, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    const ctx = fakeCtx(late, [
      /^yes$/,
      /^spec and ship/,
      "a nightly reconciliation job",
      /every phase/,
      /no — use pi/,  // routing: off for this harness
      /^overview/,
      /start with these settings/,
    ]);
    await pi.command("infinity:init", "", ctx);

    const config = cfg(late);
    // The shape a single copilot/autopilot switch could not express.
    assert.equal(config.phaseModes.define, "copilot", "you sign the scope going in");
    assert.equal(config.phaseModes.ship, "copilot", "and the release coming out");
    assert.equal(config.phaseModes.plan, "autopilot", "the middle is its own");
    assert.equal(config.phaseModes.build, "autopilot");
    assert.equal(config.display.levels.task, false, "and the display template came with it");
    rmSync(late, { recursive: true, force: true });
  });

  await step("a custom workflow is built phase by phase, named, and offered next time", async () => {
    const store = mkTempDir("coldstart-store");
    const custom = mkTempDir("coldstart-custom");
    writeFileSync(join(custom, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));

    // The store lives with the person, not the project, so point it somewhere
    // this test owns.
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = store;
    try {
      const ctx = fakeCtx(custom, [
        /^yes$/,
        /build one/,
        // Phases: add RESEARCH, then done.
        (_t, options) => options.find((o) => /\[ \] research/.test(o)),
        (_t, options) => options.at(-1),
        // A mode for each, in pipeline order.
        /copilot/, // research
        /autopilot/, // define
        /autopilot/, // plan
        /autopilot/, // build
        /autopilot/, // verify
        /copilot/, // review
        /copilot/, // ship
        /save it under a name/,
        "Client work",
        "a client project",
        /every phase/,
        /no \u2014 use pi/,  // routing: off for this harness
        /^everything/,
        /start with these settings/,
      ]);
      await pi.command("infinity:init", "", ctx);

      const config = cfg(custom);
      assert.ok(config.phases.enabled.includes("research"));
      assert.equal(config.phaseModes.research, "copilot");
      assert.equal(config.phaseModes.plan, "autopilot");
      assert.equal(config.phaseModes.review, "copilot");
      assert.equal(config.phaseModes.ship, "copilot");
      assert.equal(config.workflow?.name, "Client work");
      assert.equal(config.display.levels.subtask, "all");

      const saved = JSON.parse(
        readFileSync(join(store, "infinity-harness", "workflows.json"), "utf-8"),
      );
      assert.equal(saved.workflows.length, 1, "it was written to the person's store");
      assert.equal(saved.workflows[0].name, "Client work");

      // And a second project is offered it.
      const next = mkTempDir("coldstart-reuse");
      writeFileSync(join(next, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
      const ctx2 = fakeCtx(next, [
        /^yes$/,
        /Client work \(yours\)/,
        "the next one",
        /every phase/,
        /no — use pi/,
        /^focus/,
        /start with these settings/,
      ]);
      await pi.command("infinity:init", "", ctx2);
      assert.equal(cfg(next).workflow?.name, "Client work", "a saved workflow is reusable");
      assert.equal(cfg(next).phaseModes.ship, "copilot");
      rmSync(next, { recursive: true, force: true });
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(store, { recursive: true, force: true });
      rmSync(custom, { recursive: true, force: true });
    }
  });

  await step("forfeiting every signature is allowed, and says what it means", async () => {
    const walkAway = mkTempDir("coldstart-walkaway");
    writeFileSync(join(walkAway, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    const ctx = fakeCtx(walkAway, [
      /^yes$/,
      /^autopilot/,
      "a URL shortener",
      /every phase/,
      /no \u2014 use pi/,  // routing: off for this harness
      /^focus/,
      /start with these settings/,
    ]);
    await pi.command("infinity:init", "", ctx);

    const config = cfg(walkAway);
    assert.ok(
      Object.values(config.phaseModes).every((m) => m === "autopilot"),
      "autopilot stops nowhere",
    );
    const said = ctx.notices.map((n) => n.m).join("\n");
    assert.match(said, /Nothing is being approved by you/, "the trade-off is stated, not buried");
    rmSync(walkAway, { recursive: true, force: true });
  });

  await step("with no goal given, the run asks for one instead of inventing a project", async () => {
    const vague = mkTempDir("coldstart-vague");
    writeFileSync(join(vague, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    const before = pi.userMessages.length;
    const ctx = fakeCtx(vague, [
      /^yes$/,
      /^autopilot/,
      "",
      /every phase/,
      /no \u2014 use pi/,  // routing: off for this harness
      /^focus/,
      /start with these settings/,
    ]);
    await pi.command("infinity:init", "", ctx);

    const opener = pi.userMessages.at(-1).text;
    assert.ok(pi.userMessages.length > before);
    assert.match(opener, /has not said what they want built/);
    assert.match(opener, /do not start any work or invent a scope/);
    assert.match(
      ctx.notices.map((n) => n.m).join("\n"),
      /No goal was given/,
      "and the human is told that is what will happen",
    );
    rmSync(vague, { recursive: true, force: true });
  });

  await step("the workflow and the display can both be changed mid-run", async () => {
    // Everything the wizard set is editable afterwards, because a run three
    // phases deep is exactly when someone realises they do want to see the
    // review after all.
    const ctx = fakeCtx(dir, []);
    await pi.command("infinity:workflow", "every-gate", ctx);
    const after = cfg(dir);
    assert.ok(
      after.phases.enabled.every((p) => after.phaseModes[p] === "copilot"),
      "switching workflow by name rewrites every mode",
    );
    assert.equal(after.workflow?.id, "every-gate");
    assert.match(ctx.notices.map((n) => n.m).join("\n"), /\[define\]/, "and shows what it now does");

    await pi.command("infinity:display", "worklist", ctx);
    assert.equal(cfg(dir).display.levels.feature, false, "and the display too");
    assert.equal(cfg(dir).display.levels.task, true);

    ctx.notices.length = 0;
    await pi.command("infinity:workflow", "no-such-thing", ctx);
    assert.match(ctx.notices.map((n) => n.m).join("\n"), /No workflow called/, "a typo is reported, not applied");
    assert.equal(cfg(dir).workflow?.id, "every-gate", "and changes nothing");

    ctx.notices.length = 0;
    await pi.command("infinity:workflow", "list", ctx);
    const listed = ctx.notices.map((n) => n.m).join("\n");
    assert.match(listed, /copilot/);
    assert.match(listed, /every gate/);

    // Put it back so the later steps see the harness they expect.
    await pi.command("infinity:workflow", "copilot", ctx);
    await pi.command("infinity:display", "focus", ctx);
  });

  await step("cancelling writes nothing", async () => {
    const fresh = mkTempDir("coldstart-cancel");
    const ctx = fakeCtx(fresh, ["cancel"]);
    await pi.command("infinity:init", "", ctx);
    assert.equal(isHarnessProject(fresh), false, "cancel means cancel");
    assert.equal(readdirSync(fresh).length, 0, "not one file was written");
    assert.match(ctx.notices.map((n) => n.m).join("\n"), /cancelled/);
  });

  await step("a second init refuses, and says what to run instead", async () => {
    const ctx = fakeCtx(dir, [/^yes$/]);
    await pi.command("infinity:init", "", ctx);
    const said = ctx.notices.map((n) => n.m).join("\n");
    assert.match(said, /already has a harness/);
    assert.match(said, /\/infinity:config/);
    assert.equal(ctx.asked.length, 0, "it did not even ask");
  });

  await step("with no dialogs it takes the detected defaults rather than stalling", async () => {
    const headless = mkTempDir("coldstart-headless");
    writeFileSync(join(headless, "go.mod"), "module cold\n");
    const ctx = fakeCtx(headless); // hasUI false
    await pi.command("infinity:init", "", ctx);
    assert.ok(isHarnessProject(headless), "an unattended run still gets a harness");
    assert.equal(ctx.asked.length, 0, "and was never asked a question nobody would answer");
    const config = JSON.parse(readFileSync(join(headless, "harness", "config.json"), "utf-8"));
    assert.equal(config.stack, "go");
    assert.equal(config.commands.test, "go test ./...");
    // Autopilot with nothing signed, because a run parked on an approval
    // nobody can answer is a run that never finishes.
    assert.equal(config.mode, "autopilot");
    assert.equal(config.approvals.define, false);
    assert.match(
      ctx.notices.map((n) => n.m).join("\n"),
      /no dialogs/i,
      "and it says so rather than pretending the human chose this",
    );
  });

  await step("the freshly-made harness is a working one: brief, plan, gate", async () => {
    const ctx = fakeCtx(dir);

    // The brief the model would act on.
    const brief = await pi.call("infinity_brief", {}, ctx);
    assert.match(toolText(brief), /NEXT STEP · DEFINE/);
    assert.match(toolText(brief), /infinity_validate/, "and it names a tool that exists");

    // DEFINE opens only once features carry criteria — so write a plan.
    // Nesting tasks inside a feature is the obvious wrong guess; it must say
    // where they actually go rather than dropping them.
    const wrongShape = await pi.call(
      "infinity_plan",
      { features: [{ id: "feature-001", tasks: [{ id: "task-001" }] }] },
      ctx,
    );
    assert.ok(wrongShape.isError, "nested tasks should be refused");
    assert.match(toolText(wrongShape), /top-level "tasks" array/);

    // DEFINE is about criteria, and tasks do not exist yet — so this writes
    // feature metadata with no `tasks` field at all.
    const defined = await pi.call(
      "infinity_plan",
      {
        baseRevision: 0,
        goal: "Prove a cold start reaches a working pipeline",
        features: [{ id: "feature-001", name: "First feature", criteria: ["it does the thing"] }],
      },
      ctx,
    );
    assert.ok(!defined.isError, toolText(defined));

    const read = await pi.call("infinity_plan", {}, ctx);
    assert.match(toolText(read), /Goal: Prove a cold start/);
    assert.match(toolText(read), /it does the thing/, "the read view shows the criteria it is judged on");

    const gate = await pi.call("infinity_validate", {}, ctx);
    assert.match(toolText(gate), /Gate PASS/, `DEFINE should open with criteria set:\n${toolText(gate)}`);

    const advanced = await pi.call("infinity_advance", {}, ctx);
    assert.ok(!advanced.isError, toolText(advanced));
    const config = JSON.parse(readFileSync(join(dir, "harness", "config.json"), "utf-8"));
    assert.equal(config.currentPhase, "plan", "the pipeline moved, from a harness that did not exist");
  });

  await step("init restores what was deleted without touching what was written", async () => {
    const rubric = join(dir, "harness", "evaluator-rubric.md");
    writeFileSync(join(dir, "harness", "docs", "ARCHITECTURE.md"), "# Arch\n\nSomething real.\n");
    rmSync(rubric);
    const ctx = fakeCtx(dir, [
      /^yes$/,
      /^copilot/,
      "reconcile Stripe payouts against the ledger",
      /every phase/,
      /no \u2014 use pi/,  // routing: off for this harness
      /^focus/,
      /start with these settings/,
    ]);
    await pi.command("infinity:init", "force", ctx);
    assert.ok(existsSync(rubric), "the missing file came back");
    assert.match(
      readFileSync(join(dir, "harness", "docs", "ARCHITECTURE.md"), "utf-8"),
      /Something real/,
      "and the written one was left alone",
    );
  });

  rmSync(dir, { recursive: true, force: true });
}

async function scenarioPackage() {
  const { auditSkillsDir, formatAudit } = await import(
    pathToFileURL(join(REPO_ROOT, "src", "core", "skillsAudit.ts")).href,
  );

  const workdir = mkTempDir("package");
  let tarball;
  await step("npm pack produces a tarball", async () => {
    const res = spawnSync("npm", ["pack", "--pack-destination", workdir, "--silent"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: 120_000,
    });
    assert.equal(res.status, 0, `npm pack failed: ${res.stderr || res.stdout}`);
    const files = readdirSync(workdir).filter((f) => f.endsWith(".tgz"));
    assert.equal(files.length, 1, `expected one tarball, got ${files.join(", ")}`);
    tarball = join(workdir, files[0]);
  });

  const root = join(workdir, "package");
  await step("it extracts with no symlink and no path escaping the package", async () => {
    const listing = execFileSync("tar", ["-tvzf", tarball], { encoding: "utf-8" });
    for (const line of listing.split("\n")) {
      if (!line.trim()) continue;
      assert.ok(!line.startsWith("l"), `tarball contains a symlink: ${line}`);
      const name = line.slice(line.indexOf("package/"));
      assert.ok(name.startsWith("package/"), `entry outside the package root: ${line}`);
      assert.ok(!name.includes(".."), `entry escapes the package root: ${line}`);
    }
    execFileSync("tar", ["-xzf", tarball, "-C", workdir]);
    assert.ok(existsSync(root), "the tarball extracted to package/");
  });

  const packed = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
  const local = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));

  await step("what pi is told to load is actually inside it", async () => {
    assert.equal(packed.version, local.version, "the packed version is the repo's version");
    for (const entry of packed.pi?.extensions ?? []) {
      assert.ok(existsSync(join(root, entry)), `pi.extensions "${entry}" is not in the tarball`);
    }
    for (const entry of packed.pi?.skills ?? []) {
      assert.ok(existsSync(join(root, entry)), `pi.skills "${entry}" is not in the tarball`);
    }
    for (const file of ["README.md", "LICENSE", "CHANGELOG.md"]) {
      assert.ok(existsSync(join(root, file)), `${file} is not in the tarball`);
    }
    // The symlinks that made 1.x uninstallable pointed at a sibling checkout.
    for (const gone of ["cli", "prompts", "skills"]) {
      assert.ok(!existsSync(join(root, gone)), `${gone}/ is back in the package`);
    }
  });

  await step("the shipped skills load cleanly in pi — no conflict block on start", async () => {
    for (const entry of packed.pi?.skills ?? []) {
      const audit = auditSkillsDir(join(root, entry));
      assert.equal(audit.problems.length, 0, `${entry} in the tarball:\n${formatAudit(audit, root)}`);
      assert.ok(audit.skills.length > 0, `${entry} ships no skills`);
    }
  });

  let reachable;
  await step("every module the extension imports is in the tarball too", async () => {
    // A file left out of package.json "files" is invisible here and fatal
    // after install, where the first import throws instead of the last test
    // failing.
    const entry = join(root, packed.pi.extensions[0], "infinity-harness", "index.ts");
    assert.ok(existsSync(entry), `extension entry point missing: ${entry}`);

    // Static and dynamic: `src/remote.ts` is deliberately deferred behind
    // `await import(...)` so the dashboard's HTTP server never loads unless
    // someone opens it.
    const SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.[^"']+)["']/g;
    const seen = new Set();
    const queue = [entry];
    while (queue.length) {
      const file = queue.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, "utf-8");
      for (const [, spec] of source.matchAll(SPEC)) {
        const resolved = resolve(dirname(file), spec);
        assert.ok(
          existsSync(resolved),
          `${relative(root, file)} imports "${spec}", which npm did not publish`,
        );
        if (resolved.endsWith(".ts")) queue.push(resolved);
      }
    }
    reachable = seen;
    assert.ok(seen.size >= 20, `expected the src tree to be reachable, walked ${seen.size}`);
  });

  await step("nothing new ships that the extension cannot reach", async () => {
    // "The tested code was not the shipped code" was this project's worst bug:
    // the extension carried inlined copies of modules the tests exercised in
    // `src/`, so the suite was green about code nobody ran. This is the guard
    // against the mirror image — a module that ships, typechecks and passes
    // tests while no code path in the running product can reach it.
    //
    // Everything on this list is real, tested, and currently unreachable from
    // the extension. It is debt, recorded here so it cannot grow quietly and
    // cannot be mistaken for shipped behaviour.
    // This list is empty, and keeping it empty is the point.
    //
    // Nine modules once shipped with no path to them: the escalation ladder,
    // rework, replan, the review bounce guard, isolated workers, the whole
    // goal loop, and the skills audit. They typechecked, they passed their
    // tests, and no code path in the running product could reach a single one.
    // The README advertised them. That is the mirror image of this project's
    // worst bug — tested code that was not shipped code — and it survived for
    // months because nothing looked.
    const KNOWN_UNREACHABLE = new Map([]);

    const shipped = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".ts")) shipped.push(full);
      }
    };
    walk(join(root, "src"));

    const orphans = shipped
      .filter((f) => !reachable.has(f))
      .map((f) => relative(root, f).split("\\").join("/"));
    const unexpected = orphans.filter((f) => !KNOWN_UNREACHABLE.has(f));
    assert.deepEqual(
      unexpected,
      [],
      `these modules ship but nothing in the extension can reach them:\n  ${unexpected.join("\n  ")}`,
    );

    const fixed = [...KNOWN_UNREACHABLE.keys()].filter((f) => !orphans.includes(f));
    assert.deepEqual(fixed, [], `wired in at last — delete from KNOWN_UNREACHABLE: ${fixed.join(", ")}`);
    out(`      note: ${reachable.size} modules reachable, ${orphans.length} orphaned`);
  });

  await step("no shipped text file carries a UTF-8 BOM", async () => {
    // Windows editors add one, JSON.parse rejects it, and the failure reads as
    // "config is missing or unreadable" with no clue why.
    const offenders = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|json|md|mjs)$/.test(name)) continue;
        const head = readFileSync(full).subarray(0, 3);
        if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) offenders.push(relative(root, full));
      }
    };
    walk(root);
    assert.deepEqual(offenders, [], `BOM found in: ${offenders.join(", ")}`);
  });

  rmSync(workdir, { recursive: true, force: true });
}

async function scenarioLive() {
  if (NO_LIVE) throw new SkipLeg("--no-live");

  const probe = await probeLiveEndpoint();
  if (!probe.reachable) throw new SkipLeg(`${LIVE_BASE_URL} unreachable — ${probe.why}`);
  if (!probe.model) throw new SkipLeg(`${LIVE_BASE_URL} answered but advertised no models`);
  note(`model: ${probe.model} (of ${probe.models.length} advertised)`);

  const dir = mkProject("live", (c) => {
    c.currentPhase = "plan";
    c.currentRole = "planner";
  });
  writePlanFile(dir, {
    version: "2.0",
    baseRevision: 0,
    goals: [{ id: "goal-001", title: "Add a CSV export to the reporting page" }],
    sprints: [],
    features: [{ id: "feature-001", name: "CSV export", passes: false, criteria: ["downloads a well-formed CSV"], tasks: [] }],
  });

  const chat = async (messages, maxTokens) => {
    const res = await liveFetch("/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: probe.model, messages, max_tokens: maxTokens, temperature: 0 }),
    });
    if (!res.ok) throw new Error(`chat/completions → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    const choice = body?.choices?.[0];
    const text = choice?.message?.content;

    // A reasoning model can spend its whole budget thinking and return
    // content:null with finish_reason "length". That is a budget problem, not
    // an endpoint problem, so say which it is rather than asserting on a type.
    if (typeof text !== "string") {
      const reason = choice?.finish_reason ?? "unknown";
      const used = body?.usage?.completion_tokens ?? "?";
      throw new Error(
        reason === "length"
          ? `the model hit the ${maxTokens}-token cap before emitting any content ` +
            `(finish_reason=length, completion_tokens=${used}) — raise the cap for this model`
          : `no completion text (finish_reason=${reason}): ${JSON.stringify(body).slice(0, 240)}`,
      );
    }
    return text;
  };

  await step("a real completion reads the brief the harness generated", async () => {
    const brief = renderBrief(await buildBrief(dir), cfg(dir));
    const answer = await chat(
      [
        { role: "system", content: "Answer with one lowercase word and nothing else." },
        { role: "user", content: `${brief}\n\nWhich phase is this brief for?` },
      ],
      LIVE_MAX_TOKENS,
    );
    note(`answer: ${JSON.stringify(answer.trim())}`);
    assert.ok(answer.trim().length > 0, "the model returned an empty completion");
    assert.match(answer.toLowerCase(), /plan/, "the brief did not carry its own phase to the model");
  });

  await step("real model output is either accepted by the plan editor or rejected legibly", async () => {
    const raw = await chat(
      [
        {
          role: "system",
          content:
            'Reply with JSON only: {"tasks":[{"key":"feature-001/task-001","subject":"...","status":"pending"}]}. ' +
            "Two tasks maximum. No prose, no code fences.",
        },
        { role: "user", content: "Plan the work for: add a CSV export to the reporting page." },
      ],
      LIVE_MAX_TOKENS,
    );
    note(`raw: ${raw.replace(/\s+/g, " ").slice(0, 200)}`);

    let parsed = null;
    const json = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    try {
      parsed = JSON.parse(json);
    } catch {
      note("the model did not return parseable JSON — that is the model's problem, not the harness's");
    }

    if (parsed && Array.isArray(parsed.tasks)) {
      try {
        const result = writeTaskList(dir, { baseRevision: 0, tasks: parsed.tasks });
        assert.equal(result.revision, 1, "an accepted write bumps the revision exactly once");
        assert.ok(result.tasks.length > 0);
        assert.equal(revisionOf(dir), 1);
        note(`accepted ${result.tasks.length} task(s)`);
      } catch (e) {
        assert.equal(e.name, "ValidationError", `a bad plan must be a ValidationError, not ${e.name}: ${e.message}`);
        assert.ok(e.message.length > 20, "a rejection has to tell the model what to fix");
        assert.equal(revisionOf(dir), 0, "a rejected write left the plan alone");
        note(`rejected: ${e.message}`);
      }
    } else {
      assert.equal(revisionOf(dir), 0, "nothing was written from unparseable output");
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// runner
// ═══════════════════════════════════════════════════════════════════════════

// ── real pi ─────────────────────────────────────────────────────────────────
//
// Every other scenario in this file drives our own modules, or drives the
// adapter against a *fake* pi. That is a fair test of our contracts and a poor
// test of pi's: the bugs that reached users — a BOM that made every config
// read fail, a run that ended at its first session handoff, a brief queued in
// a delivery mode that deadlocks `pi -p` — all lived in the gap between what
// we thought pi did and what it does.
//
// This scenario closes the gap. It starts a real `pi --mode rpc` process
// against a scripted model server and speaks the RPC protocol to it: typing
// prompts and slash commands, answering `ctx.ui.select` dialogs, and reading
// back the widget and the notifications the human would actually see.

async function scenarioRealPi() {
  const rig = pathToFileURL(join(REPO_ROOT, "scripts", "rig", "pi-driver.mjs")).href;
  const { PiDriver, startMockModel } = await import(rig);

  const piBin = join(REPO_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  if (!existsSync(piBin)) throw new SkipLeg("pi is not installed (npm ci first)");

  const EXT = join(REPO_ROOT, "extensions", "infinity-harness", "index.ts");
  const workdir = mkTempDir("realpi");
  const scriptPath = join(workdir, "model.json");
  const reqLog = join(workdir, "requests.jsonl");
  writeFileSync(scriptPath, JSON.stringify({ default: { content: "Working." } }));

  const mock = await startMockModel(scriptPath, reqLog);
  let seq = 0;
  const drivers = [];

  /** A fresh pi process on a fresh project, with the harness already made. */
  const launch = (name, { initOptions = {}, plan = null, settings = {}, contextWindow = 40000 } = {}) => {
    const dir = mkTempDir(`realpi-${name}`);
    gitInit(dir);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "demo", version: "1.0.0", scripts: { test: "node -e 0", lint: "node -e 0" } }),
    );
    writeFileSync(join(dir, "README.md"), `# demo\n\n${"x".repeat(300)}\n`);
    writeFileSync(join(dir, "LICENSE"), "MIT\n");
    writeFileSync(join(dir, "CHANGELOG.md"), `# Changelog\n\n${"y".repeat(200)}\n`);
    gitCommitAll(dir, "chore: initial commit");
    if (initOptions !== false) {
      const r = initHarness(dir, initOptions);
      assert.equal(r.ok, true, r.error ?? "initHarness failed");
      if (plan) writePlanFile(dir, plan);
    }
    const driver = new PiDriver({
      cwd: dir,
      configDir: join(workdir, `pi-${++seq}`),
      sessionDir: join(workdir, `sessions-${seq}`),
      port: mock.port,
      extensions: [EXT],
      contextWindow,
      settings,
    }).start();
    drivers.push(driver);
    // `configDir` is where the harness keeps the *person's* saved workflows and
    // display templates, under `infinity-harness/` — a scenario that saves one
    // looks for it there.
    return {
      dir,
      driver,
      sessionDir: join(workdir, `sessions-${seq}`),
      configDir: join(workdir, `pi-${seq}`),
    };
  };

  const settled = (d, ms = 60_000) => d.settle(d.events.length ? d.events.length - 1 : 0, ms);
  const waitUntil = async (fn, ms, what) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.fail(`timed out waiting for ${what}`);
  };

  try {
    await step("real pi loads the extension, briefs the model and paints the widget", async () => {
      const { driver } = launch("start", { initOptions: { mode: "copilot", brief: "a demo project" } });
      await driver.waitForUi((r) => r.method === "setWidget", 40_000, "the plan widget");

      const widget = driver.widget().join("\n");
      assert.match(widget, /INFINITY/, "the widget is drawn in a real terminal session");
      assert.match(widget, /DEFINE/, "and says where the pipeline is");
      assert.match(widget, /a demo project/, "and what the human asked for");
      // setWidget and setStatus are two separate fire-and-forget requests, so
      // waiting only for the first races the second.
      await driver.waitForUi((r) => r.method === "setStatus", 20_000, "the status line");
      assert.ok(driver.statuses.get("infinity"), "the status line is set too");
      assert.match(driver.notes(), /infinity-harness active/);

      await driver.prompt("hello");
      await settled(driver);
      const brief = driver.transcript().find((m) => /NEXT STEP · DEFINE/.test(m.text));
      assert.ok(brief, "the brief actually reached the model, not just the screen");
    });

    await step("the start-up wizard runs inside real pi, and writes what was chosen", async () => {
      const { dir, driver } = launch("wizard", { initOptions: false });
      await new Promise((r) => setTimeout(r, 1500));

      driver.answer((r) => /Create a harness here/.test(r.title ?? ""), (r) => r.options[0]);
      driver.answer((r) => /which phases, and which of them stop for you/.test(r.title ?? ""), (r) =>
        r.options.find((o) => /^research first/.test(o)),
      );
      driver.answer((r) => /What are you building/.test(r.title ?? ""), "a nightly reconciliation job");
      driver.answer((r) => /fresh session/.test(r.title ?? ""), (r) => r.options[0]);
      driver.answer((r) => /Route work by difficulty/.test(r.title ?? ""), (r) => r.options.find((o) => /no \u2014 use pi/i.test(o)) ?? r.options[0]);
      driver.answer((r) => /How much of the plan/.test(r.title ?? ""), (r) =>
        r.options.find((o) => /^everything/.test(o)),
      );
      driver.answer((r) => /Ready\?/.test(r.title ?? ""), (r) => r.options[0]);

      await driver.prompt("/infinity:init");
      await waitUntil(async () => existsSync(join(dir, "harness", "config.json")), 40_000, "the harness to be written");
      await new Promise((r) => setTimeout(r, 800));

      const config = JSON.parse(readFileSync(join(dir, "harness", "config.json"), "utf-8"));
      assert.equal(config.intake.brief, "a nightly reconciliation job", "the goal it was told, not one it invented");
      assert.equal(config.workflow.id, "research-first");
      assert.ok(config.phases.enabled.includes("research"));
      assert.equal(config.currentPhase, "research");
      assert.equal(config.phaseModes.research, "copilot");
      assert.equal(config.phaseModes.define, "copilot");
      assert.equal(config.phaseModes.build, "autopilot");
      assert.equal(config.display.levels.subtask, "all", "the display template was applied too");
      assert.ok(existsSync(join(dir, "harness", "docs", "RESEARCH.md")));

      const asked = driver.uiRequests.filter((r) => r.method === "select" || r.method === "input");
      note(`${asked.length} dialogs answered as a human would`);
    });

    await step("a workflow is built phase by phase inside real pi, and kept for next time", async () => {
      // The whole point of a custom workflow is that it survives the project
      // it was designed in, so this checks the store on disk as well as the
      // config it produced.
      const { dir, driver, configDir } = launch("custom", { initOptions: false });
      const store = join(configDir, "infinity-harness");
      await new Promise((r) => setTimeout(r, 1500));

      driver.answer((r) => /Create a harness here/.test(r.title ?? ""), (r) => r.options[0]);
      driver.answer((r) => /which phases, and which of them stop for you/.test(r.title ?? ""), (r) =>
        r.options.find((o) => /build one/.test(o)),
      );
      // Phases: turn RESEARCH on, then finish.
      driver.answer((r) => /Which phases should run/.test(r.title ?? ""), (r) =>
        r.options.find((o) => /\[ \] research/.test(o)),
      );
      driver.answer((r) => /Which phases should run/.test(r.title ?? ""), (r) => r.options.at(-1));
      // A mode for each phase, in pipeline order. The interesting shape: the
      // model thinks for itself and still shows you the release.
      for (const [phase, want] of [
        ["RESEARCH", /autopilot/],
        ["DEFINE", /autopilot/],
        ["PLAN", /autopilot/],
        ["BUILD", /autopilot/],
        ["VERIFY", /autopilot/],
        ["REVIEW", /copilot/],
        ["SHIP", /copilot/],
      ]) {
        driver.answer(
          (r) => new RegExp(`^${phase} —`).test(r.title ?? ""),
          (r) => r.options.find((o) => want.test(o)),
        );
      }
      driver.answer((r) => /Keep this workflow/.test(r.title ?? ""), (r) =>
        r.options.find((o) => /save it under a name/.test(o)),
      );
      driver.answer((r) => /Call it what/.test(r.title ?? ""), "Ship review");
      driver.answer((r) => /What are you building/.test(r.title ?? ""), "an internal tool");
      driver.answer((r) => /fresh session/.test(r.title ?? ""), (r) => r.options[0]);
      driver.answer((r) => /Route work by difficulty/.test(r.title ?? ""), (r) => r.options.find((o) => /no \u2014 use pi/i.test(o)) ?? r.options[0]);
      driver.answer((r) => /How much of the plan/.test(r.title ?? ""), (r) => r.options[0]);
      driver.answer((r) => /Ready\?/.test(r.title ?? ""), (r) => r.options[0]);

      await driver.prompt("/infinity:init");
      await waitUntil(async () => existsSync(join(dir, "harness", "config.json")), 40_000, "the harness to be written");
      await new Promise((r) => setTimeout(r, 800));

      const config = JSON.parse(readFileSync(join(dir, "harness", "config.json"), "utf-8"));
      assert.equal(config.workflow.name, "Ship review");
      assert.equal(config.phaseModes.plan, "autopilot", "the middle really is left alone");
      assert.equal(config.phaseModes.review, "copilot");
      assert.equal(config.phaseModes.ship, "copilot");

      const saved = JSON.parse(readFileSync(join(store, "workflows.json"), "utf-8"));
      assert.equal(saved.workflows.length, 1, "it was written to the person's store, not the project's");
      assert.equal(saved.workflows[0].name, "Ship review");
      assert.equal(saved.workflows[0].modes.review, "copilot");

      assert.deepEqual(driver.events.filter((e) => e.type === "extension_error"), []);
    });

    await step("the display template changes what the widget draws, live", async () => {
      const { driver } = launch("display", {
        initOptions: { mode: "autopilot", brief: "a demo" },
        plan: {
          version: "2.0",
          baseRevision: 1,
          goals: [{ id: "goal-001", title: "Reconcile payouts" }],
          sprints: [{ id: "sprint-001", name: "Foundations", goalId: "goal-001" }],
          features: [
            {
              id: "feature-001",
              name: "Ledger import",
              sprintId: "sprint-001",
              goalId: "goal-001",
              criteria: ["it works"],
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
          ],
        },
      });
      await driver.waitForUi((r) => r.method === "setWidget", 40_000, "the plan widget");

      const drawn = async () => {
        await new Promise((r) => setTimeout(r, 600));
        return (driver.widget() ?? []).join("\n");
      };

      const focus = await drawn();
      assert.match(focus, /Foundations/, "focus draws the sprint");
      assert.match(focus, /Parse the payout CSV/);

      await driver.prompt("/infinity:display overview");
      const overview = await drawn();
      assert.match(overview, /Foundations/, "overview keeps the shape");
      assert.doesNotMatch(overview, /Parse the payout CSV/, "and drops the work");

      await driver.prompt("/infinity:display worklist");
      const worklist = await drawn();
      assert.doesNotMatch(worklist, /Foundations/, "worklist drops the grouping rows");
      assert.match(worklist, /Parse the payout CSV/, "and keeps the work");
      assert.doesNotMatch(worklist, /◉ BUILD|◉ DEFINE/, "and the phase rail with them");

      await driver.prompt("/infinity:display everything");
      const everything = await drawn();
      assert.match(everything, /handle the BOM/, "everything shows every subtask");

      await driver.prompt("/infinity:display no-such-template");
      await new Promise((r) => setTimeout(r, 600));
      assert.match(driver.notes(), /No template called/, "a typo is reported rather than applied");
      assert.match((driver.widget() ?? []).join("\n"), /handle the BOM/, "and changes nothing");

      assert.deepEqual(driver.events.filter((e) => e.type === "extension_error"), []);
    });

    await step("a run spans several real pi sessions, and its budgets survive them", async () => {
      const { dir, driver, sessionDir } = launch("handoff", {
        initOptions: { mode: "autopilot", brief: "a demo", session: { handoff: "phase" } },
        plan: {
          version: "2.0",
          baseRevision: 1,
          goals: [{ id: "goal-001", title: "a demo" }],
          sprints: [{ id: "sprint-001", name: "S1", goalId: "goal-001" }],
          features: [
            {
              id: "feature-001",
              name: "F1",
              sprintId: "sprint-001",
              goalId: "goal-001",
              criteria: ["it demonstrably works"],
              tasks: [{ id: "task-001", description: "do the thing", status: "complete", dependsOn: [], subtasks: [] }],
            },
          ],
        },
      });
      await driver.waitForUi((r) => r.method === "setWidget", 40_000, "the plan widget");
      await driver.prompt("/infinity:run");

      await waitUntil(async () => /run finished/.test(driver.notes()), 120_000, "the run to finish");

      const files = readdirSync(sessionDir, { recursive: true }).filter((f) => String(f).endsWith(".jsonl"));
      assert.ok(files.length >= 3, `the run should span several sessions, got ${files.length}`);

      const run = JSON.parse(readFileSync(join(dir, "harness", "run.json"), "utf-8"));
      assert.ok(run.sessions >= 3, "and the run counted them");
      assert.equal(run.armed, false, "a finished run is disarmed on disk, not just in memory");
      assert.ok(run.stopReason, "and says why it stopped");

      // One run id across every session is what keeps the wall-clock budget,
      // the iteration ceiling and the escalation ladder from resetting each
      // time the harness starts a fresh session.
      const loop = JSON.parse(readFileSync(join(dir, "harness", "loop-state.json"), "utf-8"));
      assert.equal(loop.runId, run.runId, "every session drove the same run");
      assert.ok(loop.iterations >= files.length, "the iteration budget carried across sessions");

      assert.match(driver.notes(), /new session — phase/, "and the human was told each time");
      assert.deepEqual(
        driver.events.filter((e) => e.type === "extension_error"),
        [],
        "no extension errors along the way",
      );
    });

    await step("the run survives real auto-compaction", async () => {
      // A model whose replies are long and whose reported context is nearly
      // full: pi compacts on its own, exactly as it would on a real long run.
      writeFileSync(
        scriptPath,
        JSON.stringify({
          default: {
            content: `Working. ${"Lorem ipsum dolor sit amet consectetur adipiscing elit. ".repeat(400)}`,
            prompt_tokens: 11_500,
          },
        }),
      );

      const { dir, driver } = launch("compaction", {
        initOptions: { mode: "autopilot", brief: "a demo", session: { handoff: "off", contextThreshold: 0 } },
        contextWindow: 12_000,
        settings: { compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 3000 } },
      });
      await driver.waitForUi((r) => r.method === "setWidget", 40_000, "the plan widget");
      await driver.prompt("/infinity:run");

      await waitUntil(async () => /run finished/.test(driver.notes()), 120_000, "the run to finish");

      const compactions = driver.events.filter((e) => e.type === "compaction_end").length;
      assert.ok(compactions > 0, "the run really did compact — otherwise this proves nothing");
      note(`${compactions} real compactions during the run`);

      assert.deepEqual(driver.events.filter((e) => e.type === "extension_error"), []);
      assert.match(driver.notes(), /run finished/, "and it still stopped for a reason, not by dying");

      // The rules must be in the system prompt, which compaction never sees.
      const requests = readFileSync(reqLog, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      //
      // Look at the turns that happened *after* a compaction — the ones pi
      // rebuilt from a summary. Those are the turns where a harness that kept
      // its rules in the transcript would have forgotten them.
      const postCompaction = requests.filter((r) =>
        (r.body?.messages ?? []).some(
          (m) =>
            m.role === "user" &&
            JSON.stringify(m.content ?? "").includes("compacted into the following summary"),
        ),
      );
      assert.ok(postCompaction.length > 0, "at least one turn ran on a compacted context");
      note(`${postCompaction.length} turns ran on a compacted context`);

      for (const req of postCompaction) {
        const system = (req.body?.messages ?? []).find((m) => m.role === "system");
        assert.ok(system, "pi sent a system prompt");
        assert.match(String(system.content), /infinity-harness/, "carrying the harness contract");
        assert.match(String(system.content), /infinity_validate/, "including the rule the run depends on");
      }

      const config = JSON.parse(readFileSync(join(dir, "harness", "config.json"), "utf-8"));
      assert.ok(config.currentPhase, "and the pipeline still knows where it is");

      writeFileSync(scriptPath, JSON.stringify({ default: { content: "Working." } }));
    });

    await step("the whole pipeline, three signatures, five sessions", async () => {
      const { dir, driver, sessionDir } = launch("pipeline", {
        initOptions: {
          mode: "copilot",
          brief: "a CLI that reconciles Stripe payouts",
          phases: ["research", "define", "plan", "build", "verify", "review", "ship"],
          approvals: { research: true, define: true, plan: true },
          session: { handoff: "phase" },
        },
        plan: {
          version: "2.0",
          baseRevision: 1,
          goals: [{ id: "goal-001", title: "Reconcile Stripe payouts" }],
          sprints: [{ id: "sprint-001", name: "Foundations", goalId: "goal-001" }],
          features: [
            {
              id: "feature-001",
              name: "Ledger import",
              sprintId: "sprint-001",
              goalId: "goal-001",
              criteria: ["refunds reconcile against the ledger"],
              tasks: [
                { id: "task-001", description: "Parse the payout CSV", status: "complete", dependsOn: [], subtasks: [] },
                { id: "task-002", description: "Reconcile fees", status: "complete", dependsOn: ["feature-001/task-001"], subtasks: [] },
              ],
            },
          ],
        },
      });

      // Everything the gates ask for, staged up front, so each one opens in
      // turn and what is being watched is the human's path through the run.
      put(
        dir,
        "harness/docs/RESEARCH.md",
        `# Research\n\n${"FX must be fixed at settlement time, not at import time.\n".repeat(20)}`,
      );
      put(dir, "harness/sprint-contract.md", "# Sprint contract\n\nIn: import. Out: reporting.\n");
      gitCommitAll(dir, "chore: the work");

      for (const phase of ["RESEARCH", "DEFINE", "PLAN"]) {
        driver.answer((r) => new RegExp(`${phase} is waiting for you`).test(r.title ?? ""), (r) => r.options[0]);
      }

      await driver.waitForUi((r) => r.method === "setWidget", 40_000, "the plan widget");
      await driver.prompt("/infinity:run");
      await waitUntil(async () => /run finished/.test(driver.notes()), 120_000, "the run to finish");

      const notes = driver.notes();
      for (const phase of ["RESEARCH", "DEFINE", "PLAN"]) {
        assert.match(notes, new RegExp(`${phase} is waiting for your approval`), `${phase} never stopped for the human`);
        assert.match(notes, new RegExp(`${phase} approved`));
      }
      assert.match(notes, /new session — phase: RESEARCH → DEFINE/);
      assert.match(notes, /new session — phase: PLAN → BUILD/);

      const files = readdirSync(sessionDir, { recursive: true }).filter((f) => String(f).endsWith(".jsonl"));
      assert.ok(files.length >= 4, `the run should span a session per phase, got ${files.length}`);

      const config = JSON.parse(readFileSync(join(dir, "harness", "config.json"), "utf-8"));
      assert.ok(
        ["verify", "review", "ship"].includes(String(config.currentPhase)),
        `the pipeline should have reached at least VERIFY, sits at ${config.currentPhase}`,
      );

      // The same pass is not two passes. This read
      // `research:pass → research:pass → define:pass → define:pass`, which
      // says a phase had to be attempted twice — the opposite of the truth.
      const history = (config.gateHistory ?? []).map((g) => `${g.phase}:${g.result}`);
      const passes = history.filter((h) => h.endsWith(":pass"));
      assert.deepEqual(
        passes,
        ["research:pass", "define:pass", "plan:pass", "build:pass"],
        `each phase passed exactly once: ${history.join(" → ")}`,
      );

      // …but repeated failures are exactly what a human comes back to read.
      assert.ok(
        history.filter((h) => h === "verify:fail").length > 1,
        "repeated failures on one phase are not collapsed",
      );

      // A fresh phase has not been asked to do anything yet, so its first
      // failure is not a stall. The run used to spend `retry` and `reframe`
      // on the opening turn of every phase.
      const firstVerify = notes.indexOf("new session — phase: BUILD → VERIFY");
      const afterVerify = notes.slice(firstVerify);
      const firstReaction = afterVerify.split("\n").find((l) => /re-briefing/.test(l)) ?? "";
      assert.doesNotMatch(
        firstReaction,
        /escalated/,
        "the first turn of a new phase must not be treated as a stall",
      );

      assert.deepEqual(driver.events.filter((e) => e.type === "extension_error"), []);
    });

    await step("an approval gate stops the run for a human, and takes their answer", async () => {
      const { dir, driver } = launch("approval", {
        initOptions: {
          mode: "copilot",
          brief: "a demo",
          approvals: { define: true, plan: true },
          session: { handoff: "off", contextThreshold: 0 },
        },
        plan: {
          version: "2.0",
          baseRevision: 1,
          goals: [{ id: "goal-001", title: "a demo" }],
          sprints: [],
          features: [
            {
              id: "feature-001",
              name: "F1",
              criteria: ["it works"],
              tasks: [{ id: "task-001", description: "do the thing", status: "complete", dependsOn: [], subtasks: [] }],
            },
          ],
        },
      });
      await driver.waitForUi((r) => r.method === "setWidget", 40_000, "the plan widget");

      driver.answer((r) => /DEFINE is waiting for you/.test(r.title ?? ""), (r) =>
        r.options.find((o) => /send it back/.test(o)),
      );
      driver.answer((r) => /What needs to change/.test(r.title ?? ""), "the criteria say nothing about refunds");

      await driver.prompt("/infinity:run");
      await waitUntil(
        async () => /sent back/.test(driver.notes()),
        90_000,
        "the run to stop and take the rejection",
      );

      const told = driver.transcript().find((m) => /sent it back/.test(m.text));
      assert.ok(told, "the agent is told what the human said, not just that they said no");
      assert.match(told.text, /refunds/);

      const config = JSON.parse(readFileSync(join(dir, "harness", "config.json"), "utf-8"));
      assert.equal(config.currentPhase, "define", "and the phase did not advance");

      // A rejection nobody acts on must not spin forever: the no-progress
      // detector has to see it, which it did not when this was an early
      // return in the loop.
      await waitUntil(async () => /run finished/.test(driver.notes()), 120_000, "the run to give up");
      assert.match(driver.notes(), /sent .* back|not acting on it|no change/i);
    });

    await step("every command runs clean under `pi -p`, with no stale-context errors", async () => {
      // Two failure modes lived here, both invisible to a suite that never ran
      // pi. A command ending in `sendUserMessage(..., followUp)` waits for an
      // agent that print mode never starts. And a handoff in a one-shot run
      // replaces the session out from under the instance that asked for it,
      // so every later handler touches a stale ctx.
      const dir = mkTempDir("realpi-commands");
      gitInit(dir);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node -e 0" } }));
      gitCommitAll(dir, "chore: initial commit");

      const configDir = join(workdir, "pi-commands");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "models.json"),
        JSON.stringify({
          providers: {
            mock: {
              baseUrl: `http://127.0.0.1:${mock.port}`,
              api: "openai-completions",
              apiKey: "mock",
              compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
              models: [{ id: "mock-1", name: "Mock", contextWindow: 40000, maxTokens: 4096 }],
            },
          },
        }),
      );

      const print = (prompt) =>
        spawnSync(
          process.execPath,
          [piBin, "-p", "-a", "--offline", "--provider", "mock", "--model", "mock-1", "--api-key", "mock", "--no-session", "-e", EXT, prompt],
          {
            cwd: dir,
            encoding: "utf-8",
            timeout: 45_000,
            env: { ...process.env, PI_CODING_AGENT_DIR: configDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", NO_COLOR: "1" },
          },
        );

      // Before there is a harness, and after.
      const beforeInit = print("/infinity:init");
      assert.notEqual(beforeInit.signal, "SIGTERM", "/infinity:init hung with no harness present");
      assert.doesNotMatch(beforeInit.stderr ?? "", /stale/i, beforeInit.stderr);

      initHarness(dir, { mode: "autopilot", brief: "a demo" });

      for (const command of [
        "hello",
        "/infinity:status",
        "/infinity:next",
        "/infinity:validate",
        "/infinity:run",
        "/infinity:approve",
        "/infinity:scroll",
        "/infinity:handoff",
        "/infinity:goal",
        "/infinity:halt",
      ]) {
        const res = print(command);
        assert.notEqual(res.signal, "SIGTERM", `${command} hung under pi -p`);
        assert.equal(res.status, 0, `${command} exited ${res.status}: ${res.stderr}`);
        assert.doesNotMatch(
          res.stderr ?? "",
          /stale after session replacement/i,
          `${command} touched a torn-down session: ${res.stderr}`,
        );
        assert.doesNotMatch(res.stderr ?? "", /Extension error/i, `${command}: ${res.stderr}`);
      }
      note("11 commands run headlessly, none hung, none touched a dead session");
      rmSync(dir, { recursive: true, force: true });
    });

    await step("`pi -p` does not hang on a harness project", async () => {
      // The brief used to be queued with `deliverAs: "nextTurn"`, which waits
      // for a user prompt. Print mode never has one, so every headless run
      // hung on startup and nothing in the suite could see it.
      const dir = mkTempDir("realpi-print");
      gitInit(dir);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node -e 0" } }));
      gitCommitAll(dir, "chore: initial commit");
      initHarness(dir, { mode: "autopilot", brief: "a demo" });

      const configDir = join(workdir, "pi-print");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "models.json"),
        JSON.stringify({
          providers: {
            mock: {
              baseUrl: `http://127.0.0.1:${mock.port}`,
              api: "openai-completions",
              apiKey: "mock",
              compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
              models: [{ id: "mock-1", name: "Mock", contextWindow: 40000, maxTokens: 4096 }],
            },
          },
        }),
      );

      const res = spawnSync(
        process.execPath,
        [piBin, "-p", "-a", "--offline", "--provider", "mock", "--model", "mock-1", "--api-key", "mock", "--no-session", "-e", EXT, "say hi"],
        {
          cwd: dir,
          encoding: "utf-8",
          timeout: 60_000,
          env: { ...process.env, PI_CODING_AGENT_DIR: configDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", NO_COLOR: "1" },
        },
      );
      assert.notEqual(res.signal, "SIGTERM", "pi -p must not hang on a harness project");
      assert.equal(res.status, 0, `pi -p failed: ${res.stderr || res.stdout}`);
      assert.match(res.stdout, /\S/, "and it produced output");
      rmSync(dir, { recursive: true, force: true });
    });
  } finally {
    for (const d of drivers) {
      try {
        await d.stop();
      } catch {
        /* a dead process is the desired end state */
      }
    }
    mock.stop();
    rmSync(workdir, { recursive: true, force: true });
  }
}

const SCENARIOS = [
  ["pipeline", "the full walkthrough: define → plan → build → verify → review → ship", scenarioPipeline],
  ["convergence", "a continuous run drives itself to complete", scenarioConvergence],
  ["stops", "every stop condition fires, from real state", scenarioStops],
  ["crash", "SIGKILL mid-phase, restart from disk, and .bak recovery", scenarioCrash],
  ["concurrency", "parallel writers cannot corrupt the plan", scenarioConcurrency],
  ["roundtrip", "task data survives repeated plan edits", scenarioRoundTrip],
  ["dashboard", "the web view, and proof it never writes", scenarioDashboard],
  ["widget", "rendering across empty, huge, long, CJK, ASCII and narrow", scenarioWidget],
  ["edges", "adversarial plans and inputs", scenarioEdges],
  ["extension", "the pi adapter driven through its real tools, commands and hooks", scenarioExtension],
  ["coldstart", "install, open pi, and get to a working harness", scenarioColdStart],
  ["escalation", "what a stuck run does before it gives up", scenarioEscalation],
  ["goal", "the outer loop: is the thing that was asked for actually done?", scenarioGoal],
  ["realpi", "a real pi process, driven like a human: dialogs, widget, compaction, handoff", scenarioRealPi],
  ["package", "what npm actually ships, unpacked and inspected", scenarioPackage],
  ["live", "one real model call (skipped when the endpoint is unreachable)", scenarioLive],
];

if (LIST_ONLY) {
  for (const [name, desc] of SCENARIOS) out(`${name.padEnd(14)} ${desc}`);
  process.exit(0);
}

const selected = ONLY ? SCENARIOS.filter(([n]) => n === ONLY || n.startsWith(ONLY)) : SCENARIOS;
if (selected.length === 0) {
  out(`no scenario matches "${ONLY}". Known: ${SCENARIOS.map(([n]) => n).join(", ")}`);
  process.exit(1);
}

out("");
out(`infinity-harness e2e — ${selected.length} scenario${selected.length === 1 ? "" : "s"}  (node ${process.version})`);

const results = [];
const runStarted = Date.now();

for (const [i, [name, desc, fn]] of selected.entries()) {
  out("");
  out(RULE);
  out(`▸ ${i + 1}/${selected.length}  ${name} — ${desc}`);
  out(RULE);

  const t0 = Date.now();
  let status = "pass";
  let skipReason = null;
  try {
    await fn();
  } catch (e) {
    if (e instanceof SkipLeg) {
      status = "skip";
      skipReason = e.message;
      out(`  ⊘ skipped — ${skipReason}`);
    } else {
      status = "fail";
      if (!e?.__stepFailure) {
        out("  ✗ scenario threw outside a step");
        out(indent(e?.stack ?? String(e), 6));
      }
    }
  } finally {
    await closeServers();
    cleanupSync();
  }
  const ms = Date.now() - t0;
  results.push({ name, status, ms, skipReason });
  out(`  ${status === "pass" ? "PASS" : status === "skip" ? "SKIP" : "FAIL"}  ${name.padEnd(14)} ${String(ms).padStart(6)}ms`);
}

await closeServers();
cleanupSync();

const failed = results.filter((r) => r.status === "fail");
const skipped = results.filter((r) => r.status === "skip");
const passed = results.filter((r) => r.status === "pass");

out("");
out(RULE);
out(
  `${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped · ` +
    `${stepsPassed} assertion group${stepsPassed === 1 ? "" : "s"}  (${Date.now() - runStarted}ms)`,
);
for (const s of skipped) out(`  SKIP  ${s.name} — ${s.skipReason}`);
for (const f of failed) out(`  FAIL  ${f.name}`);

const leftovers = [...ALL_TEMP_DIRS].filter((d) => existsSync(d));
if (leftovers.length) {
  out(`  FAIL  cleanup — ${leftovers.length} of ${ALL_TEMP_DIRS.size} temp dir(s) survived: ${leftovers[0]}`);
} else if (VERBOSE) {
  out(`  · ${ALL_TEMP_DIRS.size} temp dir(s) created and removed, ${SERVERS.size} server(s) left open`);
}

process.exit(failed.length === 0 && leftovers.length === 0 ? 0 : 1);
