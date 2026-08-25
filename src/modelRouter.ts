/**
 * modelRouter — difficulty tiers + MASTER ladder, fresh-read each call, optional via harness/model-router.json v1
 * Priority: task.modelHint > byDifficulty[difficulty] > byFeature > bySprint > byPhase > byRole > default
 * Ladder: easy -> moderate -> difficult -> MASTER (MASTER never directly assigned)
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeJsonAtomic, stripBom } from "./core/fsx.ts";

export const ROUTER_FILE = "harness/model-router.json";
export const ROUTER_VERSION = 1;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v);
}

export interface RouterConfig {
  version: number;
  enabled: boolean;
  default: string;
  byDifficulty?: Record<string, string>;
  master?: string;
  byPhase?: Record<string, string>;
  byRole?: Record<string, string>;
  byFeature?: Record<string, string>;
  bySprint?: Record<string, string>;
  byTask?: Record<string, string>;
  consultation?: { enabled: boolean; maxPerTask: number; oneStepOnly: boolean; requireExhaustion: boolean };
  budgets?: { maxReworksPerRun: number; maxReplansPerRun: number; maxReviewBounces: number };
  /** Thinking level per tier, and for master/default. Empty means inherit pi's current level. */
  thinkingByDifficulty?: Partial<Record<string, ThinkingLevel | "">>;
  thinkingMaster?: ThinkingLevel | "";
  thinkingDefault?: ThinkingLevel | "";
}

/**
 * Router defaults.
 *
 * Every model slot is empty on purpose. An empty string means "whatever model
 * pi is already configured with", so installing the harness never silently
 * redirects work to some vendor's model that the user did not choose. Routing
 * only takes effect once someone fills in harness/model-router.json and sets
 * `enabled: true`.
 */
export const DEFAULT_ROUTER: RouterConfig = {
  version: 1,
  enabled: false,
  default: "",
  byDifficulty: {
    easy: "",
    moderate: "",
    difficult: "",
  },
  master: "",
  byPhase: {},
  byRole: {},
  byFeature: {},
  bySprint: {},
  byTask: {},
  consultation: { enabled: true, maxPerTask: 1, oneStepOnly: true, requireExhaustion: true },
  budgets: { maxReworksPerRun: 3, maxReplansPerRun: 2, maxReviewBounces: 2 },
  thinkingByDifficulty: { easy: "" as ThinkingLevel | "", moderate: "" as ThinkingLevel | "", difficult: "" as ThinkingLevel | "" } as Partial<Record<string, ThinkingLevel | "">>,
  thinkingMaster: "" as ThinkingLevel | "",
  thinkingDefault: "" as ThinkingLevel | "",
};

export const DIFFICULTY_LADDER: Array<"easy" | "moderate" | "difficult"> = ["easy", "moderate", "difficult"];

function routerPath(projectDir = process.cwd()): string { return resolve(projectDir, ROUTER_FILE); }

/**
 * Persist the router config.
 *
 * Written atomically and read fresh on every resolution, so an edit made from
 * the config TUI takes effect on the next task without restarting the session.
 */
export function saveRouterConfig(projectDir: string, cfg: RouterConfig): void {
  writeJsonAtomic(routerPath(projectDir), cfg);
}

function normalizeThinking(v: unknown): ThinkingLevel | "" {
  return typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v) ? (v as ThinkingLevel) : "";
}

export function loadRouterConfig(projectDir?: string): RouterConfig {
  const p = routerPath(projectDir);
  if (!existsSync(p)) return { ...DEFAULT_ROUTER, byDifficulty: { ...DEFAULT_ROUTER.byDifficulty! }, byPhase: {}, byRole: {}, byFeature: {}, bySprint: {}, byTask: {}, consultation: { ...DEFAULT_ROUTER.consultation! }, budgets: { ...DEFAULT_ROUTER.budgets! }, thinkingByDifficulty: { ...(DEFAULT_ROUTER.thinkingByDifficulty as Record<string, ThinkingLevel | "">) }, thinkingMaster: DEFAULT_ROUTER.thinkingMaster, thinkingDefault: DEFAULT_ROUTER.thinkingDefault };
  try {
    const raw = JSON.parse(stripBom(readFileSync(p, "utf-8")));
    // merge with defaults to ensure fields
    const cfg: RouterConfig = {
      version: typeof raw.version === "number" ? raw.version : 1,
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : false,
      default: typeof raw.default === "string" && raw.default ? raw.default : DEFAULT_ROUTER.default,
      byDifficulty: raw.byDifficulty ?? { ...DEFAULT_ROUTER.byDifficulty! },
      master: typeof raw.master === "string" ? raw.master : DEFAULT_ROUTER.master,
      byPhase: raw.byPhase ?? {},
      byRole: raw.byRole ?? {},
      byFeature: raw.byFeature ?? {},
      bySprint: raw.bySprint ?? {},
      byTask: raw.byTask ?? {},
      consultation: raw.consultation ?? { ...DEFAULT_ROUTER.consultation! },
      budgets: raw.budgets ?? { ...DEFAULT_ROUTER.budgets! },
      thinkingByDifficulty: (() => {
        const cur = raw.thinkingByDifficulty;
        if (!cur || typeof cur !== "object") return { ...(DEFAULT_ROUTER.thinkingByDifficulty as Record<string, ThinkingLevel | "">) };
        const out: Record<string, ThinkingLevel | ""> = {};
        for (const k of DIFFICULTY_LADDER) out[k] = normalizeThinking((cur as Record<string, unknown>)[k]);
        return out;
      })(),
      thinkingMaster: normalizeThinking(raw.thinkingMaster),
      thinkingDefault: normalizeThinking(raw.thinkingDefault),
    };
    if (!cfg.byDifficulty) cfg.byDifficulty = { ...DEFAULT_ROUTER.byDifficulty! };
    if (!cfg.thinkingByDifficulty) cfg.thinkingByDifficulty = { ...(DEFAULT_ROUTER.thinkingByDifficulty as Record<string, ThinkingLevel | "">) };
    return cfg;
  } catch {
    return { ...DEFAULT_ROUTER };
  }
}

export interface ResolveOpts {
  projectDir?: string;
  task?: { difficulty?: string; modelHint?: string; id?: string; key?: string };
  feature?: { id?: string; difficulty?: string };
  sprint?: { id?: string; difficulty?: string };
  phase?: string;
  role?: string;
  // direct overrides for testing
  difficulty?: string;
  modelHint?: string;
}

export function resolveModel(opts: ResolveOpts = {}): string {
  const cfg = loadRouterConfig(opts.projectDir);
  if (!cfg.enabled) return cfg.default;
  // 1. task.modelHint (explicit override)
  const hint = opts.modelHint ?? opts.task?.modelHint;
  if (hint && hint.trim()) return hint.trim();
  // 2. byTask exact key
  const taskKey = opts.task?.key ?? opts.task?.id;
  if (taskKey && cfg.byTask && cfg.byTask[taskKey]) return cfg.byTask[taskKey];
  // 3. byDifficulty[difficulty]
  const difficulty = opts.difficulty ?? opts.task?.difficulty ?? opts.feature?.difficulty ?? opts.sprint?.difficulty;
  if (difficulty && cfg.byDifficulty && (cfg.byDifficulty as Record<string, string>)[difficulty]) {
    return (cfg.byDifficulty as Record<string, string>)[difficulty];
  }
  // 4. byFeature
  const featureId = opts.feature?.id;
  if (featureId && cfg.byFeature && cfg.byFeature[featureId]) return cfg.byFeature[featureId];
  // 5. bySprint
  const sprintId = opts.sprint?.id;
  if (sprintId && cfg.bySprint && cfg.bySprint[sprintId]) return cfg.bySprint[sprintId];
  // 6. byPhase
  if (opts.phase && cfg.byPhase && cfg.byPhase[opts.phase]) return cfg.byPhase[opts.phase];
  // 7. byRole
  if (opts.role && cfg.byRole && cfg.byRole[opts.role]) return cfg.byRole[opts.role];
  return cfg.default;
}

/**
 * One-step ladder: easy -> moderate -> difficult -> MASTER
 * MASTER never assigned, only via consultNext after exhaustion.
 * Returns next model or null if at top/budget exhausted.
 */
export function consultNextWithThinking(
  currentDifficulty: string | null | undefined,
  opts: { projectDir?: string; consultedCount?: number } = {},
): { model: string | null; thinking: ThinkingLevel | "" } {
  const model = consultNext(currentDifficulty, opts);
  let thinking: ThinkingLevel | "" = "";
  if (model) {
    const idx = DIFFICULTY_LADDER.indexOf(currentDifficulty as any);
    const nextDiff = idx >= 0 && idx < DIFFICULTY_LADDER.length - 1 ? DIFFICULTY_LADDER[idx + 1] as string : (idx === DIFFICULTY_LADDER.length - 1 ? null : null);
    thinking = resolveThinkingForConsult(nextDiff, opts.projectDir) ?? "";
  }
  return { model, thinking };
}

export function consultNext(
  currentDifficulty: string | null | undefined,
  opts: { projectDir?: string; consultedCount?: number } = {},
): string | null {
  const cfg = loadRouterConfig(opts.projectDir);
  if (!cfg.consultation?.enabled) return null;
  const maxPerTask = cfg.consultation.maxPerTask ?? 1;
  if ((opts.consultedCount ?? 0) >= maxPerTask) return null;
  // oneStepOnly: only one step per call
  if (!currentDifficulty) {
    // from no difficulty -> easy? Actually consult is after exhaustion of current ladder rung
    // If no difficulty, next is byDifficulty easy, else if easy -> moderate etc.
    return null;
  }
  const idx = DIFFICULTY_LADDER.indexOf(currentDifficulty as any);
  if (idx === -1) {
    // unknown difficulty: check if current is byDifficulty value? Try to infer
    return null;
  }
  if (idx < DIFFICULTY_LADDER.length - 1) {
    const nextDiff = DIFFICULTY_LADDER[idx + 1];
    const nextModel = cfg.byDifficulty?.[nextDiff] ?? DEFAULT_ROUTER.byDifficulty![nextDiff];
    return nextModel ?? null;
  }
  // at difficult -> MASTER
  if (idx === DIFFICULTY_LADDER.length - 1) {
    return cfg.master ?? DEFAULT_ROUTER.master ?? null;
  }
  return null;
}

export function resolveThinking(opts: ResolveOpts = {}): ThinkingLevel | "" {
  const cfg = loadRouterConfig(opts.projectDir);
  // Thinking is orthogonal to routing-enabled; when disabled, fall through to default/inherit.
  const difficulty = opts.difficulty ?? opts.task?.difficulty ?? opts.feature?.difficulty ?? opts.sprint?.difficulty;
  if (difficulty && cfg.thinkingByDifficulty && (cfg.thinkingByDifficulty as Record<string, ThinkingLevel | "">)[difficulty]) {
    const v = (cfg.thinkingByDifficulty as Record<string, ThinkingLevel | "">)[difficulty];
    if (v) return v;
  }
  // Master thinking only via consultation path; here just check difficulty default fallback
  if (cfg.thinkingDefault) return cfg.thinkingDefault;
  return "";
}

export function resolveThinkingForConsult(nextDifficulty: string | null, projectDir?: string): ThinkingLevel | "" {
  const cfg = loadRouterConfig(projectDir);
  if (!nextDifficulty) return cfg.thinkingMaster ?? "";
  const v = cfg.thinkingByDifficulty?.[nextDifficulty as string] as ThinkingLevel | "" | undefined;
  if (v) return v;
  return "";
}

/** For widget/remote read-only exposure */
export function routerSummary(projectDir?: string): { enabled: boolean; default: string; byDifficulty: Record<string, string>; thinkingByDifficulty: Record<string, ThinkingLevel | "">; master: string; thinkingMaster: ThinkingLevel | ""; thinkingDefault: ThinkingLevel | ""; budgets: RouterConfig["budgets"]; consultation: RouterConfig["consultation"] } {
  const cfg = loadRouterConfig(projectDir);
  return {
    enabled: cfg.enabled,
    default: cfg.default,
    byDifficulty: { ...(cfg.byDifficulty ?? {}) } as Record<string, string>,
    thinkingByDifficulty: { ...(cfg.thinkingByDifficulty ?? {}) } as Record<string, ThinkingLevel | "">,
    master: cfg.master ?? DEFAULT_ROUTER.master!,
    thinkingMaster: (cfg.thinkingMaster ?? "") as ThinkingLevel | "",
    thinkingDefault: (cfg.thinkingDefault ?? "") as ThinkingLevel | "",
    budgets: cfg.budgets,
    consultation: cfg.consultation,
  };
}
