/**
 * infinity-harness — workflows: which phases run, and who signs each one.
 *
 * "copilot" and "autopilot" were a single switch, and a single switch is the
 * wrong shape for the question. What people actually want is per-phase: let
 * the model define and plan on its own but show me the review; or grill me on
 * the definition and then leave me alone until it ships. Two words cannot say
 * that.
 *
 * So the setting is a **mode per phase**, and copilot and autopilot become two
 * named points in that space rather than the only two points in it:
 *
 *   copilot     you sign RESEARCH, DEFINE and PLAN
 *   autopilot   you sign nothing
 *   custom      you decide, phase by phase, and can name and keep it
 *
 * A named workflow is worth as much on the next project as on this one, so
 * saved ones live with the *person* (`~/.pi/agent/infinity-harness/`), not
 * under a project's `harness/`.
 *
 * Built-ins are read-only on purpose. "copilot" has to mean the same thing in
 * every conversation about this tool; someone who wants a different copilot
 * makes a custom workflow and gives it their own name.
 */

import type { HarnessConfig, Phase } from "./core/types.ts";
import { PHASE_ORDER, DEFAULT_ENABLED_PHASES } from "./core/types.ts";
import { userWorkflowsPath } from "./core/paths.ts";
import { readJsonSafe, writeJsonAtomic, ensureDir } from "./core/fsx.ts";
import { dirname } from "node:path";

/**
 * What happens when a phase's gate passes.
 *
 * `copilot`   stop and ask the human to sign it off before advancing
 * `autopilot` advance
 */
export type PhaseMode = "copilot" | "autopilot";

export type PhaseModes = Partial<Record<Phase, PhaseMode>>;

export type Workflow = {
  /** Stable key. Built-ins own the ones below; saved ones are slugs of their name. */
  id: string;
  name: string;
  /** One line the human reads while choosing. */
  description: string;
  /** True for the four that ship with the package and cannot be edited. */
  builtIn: boolean;
  /** The pipeline this workflow runs, in canonical order. */
  phases: Phase[];
  /** Mode per phase. A phase absent from the map runs in autopilot. */
  modes: PhaseModes;
  /** When a saved workflow was written. Absent on built-ins. */
  savedAt?: string;
};

/** Phases a human can be asked to sign. Everything except INIT, which is plumbing. */
export const SIGNABLE_PHASES: Phase[] = PHASE_ORDER.filter((p) => p !== "init");

const BASE: Phase[] = [...DEFAULT_ENABLED_PHASES];
const WITH_RESEARCH: Phase[] = PHASE_ORDER.filter(
  (p) => p === "research" || DEFAULT_ENABLED_PHASES.includes(p),
);

function modesFrom(phases: Phase[], copilotPhases: Phase[]): PhaseModes {
  const out: PhaseModes = {};
  for (const p of phases) out[p] = copilotPhases.includes(p) ? "copilot" : "autopilot";
  return out;
}

/**
 * The workflows that ship with the package.
 *
 * Four, not one per taste: enough that most people find themselves in the
 * list, few enough that reading the list is faster than building one.
 */
export const BUILTIN_WORKFLOWS: Workflow[] = [
  {
    id: "copilot",
    name: "copilot",
    description: "You approve the research, the definition and the plan. Then it builds.",
    builtIn: true,
    phases: BASE,
    modes: modesFrom(BASE, ["research", "define", "plan"]),
  },
  {
    id: "autopilot",
    name: "autopilot",
    description: "You approve nothing. Say what you want, walk away, read the result.",
    builtIn: true,
    phases: BASE,
    modes: modesFrom(BASE, []),
  },
  {
    id: "spec-and-ship",
    name: "spec and ship",
    description: "You sign the scope going in and the release coming out. The middle is its own.",
    builtIn: true,
    phases: BASE,
    modes: modesFrom(BASE, ["define", "ship"]),
  },
  {
    id: "research-first",
    name: "research first",
    description: "Adds a RESEARCH phase and stops on all three thinking phases before any code.",
    builtIn: true,
    phases: WITH_RESEARCH,
    modes: modesFrom(WITH_RESEARCH, ["research", "define", "plan"]),
  },
  {
    id: "every-gate",
    name: "every gate",
    description: "It stops at every phase. Slowest, and the one you want on something that matters.",
    builtIn: true,
    phases: BASE,
    modes: modesFrom(BASE, BASE),
  },
];

export function builtInWorkflow(id: string): Workflow | null {
  return BUILTIN_WORKFLOWS.find((w) => w.id === id) ?? null;
}

// ── the saved store ─────────────────────────────────────────────────────────

type SavedStore = { version: string; workflows: Workflow[] };

/** Turn a name into a stable id. Two workflows cannot share one. */
export function slugify(name: string): string {
  const slug = String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug;
}

export function loadSavedWorkflows(env?: NodeJS.ProcessEnv): Workflow[] {
  const store = readJsonSafe<SavedStore | null>(userWorkflowsPath(env), null);
  const list = Array.isArray(store?.workflows) ? store.workflows : [];
  return list
    .filter((w): w is Workflow => typeof w?.id === "string" && typeof w?.name === "string")
    .map((w) => ({
      ...w,
      builtIn: false,
      phases: normalizePhases(w.phases),
      modes: normalizeModes(w.modes, normalizePhases(w.phases)),
    }));
}

/** Built-ins first, then the person's own. */
export function listWorkflows(env?: NodeJS.ProcessEnv): Workflow[] {
  return [...BUILTIN_WORKFLOWS, ...loadSavedWorkflows(env)];
}

export function findWorkflow(id: string, env?: NodeJS.ProcessEnv): Workflow | null {
  return listWorkflows(env).find((w) => w.id === id) ?? null;
}

export type SaveResult = { ok: boolean; error: string | null; workflow?: Workflow };

/**
 * Save a workflow under a name the person chose.
 *
 * Overwriting one of their own is fine — that is editing. Overwriting a
 * built-in is refused: "copilot" has to mean the same thing everywhere, and a
 * shadowed built-in is a support conversation nobody enjoys.
 */
export function saveWorkflow(
  input: { name: string; description?: string; phases: Phase[]; modes: PhaseModes },
  env?: NodeJS.ProcessEnv,
): SaveResult {
  const name = String(input.name ?? "").trim();
  if (!name) return { ok: false, error: "A workflow needs a name." };

  const id = slugify(name);
  if (!id) return { ok: false, error: `"${name}" has no letters or digits in it.` };
  if (builtInWorkflow(id)) {
    return { ok: false, error: `"${name}" is a built-in workflow. Pick another name.` };
  }

  const phases = normalizePhases(input.phases);
  const workflow: Workflow = {
    id,
    name,
    description: (input.description ?? "").trim() || describeModes(phases, normalizeModes(input.modes, phases)),
    builtIn: false,
    phases,
    modes: normalizeModes(input.modes, phases),
    savedAt: new Date().toISOString(),
  };

  const existing = loadSavedWorkflows(env).filter((w) => w.id !== id);
  const path = userWorkflowsPath(env);
  try {
    ensureDir(dirname(path));
    writeJsonAtomic(path, { version: "1", workflows: [...existing, workflow] } satisfies SavedStore);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, error: null, workflow };
}

export function deleteWorkflow(id: string, env?: NodeJS.ProcessEnv): SaveResult {
  if (builtInWorkflow(id)) return { ok: false, error: "Built-in workflows cannot be deleted." };
  const remaining = loadSavedWorkflows(env).filter((w) => w.id !== id);
  const path = userWorkflowsPath(env);
  try {
    ensureDir(dirname(path));
    writeJsonAtomic(path, { version: "1", workflows: remaining } satisfies SavedStore);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, error: null };
}

// ── normalising ─────────────────────────────────────────────────────────────

export function normalizePhases(requested: readonly Phase[] | undefined): Phase[] {
  if (!Array.isArray(requested) || requested.length === 0) return [...DEFAULT_ENABLED_PHASES];
  const wanted = new Set(requested.filter((p) => (PHASE_ORDER as readonly string[]).includes(p)));
  wanted.delete("init");
  const ordered = PHASE_ORDER.filter((p) => wanted.has(p));
  return ordered.length ? [...ordered] : [...DEFAULT_ENABLED_PHASES];
}

/** Every enabled phase gets an explicit mode; anything else is dropped. */
export function normalizeModes(modes: PhaseModes | undefined, phases: Phase[]): PhaseModes {
  const out: PhaseModes = {};
  for (const p of phases) out[p] = modes?.[p] === "copilot" ? "copilot" : "autopilot";
  return out;
}

// ── applying, and reading back ──────────────────────────────────────────────

/** Fold a workflow into a config. Returns the config for chaining. */
export function applyWorkflow(config: HarnessConfig, workflow: Workflow): HarnessConfig {
  const phases = normalizePhases(workflow.phases);
  config.phases = { ...(config.phases ?? { enabled: phases }), enabled: phases };
  config.phaseModes = normalizeModes(workflow.modes, phases);
  config.workflow = { id: workflow.id, name: workflow.name };
  return config;
}

/** The modes a config is actually running, whatever shape it was written in. */
export function modesOf(config: HarnessConfig): PhaseModes {
  const phases = normalizePhases(config.phases?.enabled as Phase[] | undefined);
  return normalizeModes(config.phaseModes as PhaseModes | undefined, phases);
}

export function modeFor(config: HarnessConfig, phase: Phase | null): PhaseMode {
  if (!phase) return "autopilot";
  return modesOf(config)[phase] === "copilot" ? "copilot" : "autopilot";
}

/** The phases this config stops on, in pipeline order. */
export function signedPhases(config: HarnessConfig): Phase[] {
  const modes = modesOf(config);
  return PHASE_ORDER.filter((p) => modes[p] === "copilot");
}

/**
 * Which built-in or saved workflow a config currently matches, if any.
 *
 * Used to tell someone their settings have drifted off the preset they picked
 * — otherwise a config edited one setting at a time still claims to be
 * "copilot", and the word stops meaning anything.
 */
export function matchWorkflow(config: HarnessConfig, env?: NodeJS.ProcessEnv): Workflow | null {
  const phases = normalizePhases(config.phases?.enabled as Phase[] | undefined);
  const modes = modesOf(config);
  return (
    listWorkflows(env).find(
      (w) =>
        normalizePhases(w.phases).join(",") === phases.join(",") &&
        SIGNABLE_PHASES.every((p) => normalizeModes(w.modes, phases)[p] === modes[p]),
    ) ?? null
  );
}

// ── describing ──────────────────────────────────────────────────────────────

export function describeModes(phases: Phase[], modes: PhaseModes): string {
  const signed = phases.filter((p) => modes[p] === "copilot");
  if (signed.length === 0) return "runs the whole pipeline without stopping";
  if (signed.length === phases.length) return "stops at every phase";
  return `stops at ${signed.map((p) => p.toUpperCase()).join(", ")}`;
}

/** The pipeline with each phase's mode, for a menu row or a notification. */
export function renderWorkflow(workflow: Workflow): string {
  const modes = normalizeModes(workflow.modes, normalizePhases(workflow.phases));
  const rail = normalizePhases(workflow.phases)
    .map((p) => (modes[p] === "copilot" ? `[${p}]` : p))
    .join(" → ");
  return `${workflow.name}\n  ${workflow.description}\n  ${rail}\n  (a phase in [brackets] stops for you)`;
}

/** One line: `copilot · stops at RESEARCH, DEFINE, PLAN`. */
export function summarizeWorkflow(config: HarnessConfig, env?: NodeJS.ProcessEnv): string {
  const phases = normalizePhases(config.phases?.enabled as Phase[] | undefined);
  const modes = modesOf(config);
  const named = matchWorkflow(config, env);
  const recorded = (config.workflow as { name?: string } | undefined)?.name;
  const label = named ? named.name : recorded ? `${recorded} (edited)` : "custom";
  return `${label} · ${describeModes(phases, modes)}`;
}
