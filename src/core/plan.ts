/**
 * infinity-harness — plan.ts (canonical) — re-export / wrapper around featureList.ts.
 *
 * v3 canonical path is `harness/plan.json`. The module `featureList.ts` already
 * implements the canonical load/save with legacy fallback and stub handling;
 * this file is the name the architecture calls "plan.ts" — one file, one name,
 * matching the 5-level hierarchy.
 *
 * Keeping `featureList.ts` as the real implementation avoids churning every
 * import in one commit; this shim means `import { loadPlan } from "./plan.ts"`
 * and `import { loadFeatureList } from "./featureList.ts"` both work and
 * point at the same truth.
 */

export {
  emptyFeatureList,
  validateKey,
  normalizeStatus,
  normalizeSubtaskStatus,
  isDone,
  resolvePlanFile,
  loadFeatureList,
  loadFeatureList as loadPlan,
  saveFeatureList,
  saveFeatureList as savePlan,
  flattenTasks,
  findTask,
  findFeature,
  tasksForPhase,
  featuresForPhase,
  computeProgress,
  nextActionableTask,
  detectCycle,
  MAX_TASKS,
  MAX_DEPENDS_ON,
  MAX_SUBJECT_LEN,
  MAX_DESCRIPTION_LEN,
} from "./featureList.ts";
export type { LoadedFeatureList, FlatTask, Progress } from "./featureList.ts";
