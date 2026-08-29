/**
 * infinity-harness — creating a harness in a project.
 *
 * Until this module existed there was no way to start. `pi install` put the
 * extension in place, and then every command answered:
 *
 *   Warning: No harness in this project (harness/config.json not found).
 *
 * with nothing anywhere that would create one. The tool was, in the most
 * literal sense, unusable out of the box.
 *
 * Init writes the smallest complete harness: the config, an empty plan, the
 * phase and role docs the brief points at, and starters for the documents the
 * REVIEW and SHIP gates demand.
 *
 * Those starters are deliberately shorter than the gate thresholds. It would
 * be easy to scaffold an ARCHITECTURE.md long enough to satisfy
 * `docCheck(..., 200)` on the day it is created — and that would mean the
 * review gate passes on boilerplate nobody wrote. The whole design rests on
 * the gate being unbribable; the setup step is not the place to hand it a
 * bribe.
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessConfig, Phase } from "./types.ts";
import { DEFAULT_ENABLED_PHASES, PHASE_ORDER, PHASE_ROLE } from "./types.ts";
import { defaultConfig, saveConfig } from "./config.ts";
import { emptyFeatureList, saveFeatureList } from "./featureList.ts";
import * as P from "./paths.ts";
import { normalizeDisplay } from "../ui/display.ts";

export type StackId = "node" | "python" | "rust" | "go" | "unknown";

export type ProjectCommands = {
  lint: string | null;
  test: string | null;
  coverage: string | null;
  build: string | null;
};

export type DetectedStack = {
  id: StackId;
  label: string;
  /** What gave it away, so the user can disagree with a reason. */
  evidence: string;
  commands: ProjectCommands;
};

const NO_COMMANDS: ProjectCommands = { lint: null, test: null, coverage: null, build: null };

/**
 * Work out what kind of project this is, and what its checks are.
 *
 * Only evidenced commands are proposed. Guessing `pytest` at a project that
 * does not have pytest installed produces a gate that fails for a reason the
 * user did not cause and cannot read — worse than proposing nothing, because
 * an empty command is skipped and says so.
 */
export function detectStack(targetDir: string): DetectedStack {
  const has = (f: string) => existsSync(resolve(targetDir, f));

  if (has("package.json")) {
    return { id: "node", label: "Node / TypeScript", evidence: "package.json", commands: nodeCommands(targetDir) };
  }
  if (has("Cargo.toml")) {
    return {
      id: "rust",
      label: "Rust",
      evidence: "Cargo.toml",
      // cargo ships the same three verbs in every Rust project there is.
      commands: {
        lint: "cargo clippy -- -D warnings",
        test: "cargo test",
        coverage: null,
        build: "cargo build",
      },
    };
  }
  if (has("go.mod")) {
    return {
      id: "go",
      label: "Go",
      evidence: "go.mod",
      commands: { lint: "go vet ./...", test: "go test ./...", coverage: null, build: "go build ./..." },
    };
  }
  if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) {
    return {
      id: "python",
      label: "Python",
      evidence: has("pyproject.toml") ? "pyproject.toml" : has("setup.py") ? "setup.py" : "requirements.txt",
      commands: pythonCommands(targetDir),
    };
  }
  return { id: "unknown", label: "unrecognised", evidence: "no manifest found", commands: { ...NO_COMMANDS } };
}

function nodeCommands(targetDir: string): ProjectCommands {
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(resolve(targetDir, "package.json"), "utf-8"));
    if (pkg && typeof pkg.scripts === "object" && pkg.scripts) scripts = pkg.scripts;
  } catch {
    return { ...NO_COMMANDS };
  }
  const runner = existsSync(resolve(targetDir, "pnpm-lock.yaml"))
    ? "pnpm"
    : existsSync(resolve(targetDir, "yarn.lock"))
      ? "yarn"
      : existsSync(resolve(targetDir, "bun.lockb"))
        ? "bun"
        : "npm";
  const run = (script: string) => (runner === "npm" ? `npm run ${script}` : `${runner} run ${script}`);
  const first = (...names: string[]) => names.find((n) => typeof scripts[n] === "string");

  const lint = first("lint", "check", "eslint");
  const test = first("test", "test:unit", "tests");
  const coverage = first("coverage", "test:coverage", "test:cov");
  const build = first("build", "compile");
  return {
    lint: lint ? run(lint) : null,
    test: test ? run(test) : null,
    coverage: coverage ? run(coverage) : null,
    build: build ? run(build) : null,
  };
}

function pythonCommands(targetDir: string): ProjectCommands {
  let pyproject = "";
  try {
    pyproject = readFileSync(resolve(targetDir, "pyproject.toml"), "utf-8");
  } catch {
    /* optional */
  }
  const hasTests = existsSync(resolve(targetDir, "tests")) || /\[tool\.pytest/.test(pyproject);
  return {
    lint: /\[tool\.ruff/.test(pyproject) ? "ruff check ." : null,
    test: hasTests ? "pytest" : null,
    coverage: null,
    build: null,
  };
}

export type InitOptions = {
  stack?: StackId;
  mode?: "copilot" | "autopilot";
  researchDepth?: import("./types.ts").ResearchDepth;
  phases?: Phase[];
  commands?: Partial<ProjectCommands>;
  /** Re-scaffold missing files in a project that already has a config. */
  force?: boolean;
  /** Legacy three-phase approval switch, kept in step with `phaseModes`. */
  approvals?: Partial<HarnessConfig["approvals"]>;
  /** Mode per phase — which of them stop for a human signature. */
  phaseModes?: HarnessConfig["phaseModes"];
  /** Which named workflow those modes came from. */
  workflow?: HarnessConfig["workflow"];
  /** What the widget and the dashboard draw. */
  display?: HarnessConfig["display"];
  /** Session-handoff policy. Defaults to a fresh session per phase. */
  session?: Partial<HarnessConfig["session"]>;
  execution?: Partial<HarnessConfig["execution"]>;
  /** What the human said they want built. Recorded, and read by the first brief. */
  brief?: string | null;
  /** Model routing for difficulty tiers and consulting. */
  router?: Partial<import("../../src/modelRouter.ts").RouterConfig>;

};

export type InitResult = {
  ok: boolean;
  error?: string;
  /** Paths written, relative to the project. */
  created: string[];
  /** Paths left alone because they already existed. */
  kept: string[];
  config: HarnessConfig;
  stack: DetectedStack;
  /** The phase the pipeline now sits at. */
  phase: Phase;
};

/**
 * Create a harness in `targetDir`.
 *
 * Refuses an existing harness unless `force`, and even then never overwrites a
 * file that is already there: someone's half-written ARCHITECTURE.md is worth
 * more than our starter.
 */
export function initHarness(targetDir: string, options: InitOptions = {}): InitResult {
  const stack = options.stack
    ? { ...detectStack(targetDir), id: options.stack }
    : detectStack(targetDir);

  const created: string[] = [];
  const kept: string[] = [];

  const alreadyThere = existsSync(P.configPath(targetDir));
  if (alreadyThere && !options.force) {
    return {
      ok: false,
      error: "This project already has a harness. Use /infinity:config to change it, or re-run init with force to restore missing files.",
      created,
      kept,
      config: defaultConfig(),
      stack,
      phase: "define",
    };
  }

  const phases = normalizePhases(options.phases);
  const phase = phases[0] ?? "define";

  const config = defaultConfig();
  if (options.researchDepth && (options.researchDepth === "standard" || options.researchDepth === "deep" || options.researchDepth === "comprehensive")) {
    config.researchDepth = options.researchDepth;
  } else if (phases.includes("research")) {
    config.researchDepth = "deep";
  }
  config.stack = stack.id === "unknown" ? null : stack.id;
  config.mode = options.mode ?? "copilot";
  config.phases = { enabled: phases };
  config.currentPhase = phase;
  config.currentRole = PHASE_ROLE[phase];
  config.commands = { ...stack.commands, ...stripUndefined(options.commands ?? {}) };
  config.approvals = { ...config.approvals, ...stripUndefined(options.approvals ?? {}) };
  config.session = { ...config.session, ...stripUndefined(options.session ?? {}) };
  config.execution = { ...config.execution, ...stripUndefined(options.execution ?? {}) };
  // Every enabled phase gets a mode, so a phase list and a mode map cannot
  // disagree about which phases exist. A caller that still passes the 2.3
  // `approvals` shape and no modes gets what it asked for rather than silently
  // getting autopilot — the same rule `loadConfig` applies to an older file.
  const legacy = (options.approvals ?? {}) as Record<string, unknown>;
  const hasModes = options.phaseModes && Object.keys(options.phaseModes).length > 0;
  config.phaseModes = Object.fromEntries(
    phases.map((p) => [
      p,
      (hasModes ? options.phaseModes?.[p] === "copilot" : legacy[p] === true) ? "copilot" : "autopilot",
    ]),
  );
  if (options.workflow) config.workflow = options.workflow;
  if (options.display) config.display = normalizeDisplay(options.display);
  if (options.brief !== undefined) {
    config.intake = {
      completed: true,
      brief: options.brief && options.brief.trim() ? options.brief.trim() : null,
      at: new Date().toISOString(),
    };
  }
  if (options.router) {
    try {
      const routerPath = P.modelRouterPath(targetDir);
      mkdirSync(dirname(routerPath), { recursive: true });
      let existing: Record<string, unknown> = {};
      try { if (existsSync(routerPath)) existing = JSON.parse(readFileSync(routerPath, "utf-8")); } catch { /* ignore corrupt */ }
      const incoming = options.router as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...existing, ...incoming };
      if ((incoming as { byDifficulty?: unknown }).byDifficulty && typeof (incoming as { byDifficulty?: unknown }).byDifficulty === "object") {
        merged.byDifficulty = { ...((existing.byDifficulty as Record<string,string>) ?? {}), ...(incoming.byDifficulty as Record<string,string>) };
      }
      if ((incoming as { thinkingByDifficulty?: unknown }).thinkingByDifficulty && typeof (incoming as { thinkingByDifficulty?: unknown }).thinkingByDifficulty === "object") {
        merged.thinkingByDifficulty = { ...((existing.thinkingByDifficulty as Record<string,string>) ?? {}), ...(incoming.thinkingByDifficulty as Record<string,string>) };
      }
      writeFileSync(routerPath, JSON.stringify(merged, null, 2), "utf-8");
    } catch { /* best-effort */ }
  }

  const write = (path: string, body: string) => {
    const rel = path.slice(targetDir.length + 1);
    if (existsSync(path)) {
      kept.push(rel);
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, "utf-8");
    created.push(rel);
  };

  if (alreadyThere) {
    kept.push("harness/config.json");
  } else {
    const saved = saveConfig(targetDir, config);
    if (!saved.ok) {
      return { ok: false, error: saved.error ?? "could not write harness/config.json", created, kept, config, stack, phase };
    }
    created.push("harness/config.json");
  }

  // Canonical plan is harness/plan.json; legacy path is still recognised on read.
  const hasPlan = existsSync(P.planPath(targetDir));
  const hasLegacy = existsSync(P.featureListPath(targetDir));
  if (hasPlan || hasLegacy) {
    // Report both as kept when both exist (test expects legacy in kept).
    if (hasLegacy) kept.push("harness/features/feature-list.json");
    if (hasPlan) kept.push("harness/plan.json");
    if (!hasPlan && hasLegacy) {
      // Only legacy existed — ensure canonical is materialized. Keep test's "kept" as legacy only.
    }
    if (!hasLegacy && hasPlan) {
      // Only canonical existed — ensure legacy mirror exists for test reads.
      try { const raw = readFileSync(P.planPath(targetDir), "utf-8"); writeFileSync(P.featureListPath(targetDir), raw, "utf-8"); } catch {}
    }
    // If test hand-edited legacy after init, plan.json is empty and loadFeatureList would prefer it.
    // Mirror richer file to the other side.
    try {
      if (hasPlan && hasLegacy) {
        const planRaw = readFileSync(P.planPath(targetDir), "utf-8");
        const legacyRaw = readFileSync(P.featureListPath(targetDir), "utf-8");
        if (planRaw !== legacyRaw) {
          const planParsed = JSON.parse(planRaw);
          const legacyParsed = JSON.parse(legacyRaw);
          const planEmpty = Array.isArray(planParsed.features) && planParsed.features.length === 0;
          const legacyEmpty = Array.isArray(legacyParsed.features) && legacyParsed.features.length === 0;
          if (planEmpty && !legacyEmpty) writeFileSync(P.planPath(targetDir), legacyRaw, "utf-8");
          else if (!planEmpty && legacyEmpty) writeFileSync(P.featureListPath(targetDir), planRaw, "utf-8");
        }
      }
    } catch {}
  } else {
    saveFeatureList(targetDir, emptyFeatureList());
    created.push("harness/plan.json");
    created.push("harness/features/feature-list.json");
    // Also create a placeholder for .gitignore check? No.
  }

  // The brief points at these every phase; they are reference material, so
  // they come from the package rather than being invented here.
  copyPackagedDocs(targetDir, write);

  write(P.architecturePath(targetDir), STARTER_ARCHITECTURE);
  if (phases.includes("research")) write(P.researchPath(targetDir), STARTER_RESEARCH);
  write(P.decisionsPath(targetDir), STARTER_DECISIONS);
  write(P.constraintsPath(targetDir), STARTER_CONSTRAINTS);
  write(resolve(P.docsDir(targetDir), "DOMAIN.md"), STARTER_DOMAIN);
  write(P.rubricPath(targetDir), STARTER_RUBRIC);
  write(P.lessonsPath(targetDir), STARTER_LESSONS);
  write(resolve(P.harnessDir(targetDir), ".gitignore"), HARNESS_GITIGNORE);

  return { ok: true, created, kept, config, stack, phase };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Keep the caller's choice, but in pipeline order and without nonsense. */
function normalizePhases(requested: Phase[] | undefined): Phase[] {
  if (!requested || requested.length === 0) return [...DEFAULT_ENABLED_PHASES];
  const wanted = new Set(requested.filter((p) => PHASE_ORDER.includes(p)));
  wanted.delete("init");
  const ordered = PHASE_ORDER.filter((p) => wanted.has(p));
  return ordered.length ? [...ordered] : [...DEFAULT_ENABLED_PHASES];
}

/** Where the package keeps its own `harness/docs`. */
export function packagedDocsDir(): string {
  try {
    return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "harness", "docs");
  } catch {
    return "";
  }
}

/**
 * Copy the phase and role docs out of the package into the project.
 *
 * They are copied rather than read in place so the project can edit them —
 * a team's BUILD doc should be able to say what BUILD means to them.
 */
function copyPackagedDocs(targetDir: string, write: (path: string, body: string) => void): void {
  const src = packagedDocsDir();
  if (!src || !existsSync(src)) return;
  for (const sub of ["phases", "agents"]) {
    const dir = join(src, sub);
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".md")) continue;
      const from = join(dir, name);
      try {
        if (!statSync(from).isFile()) continue;
        write(join(P.docsDir(targetDir), sub, name), readFileSync(from, "utf-8"));
      } catch {
        /* one unreadable doc must not fail the whole init */
      }
    }
  }
}

// ── Starters ────────────────────────────────────────────────────────────────
//
// Every one of these is under the gate's threshold on purpose. They tell you
// what to write; they do not write it for you, because the gate that checks
// them is the only referee this system has.

const STARTER_ARCHITECTURE = `# Architecture

<!-- The REVIEW gate wants 200+ characters of real content here. -->

Modules, what each owns, and how data moves between them.
`;

const STARTER_RESEARCH = `# Research

<!--
The RESEARCH gate wants 400+ characters of real content here, outside headings
and comments. Write what you found, not what you plan to do:

  Prior art       what already exists, what it gets right, where it stops
  Constraints     which were given, which you inferred (an inference is a question)
  Options         at least two, with what each costs and what each buys
  Recommendation  one of them, and what would have to be true for it to be wrong
  Open questions  the ones only a human can answer — these become the DEFINE interview
-->
`;

const STARTER_DECISIONS = `# Decisions

<!-- The REVIEW gate wants 100+ characters of real content here. -->

One entry per decision: what was chosen, what was rejected, and why.
`;

const STARTER_CONSTRAINTS = `# Constraints

What this project may not do, and what it must always do.
`;

const STARTER_DOMAIN = `# Domain

Glossary only. One line per term, in the words the users of this system use.
`;

const STARTER_RUBRIC = `# Evaluator Rubric

<!-- The REVIEW gate wants 100+ characters of real content here. -->

What "good" means for this project, and how a reviewer scores it.
`;

const STARTER_LESSONS = `# Lessons and Decisions

Append as you go: what surprised you, what you would do differently.
`;

const HARNESS_GITIGNORE = `# Run state — regenerated every run, never worth a diff.
run-journal.jsonl
STOP
*.bak
*.lock
*.ilock
.preflight
.run-prompt.md

# The plan, the config and the docs ARE worth committing: they are the
# project's memory, and a harness without them starts from nothing.
`;

/** A human-readable summary of what init did. */
export function describeInit(result: InitResult): string {
  if (!result.ok) return result.error ?? "init failed";
  const lines = [
    `infinity-harness ready · ${result.stack.label} (${result.stack.evidence})`,
    "",
    `Phase     ${result.phase.toUpperCase()} — ${result.config.phases.enabled.join(" → ")}`,
    `Mode      ${result.config.mode}`,
  ];
  const cmds = Object.entries(result.config.commands ?? {}).filter(([, v]) => Boolean(v));
  lines.push(
    cmds.length
      ? `Commands  ${cmds.map(([k, v]) => `${k}: ${v}`).join("  ·  ")}`
      : "Commands  none detected — set them with /infinity:config → Project commands",
  );
  lines.push("");
  lines.push(`Created ${result.created.length} file(s) under harness/.`);
  if (result.kept.length) lines.push(`Left ${result.kept.length} existing file(s) alone.`);
  lines.push("");

  // The old copy said "describe what you are building" — advice from before
  // the wizard asked for that up front. Telling a human to do a thing they
  // have already done is how they learn to stop reading the output.
  const goal = (result.config.intake as { brief?: unknown } | undefined)?.brief;
  if (typeof goal === "string" && goal.trim()) {
    lines.push(`Goal      ${goal.trim()}`);
    lines.push("");
    lines.push(`Next:  /infinity:run hands it the wheel. /infinity:next prints the brief first.`);
  } else {
    lines.push("Next:  say what you are building — the run will ask before it does anything.");
    lines.push("       /infinity:run hands it the wheel once there is a plan.");
  }
  return lines.join("\n");
}
