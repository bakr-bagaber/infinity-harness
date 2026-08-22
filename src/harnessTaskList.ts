/**
 * harnessTaskList — atomic task list with omission deletion, baseRevision, cycle/missing dep, in_progress checks
 * Adapted from @99percentpeople/pi-todo atomic logic (MIT) re-pointed to harness/features/feature-list.json
 *
 * Pure logic operates on flat HarnessState {revision, tasks}; file helpers convert to/from feature-list.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

// ── Types ───────────────────────────────────────────────────────────────────
export type TaskStatus = "pending" | "in_progress" | "complete" | "completed" | "blocked" | "rework" | "done" | "closed" | "passed";

export interface InputSubtask {
  title: string;
  status: string;
}

export interface HarnessTaskInput {
  key: string;
  subject?: string;
  description?: string;
  status?: string;
  dependsOn?: string[];
  subtasks?: InputSubtask[];
}

export interface HarnessTask {
  key: string;
  subject: string; // canonical subject (maps to description in file)
  description?: string; // alias kept for file compat, same as subject
  status: string; // normalized: pending | in_progress | complete | blocked
  dependsOn: string[];
  subtasks: InputSubtask[];
}

export interface HarnessState {
  revision: number;
  tasks: HarnessTask[];
}

export interface AtomicResult {
  revision: number;
  tasks: HarnessTask[];
  change: {
    added: string[];
    updated: string[];
    removed: string[];
    reordered: boolean;
  };
}

export class ValidationError extends Error {
  override name = "ValidationError";
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

// ── Validation helpers ──────────────────────────────────────────────────────
const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const KEY_WITH_SLASH_RE = /^[a-z0-9][a-z0-9._\-\/]{0,79}$/; // allow slash for featureId/taskId

function validateKeyPart(part: string, path: string): string {
  const trimmed = part.trim();
  if (!KEY_RE.test(trimmed)) {
    throw new ValidationError(`${path} must be 1-40 lowercase ASCII letters, numbers, dots, underscores, or hyphens (got \"${part}\")`);
  }
  return trimmed;
}

export function validateKey(key: string, path: string): string {
  const trimmed = key.trim();
  if (!trimmed) throw new ValidationError(`${path} must be non-empty`);
  // Allow featureId/taskId composite with slash
  if (trimmed.includes("/")) {
    const parts = trimmed.split("/");
    if (parts.length !== 2) throw new ValidationError(`${path} composite key must be featureId/taskId, got \"${key}\"`);
    const [feat, task] = parts;
    validateKeyPart(feat, `${path} (feature part)`);
    validateKeyPart(task, `${path} (task part)`);
    return `${feat}/${task}`;
  }
  if (!KEY_RE.test(trimmed)) {
    throw new ValidationError(`${path} must be 1-40 lowercase ASCII letters, numbers, dots, underscores, or hyphens (got \"${key}\")`);
  }
  return trimmed;
}

function normalizeStatus(s: string): string {
  const v = s.trim();
  if (v === "completed" || v === "done" || v === "closed" || v === "passed") return "complete";
  if (v === "in_progress" || v === "in-progress") return "in_progress";
  return v;
}

const VALID_STATUSES = new Set(["pending", "in_progress", "complete", "blocked", "rework"]);

function validateStatus(status: string, path: string): string {
  const norm = normalizeStatus(status);
  if (!VALID_STATUSES.has(norm)) {
    throw new ValidationError(`${path} is invalid: ${String(status)} (expected pending|in_progress|complete|blocked|rework)`);
  }
  return norm;
}

function trimOrUndef(s?: string): string | undefined {
  if (s === undefined || s === null) return undefined;
  const t = s.trim();
  return t ? t : undefined;
}

// Validate full task after inheritance
function validateTask(task: HarnessTask, index: number): HarnessTask {
  const p = `tasks[${index}]`;
  const key = validateKey(task.key, `${p}.key`);
  const subject = task.subject.trim();
  if (!subject) throw new ValidationError(`${p}.subject is required`);
  if (subject.length > 160) throw new ValidationError(`${p}.subject must be at most 160 characters`);
  const desc = trimOrUndef(task.description);
  if (desc && desc.length > 2000) throw new ValidationError(`${p}.description must be at most 2000 characters`);
  const status = validateStatus(task.status, `${p}.status`);
  const dependsOn = task.dependsOn ?? [];
  if (dependsOn.length > 20) throw new ValidationError(`${p}.dependsOn supports at most 20 keys`);
  // dedupe and trim dependsOn, validate each key
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const dep of dependsOn) {
    const d = dep.trim();
    if (!d) throw new ValidationError(`${p}.dependsOn cannot contain an empty key`);
    const vk = validateKey(d, `${p}.dependsOn`);
    if (!seen.has(vk)) {
      seen.add(vk);
      deduped.push(vk);
    }
  }
  // subtasks validation: title non-empty, status valid
  const subtasks = (task.subtasks ?? []).map((st, si) => {
    const title = st.title?.trim();
    if (!title) throw new ValidationError(`${p}.subtasks[${si}].title is required`);
    const stStatus = normalizeStatus(st.status ?? "pending");
    if (!["pending", "in_progress", "complete"].includes(stStatus)) {
      throw new ValidationError(`${p}.subtasks[${si}].status invalid: ${st.status}`);
    }
    return { title, status: stStatus };
  });

  return {
    key,
    subject,
    ...(desc ? { description: desc } : {}),
    status,
    dependsOn: deduped,
    subtasks,
  };
}

// ── Dependency checks ───────────────────────────────────────────────────────
export function detectCycle(tasks: HarnessTask[]): void {
  const map = new Map(tasks.map((t) => [t.key, t.dependsOn ?? []]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const dfs = (key: string) => {
    if (visiting.has(key)) throw new ValidationError(`dependency cycle detected at ${key}`);
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dep of map.get(key) ?? []) {
      dfs(dep);
    }
    visiting.delete(key);
    visited.add(key);
  };

  for (const key of map.keys()) dfs(key);
}

export function validateDeps(tasks: HarnessTask[]): void {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    for (const dep of t.dependsOn) {
      if (!byKey.has(dep)) {
        throw new ValidationError(`tasks[${i}].dependsOn references missing task ${dep}`);
      }
    }
    // in_progress or complete requires deps completed
    if (t.status === "in_progress" || t.status === "complete") {
      const unresolved = (t.dependsOn ?? []).filter((d) => byKey.get(d)?.status !== "complete");
      if (unresolved.length > 0) {
        throw new ValidationError(`tasks[${i}] cannot be ${t.status} while dependencies are unresolved: ${unresolved.join(", ")}`);
      }
    }
  }
}

// ── Atomic apply ────────────────────────────────────────────────────────────
function cloneTask(t: HarnessTask): HarnessTask {
  return {
    key: t.key,
    subject: t.subject,
    ...(t.description ? { description: t.description } : {}),
    status: t.status,
    dependsOn: [...t.dependsOn],
    subtasks: t.subtasks.map((s) => ({ ...s })),
  };
}

function tasksEqual(a: HarnessTask, b: HarnessTask): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Atomic apply: validates input against current state, returns new state or throws ValidationError.
 * Mirrors pi-todo `a` function semantics adapted for harness.
 */
export function atomicApply(
  current: HarnessState,
  input: { baseRevision?: number; tasks: HarnessTaskInput[] },
): AtomicResult {
  // baseRevision check
  if (input.baseRevision !== undefined && input.baseRevision !== current.revision) {
    throw new ValidationError(`stale baseRevision: expected ${input.baseRevision}, current revision is ${current.revision}`);
  }
  if (input.tasks.length > 50) {
    throw new ValidationError("tasks supports at most 50 items");
  }

  const currentMap = new Map(current.tasks.map((t) => [t.key, t]));
  const nextTasks: HarnessTask[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < input.tasks.length; i++) {
    const raw = input.tasks[i];
    const key = validateKey(raw.key, `tasks[${i}].key`);
    if (seen.has(key)) throw new ValidationError(`tasks[${i}].key is duplicated: ${key}`);
    seen.add(key);

    const existing = currentMap.get(key);
    // inherit subject/description: prefer raw.subject ?? raw.description ?? existing?.subject
    const subject = raw.subject ?? raw.description ?? existing?.subject;
    if (subject === undefined) {
      throw new ValidationError(`tasks[${i}].subject is required for new task ${key}`);
    }
    const statusRaw = raw.status ?? existing?.status;
    if (statusRaw === undefined) {
      throw new ValidationError(`tasks[${i}].status is required for new task ${key}`);
    }

    // dependsOn: if explicitly provided (even []), use it; otherwise inherit
    let dependsOn: string[] | undefined;
    if (raw.dependsOn !== undefined) {
      dependsOn = raw.dependsOn;
    } else if (existing?.dependsOn) {
      dependsOn = [...existing.dependsOn];
    } else {
      dependsOn = [];
    }

    // subtasks similarly
    let subtasks: InputSubtask[] | undefined;
    if (raw.subtasks !== undefined) {
      subtasks = raw.subtasks;
    } else if (existing?.subtasks) {
      subtasks = existing.subtasks.map((s) => ({ ...s }));
    } else {
      subtasks = [];
    }

    const description = raw.description ?? existing?.description;

    const candidate: HarnessTask = {
      key,
      subject: subject.trim(),
      ...(description ? { description: description.trim() } : {}),
      status: statusRaw,
      dependsOn: dependsOn ?? [],
      subtasks: subtasks ?? [],
    };

    const validated = validateTask(candidate, i);
    nextTasks.push(validated);
  }

  // Omission = deletion: find current tasks not in input
  const removedKeys = current.tasks.filter((t) => !seen.has(t.key)).map((t) => t.key);
  const removedMap = new Map(current.tasks.filter((t) => removedKeys.includes(t.key)).map((t) => [t.key, t]));

  // Prune completed→completed soft refs when target is deleted and completed
  // (matches pi-todo: completed task's dependsOn that points to deleted completed task is auto-pruned)
  const pruned = nextTasks.map((t) => {
    if (t.status !== "complete" || !t.dependsOn.length) return t;
    const filtered = t.dependsOn.filter((dep) => {
      const removed = removedMap.get(dep);
      if (!removed) return true; // not removed, keep
      // if removed task was completed, prune the edge; otherwise keep (will be caught as missing)
      return removed.status !== "complete";
    });
    if (filtered.length === t.dependsOn.length) return t;
    return { ...t, dependsOn: filtered };
  });

  // Validate deps and cycles
  // Use pruned list for checks
  validateDeps(pruned);
  detectCycle(pruned);

  // Compute change
  const added: string[] = [];
  const updated: string[] = [];
  const cloned = pruned.map((t) => {
    const existing = currentMap.get(t.key);
    const clonedTask = cloneTask(t);
    if (!existing) added.push(t.key);
    else if (!tasksEqual(existing, clonedTask)) updated.push(t.key);
    return clonedTask;
  });

  const oldOrder = current.tasks.map((t) => t.key);
  const newOrder = cloned.map((t) => t.key);
  const reordered = oldOrder.length !== newOrder.length || oldOrder.some((k, i) => k !== newOrder[i]);

  const hasChange = added.length > 0 || updated.length > 0 || removedKeys.length > 0 || reordered;
  const newRevision = hasChange ? current.revision + 1 : current.revision;

  return {
    revision: newRevision,
    tasks: cloned,
    change: {
      added,
      updated,
      removed: removedKeys,
      reordered,
    },
  };
}

// ── File helpers ─────────────────────────────────────────────────────────────
export interface FileFeatureList {
  version: string;
  baseRevision: number;
  goals?: any[];
  sprints?: any[];
  features: Array<{
    id: string;
    name: string;
    description?: string;
    passes?: boolean;
    sprintId?: string;
    goalId?: string;
    tasks: Array<{
      id: string;
      key?: string;
      description: string;
      status: string;
      dependsOn?: string[];
      subtasks?: Array<{ id: string; title: string; status: string }>;
      acceptanceCriteria?: string[];
      producedByRole?: string | null;
    }>;
    definitionOfDone?: string[];
    producedByRole?: string | null;
    coversCriteria?: number[];
  }>;
  [k: string]: any;
}

export function harnessStateFromFile(data: FileFeatureList): HarnessState {
  const revision = typeof data.baseRevision === "number" ? data.baseRevision : 0;
  const flat: HarnessTask[] = [];
  for (const feat of data.features ?? []) {
    for (const task of feat.tasks ?? []) {
      // key may be task.key or fallback to task.id; if composite handling needed, use key as is
      const key = task.key ?? task.id;
      flat.push({
        key,
        subject: task.description,
        description: task.description,
        status: task.status,
        dependsOn: task.dependsOn ?? [],
        subtasks: (task.subtasks ?? []).map((st) => ({ title: st.title, status: st.status })),
      });
    }
  }
  return { revision, tasks: flat };
}

export function fileFromHarnessState(
  original: FileFeatureList,
  state: HarnessState,
): FileFeatureList {
  // Clone original to preserve goals/sprints/etc.
  const out: FileFeatureList = JSON.parse(JSON.stringify(original));
  out.baseRevision = state.revision;
  // Distribute tasks back to features
  // Simple: if single feature, all tasks go there; if multiple, route by key prefix featureId/taskKey
  const featureMap = new Map(out.features.map((f) => [f.id, f]));
  // Clear existing tasks
  for (const f of out.features) f.tasks = [];

  if (out.features.length === 0) {
    out.features.push({
      id: "feature-001",
      name: "Feature 1",
      passes: false,
      tasks: [],
    });
  }

  // If only one feature, assign all tasks there
  if (out.features.length === 1) {
    const feat = out.features[0];
    feat.tasks = state.tasks.map((t, idx) => {
      // preserve subtask ids if possible, generate new if missing
      const subtasks = t.subtasks.map((st, si) => ({
        id: `st-${idx}-${si}`,
        title: st.title,
        status: st.status,
      }));
      // key may contain slash; extract task part for id if needed
      const keyParts = t.key.split("/");
      const bareKey = keyParts.length === 2 ? keyParts[1] : t.key;
      const featId = keyParts.length === 2 ? keyParts[0] : feat.id;
      // If key had explicit feature prefix different from single feature, keep key as is for roundtrip
      // but id is bare
      return {
        id: bareKey,
        key: t.key,
        description: t.subject,
        status: t.status,
        dependsOn: t.dependsOn,
        subtasks,
      };
    });
    // If we had composite keys with different featureIds but only one feature exists, we still store key composite
    // but tasks live in the single feature — that's okay for now
  } else {
    // Multiple features: route by composite key prefix
    for (let idx = 0; idx < state.tasks.length; idx++) {
      const t = state.tasks[idx];
      let featId: string;
      let bareKey: string;
      if (t.key.includes("/")) {
        const parts = t.key.split("/");
        featId = parts[0];
        bareKey = parts[1];
      } else {
        featId = out.features[0].id;
        bareKey = t.key;
      }
      let feat = featureMap.get(featId);
      if (!feat) {
        // create feature on fly if missing
        feat = {
          id: featId,
          name: featId,
          passes: false,
          tasks: [],
        };
        out.features.push(feat);
        featureMap.set(featId, feat);
      }
      const subtasks = t.subtasks.map((st, si) => ({
        id: `st-${idx}-${si}`,
        title: st.title,
        status: st.status,
      }));
      feat.tasks.push({
        id: bareKey,
        key: t.key,
        description: t.subject,
        status: t.status,
        dependsOn: t.dependsOn,
        subtasks,
      });
    }
  }

  return out;
}

// Load from disk (targetDir is project root containing harness/features/feature-list.json)
export function loadHarnessState(targetDir: string): { state: HarnessState; file: FileFeatureList; path: string } {
  const p = resolve(targetDir, "harness", "features", "feature-list.json");
  if (!existsSync(p)) {
    const empty: FileFeatureList = {
      version: "0.1",
      baseRevision: 0,
      features: [
        { id: "feature-001", name: "Feature 1", passes: false, tasks: [] },
      ],
    };
    return { state: { revision: 0, tasks: [] }, file: empty, path: p };
  }
  const raw = readFileSync(p, "utf-8");
  const parsed = JSON.parse(raw) as FileFeatureList;
  const state = harnessStateFromFile(parsed);
  return { state, file: parsed, path: p };
}

// Atomic save with temp file + rename (concurrency safe best-effort; proper-lockfile used by extension)
export function saveHarnessState(targetDir: string, state: HarnessState): { revision: number } {
  const { file, path: p } = loadHarnessState(targetDir);
  const nextFile = fileFromHarnessState(file, state);
  // ensure revision matches state.revision
  nextFile.baseRevision = state.revision;
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(nextFile, null, 2) + "\n", "utf-8");
  renameSync(tmp, p);
  return { revision: state.revision };
}

// High-level file-atomic apply: loads current file state, validates, writes if success, throws ValidationError otherwise
export function applyToFile(
  targetDir: string,
  input: { baseRevision?: number; tasks: HarnessTaskInput[] },
): AtomicResult {
  const { state, file } = loadHarnessState(targetDir);
  const result = atomicApply(state, input);
  // Only write if revision changed or tasks changed (atomicApply already decides)
  // But we must write file with new revision/tasks via fileFromHarnessState
  const newFile = fileFromHarnessState(file, { revision: result.revision, tasks: result.tasks });
  // Preserve baseRevision from result
  newFile.baseRevision = result.revision;
  const p = resolve(targetDir, "harness", "features", "feature-list.json");
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(newFile, null, 2) + "\n", "utf-8");
  renameSync(tmp, p);
  return result;
}

// Helper for widget / extension: get current tasks with details for toolResult
export function toToolDetails(result: AtomicResult): { rev: number; tasks: HarnessTask[] } {
  return { rev: result.revision, tasks: result.tasks.map(cloneTask) };
}

// For testing: create state directly
export function makeState(revision: number, tasks: HarnessTask[]): HarnessState {
  return { revision, tasks: tasks.map(cloneTask) };
}
