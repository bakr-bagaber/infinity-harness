/**
 * The start-up wizard: what the answers mean, and how they are asked.
 *
 * The bug this replaces: choosing "autopilot" started the run immediately,
 * with no idea and no scope, so the first thing the harness did was invent a
 * project and start building it. Autopilot was being read as "you decide
 * everything, including what I want".
 *
 * Two questions were tangled together and are now separate — *what are we
 * building* and *who signs off on what* — and the second turned out to be
 * tangled too, because one switch cannot say "let it plan on its own but show
 * me the review". It is a workflow now: a mode per phase.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
} from "../src/intake.ts";
import { buildWorkflow, pickDisplay, runIntakeWizard, unattendedIntake } from "../src/ui/wizard.ts";
import { BUILTIN_WORKFLOWS, builtInWorkflow, loadSavedWorkflows } from "../src/workflow.ts";
import { BUILTIN_DISPLAYS } from "../src/ui/display.ts";
import type { Prompter } from "../src/ui/config.ts";

/** A scripted human. Answers are matched against the question title. */
function human(script: Array<[RegExp, string | ((options: string[]) => string | undefined)]>) {
  const asked: { title: string; options: string[] | null }[] = [];
  const notices: string[] = [];
  const remaining = [...script];

  const answer = (title: string, options: string[] | null): string | undefined => {
    asked.push({ title, options });
    const i = remaining.findIndex(([re]) => re.test(title));
    if (i === -1) return undefined;
    const [, value] = remaining.splice(i, 1)[0]!;
    return typeof value === "function" ? value(options ?? []) : value;
  };

  const prompt: Prompter = {
    select: async (title, options) => answer(title, options),
    input: async (title) => answer(title, null),
    notify: (message) => {
      notices.push(message);
    },
  };
  return { prompt, asked, notices, remaining };
}

const pick = (re: RegExp) => (options: string[]) => options.find((o) => re.test(o));

/** An isolated place for saved workflows and templates. */
function sandbox(): { env: NodeJS.ProcessEnv; clean: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "intake-store-"));
  return { env: { PI_CODING_AGENT_DIR: dir }, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

// ── a workflow is a mode per phase ─────────────────────────────────────────
{
  const copilot = planIntake({ workflow: builtInWorkflow("copilot")!, brief: "a CSV reconciler" });
  assert.equal(copilot.mode, "copilot");
  assert.equal(copilot.phaseModes.define, "copilot");
  assert.equal(copilot.phaseModes.build, "autopilot");
  assert.match(copilot.summary, /\[define\]/, "the summary shows which phases stop");
  assert.match(copilot.summary, /a CSV reconciler/);

  const autopilot = planIntake({ workflow: builtInWorkflow("autopilot")!, brief: "x" });
  assert.equal(autopilot.mode, "autopilot");
  assert.ok(
    Object.values(autopilot.phaseModes).every((m) => m === "autopilot"),
    "autopilot stops nowhere",
  );
  assert.ok(autopilot.warnings.some((w) => /Nothing is being approved by you/.test(w)));

  // The shape the old switch could not express.
  const late = planIntake({
    workflow: customWorkflow(
      ["define", "plan", "build", "verify", "review", "ship"],
      { review: "copilot", ship: "copilot" },
    ),
    brief: "x",
  });
  assert.equal(late.phaseModes.define, "autopilot", "it plans on its own");
  assert.equal(late.phaseModes.review, "copilot", "and still shows you the review");
  assert.equal(late.mode, "copilot", "any stop at all makes this a copilot run");
  console.log("✓ a workflow says who signs each phase, including the ones a switch could not reach");
}

// ── the built-ins ──────────────────────────────────────────────────────────
{
  assert.ok(BUILTIN_WORKFLOWS.length >= 4, "there are several to choose from");
  for (const w of BUILTIN_WORKFLOWS) {
    assert.ok(w.builtIn, `${w.id} must be marked built-in`);
    assert.ok(w.description.length > 20, `${w.id} says what it is for`);
    assert.ok(w.phases.length > 0);
    for (const p of w.phases) {
      assert.ok(["copilot", "autopilot"].includes(w.modes[p]!), `${w.id}/${p} has no mode`);
    }
  }
  assert.ok(
    builtInWorkflow("research-first")!.phases.includes("research"),
    "the research workflow actually enables research",
  );
  assert.ok(
    builtInWorkflow("every-gate")!.phases.every((p) => builtInWorkflow("every-gate")!.modes[p] === "copilot"),
    "'every gate' means every gate",
  );
  console.log("✓ every built-in workflow is complete and says what it is for");
}

// ── the missing question ───────────────────────────────────────────────────
{
  const vague = planIntake({ workflow: builtInWorkflow("autopilot")!, brief: "   " });
  assert.equal(vague.brief, null);
  assert.ok(
    vague.warnings.some((w) => /No goal was given/.test(w) && /will not guess/.test(w)),
    "an empty goal is allowed, and the run says it will ask rather than invent one",
  );
  assert.match(vague.summary, /you will be asked/);
  console.log("✓ a missing goal is a stated fact, not a licence to invent a project");
}

// ── session policy ─────────────────────────────────────────────────────────
{
  const off = planIntake({ workflow: builtInWorkflow("copilot")!, brief: "x", handoff: "off" });
  assert.equal(off.session.contextThreshold, 0, "no handoff means no context handoff either");
  assert.ok(off.warnings.some((w) => /one context window/.test(w)));

  const perTask = planIntake({ workflow: builtInWorkflow("copilot")!, brief: "x", handoff: "task" });
  assert.match(perTask.summary, /per task/);
  console.log("✓ the session policy is chosen, explained, and warned about when it will hurt");
}

// ── the wizard flow ────────────────────────────────────────────────────────
{
  const box = sandbox();
  const h = human([
    [/which phases, and which of them stop for you/, pick(/^research first/)],
    [/What are you building/, "a CLI that reconciles Stripe payouts"],
    [/fresh session/, pick(/every phase/)],
    [/How deep should research go/, pick(/Very Deep/)],
    [/How much of the plan/, pick(/^everything/)],
    [/Ready/, pick(/start with these settings/)],
  ]);

  const result = await runIntakeWizard({ prompt: h.prompt, env: box.env });
  assert.equal(result.cancelled, false);
  if (result.cancelled) throw new Error("unreachable");

  assert.equal(result.plan.workflow.id, "research-first");
  assert.equal(result.plan.brief, "a CLI that reconciles Stripe payouts");
  assert.ok(result.plan.phases.includes("research"));
  assert.equal(result.plan.phaseModes.define, "copilot");
  assert.equal(result.plan.display.levels.subtask, "all", "the display template was applied");

  const titles = h.asked.map((a) => a.title).join("\n");
  assert.match(titles, /What are you building/, "the goal is asked for whatever the workflow");
  assert.match(titles, /How much of the plan/);
  assert.ok(h.notices.some((n) => /Workflow {2}research first/.test(n)), "the summary is shown before committing");
  assert.equal(result.plan.researchDepth, "deep", "very deep was stored when research is in pipeline");
  assert.match(result.plan.summary, /Research  deep/);
  box.clean();
  console.log("✓ the wizard asks four questions and returns what they add up to");
}

// ── building a workflow, and keeping it ────────────────────────────────────
{
  const box = sandbox();
  const h = human([
    // Turn RESEARCH on, SIMPLIFY on, then finish the phase picker.
    [/Which phases should run/, pick(/\[ \] research/)],
    [/Which phases should run/, pick(/\[ \] simplify/)],
    [/Which phases should run/, (o) => o.at(-1)],
    // A mode for each phase, in pipeline order.
    [/^RESEARCH —/, pick(/copilot/)],
    [/^DEFINE —/, pick(/autopilot/)],
    [/^PLAN —/, pick(/autopilot/)],
    [/^BUILD —/, pick(/autopilot/)],
    [/^VERIFY —/, pick(/autopilot/)],
    [/^SIMPLIFY —/, pick(/autopilot/)],
    [/^REVIEW —/, pick(/copilot/)],
    [/^SHIP —/, pick(/copilot/)],
    [/Keep this workflow/, pick(/save it under a name/)],
    [/Call it what/, "Client work"],
  ]);

  const built = await buildWorkflow(h.prompt, box.env);
  assert.ok(built, "a workflow came back");
  assert.equal(built!.id, "client-work", "the name became a stable id");
  assert.deepEqual(built!.phases, [
    "research",
    "define",
    "plan",
    "build",
    "verify",
    "simplify",
    "review",
    "ship",
  ]);
  assert.equal(built!.modes.research, "copilot");
  assert.equal(built!.modes.plan, "autopilot", "the middle really is left alone");
  assert.equal(built!.modes.review, "copilot");
  assert.equal(built!.modes.ship, "copilot");

  // And it is there for the next project.
  const saved = loadSavedWorkflows(box.env);
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.name, "Client work");
  assert.equal(saved[0]?.builtIn, false);

  // Which means the wizard offers it.
  const h2 = human([
    [/which phases, and which of them stop for you/, pick(/Client work \(yours\)/)],
    [/What are you building/, "the next one"],
    [/fresh session/, (o) => o[0]],
    [/How deep should research go/, pick(/Deep/)],
    [/How much of the plan/, (o) => o[0]],
    [/Ready/, pick(/start with these settings/)],
  ]);
  const second = await runIntakeWizard({ prompt: h2.prompt, env: box.env });
  assert.equal(second.cancelled, false);
  if (second.cancelled) throw new Error("unreachable");
  assert.equal(second.plan.workflow.id, "client-work", "a saved workflow is reusable");
  assert.equal(second.plan.phaseModes.ship, "copilot");

  box.clean();
  console.log("✓ a custom workflow can be built, named, kept, and picked again next time");
}

// ── a one-off custom workflow is not saved ─────────────────────────────────
{
  const box = sandbox();
  const h = human([
    [/Which phases should run/, (o) => o.at(-1)],
    [/^DEFINE —/, pick(/copilot/)],
    [/^PLAN —/, pick(/autopilot/)],
    [/^BUILD —/, pick(/autopilot/)],
    [/^VERIFY —/, pick(/autopilot/)],
    [/^REVIEW —/, pick(/autopilot/)],
    [/^SHIP —/, pick(/autopilot/)],
    [/Keep this workflow/, pick(/just use it here/)],
  ]);
  const built = await buildWorkflow(h.prompt, box.env);
  assert.ok(built);
  assert.equal(built!.id, "custom");
  assert.equal(loadSavedWorkflows(box.env).length, 0, "declining to keep it keeps nothing");
  box.clean();
  console.log("✓ a one-off shape does not have to be named");
}

// ── built-in names are protected ───────────────────────────────────────────
{
  const box = sandbox();
  const h = human([
    [/Which phases should run/, (o) => o.at(-1)],
    [/^DEFINE —/, pick(/autopilot/)],
    [/^PLAN —/, pick(/autopilot/)],
    [/^BUILD —/, pick(/autopilot/)],
    [/^VERIFY —/, pick(/autopilot/)],
    [/^REVIEW —/, pick(/autopilot/)],
    [/^SHIP —/, pick(/autopilot/)],
    [/Keep this workflow/, pick(/save it under a name/)],
    [/Call it what/, "copilot"],
    [/Call it what/, "my copilot"],
  ]);
  const built = await buildWorkflow(h.prompt, box.env);
  assert.equal(built?.id, "my-copilot");
  assert.ok(
    h.notices.some((n) => /built-in workflow/.test(n)),
    "shadowing a built-in is refused, with a reason, and it asks again",
  );
  assert.equal(loadSavedWorkflows(box.env).length, 1);
  box.clean();
  console.log("✓ 'copilot' means the same thing everywhere — a built-in name cannot be taken");
}

// ── display templates ──────────────────────────────────────────────────────
{
  const box = sandbox();
  for (const t of BUILTIN_DISPLAYS) {
    assert.ok(t.builtIn);
    assert.ok(t.description.length > 20, `${t.id} says what it is for`);
  }
  assert.ok(BUILTIN_DISPLAYS.length >= 3, "at least three ship with the package");

  const h = human([[/How much of the plan/, pick(/^overview/)]]);
  const policy = await pickDisplay(h.prompt, box.env);
  assert.equal(policy?.levels.task, false, "overview hides tasks");
  assert.equal(policy?.levels.feature, true);
  box.clean();
  console.log("✓ display templates ship, and picking one returns its policy");
}

// ── nobody is there to answer ──────────────────────────────────────────────
{
  const plan = unattendedIntake("a scheduled build");
  assert.equal(plan.mode, "autopilot");
  assert.ok(
    Object.values(plan.phaseModes).every((m) => m === "autopilot"),
    "an approval gate with nobody to answer it would park the run forever",
  );
  assert.equal(plan.brief, "a scheduled build");
  assert.ok(
    plan.warnings.some((w) => /no dialogs/i.test(w)),
    "a headless run says the wizard was skipped rather than implying the human chose this",
  );
  console.log("✓ with no dialogs the wizard is skipped loudly, and nothing can park the run");
}

// ── cancelling ─────────────────────────────────────────────────────────────
{
  const cancelled = await runIntakeWizard({ prompt: human([]).prompt });
  assert.equal(cancelled.cancelled, true, "an unanswered question cancels rather than guessing");
  console.log("✓ cancelling writes nothing");
}

// ── the questions themselves ───────────────────────────────────────────────
{
  for (const q of [HANDOFF_QUESTION]) {
    assert.ok(q.options && q.options.length >= 2, `${q.id} needs real choices`);
    for (const o of q.options ?? []) {
      assert.ok(o.label.length > 3, `${q.id} option has no label`);
      assert.ok(o.help.length > 20, `${q.id}/${o.value} does not say why you would pick it`);
    }
  }
  assert.ok(BRIEF_QUESTION.placeholder, "the goal question shows an example");
  assert.ok(WORKFLOW_QUESTION.title.length > 20);
  assert.ok(DISPLAY_QUESTION.title.length > 20);

  assert.equal(PHASE_MODE_OPTIONS.length, 2);
  for (const o of PHASE_MODE_OPTIONS) assert.ok(o.help.length > 20, `${o.value} does not explain itself`);

  // Every phase someone can pick has a line saying what it is for — that line
  // is the whole reason the mode question is asked one phase at a time.
  for (const p of SELECTABLE_PHASES) {
    assert.ok(PHASE_PURPOSE[p] && PHASE_PURPOSE[p].length > 10, `${p} has no purpose line`);
  }
  assert.ok(!SELECTABLE_PHASES.includes("init"), "INIT is plumbing, not a phase anyone picks");
  console.log("✓ every choice explains itself");
}
