/**
 * infinity-harness — the start-up wizard.
 *
 * The bug this module exists to kill: choosing "autopilot" used to start the
 * run *immediately*, with no idea and no scope, so the first thing the harness
 * did was invent a project and start building it. Autopilot was being read as
 * "you decide everything, including what I want", which is not a mode anybody
 * asked for.
 *
 * The fix was to separate two questions that were tangled together:
 *
 *   1. What are we building?      — always asked
 *   2. Who signs off on what?     — the workflow
 *
 * And the second of those turned out to be tangled too. "copilot" and
 * "autopilot" are one switch, and one switch cannot say "let it define and
 * plan on its own but show me the review". So the answer is a **workflow**: a
 * mode per phase, with the two familiar words as two named points in that
 * space rather than the only two points in it. `src/workflow.ts` owns what a
 * workflow is and where saved ones live.
 *
 * Nothing here talks to pi. It takes answers and returns a plan of record, so
 * the flow can be unit-tested without a terminal and driven from the adapter,
 * from a test, or from a config file.
 */

import type { ApprovalPolicy, DisplayPolicy, Phase, SessionPolicy } from "./core/types.ts";
import { DEFAULT_ENABLED_PHASES, PHASE_ORDER } from "./core/types.ts";
import {
  BUILTIN_WORKFLOWS,
  describeModes,
  normalizeModes,
  normalizePhases,
  signedPhases as signedIn,
  type PhaseMode,
  type PhaseModes,
  type Workflow,
} from "./workflow.ts";
import { defaultDisplay, normalizeDisplay } from "./ui/display.ts";

export type Mode = "copilot" | "autopilot";

/** The wizard's questions, in the order they are asked. */
export const INTAKE_STEPS = ["workflow", "brief", "handoff", "display"] as const;
export type IntakeStep = (typeof INTAKE_STEPS)[number];

export type IntakeAnswers = {
  /** The chosen workflow: a built-in, one they saved, or one they just built. */
  workflow: Workflow;
  /** What the human wants built, in their words. Empty is allowed but warned about. */
  brief: string;
  /** Session handoff policy. Defaults to a fresh session per phase. */
  handoff?: SessionPolicy["handoff"];
  /** What the surfaces should draw. Defaults to the `focus` template. */
  display?: DisplayPolicy;
  /** Model routing for difficulty tiers and consulting. */
  router?: {
    enabled: boolean;
    byDifficulty: Record<string, string>;
    thinkingByDifficulty?: Partial<Record<string, string>>;
    master?: string;
    thinkingMaster?: string;
    default?: string;
    thinkingDefault?: string;
  };
};

export type IntakePlan = {
  /** Derived: "copilot" when the run stops for the human anywhere, else "autopilot". */
  mode: Mode;
  workflow: { id: string; name: string };
  brief: string | null;
  phases: Phase[];
  phaseModes: PhaseModes;
  /** Kept in step with `phaseModes` so a 2.3 config read by a 2.3 tool still works. */
  approvals: ApprovalPolicy;
  session: SessionPolicy;
  display: DisplayPolicy;
  router?: IntakeAnswers["router"];
  /** What the human should be told about what they just chose. */
  summary: string;
  /** Things that will bite later if left as they are. */
  warnings: string[];
};

export function builtInByName(name: string): Workflow | null {
  return BUILTIN_WORKFLOWS.find((w) => w.id === name || w.name === name) ?? null;
}

/** Build an ad-hoc workflow from a phase list and a mode per phase. */
export function customWorkflow(
  phases: Phase[],
  modes: PhaseModes,
  name = "custom",
): Workflow {
  const ordered = normalizePhases(phases);
  const normalized = normalizeModes(modes, ordered);
  return {
    id: "custom",
    name,
    description: describeModes(ordered, normalized),
    builtIn: false,
    phases: ordered,
    modes: normalized,
  };
}

/** Turn the wizard's answers into everything `initHarness` needs. */
export function planIntake(answers: IntakeAnswers): IntakePlan {
  const workflow = answers.workflow;
  const phases = normalizePhases(workflow.phases);
  const phaseModes = normalizeModes(workflow.modes, phases);

  const handoff = answers.handoff ?? "phase";
  const session: SessionPolicy = {
    handoff,
    contextThreshold: handoff === "off" ? 0 : 0.7,
    carryNotes: true,
  };

  const display = normalizeDisplay(answers.display ?? defaultDisplay());
  const brief = answers.brief?.trim() ? answers.brief.trim() : null;
  const signed = PHASE_ORDER.filter((p) => phaseModes[p] === "copilot");
  const mode: Mode = signed.length > 0 ? "copilot" : "autopilot";

  const warnings: string[] = [];
  if (!brief) {
    warnings.push(
      "No goal was given, so the first thing the run does is ask you for one. " +
        "It will not guess a project.",
    );
  }
  if (signed.length === 0) {
    warnings.push(
      "Nothing is being approved by you. The model decides what to build and how, " +
        "and you see it when it is done. This is the right setting for a run you " +
        "want to walk away from — and the wrong one if the goal is vague.",
    );
  }
  if (signed.length === phases.length) {
    warnings.push(
      "Every phase stops for you. Nothing moves while you are away, which is the " +
        "point — just do not expect to start this and go to bed.",
    );
  }
  if (handoff === "off") {
    warnings.push(
      "Session handoff is off, so the whole run shares one context window. " +
        "Expect compaction on anything longer than a few tasks.",
    );
  }

  return {
    mode,
    workflow: { id: workflow.id, name: workflow.name },
    brief,
    phases,
    phaseModes,
    approvals: {
      research: phaseModes.research === "copilot",
      define: phaseModes.define === "copilot",
      plan: phaseModes.plan === "copilot",
    },
    session,
    display,
    router: answers.router,
    summary: summarize(workflow, phases, phaseModes, session, display, brief),
    warnings,
  };
}

function summarize(
  workflow: Workflow,
  phases: Phase[],
  modes: PhaseModes,
  session: SessionPolicy,
  display: DisplayPolicy,
  brief: string | null,
): string {
  const signed = phases.filter((p) => modes[p] === "copilot");
  const L: string[] = [];
  L.push(`Workflow  ${workflow.name}`);
  L.push(`Pipeline  ${phases.map((p) => (modes[p] === "copilot" ? `[${p}]` : p)).join(" → ")}`);
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
  L.push(`Display   ${display.preset}`);
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

export const WORKFLOW_QUESTION: Question = {
  id: "workflow",
  title: "How should this run — which phases, and which of them stop for you?",
};

export const BRIEF_QUESTION: Question = {
  id: "brief",
  title: "What are you building? One or two sentences is enough.",
  placeholder: "e.g. a CLI that reconciles Stripe payouts against our ledger",
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

export const DISPLAY_QUESTION: Question = {
  id: "display",
  title: "How much of the plan do you want on screen?",
};

/** The two modes, as a question about one phase. */
export const PHASE_MODE_OPTIONS: { value: PhaseMode; label: string; help: string }[] = [
  {
    value: "autopilot",
    label: "autopilot — it passes the gate and moves on",
    help: "The deterministic gate is the only referee for this phase.",
  },
  {
    value: "copilot",
    label: "copilot — it stops and waits for you",
    help: "When the gate passes, the run parks and asks you to sign it off before advancing.",
  },
];

/** What each phase is for, one line, shown while picking modes. */
export const PHASE_PURPOSE: Record<Phase, string> = {
  init: "set the project up",
  research: "find out what it actually has to be",
  define: "write down what is being built, and the criteria",
  plan: "break it into ordered, dependency-aware tasks",
  build: "implement it, one task at a time",
  verify: "prove it behaves; hunt what the tests miss",
  simplify: "delete more than you add",
  review: "judge it as if someone else wrote it",
  ship: "tag, changelog, leave the tree clean",
};

/** Phases someone can put in a pipeline. INIT is not one of them. */
export const SELECTABLE_PHASES: Phase[] = PHASE_ORDER.filter((p) => p !== "init");

export { DEFAULT_ENABLED_PHASES, signedIn as signedPhases };
