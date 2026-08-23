/**
 * infinity-harness — harness/config.json load, save, and mutation helpers.
 *
 * The config is the pipeline's control state: which phase, which feature/task,
 * how many retries are burnt, and what the gate history looks like. It is
 * read on nearly every call, so it is deliberately cheap to load and always
 * deep-merged over defaults — an older config missing new keys still works.
 */

import type { HarnessConfig, GateHistoryEntry, Phase, Role } from "./types.ts";
import { DEFAULT_ENABLED_PHASES } from "./types.ts";
import { configPath } from "./paths.ts";
import { readJson, writeJsonAtomic, backupOnce, fileExists } from "./fsx.ts";

export const DEFAULT_MAX_RETRIES = 10;
export const DEFAULT_FEATURE_RETRIES = 2;
export const DEFAULT_PHASE_RETRIES = 2;
export const COVERAGE_THRESHOLD_DEFAULT = 80;

/** Cap on gateHistory length. Unbounded growth is a real problem on multi-day runs. */
export const GATE_HISTORY_LIMIT = 500;

export function defaultConfig(): HarnessConfig {
  return {
    version: "2.0",
    stack: null,
    mode: "copilot",
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
    retry: {
      tasks: { enabled: true, maxRetries: null },
      features: { enabled: false, maxRetries: DEFAULT_FEATURE_RETRIES },
      phases: { enabled: false, maxRetries: DEFAULT_PHASE_RETRIES },
    },
    maxRetries: DEFAULT_MAX_RETRIES,
    retryCount: 0,
    taskRetryCount: 0,
    featureRetryCount: 0,
    phaseRetryCount: 0,
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
    return { ok: true, config: deepMerge(defaultConfig(), raw), error: null, seeded: false };
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
  config.gateHistory.push(entry);
  trimGateHistory(config);
}

// ── Retry budgets ───────────────────────────────────────────────────────────

export type EffectiveRetry = {
  tasks: { enabled: boolean; max: number };
  features: { enabled: boolean; max: number };
  phases: { enabled: boolean; max: number };
};

/** Resolve retry budgets, seeding task retries from the legacy `maxRetries`. */
export function getRetryConfig(config: HarnessConfig): EffectiveRetry {
  const legacy = typeof config.maxRetries === "number" ? config.maxRetries : DEFAULT_MAX_RETRIES;
  const r = config.retry ?? defaultConfig().retry;
  return {
    tasks: { enabled: r.tasks?.enabled ?? true, max: r.tasks?.maxRetries ?? legacy },
    features: { enabled: r.features?.enabled ?? false, max: r.features?.maxRetries ?? DEFAULT_FEATURE_RETRIES },
    phases: { enabled: r.phases?.enabled ?? false, max: r.phases?.maxRetries ?? DEFAULT_PHASE_RETRIES },
  };
}

export function resetTaskRetry(config: HarnessConfig): void {
  config.taskRetryCount = 0;
}
export function incrementTaskRetry(config: HarnessConfig): number {
  config.taskRetryCount = (config.taskRetryCount ?? 0) + 1;
  return config.taskRetryCount;
}
export function resetFeatureRetry(config: HarnessConfig): void {
  config.featureRetryCount = 0;
}
export function incrementFeatureRetry(config: HarnessConfig): number {
  config.featureRetryCount = (config.featureRetryCount ?? 0) + 1;
  return config.featureRetryCount;
}
export function resetPhaseRetry(config: HarnessConfig): void {
  config.phaseRetryCount = 0;
  config.retryCount = 0;
}
export function incrementPhaseRetry(config: HarnessConfig): number {
  config.phaseRetryCount = (config.phaseRetryCount ?? 0) + 1;
  config.retryCount = (config.retryCount ?? 0) + 1;
  return config.phaseRetryCount;
}

/** True when any *enabled* retry budget is exhausted — the signal to escalate. */
export function isRetryExhausted(config: HarnessConfig): { exhausted: boolean; which: string | null } {
  const r = getRetryConfig(config);
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

export function currentRoleFor(phase: Phase | null): Role | null {
  if (!phase) return null;
  const map: Record<Phase, Role> = {
    init: "planner",
    define: "planner",
    plan: "planner",
    build: "generator",
    verify: "evaluator",
    simplify: "simplifier",
    review: "evaluator",
    ship: "evaluator",
  };
  return map[phase] ?? null;
}
