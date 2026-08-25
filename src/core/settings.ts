/**
 * infinity-harness — the settings schema.
 *
 * Every option the harness exposes is declared here once, as data: where it
 * lives, what it accepts, what it defaults to, and how to explain it. The
 * config TUI is *generated* from this list rather than hand-written, so a new
 * option cannot be added to the file format and forgotten in the UI — the two
 * cannot drift because there is only one source.
 *
 * Editing the JSON by hand stays entirely valid. This is the same data, with
 * enough type information attached to prompt for it safely.
 */

import type { HarnessConfig, Phase } from "./types.ts";
import { PHASE_ORDER } from "./types.ts";
import { loadConfig, saveConfig, getKey, setKey } from "./config.ts";
import { loadRouterConfig, saveRouterConfig, type RouterConfig } from "../modelRouter.ts";
import { configPath, modelRouterPath } from "./paths.ts";
import { withLockSync } from "./lock.ts";

/** Which file a setting is persisted in. */
export type SettingFile = "config" | "router";

export type SettingType =
  | { kind: "boolean" }
  | { kind: "number"; min?: number; max?: number; unit?: string }
  | { kind: "text"; placeholder?: string; allowEmpty?: boolean }
  | { kind: "choice"; choices: readonly string[] }
  | { kind: "multi"; choices: readonly string[] }
  /** Resolved at runtime from the models pi has configured. */
  | { kind: "model" }
  | { kind: "thinking" };

export type Setting = {
  /** Dotted path within the file. */
  path: string;
  file: SettingFile;
  label: string;
  /** One line the user reads while choosing. Say what it does, not its type. */
  help: string;
  type: SettingType;
};

export type SettingsGroup = {
  id: string;
  label: string;
  help: string;
  settings: Setting[];
};

// ── The schema ──────────────────────────────────────────────────────────────

/** The two things a phase can do when its gate passes. */
const PHASE_MODE_CHOICES = ["autopilot", "copilot"] as const;

const DIFFICULTY_HELP =
  "Tasks the planner marked at this difficulty run on this model. Empty means: use whatever model pi is already on.";

export const SETTINGS: SettingsGroup[] = [
  {
    id: "models",
    label: "Models",
    help: "Route work to different models by difficulty. Choices come from the models pi has configured.",
    settings: [
      {
        path: "enabled",
        file: "router",
        label: "Routing enabled",
        help: "Off means every task uses pi's current model, whatever is set below.",
        type: { kind: "boolean" },
      },
      {
        path: "byDifficulty.easy",
        file: "router",
        label: "Easy tier",
        help: DIFFICULTY_HELP,
        type: { kind: "model" },
      },
      {
        path: "thinkingByDifficulty.easy",
        file: "router",
        label: "Easy thinking",
        help: "Thinking level for easy tasks. Empty inherits pi's current level.",
        type: { kind: "thinking" },
      },
      {
        path: "byDifficulty.moderate",
        file: "router",
        label: "Moderate tier",
        help: DIFFICULTY_HELP,
        type: { kind: "model" },
      },
      {
        path: "thinkingByDifficulty.moderate",
        file: "router",
        label: "Moderate thinking",
        help: "Thinking level for moderate tasks. Empty inherits pi's current level.",
        type: { kind: "thinking" },
      },
      {
        path: "byDifficulty.difficult",
        file: "router",
        label: "Difficult tier",
        help: DIFFICULTY_HELP,
        type: { kind: "model" },
      },
      {
        path: "thinkingByDifficulty.difficult",
        file: "router",
        label: "Difficult thinking",
        help: "Thinking level for difficult tasks. Empty inherits pi's current level.",
        type: { kind: "thinking" },
      },
      {
        path: "master",
        file: "router",
        label: "Master (consultation only)",
        help: "Never assigned to a task directly — reached only when the ladder is exhausted and the harness asks for one opinion.",
        type: { kind: "model" },
      },
      {
        path: "thinkingMaster",
        file: "router",
        label: "Master thinking",
        help: "Thinking level for the master consultation model.",
        type: { kind: "thinking" },
      },
      {
        path: "default",
        file: "router",
        label: "Default",
        help: "Used when nothing more specific matches. Empty means pi's current model.",
        type: { kind: "model" },
      },
      {
        path: "thinkingDefault",
        file: "router",
        label: "Default thinking",
        help: "Fallback thinking level when no tier-specific level is set.",
        type: { kind: "thinking" },
      },
      {
        path: "consultation.enabled",
        file: "router",
        label: "Allow consultation",
        help: "When a task is stuck at the top of the ladder, ask the master model once.",
        type: { kind: "boolean" },
      },
      {
        path: "consultation.maxPerTask",
        file: "router",
        label: "Consultations per task",
        help: "How many times a single task may escalate to the master model.",
        type: { kind: "number", min: 0, max: 10 },
      },
    ],
  },
  {
    id: "pipeline",
    label: "Pipeline",
    help: "Which phases run, and how strictly roles are enforced.",
    settings: [
      {
        path: "phases.enabled",
        file: "config",
        label: "Enabled phases",
        help: "The pipeline, in order. SIMPLIFY is off by default; INIT is only for a fresh project.",
        type: { kind: "multi", choices: PHASE_ORDER },
      },
      {
        path: "mode",
        file: "config",
        label: "Mode",
        help: "copilot expects a human in the loop; autopilot is for unattended runs.",
        type: { kind: "choice", choices: ["copilot", "autopilot"] },
      },
      {
        path: "roles.strict",
        file: "config",
        label: "Strict roles",
        help: "Make role boundaries blocking rather than advisory. Useful with multiple agents.",
        type: { kind: "boolean" },
      },
      {
        path: "paused",
        file: "config",
        label: "Paused",
        help: "A paused pipeline refuses to advance and stops the continuous run.",
        type: { kind: "boolean" },
      },
    ],
  },
  {
    id: "workflow",
    label: "Workflow",
    help: "Which phases stop and wait for your signature, one phase at a time. `/infinity:workflow` picks a named one or builds a new one.",
    settings: [
      {
        path: "phaseModes.research",
        file: "config",
        label: "RESEARCH",
        help: "copilot stops so you can read harness/docs/RESEARCH.md before anything is specified.",
        type: { kind: "choice", choices: PHASE_MODE_CHOICES },
      },
      {
        path: "phaseModes.define",
        file: "config",
        label: "DEFINE",
        help: "The highest-leverage signature: a wrong definition is a weekend building the wrong thing perfectly.",
        type: { kind: "choice", choices: PHASE_MODE_CHOICES },
      },
      {
        path: "phaseModes.plan",
        file: "config",
        label: "PLAN",
        help: "copilot shows you the whole task list before a line of it is built.",
        type: { kind: "choice", choices: PHASE_MODE_CHOICES },
      },
      {
        path: "phaseModes.build",
        file: "config",
        label: "BUILD",
        help: "copilot stops once the code passes its gate, so you can read the diff.",
        type: { kind: "choice", choices: PHASE_MODE_CHOICES },
      },
      {
        path: "phaseModes.verify",
        file: "config",
        label: "VERIFY",
        help: "copilot asks whether the tests prove the thing works or only that it runs.",
        type: { kind: "choice", choices: PHASE_MODE_CHOICES },
      },
      {
        path: "phaseModes.simplify",
        file: "config",
        label: "SIMPLIFY",
        help: "copilot shows you what was deleted before it moves on.",
        type: { kind: "choice", choices: PHASE_MODE_CHOICES },
      },
      {
        path: "phaseModes.review",
        file: "config",
        label: "REVIEW",
        help: "copilot asks whether you would approve this if someone else had written it.",
        type: { kind: "choice", choices: PHASE_MODE_CHOICES },
      },
      {
        path: "phaseModes.ship",
        file: "config",
        label: "SHIP",
        help: "copilot stops before the tag goes on. The last chance to say no.",
        type: { kind: "choice", choices: PHASE_MODE_CHOICES },
      },
    ],
  },
  {
    id: "display",
    label: "Display",
    help: "What the terminal widget and the web dashboard draw. `/infinity:display` picks a template or edits this level by level.",
    settings: [
      {
        path: "display.levels.goal",
        file: "config",
        label: "Goals",
        help: "The outermost level. Off on a plan with one goal costs you nothing.",
        type: { kind: "boolean" },
      },
      {
        path: "display.levels.sprint",
        file: "config",
        label: "Sprints",
        help: "Off hides the sprint rows; the features under them still show, one level shallower.",
        type: { kind: "boolean" },
      },
      {
        path: "display.levels.feature",
        file: "config",
        label: "Features",
        help: "Off hides the feature rows; their tasks still show.",
        type: { kind: "boolean" },
      },
      {
        path: "display.levels.task",
        file: "config",
        label: "Tasks",
        help: "Off leaves the shape of the run without the work — see the `overview` template.",
        type: { kind: "boolean" },
      },
      {
        path: "display.levels.subtask",
        file: "config",
        label: "Subtasks",
        help: "active shows them only on the task being worked, which is what fits in a widget.",
        type: { kind: "choice", choices: ["none", "active", "all"] },
      },
      {
        path: "display.counts",
        file: "config",
        label: "Counts",
        help: "The done/total figure on goals, sprints and features.",
        type: { kind: "boolean" },
      },
      {
        path: "display.dependencies",
        file: "config",
        label: "Dependency labels",
        help: "The `← #3` markers that say which task a task is waiting on.",
        type: { kind: "boolean" },
      },
      {
        path: "display.criteria",
        file: "config",
        label: "Acceptance criteria",
        help: "Shown under each feature on the dashboard. No room for them in a terminal widget.",
        type: { kind: "boolean" },
      },
      {
        path: "display.rail",
        file: "config",
        label: "Phase rail",
        help: "The `define ─ plan ─ BUILD ─ …` strip.",
        type: { kind: "boolean" },
      },
      {
        path: "display.progress",
        file: "config",
        label: "Progress meter",
        help: "The bar and the task/feature counts beside it.",
        type: { kind: "boolean" },
      },
      {
        path: "display.alerts",
        file: "config",
        label: "Alert strip",
        help: "Blocked and rework counts, retries, sessions, and any phase waiting for you.",
        type: { kind: "boolean" },
      },
      {
        path: "display.taskWindow",
        file: "config",
        label: "Widget rows",
        help: "How many rows of plan the terminal shows before it starts scrolling.",
        type: { kind: "number", min: 3, max: 60 },
      },
    ],
  },
  {
    id: "sessions",
    label: "Sessions",
    help: "How the run divides itself into pi sessions. A run that never starts a fresh one carries its whole history into every request.",
    settings: [
      {
        path: "session.handoff",
        file: "config",
        label: "Fresh session",
        help: "goal: one session · phase: per phase (old) · sprint/feature: when plan grouping changes · task: every task (default) · subtask: every subtask. Coarser levels still fire.",
        type: { kind: "choice", choices: ["off", "goal", "phase", "sprint", "feature", "task", "subtask"] },
      },
      {
        path: "session.contextThreshold",
        file: "config",
        label: "Context handoff threshold",
        help: "Hand off early once the context is this full, as a fraction of the window. 0 disables it. 0.7 keeps a long BUILD phase out of compaction.",
        type: { kind: "number", min: 0, max: 0.95 },
      },
      {
        path: "session.carryNotes",
        file: "config",
        label: "Carry a note across",
        help: "Tell the replacement session, in one line, what the previous one got done.",
        type: { kind: "boolean" },
      },
    ],
  },
  {
    id: "commands",
    label: "Project commands",
    help: "What the gate runs to judge the work. An empty command is reported as advisory, never as a failure.",
    settings: [
      {
        path: "commands.lint",
        file: "config",
        label: "Lint",
        help: "e.g. npm run lint · ruff check . · golangci-lint run",
        type: { kind: "text", placeholder: "npm run lint", allowEmpty: true },
      },
      {
        path: "commands.test",
        file: "config",
        label: "Test",
        help: "e.g. npm test · pytest -q · go test ./...",
        type: { kind: "text", placeholder: "npm test", allowEmpty: true },
      },
      {
        path: "commands.coverage",
        file: "config",
        label: "Coverage",
        help: "Must print a percentage. The lowest figure it prints is the one used.",
        type: { kind: "text", placeholder: "npm run coverage", allowEmpty: true },
      },
      {
        path: "commands.build",
        file: "config",
        label: "Build",
        help: "Optional. Recorded for context; not currently gated on.",
        type: { kind: "text", placeholder: "npm run build", allowEmpty: true },
      },
    ],
  },
  {
    id: "gates",
    label: "Gates",
    help: "The referee. Turning gates off removes every guarantee the harness makes.",
    settings: [
      {
        path: "gates.enabled",
        file: "config",
        label: "Gates enabled",
        help: "Off means nothing is enforced and phases advance freely. Rarely what you want.",
        type: { kind: "boolean" },
      },
      {
        path: "gates.coverage.enabled",
        file: "config",
        label: "Coverage gate",
        help: "Require the coverage command to clear the threshold below.",
        type: { kind: "boolean" },
      },
      {
        path: "gates.coverage.threshold",
        file: "config",
        label: "Coverage threshold",
        help: "Percent. The gate fails below this figure.",
        type: { kind: "number", min: 0, max: 100, unit: "%" },
      },
      {
        path: "gates.antiPlaceholder.enabled",
        file: "config",
        label: "Reject placeholders",
        help: "Fail the gate on TODO-implement, FIXME, 'not implemented' and friends in source.",
        type: { kind: "boolean" },
      },
    ],
  },
  {
    id: "loop",
    label: "Continuous run",
    help: "The budgets that decide when an unattended run gives up. These are what make walking away safe.",
    settings: [
      {
        path: "loop.maxIterations",
        file: "config",
        label: "Iteration ceiling",
        help: "Hard stop after this many loop turns, regardless of the clock.",
        type: { kind: "number", min: 1, max: 100000 },
      },
      {
        path: "loop.maxWallClockMs",
        file: "config",
        label: "Wall-clock budget",
        help: "Milliseconds. 86400000 is 24 hours.",
        type: { kind: "number", min: 60000, unit: "ms" },
      },
      {
        path: "loop.noProgressLimit",
        file: "config",
        label: "No-progress strikes",
        help: "Stop after this many gate failures in a row with no change to the tree or the plan.",
        type: { kind: "number", min: 1, max: 50 },
      },
    ],
  },
  {
    id: "retries",
    label: "Retry budgets",
    help: "How many attempts a task, feature or phase gets before the run escalates to you.",
    settings: [
      {
        path: "maxRetries",
        file: "config",
        label: "Task retries",
        help: "Attempts per task before the harness stops and asks for help.",
        type: { kind: "number", min: 1, max: 100 },
      },
      {
        path: "retry.features.enabled",
        file: "config",
        label: "Feature retry budget",
        help: "Also bound retries per feature, not just per task.",
        type: { kind: "boolean" },
      },
      {
        path: "retry.features.maxRetries",
        file: "config",
        label: "Feature retries",
        help: "Attempts per feature when the budget above is enabled.",
        type: { kind: "number", min: 1, max: 100 },
      },
      {
        path: "retry.phases.enabled",
        file: "config",
        label: "Phase retry budget",
        help: "Also bound how many times one phase may repeat.",
        type: { kind: "boolean" },
      },
      {
        path: "retry.phases.maxRetries",
        file: "config",
        label: "Phase retries",
        help: "Attempts per phase when the budget above is enabled.",
        type: { kind: "number", min: 1, max: 100 },
      },
    ],
  },
];

export function findGroup(id: string): SettingsGroup | undefined {
  return SETTINGS.find((g) => g.id === id);
}

export function allSettings(): Setting[] {
  return SETTINGS.flatMap((g) => g.settings);
}

// ── Read / write ────────────────────────────────────────────────────────────

export type SettingsIO = {
  config: HarnessConfig;
  router: RouterConfig;
};

export function readAll(targetDir: string): SettingsIO {
  return {
    config: loadConfig(targetDir).config,
    router: loadRouterConfig(targetDir),
  };
}

export function readSetting(io: SettingsIO, setting: Setting): unknown {
  const source = setting.file === "config" ? io.config : io.router;
  return getKey(source as unknown as HarnessConfig, setting.path);
}

/**
 * Persist one setting.
 *
 * Read-modify-write under the file's lock, so a config edit made from the TUI
 * cannot clobber a concurrent write from the loop (which records gate history
 * on the same file).
 */
export function writeSetting(targetDir: string, setting: Setting, value: unknown): void {
  if (setting.file === "config") {
    withLockSync(configPath(targetDir), () => {
      const { config } = loadConfig(targetDir);
      setKey(config, setting.path, value);
      const res = saveConfig(targetDir, config);
      if (!res.ok) throw new Error(res.error ?? "could not save config");
    });
    return;
  }
  withLockSync(modelRouterPath(targetDir), () => {
    const router = loadRouterConfig(targetDir);
    setKey(router as unknown as HarnessConfig, setting.path, value);
    saveRouterConfig(targetDir, router);
  });
}

// ── Display ─────────────────────────────────────────────────────────────────

/** How a value is shown in the menu. Empty model slots read as inherited. */
export function formatValue(setting: Setting, value: unknown): string {
  switch (setting.type.kind) {
    case "boolean":
      return value ? "on" : "off";
    case "model":
      return typeof value === "string" && value.trim() ? value : "(pi's current model)";
    case "thinking":
      return typeof value === "string" && value.trim() ? value : "(inherit)";
    case "text":
      return typeof value === "string" && value.trim() ? value : "(not set)";
    case "multi":
      return Array.isArray(value) && value.length ? value.join(" → ") : "(none)";
    case "number": {
      if (typeof value !== "number") return "(not set)";
      if (setting.type.unit === "ms") return humanizeMs(value);
      return setting.type.unit ? `${value}${setting.type.unit}` : String(value);
    }
    default:
      return value === undefined || value === null ? "(not set)" : String(value);
  }
}

export function humanizeMs(ms: number): string {
  if (ms >= 3_600_000) {
    const h = ms / 3_600_000;
    return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
  }
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${ms}ms`;
}

/** Parse a duration the user typed: bare ms, or `12h` / `90m` / `30s`. */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
  if (!m) return null;
  const n = Number.parseFloat(m[1]!);
  if (!Number.isFinite(n)) return null;
  switch (m[2]) {
    case "h":
      return Math.round(n * 3_600_000);
    case "m":
      return Math.round(n * 60_000);
    case "s":
      return Math.round(n * 1000);
    default:
      return Math.round(n);
  }
}

export type ValidationResult = { ok: true; value: unknown } | { ok: false; error: string };

export const THINKING_CHOICES = ["(inherit)", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Coerce and bounds-check a raw answer for `setting`. */
export function coerce(setting: Setting, raw: string): ValidationResult {
  const t = setting.type;
  switch (t.kind) {
    case "number": {
      const n = t.unit === "ms" ? parseDuration(raw) : Number(raw.trim());
      if (n === null || !Number.isFinite(n)) {
        return { ok: false, error: t.unit === "ms" ? `not a duration: "${raw}" (try 24h, 90m, or a number of ms)` : `not a number: "${raw}"` };
      }
      if (t.min !== undefined && n < t.min) return { ok: false, error: `must be at least ${t.min}` };
      if (t.max !== undefined && n > t.max) return { ok: false, error: `must be at most ${t.max}` };
      return { ok: true, value: n };
    }
    case "thinking": {
      const v = raw.trim();
      if (!v || v === "(inherit)") return { ok: true, value: "" };
      const allowed = new Set(THINKING_CHOICES.slice(1) as readonly string[]);
      if (!allowed.has(v)) return { ok: false, error: `must be one of: ${THINKING_CHOICES.join(", ")}` };
      return { ok: true, value: v };
    }
    case "text":
    case "model": {
      const v = raw.trim();
      if (!v && t.kind === "text" && t.allowEmpty === false) return { ok: false, error: "cannot be empty" };
      // An empty model slot is meaningful: inherit pi's current model.
      return { ok: true, value: v };
    }
    case "choice": {
      const v = raw.trim();
      if (!t.choices.includes(v)) return { ok: false, error: `must be one of: ${t.choices.join(", ")}` };
      return { ok: true, value: v };
    }
    case "boolean": {
      const v = raw.trim().toLowerCase();
      if (["on", "true", "yes", "y", "1"].includes(v)) return { ok: true, value: true };
      if (["off", "false", "no", "n", "0"].includes(v)) return { ok: true, value: false };
      return { ok: false, error: `expected on or off, got "${raw}"` };
    }
    case "multi": {
      const parts = raw
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const bad = parts.filter((p) => !t.choices.includes(p));
      if (bad.length) return { ok: false, error: `not valid: ${bad.join(", ")}` };
      // Keep canonical order regardless of what order they were typed in —
      // the pipeline is an ordered sequence, not a set.
      const ordered = t.choices.filter((c) => parts.includes(c));
      return { ok: true, value: ordered as Phase[] };
    }
  }
}
