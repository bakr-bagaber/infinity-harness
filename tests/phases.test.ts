import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PHASE_ORDER,
  advancePhase,
  getPhaseOrder,
  isFinalPhase,
  isPhase,
  isValidTransition,
  nextPhase,
  transitionPhase,
} from "../src/core/phases.ts";
import { defaultConfig, loadConfig } from "../src/core/config.ts";
import { DEFAULT_ENABLED_PHASES, type HarnessConfig, type Phase } from "../src/core/types.ts";

function tmpProject(mutate: (c: HarnessConfig) => void = () => {}): string {
  const d = mkdtempSync(join(tmpdir(), "pi-phases-"));
  mkdirSync(join(d, "harness"), { recursive: true });
  const c = defaultConfig();
  mutate(c);
  writeFileSync(join(d, "harness", "config.json"), JSON.stringify(c, null, 2), "utf-8");
  return d;
}

function configFile(dir: string): string {
  return join(dir, "harness", "config.json");
}

// ── isPhase / getPhaseOrder ────────────────────────────────────────────────
{
  assert.ok(isPhase("build"));
  assert.ok(isPhase("simplify"));
  assert.ok(!isPhase("deploy"));
  assert.ok(!isPhase(null));
  assert.ok(!isPhase(3));

  const def = getPhaseOrder();
  assert.deepEqual(def, DEFAULT_ENABLED_PHASES);
  assert.ok(!def.includes("simplify"), "SIMPLIFY is not in the default pipeline");
  assert.ok(!def.includes("init"), "INIT is a bootstrap step, not part of the run");
  assert.deepEqual(getPhaseOrder(null), def, "null means default");
  assert.deepEqual(getPhaseOrder(undefined), def);
  assert.deepEqual(getPhaseOrder([] as string[]), def, "an empty pipeline falls back to the default");
  assert.deepEqual(getPhaseOrder(["nonsense"]), def, "a pipeline of unknown phases falls back to the default");

  // Enabling SIMPLIFY puts it in its canonical position, not at the end.
  const withSimplify = getPhaseOrder([...DEFAULT_ENABLED_PHASES, "simplify"]);
  assert.deepEqual(withSimplify, ["define", "plan", "build", "verify", "simplify", "review", "ship"]);

  // Order comes from PHASE_ORDER, not from the order the caller listed them.
  assert.deepEqual(getPhaseOrder(["ship", "define", "build"]), ["define", "build", "ship"]);
  // Unknown entries are ignored rather than inserted.
  assert.deepEqual(getPhaseOrder(["define", "deploy", "ship"]), ["define", "ship"]);
  assert.deepEqual([...PHASE_ORDER], ["init", "define", "plan", "build", "verify", "simplify", "review", "ship"]);
  console.log("✓ getPhaseOrder: default excludes simplify, order is canonical");
}

// ── isValidTransition ──────────────────────────────────────────────────────
{
  // From nothing, only the first phase of the pipeline is reachable.
  assert.equal(isValidTransition(null, "define"), true);
  assert.equal(isValidTransition(null, "plan"), false, "a run cannot start in the middle");
  assert.equal(isValidTransition(null, "ship"), false);

  // Forward exactly one step.
  const order = getPhaseOrder();
  for (let i = 0; i < order.length - 1; i++) {
    assert.equal(isValidTransition(order[i]!, order[i + 1]!), true, `${order[i]} → ${order[i + 1]}`);
  }

  // Re-running the current phase is always legal — that is how a failed gate retries.
  for (const p of order) assert.equal(isValidTransition(p, p), true, `${p} → ${p}`);

  // Skipping ahead is the thing the harness exists to prevent.
  assert.equal(isValidTransition("build", "review"), false);
  assert.equal(isValidTransition("build", "ship"), false);
  assert.equal(isValidTransition("define", "build"), false);

  // Backwards is never a transition; it is an explicit rework.
  assert.equal(isValidTransition("verify", "build"), false);
  assert.equal(isValidTransition("ship", "define"), false);
  assert.equal(isValidTransition("plan", "define"), false);

  // A phase outside the enabled pipeline is not reachable at all.
  assert.equal(isValidTransition("verify", "simplify"), false, "simplify is disabled by default");
  assert.equal(
    isValidTransition("verify", "simplify", [...DEFAULT_ENABLED_PHASES, "simplify"]),
    true,
    "…and reachable once enabled",
  );
  assert.equal(
    isValidTransition("verify", "review", [...DEFAULT_ENABLED_PHASES, "simplify"]),
    false,
    "enabling simplify makes verify → review a skip",
  );

  // A custom pipeline redefines what "one step" means.
  const custom = ["define", "build", "ship"];
  assert.equal(isValidTransition("define", "build", custom), true);
  assert.equal(isValidTransition("build", "ship", custom), true);
  assert.equal(isValidTransition("define", "plan", custom), false, "a disabled phase is not a valid target");
  console.log("✓ isValidTransition: forward one step or same phase, nothing else");
}

// ── nextPhase / isFinalPhase ───────────────────────────────────────────────
{
  assert.equal(nextPhase(null), "define", "the pipeline starts at its first phase");
  assert.equal(nextPhase("define"), "plan");
  assert.equal(nextPhase("build"), "verify");
  assert.equal(nextPhase("review"), "ship");
  assert.equal(nextPhase("ship"), null, "there is nothing after the final phase");
  assert.equal(nextPhase("simplify"), "define", "a phase outside the pipeline restarts at the top");
  assert.equal(nextPhase("verify", [...DEFAULT_ENABLED_PHASES, "simplify"]), "simplify");
  assert.equal(nextPhase("build", ["define", "build", "ship"]), "ship");

  assert.equal(isFinalPhase("ship"), true);
  assert.equal(isFinalPhase("review"), false);
  assert.equal(isFinalPhase(null), false);
  assert.equal(isFinalPhase("build", ["define", "build"]), true, "the final phase depends on the pipeline");
  assert.equal(isFinalPhase("ship", ["define", "build"]), false, "a disabled phase is never the final one");
  console.log("✓ nextPhase / isFinalPhase");
}

// ── transitionPhase: a valid advance persists ──────────────────────────────
{
  const dir = tmpProject((c) => {
    c.currentPhase = "build";
    c.currentRole = "generator";
    c.phaseRetryCount = 3;
    c.retryCount = 3;
    c.taskRetryCount = 2;
    c.featureRetryCount = 1;
    c.pipelineIteration = 5;
    c.paused = true;
  });
  try {
    const res = await transitionPhase(dir, "verify");
    assert.equal(res.ok, true, res.error ?? "");
    assert.equal(res.from, "build");
    assert.equal(res.to, "verify");

    const stored = loadConfig(dir).config;
    assert.equal(stored.currentPhase, "verify", "the new phase is on disk, not just in memory");
    assert.equal(stored.currentRole, "evaluator", "the role follows the phase");
    assert.equal(stored.phaseRetryCount, 0, "a new phase starts with a fresh phase budget");
    assert.equal(stored.retryCount, 0);
    assert.equal(stored.taskRetryCount, 2, "the task budget belongs to the task, not the phase");
    assert.equal(stored.featureRetryCount, 1, "the feature budget belongs to the feature");
    assert.equal(stored.pipelineIteration, 6, "advancing counts as a pipeline iteration");
    assert.equal(stored.paused, false, "advancing clears a pause");
    assert.equal(stored.gateHistory.length, 1, "leaving a phase records its passing gate");
    assert.equal(stored.gateHistory[0]!.phase, "build");
    assert.equal(stored.gateHistory[0]!.result, "pass");
    console.log("✓ transitionPhase: a valid advance persists and resets the phase budget");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── transitionPhase: re-running the same phase is a retry ──────────────────
{
  const dir = tmpProject((c) => {
    c.currentPhase = "build";
    c.phaseRetryCount = 1;
    c.retryCount = 1;
    c.pipelineIteration = 4;
  });
  try {
    const res = await transitionPhase(dir, "build");
    assert.equal(res.ok, true, res.error ?? "");
    assert.equal(res.from, "build");
    assert.equal(res.to, "build");

    const stored = loadConfig(dir).config;
    assert.equal(stored.currentPhase, "build");
    assert.equal(stored.phaseRetryCount, 2, "a re-run burns one phase retry");
    assert.equal(stored.retryCount, 2);
    assert.equal(stored.pipelineIteration, 4, "a re-run is not a new pipeline iteration");
    assert.deepEqual(stored.gateHistory, [], "a re-run does not record a passing gate");

    // Retries accumulate across re-runs.
    await transitionPhase(dir, "build");
    assert.equal(loadConfig(dir).config.phaseRetryCount, 3);
    console.log("✓ transitionPhase: a same-phase re-run increments the retry count");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── transitionPhase: an invalid transition writes nothing ──────────────────
{
  const dir = tmpProject((c) => {
    c.currentPhase = "build";
    c.phaseRetryCount = 2;
  });
  try {
    const before = readFileSync(configFile(dir), "utf-8");

    for (const target of ["ship", "review", "plan"] as Phase[]) {
      const res = await transitionPhase(dir, target);
      assert.equal(res.ok, false, `build → ${target} must be rejected`);
      assert.equal(res.config, null, "a rejected transition hands back no config");
      assert.match(res.error ?? "", /invalid transition build → /);
      assert.match(res.error ?? "", /Pipeline is: define → plan → build → verify → review → ship/);
      assert.equal(res.from, "build");
      assert.equal(res.to, target);
    }

    assert.equal(readFileSync(configFile(dir), "utf-8"), before, "the config file is untouched");
    const stored = loadConfig(dir).config;
    assert.equal(stored.currentPhase, "build");
    assert.equal(stored.phaseRetryCount, 2, "a rejected transition burns nothing");
    console.log("✓ transitionPhase: an invalid transition is rejected without writing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── transitionPhase: no config at all ──────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "pi-phases-bare-"));
  try {
    const res = await transitionPhase(dir, "define");
    assert.equal(res.ok, false, "an uninitialised project cannot transition");
    assert.equal(res.config, null);
    assert.match(res.error ?? "", /config/);
    console.log("✓ transitionPhase refuses an uninitialised project");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── advancePhase walks the pipeline and stops at the end ───────────────────
{
  const dir = tmpProject((c) => {
    c.currentPhase = null;
  });
  try {
    const walked: Array<string | null> = [];
    for (let i = 0; i < DEFAULT_ENABLED_PHASES.length; i++) {
      const res = await advancePhase(dir);
      assert.equal(res.ok, true, res.error ?? "");
      walked.push(res.to);
    }
    assert.deepEqual(walked, DEFAULT_ENABLED_PHASES, "advancePhase walks the enabled pipeline in order");

    const done = await advancePhase(dir);
    assert.equal(done.ok, false, "the pipeline does not wrap around");
    assert.match(done.error ?? "", /pipeline complete/);
    assert.equal(done.to, null);
    assert.equal(loadConfig(dir).config.currentPhase, "ship", "the final phase stays put");
    console.log("✓ advancePhase walks the pipeline and stops at the end");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── a custom pipeline is honoured end to end ───────────────────────────────
{
  const dir = tmpProject((c) => {
    c.currentPhase = "define";
    c.phases.enabled = ["define", "build", "ship"];
  });
  try {
    const skipped = await transitionPhase(dir, "plan");
    assert.equal(skipped.ok, false, "a disabled phase is not a legal target");

    const ok = await transitionPhase(dir, "build");
    assert.equal(ok.ok, true, ok.error ?? "");
    assert.equal(loadConfig(dir).config.currentPhase, "build");

    const last = await advancePhase(dir);
    assert.equal(last.to, "ship");
    assert.equal(isFinalPhase("ship", loadConfig(dir).config.phases.enabled), true);
    console.log("✓ a custom pipeline is honoured end to end");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("All phases tests PASS");
