/**
 * infinity-harness — core/runState.ts (Core owns type + path, Daemon owns writes).
 *
 * v2.7's `src/runState.ts` had { armed, runId, startedAt, sessions, stoppedAt, stopReason }.
 * v3 extends it with: baseModel, tiers (preflight results), budget (byTier UsageTotals + caps).
 * Existing fields are kept; the file stays `harness/run.json`.
 *
 * Core owns the type, the path spelling, and the read helpers used by Interfaces.
 * Daemon owns the writes (arm, heartbeat, budget, preflight) — but the types
 * are here so Interfaces and Core can read the same truth without importing
 * the Daemon.
 */

import { runStatePath } from "./paths.ts";
import { readJsonSafe, writeJsonAtomic, removeFile } from "./fsx.ts";

export type ProviderModel = { provider: string; id: string; thinkingLevel?: string };

export type TierPreflight = { provider: string; id: string; preflight: "ok" | "fail"; servedModel?: string; reason?: string };

export type TierResults = Partial<Record<"A" | "B" | "C" | "D" | "X", TierPreflight>>;

export type UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; calls: number };

export function createUsageTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 };
}

export type Budget = {
  byTier: Partial<Record<"A" | "B" | "C" | "D" | "X", UsageTotals>>;
  cap: { totalTokens?: number | null; costUsd?: number | null; wallClockMs?: number | null };
  stopOnExhaustion?: boolean;
};

export type RunState = {
  armed: boolean;
  runId: string;
  startedAt: string;
  sessions: number;
  stoppedAt: string | null;
  stopReason: string | null;
  /** Captured from ctx.model at arm time. The detached Daemon has no ctx. */
  baseModel: ProviderModel | null;
  /** Preflight outcome per tier. A failing tier blocks arming. */
  tiers: TierResults;
  /** Per-tier spend and caps. X outside consultation is a defect signal, not a budget. */
  budget: Budget;
  wallClockMs?: number;
  escalation?: { level: string | null; since: string | null };
};

export function newRunState(runId: string, now = new Date()): RunState {
  return {
    armed: true,
    runId,
    startedAt: now.toISOString(),
    sessions: 1,
    stoppedAt: null,
    stopReason: null,
    baseModel: null,
    tiers: {},
    budget: { byTier: {}, cap: {}, stopOnExhaustion: true },
  };
}

export function loadRunState(targetDir: string): RunState | null {
  const raw = readJsonSafe<Record<string, unknown> | null>(runStatePath(targetDir), null);
  if (!raw || typeof raw.runId !== "string" || !raw.runId) return null;
  const sessions = typeof raw.sessions === "number" && (raw.sessions as number) > 0 ? (raw.sessions as number) : 1;
  // Back-compat: older file had no baseModel/tiers/budget — treat as null/empty.
  const baseModel = (() => {
    const bm = (raw as Record<string, unknown>).baseModel;
    if (!bm || typeof bm !== "object" || Array.isArray(bm)) return null;
    const b = bm as Record<string, unknown>;
    if (typeof b.provider === "string" && typeof b.id === "string") return { provider: String(b.provider), id: String(b.id), ...(typeof b.thinkingLevel === "string" ? { thinkingLevel: b.thinkingLevel } : {}) } as ProviderModel;
    // legacy: baseModel was a string "provider/id"
    if (typeof raw.baseModel === "string" && String(raw.baseModel).trim()) {
      const s = String(raw.baseModel).trim();
      const parts = s.split("/");
      if (parts.length >= 2) return { provider: parts[0]!, id: parts.slice(1).join("/") };
      return { provider: "anthropic", id: s };
    }
    return null;
  })();
  const tiersRaw = (raw as Record<string, unknown>).tiers;
  const tiers: TierResults = (tiersRaw && typeof tiersRaw === "object" && !Array.isArray(tiersRaw) ? tiersRaw : {}) as TierResults;
  const budgetRaw = (raw as Record<string, unknown>).budget;
  const budget: Budget = (budgetRaw && typeof budgetRaw === "object" && !Array.isArray(budgetRaw)
    ? budgetRaw as Budget
    : { byTier: {}, cap: {}, stopOnExhaustion: true });
  if (!budget.byTier || typeof budget.byTier !== "object") budget.byTier = {};
  if (!budget.cap || typeof budget.cap !== "object") budget.cap = {};
  return {
    armed: raw.armed === true,
    runId: raw.runId as string,
    startedAt: typeof raw.startedAt === "string" ? (raw.startedAt as string) : new Date(0).toISOString(),
    sessions,
    stoppedAt: typeof raw.stoppedAt === "string" ? (raw.stoppedAt as string) : null,
    stopReason: typeof raw.stopReason === "string" ? (raw.stopReason as string) : null,
    baseModel,
    tiers,
    budget,
    ...(typeof (raw as Record<string, unknown>).wallClockMs === "number" ? { wallClockMs: (raw as Record<string, unknown>).wallClockMs as number } : {}),
    ...(typeof (raw as Record<string, unknown>).escalation === "object" ? { escalation: (raw as Record<string, unknown>).escalation as RunState["escalation"] } : {}),
  };
}

export function saveRunState(targetDir: string, state: RunState): void {
  try { writeJsonAtomic(runStatePath(targetDir), state); } catch { /* run bookkeeping must not kill the session */ }
}

export function armRun(targetDir: string, runId: string, now = new Date()): RunState {
  const existing = loadRunState(targetDir);
  const state = existing && existing.armed ? { ...existing, stoppedAt: null, stopReason: null } : newRunState(runId, now);
  saveRunState(targetDir, state);
  return state;
}

export function disarmRun(targetDir: string, reason: string, now = new Date()): RunState | null {
  const existing = loadRunState(targetDir);
  if (!existing) return null;
  const state: RunState = { ...existing, armed: false, stoppedAt: now.toISOString(), stopReason: reason };
  saveRunState(targetDir, state);
  return state;
}

export function countSession(targetDir: string): RunState | null {
  const existing = loadRunState(targetDir);
  if (!existing) return null;
  const state = { ...existing, sessions: existing.sessions + 1 };
  saveRunState(targetDir, state);
  return state;
}

export function clearRunState(targetDir: string): void {
  try { removeFile(runStatePath(targetDir)); } catch { /* nothing to clear */ }
}

export function runIdFor(targetDir: string, fallback: string): string {
  const state = loadRunState(targetDir);
  return state && state.armed ? state.runId : fallback;
}

/** Parse a legacy baseModel string "provider/id" into a ProviderModel. */
export function parseBaseModelString(s: string | null | undefined): ProviderModel | null {
  if (!s || !String(s).trim()) return null;
  const str = String(s).trim();
  const parts = str.split("/");
  if (parts.length >= 2) return { provider: parts[0]!, id: parts.slice(1).join("/") };
  return { provider: "anthropic", id: str };
}
