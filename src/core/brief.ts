/**
 * infinity-harness — the brief.
 *
 * The brief answers one question: "what do I do right now?" It is injected at
 * session start and after every phase change, so it has to be complete enough
 * that an agent needs no other context, and short enough that it does not
 * crowd out the work. Everything in it is derived from state on disk — the
 * brief never invents a plan.
 */

import type { Brief, GateResult, HarnessConfig, Phase } from "./types.ts";
import { PHASE_ROLE } from "./types.ts";
import { loadConfig, getRetryConfig, isRetryExhausted } from "./config.ts";
import {
  loadFeatureList,
  computeProgress,
  nextActionableTask,
  findFeature,
  flattenTasks,
} from "./featureList.ts";
import { runChecks } from "./gates.ts";
import { getPhaseOrder, nextPhase, isFinalPhase } from "./phases.ts";
import * as P from "./paths.ts";
import { readText } from "./fsx.ts";
import { loadSkills, matchSkills } from "./skills.ts";

/**
 * What the agent calls to have its work judged.
 *
 * This said `harness validate` for a long time — a command line that has not
 * existed since the CLI was ported into `src/`. A brief that ends by telling
 * the model to run a command that does not exist is a brief that ends in a
 * failed shell call and a confused retry, every single turn.
 */
const VALIDATE_TOOL = "infinity_validate";

/**
 * Two is the number that gets read. One hides a better match; five is a
 * reading list, and a reading list is a thing you skip.
 */
const SKILL_SUGGESTIONS = 2;

const PHASE_INTENT: Record<Phase, string> = {
  init: "Set up the project skeleton and confirm the harness can see it.",
  define: "Write down what is being built and how you will know it is done. Acceptance criteria per feature.",
  plan: "Break each feature into ordered, dependency-aware tasks. No code yet.",
  build: "Implement the current task. One task at a time, tests alongside.",
  verify: "Prove the work behaves. Run the suite, look for what the tests do not cover.",
  simplify: "Delete more than you add. Collapse duplication, drop dead paths.",
  review: "Judge this as if someone else wrote it. Score it against the rubric.",
  ship: "Tag, changelog, and leave the tree clean.",
};

export type BuildBriefOptions = {
  /** Run the gate to include a live verdict. Costs a lint/test run. */
  includeGate?: boolean;
};

export async function buildBrief(targetDir: string, options: BuildBriefOptions = {}): Promise<Brief> {
  const { config, ok } = loadConfig(targetDir);
  const { list } = loadFeatureList(targetDir);
  const progress = computeProgress(list);
  const phase = config.currentPhase;
  const role = phase ? PHASE_ROLE[phase] : null;

  const notes: string[] = [];
  if (!ok) notes.push("harness/config.json is missing or unreadable — run init.");

  const nextTask = nextActionableTask(list);
  const feature = nextTask ? findFeature(list, nextTask.featureId) : null;

  let gate: GateResult | null = null;
  if (options.includeGate && phase) {
    gate = await runChecks(targetDir, phase, { record: false });
  }

  const retry = getRetryConfig(config);
  const exhausted = isRetryExhausted(config);
  if (exhausted.exhausted) {
    notes.push(
      `Retry budget for ${exhausted.which} is exhausted. Stop and escalate to the human rather than retrying again.`,
    );
  }

  const blockedTasks = flattenTasks(list).filter((t) => t.status === "blocked");
  if (blockedTasks.length > 0) {
    notes.push(`${blockedTasks.length} task(s) are blocked: ${blockedTasks.map((t) => t.compositeKey).join(", ")}`);
  }

  const complete = isFinalPhase(phase, config.phases?.enabled) && progress.tasksDone === progress.tasksTotal;

  return {
    phase,
    role,
    paused: Boolean(config.paused),
    complete,
    goal: (list.goals ?? [])[0]?.title ?? null,
    feature: feature ? { id: feature.id, name: feature.name } : null,
    task: nextTask
      ? {
          id: nextTask.id,
          key: nextTask.compositeKey,
          description: nextTask.description,
          status: nextTask.status,
        }
      : null,
    criteria: collectCriteria(feature, nextTask?.criteria),
    validateCommand: VALIDATE_TOOL,
    gate,
    progress: {
      tasksDone: progress.tasksDone,
      tasksTotal: progress.tasksTotal,
      featuresDone: progress.featuresDone,
      featuresTotal: progress.featuresTotal,
    },
    retries: {
      task: config.taskRetryCount ?? 0,
      feature: config.featureRetryCount ?? 0,
      phase: config.phaseRetryCount ?? 0,
      max: retry.tasks.max,
    },
    skills: suggestSkills(phase, {
      goal: (list.goals ?? [])[0]?.title ?? null,
      feature: feature?.name ?? null,
      task: nextTask?.description ?? null,
      criteria: collectCriteria(feature, nextTask?.criteria),
    }),
    notes,
  };
}

/**
 * Which craft skills to point at, given what is being worked on.
 *
 * The skills ship with the package, so this works in an install with no
 * project-level setup. If they are missing — someone vendored `src/` alone —
 * the brief simply has no SKILLS section rather than failing to build.
 */
function suggestSkills(
  phase: Phase | null,
  work: { goal: string | null; feature: string | null; task: string | null; criteria: string[] },
): Brief["skills"] {
  const text = [work.task, work.feature, work.goal, ...work.criteria].filter(Boolean).join(" \n ");
  try {
    return matchSkills(loadSkills(), { phase, text, limit: SKILL_SUGGESTIONS }).map((m) => ({
      name: m.skill.name,
      description: m.skill.description,
      why: m.why,
    }));
  } catch {
    return [];
  }
}

function collectCriteria(
  feature: { criteria?: string[] } | null,
  taskCriteria: string[] | undefined,
): string[] {
  const out: string[] = [];
  if (Array.isArray(taskCriteria)) out.push(...taskCriteria);
  if (out.length === 0 && Array.isArray(feature?.criteria)) out.push(...feature.criteria);
  return out;
}

// ── Rendering ───────────────────────────────────────────────────────────────

const RULE = "─".repeat(64);

/**
 * Render the brief as the text injected into the agent's context.
 * Deliberately plain: this is read by a model, not a terminal, so it carries
 * no colour and no box drawing that would waste tokens.
 */
export function renderBrief(brief: Brief, config?: HarnessConfig): string {
  const L: string[] = [];
  const phase = (brief.phase ?? "not started").toUpperCase();

  if (brief.paused) {
    L.push("HARNESS PAUSED");
    L.push("");
    L.push("The pipeline is paused. Do not continue autonomously — tell the human and stop.");
    return L.join("\n");
  }

  if (brief.complete) {
    L.push("PIPELINE COMPLETE");
    L.push("");
    L.push(`All ${brief.progress.tasksTotal} task(s) across ${brief.progress.featuresTotal} feature(s) are done`);
    L.push("and the final phase has passed. Report to the human; do not start new work.");
    return L.join("\n");
  }

  L.push(RULE);
  const head = [`NEXT STEP · ${phase}`];
  if (brief.feature) head.push(brief.feature.id);
  if (brief.task) head.push(brief.task.key);
  L.push(head.join(" · "));
  L.push(RULE);
  L.push("");

  if (brief.goal) {
    L.push(`GOAL     ${brief.goal}`);
  }
  if (brief.role) {
    L.push(`ROLE     ${brief.role} — ${PHASE_INTENT[brief.phase!]}`);
  }
  if (brief.feature) {
    L.push(`FEATURE  ${brief.feature.id} · ${brief.feature.name}`);
  }
  if (brief.task) {
    L.push(`TASK     ${brief.task.key} [${brief.task.status}]`);
    L.push(`         ${brief.task.description}`);
  } else {
    L.push("TASK     (none actionable — every remaining task is blocked or the plan is empty)");
  }

  L.push("");
  L.push(
    `PROGRESS ${brief.progress.tasksDone}/${brief.progress.tasksTotal} tasks · ` +
      `${brief.progress.featuresDone}/${brief.progress.featuresTotal} features · ` +
      `retries ${brief.retries.task}/${brief.retries.max}`,
  );

  if (config) {
    const order = getPhaseOrder(config.phases?.enabled);
    const marked = order
      .map((p) => (p === brief.phase ? `[${p.toUpperCase()}]` : p))
      .join(" → ");
    L.push(`PIPELINE ${marked}`);
  }

  if (brief.criteria.length) {
    L.push("");
    L.push("ACCEPTANCE CRITERIA");
    for (const c of brief.criteria) L.push(`  - ${c}`);
  }

  if (brief.skills.length) {
    L.push("");
    L.push("SKILLS   read before you start — invoke by name");
    for (const s of brief.skills) {
      L.push(`  - ${s.name} — ${s.description}`);
      if (s.why) L.push(`    (${s.why})`);
    }
  }

  if (brief.gate) {
    L.push("");
    L.push(`GATE     ${brief.gate.overall ? "PASS" : "FAIL"}`);
    for (const c of brief.gate.checks) {
      const mark = c.advisory ? "·" : c.pass ? "+" : "x";
      L.push(`  ${mark} ${c.name}: ${c.detail}`);
    }
  }

  if (brief.notes.length) {
    L.push("");
    L.push("ATTENTION");
    for (const n of brief.notes) L.push(`  ! ${n}`);
  }

  L.push("");
  L.push("THE LOOP");
  L.push("  1. Do the work described above.");
  L.push(`  2. Call the ${brief.validateCommand} tool (a human types /infinity:validate).`);
  L.push("  3. FAIL → fix the listed checks and validate again.");
  L.push("  4. PASS → the harness advances the phase and issues the next brief.");
  L.push("");
  L.push("Do not edit harness/config.json by hand and do not mark your own work complete.");
  L.push("The gate is the only referee.");

  return L.join("\n");
}

/** One-line status suitable for a status bar. */
export function renderBriefLine(brief: Brief): string {
  if (brief.paused) return "paused";
  if (brief.complete) return "complete";
  const bits = [brief.phase ?? "—"];
  if (brief.task) bits.push(brief.task.key);
  bits.push(`${brief.progress.tasksDone}/${brief.progress.tasksTotal}`);
  return bits.join(" · ");
}

/** Phase doc + craft skill the brief points at, when present in the project. */
export function referencedDocs(targetDir: string, phase: Phase | null): string[] {
  if (!phase) return [];
  const out: string[] = [];
  const pd = P.phaseDocPath(targetDir, phase);
  if (readText(pd) !== null) out.push(pd);
  const role = PHASE_ROLE[phase];
  const ad = P.agentDocPath(targetDir, role);
  if (readText(ad) !== null) out.push(ad);
  return out;
}

export { nextPhase };
