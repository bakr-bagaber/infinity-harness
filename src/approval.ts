/**
 * infinity-harness — human sign-off on the phases that decide what gets built.
 *
 * The gate is a good referee for execution and a poor one for intent. It can
 * prove a feature has acceptance criteria; it cannot prove they are the right
 * criteria. It can prove a plan has tasks; it cannot prove the plan builds the
 * thing the human asked for. Those two judgements are the human's, and this
 * module is where the run stops to collect them.
 *
 * The policy is per-phase and set once, by the start-up wizard:
 *
 *   copilot    RESEARCH (if on), DEFINE and PLAN are approved by the human
 *   autopilot  the human picks which of them to approve and which to forfeit;
 *              forfeiting all three is the "give it a goal and walk away" mode
 *
 * Nothing after PLAN is approvable. Once the definition and the plan are
 * signed off, a wrong BUILD fails a gate and retries — a wrong DEFINE spends a
 * weekend building the wrong product perfectly.
 */

import type { HarnessConfig, Phase } from "./core/types.ts";
import { loadConfig, saveConfig } from "./core/config.ts";
import { modeFor, signedPhases, SIGNABLE_PHASES } from "./workflow.ts";

export type ApprovalRequest = {
  phase: Phase;
  /** What the human is being asked to look at before signing. */
  artifacts: string[];
  prompt: string;
};

/** Every phase except INIT, which is plumbing rather than work. */
export function isApprovable(phase: Phase | null): boolean {
  return phase !== null && SIGNABLE_PHASES.includes(phase);
}

/** Does `phase` need a signature before the pipeline may leave it? */
export function needsApproval(config: HarnessConfig, phase: Phase | null): boolean {
  if (!isApprovable(phase)) return false;
  return modeFor(config, phase) === "copilot";
}

/** Which phases the human has asked to sign, in pipeline order. */
export function approvedPhases(config: HarnessConfig): Phase[] {
  return signedPhases(config);
}

const ARTIFACTS: Record<string, string[]> = {
  research: ["harness/docs/RESEARCH.md"],
  define: ["specs/prd.md", "harness/sprint-contract.md", "the acceptance criteria in the plan"],
  plan: ["the task list in the widget, or `/infinity:dashboard`"],
  build: ["the diff since the last phase — `git diff`", "the tasks marked complete in the plan"],
  verify: ["the test output", "what the tests still do not cover"],
  simplify: ["what was deleted — `git diff --stat`"],
  review: ["harness/evaluator-rubric.md and the score against it", "README.md and harness/docs/"],
  ship: ["CHANGELOG.md", "the tag, and `git log` since the last one"],
};

const ASKS: Record<string, string> = {
  research:
    "Does this research describe the problem you actually have, and is the recommendation one you would take?",
  define:
    "Is this the thing you want built, and would meeting these criteria convince you it works?",
  plan: "Does this plan build that thing, in an order that makes sense, with nothing important missing?",
  build: "Is this the code you wanted written, and would you be happy to own it?",
  verify: "Do these tests actually prove the thing works, or only that it runs?",
  simplify: "Is what is left simpler, and is anything missing that should not be?",
  review: "Would you approve this if someone else had written it?",
  ship: "Is this ready to go out, under this version, with this changelog?",
};

export function describeApproval(phase: Phase): ApprovalRequest {
  return {
    phase,
    artifacts: ARTIFACTS[phase] ?? [],
    prompt: ASKS[phase] ?? `Approve the ${phase.toUpperCase()} phase?`,
  };
}

/** The text a human reads when the run pauses for them. */
export function renderApprovalRequest(request: ApprovalRequest): string {
  const lines = [
    `${request.phase.toUpperCase()} passed its gate and is waiting for you.`,
    "",
    request.prompt,
  ];
  if (request.artifacts.length) {
    lines.push("", "Look at:");
    for (const a of request.artifacts) lines.push(`  - ${a}`);
  }
  lines.push(
    "",
    "`/infinity:approve` continues. `/infinity:approve <what is wrong>` sends it back",
    "to be redone with your note. The run does not advance until you answer.",
  );
  return lines.join("\n");
}

/** Park the pipeline on `phase` until a human answers. */
export function requestApproval(targetDir: string, phase: Phase): { ok: boolean; error: string | null } {
  const { config, ok, error } = loadConfig(targetDir);
  if (!ok) return { ok: false, error: error ?? "cannot load config" };
  config.awaitingApproval = phase;
  const saved = saveConfig(targetDir, config);
  return { ok: saved.ok, error: saved.error };
}

/**
 * A rejection, pinned to the state of the project when it was made.
 *
 * Without the fingerprint the run nags: the gate is deterministic, so the
 * moment a phase is sent back it passes again on the next tick and asks the
 * human the same question. Recording *what the project looked like* when they
 * said no means the question is only asked again once something has actually
 * changed in response to it.
 */
export type ApprovalRejection = { phase: string; note: string; fingerprint: string; at: string };

export function loadRejection(config: HarnessConfig): ApprovalRejection | null {
  const raw = config.approvalRejection as Partial<ApprovalRejection> | undefined;
  if (!raw || typeof raw.phase !== "string" || typeof raw.fingerprint !== "string") return null;
  return {
    phase: raw.phase,
    note: typeof raw.note === "string" ? raw.note : "",
    fingerprint: raw.fingerprint,
    at: typeof raw.at === "string" ? raw.at : "",
  };
}

/**
 * Has the project moved since the human said no?
 *
 * `true` means the agent has not yet done anything about the rejection, so
 * re-asking would be asking the same question about the same artefact.
 */
export function rejectionStandsFor(
  config: HarnessConfig,
  phase: string,
  fingerprint: string,
): ApprovalRejection | null {
  const rejection = loadRejection(config);
  if (!rejection || rejection.phase !== phase) return null;
  return rejection.fingerprint === fingerprint ? rejection : null;
}

export type ApprovalOutcome =
  | { ok: true; approved: true; phase: Phase }
  | { ok: true; approved: false; phase: Phase; note: string }
  | { ok: false; error: string };

/**
 * Answer a pending approval.
 *
 * An empty note approves. A note is a rejection carrying the reason, which is
 * the only useful form of "no": the phase is re-run with the human's words in
 * the brief, rather than re-run identically and failing the same way.
 */
export function resolveApproval(
  targetDir: string,
  note = "",
  fingerprint = "",
): ApprovalOutcome {
  const { config, ok, error } = loadConfig(targetDir);
  if (!ok) return { ok: false, error: error ?? "cannot load config" };

  const phase = config.awaitingApproval;
  if (!phase) return { ok: false, error: "Nothing is waiting for approval." };

  config.awaitingApproval = null;
  const trimmed = note.trim();
  if (trimmed) {
    const notes = Array.isArray(config.approvalNotes) ? (config.approvalNotes as unknown[]) : [];
    config.approvalNotes = [
      ...notes,
      { phase, note: trimmed, at: new Date().toISOString() },
    ].slice(-50);
    config.approvalRejection = { phase, note: trimmed, fingerprint, at: new Date().toISOString() };
  } else {
    // Approved. The old rejection is answered, and the note that carried it
    // must stop appearing in the brief — an agent told to address a complaint
    // that was already resolved goes round in circles fixing nothing.
    config.approvalRejection = null;
    config.approvalNotes = (Array.isArray(config.approvalNotes) ? config.approvalNotes : []).filter(
      (n) => typeof n === "object" && n !== null && (n as { phase?: unknown }).phase !== phase,
    );
  }

  const saved = saveConfig(targetDir, config);
  if (!saved.ok) return { ok: false, error: saved.error ?? "could not save config" };

  return trimmed
    ? { ok: true, approved: false, phase, note: trimmed }
    : { ok: true, approved: true, phase };
}

/** Notes the human left when rejecting a phase, newest last. */
export function approvalNotes(config: HarnessConfig, phase?: Phase): { phase: string; note: string; at: string }[] {
  const raw = Array.isArray(config.approvalNotes) ? config.approvalNotes : [];
  const all = raw.filter(
    (n): n is { phase: string; note: string; at: string } =>
      typeof n === "object" && n !== null && typeof (n as { note?: unknown }).note === "string",
  );
  return phase ? all.filter((n) => n.phase === phase) : all;
}
