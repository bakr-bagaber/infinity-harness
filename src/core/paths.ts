/**
 * infinity-harness — path resolution.
 *
 * Every harness-managed file lives under `harness/` in the target project.
 * Nothing outside this module hardcodes a harness path.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";

export const HARNESS_DIRNAME = "harness";

/**
 * Where things that belong to the *person* live, rather than to a project.
 *
 * A workflow someone designed and named is worth exactly as much on their next
 * project as on this one, so it cannot live under `harness/`. This follows
 * pi's own config directory, honouring the same override pi honours, so a
 * sandboxed or rebranded install keeps everything in one place.
 */
export function userDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_CODING_AGENT_DIR;
  if (override && override.trim()) return resolve(override.trim(), "infinity-harness");
  return resolve(homedir(), ".pi", "agent", "infinity-harness");
}

/** The workflows this person has saved, reusable across every project. */
export function userWorkflowsPath(env?: NodeJS.ProcessEnv): string {
  return resolve(userDir(env), "workflows.json");
}

/** The display templates this person has saved. */
export function userDisplayPath(env?: NodeJS.ProcessEnv): string {
  return resolve(userDir(env), "displays.json");
}

export function harnessDir(targetDir: string): string {
  return resolve(targetDir, HARNESS_DIRNAME);
}

export function configPath(targetDir: string): string {
  return resolve(harnessDir(targetDir), "config.json");
}

export function featureListPath(targetDir: string): string {
  return resolve(harnessDir(targetDir), "features", "feature-list.json");
}

export function progressPath(targetDir: string): string {
  return resolve(harnessDir(targetDir), "progress.md");
}

export function rubricPath(targetDir: string): string {
  return resolve(harnessDir(targetDir), "evaluator-rubric.md");
}

export function handoffPath(targetDir: string): string {
  return resolve(harnessDir(targetDir), "session-handoff.md");
}

export function contractPath(targetDir: string): string {
  return resolve(harnessDir(targetDir), "sprint-contract.md");
}

export function lessonsPath(targetDir: string): string {
  return resolve(harnessDir(targetDir), "lessons-decisions.md");
}

export function journalPath(targetDir: string): string {
  return resolve(harnessDir(targetDir), "run-journal.jsonl");
}

export function modelRouterPath(targetDir: string): string {
  return resolve(harnessDir(targetDir), "model-router.json");
}

export function reworkPath(targetDir: string): string {
  return resolve(harnessDir(targetDir), "rework.json");
}

export function replanPath(targetDir: string): string {
  return resolve(harnessDir(targetDir), "replan.json");
}

export function docsDir(targetDir: string): string {
  return resolve(harnessDir(targetDir), "docs");
}

export function architecturePath(targetDir: string): string {
  return resolve(docsDir(targetDir), "ARCHITECTURE.md");
}

export function decisionsPath(targetDir: string): string {
  return resolve(docsDir(targetDir), "DECISIONS.md");
}

export function researchPath(targetDir: string): string {
  return resolve(docsDir(targetDir), "RESEARCH.md");
}

export function constraintsPath(targetDir: string): string {
  return resolve(docsDir(targetDir), "CONSTRAINTS.md");
}

/** Whether a continuous run is armed, and which run it is. Survives sessions. */
export function runStatePath(targetDir: string): string {
  return resolve(harnessDir(targetDir), "run.json");
}

/** A handoff waiting to be picked up by the session that replaces this one. */
export function pendingSessionPath(targetDir: string): string {
  return resolve(harnessDir(targetDir), "next-session.json");
}

export function skillsDir(targetDir: string): string {
  return resolve(harnessDir(targetDir), "skills");
}

export function phaseDocPath(targetDir: string, phase: string): string {
  return resolve(docsDir(targetDir), "phases", `${phase}.md`);
}

export function agentDocPath(targetDir: string, role: string): string {
  return resolve(docsDir(targetDir), "agents", `${role}.md`);
}

/** Root for per-run worker isolation. Always inside the project, always ignorable. */
export function runRoot(targetDir: string): string {
  return resolve(targetDir, "tmp", "infinity-harness");
}

export function agentsPath(targetDir: string): string {
  return resolve(targetDir, "AGENTS.md");
}
