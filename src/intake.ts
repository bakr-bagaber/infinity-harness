/**
 * infinity-harness — the start-up wizard.
 *
 * The bug this module exists to kill: choosing "autopilot" used to start the
 * run *immediately*, with no idea and no scope, so the first thing the harness
 * did was invent a project and start building it. Autopilot was being read as
 * "you decide everything, including what I want", which is not a mode anybody
 * asked for.
 *
 * The fix is to separate two questions that were tangled together:
 *
 *   1. What are we building?      — always asked, in both modes
 *   2. Who signs off on what?     — the mode's actual meaning
 *
 * copilot     the human is in the loop. DEFINE and PLAN are theirs to approve
 *             (and RESEARCH too, when it is on). Not negotiable — that is what
 *             the word means.
 * autopilot   the human is *optionally* in the loop. They pick which of
 *             RESEARCH / DEFINE / PLAN they want to sign and which they hand
 *             to the model. Forfeiting all three is the "give it a goal and
 *             walk away" mode; keeping DEFINE is the common middle.
 *
 * RESEARCH is a separate, optional phase that runs before DEFINE: the human
 * gives an idea, the model goes and finds out what it actually has to be.
 *
 * Nothing here talks to pi. It takes answers and returns a plan of record, so
 * the flow can be unit-tested without a terminal and driven from the adapter,
 * from a test, or from a config file.
 */

import type { ApprovalPolicy, Phase, SessionPolicy } from "./core/types.ts";
import { DEFAULT_ENABLED_PHASES, PHASE_ORDER } from "./core/types.ts";

export type Mode = "copilot" | "autopilot";

/** The wizard's questions, in the order they are asked. */
export const INTAKE_STEPS = ["mode", "brief", "research", "approvals", "handoff"] as const;
export type IntakeStep = (typeof INTAKE_STEPS)[number];

export type IntakeAnswers = {
  mode: Mode;
  /** What the human wants built, in their words. Empty is allowed but warned about. */
  brief: string;
  /** Run the optional RESEARCH phase before DEFINE. */
  research: boolean;
  /**
   * Which phases the human wants to sign, for autopilot only.
   * Ignored in copilot, where all three are always signed.
   */
  approvals?: Partial<ApprovalPolicy>;
  /** Session handoff policy. Defaults to a fresh session per phase. */
  handoff?: SessionPolicy["handoff"];
  /** Phases the human explicitly chose. Overrides the research toggle. */
  phases?: Phase[];
};

export type IntakePlan = {
  mode: Mode;
  brief: string | null;
  phases: Phase[];
  approvals: ApprovalPolicy;
  session: SessionPolicy;
  /** What the human should be told about what they just chose. */
  summary: string;
  /** Things that will bite later if left as they are. */
  warnings: string[];
};

/**
 * In copilot the human is in the loop by definition, so every approvable
 * phase that is enabled is theirs. Making this configurable would make
 * "copilot" mean nothing.
 */
export function copilotApprovals(phases: Phase[]): ApprovalPolicy {
  return {
    research: phases.includes("research"),
    define: true,
    plan: true,
  };
}

function normalizePhases(base: Phase[], research: boolean): Phase[] {
  const wanted = new Set<Phase>(base.filter((p) => (PHASE_ORDER as readonly string[]).includes(p)));
  wanted.delete("init");
  if (research) wanted.add("research");
  else wanted.delete("research");
  const ordered = PHASE_ORDER.filter((p) => wanted.has(p));
  return ordered.length ? [...ordered] : [...DEFAULT_ENABLED_PHASES];
}

/** Turn the wizard's answers into everything `initHarness` needs. */
export function planIntake(answers: IntakeAnswers): IntakePlan {
  const research = answers.research === true;
  const phases = normalizePhases(answers.phases ?? [...DEFAULT_ENABLED_PHASES], research);

  const approvals: ApprovalPolicy =
    answers.mode === "copilot"
      ? copilotApprovals(phases)
      : {
          research: phases.includes("research") && answers.approvals?.research === true,
          define: answers.approvals?.define === true,
          plan: answers.approvals?.plan === true,
        };

  const handoff = answers.handoff ?? "phase";
  const session: SessionPolicy = {
    handoff,
    contextThreshold: handoff === "off" ? 0 : 0.7,
    carryNotes: true,
  };

  const brief = answers.brief?.trim() ? answers.brief.trim() : null;

  const warnings: string[] = [];
  if (!brief) {
    warnings.push(
      "No goal was given, so the first thing the run does is ask you for one. " +
        "It will not guess a project.",
    );
  }
  if (answers.mode === "autopilot" && !approvals.define && !approvals.plan && !approvals.research) {
    warnings.push(
      "Nothing is being approved by you. The model decides what to build and how, " +
        "and you see it when it is done. This is the right setting for a run you " +
        "want to walk away from — and the wrong one if the goal is vague.",
    );
  }
  if (handoff === "off") {
    warnings.push(
      "Session handoff is off, so the whole run shares one context window. " +
        "Expect compaction on anything longer than a few tasks.",
    );
  }

  return { mode: answers.mode, brief, phases, approvals, session, summary: summarize(answers.mode, phases, approvals, session, brief), warnings };
}

function summarize(
  mode: Mode,
  phases: Phase[],
  approvals: ApprovalPolicy,
  session: SessionPolicy,
  brief: string | null,
): string {
  const signed = (["research", "define", "plan"] as const).filter((p) => approvals[p]);
  const L: string[] = [];
  L.push(`Mode      ${mode}`);
  L.push(`Pipeline  ${phases.join(" → ")}`);
  L.push(
    `You sign  ${signed.length ? signed.map((s) => s.toUpperCase()).join(", ") : "nothing — the model decides and runs"}`,
  );
  L.push(
    `Sessions  ${
      session.handoff === "off"
        ? "one session for the whole run"
        : session.handoff === "task"
          ? "fresh session per task and per phase"
          : "fresh session per phase"
    }`,
  );
  L.push(`Goal      ${brief ?? "(none yet — you will be asked first thing)"}`);
  return L.join("\n");
}

// ── The questions, as data ──────────────────────────────────────────────────
//
// Declared here rather than written inline in the adapter so the wizard has
// one wording, the tests read the same strings the human does, and a
// non-interactive caller can answer them without a terminal.

export type Question = {
  id: IntakeStep;
  title: string;
  /** For choice questions. */
  options?: { value: string; label: string; help: string }[];
  /** For free-text questions. */
  placeholder?: string;
};

export const MODE_QUESTION: Question = {
  id: "mode",
  title: "How much do you want to be involved?",
  options: [
    {
      value: "copilot",
      label: "copilot — I approve the definition and the plan",
      help: "The run stops and shows you its work before it starts building. You can send any phase back with a note.",
    },
    {
      value: "autopilot",
      label: "autopilot — I choose what to approve, if anything",
      help: "You pick which of research, definition and plan you sign. Approve none of them and the run is yours to walk away from.",
    },
  ],
};

export const BRIEF_QUESTION: Question = {
  id: "brief",
  title: "What are you building? One or two sentences is enough.",
  placeholder: "e.g. a CLI that reconciles Stripe payouts against our ledger",
};

export const RESEARCH_QUESTION: Question = {
  id: "research",
  title: "Research the idea first?",
  options: [
    {
      value: "no",
      label: "no — go straight to defining it",
      help: "Right when you already know what has to be built.",
    },
    {
      value: "yes",
      label: "yes — find out what it has to be first",
      help: "Adds a RESEARCH phase before DEFINE: prior art, constraints, options with costs, a recommendation, and the questions only you can answer.",
    },
  ],
};

export const HANDOFF_QUESTION: Question = {
  id: "handoff",
  title: "When should the run start a fresh session?",
  options: [
    {
      value: "phase",
      label: "every phase (recommended)",
      help: "Each phase starts clean, working from the brief. Keeps the context small on long runs.",
    },
    {
      value: "task",
      label: "every task",
      help: "The cleanest context per unit of work. Best with small models; costs one extra brief per task.",
    },
    {
      value: "off",
      label: "never — one long session",
      help: "The old behaviour. The context grows for the whole run and compaction takes over.",
    },
  ],
};

/** The approval checklist, offered only in autopilot. */
export function approvalOptions(research: boolean): { value: keyof ApprovalPolicy; label: string; help: string }[] {
  const out: { value: keyof ApprovalPolicy; label: string; help: string }[] = [];
  if (research) {
    out.push({
      value: "research",
      label: "RESEARCH — what it found before anything is specified",
      help: "You read harness/docs/RESEARCH.md and say whether it is looking at the right problem.",
    });
  }
  out.push({
    value: "define",
    label: "DEFINE — the scope and the acceptance criteria",
    help: "The single highest-leverage signature: a wrong definition is a weekend building the wrong thing perfectly.",
  });
  out.push({
    value: "plan",
    label: "PLAN — the task list before any code is written",
    help: "You see the whole decomposition and can send it back before it is built.",
  });
  return out;
}
