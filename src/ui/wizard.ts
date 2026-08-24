/**
 * infinity-harness — the start-up wizard, as a flow.
 *
 * `src/intake.ts` decides what a set of answers *means*. This asks the
 * questions. Like the settings menu it talks to a `Prompter` rather than to
 * pi, so the whole conversation can be driven by a test — and, in the E2E
 * suite, by a script answering over pi's RPC extension-UI protocol, which is
 * as close to watching a human use it as this gets.
 *
 * The flow is short on purpose. Five questions, three of them one keypress:
 *
 *   1. copilot or autopilot?
 *   2. what are you building?
 *   3. research it first?
 *   4. (autopilot only) which phases do you want to sign?
 *   5. when should the run start a fresh session?
 *
 * Cancelling any question cancels the wizard. Nothing is written until the
 * human has seen the summary and said yes, because a wizard that half-commits
 * leaves a project in a state nobody chose.
 */

import type { Prompter } from "./config.ts";
import type { ApprovalPolicy, Phase } from "../core/types.ts";
import {
  BRIEF_QUESTION,
  HANDOFF_QUESTION,
  MODE_QUESTION,
  RESEARCH_QUESTION,
  approvalOptions,
  planIntake,
  type IntakeAnswers,
  type IntakePlan,
  type Mode,
} from "../intake.ts";

export type WizardOptions = {
  prompt: Prompter;
  /** Phases already chosen elsewhere (e.g. the phase picker). */
  phases?: Phase[];
  /** Pre-fill the goal, e.g. from `/infinity:start <goal>`. */
  brief?: string | null;
  /** Skip the final confirmation. Used when the caller does its own. */
  skipConfirm?: boolean;
};

export type WizardResult =
  | { cancelled: true }
  | { cancelled: false; plan: IntakePlan; answers: IntakeAnswers };

const CONFIRM = "start with these settings";
const RESTART = "change something";
const CANCEL = "cancel";

/** Render a choice as one selectable line: the label, then why you would pick it. */
function line(label: string, help: string): string {
  return `${label}  —  ${help}`;
}

export async function runIntakeWizard(options: WizardOptions): Promise<WizardResult> {
  const { prompt } = options;

  for (;;) {
    // -- 1. mode ------------------------------------------------------------
    const modeOptions = MODE_QUESTION.options ?? [];
    const modeLabels = modeOptions.map((o) => line(o.label, o.help));
    const modePick = await prompt.select(MODE_QUESTION.title, modeLabels);
    if (modePick === undefined) return { cancelled: true };
    const mode = (modeOptions[modeLabels.indexOf(modePick)]?.value ?? "copilot") as Mode;

    // -- 2. what are we building -------------------------------------------
    //
    // Asked in *both* modes. This is the question the old flow skipped, and
    // skipping it is why autopilot used to invent a project and start
    // building it.
    const brief =
      (await prompt.input(BRIEF_QUESTION.title, BRIEF_QUESTION.placeholder)) ?? options.brief ?? "";

    // -- 3. research --------------------------------------------------------
    const researchOptions = RESEARCH_QUESTION.options ?? [];
    const researchLabels = researchOptions.map((o) => line(o.label, o.help));
    const researchPick = await prompt.select(RESEARCH_QUESTION.title, researchLabels);
    if (researchPick === undefined) return { cancelled: true };
    const research = researchOptions[researchLabels.indexOf(researchPick)]?.value === "yes";

    // -- 4. approvals -------------------------------------------------------
    //
    // Only autopilot gets a choice. In copilot the human is in the loop by
    // definition, and offering them a way out of it would make the word mean
    // nothing.
    let approvals: Partial<ApprovalPolicy> | undefined;
    if (mode === "autopilot") {
      const picked = await pickApprovals(prompt, research);
      if (picked === undefined) return { cancelled: true };
      approvals = picked;
    }

    // -- 5. sessions --------------------------------------------------------
    const handoffOptions = HANDOFF_QUESTION.options ?? [];
    const handoffLabels = handoffOptions.map((o) => line(o.label, o.help));
    const handoffPick = await prompt.select(HANDOFF_QUESTION.title, handoffLabels);
    if (handoffPick === undefined) return { cancelled: true };
    const handoff = (handoffOptions[handoffLabels.indexOf(handoffPick)]?.value ?? "phase") as
      | "off"
      | "phase"
      | "task";

    const answers: IntakeAnswers = {
      mode,
      brief,
      research,
      approvals,
      handoff,
      phases: options.phases,
    };
    const plan = planIntake(answers);

    if (options.skipConfirm) return { cancelled: false, plan, answers };

    const body = [plan.summary, ...(plan.warnings.length ? ["", ...plan.warnings.map((w) => `! ${w}`)] : [])].join(
      "\n",
    );
    prompt.notify(body, plan.warnings.length ? "warning" : "info");

    const confirm = await prompt.select("Ready?", [CONFIRM, RESTART, CANCEL]);
    if (confirm === undefined || confirm === CANCEL) return { cancelled: true };
    if (confirm === RESTART) continue;
    return { cancelled: false, plan, answers };
  }
}

const APPROVALS_DONE = "✓ done";

/**
 * A checklist, built out of `select` because that is the only list widget pi
 * gives an extension. Each pick toggles a row and redraws; `done` commits.
 */
async function pickApprovals(
  prompt: Prompter,
  research: boolean,
): Promise<Partial<ApprovalPolicy> | undefined> {
  const options = approvalOptions(research);
  // DEFINE is pre-ticked: it is the signature that pays for itself, and a
  // human who genuinely wants to forfeit everything unticks one box.
  const chosen = new Set<keyof ApprovalPolicy>(["define"]);

  for (;;) {
    const rows = options.map((o) => `${chosen.has(o.value) ? "[x]" : "[ ]"} ${line(o.label, o.help)}`);
    const summary = chosen.size
      ? `you will sign ${[...chosen].map((c) => c.toUpperCase()).join(", ")}`
      : "you will sign nothing — the model decides and runs";
    const pick = await prompt.select(`Which phases do you want to approve? (${summary})`, [
      ...rows,
      APPROVALS_DONE,
    ]);
    if (pick === undefined) return undefined;
    if (pick === APPROVALS_DONE) break;
    const hit = options[rows.indexOf(pick)];
    if (!hit) break;
    if (chosen.has(hit.value)) chosen.delete(hit.value);
    else chosen.add(hit.value);
  }

  return {
    research: chosen.has("research"),
    define: chosen.has("define"),
    plan: chosen.has("plan"),
  };
}

/**
 * The wizard's answers when nobody is there to give any.
 *
 * A headless run must not stall on a prompt, and it must not silently become
 * a mode the human did not pick. The safe default is autopilot with nothing
 * approved — because a run with an approval gate and no human to answer it
 * would park forever — plus a loud warning that says exactly that.
 */
export function unattendedIntake(brief: string | null, phases?: Phase[]): IntakePlan {
  const plan = planIntake({
    mode: "autopilot",
    brief: brief ?? "",
    research: false,
    approvals: { research: false, define: false, plan: false },
    handoff: "phase",
    phases,
  });
  return {
    ...plan,
    warnings: [
      "No dialogs are available here, so the wizard was skipped: autopilot, nothing approved by you.",
      ...plan.warnings,
    ],
  };
}
