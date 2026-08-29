/**
 * infinity-harness — daemon/budget.ts
 *
 * Per-tier token+cost accounting. Uses pi's UsageTotals shape.
 * - `byTier` holds cumulative per-tier spend (one UsageTotals per A/B/C/D/X).
 * - `cap` is the budget ceiling (costUsd / totalTokens / wallClockMs).
 * - The X-leak tripwire: X tokens outside a consultation worker are a defect.
 *
 * pi reports usage cumulatively per session (last message_end usage IS the
 * session total, not a delta). So per-session we keep the MAX, and per-tier
 * we sum finished sessions' totals via addUsageToTotals semantics.
 */

import type { UsageTotals, Budget, RunState } from "../core/runState.ts";
import type { TierId } from "../core/types.ts";
import { createUsageTotals } from "../core/runState.ts";

export type Tier = TierId;

export type Caps = { costUsd?: number | null; totalTokens?: number | null; wallClockMs?: number | null };

export type BudgetState = Budget; // alias for the RunState's budget shape

export function emptyBudget(): Budget {
  return { byTier: {}, cap: {}, stopOnExhaustion: true };
}

export function addUsageForTier(budget: Budget, tier: Tier, usage: Partial<UsageTotals> & { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number; calls?: number }): void {
  const byTier = (budget.byTier ??= {});
  const cur: UsageTotals = byTier[tier] ?? createUsageTotals();
  cur.input += usage.input ?? 0;
  cur.output += usage.output ?? 0;
  cur.cacheRead += usage.cacheRead ?? 0;
  cur.cacheWrite += usage.cacheWrite ?? 0;
  cur.cost += usage.cost ?? 0;
  cur.calls += usage.calls ?? 1;
  byTier[tier] = cur;
}

export function totalTokens(budget: Budget): number {
  let n = 0;
  for (const u of Object.values(budget.byTier ?? {})) n += (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  return n;
}

export function totalCost(budget: Budget): number {
  let c = 0;
  for (const u of Object.values(budget.byTier ?? {})) c += u.cost ?? 0;
  return c;
}

export function isCapExceeded(budget: Budget): { exceeded: boolean; reason: string | null } {
  const cap = budget.cap ?? {};
  const tokens = totalTokens(budget);
  const cost = totalCost(budget);
  if (typeof cap.totalTokens === "number" && cap.totalTokens > 0 && tokens >= cap.totalTokens) return { exceeded: true, reason: `token cap ${cap.totalTokens} exceeded (${tokens})` };
  if (typeof cap.costUsd === "number" && cap.costUsd > 0 && cost >= cap.costUsd) return { exceeded: true, reason: `cost cap $${cap.costUsd} exceeded ($${cost.toFixed(2)})` };
  return { exceeded: false, reason: null };
}

/**
 * X-leak tripwire. True when X has accrued cost/tokens while no consultation
 * worker is alive. The Daemon treats this as a hard stop with reason.
 */
export function hasXLeak(budget: Budget, hasConsultationWorker: boolean): boolean {
  if (hasConsultationWorker) return false;
  const x = (budget.byTier as Record<string, UsageTotals | undefined>)["X"];
  if (!x) return false;
  return (x.cost ?? 0) > 0 || (x.input ?? 0) + (x.output ?? 0) > 0 || (x.calls ?? 0) > 0;
}

export function xLeakReason(budget: Budget): string {
  const x = (budget.byTier as Record<string, UsageTotals | undefined>)["X"];
  const cost = x?.cost ?? 0;
  const tokens = (x?.input ?? 0) + (x?.output ?? 0);
  return `X accrued ${tokens} tokens ($${cost.toFixed(2)}) with no consultation worker — routing leak`;
}

export function budgetFromRunState(runState: RunState | null): Budget {
  if (!runState?.budget) return emptyBudget();
  return runState.budget;
}

export function budgetSummary(budget: Budget): string {
  const parts: string[] = [];
  for (const tier of ["A","B","C","D","X"] as Tier[]) {
    const u = (budget.byTier as Record<string, UsageTotals | undefined>)[tier];
    if (!u || (!u.calls && !u.cost && !u.input && !u.output)) continue;
    parts.push(`${tier}:${u.input}+${u.output} $${(u.cost ?? 0).toFixed(2)} ×${u.calls}`);
  }
  const cap = budget.cap ?? {};
  const capStr = [cap.totalTokens ? `tokens ${cap.totalTokens}` : null, cap.costUsd ? `$${cap.costUsd}` : null].filter(Boolean).join(" / ");
  return parts.length ? `${parts.join(" | ")}${capStr ? ` — cap ${capStr}` : ""}` : (capStr ? `cap ${capStr}` : "no spend yet");
}
