/**
 * You have to be able to start.
 *
 * This file exists because you couldn't. `pi install infinity-harness` put the
 * extension in place, and then every single command answered:
 *
 *   Warning: No harness in this project (harness/config.json not found).
 *
 * There was no command, tool, or documented procedure that created one. The
 * package shipped, installed, loaded, passed its whole test suite, and could
 * not be used.
 *
 * So: init makes a project the harness can actually run in, and these tests
 * check that by running it — building a brief, running a gate — rather than by
 * asserting that some files exist.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectStack, describeInit, initHarness, packagedDocsDir } from "../src/core/init.ts";
import { isHarnessProject, loadConfig } from "../src/core/config.ts";
import { loadFeatureList } from "../src/core/featureList.ts";
import { buildBrief, renderBrief } from "../src/core/brief.ts";
import { runChecks } from "../src/core/gates.ts";
import { DEFAULT_ENABLED_PHASES } from "../src/core/types.ts";

function tmpProject(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-init-"));
  for (const [name, body] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body, "utf-8");
  }
  return dir;
}

// ── the whole point ────────────────────────────────────────────────────────
{
  const dir = tmpProject();
  assert.equal(isHarnessProject(dir), false, "a bare directory is not a harness project");

  const result = initHarness(dir);
  assert.ok(result.ok, result.error);
  assert.equal(isHarnessProject(dir), true, "after init, it is");

  // The three commands that used to dead-end all have something to read.
  const { config, ok } = loadConfig(dir);
  assert.ok(ok, "the config we just wrote is readable");
  assert.equal(config.currentPhase, "define");
  assert.equal(config.currentRole, "planner");
  assert.deepEqual(config.phases.enabled, DEFAULT_ENABLED_PHASES);

  const { list } = loadFeatureList(dir);
  assert.deepEqual(list.features, [], "the plan starts empty, not absent");

  const brief = await buildBrief(dir);
  const text = renderBrief(brief, config);
  assert.match(text, /NEXT STEP · DEFINE/);
  assert.match(text, /THE LOOP/);

  const gate = await runChecks(dir, "define", { record: false });
  assert.ok(Array.isArray(gate.checks) && gate.checks.length > 0, "the gate runs and reports");

  rmSync(dir, { recursive: true, force: true });
  console.log("✓ init turns a bare directory into a project the harness can run");
}

// ── the gate stays unbribable ──────────────────────────────────────────────
// It would be easy to scaffold documents long enough to satisfy the review
// gate on the day they are created. That would mean REVIEW passes on
// boilerplate nobody wrote, which is the one thing this design cannot allow.
{
  const dir = tmpProject();
  initHarness(dir);
  const gate = await runChecks(dir, "review", { record: false });
  const docChecks = gate.checks.filter((c) =>
    ["architecture-doc", "decisions-logged", "rubric-content"].includes(c.name),
  );
  assert.equal(docChecks.length, 3, "the review gate checks all three documents");
  for (const check of docChecks) {
    assert.equal(check.pass, false, `${check.name} passed on a starter template`);
    assert.match(check.detail, /essentially empty/);
  }
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ the scaffolded documents do not satisfy the gate that demands them");
}

// ── it never destroys work ─────────────────────────────────────────────────
{
  const dir = tmpProject();
  initHarness(dir);
  const arch = join(dir, "harness", "docs", "ARCHITECTURE.md");
  writeFileSync(arch, "# Architecture\n\nReal content someone actually wrote.\n", "utf-8");
  writeFileSync(join(dir, "harness", "features", "feature-list.json"), JSON.stringify({
    version: "2.0", baseRevision: 7, goals: [], sprints: [],
    features: [{ id: "feature-001", name: "Kept", passes: false, criteria: ["c"], tasks: [] }],
  }));

  const again = initHarness(dir, { force: true });
  assert.ok(again.ok, again.error);
  assert.match(readFileSync(arch, "utf-8"), /Real content someone actually wrote/);
  assert.equal(loadFeatureList(dir).list.features.length, 1, "the existing plan survived");
  assert.ok(again.kept.includes("harness/config.json"));
  assert.ok(again.kept.includes("harness/features/feature-list.json"));
  assert.equal(again.created.length, 0, "a complete harness needs nothing restored");
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ re-running init never overwrites work that is already there");
}

// ...and restores only what is missing.
{
  const dir = tmpProject();
  initHarness(dir);
  rmSync(join(dir, "harness", "evaluator-rubric.md"));
  const again = initHarness(dir, { force: true });
  assert.deepEqual(again.created, ["harness/evaluator-rubric.md"]);
  console.log("✓ force restores exactly what is missing");
  rmSync(dir, { recursive: true, force: true });
}

// ── refusing politely ──────────────────────────────────────────────────────
{
  const dir = tmpProject();
  initHarness(dir);
  const again = initHarness(dir);
  assert.equal(again.ok, false);
  assert.match(again.error!, /already has a harness/);
  assert.match(again.error!, /\/infinity:config/, "the refusal says what to do instead");
  rmSync(dir, { recursive: true, force: true });
}

// ── stack detection ────────────────────────────────────────────────────────
{
  const node = tmpProject({
    "package.json": JSON.stringify({
      name: "x",
      scripts: { lint: "eslint .", test: "vitest run", build: "tsc", coverage: "vitest run --coverage" },
    }),
  });
  const d = detectStack(node);
  assert.equal(d.id, "node");
  assert.equal(d.commands.lint, "npm run lint");
  assert.equal(d.commands.test, "npm run test");
  assert.equal(d.commands.coverage, "npm run coverage");
  assert.equal(d.commands.build, "npm run build");
  rmSync(node, { recursive: true, force: true });

  // The lockfile decides the runner — `npm run` in a pnpm project is a
  // different resolution and sometimes a different result.
  const pnpm = tmpProject({
    "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
    "pnpm-lock.yaml": "lockfileVersion: 9",
  });
  assert.equal(detectStack(pnpm).commands.test, "pnpm run test");
  rmSync(pnpm, { recursive: true, force: true });

  // Scripts that do not exist are not invented.
  const bare = tmpProject({ "package.json": JSON.stringify({ name: "x" }) });
  assert.deepEqual(detectStack(bare).commands, { lint: null, test: null, coverage: null, build: null });
  rmSync(bare, { recursive: true, force: true });

  const rust = tmpProject({ "Cargo.toml": "[package]\nname = \"x\"\n" });
  assert.equal(detectStack(rust).id, "rust");
  assert.equal(detectStack(rust).commands.test, "cargo test");
  rmSync(rust, { recursive: true, force: true });

  const go = tmpProject({ "go.mod": "module x\n" });
  assert.equal(detectStack(go).commands.test, "go test ./...");
  rmSync(go, { recursive: true, force: true });

  // Python only claims what the project shows evidence of.
  const py = tmpProject({ "pyproject.toml": "[project]\nname = \"x\"\n" });
  assert.equal(detectStack(py).id, "python");
  assert.equal(detectStack(py).commands.test, null, "no tests dir, no pytest claim");
  rmSync(py, { recursive: true, force: true });

  const pyTested = tmpProject({
    "pyproject.toml": "[tool.ruff]\nline-length = 100\n[tool.pytest.ini_options]\n",
    "tests/test_x.py": "def test_x(): pass\n",
  });
  assert.equal(detectStack(pyTested).commands.test, "pytest");
  assert.equal(detectStack(pyTested).commands.lint, "ruff check .");
  rmSync(pyTested, { recursive: true, force: true });

  const nothing = tmpProject();
  assert.equal(detectStack(nothing).id, "unknown");
  rmSync(nothing, { recursive: true, force: true });
  console.log("✓ stack detection proposes only what the project shows evidence of");
}

// Detected commands reach the config, so the gate runs the right thing.
{
  const dir = tmpProject({ "package.json": JSON.stringify({ scripts: { test: "jest", lint: "eslint ." } }) });
  const r = initHarness(dir);
  assert.equal(r.config.commands.test, "npm run test");
  assert.equal(r.config.commands.lint, "npm run lint");
  assert.equal(r.config.stack, "node");
  assert.equal(loadConfig(dir).config.commands.test, "npm run test", "and they are persisted");
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ what init detects is what the gate will run");
}

// ── phases ─────────────────────────────────────────────────────────────────
{
  // Stored in pipeline order, not the order they were clicked.
  const dir = tmpProject();
  const r = initHarness(dir, { phases: ["ship", "build", "define"] });
  assert.deepEqual(r.config.phases.enabled, ["define", "build", "ship"]);
  assert.equal(r.config.currentPhase, "define", "the run starts at the first enabled phase");
  rmSync(dir, { recursive: true, force: true });

  // SIMPLIFY is opt-in, and opting in works.
  const s = tmpProject();
  const withSimplify = initHarness(s, { phases: [...DEFAULT_ENABLED_PHASES, "simplify"] });
  assert.ok(withSimplify.config.phases.enabled.includes("simplify"));
  assert.deepEqual(
    withSimplify.config.phases.enabled,
    ["define", "plan", "build", "verify", "simplify", "review", "ship"],
  );
  rmSync(s, { recursive: true, force: true });

  // Nonsense in, sane pipeline out — an empty pipeline is not a pipeline.
  const junk = tmpProject();
  const j = initHarness(junk, { phases: ["nope" as never, "init"] });
  assert.deepEqual(j.config.phases.enabled, DEFAULT_ENABLED_PHASES);
  rmSync(junk, { recursive: true, force: true });

  // A pipeline that starts at BUILD starts at BUILD.
  const late = tmpProject();
  const l = initHarness(late, { phases: ["build", "verify"] });
  assert.equal(l.config.currentPhase, "build");
  assert.equal(l.config.currentRole, "generator");
  rmSync(late, { recursive: true, force: true });
  console.log("✓ the pipeline is what you asked for, in the order it actually runs");
}

// ── the docs the brief points at ───────────────────────────────────────────
{
  const dir = tmpProject();
  initHarness(dir);
  const packaged = packagedDocsDir();
  assert.ok(existsSync(packaged), "the package ships the docs init copies");

  for (const phase of DEFAULT_ENABLED_PHASES) {
    assert.ok(
      existsSync(join(dir, "harness", "docs", "phases", `${phase}.md`)),
      `the ${phase} phase doc is missing — the brief points at it`,
    );
  }
  for (const role of ["planner", "generator", "evaluator", "simplifier"]) {
    assert.ok(existsSync(join(dir, "harness", "docs", "agents", `${role}.md`)), `${role}.md is missing`);
  }

  // Copied, not linked: a team's BUILD doc should be theirs to edit.
  const doc = join(dir, "harness", "docs", "phases", "build.md");
  writeFileSync(doc, "# Our BUILD\n", "utf-8");
  assert.notEqual(readFileSync(join(packaged, "phases", "build.md"), "utf-8"), "# Our BUILD\n");
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ the phase and role docs land in the project, as editable copies");
}

// ── run state does not get committed ───────────────────────────────────────
{
  const dir = tmpProject();
  initHarness(dir);
  const ignore = readFileSync(join(dir, "harness", ".gitignore"), "utf-8");
  for (const noisy of ["run-journal.jsonl", "STOP", "*.bak", "*.ilock"]) {
    assert.ok(ignore.includes(noisy), `${noisy} should not be committed`);
  }
  assert.ok(!ignore.includes("config.json"), "the config IS worth committing");
  assert.ok(!ignore.includes("feature-list"), "the plan IS worth committing");
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ run state is ignored; the plan and config are not");
}

// ── what it tells the user ─────────────────────────────────────────────────
{
  const dir = tmpProject({ "package.json": JSON.stringify({ scripts: { test: "vitest" } }) });
  const text = describeInit(initHarness(dir));
  assert.match(text, /Node/);
  assert.match(text, /DEFINE/);
  assert.match(text, /npm run test/);
  assert.match(text, /say what you are building/, "with no goal it asks for one");
  assert.doesNotMatch(text, /Goal {6}/, "and does not pretend to have one");
  rmSync(dir, { recursive: true, force: true });

  // With a goal from the wizard it must not tell the human to supply one they
  // have already supplied.
  const withGoal = tmpProject({ "package.json": JSON.stringify({ scripts: { test: "vitest" } }) });
  const goalText = describeInit(initHarness(withGoal, { brief: "reconcile Stripe payouts" }));
  assert.match(goalText, /Goal {6}reconcile Stripe payouts/);
  assert.match(goalText, /\/infinity:run/, "it says what to do next");
  assert.doesNotMatch(goalText, /say what you are building/);
  rmSync(withGoal, { recursive: true, force: true });

  const bare = tmpProject();
  const bareText = describeInit(initHarness(bare));
  assert.match(bareText, /none detected/);
  assert.match(bareText, /\/infinity:config/, "and where to fix that");
  rmSync(bare, { recursive: true, force: true });
  console.log("✓ init reports what it found, what it did, and what to do next");
}

console.log("init.test.ts ✓");
