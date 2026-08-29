/**
 * infinity-harness — harness/config.json load, save, and mutation helpers.
 *
 * The config is the pipeline's control state: which phase, which feature/task,
 * how many retries are burnt, and what the gate history looks like. It is
 * read on nearly every call, so it is deliberately cheap to load and always
 * deep-merged over defaults — an older config missing new keys still works.
 */

import type { HarnessConfig, GateHistoryEntry, Phase, Role } from "./types.ts";
import { DEFAULT_ENABLED_PHASES, PHASE_ROLE } from "./types.ts";
import { defaultDisplay, normalizeDisplay } from "../ui/display.ts";
import { configPath } from "./paths.ts";
import { readJson, writeJsonAtomic, backupOnce, fileExists } from "./fsx.ts";

export const DEFAULT_MAX_RETRIES = 10;
export const DEFAULT_FEATURE_RETRIES = 2;
export const DEFAULT_PHASE_RETRIES = 2;
export const COVERAGE_THRESHOLD_DEFAULT = 80;

export type PilotMode = "copilot" | "autopilot" | "full";
export const PILOT_MODES: readonly PilotMode[] = ["copilot", "autopilot", "full"] as const;

export const DEFAULT_LIMITS = {
  unitWallClockMs: 30 * 60 * 1000,
  maxRecycles: 2,
  maxReworkPerUnit: 2,
  maxReplansPerPhase: 3,
  tokenCap: null as number | null,
  costCap: null as number | null,
};

function normalizeTiers(raw: unknown): Record<string, { provider: string; id: string; thinkingLevel?: string }> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, { provider: string; id: string; thinkingLevel?: string }> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!["A","B","C","D","X"].includes(k)) continue;
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const vv = v as Record<string, unknown>;
    if (typeof vv.provider !== "string" || typeof vv.id !== "string") continue;
    out[k] = { provider: String(vv.provider), id: String(vv.id), ...(typeof vv.thinkingLevel === "string" ? { thinkingLevel: vv.thinkingLevel } : {}) };
  }
  return out;
}

function migrateModelRouterTiers(targetDir: string, tiers: Record<string, unknown>): Record<string, { provider: string; id: string }> {
  // One-time migration from harness/model-router.json "byDifficulty" strings.
  // "anthropic/claude-x" → {provider:"anthropic", id:"claude-x"}
  try {
    const p = `${targetDir}/harness/model-router.json`;
    // Lazy import to avoid circular dep.
    const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs");
    if (!existsSync(p)) return tiers as Record<string, { provider: string; id: string }>;
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    const bd: Record<string, string> = raw?.byDifficulty ?? {};
    const labels: Record<string, string> = { easy: "B", moderate: "C", difficult: "D" };
    for (const [diff, label] of Object.entries(labels)) {
      const v = bd[diff];
      if (typeof v === "string" && v.trim() && !tiers[label]) {
        const parts = v.split("/");
        if (parts.length >= 2) {
          const id = parts.slice(1).join("/");
          tiers[label] = { provider: parts[0]!, id };
        } else {
          tiers[label] = { provider: "anthropic", id: v.trim() };
        }
      }
    }
    if (typeof raw.master === "string" && raw.master.trim() && !tiers.X) {
      const v = raw.master as string;
      const parts = v.split("/");
      tiers.X = parts.length >= 2 ? { provider: parts[0]!, id: parts.slice(1).join("/") } : { provider: "anthropic", id: v.trim() };
    }
  } catch { /* ignore */ }
  return tiers as Record<string, { provider: string; id: string }>;
}

/** Cap on gateHistory length. Unbounded growth is a real problem on multi-day runs. */
export const GATE_HISTORY_LIMIT = 500;

export function defaultConfig(): HarnessConfig {
  return {
    version: "2.0",
    stack: null,
    mode: "copilot",
    pilot: "autopilot" as PilotMode,
    tiers: {},
    limits: { ...DEFAULT_LIMITS },
    currentPhase: null,
    currentRole: null,
    currentFeature: null,
    currentTask: null,
    paused: false,
    features: { remaining: 0, passing: 0, total: 0 },
    gates: {
      enabled: true,
      checks: ["all"],
      coverage: { enabled: false, threshold: COVERAGE_THRESHOLD_DEFAULT },
      cleanState: { enabled: false, stalePatterns: [], startupCmd: null },
      antiPlaceholder: { enabled: true, patterns: [] },
    },
    commands: { lint: null, test: null, coverage: null, build: null },
    git: {
      autoCommit: false,
      autoTag: false,
      branch: null,
      clean: true,
      hasUpstream: false,
      lastCommitMessage: null,
    },
    phases: { enabled: [...DEFAULT_ENABLED_PHASES] },
    roles: { strict: false },
    researchDepth: "deep" as import("./types.ts").ResearchDepth,
    session: { handoff: "task", contextThreshold: 0.6, carryNotes: true },
    execution: { engine: "background", parallelAt: "task", maxWorkers: 3, isolation: "worktree" as const },
    approvals: { research: false, define: false, plan: false },
    phaseModes: Object.fromEntries(DEFAULT_ENABLED_PHASES.map((p) => [p, "autopilot"])),
    workflow: { id: "autopilot", name: "autopilot" },
    display: defaultDisplay(),
    intake: { completed: false, brief: null, at: null },
    awaitingApproval: null,
    loop: {
      maxIterations: 2000,
      maxWallClockMs: 24 * 60 * 60 * 1000,
      noProgressLimit: 3,
    },
    retry: {
      tasks: { enabled: true, maxRetries: null },
      features: { enabled: false, maxRetries: DEFAULT_FEATURE_RETRIES },
      phases: { enabled: false, maxRetries: DEFAULT_PHASE_RETRIES },
      levels: {
        goal: { enabled: false, maxRetries: 2 },
        phase: { enabled: false, maxRetries: DEFAULT_PHASE_RETRIES },
        sprint: { enabled: false, maxRetries: DEFAULT_FEATURE_RETRIES },
        feature: { enabled: false, maxRetries: DEFAULT_FEATURE_RETRIES },
        task: { enabled: true, maxRetries: null },
        subtask: { enabled: false, maxRetries: 3 },
      },
    },
    maxRetries: DEFAULT_MAX_RETRIES,
    retryCount: 0,
    taskRetryCount: 0,
    featureRetryCount: 0,
    phaseRetryCount: 0,
    retryPerLevel: {},
    pipelineIteration: 0,
    gateHistory: [],
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge `partial` over `defaults`. Arrays are replaced, not merged. */
function deepMerge<T>(defaults: T, partial: unknown): T {
  if (!isPlainObject(partial)) return defaults;
  if (!isPlainObject(defaults)) return partial as T;
  const out: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
  for (const [k, v] of Object.entries(partial)) {
    const d = (defaults as Record<string, unknown>)[k];
    out[k] = isPlainObject(v) && isPlainObject(d) ? deepMerge(d, v) : v;
  }
  return out as T;
}

/**
 * Bring an older config forward on read.
 *
 * 2.3 had a three-phase `approvals` switch; 2.4 has a mode for every phase.
 * A project mid-run must not lose the approvals it was configured with just
 * because the shape moved, and nobody should have to edit JSON to upgrade.
 * The migration is read-only — it takes effect on the next save like any other
 * change — so a downgrade still finds the old field where it left it.
 */
function migrate(config: HarnessConfig, stored: Partial<HarnessConfig>): HarnessConfig {
  const out = config as Record<string, unknown>;
  const phases = Array.isArray(config.phases?.enabled) ? config.phases.enabled : [...DEFAULT_ENABLED_PHASES];

  // pilot default for v2.x configs
  if (!stored.pilot || typeof stored.pilot !== "string" || !(PILOT_MODES as readonly string[]).includes(stored.pilot as string)) {
    // v2.x closest to autopilot
    if (!("pilot" in (stored as Record<string, unknown>))) (out as Record<string, unknown>).pilot = "autopilot";
  }
  // limits defaults
  if (!stored.limits || typeof stored.limits !== "object") {
    (out as Record<string, unknown>).limits = { ...DEFAULT_LIMITS };
  } else {
    const lim = (out as Record<string, unknown>).limits as Record<string, unknown>;
    for (const k of Object.keys(DEFAULT_LIMITS)) if (!(k in lim)) (lim as Record<string, unknown>)[k] = (DEFAULT_LIMITS as Record<string, unknown>)[k];
  }
  // execution.isolation + maxWorkers default bump-down until worktrees
  const exec = (out as Record<string, unknown>).execution as Record<string, unknown>;
  if (exec) {
    if (!("isolation" in exec) || (exec.isolation !== "worktree" && exec.isolation !== "none")) exec.isolation = "worktree";
    // v3.0 sequential default: stored without execution.maxWorkers keeps default 1 (no migration needed).
    // Null op — defaults already set via deepMerge; no explicit clamp.
    // Clamp parallelAt finer than handoff
    const order = ["off","goal","phase","sprint","feature","task","subtask"];
    const handoff = (config.session as unknown as { handoff?: string })?.handoff ?? "task";
    const parallelAt = typeof exec.parallelAt === "string" ? exec.parallelAt as string : "task";
    const hIdx = order.indexOf(handoff);
    const pIdx = order.indexOf(parallelAt);
    if (pIdx !== -1 && hIdx !== -1 && pIdx > hIdx) {
      // parallelAt finer than handoff — clamp and log via console (no throw)
      exec.parallelAt = handoff;
      try { console.warn(`[config] parallelAt "${parallelAt}" finer than handoff "${handoff}" — clamped to "${handoff}".`); } catch {}
    }
    // isolation none forces maxWorkers 1
    if (exec.isolation === "none" && typeof exec.maxWorkers === "number" && exec.maxWorkers > 1) {
      exec.maxWorkers = 1;
    }
  }
  // tiers: validate + migrate from model-router.json if empty
  {
    const t = normalizeTiers((out as Record<string, unknown>).tiers);
    if (t !== undefined) (out as Record<string, unknown>).tiers = t;
    else (out as Record<string, unknown>).tiers = {};
  }

  // The signal is what the *file* had, not what the merge produced: defaults
  // supply a `phaseModes` for every phase, so a merged config always looks
  // migrated and the old approvals would be silently dropped.
  const hadModes =
    typeof stored.phaseModes === "object" &&
    stored.phaseModes !== null &&
    Object.keys(stored.phaseModes).length > 0;

  if (!hadModes) {
    const approvals = (stored.approvals ?? {}) as Record<string, unknown>;
    const next: Record<string, string> = {};
    for (const p of phases) next[p] = approvals[p] === true ? "copilot" : "autopilot";
    out.phaseModes = next;
    if (!stored.workflow) {
      const signed = phases.filter((p) => next[p] === "copilot");
      out.workflow =
        signed.length === 0
          ? { id: "autopilot", name: "autopilot" }
          : { id: "copilot", name: "copilot" };
    }
  }

  config.display = normalizeDisplay(config.display);
  // Pilot preset -> phaseModes helper: full means all autopilot; stored phaseModes still authoritative after migration.
  // We keep model-router.json migration delayed — requires targetDir. Do it in loadConfig wrapper.
  return config;
}

export function applyPilotPreset(config: HarnessConfig, pilot: PilotMode): void {
  const all = [...DEFAULT_ENABLED_PHASES, "init", "research", "simplify"] as string[];
  if (pilot === "full") {
    for (const p of all) (config.phaseModes as Record<string, unknown>)[p] = "autopilot";
  } else if (pilot === "autopilot") {
    for (const p of all) {
      if (["build","verify","simplify"].includes(p)) (config.phaseModes as Record<string, unknown>)[p] = "autopilot";
      else if (["define","plan","ship"].includes(p)) (config.phaseModes as Record<string, unknown>)[p] = "copilot";
      else if (p === "research") (config.phaseModes as Record<string, unknown>)[p] = "autopilot";
    }
  } else if (pilot === "copilot") {
    for (const p of all) (config.phaseModes as Record<string, unknown>)[p] = "copilot";
  }
}

export type LoadResult = {
  ok: boolean;
  config: HarnessConfig;
  error: string | null;
  /** True when no config file existed and defaults were synthesised. */
  seeded: boolean;
};

/**
 * Load config, merged over defaults.
 *
 * A missing file yields defaults with `ok:false` (the project is not
 * initialised). A corrupt file yields defaults with an error — never a throw,
 * because every lifecycle hook calls this and a crash there kills the session.
 */
export function loadConfig(targetDir: string): LoadResult {
  const path = configPath(targetDir);
  if (!fileExists(path)) {
    return { ok: false, config: defaultConfig(), error: "no harness/config.json", seeded: true };
  }
  try {
    const raw = readJson<Partial<HarnessConfig>>(path);
    if (raw === null) {
      return { ok: false, config: defaultConfig(), error: "harness/config.json is empty", seeded: true };
    }
    return { ok: true, config: migrate(deepMerge(defaultConfig(), raw), raw), error: null, seeded: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, config: defaultConfig(), error: msg, seeded: false };
  }
}

export function saveConfig(targetDir: string, config: HarnessConfig): { ok: boolean; error: string | null } {
  const path = configPath(targetDir);
  try {
    trimGateHistory(config);
    backupOnce(path);
    writeJsonAtomic(path, config);
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function isHarnessProject(targetDir: string): boolean {
  return fileExists(configPath(targetDir));
}

// ── Gate history ────────────────────────────────────────────────────────────

export function trimGateHistory(config: HarnessConfig): void {
  if (!Array.isArray(config.gateHistory)) {
    config.gateHistory = [];
    return;
  }
  if (config.gateHistory.length > GATE_HISTORY_LIMIT) {
    config.gateHistory = config.gateHistory.slice(-GATE_HISTORY_LIMIT);
  }
}

export function recordGate(
  config: HarnessConfig,
  phase: string,
  result: "pass" | "fail",
  scope?: { feature?: string; task?: string },
): void {
  if (!Array.isArray(config.gateHistory)) config.gateHistory = [];
  const entry: GateHistoryEntry = {
    phase,
    result,
    timestamp: new Date().toISOString(),
    ...(scope?.feature ? { feature: scope.feature } : {}),
    ...(scope?.task ? { task: scope.task } : {}),
  };

  // Two callers record the same *pass*: `runChecks` when the gate is run, and
  // `transitionPhase` when that verdict lets the pipeline leave the phase. The
  // history read `research:pass → research:pass → define:pass → define:pass`,
  // which reads as a phase that had to be attempted twice — the opposite of
  // what happened. The same pass is not two passes.
  //
  // Repeated *failures* are never collapsed: five failures on one phase is
  // exactly the fact a human comes back to read.
  const last = config.gateHistory[config.gateHistory.length - 1];
  const duplicatePass =
    result === "pass" &&
    last !== undefined &&
    last.phase === entry.phase &&
    last.result === "pass" &&
    (last.feature ?? null) === (entry.feature ?? null) &&
    (last.task ?? null) === (entry.task ?? null);
  if (duplicatePass) return;

  config.gateHistory.push(entry);
  trimGateHistory(config);
}

// ── Retry budgets ───────────────────────────────────────────────────────────

export type EffectiveRetry = {
  tasks: { enabled: boolean; max: number };
  features: { enabled: boolean; max: number };
  phases: { enabled: boolean; max: number };
  levels: Record<string, { enabled: boolean; max: number }>;
};

const LEVEL_DEFAULTS: Record<string, number> = {
  goal: 2,
  phase: DEFAULT_PHASE_RETRIES,
  sprint: DEFAULT_FEATURE_RETRIES,
  feature: DEFAULT_FEATURE_RETRIES,
  task: DEFAULT_MAX_RETRIES,
  subtask: 3,
};

/** Resolve retry budgets, seeding task retries from the legacy `maxRetries`. */
export function getRetryConfig(config: HarnessConfig): EffectiveRetry {
  const legacy = typeof config.maxRetries === "number" ? config.maxRetries : DEFAULT_MAX_RETRIES;
  const r = (config.retry ?? defaultConfig().retry) as typeof defaultConfig.prototype.retry & { levels?: Record<string, { enabled?: boolean; maxRetries?: number | null }> };
  const levels: Record<string, { enabled: boolean; max: number }> = {};
  for (const k of ["goal","phase","sprint","feature","task","subtask"]) {
    const bucket = (r as Record<string, unknown>).levels ? ((r as Record<string, unknown>).levels as Record<string, { enabled?: boolean; maxRetries?: number | null }>)[k] : undefined;
    const defEnabled = k === "task";
    const defMax = LEVEL_DEFAULTS[k] ?? DEFAULT_MAX_RETRIES;
    const enabled = bucket ? (bucket.enabled ?? defEnabled) : defEnabled;
    const rawMax = bucket ? (bucket.maxRetries ?? null) : null;
    // Unset task level inherits legacy maxRetries
    const max = rawMax === null ? (k === "task" ? legacy : defMax) : rawMax;
    levels[k] = { enabled, max };
  }
  // Also keep legacy per-name budgets for compatibility
  return {
    tasks: { enabled: r.tasks?.enabled ?? true, max: r.tasks?.maxRetries ?? legacy },
    features: { enabled: r.features?.enabled ?? false, max: r.features?.maxRetries ?? DEFAULT_FEATURE_RETRIES },
    phases: { enabled: r.phases?.enabled ?? false, max: r.phases?.maxRetries ?? DEFAULT_PHASE_RETRIES },
    levels,
  };
}

/** Generic per-level retry counter helpers (zero on pass, escalate on exhaustion). */
export function getRetryLevel(config: HarnessConfig, level: string): number {
  const m = (config.retryPerLevel ?? {}) as Record<string, number>;
  return typeof m[level] === "number" ? m[level]! : 0;
}
export function resetRetryLevel(config: HarnessConfig, level: string): void {
  if (!config.retryPerLevel) config.retryPerLevel = {};
  (config.retryPerLevel as Record<string, number>)[level] = 0;
  // keep legacy counters in step
  if (level === "task") config.taskRetryCount = 0;
  if (level === "feature") config.featureRetryCount = 0;
  if (level === "phase") { config.phaseRetryCount = 0; config.retryCount = 0; }
}
export function incrementRetryLevel(config: HarnessConfig, level: string): number {
  if (!config.retryPerLevel) config.retryPerLevel = {};
  const m = config.retryPerLevel as Record<string, number>;
  m[level] = (m[level] ?? 0) + 1;
  if (level === "task") config.taskRetryCount = m[level]!;
  if (level === "feature") config.featureRetryCount = m[level]!;
  if (level === "phase") { config.phaseRetryCount = m[level]!; config.retryCount = m[level]!; }
  return m[level]!;
}
/** Zero all strictly lower levels than `passedLevel` on a pass (e.g. task pass zeroes subtask). */
export function zeroLowerOnPass(config: HarnessConfig, passedLevel: string): void {
  const order = ["goal","phase","sprint","feature","task","subtask"];
  const idx = order.indexOf(passedLevel);
  if (idx === -1) return;
  for (let i = idx + 1; i < order.length; i++) {
    const lower = order[i]!;
    if (getRetryLevel(config, lower) !== 0) resetRetryLevel(config, lower);
  }
}

export function resetTaskRetry(config: HarnessConfig): void {
  resetRetryLevel(config, "task");
}
export function incrementTaskRetry(config: HarnessConfig): number {
  return incrementRetryLevel(config, "task");
}
export function resetFeatureRetry(config: HarnessConfig): void {
  resetRetryLevel(config, "feature");
}
export function incrementFeatureRetry(config: HarnessConfig): number {
  return incrementRetryLevel(config, "feature");
}
export function resetPhaseRetry(config: HarnessConfig): void {
  resetRetryLevel(config, "phase");
}
export function incrementPhaseRetry(config: HarnessConfig): number {
  return incrementRetryLevel(config, "phase");
}

/** True when any *enabled* retry budget is exhausted — the signal to escalate. */
export function isRetryExhausted(config: HarnessConfig): { exhausted: boolean; which: string | null } {
  const r = getRetryConfig(config);
  // Prefer per-level levels when enabled, but retain legacy task/feature/phase order for compatibility.
  for (const lvl of ["subtask","task","feature","sprint","phase","goal"]) {
    const b = r.levels[lvl];
    if (!b) continue;
    const cnt = getRetryLevel(config as unknown as HarnessConfig, lvl);
    if (b.enabled && cnt >= b.max) return { exhausted: true, which: lvl };
  }
  if (r.tasks.enabled && (config.taskRetryCount ?? 0) >= r.tasks.max) return { exhausted: true, which: "task" };
  if (r.features.enabled && (config.featureRetryCount ?? 0) >= r.features.max) return { exhausted: true, which: "feature" };
  if (r.phases.enabled && (config.phaseRetryCount ?? 0) >= r.phases.max) return { exhausted: true, which: "phase" };
  return { exhausted: false, which: null };
}

// ── Dotted get/set (used by the `config` command surface) ────────────────────

export function getKey(config: HarnessConfig, key: string): unknown {
  let cur: unknown = config;
  for (const part of key.split(".")) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function setKey(config: HarnessConfig, key: string, value: unknown): void {
  const parts = key.split(".");
  let cur: Record<string, unknown> = config as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (!isPlainObject(cur[p])) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/** Required-field check. `currentPhase` is legitimately null before INIT. */
export function validateConfig(config: HarnessConfig): string[] {
  const required = ["version", "mode", "gates", "git", "phases", "maxRetries"];
  const missing: string[] = [];
  for (const f of required) {
    const v = (config as Record<string, unknown>)[f];
    if (v === undefined || v === null) missing.push(f);
  }
  if (!("currentPhase" in config)) missing.push("currentPhase");
  return missing;
}

/**
 * The role that owns a phase.
 *
 * This used to be a second copy of `PHASE_ROLE` written out longhand, which
 * meant adding a phase compiled fine and then silently reported the wrong
 * role for it. There is one table.
 */
export function currentRoleFor(phase: Phase | null): Role | null {
  return phase ? (PHASE_ROLE[phase] ?? null) : null;
}
