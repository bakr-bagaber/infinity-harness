import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseUnstuckStrategy, hashAttempt } from "../src/unstuck.ts";
import { hashLite } from "../src/worker.ts";

function tmpProject(overrides: { config?: any; router?: any } = {}): string {
  const d = mkdtempSync(join(tmpdir(), "pi-unstuck-"));
  mkdirSync(join(d, "harness"), { recursive: true });
  const cfg = overrides.config ?? {
    rework: { maxReworks: 3 },
    replan: { maxReplans: 2 },
    unstuck: { strategies: ["retry","reframe","consult","rework","replan","master"], hysteresisMs: 0 },
    review: { allowBackward: true, maxBounces: 2, bounceRequiresDelta: true },
  };
  writeFileSync(join(d, "harness", "config.json"), JSON.stringify(cfg, null, 2));
  const router = overrides.router ?? {
    version: 1, enabled: true, default: "DEF",
    byDifficulty: { easy: "E", moderate: "M", difficult: "D" },
    master: "MASTER",
    consultation: { enabled: true, maxPerTask: 1, oneStepOnly: true, requireExhaustion: true },
    budgets: { maxReworksPerRun: 3, maxReplansPerRun: 2, maxReviewBounces: 2 },
  };
  mkdirSync(join(d, "harness"), { recursive: true });
  writeFileSync(join(d, "harness", "model-router.json"), JSON.stringify(router, null, 2));
  return d;
}

// 1. order retry->reframe->consult->rework->replan->master
{
  const proj = tmpProject();
  try {
    // empty history, consult requires exhaustion so should skip to retry
    let res = chooseUnstuckStrategy({ projectDir: proj });
    assert.equal(res.strategy, "retry", "first should be retry");
    // retry dedup: fingerprint dedup skips retry -> reframe
    const fp = hashAttempt("hello");
    res = chooseUnstuckStrategy({ projectDir: proj, currentFingerprint: fp, attemptFingerprints: [fp] });
    assert.equal(res.strategy, "reframe", "dedup skips retry to reframe");
    console.log("✓ order + dedup");
  } finally { rmSync(proj, { recursive: true, force: true }); }
}

// 2. maxReworks/maxReplans/maxBounces guards skip rework/replan
{
  const proj = tmpProject();
  try {
    // force rework eligible by skipping retry/reframe/consult
    let res = chooseUnstuckStrategy({
      projectDir: proj,
      strategies: ["rework","replan","master"],
      fileDelta: true,
      reworkCount: 3, // at max 3 -> skip
      replanCount: 0,
    });
    assert.equal(res.strategy, "replan", "rework at budget -> replan");

    res = chooseUnstuckStrategy({
      projectDir: proj,
      strategies: ["rework","replan"],
      fileDelta: true,
      reworkCount: 3,
      replanCount: 2, // both at max
    });
    assert.equal(res.strategy, null, "both exhausted -> null");

    // max per task for consult
    res = chooseUnstuckStrategy({
      projectDir: proj,
      strategies: ["consult","rework"],
      currentDifficulty: "easy",
      attemptFingerprints: [hashAttempt("a")],
      consultedCount: 1, // max 1 reached
      fileDelta: true,
    });
    assert.equal(res.strategy, "rework", "consult maxPerTask skip to rework");

    // oneStepOnly already via maxPerTask, but ensure
    res = chooseUnstuckStrategy({
      projectDir: proj,
      strategies: ["consult"],
      currentDifficulty: "easy",
      attemptFingerprints: [hashAttempt("a")],
      consultedCount: 0,
      fileDelta: true,
    });
    assert.equal(res.strategy, "consult");
    assert.equal(res.nextModel, "M", "easy -> moderate");

    console.log("✓ maxReworks/maxReplans/maxPerTask guards");
  } finally { rmSync(proj, { recursive: true, force: true }); }
}

// 3. fileDelta guard and bounceRequiresDelta
{
  const proj = tmpProject({ config: {
    rework: { maxReworks: 3 },
    replan: { maxReplans: 2 },
    unstuck: { strategies: ["rework","replan","master"] },
    review: { allowBackward: true, maxBounces: 2, bounceRequiresDelta: true },
  }});
  try {
    let res = chooseUnstuckStrategy({
      projectDir: proj,
      strategies: ["rework","replan"],
      fileDelta: false, // no delta -> bounceRequiresDelta blocks
      reworkCount: 0,
      replanCount: 0,
    });
    // rework/replan both require delta, so skip to null (master would be next but not in list)
    assert.equal(res.strategy, null, "fileDelta false blocks rework/replan when bounceRequiresDelta");

    // with delta true -> rework
    res = chooseUnstuckStrategy({
      projectDir: proj,
      strategies: ["rework","replan"],
      fileDelta: true,
      reworkCount: 0,
      replanCount: 0,
    });
    assert.equal(res.strategy, "rework");

    // review bounce variant: if strategies includes only rework and fileDelta false, master should still be considered if in strategies
    res = chooseUnstuckStrategy({
      projectDir: proj,
      strategies: ["rework","master"],
      fileDelta: false,
      reworkCount: 0,
      masterUsed: false,
    });
    assert.equal(res.strategy, "master", "master not gated by fileDelta");

    console.log("✓ fileDelta + bounceRequiresDelta");
  } finally { rmSync(proj, { recursive: true, force: true }); }
}

// 4. hysteresis, requireExhaustion, master once
{
  const proj = tmpProject({ config: {
    rework: { maxReworks: 10 },
    replan: { maxReplans: 10 },
    unstuck: { strategies: ["retry","consult","master"], hysteresisMs: 60000 },
    review: { maxBounces: 10, bounceRequiresDelta: false },
  }});
  try {
    const now = Date.now();
    let res = chooseUnstuckStrategy({
      projectDir: proj,
      strategies: ["retry","consult","master"],
      lastUnstuckAt: new Date(now - 1000).toISOString(), // 1s ago, hysteresis 60s -> block
      hysteresisMs: 60000,
    });
    assert.equal(res.strategy, null);
    assert.match(res.reason, /hysteresis/);

    // requireExhaustion: consult needs prior fingerprints
    res = chooseUnstuckStrategy({
      projectDir: proj,
      strategies: ["consult","master"],
      currentDifficulty: "easy",
      attemptFingerprints: [], // empty -> requireExhaustion blocks consult
      hysteresisMs: 0,
    });
    assert.equal(res.strategy, "master", "consult blocked by requireExhaustion -> master");

    // with exhaustion -> consult
    res = chooseUnstuckStrategy({
      projectDir: proj,
      strategies: ["consult","master"],
      currentDifficulty: "easy",
      attemptFingerprints: [hashAttempt("a")],
      hysteresisMs: 0,
    });
    assert.equal(res.strategy, "consult");

    // master once per run
    res = chooseUnstuckStrategy({
      projectDir: proj,
      strategies: ["master"],
      masterUsed: true,
      hysteresisMs: 0,
    });
    assert.equal(res.strategy, null, "master once per run");

    res = chooseUnstuckStrategy({
      projectDir: proj,
      strategies: ["master"],
      masterUsed: false,
      hysteresisMs: 0,
    });
    assert.equal(res.strategy, "master");
    assert.equal(res.nextModel, "MASTER");

    console.log("✓ hysteresis + requireExhaustion + master once");
  } finally { rmSync(proj, { recursive: true, force: true }); }
}

// 5. fingerprint dedup via hashLite helper and prompt hash
{
  const proj = tmpProject({ config: {
    rework: { maxReworks: 10 },
    replan: { maxReplans: 10 },
    unstuck: { strategies: ["retry","reframe"] },
    review: { maxBounces: 10, bounceRequiresDelta: false },
  }});
  try {
    const prompt = "do the thing";
    const fp = hashLite(prompt);
    let res = chooseUnstuckStrategy({
      projectDir: proj,
      strategies: ["retry","reframe"],
      currentFingerprint: fp,
      attemptFingerprints: [fp],
      hysteresisMs: 0,
    });
    assert.equal(res.strategy, "reframe", "dedup skips retry");
    assert.equal(res.fingerprintDedup, true);

    // using currentPrompt
    res = chooseUnstuckStrategy({
      projectDir: proj,
      strategies: ["retry","reframe"],
      currentPrompt: prompt,
      attemptFingerprints: [fp],
      hysteresisMs: 0,
    });
    assert.equal(res.strategy, "reframe");

    // no dedup -> retry
    res = chooseUnstuckStrategy({
      projectDir: proj,
      strategies: ["retry","reframe"],
      currentFingerprint: hashLite("different"),
      attemptFingerprints: [fp],
      hysteresisMs: 0,
    });
    assert.equal(res.strategy, "retry");
    assert.equal(res.fingerprintDedup, false);

    console.log("✓ fingerprint dedup via hashLite");
  } finally { rmSync(proj, { recursive: true, force: true }); }
}

// 6. consultation disabled -> skip consult
{
  const proj = tmpProject({ router: {
    version: 1, enabled: true, default: "DEF",
    byDifficulty: { easy: "E", moderate: "M", difficult: "D" },
    master: "MASTER",
    consultation: { enabled: false, maxPerTask: 1, oneStepOnly: true, requireExhaustion: false },
    budgets: { maxReworksPerRun: 3, maxReplansPerRun: 2, maxReviewBounces: 2 },
  }, config: {
    rework: { maxReworks: 10 },
    unstuck: { strategies: ["consult","rework"] },
    review: { maxBounces: 10, bounceRequiresDelta: false },
  }});
  try {
    const res = chooseUnstuckStrategy({
      projectDir: proj,
      strategies: ["consult","rework"],
      currentDifficulty: "easy",
      attemptFingerprints: [hashAttempt("a")],
      hysteresisMs: 0,
      fileDelta: true,
    });
    assert.equal(res.strategy, "rework", "consultation disabled -> skip to rework");
    console.log("✓ consultation disabled");
  } finally { rmSync(proj, { recursive: true, force: true }); }
}

console.log("All unstuck tests PASS");
