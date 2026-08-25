/**
 * Session handoff — when the run should continue in a fresh pi session, and
 * what the replacement is told.
 *
 * The thing being defended here is small and easy to get wrong: a handoff is
 * only worth doing at a boundary, it must never fire twice for the same
 * boundary, and it must never lose the brief. Everything else about a handoff
 * — that pi really starts a new session, that the run's budgets carry across
 * it — is proved in the `realpi` e2e scenario against a real pi process,
 * because no unit test can see that.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearHandoff,
  composeKickoff,
  defaultSessionPolicy,
  describeHandoff,
  hasPendingHandoff,
  peekHandoff,
  requestHandoff,
  shouldHandoff,
  takeHandoff,
} from "../src/handoff.ts";
import { defaultConfig } from "../src/core/config.ts";
import { pendingSessionPath } from "../src/core/paths.ts";
import type { HarnessConfig, SessionPolicy } from "../src/core/types.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "handoff-test-"));

function config(session: Partial<SessionPolicy> = {}): HarnessConfig {
  const c = defaultConfig();
  c.session = { ...defaultSessionPolicy(), ...session };
  return c;
}

const signals = (over: Partial<Parameters<typeof shouldHandoff>[0]> = {}) => ({
  config: config(),
  fromPhase: "build" as const,
  toPhase: "build" as const,
  fromTask: "feature-001/task-001",
  toTask: "feature-001/task-001",
  contextRatio: null,
  ...over,
});

// ── when a handoff is due ──────────────────────────────────────────────────
{
  assert.equal(shouldHandoff(signals()).handoff, false, "standing still is not a boundary");

  const phase = shouldHandoff(signals({ toPhase: "verify" }));
  assert.equal(phase.handoff, true);
  assert.equal(phase.handoff && phase.reason, "phase");
  assert.match(phase.handoff ? phase.detail : "", /BUILD → VERIFY/);

  // Per-phase should ignore a task change; task (now default) should not.
  assert.equal(
    shouldHandoff(signals({ config: config({ handoff: "phase" }), toTask: "feature-001/task-002" })).handoff,
    false,
    "per-phase policy ignores a task change",
  );
  assert.equal(
    shouldHandoff(signals({ toTask: "feature-001/task-002" })).handoff,
    true,
    "default is per-task now, so a task change does handoff",
  );

  const perTask = shouldHandoff(
    signals({ config: config({ handoff: "task" }), toTask: "feature-001/task-002" }),
  );
  assert.equal(perTask.handoff, true);
  assert.equal(perTask.handoff && perTask.reason, "task");

  assert.equal(
    shouldHandoff(signals({ config: config({ handoff: "off" }), toPhase: "verify" })).handoff,
    false,
    "off means off, even at a phase boundary",
  );
  console.log("✓ shouldHandoff fires at boundaries the policy names, and nowhere else");
}

// ── context pressure ───────────────────────────────────────────────────────
{
  // The point of the context trigger is to get out *before* compaction, so it
  // outranks everything: a handoff that arrives after the context filled up
  // has arrived too late to be the thing that prevented it.
  const pressed = shouldHandoff(signals({ contextRatio: 0.82 }));
  assert.equal(pressed.handoff, true);
  assert.equal(pressed.handoff && pressed.reason, "context");
  assert.match(pressed.handoff ? pressed.detail : "", /82%/);

  assert.equal(shouldHandoff(signals({ contextRatio: 0.5 })).handoff, false, "under the threshold, nothing happens");

  assert.equal(
    shouldHandoff(signals({ config: config({ contextThreshold: 0 }), contextRatio: 0.99 })).handoff,
    false,
    "a zero threshold disables the trigger entirely",
  );

  // A misconfigured threshold must not silently become "never" or "always".
  assert.equal(
    shouldHandoff(signals({ config: config({ contextThreshold: 5 }), contextRatio: 0.96 })).handoff,
    true,
    "a threshold above 1 is clamped rather than made unreachable",
  );
  assert.equal(
    shouldHandoff(signals({ config: config({ contextThreshold: -1 }), contextRatio: 0.1 })).handoff,
    false,
    "a negative threshold is treated as off, not as always-on",
  );

  assert.equal(
    shouldHandoff(signals({ contextRatio: null, toPhase: "verify" })).handoff,
    true,
    "an unknown context ratio does not stop a phase handoff",
  );
  console.log("✓ context pressure outranks the boundary rules, and bad thresholds are clamped");
}

// ── the pending handoff file ───────────────────────────────────────────────
{
  const dir = tmp();
  assert.equal(hasPendingHandoff(dir), false);
  assert.equal(peekHandoff(dir), null);
  assert.equal(takeHandoff(dir), null, "claiming nothing is not an error");

  const pending = requestHandoff(dir, {
    reason: "phase",
    detail: "BUILD → VERIFY",
    kickoff: "the whole brief",
    carry: "  3/9 tasks done",
    runId: "run-1",
  });
  assert.ok(pending.at, "a handoff is stamped");
  assert.equal(hasPendingHandoff(dir), true);
  assert.equal(peekHandoff(dir)?.kickoff, "the whole brief");
  assert.equal(hasPendingHandoff(dir), true, "peeking does not consume it");

  const taken = takeHandoff(dir);
  assert.equal(taken?.runId, "run-1");
  assert.equal(hasPendingHandoff(dir), false, "claiming consumes it");
  assert.equal(
    takeHandoff(dir),
    null,
    "and a second claim finds nothing — a stale file must not loop the run through handoffs",
  );

  requestHandoff(dir, { reason: "manual", detail: "d", kickoff: "k", carry: null, runId: "r" });
  clearHandoff(dir);
  assert.equal(existsSync(pendingSessionPath(dir)), false);

  assert.match(
    describeHandoff({ reason: "context", detail: "context 78% full", kickoff: "", carry: null, runId: "r", at: "" }),
    /context/,
  );
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ a pending handoff is written once, claimed once, and never twice");
}

// ── what the replacement session is told ───────────────────────────────────
{
  const kickoff = composeKickoff("NEXT STEP · VERIFY\n…", "phase", "BUILD → VERIFY", "  3/9 tasks done");

  assert.match(kickoff, /NEXT STEP · VERIFY/, "the brief is the point — it must survive");
  assert.match(kickoff, /BUILD → VERIFY/, "and it says why this session exists");
  assert.match(kickoff, /3\/9 tasks done/, "the carry note comes across");
  assert.match(kickoff, /harness\//, "it points at where the state actually lives");
  assert.match(
    kickoff,
    /Do not\s*\n?\s*go looking for the previous conversation/,
    "an agent that wakes up mid-run must be told not to go hunting for context",
  );

  for (const reason of ["phase", "task", "context", "goal-pass", "manual"] as const) {
    const text = composeKickoff("BRIEF", reason, "detail", null);
    assert.match(text, /BRIEF/);
    assert.ok(text.split("\n").length > 3, `${reason} produced a kickoff with no explanation`);
  }
  console.log("✓ the kickoff carries the brief, the reason, and the note");
}

// -- full granularity (goal/phase/sprint/feature/task/subtask) ----------------
{
  const sprint = shouldHandoff(signals({ config: config({ handoff: "sprint" }), fromSprint: "s-1", toSprint: "s-2" }));
  assert.equal(sprint.handoff, true);
  assert.equal(sprint.handoff && (sprint as { reason: string }).reason, "sprint");
  assert.equal(shouldHandoff(signals({ config: config({ handoff: "phase" }), fromSprint: "s-1", toSprint: "s-2" })).handoff, false, "phase must not fire on sprint");

  const feat = shouldHandoff(signals({ config: config({ handoff: "feature" }), fromFeature: "f-1", toFeature: "f-2" }));
  assert.equal(feat.handoff, true);
  assert.equal(feat.handoff && (feat as { reason: string }).reason, "feature");

  const sub = shouldHandoff(signals({ config: config({ handoff: "subtask" }), fromSubtask: "t#s-1", toSubtask: "t#s-2" }));
  assert.equal(sub.handoff, true);
  assert.equal(sub.handoff && (sub as { reason: string }).reason, "subtask");
  assert.equal(shouldHandoff(signals({ config: config({ handoff: "task" }), fromSubtask: "t#s-1", toSubtask: "t#s-2" })).handoff, false, "task must not fire on subtask");

  // goal is an alias for off — never fires as a handoff reason in shouldHandoff
  assert.equal(shouldHandoff(signals({ config: config({ handoff: "goal" }), fromGoal: "g1", toGoal: "g2" })).handoff, false);
  console.log("✓ granularity hierarchy: sprint/feature/task/subtask fire only when configured fine enough");
}
