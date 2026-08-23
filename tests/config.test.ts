import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COVERAGE_THRESHOLD_DEFAULT,
  DEFAULT_FEATURE_RETRIES,
  DEFAULT_MAX_RETRIES,
  DEFAULT_PHASE_RETRIES,
  GATE_HISTORY_LIMIT,
  currentRoleFor,
  defaultConfig,
  getKey,
  getRetryConfig,
  incrementFeatureRetry,
  incrementPhaseRetry,
  incrementTaskRetry,
  isHarnessProject,
  isRetryExhausted,
  loadConfig,
  recordGate,
  resetFeatureRetry,
  resetPhaseRetry,
  resetTaskRetry,
  saveConfig,
  setKey,
  trimGateHistory,
  validateConfig,
} from "../src/core/config.ts";
import { DEFAULT_ENABLED_PHASES, type HarnessConfig } from "../src/core/types.ts";

function tmpProject(): string {
  const d = mkdtempSync(join(tmpdir(), "pi-config-"));
  mkdirSync(join(d, "harness"), { recursive: true });
  return d;
}

function configFile(dir: string): string {
  return join(dir, "harness", "config.json");
}

function writeRaw(dir: string, text: string): void {
  writeFileSync(configFile(dir), text, "utf-8");
}

// ── defaults ───────────────────────────────────────────────────────────────
{
  const c = defaultConfig();
  assert.equal(c.version, "2.0");
  assert.equal(c.mode, "copilot");
  assert.equal(c.currentPhase, null, "a fresh project has not entered a phase");
  assert.equal(c.currentRole, null);
  assert.equal(c.paused, false);
  assert.equal(c.gates.enabled, true, "gates are on by default — that is the whole point");
  assert.deepEqual(c.gates.checks, ["all"]);
  assert.equal(c.gates.coverage.enabled, false);
  assert.equal(c.gates.coverage.threshold, COVERAGE_THRESHOLD_DEFAULT);
  assert.equal(c.gates.antiPlaceholder.enabled, true);
  assert.deepEqual(c.phases.enabled, DEFAULT_ENABLED_PHASES);
  assert.ok(!c.phases.enabled.includes("simplify"), "SIMPLIFY is opt-in");
  assert.equal(c.maxRetries, DEFAULT_MAX_RETRIES);
  assert.deepEqual(c.gateHistory, []);
  assert.deepEqual(validateConfig(c), [], "the defaults are themselves valid");

  // Each call is a fresh object — one caller's mutation cannot leak into another's.
  const other = defaultConfig();
  other.gates.checks.push("lint");
  assert.deepEqual(defaultConfig().gates.checks, ["all"]);
  assert.notEqual(c.phases.enabled, other.phases.enabled);
  console.log("✓ defaults");
}

// ── deep merge over defaults ───────────────────────────────────────────────
{
  const dir = tmpProject();
  try {
    writeRaw(
      dir,
      JSON.stringify({
        mode: "autopilot",
        currentPhase: "build",
        gates: { coverage: { threshold: 95 }, checks: ["lint", "tests"] },
        phases: { enabled: ["define", "build"] },
        retry: { features: { enabled: true } },
        customFutureKey: { nested: true },
      }),
    );
    const { ok, config, seeded, error } = loadConfig(dir);
    assert.equal(ok, true);
    assert.equal(seeded, false);
    assert.equal(error, null);

    // Supplied values win.
    assert.equal(config.mode, "autopilot");
    assert.equal(config.currentPhase, "build");
    assert.equal(config.gates.coverage.threshold, 95);

    // Nested defaults the partial never mentioned survive the merge.
    assert.equal(config.gates.enabled, true, "gates.enabled survives a partial gates block");
    assert.equal(config.gates.coverage.enabled, false, "sibling key inside a nested object survives");
    assert.equal(config.gates.antiPlaceholder.enabled, true);
    assert.equal(config.retry.features.maxRetries, DEFAULT_FEATURE_RETRIES, "sibling of a nested override survives");
    assert.equal(config.retry.tasks.enabled, true, "untouched nested branches survive");
    assert.equal(config.maxRetries, DEFAULT_MAX_RETRIES);

    // Arrays are replaced wholesale, never element-merged.
    assert.deepEqual(config.gates.checks, ["lint", "tests"]);
    assert.deepEqual(config.phases.enabled, ["define", "build"]);

    // Keys the harness does not know about are carried through untouched.
    assert.deepEqual(config.customFutureKey, { nested: true });
    console.log("✓ deep merge keeps nested defaults and replaces arrays");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── loadConfig: missing vs empty vs corrupt ────────────────────────────────
{
  const dir = tmpProject();
  try {
    assert.equal(isHarnessProject(dir), false);
    const missing = loadConfig(dir);
    assert.equal(missing.ok, false, "an uninitialised project is not ok");
    assert.equal(missing.seeded, true, "…but it is seeded with defaults so callers can still read state");
    assert.match(missing.error ?? "", /no harness\/config.json/);
    assert.deepEqual(missing.config, defaultConfig());

    writeRaw(dir, "");
    assert.equal(isHarnessProject(dir), true, "the file exists even though it says nothing");
    const empty = loadConfig(dir);
    assert.equal(empty.ok, false);
    assert.equal(empty.seeded, true);
    assert.match(empty.error ?? "", /empty/);

    // A corrupt file must never throw: every lifecycle hook calls loadConfig,
    // and a throw there kills the session.
    writeRaw(dir, '{ "mode": "autopilot", ');
    let corrupt!: ReturnType<typeof loadConfig>;
    assert.doesNotThrow(() => {
      corrupt = loadConfig(dir);
    }, "loadConfig must not throw on a corrupt file");
    assert.equal(corrupt.ok, false);
    assert.equal(corrupt.seeded, false, "corrupt is not the same as absent — do not claim it was seeded");
    assert.ok(corrupt.error && corrupt.error.length > 0, "the parse error is reported");
    assert.match(corrupt.error!, /not valid JSON/);
    assert.deepEqual(corrupt.config, defaultConfig(), "callers still get a usable config object");

    // The corrupt file is left alone rather than clobbered with defaults.
    assert.equal(readFileSync(configFile(dir), "utf-8"), '{ "mode": "autopilot", ');
    console.log("✓ loadConfig: missing, empty and corrupt all degrade without throwing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── saveConfig round-trip ──────────────────────────────────────────────────
{
  const dir = tmpProject();
  try {
    const c = defaultConfig();
    c.currentPhase = "verify";
    c.currentRole = currentRoleFor("verify");
    c.currentFeature = "feature-002";
    c.currentTask = "feature-002/task-3";
    c.taskRetryCount = 4;
    c.gates.coverage.threshold = 91;
    c.commands.test = "npm test";
    recordGate(c, "build", "pass", { feature: "feature-001", task: "task-1" });

    const saved = saveConfig(dir, c);
    assert.equal(saved.ok, true);
    assert.equal(saved.error, null);
    assert.ok(existsSync(configFile(dir)));

    const round = loadConfig(dir);
    assert.equal(round.ok, true);
    assert.deepEqual(round.config, c, "everything written comes back identical");
    assert.equal(round.config.currentRole, "evaluator");
    assert.equal(round.config.gateHistory.length, 1);
    assert.equal(round.config.gateHistory[0]!.feature, "feature-001");

    // The previous revision is kept beside the file before it is overwritten.
    assert.equal(existsSync(configFile(dir) + ".bak"), false, "nothing to back up on the first write");
    round.config.currentPhase = "review";
    saveConfig(dir, round.config);
    assert.equal(existsSync(configFile(dir) + ".bak"), true, "the prior revision is kept");
    assert.equal(JSON.parse(readFileSync(configFile(dir) + ".bak", "utf-8")).currentPhase, "verify");
    assert.equal(loadConfig(dir).config.currentPhase, "review");
    console.log("✓ saveConfig round-trip and backup");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── gate history ───────────────────────────────────────────────────────────
{
  const c = defaultConfig();
  recordGate(c, "build", "fail");
  assert.equal(c.gateHistory.length, 1);
  const entry = c.gateHistory[0]!;
  assert.equal(entry.phase, "build");
  assert.equal(entry.result, "fail");
  assert.ok(!Number.isNaN(Date.parse(entry.timestamp)), "the timestamp is an ISO instant");
  assert.equal("feature" in entry, false, "scope keys are omitted, not written as undefined");
  assert.equal("task" in entry, false);

  recordGate(c, "verify", "pass", { feature: "feature-001", task: "task-2" });
  assert.equal(c.gateHistory[1]!.feature, "feature-001");
  assert.equal(c.gateHistory[1]!.task, "task-2");

  // A corrupted gateHistory is repaired rather than allowed to throw.
  (c as unknown as Record<string, unknown>).gateHistory = "not an array";
  trimGateHistory(c);
  assert.deepEqual(c.gateHistory, []);
  (c as unknown as Record<string, unknown>).gateHistory = null;
  recordGate(c, "ship", "pass");
  assert.equal(c.gateHistory.length, 1);

  // Unbounded growth is a real problem on multi-day runs: the newest entries win.
  const big = defaultConfig();
  const overflow = GATE_HISTORY_LIMIT + 100;
  for (let i = 0; i < overflow; i++) recordGate(big, `p${i}`, i % 2 === 0 ? "pass" : "fail");
  assert.equal(big.gateHistory.length, GATE_HISTORY_LIMIT, "history is capped");
  assert.equal(big.gateHistory[GATE_HISTORY_LIMIT - 1]!.phase, `p${overflow - 1}`, "the newest entry is kept");
  assert.equal(big.gateHistory[0]!.phase, `p${overflow - GATE_HISTORY_LIMIT}`, "the oldest entries are dropped");

  // trimGateHistory is idempotent and leaves an under-cap history alone.
  const before = JSON.stringify(big.gateHistory);
  trimGateHistory(big);
  assert.equal(JSON.stringify(big.gateHistory), before);
  console.log("✓ recordGate and trimGateHistory cap the history at GATE_HISTORY_LIMIT");
}

// ── retry budgets ──────────────────────────────────────────────────────────
{
  const c = defaultConfig();
  const r = getRetryConfig(c);
  assert.deepEqual(r, {
    tasks: { enabled: true, max: DEFAULT_MAX_RETRIES },
    features: { enabled: false, max: DEFAULT_FEATURE_RETRIES },
    phases: { enabled: false, max: DEFAULT_PHASE_RETRIES },
  });

  // A null task budget inherits the legacy `maxRetries` knob.
  c.maxRetries = 3;
  assert.equal(getRetryConfig(c).tasks.max, 3, "tasks.maxRetries=null falls back to maxRetries");
  c.retry.tasks.maxRetries = 7;
  assert.equal(getRetryConfig(c).tasks.max, 7, "an explicit budget wins over the legacy knob");

  // Counters.
  const k = defaultConfig();
  assert.equal(incrementTaskRetry(k), 1);
  assert.equal(incrementTaskRetry(k), 2);
  resetTaskRetry(k);
  assert.equal(k.taskRetryCount, 0);
  assert.equal(incrementFeatureRetry(k), 1);
  resetFeatureRetry(k);
  assert.equal(k.featureRetryCount, 0);
  assert.equal(incrementPhaseRetry(k), 1);
  assert.equal(k.retryCount, 1, "the phase counter keeps the legacy retryCount in step");
  incrementPhaseRetry(k);
  assert.equal(k.phaseRetryCount, 2);
  assert.equal(k.retryCount, 2);
  resetPhaseRetry(k);
  assert.equal(k.phaseRetryCount, 0);
  assert.equal(k.retryCount, 0);

  // Counters survive an absent field (an older config file).
  const legacy = defaultConfig();
  delete (legacy as unknown as Record<string, unknown>).taskRetryCount;
  assert.equal(incrementTaskRetry(legacy), 1);
  console.log("✓ retry counters");
}

// ── isRetryExhausted respects the enabled flags ────────────────────────────
{
  const c = defaultConfig();
  assert.deepEqual(isRetryExhausted(c), { exhausted: false, which: null });

  c.taskRetryCount = DEFAULT_MAX_RETRIES;
  assert.deepEqual(isRetryExhausted(c), { exhausted: true, which: "task" }, "task budget is enabled by default");

  // A disabled bucket is never exhausted, however high the counter goes.
  c.retry.tasks.enabled = false;
  c.taskRetryCount = 9999;
  assert.deepEqual(isRetryExhausted(c), { exhausted: false, which: null }, "a disabled budget cannot stop the run");

  c.featureRetryCount = 99;
  assert.equal(isRetryExhausted(c).exhausted, false, "the feature budget is off by default too");
  c.retry.features.enabled = true;
  assert.deepEqual(isRetryExhausted(c), { exhausted: true, which: "feature" });

  const p = defaultConfig();
  p.retry.tasks.enabled = false;
  p.retry.phases.enabled = true;
  p.phaseRetryCount = DEFAULT_PHASE_RETRIES - 1;
  assert.equal(isRetryExhausted(p).exhausted, false, "one under the limit is not exhausted");
  p.phaseRetryCount = DEFAULT_PHASE_RETRIES;
  assert.deepEqual(isRetryExhausted(p), { exhausted: true, which: "phase" }, "the limit itself is exhausted");

  // Reporting order: the most specific budget is named first.
  const all = defaultConfig();
  all.retry.features.enabled = true;
  all.retry.phases.enabled = true;
  all.taskRetryCount = 999;
  all.featureRetryCount = 999;
  all.phaseRetryCount = 999;
  assert.equal(isRetryExhausted(all).which, "task");
  console.log("✓ isRetryExhausted respects the enabled flags");
}

// ── dotted get/set ─────────────────────────────────────────────────────────
{
  const c = defaultConfig();
  assert.equal(getKey(c, "mode"), "copilot");
  assert.equal(getKey(c, "gates.coverage.threshold"), COVERAGE_THRESHOLD_DEFAULT);
  assert.equal(getKey(c, "retry.tasks.enabled"), true);
  assert.deepEqual(getKey(c, "gates.checks"), ["all"]);
  assert.equal(getKey(c, "gates.nope"), undefined, "an unknown leaf is undefined");
  assert.equal(getKey(c, "nope.nope.nope"), undefined, "an unknown branch is undefined, not a throw");
  assert.equal(getKey(c, "maxRetries.deeper"), undefined, "descending into a scalar is undefined");

  setKey(c, "gates.coverage.threshold", 65);
  assert.equal(c.gates.coverage.threshold, 65);
  setKey(c, "mode", "autopilot");
  assert.equal(c.mode, "autopilot");
  setKey(c, "gates.checks", ["lint"]);
  assert.deepEqual(c.gates.checks, ["lint"]);

  // Setting one key in an existing section leaves its siblings alone — the
  // config TUI writes a single setting at a time and must not blank the rest.
  setKey(c, "loop.maxIterations", 25);
  assert.equal(c.loop.maxIterations, 25);
  assert.equal(c.loop.noProgressLimit, 3, "a sibling in the same section survives");

  // Missing intermediates are created all the way down.
  setKey(c, "custom.nested.deep.value", "x");
  assert.equal(getKey(c, "custom.nested.deep.value"), "x");
  setKey(c, "custom.nested.other", 1);
  assert.equal(getKey(c, "custom.nested.deep.value"), "x", "creating a sibling does not wipe the branch");

  // A scalar standing where an object is needed is replaced.
  setKey(c, "maxRetries.deeper", 1);
  assert.deepEqual(c.maxRetries, { deeper: 1 });

  // Dotted writes survive a save/load round-trip.
  const dir = tmpProject();
  try {
    const fresh = defaultConfig();
    setKey(fresh, "loop.maxWallClockMs", 1234);
    saveConfig(dir, fresh);
    assert.equal(getKey(loadConfig(dir).config, "loop.maxWallClockMs"), 1234);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("✓ getKey/setKey on dotted paths");
}

// ── validateConfig / currentRoleFor ────────────────────────────────────────
{
  const c = defaultConfig();
  delete (c as unknown as Record<string, unknown>).gates;
  (c as unknown as Record<string, unknown>).mode = null;
  const missing = validateConfig(c as HarnessConfig);
  assert.ok(missing.includes("gates"));
  assert.ok(missing.includes("mode"));
  assert.ok(!missing.includes("currentPhase"), "currentPhase is legitimately null before INIT");

  assert.equal(currentRoleFor(null), null);
  assert.equal(currentRoleFor("plan"), "planner");
  assert.equal(currentRoleFor("build"), "generator");
  assert.equal(currentRoleFor("verify"), "evaluator");
  assert.equal(currentRoleFor("simplify"), "simplifier");
  assert.equal(currentRoleFor("ship"), "evaluator");
  console.log("✓ validateConfig and currentRoleFor");
}

console.log("All config tests PASS");
