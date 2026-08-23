import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBrief, renderBrief, renderBriefLine, referencedDocs } from "../src/core/brief.ts";
import { defaultConfig } from "../src/core/config.ts";
import type { FeatureList, HarnessConfig, Task, TaskStatus } from "../src/core/types.ts";

function mkTask(id: string, status: TaskStatus, extra: Record<string, unknown> = {}): Task {
  return { id, description: `Do ${id}`, status, dependsOn: [], subtasks: [], ...extra };
}

function plan(tasks: Task[], featureCriteria: string[] = ["the feature works end to end"]): FeatureList {
  return {
    version: "2.0",
    baseRevision: 3,
    goals: [{ id: "goal-001", title: "Ship the infinity harness" }],
    sprints: [],
    features: [{ id: "feature-001", name: "The first feature", criteria: featureCriteria, tasks }],
  };
}

function tmpProject(mutate: (c: HarnessConfig) => void, list: FeatureList): string {
  const d = mkdtempSync(join(tmpdir(), "pi-brief-"));
  mkdirSync(join(d, "harness", "features"), { recursive: true });
  const c = defaultConfig();
  mutate(c);
  writeFileSync(join(d, "harness", "config.json"), JSON.stringify(c, null, 2), "utf-8");
  writeFileSync(join(d, "harness", "features", "feature-list.json"), JSON.stringify(list, null, 2), "utf-8");
  return d;
}

// ── buildBrief surfaces the state that answers "what now?" ─────────────────
{
  const dir = tmpProject(
    (c) => {
      c.currentPhase = "build";
      c.currentRole = "generator";
      c.taskRetryCount = 1;
      c.phaseRetryCount = 2;
    },
    plan([
      mkTask("task-1", "complete"),
      mkTask("task-2", "in_progress", { criteria: ["the task's own criterion"] }),
      mkTask("task-3", "pending"),
      mkTask("task-4", "blocked"),
    ]),
  );
  try {
    const brief = await buildBrief(dir);
    assert.equal(brief.phase, "build");
    assert.equal(brief.role, "generator", "the role is derived from the phase");
    assert.equal(brief.paused, false);
    assert.equal(brief.complete, false);
    assert.equal(brief.goal, "Ship the infinity harness");
    assert.deepEqual(brief.feature, { id: "feature-001", name: "The first feature" });

    assert.ok(brief.task, "there is work to point at");
    assert.equal(brief.task!.id, "task-2", "the in-progress task is the one to work on");
    assert.equal(brief.task!.key, "feature-001/task-2");
    assert.equal(brief.task!.description, "Do task-2");
    assert.equal(brief.task!.status, "in_progress");

    assert.deepEqual(brief.criteria, ["the task's own criterion"], "task criteria beat feature criteria");
    assert.deepEqual(brief.progress, { tasksDone: 1, tasksTotal: 4, featuresDone: 0, featuresTotal: 1 });
    assert.deepEqual(brief.retries, { task: 1, feature: 0, phase: 2, max: 10 });
    assert.equal(brief.gate, null, "the gate is not run unless asked — it costs a lint/test run");
    assert.equal(brief.validateCommand, "infinity_validate", "the brief names a tool that exists");

    // A blocked task is something the human needs to know about.
    assert.equal(brief.notes.length, 1, brief.notes.join(" | "));
    assert.match(brief.notes[0]!, /1 task\(s\) are blocked: feature-001\/task-4/);
    console.log("✓ buildBrief surfaces phase, role, task and progress");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── buildBrief falls back to feature criteria, and reports an empty plan ───
{
  const dir = tmpProject((c) => {
    c.currentPhase = "build";
  }, plan([mkTask("task-1", "pending")]));
  try {
    const brief = await buildBrief(dir);
    assert.deepEqual(brief.criteria, ["the feature works end to end"], "feature criteria fill in for a task with none");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const bare = mkdtempSync(join(tmpdir(), "pi-brief-bare-"));
  try {
    const brief = await buildBrief(bare);
    assert.equal(brief.phase, null);
    assert.equal(brief.role, null);
    assert.equal(brief.task, null);
    assert.equal(brief.feature, null);
    assert.equal(brief.goal, null);
    assert.deepEqual(brief.progress, { tasksDone: 0, tasksTotal: 0, featuresDone: 0, featuresTotal: 0 });
    assert.ok(
      brief.notes.some((n) => /config.json is missing/.test(n)),
      "an uninitialised project says so instead of pretending",
    );
    const text = renderBrief(brief);
    assert.match(text, /NEXT STEP · NOT STARTED/);
    assert.match(text, /TASK {5}\(none actionable/);
    console.log("✓ buildBrief on an empty and an uninitialised project");
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
}

// ── renderBrief: the working brief ─────────────────────────────────────────
{
  const dir = tmpProject((c) => {
    c.currentPhase = "build";
  }, plan([mkTask("task-1", "complete"), mkTask("task-2", "in_progress")]));
  try {
    const brief = await buildBrief(dir);
    const config = defaultConfig();
    config.currentPhase = "build";
    const text = renderBrief(brief, config);

    assert.match(text, /NEXT STEP · BUILD · feature-001 · feature-001\/task-2/, "the header names the phase and task");
    assert.match(text, /GOAL {5}Ship the infinity harness/);
    assert.match(text, /ROLE {5}generator — Implement the current task/, "the role comes with its intent");
    assert.match(text, /FEATURE {2}feature-001 · The first feature/);
    assert.match(text, /TASK {5}feature-001\/task-2 \[in_progress\]/);
    assert.match(text, /Do task-2/);
    assert.match(text, /PROGRESS 1\/2 tasks · 0\/1 features · retries 0\/10/);
    assert.match(text, /PIPELINE define → plan → \[BUILD\] → verify → review → ship/);
    assert.match(text, /ACCEPTANCE CRITERIA\n {2}- the feature works end to end/);

    // The loop instructions are the whole contract with the agent.
    assert.match(text, /THE LOOP/);
    assert.match(text, /1\. Do the work described above\./);
    assert.match(text, /2\. Call the infinity_validate tool/);
    assert.match(text, /3\. FAIL → fix the listed checks and validate again\./);
    assert.match(text, /4\. PASS → the harness advances the phase and issues the next brief\./);
    assert.match(text, /Do not edit harness\/config.json by hand/);
    assert.match(text, /The gate is the only referee\./);

    // Without a config there is no pipeline line, but everything else stands.
    const noConfig = renderBrief(brief);
    assert.ok(!noConfig.includes("PIPELINE"), "the pipeline rail needs the config to know what is enabled");
    assert.match(noConfig, /THE LOOP/);
    console.log("✓ renderBrief contains the phase, the task key and the loop instructions");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── renderBrief: the paused path renders the paused text and nothing else ──
{
  const dir = tmpProject((c) => {
    c.currentPhase = "build";
    c.paused = true;
  }, plan([mkTask("task-1", "in_progress")]));
  try {
    const brief = await buildBrief(dir);
    assert.equal(brief.paused, true);
    const text = renderBrief(brief, defaultConfig());
    assert.match(text, /HARNESS PAUSED/);
    assert.match(text, /Do not continue autonomously — tell the human and stop\./);
    for (const leak of ["NEXT STEP", "THE LOOP", "PROGRESS", "TASK", "PIPELINE", "GOAL"]) {
      assert.ok(!text.includes(leak), `the paused brief must not also print ${leak}`);
    }
    assert.equal(renderBriefLine(brief), "paused");
    console.log("✓ the paused path renders the paused text and nothing else");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── renderBrief: the complete path ─────────────────────────────────────────
{
  const dir = tmpProject((c) => {
    c.currentPhase = "ship";
  }, plan([mkTask("task-1", "complete"), mkTask("task-2", "complete")]));
  try {
    const brief = await buildBrief(dir);
    assert.equal(brief.complete, true, "the final phase with every task done is a finished run");
    const text = renderBrief(brief, defaultConfig());
    assert.match(text, /PIPELINE COMPLETE/);
    assert.match(text, /All 2 task\(s\) across 1 feature\(s\) are done/);
    assert.match(text, /Report to the human; do not start new work\./);
    assert.ok(!text.includes("THE LOOP"), "there is no next step to describe");
    assert.equal(renderBriefLine(brief), "complete");

    // The same plan mid-pipeline is not complete.
    const midDir = tmpProject((c) => {
      c.currentPhase = "verify";
    }, plan([mkTask("task-1", "complete"), mkTask("task-2", "complete")]));
    try {
      const mid = await buildBrief(midDir);
      assert.equal(mid.complete, false, "all tasks done is not enough — the pipeline must be finished too");
      assert.match(renderBrief(mid), /THE LOOP/);
    } finally {
      rmSync(midDir, { recursive: true, force: true });
    }
    console.log("✓ the complete path renders the completion text");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── retry exhaustion adds an escalation note ───────────────────────────────
{
  const dir = tmpProject((c) => {
    c.currentPhase = "build";
    c.maxRetries = 4;
    c.taskRetryCount = 4;
  }, plan([mkTask("task-1", "in_progress")]));
  try {
    const brief = await buildBrief(dir);
    assert.ok(
      brief.notes.some((n) => /Retry budget for task is exhausted/.test(n)),
      `expected an exhaustion note, got: ${JSON.stringify(brief.notes)}`,
    );
    assert.ok(brief.notes.some((n) => /escalate to the human/.test(n)));
    const text = renderBrief(brief, defaultConfig());
    assert.match(text, /ATTENTION/);
    assert.match(text, /! Retry budget for task is exhausted/);
    assert.match(text, /retries 4\/4/);

    // One retry short of the budget, there is nothing to escalate.
    const okDir = tmpProject((c) => {
      c.currentPhase = "build";
      c.maxRetries = 4;
      c.taskRetryCount = 3;
    }, plan([mkTask("task-1", "in_progress")]));
    try {
      const ok = await buildBrief(okDir);
      assert.deepEqual(ok.notes, [], "under budget, no note");
      assert.ok(!renderBrief(ok).includes("ATTENTION"));
    } finally {
      rmSync(okDir, { recursive: true, force: true });
    }
    console.log("✓ retry exhaustion adds an escalation note");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── includeGate embeds a live verdict ──────────────────────────────────────
{
  const dir = tmpProject((c) => {
    c.currentPhase = "build";
  }, plan([mkTask("task-1", "pending")]));
  try {
    const brief = await buildBrief(dir, { includeGate: true });
    assert.ok(brief.gate, "a gate verdict was requested");
    assert.equal(brief.gate!.phase, "build");
    assert.equal(brief.gate!.overall, false, "one task is still open");
    assert.ok(brief.gate!.failures.includes("tasks-complete"));

    const text = renderBrief(brief);
    assert.match(text, /GATE {5}FAIL/);
    assert.match(text, /x tasks-complete: /, "failing checks are marked x");
    assert.match(text, /· lint: no lint command configured/, "advisory checks are marked ·");
    console.log("✓ includeGate embeds a live gate verdict");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── renderBriefLine and referencedDocs ─────────────────────────────────────
{
  const dir = tmpProject((c) => {
    c.currentPhase = "build";
  }, plan([mkTask("task-1", "complete"), mkTask("task-2", "in_progress"), mkTask("task-3", "pending")]));
  try {
    const brief = await buildBrief(dir);
    assert.equal(renderBriefLine(brief), "build · feature-001/task-2 · 1/3");

    assert.deepEqual(referencedDocs(dir, null), [], "no phase, no docs");
    assert.deepEqual(referencedDocs(dir, "build"), [], "nothing to point at yet");

    mkdirSync(join(dir, "harness", "docs", "phases"), { recursive: true });
    mkdirSync(join(dir, "harness", "docs", "agents"), { recursive: true });
    writeFileSync(join(dir, "harness", "docs", "phases", "build.md"), "# build", "utf-8");
    writeFileSync(join(dir, "harness", "docs", "agents", "generator.md"), "# generator", "utf-8");
    const docs = referencedDocs(dir, "build");
    assert.equal(docs.length, 2);
    assert.ok(docs[0]!.endsWith(join("docs", "phases", "build.md")));
    assert.ok(docs[1]!.endsWith(join("docs", "agents", "generator.md")), "the doc follows the phase's role");
    console.log("✓ renderBriefLine and referencedDocs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("All brief tests PASS");
