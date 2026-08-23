/**
 * infinity-harness — deterministic gates.
 *
 * Gates are the referee. No agent marks its own work complete; a phase only
 * advances when every check for that phase passes. Each check is a pure
 * function of the project on disk, so the same tree always produces the same
 * verdict — that determinism is what makes an unattended multi-day run safe.
 *
 * Checks that cannot run (no lint command configured, no upstream branch) are
 * *advisory*: reported, but never a reason to fail. A gate that fails for a
 * reason the agent cannot fix is a gate that deadlocks the loop.
 */

import { resolve } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import type { CheckResult, GateResult, HarnessConfig, Phase } from "./types.ts";
import { loadConfig, saveConfig, recordGate } from "./config.ts";
import { loadFeatureList, findTask, findFeature, computeProgress, isDone } from "./featureList.ts";
import * as P from "./paths.ts";
import { readText, fileExists } from "./fsx.ts";
import { auditSkillsDir } from "./skillsAudit.ts";
import {
  run,
  isGitRepo,
  gitIsClean,
  gitHasTag,
  gitBehindUpstream,
  gitHasUpstream,
  LONG_TIMEOUT_MS,
} from "./exec.ts";

type Ctx = { targetDir: string; config: HarnessConfig };

const pass = (name: string, detail: string): CheckResult => ({ name, pass: true, detail });
const fail = (name: string, detail: string): CheckResult => ({ name, pass: false, detail });
const skip = (name: string, detail: string): CheckResult => ({
  name,
  pass: true,
  detail,
  advisory: true,
});

// ── Individual checks ───────────────────────────────────────────────────────

async function checkGitRepo({ targetDir }: Ctx): Promise<CheckResult> {
  return (await isGitRepo(targetDir))
    ? pass("git-repo", "inside a git work tree")
    : fail("git-repo", "not a git repository — run `git init`");
}

async function checkConfigExists({ targetDir }: Ctx): Promise<CheckResult> {
  return fileExists(P.configPath(targetDir))
    ? pass("config-exists", "harness/config.json present")
    : fail("config-exists", "harness/config.json is missing");
}

async function checkGitClean({ targetDir }: Ctx): Promise<CheckResult> {
  return (await gitIsClean(targetDir))
    ? pass("git-clean", "working tree clean")
    : fail("git-clean", "uncommitted changes — commit or stash before advancing");
}

async function checkLint({ targetDir, config }: Ctx): Promise<CheckResult> {
  const cmd = config.commands?.lint;
  if (!cmd) return skip("lint", "no lint command configured (config.commands.lint)");
  const r = await run(cmd, { cwd: targetDir, timeoutMs: LONG_TIMEOUT_MS });
  if (r.timedOut) return fail("lint", `lint timed out after ${LONG_TIMEOUT_MS}ms`);
  if (r.spawnError) return fail("lint", `lint could not start: ${r.spawnError}`);
  return r.ok
    ? pass("lint", "lint clean")
    : fail("lint", firstLines(r.stderr || r.stdout, 6) || `lint exited ${r.code}`);
}

async function checkTests({ targetDir, config }: Ctx): Promise<CheckResult> {
  const cmd = config.commands?.test;
  if (!cmd) return skip("tests", "no test command configured (config.commands.test)");
  const r = await run(cmd, { cwd: targetDir, timeoutMs: LONG_TIMEOUT_MS });
  if (r.timedOut) return fail("tests", `tests timed out after ${LONG_TIMEOUT_MS}ms`);
  if (r.spawnError) return fail("tests", `tests could not start: ${r.spawnError}`);
  return r.ok
    ? pass("tests", "tests pass")
    : fail("tests", firstLines(r.stderr || r.stdout, 10) || `tests exited ${r.code}`);
}

async function checkCoverage({ targetDir, config }: Ctx): Promise<CheckResult> {
  if (!config.gates?.coverage?.enabled) return skip("coverage", "coverage gate disabled");
  const cmd = config.commands?.coverage;
  if (!cmd) return skip("coverage", "no coverage command configured");
  const threshold = config.gates.coverage.threshold ?? 80;
  const r = await run(cmd, { cwd: targetDir, timeoutMs: LONG_TIMEOUT_MS });
  if (r.timedOut) return fail("coverage", `coverage run timed out after ${LONG_TIMEOUT_MS}ms`);
  if (r.spawnError) return fail("coverage", `coverage could not start: ${r.spawnError}`);
  const pct = parseCoveragePercent(r.stdout + "\n" + r.stderr);
  if (pct === null) {
    return r.ok
      ? skip("coverage", "coverage ran but no percentage could be parsed")
      : fail("coverage", `coverage command exited ${r.code}`);
  }
  return pct >= threshold
    ? pass("coverage", `${pct}% ≥ ${threshold}% threshold`)
    : fail("coverage", `${pct}% is below the ${threshold}% threshold`);
}

/** Pull the highest "NN%"-looking number out of a coverage report. */
export function parseCoveragePercent(text: string): number | null {
  const matches = [...text.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)];
  if (matches.length === 0) return null;
  const nums = matches
    .map((m) => Number.parseFloat(m[1]!))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 100);
  if (nums.length === 0) return null;
  // Coverage tools print several figures (lines/branches/functions). The
  // "all files" total is normally the lowest of the set, so take the minimum
  // rather than an optimistic maximum.
  return Math.min(...nums);
}

const PLACEHOLDER_PATTERNS = [
  /\bTODO\b\s*:?\s*implement/i,
  /\bFIXME\b/,
  /\bnot implemented\b/i,
  /throw new Error\((["'`])(?:TODO|unimplemented|not implemented)/i,
  /\bplaceholder\b/i,
  /\bcoming soon\b/i,
];

const SCAN_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".rb", ".java", ".kt", ".swift", ".cs", ".php",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "target", "vendor",
  "coverage", ".next", ".venv", "venv", "__pycache__", "tmp", ".pi",
]);

function walkSource(dir: string, out: string[], depth = 0): void {
  if (depth > 8 || out.length > 4000) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".") && name !== ".") continue;
    if (SKIP_DIRS.has(name)) continue;
    const full = resolve(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkSource(full, out, depth + 1);
    } else if (SCAN_EXTENSIONS.has(name.slice(name.lastIndexOf(".")))) {
      out.push(full);
    }
  }
}

async function checkNoPlaceholders({ targetDir, config }: Ctx): Promise<CheckResult> {
  if (!config.gates?.antiPlaceholder?.enabled) {
    return skip("anti-placeholder", "anti-placeholder gate disabled");
  }
  const extra = (config.gates.antiPlaceholder.patterns ?? [])
    .map((p) => {
      try {
        return new RegExp(p, "i");
      } catch {
        return null;
      }
    })
    .filter((r): r is RegExp => r !== null);
  const patterns = [...PLACEHOLDER_PATTERNS, ...extra];

  const files: string[] = [];
  walkSource(targetDir, files);
  const hits: string[] = [];
  for (const f of files) {
    const text = readText(f);
    if (text === null) continue;
    for (const p of patterns) {
      if (p.test(text)) {
        hits.push(f.replace(targetDir + "/", ""));
        break;
      }
    }
    if (hits.length >= 8) break;
  }
  return hits.length === 0
    ? pass("anti-placeholder", `${files.length} source files, no placeholder markers`)
    : fail("anti-placeholder", `placeholder markers in: ${hits.join(", ")}`);
}

function docCheck(name: string, path: string, minChars: number, hint: string): CheckResult {
  const text = readText(path);
  if (text === null) return fail(name, `${hint} is missing`);
  // Headings are structure and HTML comments are instructions to the author —
  // neither is content. This matters because the scaffolded starters explain
  // in a comment what belongs in the file; counting that would let the review
  // gate pass on a template nobody had written a word into.
  const body = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^#.*$/gm, "")
    .trim();
  return body.length >= minChars
    ? pass(name, `${hint} present (${body.length} chars)`)
    : fail(name, `${hint} exists but is essentially empty (${body.length} chars, need ${minChars})`);
}

async function checkReadme({ targetDir }: Ctx): Promise<CheckResult> {
  return docCheck("readme", resolve(targetDir, "README.md"), 200, "README.md");
}
async function checkLicense({ targetDir }: Ctx): Promise<CheckResult> {
  return fileExists(resolve(targetDir, "LICENSE")) || fileExists(resolve(targetDir, "LICENSE.md"))
    ? pass("license", "LICENSE present")
    : fail("license", "LICENSE is missing");
}
async function checkChangelog({ targetDir }: Ctx): Promise<CheckResult> {
  return docCheck("changelog", resolve(targetDir, "CHANGELOG.md"), 100, "CHANGELOG.md");
}
async function checkArchitectureDoc({ targetDir }: Ctx): Promise<CheckResult> {
  return docCheck("architecture-doc", P.architecturePath(targetDir), 200, "harness/docs/ARCHITECTURE.md");
}
async function checkDecisionsLogged({ targetDir }: Ctx): Promise<CheckResult> {
  return docCheck("decisions-logged", P.decisionsPath(targetDir), 100, "harness/docs/DECISIONS.md");
}
async function checkRubricContent({ targetDir }: Ctx): Promise<CheckResult> {
  return docCheck("rubric-content", P.rubricPath(targetDir), 100, "harness/evaluator-rubric.md");
}

/**
 * Any skills this project ships must be loadable by pi.
 *
 * Advisory, because a malformed skill does not make the code wrong — it makes
 * pi print a `[Skill conflicts]` block on every start, which is exactly the
 * kind of thing that gets ignored for months. This package learned that the
 * hard way from its own README sitting in its own skills directory. Reporting
 * it in the gate is how a project finds out before its users do.
 */
async function checkSkillsLoad({ targetDir }: Ctx): Promise<CheckResult> {
  const dirs = [P.skillsDir(targetDir), resolve(targetDir, ".pi", "skills"), resolve(targetDir, ".agents", "skills")];
  const present = dirs.filter((d) => existsSync(d));
  if (present.length === 0) {
    return { ...skip("skills-load", "this project ships no skills"), advisory: true };
  }

  const problems: string[] = [];
  let count = 0;
  for (const dir of present) {
    const audit = auditSkillsDir(dir);
    count += audit.skills.length;
    for (const p of audit.problems) {
      problems.push(`${p.file.replace(`${targetDir}/`, "")}: ${p.message}`);
    }
  }
  return problems.length === 0
    ? { ...pass("skills-load", `${count} skill(s) load cleanly in pi`), advisory: true }
    : {
        ...fail("skills-load", `pi would report a skill conflict — ${problems.slice(0, 4).join("; ")}`),
        advisory: true,
      };
}

async function checkTagged({ targetDir }: Ctx): Promise<CheckResult> {
  return (await gitHasTag(targetDir))
    ? pass("tagged", "HEAD carries a release tag")
    : fail("tagged", "HEAD is not tagged — tag the release before shipping");
}

async function checkBranchUpToDate({ targetDir }: Ctx): Promise<CheckResult> {
  if (!(await gitHasUpstream(targetDir))) {
    return skip("branch-up-to-date", "no upstream configured");
  }
  const behind = await gitBehindUpstream(targetDir);
  if (behind === null) return skip("branch-up-to-date", "could not compare against upstream");
  return behind === 0
    ? pass("branch-up-to-date", "level with upstream")
    : fail("branch-up-to-date", `${behind} commit(s) behind upstream — pull first`);
}

async function checkNoEmptyDirs({ targetDir }: Ctx): Promise<CheckResult> {
  const empties: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || empties.length >= 5) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    const visible = entries.filter((e) => !SKIP_DIRS.has(e) && !e.startsWith("."));
    if (visible.length === 0 && dir !== targetDir) {
      empties.push(dir.replace(targetDir + "/", ""));
      return;
    }
    for (const e of visible) {
      const full = resolve(dir, e);
      try {
        if (statSync(full).isDirectory()) walk(full, depth + 1);
      } catch {
        /* unreadable */
      }
    }
  };
  walk(targetDir, 0);
  return empties.length === 0
    ? pass("no-empty-dirs", "no empty directories")
    : fail("no-empty-dirs", `empty directories: ${empties.join(", ")}`);
}

/** Every feature must declare acceptance criteria before BUILD starts. */
async function checkFeatureCriteria({ targetDir }: Ctx): Promise<CheckResult> {
  const { list } = loadFeatureList(targetDir);
  const features = list.features ?? [];
  if (features.length === 0) return fail("feature-criteria", "no features planned yet");
  const missing = features.filter((f) => !(f.criteria ?? []).length).map((f) => f.id);
  return missing.length === 0
    ? pass("feature-criteria", `${features.length} feature(s) have criteria`)
    : fail("feature-criteria", `features without criteria: ${missing.join(", ")}`);
}

/** Every task in the plan must be complete before the phase gate opens. */
async function checkTasksComplete({ targetDir }: Ctx): Promise<CheckResult> {
  const { list } = loadFeatureList(targetDir);
  const p = computeProgress(list);
  if (p.tasksTotal === 0) return fail("tasks-complete", "no tasks planned");
  if (p.tasksDone === p.tasksTotal) return pass("tasks-complete", `${p.tasksDone}/${p.tasksTotal} tasks complete`);
  const remaining = p.tasksTotal - p.tasksDone;
  return fail(
    "tasks-complete",
    `${remaining} task(s) still open (${p.blocked} blocked, ${p.inProgress} in progress, ${p.rework} rework)`,
  );
}

function firstLines(s: string, n: number): string {
  return s.split("\n").slice(0, n).join("\n").trim();
}

// ── Phase → checks ──────────────────────────────────────────────────────────

type Check = (ctx: Ctx) => Promise<CheckResult>;

const PHASE_CHECKS: Record<Phase, Check[]> = {
  init: [checkGitRepo, checkConfigExists],
  define: [checkFeatureCriteria, checkSkillsLoad],
  plan: [checkFeatureCriteria, checkTasksPlanned],
  build: [checkLint, checkTests, checkCoverage, checkNoPlaceholders, checkTasksComplete],
  verify: [checkTests, checkCoverage, checkGitClean],
  simplify: [checkTests, checkNoEmptyDirs, checkGitClean],
  review: [checkBranchUpToDate, checkRubricContent, checkReadme, checkArchitectureDoc, checkDecisionsLogged, checkSkillsLoad],
  ship: [
    checkGitClean,
    checkTagged,
    checkChangelog,
    checkReadme,
    checkLicense,
    checkNoEmptyDirs,
    checkNoPlaceholders,
  ],
};

async function checkTasksPlanned({ targetDir }: Ctx): Promise<CheckResult> {
  const { list } = loadFeatureList(targetDir);
  const total = (list.features ?? []).reduce((n, f) => n + (f.tasks ?? []).length, 0);
  return total > 0
    ? pass("tasks-planned", `${total} task(s) planned`)
    : fail("tasks-planned", "no tasks planned — PLAN must produce a task list");
}

/** Checks that are meaningful for a single task rather than a whole phase. */
const TASK_SCOPED = new Set(["lint", "tests", "coverage"]);

export function getPhaseCheckNames(phase: Phase): string[] {
  return (PHASE_CHECKS[phase] ?? []).map((fn) => fn.name.replace(/^check/, "").toLowerCase());
}

// ── Runner ──────────────────────────────────────────────────────────────────

export type RunChecksOptions = {
  feature?: string;
  task?: string;
  /** Persist the verdict to gateHistory. Read-only callers pass false. */
  record?: boolean;
};

/**
 * Run the checks for `phase`.
 *
 * With `feature` + `task` set, only task-scoped checks run plus that task's
 * own acceptance criteria — validating one task must not demand that the
 * whole phase is finished.
 */
export async function runChecks(
  targetDir: string,
  phase: Phase | null,
  options: RunChecksOptions = {},
): Promise<GateResult> {
  const { config } = loadConfig(targetDir);

  if (!phase) {
    return { phase: "none", checks: [], overall: false, failures: ["no-phase"] };
  }
  if (config.gates?.enabled === false) {
    return {
      phase,
      checks: [skip("gates-disabled", "gates are disabled in config — nothing enforced")],
      overall: true,
      failures: [],
    };
  }

  const ctx: Ctx = { targetDir, config };
  const isTaskScoped = Boolean(options.feature && options.task);

  let checks = PHASE_CHECKS[phase] ?? [];
  if (isTaskScoped) {
    checks = checks.filter((fn) => TASK_SCOPED.has(fn.name.replace(/^check/, "").toLowerCase()));
  }

  const results: CheckResult[] = [];
  for (const fn of checks) {
    try {
      results.push(await fn(ctx));
    } catch (e) {
      results.push(fail(fn.name, `check threw: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  if (isTaskScoped) {
    results.push(checkTaskCriteria(targetDir, options.feature!, options.task!));
  }

  const failures = results.filter((r) => !r.pass).map((r) => r.name);
  const result: GateResult = {
    phase,
    checks: results,
    overall: failures.length === 0,
    failures,
    ...(options.feature ? { feature: options.feature } : {}),
    ...(options.task ? { task: options.task } : {}),
  };

  if (options.record !== false) {
    try {
      const fresh = loadConfig(targetDir);
      if (fresh.ok) {
        recordGate(fresh.config, phase, result.overall ? "pass" : "fail", {
          feature: options.feature,
          task: options.task,
        });
        saveConfig(targetDir, fresh.config);
      }
    } catch {
      /* gate history is best-effort and must never break validation */
    }
  }

  return result;
}

/** A task passes when it is marked complete and every subtask is complete. */
export function checkTaskCriteria(targetDir: string, featureId: string, taskId: string): CheckResult {
  const { list } = loadFeatureList(targetDir);
  const feature = findFeature(list, featureId);
  if (!feature) return fail("task-criteria", `unknown feature ${featureId}`);
  const found = findTask(list, taskId);
  if (!found) return fail("task-criteria", `unknown task ${taskId}`);
  const { task } = found;
  const openSubtasks = (task.subtasks ?? []).filter((s) => s.status !== "complete");
  if (openSubtasks.length > 0) {
    return fail("task-criteria", `${openSubtasks.length} subtask(s) still open on ${taskId}`);
  }
  if (!isDone(task.status)) {
    return fail("task-criteria", `${taskId} is "${task.status}", not complete`);
  }
  return pass("task-criteria", `${taskId} complete with all subtasks done`);
}

export function areGatesEnabled(targetDir: string): boolean {
  const { config } = loadConfig(targetDir);
  return config.gates?.enabled !== false;
}
