// Re-export from core so both import paths work.
// Canonical type now lives in src/core/runState.ts (with baseModel/tiers/budget).
export {
  loadRunState,
  saveRunState,
  armRun,
  disarmRun,
  countSession,
  clearRunState,
  runIdFor,
  newRunState,
  parseBaseModelString,
  createUsageTotals,
} from "./core/runState.ts";
export type { RunState, ProviderModel, TierResults, TierPreflight, Budget, UsageTotals } from "./core/runState.ts";
