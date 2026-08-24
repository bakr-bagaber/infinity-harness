/**
 * Human sign-off on the phases the person wants to see.
 *
 * The gate can prove a feature has acceptance criteria. It cannot prove they
 * are the right criteria, and no amount of determinism will make it able to.
 * These are the phases where the run stops and asks.
 *
 * The subtle half of this module is the *rejection*. A gate is deterministic,
 * so the instant a phase is sent back it passes again and the run would ask
 * the identical question about the identical artefact, forever. A rejection is
 * therefore pinned to what the project looked like when it was made.
 *
 * Which phases stop is a mode per phase now, not a three-phase switch — see
 * `tests/workflow.test.ts` for the workflows those modes come from.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  approvalNotes,
  approvedPhases,
  describeApproval,
  isApprovable,
  loadRejection,
  needsApproval,
  rejectionStandsFor,
  renderApprovalRequest,
  requestApproval,
  resolveApproval,
} from "../src/approval.ts";
import { defaultConfig, loadConfig, saveConfig } from "../src/core/config.ts";

function project(mutate: (c: ReturnType<typeof defaultConfig>) => void = () => {}): string {
  const dir = mkdtempSync(join(tmpdir(), "approval-test-"));
  mkdirSync(join(dir, "harness"), { recursive: true });
  const config = defaultConfig();
  mutate(config);
  const saved = saveConfig(dir, config);
  assert.equal(saved.ok, true, saved.error ?? "saveConfig failed");
  return dir;
}

// ── which phases can be a checkpoint ───────────────────────────────────────
{
  // Every phase can stop for a human. Someone may not care about the plan and
  // care very much about the review; the tool should not have an opinion.
  for (const p of ["research", "define", "plan", "build", "verify", "simplify", "review", "ship"] as const) {
    assert.equal(isApprovable(p), true, `${p} should be signable`);
  }
  // INIT is plumbing — there is nothing there for a human to judge.
  assert.equal(isApprovable("init"), false);
  assert.equal(isApprovable(null), false);

  const config = defaultConfig();
  config.phases = { enabled: ["define", "plan", "build", "verify", "review", "ship"] };
  config.phaseModes = { define: "copilot", plan: "copilot", review: "copilot" };
  assert.equal(needsApproval(config, "define"), true);
  assert.equal(needsApproval(config, "build"), false);
  assert.equal(needsApproval(config, "review"), true, "a late phase is signable like any other");
  assert.deepEqual(approvedPhases(config), ["define", "plan", "review"]);

  // A config written before this feature existed has no `phaseModes` key.
  const legacy = defaultConfig();
  delete (legacy as Record<string, unknown>).phaseModes;
  assert.equal(needsApproval(legacy, "define"), false, "a missing policy is 'sign nothing', not a crash");
  assert.deepEqual(approvedPhases(legacy), []);
  console.log("✓ every phase but INIT can be a checkpoint, and a missing policy signs nothing");
}

// ── what the human is shown ────────────────────────────────────────────────
{
  for (const phase of [
    "research",
    "define",
    "plan",
    "build",
    "verify",
    "simplify",
    "review",
    "ship",
  ] as const) {
    const request = describeApproval(phase);
    assert.ok(request.prompt.length > 20, `${phase} asks a real question`);
    assert.ok(request.artifacts.length > 0, `${phase} says what to look at`);
    const text = renderApprovalRequest(request);
    assert.match(text, new RegExp(phase.toUpperCase()));
    assert.match(text, /\/infinity:approve/, "and how to answer");
    assert.match(text, /sends it back/, "including how to say no usefully");
  }
  console.log("✓ an approval request says what to look at and how to answer");
}

// ── approving, and rejecting with a reason ─────────────────────────────────
{
  const dir = project((c) => {
    c.currentPhase = "define";
    c.phaseModes = { define: "copilot", plan: "copilot" };
  });

  assert.deepEqual(resolveApproval(dir), { ok: false, error: "Nothing is waiting for approval." });

  assert.equal(requestApproval(dir, "define").ok, true);
  assert.equal(loadConfig(dir).config.awaitingApproval, "define");

  const rejected = resolveApproval(dir, "the criteria say nothing about refunds", "fingerprint-a");
  assert.equal(rejected.ok && rejected.approved, false);
  assert.equal(rejected.ok && !rejected.approved && rejected.note, "the criteria say nothing about refunds");

  const afterReject = loadConfig(dir).config;
  assert.equal(afterReject.awaitingApproval, null, "a rejection un-parks the run so the agent can fix it");
  assert.equal(approvalNotes(afterReject, "define").length, 1, "and the reason is kept for the brief");

  const rejection = loadRejection(afterReject);
  assert.equal(rejection?.phase, "define");
  assert.equal(rejection?.fingerprint, "fingerprint-a");

  // The nag guard: same project, same question. Different project, ask again.
  assert.ok(rejectionStandsFor(afterReject, "define", "fingerprint-a"), "nothing changed — do not re-ask");
  assert.equal(rejectionStandsFor(afterReject, "define", "fingerprint-b"), null, "the agent moved — ask again");
  assert.equal(rejectionStandsFor(afterReject, "plan", "fingerprint-a"), null, "a different phase is a different question");

  requestApproval(dir, "define");
  const approved = resolveApproval(dir);
  assert.equal(approved.ok && approved.approved, true);

  const afterApprove = loadConfig(dir).config;
  assert.equal(afterApprove.awaitingApproval, null);
  assert.equal(loadRejection(afterApprove), null, "approving answers the rejection");
  assert.deepEqual(
    approvalNotes(afterApprove, "define"),
    [],
    "and clears the note — an agent told to fix a complaint that was already resolved goes in circles",
  );

  rmSync(dir, { recursive: true, force: true });
  console.log("✓ a rejection carries a reason, pins itself to the project, and is cleared by approval");
}

// ── notes from one phase do not leak into another ──────────────────────────
{
  const dir = project((c) => {
    c.currentPhase = "define";
    c.phaseModes = { define: "copilot", plan: "copilot" };
  });

  requestApproval(dir, "define");
  resolveApproval(dir, "define is wrong", "fp1");
  requestApproval(dir, "plan");
  resolveApproval(dir, "plan is wrong too", "fp2");

  const config = loadConfig(dir).config;
  assert.equal(approvalNotes(config).length, 2, "both are remembered");
  assert.equal(approvalNotes(config, "define")[0]?.note, "define is wrong");
  assert.equal(approvalNotes(config, "plan")[0]?.note, "plan is wrong too");

  requestApproval(dir, "plan");
  resolveApproval(dir);
  const after = loadConfig(dir).config;
  assert.equal(approvalNotes(after, "plan").length, 0, "approving PLAN clears PLAN's note");
  assert.equal(approvalNotes(after, "define").length, 1, "and leaves DEFINE's alone");

  rmSync(dir, { recursive: true, force: true });
  console.log("✓ approval notes are per-phase and do not leak");
}

// ── a broken config is reported, not thrown ────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "approval-broken-"));
  mkdirSync(join(dir, "harness"), { recursive: true });
  writeFileSync(join(dir, "harness", "config.json"), "{ not json", "utf-8");

  const requested = requestApproval(dir, "define");
  assert.equal(requested.ok, false);
  assert.ok(requested.error);

  const resolved = resolveApproval(dir, "anything");
  assert.equal(resolved.ok, false);

  rmSync(dir, { recursive: true, force: true });
  console.log("✓ an unreadable config produces an error, never an exception in a lifecycle hook");
}
