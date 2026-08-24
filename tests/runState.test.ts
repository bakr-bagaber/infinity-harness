/**
 * Is a continuous run armed, and which run is it?
 *
 * This used to be a `let loopEnabled` inside the extension closure and a
 * `randomUUID()` per pi session, which meant two things at once: the first
 * session handoff silently ended the run, and every session that *did* start
 * looked like a brand-new run to `loadLoopState` — resetting the iteration
 * ceiling, the wall-clock budget, the no-progress streak and the escalation
 * ladder. Every guard that makes walking away safe was being reset by the
 * mechanism that made walking away possible.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  armRun,
  clearRunState,
  countSession,
  disarmRun,
  loadRunState,
  newRunState,
  runIdFor,
  saveRunState,
} from "../src/runState.ts";
import { runStatePath } from "../src/core/paths.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "runstate-test-"));

// ── arming, disarming, and surviving a restart ─────────────────────────────
{
  const dir = tmp();
  assert.equal(loadRunState(dir), null, "nothing armed on a fresh project");
  assert.equal(runIdFor(dir, "session-1"), "session-1", "with no run, the session is the run");

  const armed = armRun(dir, "session-1");
  assert.equal(armed.armed, true);
  assert.equal(armed.sessions, 1);
  assert.equal(armed.runId, "session-1");

  // The whole point: a different process, holding none of the first one's
  // memory, still finds the run.
  assert.equal(loadRunState(dir)?.armed, true, "the answer is on disk, not in a closure");
  assert.equal(runIdFor(dir, "session-2"), "session-1", "and a later session drives the same run");

  const again = armRun(dir, "session-2");
  assert.equal(again.runId, "session-1", "re-arming an armed run keeps its id and its budgets");

  const counted = countSession(dir);
  assert.equal(counted?.sessions, 2);
  assert.equal(countSession(dir)?.sessions, 3);
  assert.equal(loadRunState(dir)?.runId, "session-1", "counting sessions does not start a new run");

  const stopped = disarmRun(dir, "the gate never opened");
  assert.equal(stopped?.armed, false);
  assert.equal(stopped?.stopReason, "the gate never opened");
  assert.ok(stopped?.stoppedAt, "a stopped run records when");
  assert.equal(
    runIdFor(dir, "session-9"),
    "session-9",
    "a finished run does not lend its strikes to the next ad-hoc command",
  );

  const restarted = armRun(dir, "session-9");
  assert.equal(restarted.runId, "session-9", "arming after a stop really is a new run");
  assert.equal(restarted.stopReason, null);

  clearRunState(dir);
  assert.equal(loadRunState(dir), null);
  assert.equal(existsSync(runStatePath(dir)), false);
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ a run is a property of the project, not of the session that started it");
}

// ── a corrupt or half-written file must not kill a session ─────────────────
{
  const dir = tmp();
  mkdirSync(join(dir, "harness"), { recursive: true });
  writeFileSync(runStatePath(dir), "{not json", "utf-8");
  assert.equal(loadRunState(dir), null, "unreadable state reads as 'no run', never as a throw");

  writeFileSync(runStatePath(dir), JSON.stringify({ armed: true }), "utf-8");
  assert.equal(loadRunState(dir), null, "a record with no run id is not a run");

  writeFileSync(runStatePath(dir), JSON.stringify({ runId: "r", armed: "yes", sessions: -4 }), "utf-8");
  const loaded = loadRunState(dir);
  assert.equal(loaded?.armed, false, "only a real boolean arms a run");
  assert.equal(loaded?.sessions, 1, "a nonsense session count is repaired, not trusted");

  // Nothing here may throw: every one of these is called from a pi lifecycle
  // hook, and a throw in a lifecycle hook takes the session with it.
  rmSync(dir, { recursive: true, force: true });
  assert.doesNotThrow(() => saveRunState(dir, newRunState("r")));
  assert.doesNotThrow(() => clearRunState(dir));
  assert.equal(countSession(dir), null, "counting a session of a run that is not there is not an error");
  assert.equal(disarmRun(dir, "why"), null);
  console.log("✓ corrupt run state degrades to 'no run' instead of taking the session down");
}
