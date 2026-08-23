/**
 * infinity-harness — the atomic plan editor.
 *
 * The agent edits the plan by submitting the *whole* task list. That sounds
 * wasteful until you watch a model try to do incremental edits over a long
 * run: it loses track of what exists, re-adds deleted tasks, and drifts from
 * the file. Submitting the full list makes every write self-correcting, and
 * makes omission mean deletion — a single unambiguous rule.
 *
 * Three invariants hold on every write:
 *
 *   1. `baseRevision` must match, or the write is rejected. Two workers
 *      cannot silently clobber each other during a parallel run.
 *   2. Unknown fields on a stored task survive. An update merges onto the
 *      task on disk rather than replacing it, so `difficulty`, `modelHint`,
 *      `criteria` and anything a later version adds are never dropped.
 *   3. The dependency graph stays acyclic and every reference resolves.
 */

import type { FeatureList, Task, TaskStatus, Subtask } from "./core/types.ts";
import { ValidationError } from "./core/types.ts";
import {
  MAX_TASKS,
  MAX_DEPENDS_ON,
  MAX_SUBJECT_LEN,
  MAX_DESCRIPTION_LEN,
  detectCycle,
  flattenTasks,
  loadFeatureList,
  normalizeStatus,
  normalizeSubtaskStatus,
  saveFeatureList,
  validateKey,
  type FlatTask,
} from "./core/featureList.ts";
import { featureListPath } from "./core/paths.ts";
import { withLockSync } from "./core/lock.ts";

/** One task as submitted by the agent. Only `key` is mandatory. */
export type TaskInput = {
  key: string;
  subject?: string;
  description?: string;
  status?: string;
  dependsOn?: string[];
  subtasks?: Array<{ title: string; status?: string }>;
  difficulty?: string;
  modelHint?: string;
  criteria?: string[];
};

/**
 * Feature metadata, supplied alongside the tasks.
 *
 * Features themselves are derived from task keys — `feature-002/task-004`
 * creates `feature-002` — which left no way at all to give a feature a name or
 * its acceptance criteria. The DEFINE gate requires criteria on every feature,
 * so the first gate in the pipeline could not be passed through the tools: the
 * only route was hand-editing the plan file, which the brief tells you not to
 * do.
 *
 * Unlike `tasks`, this is a merge and never a deletion. Omission means
 * deletion for tasks because the model has to submit the authoritative list;
 * features are not submitted at all, they are inferred, so omitting one here
 * means "nothing to say about it", not "remove it".
 */
export type FeatureInput = {
  id: string;
  name?: string;
  description?: string;
  criteria?: string[];
};

export type ApplyInput = {
  baseRevision?: number;
  /**
   * The complete, authoritative task list. Omission means deletion — one
   * unambiguous rule beats incremental edits a model loses track of.
   *
   * Leaving the whole field out is different from sending `[]`: absent means
   * "I am not touching the tasks", empty means "delete them all". DEFINE needs
   * that distinction, because criteria are written there and tasks do not
   * exist until PLAN.
   */
  tasks?: TaskInput[];
  /** Names and acceptance criteria, merged onto features by id. */
  features?: FeatureInput[];
  /** The one-line statement of what this whole run is for. */
  goal?: string;
};

export type Change = {
  added: string[];
  updated: string[];
  removed: string[];
  reordered: boolean;
};

export type ApplyResult = {
  revision: number;
  list: FeatureList;
  tasks: FlatTask[];
  change: Change;
  /** False when the submission was a no-op; the revision did not move. */
  changed: boolean;
};

const DEFAULT_FEATURE_ID = "feature-001";

function splitKey(key: string): { featureId: string | null; taskId: string } {
  const i = key.indexOf("/");
  if (i === -1) return { featureId: null, taskId: key };
  return { featureId: key.slice(0, i), taskId: key.slice(i + 1) };
}

function validateSubtasks(raw: TaskInput["subtasks"], path: string): Subtask[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((st, i) => {
    const title = String(st?.title ?? "").trim();
    if (!title) throw new ValidationError(`${path}.subtasks[${i}].title is required`);
    if (title.length > MAX_SUBJECT_LEN) {
      throw new ValidationError(`${path}.subtasks[${i}].title exceeds ${MAX_SUBJECT_LEN} characters`);
    }
    let status: Subtask["status"];
    try {
      status = normalizeSubtaskStatus(st?.status ?? "pending");
    } catch {
      throw new ValidationError(`${path}.subtasks[${i}].status is invalid: ${String(st?.status)}`);
    }
    return { id: `${path.replace(/\W+/g, "-")}-st${i}`, title, status };
  });
}

/** At most this many features may be described in one submission. */
const MAX_FEATURES = 100;
/** And this many acceptance criteria on any one of them. */
const MAX_CRITERIA = 40;

function bounded(value: string, max: number, path: string): string {
  const trimmed = String(value ?? "").trim();
  if (trimmed.length > max) {
    throw new ValidationError(`${path} exceeds ${max} characters (${trimmed.length})`);
  }
  return trimmed;
}

function validateCriteria(raw: unknown, path: string): string[] {
  if (!Array.isArray(raw)) throw new ValidationError(`${path} must be an array`);
  if (raw.length > MAX_CRITERIA) {
    throw new ValidationError(`${path} supports at most ${MAX_CRITERIA} entries, got ${raw.length}`);
  }
  const out: string[] = [];
  for (const [i, entry] of raw.entries()) {
    const text = bounded(String(entry ?? ""), MAX_SUBJECT_LEN, `${path}[${i}]`);
    // An empty criterion is worse than none: it looks like the work was done.
    if (!text) throw new ValidationError(`${path}[${i}] must be non-empty`);
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

function validateDependsOn(raw: string[] | undefined, path: string): string[] {
  if (!Array.isArray(raw)) return [];
  if (raw.length > MAX_DEPENDS_ON) {
    throw new ValidationError(`${path}.dependsOn supports at most ${MAX_DEPENDS_ON} entries`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dep of raw) {
    const k = validateKey(String(dep ?? ""), `${path}.dependsOn`);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

/**
 * Apply a full task list to the plan on disk.
 *
 * Pure with respect to the filesystem: it takes the current list and returns
 * the next one. `writeTaskList` is what persists it.
 */
export function applyTaskList(current: FeatureList, input: ApplyInput): ApplyResult {
  if (input.baseRevision !== undefined && input.baseRevision !== current.baseRevision) {
    throw new ValidationError(
      `stale baseRevision: you sent ${input.baseRevision}, the plan is at ${current.baseRevision}. ` +
        `Re-read the plan and resubmit.`,
    );
  }
  if (input.tasks !== undefined && !Array.isArray(input.tasks)) {
    throw new ValidationError("tasks must be an array");
  }
  if (input.tasks === undefined && input.features === undefined && input.goal === undefined) {
    throw new ValidationError("nothing submitted: send tasks, features, or a goal");
  }
  const inputFeatures = input.features;
  const goal = input.goal;
  if (inputFeatures !== undefined && !Array.isArray(inputFeatures)) {
    throw new ValidationError("features must be an array");
  }
  if (Array.isArray(inputFeatures) && inputFeatures.length > MAX_FEATURES) {
    throw new ValidationError(
      `features supports at most ${MAX_FEATURES} items, got ${inputFeatures.length}`,
    );
  }
  if ((input.tasks?.length ?? 0) > MAX_TASKS) {
    throw new ValidationError(`tasks supports at most ${MAX_TASKS} items, got ${input.tasks!.length}`);
  }

  const before = flattenTasks(current);
  const storedByKey = new Map<string, FlatTask>();
  for (const t of before) {
    storedByKey.set(t.compositeKey, t);
    storedByKey.set(t.id, t);
    if (t.key) storedByKey.set(t.key, t);
  }

  // -- validate and merge each submitted task ------------------------------
  type Staged = { featureId: string; task: Task; compositeKey: string };
  const staged: Staged[] = [];
  const seen = new Set<string>();

  // No `tasks` field means the submission is about features or the goal, and
  // the task list carries over untouched. Re-staging what is already stored
  // keeps every downstream step — dependency validation, the rebuild, the
  // diff — on exactly one code path.
  if (input.tasks === undefined) {
    for (const f of current.features) {
      for (const t of f.tasks ?? []) {
        staged.push({
          featureId: f.id,
          task: structuredClone(t),
          compositeKey: t.key ?? `${f.id}/${t.id}`,
        });
      }
    }
  }

  for (let i = 0; i < (input.tasks?.length ?? 0); i++) {
    const raw = input.tasks![i]!;
    const path = `tasks[${i}]`;
    const key = validateKey(String(raw?.key ?? ""), `${path}.key`);
    if (seen.has(key)) throw new ValidationError(`${path}.key is duplicated: ${key}`);
    seen.add(key);

    const existing = storedByKey.get(key);
    const { featureId: keyFeature, taskId } = splitKey(key);
    const featureId = keyFeature ?? existing?.featureId ?? current.features[0]?.id ?? DEFAULT_FEATURE_ID;

    const subject = raw.subject ?? raw.description ?? existing?.description;
    if (subject === undefined) {
      throw new ValidationError(`${path}.subject is required for new task ${key}`);
    }
    const description = String(subject).trim();
    if (!description) throw new ValidationError(`${path}.subject must not be empty`);
    if (description.length > MAX_DESCRIPTION_LEN) {
      throw new ValidationError(`${path}.subject exceeds ${MAX_DESCRIPTION_LEN} characters`);
    }

    const statusRaw = raw.status ?? existing?.status;
    if (statusRaw === undefined) {
      throw new ValidationError(`${path}.status is required for new task ${key}`);
    }
    let status: TaskStatus;
    try {
      status = normalizeStatus(statusRaw);
    } catch {
      throw new ValidationError(`${path}.status is invalid: ${String(statusRaw)}`);
    }

    const dependsOn =
      raw.dependsOn !== undefined ? validateDependsOn(raw.dependsOn, path) : [...(existing?.dependsOn ?? [])];

    const subtasks =
      raw.subtasks !== undefined
        ? validateSubtasks(raw.subtasks, path)
        : (existing?.subtasks ?? []).map((s) => ({ ...s }));

    // Merge onto the stored task so unknown fields survive. `index`,
    // `compositeKey`, `featureId` and `featureName` are view-only additions
    // from flattenTasks and must not be persisted.
    const base: Record<string, unknown> = existing ? { ...existing } : {};
    delete base.index;
    delete base.compositeKey;
    delete base.featureId;
    delete base.featureName;

    const task: Task = {
      ...(base as Partial<Task>),
      id: taskId,
      key,
      description,
      status,
      dependsOn,
      subtasks,
    } as Task;

    if (raw.difficulty !== undefined) task.difficulty = raw.difficulty as Task["difficulty"];
    if (raw.modelHint !== undefined) task.modelHint = raw.modelHint;
    if (raw.criteria !== undefined) task.criteria = raw.criteria;

    staged.push({ featureId, task, compositeKey: key });
  }

  // -- dependency integrity -------------------------------------------------
  const stagedKeys = new Set<string>();
  for (const s of staged) {
    stagedKeys.add(s.compositeKey);
    stagedKeys.add(s.task.id);
  }

  const removedKeys = before.filter((t) => !stagedKeys.has(t.compositeKey) && !stagedKeys.has(t.id));
  const removedComplete = new Set(
    removedKeys.filter((t) => t.status === "complete").flatMap((t) => [t.compositeKey, t.id]),
  );

  for (const s of staged) {
    // A dependency on a task that was deleted *because it was finished* is
    // satisfied, not dangling — drop it rather than failing the write.
    s.task.dependsOn = (s.task.dependsOn ?? []).filter((d) => !removedComplete.has(d));
  }

  for (let i = 0; i < staged.length; i++) {
    const s = staged[i]!;
    for (const dep of s.task.dependsOn ?? []) {
      if (!stagedKeys.has(dep)) {
        throw new ValidationError(`tasks[${i}].dependsOn references unknown task "${dep}"`);
      }
    }
  }

  detectCycle(staged.map((s) => ({ compositeKey: s.compositeKey, dependsOn: s.task.dependsOn })));

  const statusByKey = new Map<string, TaskStatus>();
  for (const s of staged) {
    statusByKey.set(s.compositeKey, s.task.status);
    statusByKey.set(s.task.id, s.task.status);
  }
  for (let i = 0; i < staged.length; i++) {
    const s = staged[i]!;
    if (s.task.status !== "in_progress" && s.task.status !== "complete") continue;
    const unmet = (s.task.dependsOn ?? []).filter((d) => statusByKey.get(d) !== "complete");
    if (unmet.length > 0) {
      throw new ValidationError(
        `tasks[${i}] (${s.compositeKey}) cannot be "${s.task.status}" while these are incomplete: ${unmet.join(", ")}`,
      );
    }
  }

  // -- rebuild the list, preserving feature metadata ------------------------
  const next: FeatureList = structuredClone(current);
  const featureById = new Map(next.features.map((f) => [f.id, f]));
  for (const f of next.features) f.tasks = [];

  for (const s of staged) {
    let feature = featureById.get(s.featureId);
    if (!feature) {
      feature = { id: s.featureId, name: s.featureId, passes: false, tasks: [] };
      next.features.push(feature);
      featureById.set(s.featureId, feature);
    }
    feature.tasks.push(s.task);
  }

  // -- feature metadata -----------------------------------------------------
  let metaChanged = false;
  for (const [i, input] of (Array.isArray(inputFeatures) ? inputFeatures : []).entries()) {
    const id = validateKey(input?.id ?? "", `features[${i}].id`);
    // A model that has seen the plan file will reasonably try to nest tasks
    // inside a feature. Silently dropping them would look like the write
    // succeeded and lose the work; say where they go instead.
    if ("tasks" in (input as object)) {
      throw new ValidationError(
        `features[${i}].tasks is not accepted — submit tasks in the top-level "tasks" array, ` +
          `keyed "${id}/task-001". features carries names and criteria only.`,
      );
    }
    let feature = featureById.get(id);
    if (!feature) {
      // Declaring a feature before its tasks exist is legitimate: DEFINE is
      // where criteria are written, and PLAN is where tasks arrive.
      feature = { id, name: id, passes: false, tasks: [] };
      next.features.push(feature);
      featureById.set(id, feature);
      metaChanged = true;
    }
    if (typeof input.name === "string" && input.name.trim()) {
      const name = bounded(input.name, MAX_SUBJECT_LEN, `features[${i}].name`);
      if (feature.name !== name) {
        feature.name = name;
        metaChanged = true;
      }
    }
    if (typeof input.description === "string") {
      const description = bounded(input.description, MAX_SUBJECT_LEN, `features[${i}].description`);
      if (feature.description !== description) {
        feature.description = description;
        metaChanged = true;
      }
    }
    if (Array.isArray(input.criteria)) {
      const criteria = validateCriteria(input.criteria, `features[${i}].criteria`);
      if (JSON.stringify(feature.criteria ?? []) !== JSON.stringify(criteria)) {
        feature.criteria = criteria;
        metaChanged = true;
      }
    }
  }

  if (typeof goal === "string" && goal.trim()) {
    const title = bounded(goal, MAX_SUBJECT_LEN, "goal");
    const goals = Array.isArray(next.goals) ? next.goals : [];
    if (goals[0]?.title !== title) {
      next.goals = [{ ...(goals[0] ?? { id: "goal-001" }), title }, ...goals.slice(1)];
      metaChanged = true;
    }
  }

  // A feature passes when it has tasks and all of them are complete.
  for (const f of next.features) {
    f.passes = f.tasks.length > 0 && f.tasks.every((t) => t.status === "complete");
  }

  // -- diff -----------------------------------------------------------------
  const added: string[] = [];
  const updated: string[] = [];
  for (const s of staged) {
    const prev = storedByKey.get(s.compositeKey);
    if (!prev) {
      added.push(s.compositeKey);
      continue;
    }
    const prevComparable = stripView(prev);
    if (JSON.stringify(prevComparable) !== JSON.stringify(s.task)) updated.push(s.compositeKey);
  }
  const removed = removedKeys.map((t) => t.compositeKey);
  const oldOrder = before.map((t) => t.compositeKey);
  const newOrder = staged.map((s) => s.compositeKey);
  const reordered =
    oldOrder.length !== newOrder.length || oldOrder.some((k, i) => k !== newOrder[i]);

  const changed =
    added.length > 0 || updated.length > 0 || removed.length > 0 || reordered || metaChanged;
  next.baseRevision = changed ? current.baseRevision + 1 : current.baseRevision;

  return {
    revision: next.baseRevision,
    list: next,
    tasks: flattenTasks(next),
    change: { added, updated, removed, reordered },
    changed,
  };
}

function stripView(t: FlatTask): Task {
  const copy: Record<string, unknown> = { ...t };
  delete copy.index;
  delete copy.compositeKey;
  delete copy.featureId;
  delete copy.featureName;
  return copy as Task;
}

/**
 * Read the plan, apply the submission, and persist it — as one atomic section.
 *
 * The lock is not optional and not an optimisation. Read, check `baseRevision`,
 * write is a classic check-then-act: two processes that both read revision N
 * both pass the check and both write N+1, and one set of edits is gone. The
 * revision guard catches a stale *read*; only mutual exclusion serialises the
 * whole sequence.
 *
 * Fails closed. If the lock cannot be taken the write is refused with a
 * `LockTimeoutError` the caller can retry, rather than racing and silently
 * losing an edit.
 */
export function writeTaskList(targetDir: string, input: ApplyInput): ApplyResult {
  return withLockSync(featureListPath(targetDir), () => {
    const { list } = loadFeatureList(targetDir);
    const result = applyTaskList(list, input);
    if (result.changed) saveFeatureList(targetDir, result.list);
    return result;
  });
}

/** One-line summary of a write, for the tool result the model reads back. */
export function summarizeApply(result: ApplyResult): string {
  if (result.tasks.length === 0) return `Plan cleared (revision ${result.revision}).`;
  const { added, updated, removed, reordered } = result.change;
  const bits: string[] = [];
  if (added.length) bits.push(`+${added.length}`);
  if (updated.length) bits.push(`~${updated.length}`);
  if (removed.length) bits.push(`-${removed.length}`);
  if (reordered) bits.push("reordered");
  const diff = bits.length ? ` (${bits.join(" ")})` : " (no change)";
  const rows = result.tasks
    .map((t) => `${t.index}. [${t.status}] ${t.compositeKey}: ${t.description}`)
    .join("\n");
  return `Plan revision ${result.revision}${diff}\n${rows}`;
}
