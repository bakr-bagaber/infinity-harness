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

export type ApplyInput = {
  baseRevision?: number;
  tasks: TaskInput[];
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
  if (!Array.isArray(input.tasks)) {
    throw new ValidationError("tasks must be an array");
  }
  if (input.tasks.length > MAX_TASKS) {
    throw new ValidationError(`tasks supports at most ${MAX_TASKS} items, got ${input.tasks.length}`);
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

  for (let i = 0; i < input.tasks.length; i++) {
    const raw = input.tasks[i]!;
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

  const changed = added.length > 0 || updated.length > 0 || removed.length > 0 || reordered;
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

/** Read the plan, apply the submission, and persist it if anything changed. */
export function writeTaskList(targetDir: string, input: ApplyInput): ApplyResult {
  const { list } = loadFeatureList(targetDir);
  const result = applyTaskList(list, input);
  if (result.changed) saveFeatureList(targetDir, result.list);
  return result;
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
