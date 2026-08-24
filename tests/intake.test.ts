/**
 * The start-up wizard: what the answers mean, and how they are asked.
 *
 * The bug this replaces: choosing "autopilot" started the run immediately,
 * with no idea and no scope, so the first thing the harness did was invent a
 * project and start building it. Autopilot was being read as "you decide
 * everything, including what I want".
 *
 * Two questions were tangled together and are now separate:
 *   what are we building?   — always asked, in both modes
 *   who signs off on what?  — the mode's actual meaning
 */

import assert from "node:assert/strict";

import {
  BRIEF_QUESTION,
  HANDOFF_QUESTION,
  MODE_QUESTION,
  RESEARCH_QUESTION,
  approvalOptions,
  copilotApprovals,
  planIntake,
} from "../src/intake.ts";
import { runIntakeWizard, unattendedIntake } from "../src/ui/wizard.ts";
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

// ── copilot means the human is in the loop ─────────────────────────────────
{
  const plan = planIntake({ mode: "copilot", brief: "a CSV reconciler", research: false });
  assert.deepEqual(plan.approvals, { research: false, define: true, plan: true });
  assert.equal(plan.brief, "a CSV reconciler");
  assert.match(plan.summary, /copilot/);
  assert.match(plan.summary, /DEFINE, PLAN/);

  // Offering copilot a way out of the loop would make the word mean nothing.
  const ignored = planIntake({
    mode: "copilot",
    brief: "x",
    research: true,
    approvals: { research: false, define: false, plan: false },
  });
  assert.deepEqual(ignored.approvals, { research: true, define: true, plan: true });
  assert.deepEqual(copilotApprovals(["define", "plan"]), { research: false, define: true, plan: true });
  console.log("✓ copilot signs everything that decides what gets built, and cannot opt out");
}

// ── autopilot means the human chooses ──────────────────────────────────────
{
  const some = planIntake({
    mode: "autopilot",
    brief: "a nightly job",
    research: true,
    approvals: { define: true, plan: false },
  });
  assert.deepEqual(some.approvals, { research: false, define: true, plan: false });
  assert.ok(some.phases.includes("research"));
  assert.equal(some.phases[0], "research", "research runs before define");
  assert.equal(some.warnings.length, 0, "signing something is not worth warning about");

  const none = planIntake({ mode: "autopilot", brief: "a URL shortener", research: false, approvals: {} });
  assert.deepEqual(none.approvals, { research: false, define: false, plan: false });
  assert.match(none.summary, /the model decides and runs/);
  assert.ok(
    none.warnings.some((w) => /Nothing is being approved by you/.test(w)),
    "walking away entirely is allowed, but it is said out loud",
  );

  // Research approval is meaningless when the phase is off.
  const noResearch = planIntake({
    mode: "autopilot",
    brief: "x",
    research: false,
    approvals: { research: true },
  });
  assert.equal(noResearch.approvals.research, false);
  assert.ok(!noResearch.phases.includes("research"));
  console.log("✓ autopilot forfeits only what the human chose to forfeit");
}

// ── the missing question ───────────────────────────────────────────────────
{
  const vague = planIntake({ mode: "autopilot", brief: "   ", research: false });
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
  const perPhase = planIntake({ mode: "copilot", brief: "x", research: false, handoff: "phase" });
  assert.equal(perPhase.session.handoff, "phase");
  assert.ok(perPhase.session.contextThreshold > 0);

  const off = planIntake({ mode: "copilot", brief: "x", research: false, handoff: "off" });
  assert.equal(off.session.contextThreshold, 0, "no handoff means no context handoff either");
  assert.ok(off.warnings.some((w) => /one context window/.test(w)));

  const perTask = planIntake({ mode: "copilot", brief: "x", research: false, handoff: "task" });
  assert.match(perTask.summary, /per task/);
  console.log("✓ the session policy is chosen, explained, and warned about when it will hurt");
}

// ── phases the human picked are honoured, in pipeline order ────────────────
{
  const chosen = planIntake({
    mode: "copilot",
    brief: "x",
    research: true,
    phases: ["ship", "build", "define", "init"],
  });
  assert.deepEqual(chosen.phases, ["research", "define", "build", "ship"]);
  assert.ok(!chosen.phases.includes("init"), "init is not a phase anyone runs");

  const empty = planIntake({ mode: "copilot", brief: "x", research: false, phases: [] });
  assert.ok(empty.phases.length > 0, "an empty selection falls back to the defaults");
  console.log("✓ chosen phases are normalised into pipeline order");
}

// ── the wizard flow ────────────────────────────────────────────────────────
{
  const h = human([
    [/How much do you want to be involved/, pick(/autopilot/)],
    [/What are you building/, "a CLI that reconciles Stripe payouts"],
    [/Research the idea first/, pick(/find out what it has to be/)],
    [/approve/, pick(/PLAN —/)],
    [/approve/, (options) => options.at(-1)],
    [/fresh session/, pick(/every phase/)],
    [/Ready/, pick(/start with these settings/)],
  ]);

  const result = await runIntakeWizard({ prompt: h.prompt });
  assert.equal(result.cancelled, false);
  if (result.cancelled) throw new Error("unreachable");

  assert.equal(result.plan.mode, "autopilot");
  assert.equal(result.plan.brief, "a CLI that reconciles Stripe payouts");
  assert.ok(result.plan.phases.includes("research"));
  assert.deepEqual(result.plan.approvals, { research: false, define: true, plan: true });

  const titles = h.asked.map((a) => a.title).join("\n");
  assert.match(titles, /What are you building/, "the goal is asked for in autopilot too");
  assert.match(titles, /Research the idea first/);
  assert.match(titles, /approve/);
  assert.ok(h.notices.some((n) => /Mode {6}autopilot/.test(n)), "the summary is shown before committing");
  console.log("✓ the wizard asks five questions and returns what they add up to");
}

// ── copilot is never asked which phases to sign ────────────────────────────
{
  const h = human([
    [/How much do you want to be involved/, pick(/copilot/)],
    [/What are you building/, "a thing"],
    [/Research the idea first/, pick(/go straight/)],
    [/fresh session/, pick(/every phase/)],
    [/Ready/, pick(/start with these settings/)],
  ]);
  const result = await runIntakeWizard({ prompt: h.prompt });
  assert.equal(result.cancelled, false);
  assert.ok(
    !h.asked.some((a) => /Which phases do you want to approve/.test(a.title)),
    "copilot is in the loop by definition — asking would imply otherwise",
  );
  console.log("✓ the approvals checklist is an autopilot question only");
}

// ── cancelling, and starting over ──────────────────────────────────────────
{
  const cancelled = await runIntakeWizard({
    prompt: human([]).prompt, // every question goes unanswered
  });
  assert.equal(cancelled.cancelled, true, "an unanswered question cancels rather than guessing");

  let asked = 0;
  const restart: Prompter = {
    select: async (title, options) => {
      if (/Ready/.test(title)) {
        asked += 1;
        return asked === 1 ? options.find((o) => /change something/.test(o)) : options[0];
      }
      if (/involved/.test(title)) return options.find((o) => /copilot/.test(o));
      if (/Research/.test(title)) return options.find((o) => /go straight/.test(o));
      if (/fresh session/.test(title)) return options[0];
      return options[0];
    },
    input: async () => "a thing",
    notify: () => {},
  };
  const looped = await runIntakeWizard({ prompt: restart });
  assert.equal(looped.cancelled, false);
  assert.equal(asked, 2, "'change something' really re-asks");
  console.log("✓ cancelling writes nothing, and 'change something' starts over");
}

// ── nobody is there to answer ──────────────────────────────────────────────
{
  const plan = unattendedIntake("a scheduled build");
  assert.equal(plan.mode, "autopilot");
  assert.deepEqual(plan.approvals, { research: false, define: false, plan: false });
  assert.equal(plan.brief, "a scheduled build");
  assert.ok(
    plan.warnings.some((w) => /no dialogs/i.test(w)),
    "a headless run says the wizard was skipped rather than implying the human chose this",
  );
  // An approval gate with nobody to answer it would park the run forever.
  assert.equal(plan.approvals.define, false);
  console.log("✓ with no dialogs the wizard is skipped loudly, and nothing can park the run");
}

// ── the questions themselves ───────────────────────────────────────────────
{
  for (const q of [MODE_QUESTION, RESEARCH_QUESTION, HANDOFF_QUESTION]) {
    assert.ok(q.options && q.options.length >= 2, `${q.id} needs real choices`);
    for (const o of q.options ?? []) {
      assert.ok(o.label.length > 3, `${q.id} option has no label`);
      assert.ok(o.help.length > 20, `${q.id}/${o.value} does not say why you would pick it`);
    }
  }
  assert.ok(BRIEF_QUESTION.placeholder, "the goal question shows an example");

  assert.equal(approvalOptions(false).length, 2, "no research phase, no research checkbox");
  assert.equal(approvalOptions(true).length, 3);
  assert.equal(approvalOptions(true)[0]?.value, "research", "and it comes first, as it runs first");
  console.log("✓ every choice explains itself");
}
