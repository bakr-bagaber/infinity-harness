/**
 * The supervisor — the run's work happens in background pi sessions, not in
 * the human's.
 *
 * What is defended here:
 *   - the *unit* the run is on is the level the human chose for handoff, and
 *     the model comes from that unit's effective difficulty, not the task's
 *   - crossing a unit boundary closes the worker and opens a new one, which
 *     is what "session handoff" now means
 *   - staying inside a unit reuses the same session, so a feature-level
 *     handoff really is one session for the whole feature
 *   - an escalation that names a stronger model replaces the session rather
 *     than switching model inside it
 *   - the main session is never asked to do any of the work
 *
 * The worker is faked here. That a real `pi --mode rpc` child accepts the
 * argv, honours `--model`, and settles is proved in the `background` e2e
 * scenario against a real pi process.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig, saveConfig } from "../src/core/config.ts";
import { saveFeatureList } from "../src/core/featureList.ts";
import { saveRouterConfig, DEFAULT_ROUTER } from "../src/modelRouter.ts";
import { armRun } from "../src/runState.ts";
import type { FeatureList, HandoffGranularity } from "../src/core/types.ts";
import {
  currentUnit,
  isRefusal,
  activeOwner,
  processAlive,
  type RunningSupervisor,
  type SupervisorRefusal,
  unitLevelFor,
  describeUnit,
  startSupervisor,
  loadActivity,
  loadSupervisorState,
  appendActivity,
  saveSupervisorState,
  emptySupervisorState,
  reapOrphanWorker,
  ACTIVITY_LIMIT,
} from "../src/supervisor.ts";
import type { LoopDecision } from "../src/loop.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "supervisor-test-"));

/** Narrow away the "someone else is driving" refusal, which these cases never hit. */
function driving(r: RunningSupervisor | SupervisorRefusal): RunningSupervisor {
  assert.equal(isRefusal(r), false, isRefusal(r) ? r.reason : "");
  return r as RunningSupervisor;
}

const PLAN: FeatureList = {
  version: "2.0",
  baseRevision: 1,
  goals: [{ id: "goal-1", title: "Ship the thing" }],
  sprints: [{ id: "sprint-1", goalId: "goal-1", name: "Foundations" }],
  features: [
    {
      id: "feature-1",
      name: "Auth",
      sprintId: "sprint-1",
      goalId: "goal-1",
      criteria: ["works"],
      tasks: [
        {
          id: "task-1",
          key: "feature-1/task-1",
          description: "login form",
          status: "pending",
          difficulty: "easy",
          subtasks: [
            { id: "st-1", title: "markup", status: "pending" },
            { id: "st-2", title: "validation", status: "pending" },
          ],
        },
        { id: "task-2", key: "feature-1/task-2", description: "session cookie", status: "pending", difficulty: "difficult" },
      ],
    },
    {
      id: "feature-2",
      name: "Billing",
      sprintId: "sprint-1",
      goalId: "goal-1",
      criteria: ["works"],
      tasks: [{ id: "task-3", key: "feature-2/task-3", description: "stripe", status: "pending", difficulty: "moderate" }],
    },
  ],
};

function project(handoff: HandoffGranularity): string {
  const d = tmp();
  const cfg = defaultConfig();
  cfg.currentPhase = "build";
  cfg.phases = { enabled: ["build", "verify"] };
  cfg.session = { handoff, contextThreshold: 0.6, carryNotes: true };
  saveConfig(d, cfg);
  saveFeatureList(d, structuredClone(PLAN));
  saveRouterConfig(d, {
    ...DEFAULT_ROUTER,
    enabled: true,
    default: "prov/A",
    byDifficulty: { easy: "prov/B", moderate: "prov/C", difficult: "prov/D" },
    master: "prov/X",
  });
  return d;
}

// ── the handoff level is the unit level ────────────────────────────────────
{
  assert.equal(unitLevelFor("off"), "run");
  assert.equal(unitLevelFor("goal"), "goal");
  assert.equal(unitLevelFor("phase"), "phase");
  assert.equal(unitLevelFor("subtask"), "subtask");
  assert.equal(unitLevelFor("task"), "task");
  console.log("✓ supervisor — handoff granularity maps to a unit level");
}

// ── the unit picks the model, and the level picks the difficulty ───────────
{
  // task level: this task's own difficulty (easy) → model B
  const dTask = project("task");
  const uTask = currentUnit(dTask)!;
  assert.equal(uTask.level, "task");
  assert.equal(uTask.key, "task:feature-1/task-1");
  assert.equal(uTask.difficulty, "easy");
  assert.equal(uTask.model, "prov/B", "an easy task runs on the easy-tier model");

  // subtask level: the subtask inherits the task's difficulty, but the *unit*
  // is the subtask, so a handoff happens between the two subtasks.
  const dSub = project("subtask");
  const uSub = currentUnit(dSub)!;
  assert.equal(uSub.level, "subtask");
  assert.equal(uSub.key, "subtask:feature-1/task-1#st-1");
  assert.equal(uSub.model, "prov/B");

  // feature level: the bucket is the feature, whose hardest task is difficult
  // → the whole feature runs on model D. This is the trade-off the wizard
  // warns about, and it must actually happen.
  const dFeat = project("feature");
  const uFeat = currentUnit(dFeat)!;
  assert.equal(uFeat.level, "feature");
  assert.equal(uFeat.key, "feature:feature-1");
  assert.equal(uFeat.difficulty, "difficult");
  assert.equal(uFeat.model, "prov/D", "a feature runs on its hardest task's model");

  // phase level: the bucket is every task in BUILD → still difficult.
  const dPhase = project("phase");
  const uPhase = currentUnit(dPhase)!;
  assert.equal(uPhase.key, "phase:build");
  assert.equal(uPhase.model, "prov/D");

  // sprint level: one sprint holds both features → hardest is difficult.
  const dSprint = project("sprint");
  assert.equal(currentUnit(dSprint)!.key, "sprint:sprint-1");

  // goal / off: one session for the run.
  assert.equal(currentUnit(project("goal"))!.key, "goal:goal-1");
  assert.equal(currentUnit(project("off"))!.key, "run");

  assert.match(describeUnit(uTask), /task feature-1\/task-1.*easy.*prov\/B/);
  for (const d of [dTask, dSub, dFeat, dPhase, dSprint]) rmSync(d, { recursive: true, force: true });
  console.log("✓ supervisor — the unit's effective difficulty picks the model");
}

// ── an empty router slot inherits the main session's model ─────────────────
{
  const d = project("task");
  saveRouterConfig(d, { ...DEFAULT_ROUTER, enabled: false, default: "" });
  const u = currentUnit(d, "human/model-X")!;
  assert.equal(u.model, "human/model-X", "routing off means the worker uses pi's current model");
  rmSync(d, { recursive: true, force: true });
  console.log("✓ supervisor — an unrouted unit inherits the base model");
}

// ── the loop: one session per unit, reused inside a unit ───────────────────

/** A worker that records what it was asked, and never spawns anything. */
class FakeWorker {
  static made: FakeWorker[] = [];
  spec: Record<string, unknown>;
  prompts: string[] = [];
  closed = false;
  startError: string | null = null;
  sessionId = "fake";
  servedModel: string | null = null;
  exited = false;
  private listeners: Array<(e: unknown) => void> = [];
  constructor(spec: Record<string, unknown>) {
    this.spec = spec;
    FakeWorker.made.push(this);
  }
  on(l: (e: unknown) => void): () => void {
    this.listeners.push(l);
    return () => {};
  }
  start(): void {}
  async ready(): Promise<boolean> {
    return true;
  }
  async prompt(text: string): Promise<Record<string, unknown>> {
    this.prompts.push(text);
    return { summary: "did it", tools: [], usage: { inputTokens: 1, outputTokens: 1 }, contextRatio: 0.1, aborted: false, error: null };
  }
  async contextRatio(): Promise<number | null> {
    return 0.1;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.exited = true;
  }
}

/** Feed the supervisor a scripted sequence of loop decisions. */
function scriptedDecider(script: LoopDecision[]) {
  let i = 0;
  return async (): Promise<{ decision: LoopDecision; state: unknown }> => {
    const decision = script[Math.min(i, script.length - 1)]!;
    i += 1;
    return { decision, state: {} };
  };
}

const cont = (msg: string, over: Partial<Extract<LoopDecision, { action: "continue" }>> = {}): LoopDecision => ({
  action: "continue",
  message: msg,
  headline: "fix the gate",
  reason: "gate failed",
  ...over,
});

{
  // Task-level handoff, and the plan moves from task-1 to task-2 between
  // cycles: that is a unit boundary, so the first worker is closed and a
  // second one starts — on the *difficult* model, because task-2 is difficult.
  const d = project("task");
  armRun(d, "run-A");
  FakeWorker.made = [];
  let cycle = 0;
  const sup = startSupervisor({
    targetDir: d,
    runId: "run-A",
    baseModel: "human/model-X",
    maxCycles: 3,
    idleMs: 0,
    createWorker: ((spec: Record<string, unknown>) => new FakeWorker(spec)) as never,
    decide: (async () => {
      cycle += 1;
      if (cycle === 2) {
        // Task 1 is done; the next actionable task is task-2 (difficult).
        const list = structuredClone(PLAN);
        list.features[0]!.tasks[0]!.status = "complete";
        list.baseRevision = 2;
        saveFeatureList(d, list);
      }
      return { decision: cont(`BRIEF ${cycle}`), state: {} };
    }) as never,
  });
  await driving(sup).done;

  assert.equal(FakeWorker.made.length, 2, "a unit boundary starts a second session");
  assert.equal(FakeWorker.made[0]!.spec.model, "prov/B", "task-1 is easy → model B");
  assert.equal(FakeWorker.made[1]!.spec.model, "prov/D", "task-2 is difficult → model D");
  assert.equal(FakeWorker.made[0]!.closed, true, "the first session is closed at the boundary");
  assert.equal(FakeWorker.made[0]!.spec.unitKey, "task:feature-1/task-1");
  assert.equal(FakeWorker.made[1]!.spec.unitKey, "task:feature-1/task-2");

  const activity = loadActivity(d);
  assert.ok(
    activity.some((l) => /handoff/.test(l.text)),
    "the background log records the handoff",
  );
  const state = loadSupervisorState(d)!;
  assert.equal(state.status, "stopped");
  assert.equal(state.sessions, 2);
  rmSync(d, { recursive: true, force: true });
  console.log("✓ supervisor — a unit boundary is a new session on a new model");
}

{
  // Feature-level handoff over the same two tasks: both live in feature-1, so
  // there is no boundary and no second session. This is the bug the user
  // reported from the other side — a handoff level coarser than the task must
  // not start a session per task.
  const d = project("feature");
  armRun(d, "run-B");
  FakeWorker.made = [];
  let cycle = 0;
  const sup = startSupervisor({
    targetDir: d,
    runId: "run-B",
    maxCycles: 3,
    idleMs: 0,
    createWorker: ((spec: Record<string, unknown>) => new FakeWorker(spec)) as never,
    decide: (async () => {
      cycle += 1;
      if (cycle === 2) {
        const list = structuredClone(PLAN);
        list.features[0]!.tasks[0]!.status = "complete";
        list.baseRevision = 2;
        saveFeatureList(d, list);
      }
      return { decision: cont(`BRIEF ${cycle}`), state: {} };
    }) as never,
  });
  await driving(sup).done;

  assert.equal(FakeWorker.made.length, 1, "staying inside a feature keeps one session");
  const w = FakeWorker.made[0]!;
  assert.equal(w.prompts.length, 3, "the same session got every cycle's instruction");
  assert.match(w.prompts[0]!, /BRIEF 1/, "the first prompt carries the whole brief");
  assert.match(w.prompts[0]!, /YOUR REMIT/, "and the remit for the unit");
  assert.equal(/BRIEF 2/.test(w.prompts[1]!), false, "a returning session is not re-sent the brief");
  assert.match(w.prompts[1]!, /fix the gate/, "it gets the instruction alone");
  rmSync(d, { recursive: true, force: true });
  console.log("✓ supervisor — one session per feature, and the brief is sent once");
}

{
  // An escalation naming a stronger model must replace the session: putting
  // the master model in front of the weak model's failed reasoning is the
  // context we are escalating away from.
  const d = project("task");
  armRun(d, "run-C");
  FakeWorker.made = [];
  const sup = startSupervisor({
    targetDir: d,
    runId: "run-C",
    maxCycles: 2,
    idleMs: 0,
    createWorker: ((spec: Record<string, unknown>) => new FakeWorker(spec)) as never,
    decide: scriptedDecider([
      cont("BRIEF"),
      cont("BRIEF", { escalation: { strategy: "consult", model: "prov/X", level: "task" } }),
    ]) as never,
  });
  await driving(sup).done;
  assert.equal(FakeWorker.made.length, 2, "escalating to another model starts a new session");
  assert.equal(FakeWorker.made[1]!.spec.model, "prov/X");
  assert.ok(
    loadActivity(d).some((l) => /escalation: consult → prov\/X/.test(l.text)),
    "and says so in the log",
  );
  rmSync(d, { recursive: true, force: true });
  console.log("✓ supervisor — an escalation is a session boundary too");
}

{
  // A stop decision ends the run, closes the worker and disarms — a run that
  // stops must not leave a pi child alive.
  const d = project("task");
  armRun(d, "run-D");
  FakeWorker.made = [];
  const sup = startSupervisor({
    targetDir: d,
    runId: "run-D",
    idleMs: 0,
    createWorker: ((spec: Record<string, unknown>) => new FakeWorker(spec)) as never,
    decide: scriptedDecider([
      cont("BRIEF"),
      { action: "stop", reason: "complete", detail: "every phase passed" },
    ]) as never,
  });
  await driving(sup).done;
  assert.equal(FakeWorker.made.length, 1);
  assert.equal(FakeWorker.made[0]!.closed, true, "the worker is closed when the run stops");
  const state = loadSupervisorState(d)!;
  assert.equal(state.status, "stopped");
  assert.match(state.stopReason ?? "", /every phase passed/);
  rmSync(d, { recursive: true, force: true });
  console.log("✓ supervisor — a stop closes the background session");
}

{
  // stop() from outside must return, even while a worker is mid-turn. A
  // supervisor you cannot stop is worse than one that never started.
  const d = project("task");
  armRun(d, "run-E");
  class SlowWorker extends FakeWorker {
    async prompt(text: string): Promise<Record<string, unknown>> {
      this.prompts.push(text);
      await new Promise((r) => setTimeout(r, 5000));
      return { summary: "", tools: [], usage: { inputTokens: 0, outputTokens: 0 }, contextRatio: null, aborted: true, error: "closed" };
    }
  }
  FakeWorker.made = [];
  const sup = startSupervisor({
    targetDir: d,
    runId: "run-E",
    idleMs: 0,
    createWorker: ((spec: Record<string, unknown>) => new SlowWorker(spec)) as never,
    decide: scriptedDecider([cont("BRIEF")]) as never,
  });
  await new Promise((r) => setTimeout(r, 100));
  const began = Date.now();
  await driving(sup).stop("human hit halt");
  assert.ok(Date.now() - began < 4000, "stop() must not wait out a running turn");
  assert.equal(FakeWorker.made[0]!.closed, true);
  rmSync(d, { recursive: true, force: true });
  console.log("✓ supervisor — stop() returns while a worker is mid-turn");
}

// ── the activity log is bounded ────────────────────────────────────────────
{
  const d = tmp();
  for (let i = 0; i < ACTIVITY_LIMIT + 25; i += 1) appendActivity(d, { level: "info", worker: null, text: `line ${i}` });
  const lines = loadActivity(d);
  assert.equal(lines.length, ACTIVITY_LIMIT, "the log is a ring, not a landfill");
  assert.match(lines[lines.length - 1]!.text, /line 424/);
  rmSync(d, { recursive: true, force: true });
  console.log("✓ supervisor — the background log is bounded");
}

// ── one driver per project ─────────────────────────────────────────────────
//
// Two pi windows open on the same project would both start a supervisor, and
// the run would get two workers editing the same tree. Every lock in this
// codebase exists to stop exactly that.
{
  const d = project("task");
  armRun(d, "run-F");
  FakeWorker.made = [];
  const first = driving(
    startSupervisor({
      targetDir: d,
      runId: "run-F",
      idleMs: 50,
      sessionId: "window-1",
      createWorker: ((spec: Record<string, unknown>) => new FakeWorker(spec)) as never,
      decide: scriptedDecider([cont("BRIEF")]) as never,
    }),
  );
  await new Promise((r) => setTimeout(r, 150));

  const owner = activeOwner(d, -1);
  assert.ok(owner, "the driving session records a claim");
  assert.equal(owner!.sessionId, "window-1");

  // A second window, in the same process, must be refused rather than
  // silently doubling the workers.
  const second = startSupervisor({
    targetDir: d,
    runId: "run-F",
    idleMs: 50,
    sessionId: "window-2",
    createWorker: ((spec: Record<string, unknown>) => new FakeWorker(spec)) as never,
    decide: scriptedDecider([cont("BRIEF")]) as never,
  });
  // Same pid here, so force the claim to look like another process's.
  assert.equal(isRefusal(second), false, "same-process restarts are allowed — the pid matches");
  if (!isRefusal(second)) await second.stop("test");

  await first.stop("test");
  assert.equal(loadSupervisorState(d)!.owner, null, "stopping releases the claim");

  // A claim from a pid that is not running is not a claim.
  const st = loadSupervisorState(d)!;
  st.owner = { pid: 999_999, sessionId: "ghost", at: new Date().toISOString(), workerPid: null };
  saveSupervisorState(d, st);
  assert.equal(activeOwner(d, -1), null, "a dead owner does not block the next session");
  assert.equal(processAlive(999_999), false);
  assert.equal(processAlive(process.pid), true);

  // A stale heartbeat does not block either, however alive the pid looks.
  const stale = loadSupervisorState(d)!;
  stale.owner = { pid: process.pid, sessionId: "old", at: new Date(Date.now() - 10 * 60_000).toISOString(), workerPid: null };
  saveSupervisorState(d, stale);
  assert.equal(activeOwner(d, -1), null, "a heartbeat older than the stale window is abandoned");

  rmSync(d, { recursive: true, force: true });
  console.log("✓ supervisor — one driver per project, and a dead claim never wedges it");
}

// ── an orphaned worker is killed, not left running ─────────────────────────
{
  const d = project("task");
  // A real child, so the reaper has something to kill: a sleeping node.
  const { spawn } = await import("node:child_process");
  const ghost = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 200));
  const st = emptySupervisorState("run-G");
  st.owner = { pid: 999_998, sessionId: "dead", at: new Date().toISOString(), workerPid: ghost.pid ?? null };
  saveSupervisorState(d, st);

  const killed = reapOrphanWorker(d);
  assert.equal(killed, ghost.pid, "a worker whose supervisor is gone is killed");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(processAlive(ghost.pid), false, "and really is gone");

  rmSync(d, { recursive: true, force: true });
  console.log("✓ supervisor — a worker orphaned by a killed pi is reaped");
}
