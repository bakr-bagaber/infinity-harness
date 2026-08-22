import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRouterConfig, resolveModel, consultNext, DIFFICULTY_LADDER, DEFAULT_ROUTER } from "../src/modelRouter.ts";

function tmpProject(): string {
  const d = mkdtempSync(join(tmpdir(), "pi-router-"));
  mkdirSync(join(d, "harness"), { recursive: true });
  return d;
}

// --- defaults: disabled returns default regardless of difficulty ---
{
  const proj = tmpProject();
  try {
    // no file -> disabled default
    assert.equal(resolveModel({ projectDir: proj, task: { difficulty: "difficult" } }), DEFAULT_ROUTER.default);
    // write enabled false with byDifficulty
    writeFileSync(join(proj, "harness", "model-router.json"), JSON.stringify({ version:1, enabled:false, default: "def", byDifficulty: { easy:"E", moderate:"M", difficult:"D" }, master:"MASTER" }));
    assert.equal(resolveModel({ projectDir: proj, task: { difficulty: "easy" } }), "def");
    console.log("✓ disabled returns default");
  } finally { rmSync(proj, { recursive: true, force: true }); }
}

// --- enabled priority chain: modelHint > byDifficulty > byFeature > bySprint > byPhase > byRole > default ---
{
  const proj = tmpProject();
  try {
    writeFileSync(join(proj, "harness", "model-router.json"), JSON.stringify({
      version:1, enabled:true, default:"DEF",
      byDifficulty: { easy:"EASY", moderate:"MOD", difficult:"DIFF" },
      master:"MASTER",
      byFeature: { "feature-007":"FEAT" },
      bySprint: { "sprint-006":"SPRINT" },
      byPhase: { "build":"PHASE" },
      byRole: { "generator":"ROLE" },
      byTask: { "task-014":"TASKHINT" }
    }));
    // byTask exact
    assert.equal(resolveModel({ projectDir: proj, task: { id:"task-014", key:"task-014" } }), "TASKHINT");
    // modelHint top
    assert.equal(resolveModel({ projectDir: proj, task: { modelHint:"OVERRIDE", difficulty:"easy", id:"task-014" } }), "OVERRIDE");
    // byDifficulty
    assert.equal(resolveModel({ projectDir: proj, task: { difficulty:"moderate" } }), "MOD");
    assert.equal(resolveModel({ projectDir: proj, task: { difficulty:"difficult" }, feature:{id:"feature-007"} }), "DIFF", "difficulty before feature");
    // byFeature
    assert.equal(resolveModel({ projectDir: proj, feature:{id:"feature-007"} }), "FEAT");
    // bySprint
    assert.equal(resolveModel({ projectDir: proj, sprint:{id:"sprint-006"} }), "SPRINT");
    // byPhase
    assert.equal(resolveModel({ projectDir: proj, phase:"build" }), "PHASE");
    // byRole
    assert.equal(resolveModel({ projectDir: proj, role:"generator" }), "ROLE");
    // default fallback
    assert.equal(resolveModel({ projectDir: proj }), "DEF");
    // inheritance: feature difficulty -> byDifficulty if task no difficulty
    assert.equal(resolveModel({ projectDir: proj, task:{}, feature:{difficulty:"easy"}}), "EASY");
    console.log("✓ priority chain");
  } finally { rmSync(proj, { recursive: true, force: true }); }
}

// --- ladder: MASTER never assigned ---
{
  const proj = tmpProject();
  try {
    writeFileSync(join(proj, "harness", "model-router.json"), JSON.stringify({
      version:1, enabled:true, default:"DEF",
      byDifficulty: { easy:"E", moderate:"M", difficult:"D" },
      master:"MASTER",
      consultation:{enabled:true, maxPerTask:1, oneStepOnly:true, requireExhaustion:true}
    }));
    // resolveModel never returns MASTER even for difficult (it returns D)
    assert.notEqual(resolveModel({ projectDir: proj, task:{difficulty:"difficult"}}), "MASTER");
    assert.equal(resolveModel({ projectDir: proj, task:{difficulty:"difficult"}}), "D");
    // consultNext steps one rung
    assert.equal(consultNext("easy", {projectDir: proj}), "M");
    assert.equal(consultNext("moderate", {projectDir: proj}), "D");
    assert.equal(consultNext("difficult", {projectDir: proj}), "MASTER");
    // oneStepOnly: second consult exceeds maxPerTask 1 -> null
    assert.equal(consultNext("easy", {projectDir: proj, consultedCount:1}), null);
    assert.equal(consultNext("difficult", {projectDir: proj, consultedCount:1}), null);
    // unknown difficulty -> null
    assert.equal(consultNext("unknown" as any, {projectDir: proj}), null);
    assert.equal(consultNext(null as any, {projectDir: proj}), null);
    console.log("✓ ladder MASTER never assigned, one-step");
  } finally { rmSync(proj, { recursive: true, force: true }); }
}

// --- fresh read each call (toggle disabled->enabled) ---
{
  const proj = tmpProject();
  try {
    writeFileSync(join(proj, "harness", "model-router.json"), JSON.stringify({ version:1, enabled:false, default:"DEF", byDifficulty:{easy:"E"} }));
    assert.equal(resolveModel({projectDir: proj, task:{difficulty:"easy"}}), "DEF");
    writeFileSync(join(proj, "harness", "model-router.json"), JSON.stringify({ version:1, enabled:true, default:"DEF", byDifficulty:{easy:"E"} }));
    assert.equal(resolveModel({projectDir: proj, task:{difficulty:"easy"}}), "E");
    console.log("✓ fresh read toggle");
  } finally { rmSync(proj, { recursive: true, force: true }); }
}

// --- loadRouterConfig merges defaults ---
{
  const proj = tmpProject();
  try {
    writeFileSync(join(proj, "harness", "model-router.json"), JSON.stringify({ version:1, enabled:true }));
    const cfg = loadRouterConfig(proj);
    assert.equal(cfg.version, 1);
    assert.equal(cfg.enabled, true);
    assert.ok(cfg.default);
    assert.ok(cfg.byDifficulty);
    assert.ok(cfg.master);
    assert.ok(cfg.budgets);
    console.log("✓ load merges defaults");
  } finally { rmSync(proj, { recursive: true, force: true }); }
}

console.log("All modelRouter tests PASS");
