/**
 * Workflows: which phases run, and who signs each one.
 *
 * "copilot" and "autopilot" were a single switch, and a single switch is the
 * wrong shape for the question — it cannot say "let it define and plan on its
 * own but show me the review". The setting is a mode per phase; the two
 * familiar words are two named points in that space.
 *
 * The two rules worth defending here: a saved workflow belongs to the *person*
 * so it is there on their next project, and a built-in name cannot be taken,
 * because "copilot" has to mean the same thing in every conversation about
 * this tool.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  BUILTIN_WORKFLOWS,
  SIGNABLE_PHASES,
  applyWorkflow,
  builtInWorkflow,
  deleteWorkflow,
  describeModes,
  findWorkflow,
  listWorkflows,
  loadSavedWorkflows,
  matchWorkflow,
  modeFor,
  modesOf,
  normalizeModes,
  normalizePhases,
  renderWorkflow,
  saveWorkflow,
  signedPhases,
  slugify,
  summarizeWorkflow,
} from "../src/workflow.ts";
import { defaultConfig, loadConfig, saveConfig } from "../src/core/config.ts";
import { userWorkflowsPath } from "../src/core/paths.ts";

function sandbox(): { env: NodeJS.ProcessEnv; clean: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "workflow-store-"));
  return { env: { PI_CODING_AGENT_DIR: dir }, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

// ── the built-ins ──────────────────────────────────────────────────────────
{
  const ids = BUILTIN_WORKFLOWS.map((w) => w.id);
  assert.ok(ids.includes("copilot") && ids.includes("autopilot"), "the two familiar names survive");
  assert.equal(new Set(ids).size, ids.length, "ids are unique");

  const copilot = builtInWorkflow("copilot")!;
  assert.deepEqual(signedPhasesOf(copilot), ["define", "plan"], "copilot signs the two thinking phases it runs");

  const autopilot = builtInWorkflow("autopilot")!;
  assert.deepEqual(signedPhasesOf(autopilot), [], "autopilot signs nothing");

  const every = builtInWorkflow("every-gate")!;
  assert.deepEqual(signedPhasesOf(every), every.phases, "every gate means every gate");

  const spec = builtInWorkflow("spec-and-ship")!;
  assert.deepEqual(
    signedPhasesOf(spec),
    ["define", "ship"],
    "the shape a single switch could not express: scope in, release out",
  );

  assert.equal(builtInWorkflow("nope"), null);
  console.log("✓ the built-ins cover the shapes people ask for, including one no switch could");
}

function signedPhasesOf(w: (typeof BUILTIN_WORKFLOWS)[number]): string[] {
  return w.phases.filter((p) => w.modes[p] === "copilot");
}

// ── saving, reusing, deleting ──────────────────────────────────────────────
{
  const box = sandbox();
  assert.deepEqual(loadSavedWorkflows(box.env), [], "nothing saved to start with");
  assert.equal(listWorkflows(box.env).length, BUILTIN_WORKFLOWS.length);

  const saved = saveWorkflow(
    {
      name: "Client work",
      phases: ["define", "plan", "build", "verify", "review", "ship"],
      modes: { define: "copilot", review: "copilot", ship: "copilot" },
    },
    box.env,
  );
  assert.equal(saved.ok, true, saved.error ?? "");
  assert.equal(saved.workflow?.id, "client-work");
  assert.equal(saved.workflow?.builtIn, false);
  assert.ok(saved.workflow?.savedAt, "a saved workflow is stamped");
  assert.ok(saved.workflow!.description.length > 0, "and describes itself if you did not");

  // The point of saving: it is there next time, on any project.
  assert.equal(findWorkflow("client-work", box.env)?.name, "Client work");
  assert.equal(listWorkflows(box.env).length, BUILTIN_WORKFLOWS.length + 1);
  assert.equal(listWorkflows(box.env)[0]?.builtIn, true, "built-ins come first in the menu");

  // Saving the same name again is editing, not a duplicate.
  const edited = saveWorkflow(
    { name: "Client work", phases: ["define", "plan", "build"], modes: { plan: "copilot" } },
    box.env,
  );
  assert.equal(edited.ok, true);
  assert.equal(loadSavedWorkflows(box.env).length, 1, "one entry, not two");
  assert.equal(findWorkflow("client-work", box.env)?.modes.plan, "copilot");

  assert.equal(deleteWorkflow("client-work", box.env).ok, true);
  assert.equal(loadSavedWorkflows(box.env).length, 0);
  box.clean();
  console.log("✓ a saved workflow belongs to the person and is there on the next project");
}

// ── built-ins are read-only ────────────────────────────────────────────────
{
  const box = sandbox();
  for (const id of ["copilot", "autopilot", "Copilot", "AUTOPILOT", "auto pilot"]) {
    const attempt = saveWorkflow({ name: id, phases: ["define"], modes: {} }, box.env);
    if (builtInWorkflow(slugify(id))) {
      assert.equal(attempt.ok, false, `"${id}" should be refused`);
      assert.match(attempt.error ?? "", /built-in/i);
    }
  }
  assert.equal(deleteWorkflow("copilot", box.env).ok, false, "and they cannot be deleted either");
  assert.equal(saveWorkflow({ name: "   ", phases: ["define"], modes: {} }, box.env).ok, false);
  assert.equal(saveWorkflow({ name: "!!!", phases: ["define"], modes: {} }, box.env).ok, false);
  box.clean();
  console.log("✓ 'copilot' means the same thing everywhere — built-ins cannot be shadowed or deleted");
}

// ── a corrupt store degrades to the built-ins ──────────────────────────────
{
  const box = sandbox();
  const path = userWorkflowsPath(box.env);
  mkdirSync(dirname(path), { recursive: true });

  writeFileSync(path, "{not json", "utf-8");
  assert.deepEqual(loadSavedWorkflows(box.env), [], "unreadable reads as none, never as a throw");

  writeFileSync(path, JSON.stringify({ version: "1", workflows: [{ nonsense: true }] }), "utf-8");
  assert.deepEqual(loadSavedWorkflows(box.env), [], "an entry with no id and no name is not a workflow");

  writeFileSync(
    path,
    JSON.stringify({ version: "1", workflows: [{ id: "x", name: "X", phases: ["nope"], modes: { nope: "wat" } }] }),
    "utf-8",
  );
  const repaired = loadSavedWorkflows(box.env)[0]!;
  assert.deepEqual(repaired.phases, normalizePhases(undefined), "a nonsense phase list falls back to the default");
  assert.ok(
    Object.values(repaired.modes).every((m) => m === "copilot" || m === "autopilot"),
    "and a nonsense mode becomes a real one",
  );
  box.clean();
  console.log("✓ a corrupt store leaves you with the built-ins rather than a broken session");
}

// ── applying one to a config ───────────────────────────────────────────────
{
  const config = defaultConfig();
  applyWorkflow(config, builtInWorkflow("research-first")!);

  assert.ok(config.phases.enabled.includes("research"), "the workflow's phases become the pipeline");
  assert.equal(config.phases.enabled[0], "research", "in pipeline order");
  assert.equal(config.phaseModes.research, "copilot");
  assert.equal(config.phaseModes.build, "autopilot");
  assert.deepEqual(config.workflow, { id: "research-first", name: "research first" });

  assert.equal(modeFor(config, "define"), "copilot");
  assert.equal(modeFor(config, "build"), "autopilot");
  assert.equal(modeFor(config, null), "autopilot", "no phase is nothing to stop for");
  assert.deepEqual(signedPhases(config), ["research", "define", "plan"]);

  // Switching workflow replaces the modes rather than merging them.
  applyWorkflow(config, builtInWorkflow("autopilot")!);
  assert.deepEqual(signedPhases(config), [], "the old copilot phases are gone, not left behind");
  assert.ok(!config.phases.enabled.includes("research"), "and so is the phase it added");
  console.log("✓ applying a workflow replaces the pipeline and the modes, cleanly");
}

// ── knowing when the settings have drifted ─────────────────────────────────
{
  const box = sandbox();
  const config = defaultConfig();
  applyWorkflow(config, builtInWorkflow("copilot")!);
  assert.equal(matchWorkflow(config, box.env)?.id, "copilot");
  assert.match(summarizeWorkflow(config, box.env), /^copilot ·/);

  // One setting changed by hand, and it is no longer copilot. Saying so is the
  // difference between a word that means something and a label.
  config.phaseModes = { ...config.phaseModes, review: "copilot" };
  assert.equal(matchWorkflow(config, box.env), null);
  assert.match(summarizeWorkflow(config, box.env), /copilot \(edited\)/);
  box.clean();
  console.log("✓ a config edited off its preset says so instead of still claiming the name");
}

// ── an older config comes forward ──────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "workflow-migrate-"));
  mkdirSync(join(dir, "harness"), { recursive: true });

  // Exactly what 2.3 wrote: a three-phase `approvals` and no `phaseModes`.
  const legacy = {
    version: "2.0",
    mode: "copilot",
    phases: { enabled: ["define", "plan", "build", "verify", "review", "ship"] },
    approvals: { research: false, define: true, plan: true },
    gates: {},
    git: {},
    maxRetries: 10,
  };
  writeFileSync(join(dir, "harness", "config.json"), JSON.stringify(legacy), "utf-8");

  const { config, ok } = loadConfig(dir);
  assert.equal(ok, true);
  assert.deepEqual(
    signedPhases(config),
    ["define", "plan"],
    "a project mid-run keeps the approvals it was configured with",
  );
  assert.equal(config.phaseModes.build, "autopilot");
  assert.equal(config.workflow?.id, "copilot", "and is labelled with the workflow it amounts to");

  // A 2.3 config that approved nothing lands on autopilot, not on a mystery.
  writeFileSync(
    join(dir, "harness", "config.json"),
    JSON.stringify({ ...legacy, approvals: { research: false, define: false, plan: false } }),
    "utf-8",
  );
  assert.deepEqual(signedPhases(loadConfig(dir).config), []);
  assert.equal(loadConfig(dir).config.workflow?.id, "autopilot");

  // And the migration does not clobber a config that already has modes.
  const modern = defaultConfig();
  applyWorkflow(modern, builtInWorkflow("spec-and-ship")!);
  saveConfig(dir, modern);
  assert.deepEqual(signedPhases(loadConfig(dir).config), ["define", "ship"]);

  rmSync(dir, { recursive: true, force: true });
  console.log("✓ a 2.3 config keeps its approvals without anyone editing JSON");
}

// ── describing ─────────────────────────────────────────────────────────────
{
  assert.match(describeModes(["define", "build"], { define: "copilot", build: "autopilot" }), /DEFINE/);
  assert.match(describeModes(["define"], { define: "autopilot" }), /without stopping/);
  assert.match(describeModes(["define"], { define: "copilot" }), /every phase/);

  const rendered = renderWorkflow(builtInWorkflow("copilot")!);
  assert.match(rendered, /\[define\]/, "a phase that stops is bracketed");
  assert.match(rendered, /brackets/, "and the notation is explained rather than assumed");

  assert.deepEqual(modesOf(defaultConfig()).init, undefined, "INIT is not a phase with a mode");
  assert.ok(!SIGNABLE_PHASES.includes("init"));
  assert.deepEqual(normalizeModes({ define: "copilot" }, ["define", "build"]), {
    define: "copilot",
    build: "autopilot",
  });
  console.log("✓ a workflow can be read at a glance, and unset phases default to autopilot");
}
