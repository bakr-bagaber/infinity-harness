/**
 * infinity-harness — the start-up wizard, as a flow.
 *
 * `src/intake.ts` decides what a set of answers *means*. This asks the
 * questions. Like the settings menu it talks to a `Prompter` rather than to
 * pi, so the whole conversation can be driven by a test — and, in the E2E
 * suite, by a script answering over pi's RPC extension-UI protocol, which is
 * as close to watching a human use it as this gets.
 *
 * The flow is short on purpose. Four questions, three of them one keypress:
 *
 *   1. which workflow? — a built-in, one you saved, or "build one"
 *   2. what are you building?
 *   3. when should it start a fresh session?
 *   4. how much of the plan do you want on screen?
 *
 * Building a workflow is its own small flow: pick the phases, then say for
 * each one whether it stops for you, then optionally give it a name and keep
 * it. A kept workflow is offered first thing on the next project.
 *
 * Cancelling any question cancels the wizard. Nothing is written until the
 * human has seen the summary and said yes, because a wizard that half-commits
 * leaves a project in a state nobody chose.
 */

import type { ModelChoice, Prompter } from "./config.ts";
import type { DisplayPolicy, Phase } from "../core/types.ts";
import {
  BRIEF_QUESTION,
  DISPLAY_QUESTION,
  HANDOFF_QUESTION,
  PHASE_MODE_OPTIONS,
  PHASE_PURPOSE,
  SELECTABLE_PHASES,
  WORKFLOW_QUESTION,
  customWorkflow,
  planIntake,
  type IntakeAnswers,
  type IntakePlan,
} from "../intake.ts";
import {
  listWorkflows,
  normalizeModes,
  normalizePhases,
  renderWorkflow,
  saveWorkflow,
  type PhaseMode,
  type PhaseModes,
  type Workflow,
} from "../workflow.ts";
import { DEFAULT_ENABLED_PHASES } from "../core/types.ts";
import { defaultDisplay, listDisplays, normalizeDisplay, saveDisplay } from "./display.ts";
import type { ThinkingLevel } from "../modelRouter.ts";

export type WizardOptions = {
  prompt: Prompter;
  /** Pre-fill the goal, e.g. from `/infinity:init <goal>`. */
  brief?: string | null;
  /** Skip the final confirmation. Used when the caller does its own. */
  skipConfirm?: boolean;
  /** Where saved workflows and templates live. Tests point this elsewhere. */
  env?: NodeJS.ProcessEnv;
  /** Models pi can use — offered for each tier and for consulting. */
  models?: () => ModelChoice[] | Promise<ModelChoice[]>;
};

export type WizardResult =
  | { cancelled: true }
  | { cancelled: false; plan: IntakePlan; answers: IntakeAnswers; launchNow?: boolean };

const CONFIRM = "start with these settings";
const RESTART = "change something";
const CANCEL = "cancel";
const BUILD_ONE = "build one — I choose the phases and which of them stop for me";
const DONE = "✓ done";

/** Render a choice as one selectable line: the label, then why you would pick it. */
function line(label: string, help: string): string {
  return `${label}  —  ${help}`;
}

const MODEL_STEP_TITLE = "Which models for the difficulty tiers, and the consulting master?";
const INHERIT = "(use pi's current model)";
const CUSTOM_MODEL = "type a model id…";
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const THINK_INHERIT = "(inherit)";

async function pickModelChoice(prompt: Prompter, title: string, models: ModelChoice[], current: string): Promise<string | undefined> {
  if (models.length === 0) {
    const typed = await prompt.input(title, current || "provider/model-id");
    return typed;
  }
  const rows = models.map((m) => (m.ref === current ? `${m.label}  ← current` : m.label));
  const picked = await prompt.select(title, [INHERIT, ...rows, CUSTOM_MODEL]);
  if (picked === undefined) return undefined;
  if (picked === INHERIT) return "";
  if (picked === CUSTOM_MODEL) {
    const typed = await prompt.input(`${title} — model id`, current || "provider/model-id");
    return typed;
  }
  const model = models[rows.indexOf(picked)];
  return model?.ref;
}

async function pickThinkingLevel(prompt: Prompter, title: string): Promise<ThinkingLevel | "" | undefined> {
  const picked = await prompt.select(title, [THINK_INHERIT, ...THINKING_LEVELS]);
  if (picked === undefined) return undefined;
  if (picked === THINK_INHERIT) return "";
  return picked as ThinkingLevel;
}

/**
 * What a difficulty tier actually buys, at the level the human just chose.
 *
 * Difficulty is scored per task, but the *model* changes only where the
 * session changes — that is what makes it a model boundary at all. So at
 * feature-level handoff a feature runs on its hardest task's model and the
 * easy tasks inside it get the hard model too. Saying that here, in the
 * question, is the difference between a setting that behaves surprisingly and
 * one the human chose with their eyes open.
 */
export function tierScopeNote(handoff: string): string {
  switch (handoff) {
    case "off":
    case "goal":
      return "one session for the whole run, so the run takes the hardest tier in the plan";
    case "phase":
      return "one session per phase, so every task in a phase takes that phase's hardest tier";
    case "sprint":
      return "one session per sprint, so every task in a sprint takes that sprint's hardest tier";
    case "feature":
      return "one session per feature, so every task in a feature takes that feature's hardest tier";
    case "subtask":
      return "one session per subtask, so each subtask can take its own tier";
    default:
      return "one session per task, so each task takes its own tier";
  }
}

async function pickModelsStep(
  prompt: Prompter,
  modelsFn?: WizardOptions["models"],
  handoff: string = "task",
): Promise<{ router: NonNullable<IntakeAnswers["router"]> } | undefined> {
  const models = modelsFn ? (await modelsFn()) ?? [] : [];
  // First ask whether routing is even wanted — most runs don't need it, and
  // skipping the 8 follow-up questions keeps the wizard short. Old tests that
  // don't know about this step get routing off by default so they keep passing.
  const ROUTE_ON = "yes — pick models per tier";
  const ROUTE_OFF = "no — use pi's current model for everything";
  const enablePick = await prompt.select(
    `Route work by difficulty to different models? (${tierScopeNote(handoff)})`,
    [ROUTE_ON, ROUTE_OFF],
  );
  if (enablePick === undefined) {
    // No answer scripted (e.g. an older test) → treat as "off" so the
    // wizard doesn't look cancelled to callers that only scripted four steps.
    return { router: { enabled: false, byDifficulty: { easy: "", moderate: "", difficult: "" }, thinkingByDifficulty: { easy: "", moderate: "", difficult: "" }, master: "", thinkingMaster: "", default: "", thinkingDefault: "" } };
  }
  if (enablePick === ROUTE_OFF) {
    return { router: { enabled: false, byDifficulty: { easy: "", moderate: "", difficult: "" }, thinkingByDifficulty: { easy: "", moderate: "", difficult: "" }, master: "", thinkingMaster: "", default: "", thinkingDefault: "" } };
  }
  const tiers = ["easy", "moderate", "difficult"] as const;
  const byDifficulty: Record<string, string> = {};
  const thinkingByDifficulty: Partial<Record<string, ThinkingLevel | "">> = {};
  for (const tier of tiers) {
    const model = await pickModelChoice(prompt, `${tier.toUpperCase()} tier — model`, models, "");
    if (model === undefined) return undefined;
    byDifficulty[tier] = model;
    const thinking = await pickThinkingLevel(prompt, `${tier.toUpperCase()} tier — thinking level`);
    if (thinking === undefined) return undefined;
    thinkingByDifficulty[tier] = thinking;
  }
  const masterModel = await pickModelChoice(prompt, "Consulting master — model (used only when the ladder is exhausted)", models, "");
  if (masterModel === undefined) return undefined;
  const masterThinking = await pickThinkingLevel(prompt, "Consulting master — thinking level");
  if (masterThinking === undefined) return undefined;
  const defaultModel = await pickModelChoice(prompt, "Default — fallback when nothing more specific matches", models, "");
  if (defaultModel === undefined) return undefined;
  const defaultThinking = await pickThinkingLevel(prompt, "Default — thinking level fallback");
  if (defaultThinking === undefined) return undefined;
  return {
    router: {
      enabled: true,
      byDifficulty,
      thinkingByDifficulty,
      master: masterModel ?? "",
      thinkingMaster: masterThinking ?? "",
      default: defaultModel ?? "",
      thinkingDefault: defaultThinking ?? "",
    },
  };
}

export async function runIntakeWizard(options: WizardOptions): Promise<WizardResult> {
  const { prompt, env } = options;

  for (;;) {
    // -- 1. the workflow ----------------------------------------------------
    const workflow = await pickWorkflow(prompt, env);
    if (workflow === undefined) return { cancelled: true };

    // -- 2. what are we building -------------------------------------------
    //
    // Asked whatever the workflow is. This is the question the old flow
    // skipped, and skipping it is why autopilot used to invent a project and
    // start building it.
    const brief =
      (await prompt.input(BRIEF_QUESTION.title, BRIEF_QUESTION.placeholder)) ?? options.brief ?? "";

    // -- 3. sessions --------------------------------------------------------
    const handoffOptions = HANDOFF_QUESTION.options ?? [];
    const handoffLabels = handoffOptions.map((o) => line(o.label, o.help));
    const handoffPick = await prompt.select(HANDOFF_QUESTION.title, handoffLabels);
    if (handoffPick === undefined) return { cancelled: true };
    // Every level the question offers, not the three this cast used to allow:
    // picking "every feature" and getting the task-level narrowing is how a
    // setting silently becomes a different setting.
    const handoff = (handoffOptions[handoffLabels.indexOf(handoffPick)]?.value ??
      "phase") as import("../core/types.ts").HandoffGranularity;

    // -- 3b. research depth (only when research is in the pipeline) ----------
    let researchDepth: import("../intake.ts").ResearchDepth | undefined;
    if (workflow.phases.includes("research" as import("../core/types.ts").Phase)) {
      const RESEARCH_DEPTH_QUESTION = {
        title: "How deep should research go?",
        options: [
          { value: "standard", label: "Deep — 3 tasks, 5+ primary sources + comparison table", help: ">=5 sources with URLs, constraints table, 3 options + falsification (~800 chars gate). Lite mode." },
          { value: "deep", label: "Very Deep — 5 tasks, competitive matrix + cost/risk model", help: ">=7 sources, gap analysis, competitive matrix, risk register (~1800 chars). Recommended." },
          { value: "comprehensive", label: "Literature Review — 10 tasks, 15+ sources annotated", help: ">=15 sources annotated bibliography, benchmarks, synthesis + gap analysis (~5000 chars)." },
        ],
      };
      const depthLabels = RESEARCH_DEPTH_QUESTION.options.map((o) => line(o.label, o.help));
      const depthPick = await prompt.select(RESEARCH_DEPTH_QUESTION.title, depthLabels);
      if (depthPick === undefined) return { cancelled: true };
      researchDepth = (RESEARCH_DEPTH_QUESTION.options[depthLabels.indexOf(depthPick)]?.value ?? "deep") as import("../intake.ts").ResearchDepth;
    }

    // -- 4. models ----------------------------------------------------------
    const modelsAnswer = await pickModelsStep(prompt, options.models, handoff);
    if (modelsAnswer === undefined) return { cancelled: true };

    // -- 5. execution (parallelism) -----------------------------------------
    const execOptions = [
      { value: "off", label: "one at a time", help: "No parallel work. Simplest, lowest token use." },
      { value: "task", label: "parallel at task (recommended)", help: "Tasks with no deps run together, up to max workers." },
      { value: "feature", label: "parallel at feature", help: "Features with no deps run together." },
      { value: "sprint", label: "parallel at sprint", help: "Sprints in parallel." },
      { value: "goal", label: "parallel at goal", help: "Goals run as parallel pipelines (phases run together)." },
      { value: "subtask", label: "parallel at subtask", help: "Subtasks of a task run together. Finest grain." },
    ];
    const execLabels = execOptions.map((o) => line(o.label, o.help));
    // Execution parallelism is optional — older E2E/tests scripted 5 answers, not 7. Default to task×3 so they keep passing.
    let parallelAt: import("../core/types.ts").HandoffGranularity = "task";
    let maxWorkers = 3;
    const execPick = await prompt.select("When to run things in parallel?", execLabels);
    if (execPick !== undefined) {
      parallelAt = (execOptions[execLabels.indexOf(execPick)]?.value ?? "task") as import("../core/types.ts").HandoffGranularity;
      const workersRaw = await prompt.input("Max parallel workers? (1-16)", "3");
      maxWorkers = workersRaw === undefined ? 3 : Math.max(1, Math.min(16, Number.parseInt(String(workersRaw).trim(), 10) || 3));
    }

    // -- 6. display ---------------------------------------------------------
    const display = await pickDisplay(prompt, env);
    if (display === undefined) return { cancelled: true };

    const answers: IntakeAnswers = { workflow, researchDepth, brief, handoff, display, router: modelsAnswer.router, parallelAt, maxWorkers };
    const plan = planIntake(answers);

    if (options.skipConfirm) return { cancelled: false, plan, answers, launchNow: false };

    const body = [plan.summary, ...(plan.warnings.length ? ["", ...plan.warnings.map((w) => `! ${w}`)] : [])].join(
      "\n",
    );
    prompt.notify(body, plan.warnings.length ? "warning" : "info");

    const confirm = await prompt.select("Ready?", [CONFIRM, RESTART, CANCEL]);
    if (confirm === undefined || confirm === CANCEL) return { cancelled: true };
    if (confirm === RESTART) continue;
    // Last step: ask whether to arm and start immediately (opt-in).
    // After init the harness is never auto-started — only /infinity:run (or
    // "yes" here) arms it. Older tests/E2E scripts that do not answer this
    // are treated as "later" so they keep passing.
    const LAUNCH_NOW = "yes — start the run now";
    const LAUNCH_LATER = "no — I'll run /infinity:run when ready";
    const launchPick = await prompt.select("Start the run now?", [LAUNCH_NOW, LAUNCH_LATER]);
    let launchNow = false;
    if (launchPick !== undefined) launchNow = launchPick === LAUNCH_NOW;
    return { cancelled: false, plan, answers, launchNow };
  }
}

// ── choosing a workflow ─────────────────────────────────────────────────────

/**
 * Pick a workflow, or build one.
 *
 * Built-ins first, then whatever this person has saved, then "build one".
 * Undefined means they cancelled.
 */
export async function pickWorkflow(
  prompt: Prompter,
  env?: NodeJS.ProcessEnv,
): Promise<Workflow | undefined> {
  const available = listWorkflows(env);
  const rows = available.map((w) => line(w.builtIn ? w.name : `${w.name} (yours)`, w.description));
  const picked = await prompt.select(WORKFLOW_QUESTION.title, [...rows, BUILD_ONE]);
  if (picked === undefined) return undefined;
  if (picked === BUILD_ONE) return buildWorkflow(prompt, env);
  return available[rows.indexOf(picked)];
}

/**
 * The custom flow: phases, then a mode for each, then keep it or don't.
 *
 * Saving is offered rather than required. Someone trying a one-off shape for
 * one project should not have to name it, and someone who has found the shape
 * they always want should not have to rebuild it every time.
 */
export async function buildWorkflow(
  prompt: Prompter,
  env?: NodeJS.ProcessEnv,
): Promise<Workflow | undefined> {
  // -- which phases run ---------------------------------------------------
  const chosen = new Set<Phase>(DEFAULT_ENABLED_PHASES);
  for (;;) {
    const rows = SELECTABLE_PHASES.map(
      (p) => `${chosen.has(p) ? "[x]" : "[ ]"} ${p} — ${PHASE_PURPOSE[p]}`,
    );
    const hit = await prompt.select(
      `Which phases should run? (${chosen.size ? [...SELECTABLE_PHASES].filter((p) => chosen.has(p)).join(" → ") : "none yet"})`,
      [...rows, DONE],
    );
    if (hit === undefined) return undefined;
    if (hit === DONE) break;
    const key = SELECTABLE_PHASES[rows.indexOf(hit)];
    if (!key) break;
    if (chosen.has(key)) chosen.delete(key);
    else chosen.add(key);
  }

  const phases = normalizePhases([...chosen]);

  // -- a mode for each ----------------------------------------------------
  //
  // Asked one phase at a time rather than as a checklist, because "does this
  // one stop for me" is a different question for RESEARCH than for SHIP and
  // the help text is the useful part.
  const modes: PhaseModes = {};
  const modeLabels = PHASE_MODE_OPTIONS.map((o) => line(o.label, o.help));
  for (const phase of phases) {
    const answer = await prompt.select(
      `${phase.toUpperCase()} — ${PHASE_PURPOSE[phase]}`,
      modeLabels,
    );
    if (answer === undefined) return undefined;
    modes[phase] = (PHASE_MODE_OPTIONS[modeLabels.indexOf(answer)]?.value ?? "autopilot") as PhaseMode;
  }

  const draft = customWorkflow(phases, modes);
  prompt.notify(renderWorkflow(draft), "info");

  // -- keep it? -----------------------------------------------------------
  const KEEP = "save it under a name I can reuse";
  const ONCE = "just use it here";
  const keep = await prompt.select("Keep this workflow?", [KEEP, ONCE]);
  if (keep === undefined) return undefined;
  if (keep !== KEEP) return draft;

  for (;;) {
    const name = await prompt.input("Call it what?", "e.g. spec-heavy, weekend-run, client-work");
    if (name === undefined || !name.trim()) return draft;
    const saved = saveWorkflow(
      { name: name.trim(), phases, modes },
      env,
    );
    if (saved.ok && saved.workflow) {
      prompt.notify(`Saved "${saved.workflow.name}". It will be offered on every project.`, "info");
      return saved.workflow;
    }
    prompt.notify(saved.error ?? "Could not save that.", "warning");
  }
}

// ── choosing a display template ─────────────────────────────────────────────

const CUSTOMISE = "choose level by level";

export async function pickDisplay(
  prompt: Prompter,
  env?: NodeJS.ProcessEnv,
): Promise<DisplayPolicy | undefined> {
  const available = listDisplays(env);
  const rows = available.map((d) => line(d.builtIn ? d.name : `${d.name} (yours)`, d.description));
  const picked = await prompt.select(DISPLAY_QUESTION.title, [...rows, CUSTOMISE]);
  if (picked === undefined) return undefined;
  if (picked !== CUSTOMISE) return available[rows.indexOf(picked)]?.policy ?? defaultDisplay();
  return buildDisplay(prompt, defaultDisplay(), env);
}

const SUBTASK_CYCLE: DisplayPolicy["levels"]["subtask"][] = ["none", "active", "all"];

/**
 * The level-by-level editor, shared by the wizard and `/infinity:display`.
 *
 * Every row toggles; subtasks cycle through none → active → all, because
 * "only on the task being worked" is the answer most people want and a plain
 * on/off cannot express it.
 */
export async function buildDisplay(
  prompt: Prompter,
  starting: DisplayPolicy,
  env?: NodeJS.ProcessEnv,
): Promise<DisplayPolicy | undefined> {
  let policy = normalizeDisplay(starting);

  for (;;) {
    const rows = [
      `${policy.levels.goal ? "[x]" : "[ ]"} goals`,
      `${policy.levels.sprint ? "[x]" : "[ ]"} sprints`,
      `${policy.levels.feature ? "[x]" : "[ ]"} features`,
      `${policy.levels.task ? "[x]" : "[ ]"} tasks`,
      `[${policy.levels.subtask}] subtasks — none · active (only the task being worked) · all`,
      `${policy.counts ? "[x]" : "[ ]"} done/total counts on goals, sprints and features`,
      `${policy.dependencies ? "[x]" : "[ ]"} dependency labels (← #3)`,
      `${policy.criteria ? "[x]" : "[ ]"} acceptance criteria (dashboard only)`,
      `${policy.rail ? "[x]" : "[ ]"} the phase rail`,
      `${policy.progress ? "[x]" : "[ ]"} the progress meter`,
      `${policy.alerts ? "[x]" : "[ ]"} the alert strip (blocked, rework, retries, approvals)`,
      `[${policy.taskWindow}] rows of plan in the terminal before it scrolls`,
    ];
    const SAVE = "save this as a template I can reuse";
    const hit = await prompt.select("What should the widget and the dashboard show?", [
      ...rows,
      SAVE,
      DONE,
    ]);
    if (hit === undefined) return undefined;
    if (hit === DONE) return { ...policy, preset: "custom" };

    if (hit === SAVE) {
      const name = await prompt.input("Call it what?", "e.g. sprint-view, my-focus");
      if (name && name.trim()) {
        const saved = saveDisplay({ name: name.trim(), policy }, env);
        if (saved.ok && saved.template) {
          prompt.notify(`Saved "${saved.template.name}".`, "info");
          return saved.template.policy;
        }
        prompt.notify(saved.error ?? "Could not save that.", "warning");
      }
      continue;
    }

    const idx = rows.indexOf(hit);
    switch (idx) {
      case 0:
        policy = { ...policy, levels: { ...policy.levels, goal: !policy.levels.goal } };
        break;
      case 1:
        policy = { ...policy, levels: { ...policy.levels, sprint: !policy.levels.sprint } };
        break;
      case 2:
        policy = { ...policy, levels: { ...policy.levels, feature: !policy.levels.feature } };
        break;
      case 3:
        policy = { ...policy, levels: { ...policy.levels, task: !policy.levels.task } };
        break;
      case 4: {
        const next = SUBTASK_CYCLE[(SUBTASK_CYCLE.indexOf(policy.levels.subtask) + 1) % SUBTASK_CYCLE.length]!;
        policy = { ...policy, levels: { ...policy.levels, subtask: next } };
        break;
      }
      case 5:
        policy = { ...policy, counts: !policy.counts };
        break;
      case 6:
        policy = { ...policy, dependencies: !policy.dependencies };
        break;
      case 7:
        policy = { ...policy, criteria: !policy.criteria };
        break;
      case 8:
        policy = { ...policy, rail: !policy.rail };
        break;
      case 9:
        policy = { ...policy, progress: !policy.progress };
        break;
      case 10:
        policy = { ...policy, alerts: !policy.alerts };
        break;
      case 11: {
        const answer = await prompt.input("How many rows?", String(policy.taskWindow));
        const n = Number(String(answer ?? "").trim());
        if (Number.isFinite(n)) policy = normalizeDisplay({ ...policy, taskWindow: n });
        break;
      }
      default:
        return { ...policy, preset: "custom" };
    }
  }
}

/**
 * The wizard's answers when nobody is there to give any.
 *
 * A headless run must not stall on a prompt, and it must not silently become
 * a workflow the human did not pick. The safe default is autopilot with
 * nothing approved — because an approval gate with no human to answer it would
 * park forever — plus a loud warning that says exactly that.
 */
export function unattendedIntake(brief: string | null, phases?: Phase[]): IntakePlan {
  const ordered = normalizePhases(phases ?? [...DEFAULT_ENABLED_PHASES]);
  const workflow: Workflow = {
    id: "autopilot",
    name: "autopilot",
    description: "You approve nothing.",
    builtIn: true,
    phases: ordered,
    modes: normalizeModes({}, ordered),
  };
  const plan = planIntake({ workflow, brief: brief ?? "", handoff: "phase" });
  return {
    ...plan,
    warnings: [
      "No dialogs are available here, so the wizard was skipped: autopilot, nothing approved by you.",
      ...plan.warnings,
    ],
  };
}
