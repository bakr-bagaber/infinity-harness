/**
 * pi-harness: Pi-native enforcement layer for dev-harness
 * Visual 5-Level Widget + harness_task_list with atomic baseRevision and hidden checkpoint
 *
 * Adapted from @99percentpeople/pi-todo atomic logic (MIT) re-pointed to harness/features/feature-list.json
 * Reuses dev-harness CLI lib, adds Pi lifecycle enforcement, widget via ctx.ui.setWidget/setStatus,
 * compaction-safe replay via toolResult.details + custom checkpoint harness:checkpoint, periodic reminders.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import stringWidth from "string-width";

// ── dev-harness libs (dynamic to avoid hard failure) ────────────────────────
let briefLib: any = null;
let gatesLib: any = null;
let stateLib: any = null;
let phasesLib: any = null;
let pathsLib: any = null;

async function loadHarnessLibs() {
  if (briefLib) return { brief: briefLib, gates: gatesLib, state: stateLib, phases: phasesLib, paths: pathsLib };
  const cliDir = resolve(import.meta.dirname, "../../cli");
  briefLib = await import(`${cliDir}/lib/brief.mjs`);
  gatesLib = await import(`${cliDir}/lib/gates.mjs`);
  stateLib = await import(`${cliDir}/lib/state.mjs`);
  phasesLib = await import(`${cliDir}/lib/phases.mjs`);
  pathsLib = await import(`${cliDir}/lib/paths.mjs`);
  return { brief: briefLib, gates: gatesLib, state: stateLib, phases: phasesLib, paths: pathsLib };
}

function getProjectDir(ctx: any): string {
  return ctx.cwd || ctx.projectDir || process.cwd();
}

async function buildBriefText(targetDir: string): Promise<string | null> {
  try {
    const { brief } = await loadHarnessLibs();
    const b = await brief.buildBrief(targetDir);
    const rendered = brief.renderBriefHuman ? brief.renderBriefHuman(b) : JSON.stringify(b, null, 2);
    return rendered;
  } catch (e: any) {
    return `harness-enforcer: failed to build brief: ${e.message}`;
  }
}

async function isHarnessProject(targetDir: string): Promise<boolean> {
  try {
    const { paths } = await loadHarnessLibs();
    const cfgPath = paths.CONFIG_PATH(targetDir);
    return existsSync(cfgPath);
  } catch {
    return existsSync(resolve(targetDir, "harness", "config.json"));
  }
}

// ── Harness task list core (inline adapted from src/harnessTaskList.ts) ─────
const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;

class ValidationError extends Error {
  override name = "ValidationError";
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function validateKey(key: string, path: string): string {
  const trimmed = key.trim();
  if (!trimmed) throw new ValidationError(`${path} must be non-empty`);
  if (trimmed.includes("/")) {
    const parts = trimmed.split("/");
    if (parts.length !== 2) throw new ValidationError(`${path} composite key must be featureId/taskId, got "${key}"`);
    for (const part of parts) {
      if (!KEY_RE.test(part.trim())) throw new ValidationError(`${path} part "${part}" invalid`);
    }
    return trimmed;
  }
  if (!KEY_RE.test(trimmed)) throw new ValidationError(`${path} must be 1-40 lowercase ASCII letters, numbers, dots, underscores, or hyphens (got "${key}")`);
  return trimmed;
}

function normalizeStatus(s: string): string {
  const v = s.trim();
  if (v === "completed" || v === "done" || v === "closed" || v === "passed") return "complete";
  if (v === "in_progress" || v === "in-progress") return "in_progress";
  return v;
}
const VALID_STATUSES = new Set(["pending", "in_progress", "complete", "blocked"]);

function validateStatus(status: string, path: string): string {
  const norm = normalizeStatus(status);
  if (!VALID_STATUSES.has(norm)) throw new ValidationError(`${path} is invalid: ${String(status)}`);
  return norm;
}

type HarnessTask = {
  key: string;
  subject: string;
  description?: string;
  status: string;
  dependsOn: string[];
  subtasks: Array<{ title: string; status: string }>;
};

type HarnessState = {
  revision: number;
  tasks: HarnessTask[];
};

function validateTask(task: HarnessTask, index: number): HarnessTask {
  const p = `tasks[${index}]`;
  const key = validateKey(task.key, `${p}.key`);
  const subject = task.subject.trim();
  if (!subject) throw new ValidationError(`${p}.subject is required`);
  if (subject.length > 160) throw new ValidationError(`${p}.subject must be at most 160 characters`);
  const desc = task.description?.trim();
  if (desc && desc.length > 2000) throw new ValidationError(`${p}.description must be at most 2000 characters`);
  const status = validateStatus(task.status, `${p}.status`);
  const dependsOn = task.dependsOn ?? [];
  if (dependsOn.length > 20) throw new ValidationError(`${p}.dependsOn supports at most 20 keys`);
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
  const subtasks = (task.subtasks ?? []).map((st, si) => {
    const title = st.title?.trim();
    if (!title) throw new ValidationError(`${p}.subtasks[${si}].title is required`);
    const stStatus = normalizeStatus(st.status ?? "pending");
    if (!["pending", "in_progress", "complete"].includes(stStatus)) throw new ValidationError(`${p}.subtasks[${si}].status invalid: ${st.status}`);
    return { title, status: stStatus };
  });
  return { key, subject, ...(desc ? { description: desc } : {}), status, dependsOn: deduped, subtasks };
}

function detectCycle(tasks: HarnessTask[]): void {
  const map = new Map(tasks.map((t) => [t.key, t.dependsOn ?? []]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const dfs = (key: string) => {
    if (visiting.has(key)) throw new ValidationError(`dependency cycle detected at ${key}`);
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dep of map.get(key) ?? []) dfs(dep);
    visiting.delete(key);
    visited.add(key);
  };
  for (const k of map.keys()) dfs(k);
}

function validateDeps(tasks: HarnessTask[]): void {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    for (const dep of t.dependsOn) {
      if (!byKey.has(dep)) throw new ValidationError(`tasks[${i}].dependsOn references missing task ${dep}`);
    }
    if (t.status === "in_progress" || t.status === "complete") {
      const unresolved = (t.dependsOn ?? []).filter((d) => byKey.get(d)?.status !== "complete");
      if (unresolved.length > 0) throw new ValidationError(`tasks[${i}] cannot be ${t.status} while dependencies are unresolved: ${unresolved.join(", ")}`);
    }
  }
}

function cloneTask(t: HarnessTask): HarnessTask {
  return { key: t.key, subject: t.subject, ...(t.description ? { description: t.description } : {}), status: t.status, dependsOn: [...t.dependsOn], subtasks: t.subtasks.map((s) => ({ ...s })) };
}
function tasksEqual(a: HarnessTask, b: HarnessTask): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function atomicApply(current: HarnessState, input: { baseRevision?: number; tasks: Array<{ key: string; subject?: string; description?: string; status?: string; dependsOn?: string[]; subtasks?: Array<{ title: string; status: string }> }> }): { revision: number; tasks: HarnessTask[]; change: { added: string[]; updated: string[]; removed: string[]; reordered: boolean } } {
  if (input.baseRevision !== undefined && input.baseRevision !== current.revision) {
    throw new ValidationError(`stale baseRevision: expected ${input.baseRevision}, current revision is ${current.revision}`);
  }
  if (input.tasks.length > 50) throw new ValidationError("tasks supports at most 50 items");
  const currentMap = new Map(current.tasks.map((t) => [t.key, t]));
  const nextTasks: HarnessTask[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < input.tasks.length; i++) {
    const raw = input.tasks[i] as any;
    const key = validateKey(raw.key, `tasks[${i}].key`);
    if (seen.has(key)) throw new ValidationError(`tasks[${i}].key is duplicated: ${key}`);
    seen.add(key);
    const existing = currentMap.get(key);
    const subject = raw.subject ?? raw.description ?? existing?.subject;
    if (subject === undefined) throw new ValidationError(`tasks[${i}].subject is required for new task ${key}`);
    const statusRaw = raw.status ?? existing?.status;
    if (statusRaw === undefined) throw new ValidationError(`tasks[${i}].status is required for new task ${key}`);
    let dependsOn: string[] | undefined;
    if (raw.dependsOn !== undefined) dependsOn = raw.dependsOn;
    else if (existing?.dependsOn) dependsOn = [...existing.dependsOn];
    else dependsOn = [];
    let subtasks: any;
    if (raw.subtasks !== undefined) subtasks = raw.subtasks;
    else if (existing?.subtasks) subtasks = existing.subtasks.map((s: any) => ({ ...s }));
    else subtasks = [];
    const description = raw.description ?? existing?.description;
    const candidate: HarnessTask = { key, subject: String(subject).trim(), ...(description ? { description: String(description).trim() } : {}), status: String(statusRaw), dependsOn: dependsOn ?? [], subtasks: subtasks ?? [] };
    const validated = validateTask(candidate, i);
    nextTasks.push(validated);
  }
  const removedKeys = current.tasks.filter((t) => !seen.has(t.key)).map((t) => t.key);
  const removedMap = new Map(current.tasks.filter((t) => removedKeys.includes(t.key)).map((t) => [t.key, t]));
  const pruned = nextTasks.map((t) => {
    if (t.status !== "complete" || !t.dependsOn.length) return t;
    const filtered = t.dependsOn.filter((dep) => {
      const removed = removedMap.get(dep);
      if (!removed) return true;
      return removed.status !== "complete";
    });
    if (filtered.length === t.dependsOn.length) return t;
    return { ...t, dependsOn: filtered };
  });
  validateDeps(pruned);
  detectCycle(pruned);
  const added: string[] = [];
  const updated: string[] = [];
  const cloned = pruned.map((t) => {
    const existing = currentMap.get(t.key);
    const c = cloneTask(t);
    if (!existing) added.push(t.key);
    else if (!tasksEqual(existing, c)) updated.push(t.key);
    return c;
  });
  const oldOrder = current.tasks.map((t) => t.key);
  const newOrder = cloned.map((t) => t.key);
  const reordered = oldOrder.length !== newOrder.length || oldOrder.some((k, i) => k !== newOrder[i]);
  const hasChange = added.length > 0 || updated.length > 0 || removedKeys.length > 0 || reordered;
  const newRevision = hasChange ? current.revision + 1 : current.revision;
  return { revision: newRevision, tasks: cloned, change: { added, updated, removed: removedKeys, reordered } };
}

// ── File helpers ─────────────────────────────────────────────────────────────
type FileFeatureList = {
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
    tasks: Array<{ id: string; key?: string; description: string; status: string; dependsOn?: string[]; subtasks?: Array<{ id: string; title: string; status: string }> }>;
  }>;
  [k: string]: any;
};

function harnessStateFromFile(data: FileFeatureList): HarnessState {
  const revision = typeof data.baseRevision === "number" ? data.baseRevision : 0;
  const flat: HarnessTask[] = [];
  for (const feat of data.features ?? []) {
    for (const task of feat.tasks ?? []) {
      const key = task.key ?? task.id;
      flat.push({ key, subject: task.description, description: task.description, status: task.status, dependsOn: task.dependsOn ?? [], subtasks: (task.subtasks ?? []).map((st) => ({ title: st.title, status: st.status })) });
    }
  }
  return { revision, tasks: flat };
}

function fileFromHarnessState(original: FileFeatureList, state: HarnessState): FileFeatureList {
  const out: FileFeatureList = JSON.parse(JSON.stringify(original));
  out.baseRevision = state.revision;
  for (const f of out.features) f.tasks = [];
  if (out.features.length === 0) out.features.push({ id: "feature-001", name: "Feature 1", passes: false, tasks: [] });
  if (out.features.length === 1) {
    const feat = out.features[0];
    feat.tasks = state.tasks.map((t, idx) => {
      const subtasks = t.subtasks.map((st, si) => ({ id: `st-${idx}-${si}`, title: st.title, status: st.status }));
      const keyParts = t.key.split("/");
      const bareKey = keyParts.length === 2 ? keyParts[1] : t.key;
      return { id: bareKey, key: t.key, description: t.subject, status: t.status, dependsOn: t.dependsOn, subtasks };
    });
  } else {
    const featureMap = new Map(out.features.map((f) => [f.id, f]));
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
        feat = { id: featId, name: featId, passes: false, tasks: [] };
        out.features.push(feat);
        featureMap.set(featId, feat);
      }
      const subtasks = t.subtasks.map((st, si) => ({ id: `st-${idx}-${si}`, title: st.title, status: st.status }));
      feat.tasks.push({ id: bareKey, key: t.key, description: t.subject, status: t.status, dependsOn: t.dependsOn, subtasks });
    }
  }
  return out;
}

function loadHarnessStateFromFile(targetDir: string): { state: HarnessState; file: FileFeatureList; path: string } {
  const p = resolve(targetDir, "harness", "features", "feature-list.json");
  if (!existsSync(p)) {
    const empty: FileFeatureList = { version: "0.1", baseRevision: 0, features: [{ id: "feature-001", name: "Feature 1", passes: false, tasks: [] }] };
    return { state: { revision: 0, tasks: [] }, file: empty, path: p };
  }
  const raw = readFileSync(p, "utf-8");
  const parsed = JSON.parse(raw) as FileFeatureList;
  const state = harnessStateFromFile(parsed);
  return { state, file: parsed, path: p };
}

function saveHarnessStateToFile(targetDir: string, state: HarnessState): void {
  const { file, path: p } = loadHarnessStateFromFile(targetDir);
  const nextFile = fileFromHarnessState(file, state);
  nextFile.baseRevision = state.revision;
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(nextFile, null, 2) + "\n", "utf-8");
  renameSync(tmp, p);
}

// ── Widget helpers (minimal port of src/widget.ts) ─────────────────────────
function statusIcon(status: string): string {
  switch (status) {
    case "pending":
      return "○";
    case "in_progress":
      return "◐";
    case "complete":
    case "done":
      return "●";
    case "blocked":
      return "⚠";
    case "waiting":
      return "↷";
    default:
      return "○";
  }
}

function strWidth(s: string): number {
  try {
    return stringWidth(s);
  } catch {
    return [...s].length;
  }
}

function wrapWidgetLines(text: string, width: number): string[] {
  if (width <= 0) return [text];
  if (text === "") return [""];
  if (strWidth(text) <= width) return [text];
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    const wWidth = strWidth(word);
    if (wWidth > width) {
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      let chunk = "";
      let chunkW = 0;
      for (const ch of [...word]) {
        const cw = strWidth(ch);
        if (chunkW + cw > width) {
          lines.push(chunk);
          chunk = ch;
          chunkW = cw;
        } else {
          chunk += ch;
          chunkW += cw;
        }
      }
      if (chunk) cur = chunk;
      continue;
    }
    if (!cur) cur = word;
    else if (strWidth(cur + " " + word) <= width) cur += " " + word;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

const WIDGET_LIMIT = 8;
const COMPLETED_CONTEXT = 3;

function getWidgetWindowBounds(items: Array<{ status: string }>, limit = WIDGET_LIMIT, ctx = COMPLETED_CONTEXT): { start: number; end: number } {
  const total = items.length;
  if (total <= limit) return { start: 0, end: total };
  let activeIdx = items.findIndex((it) => it.status === "in_progress");
  if (activeIdx === -1) activeIdx = items.findIndex((it) => it.status === "pending");
  if (activeIdx === -1) activeIdx = items.findIndex((it) => it.status === "blocked");
  if (activeIdx === -1) activeIdx = total - 1;
  if (activeIdx < limit - ctx) return { start: 0, end: limit };
  if (activeIdx >= total - (limit - ctx)) return { start: total - limit, end: total };
  let start = activeIdx - ctx;
  let end = start + limit;
  for (let i = start - 1; i >= Math.max(0, start - 2); i--) {
    if (items[i]?.status === "blocked") {
      if (start > 0) {
        start -= 1;
        end -= 1;
      }
      break;
    }
  }
  if (start < 0) {
    end += -start;
    start = 0;
  }
  if (end > total) {
    start -= end - total;
    end = total;
    if (start < 0) start = 0;
  }
  return { start, end };
}

function formatDeps(dependsOn: string[], keyToIndex: Map<string, number>): string {
  if (!dependsOn || dependsOn.length === 0) return "";
  const nums: string[] = [];
  for (const dep of dependsOn) {
    const idx = keyToIndex.get(dep);
    if (idx !== undefined) nums.push(`#${idx}`);
    else nums.push(`${dep}`);
  }
  return `← ${nums.join(", ")}`;
}

function buildWidgetLinesFromState(state: HarnessState, file: FileFeatureList, opts?: { width?: number }): string[] {
  const width = opts?.width ?? 80;
  const lines: string[] = [];
  const goals = file.goals ?? [];
  const sprints = file.sprints ?? [];
  const features = file.features ?? [];

  // Use file's goals/sprints for hierarchy, but tasks from state
  if (goals.length) {
    const g = goals[0] as any;
    const label = `Goal: ${g.title}${g.description ? " — " + g.description : ""}`;
    const wrapped = wrapWidgetLines(label, width - 2);
    lines.push(`▸ ${wrapped[0]}`);
    for (let i = 1; i < wrapped.length; i++) lines.push(`  ${wrapped[i]}`);
  }
  if (!features.length) {
    lines.push("Progress: 0/0");
    return lines;
  }
  // For widget we show single feature's tasks (feature-001) but also iterate features if multiple
  // We'll flatten tasks from state and group by featureId prefix if present

  // Build feature map for display
  const feat = features[0];
  // Feature level
  const fLabel = `Feature: ${feat.name}`;
  const fWrapped = wrapWidgetLines(fLabel, width - 2);
  lines.push(`▸ ${fWrapped[0]}`);
  for (let i = 1; i < fWrapped.length; i++) lines.push(`  ${fWrapped[i]}`);

  const sprint = sprints.find((s: any) => s.id === feat.sprintId) ?? sprints[0];
  if (sprint) {
    const sLabel = `Sprint: ${sprint.name}`;
    const sWrapped = wrapWidgetLines(sLabel, width - 2);
    lines.push(`▸ ${sWrapped[0]}`);
    for (let i = 1; i < sWrapped.length; i++) lines.push(`  ${sWrapped[i]}`);
  }

  const tasks = state.tasks;
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "complete").length;
  lines.push(`Progress: ${done}/${total}  Todos (${done}/${total})`);
  if (total === 0) {
    lines.push("  (no tasks)");
    return lines;
  }
  const keyToIndex = new Map<string, number>();
  tasks.forEach((t, idx) => {
    const n = idx + 1;
    keyToIndex.set(t.key, n);
    // also map bare key if composite
    if (t.key.includes("/")) {
      const bare = t.key.split("/")[1];
      keyToIndex.set(bare, n);
    }
  });
  const bounds = getWidgetWindowBounds(tasks.map((t) => ({ status: t.status })));
  const visible = tasks.slice(bounds.start, bounds.end);
  const hiddenCount = total - visible.length;
  for (const task of visible) {
    const icon = statusIcon(task.status);
    const depStr = formatDeps(task.dependsOn ?? [], keyToIndex);
    const title = task.subject;
    const base = `${icon} ${title}${depStr ? " " + depStr : ""}`;
    const wrapped = wrapWidgetLines(base, width - 2);
    lines.push(wrapped[0]);
    for (let i = 1; i < wrapped.length; i++) lines.push(`  ${wrapped[i]}`);
    const subtasks = task.subtasks ?? [];
    for (const sub of subtasks) {
      const sIcon = statusIcon(sub.status);
      const sBase = `${sIcon} ${sub.title}`;
      const sWrapped = wrapWidgetLines(sBase, width - 4);
      lines.push(`  ${sWrapped[0]}`);
      for (let i = 1; i < sWrapped.length; i++) lines.push(`    ${sWrapped[i]}`);
    }
  }
  if (hiddenCount > 0) lines.push(`+${hiddenCount} more`);
  return lines;
}

function getCurrentWidgetLines(targetDir: string): string[] {
  try {
    const { state, file } = loadHarnessStateFromFile(targetDir);
    return buildWidgetLinesFromState(state, file, { width: 80 });
  } catch {
    return ["pi-harness: no state"];
  }
}

// ── Extension state ─────────────────────────────────────────────────────────
const CHECKPOINT_TYPE = "harness:checkpoint";
const REMINDER_TYPE = "harness:reminder";

export default function (pi: ExtensionAPI) {
  // In-memory harness state (reconstructed from session branch)
  let harnessState: HarnessState = { revision: 0, tasks: [] };
  let harnessFileSnapshot: FileFeatureList | null = null;
  let pendingCheckpoint: HarnessState | null = null;
  let needsCheckpointInject = false;
  let llmCallCounter = 0;
  const REMINDER_INTERVAL = 3;

  // Remote singleton (F5) â read-only HTTP view via src/remote.ts
  let remoteServer: any = null;
  let remoteServerProjectDir: string | null = null;

  // Widget update helper
  const updateWidget = (ctx: ExtensionContext) => {
    try {
      const dir = getProjectDir(ctx);
      // Prefer in-memory state if we have it from reconstruction; else load file
      let state = harnessState;
      let file = harnessFileSnapshot;
      if (!file || state.tasks.length === 0) {
        // fallback to file
        try {
          const loaded = loadHarnessStateFromFile(dir);
          if (loaded.state.tasks.length > 0 || !state.tasks.length) {
            state = loaded.state;
            file = loaded.file;
          }
        } catch {}
      }
      if (!file) {
        file = { version: "0.1", baseRevision: state.revision, features: [{ id: "feature-001", name: "Feature 1", passes: false, tasks: [] }], goals: [], sprints: [] } as any;
      }
      const lines = buildWidgetLinesFromState(state, file, { width: 80 });
      ctx.ui.setWidget("pi-harness", lines);
      const done = state.tasks.filter((t) => t.status === "complete").length;
      const total = state.tasks.length;
      if (total === 0) ctx.ui.setStatus("harness", undefined);
      else ctx.ui.setStatus("harness", `${done}/${total} ${state.tasks.find((t)=>t.status==="in_progress") ? "◐" : done===total ? "●" : "○"}`);
    } catch {}
  };

  const reconstructState = (ctx: ExtensionContext) => {
    try {
      const branch = ctx.sessionManager.getBranch();
      let latest: HarnessState | null = null;
      let latestFile: FileFeatureList | null = null;

      for (const entry of branch as any[]) {
        // Custom checkpoint entries (harness:checkpoint)
        if (entry.type === "custom" && entry.customType === CHECKPOINT_TYPE && entry.data) {
          const data = entry.data as any;
          if (typeof data.rev === "number" && Array.isArray(data.tasks)) {
            // Validate shape minimal
            latest = { revision: data.rev, tasks: data.tasks as HarnessTask[] };
            // keep file snapshot if present in data.file? fallback
          }
          continue;
        }
        if (entry.type === "custom_message" && (entry as any).customType === CHECKPOINT_TYPE && (entry as any).details) {
          const d = (entry as any).details as any;
          if (typeof d.rev === "number" && Array.isArray(d.tasks)) {
            latest = { revision: d.rev, tasks: d.tasks as HarnessTask[] };
          }
          continue;
        }
        if (entry.type === "message") {
          const msg: any = entry.message;
          if (msg.role === "toolResult" && msg.toolName === "harness_task_list" && msg.details) {
            const det = msg.details as any;
            if (typeof det.rev === "number" && Array.isArray(det.tasks)) {
              latest = { revision: det.rev, tasks: det.tasks as HarnessTask[] };
            } else if (typeof det.revision === "number" && Array.isArray(det.tasks)) {
              latest = { revision: det.revision, tasks: det.tasks as HarnessTask[] };
            }
          }
        }
      }

      if (latest) {
        harnessState = latest;
        // try to keep file snapshot for widget hierarchy
        try {
          const dir = getProjectDir(ctx);
          const loaded = loadHarnessStateFromFile(dir);
          harnessFileSnapshot = loaded.file;
        } catch {}
      } else {
        // no session state, load from file
        try {
          const dir = getProjectDir(ctx);
          const loaded = loadHarnessStateFromFile(dir);
          harnessState = loaded.state;
          harnessFileSnapshot = loaded.file;
        } catch {}
      }
      llmCallCounter = 0;
      needsCheckpointInject = false;
      pendingCheckpoint = null;
      updateWidget(ctx);
    } catch {}
  };

  // ── session_start: reconstruct + notify ─────────────────────────────────
  pi.on("session_start", async (_event: any, ctx: any) => {
    const dir = getProjectDir(ctx);
    if (!(await isHarnessProject(dir))) return;
    reconstructState(ctx);
    ctx.ui.notify("pi-harness: enforcer active — harness_task_list + widget + checkpoint", "info");
    ctx.ui.setStatus("harness", "ready");
    try { pi.appendEntry("harness:brief", { at: "session_start", dir }); } catch {}
    updateWidget(ctx);
  });

  pi.on("session_tree", async (_event: any, ctx: any) => {
    reconstructState(ctx);
    updateWidget(ctx);
  });

  // ── context: inject hidden checkpoint and periodic reminder ────────────────
  pi.on("context", async (event: any, _ctx: any) => {
    // Only inject for harness projects
    // We need project dir - we can use process.cwd() as best effort inside context handler
    // isHarnessProject check via file existence
    const dir = process.cwd();
    let isHarness = false;
    try { isHarness = await isHarnessProject(dir); } catch { isHarness = false; }
    if (!isHarness) return;

    const messages: any[] = event.messages ?? [];
    // Filter out previous reminder injections that are customType harness:reminder to avoid accumulation? They are not persisted anyway but we filter for cleanliness
    const filtered = messages.filter((m: any) => !(m.role === "custom" && m.customType === REMINDER_TYPE) && !(m.role === "user" && Array.isArray(m.content) && m.content.some((c: any)=> c.type==="text" && c.text?.includes("Harness reminder"))));

    // Checkpoint injection takes priority
    if (needsCheckpointInject && pendingCheckpoint) {
      const state = pendingCheckpoint;
      needsCheckpointInject = false;
      pendingCheckpoint = null;
      llmCallCounter = 0;
      const hiddenText = `Harness checkpoint (revision ${state.revision}): ${state.tasks.map((t)=> `${t.key}:${t.status}`).join(", ") || "(no tasks)"}. Use harness_task_list with baseRevision ${state.revision} to update.`;
      const injected = { role: "user" as const, content: [{ type: "text" as const, text: hiddenText }], timestamp: Date.now() };
      // Also inject as custom for visibility? spec says injected via context as messages: [{role:"user", content:[{type:"text", text: hidden}]}]
      return { messages: [...filtered, injected] };
    }

    // Periodic reminder every 3 LLM calls
    const hasPending = harnessState.tasks.some((t) => t.status !== "complete");
    if (!hasPending || harnessState.tasks.length === 0) {
      llmCallCounter = 0;
      // if filtered changed, return it, else nothing
      if (filtered.length !== messages.length) return { messages: filtered };
      return;
    }

    llmCallCounter += 1;
    if (llmCallCounter < REMINDER_INTERVAL) {
      if (filtered.length !== messages.length) return { messages: filtered };
      return;
    }
    llmCallCounter = 0;
    const reminderText = `Harness reminder (revision ${harnessState.revision}; current keys/statuses): ${harnessState.tasks.map((t)=> `${t.key}=${t.status}`).join(", ")}. Before the final response, compare actual progress with this plan. If task status, order, scope, or dependencies changed, call harness_task_list with baseRevision ${harnessState.revision} and include every key to retain.`;
    const reminderMsg = { role: "user" as const, content: [{ type: "text" as const, text: reminderText }], timestamp: Date.now() };
    return { messages: [...filtered, reminderMsg] };
  });

  // ── before_agent_start: inject pending checkpoint as hidden message if context missed ─
  pi.on("before_agent_start", async () => {
    if (!needsCheckpointInject || !pendingCheckpoint) return;
    const state = pendingCheckpoint;
    needsCheckpointInject = false;
    pendingCheckpoint = null;
    llmCallCounter = 0;
    const hiddenText = `Harness checkpoint (revision ${state.revision}): ${state.tasks.map((t)=> `${t.key}:${t.status}`).join(", ") || "(no tasks)"}. Use harness_task_list with baseRevision ${state.revision} to update.`;
    return { message: { customType: CHECKPOINT_TYPE, content: hiddenText, display: false, details: { rev: state.revision, tasks: state.tasks } } } as any;
  });

  // ── session_before_compact: store hidden checkpoint ───────────────────────
  pi.on("session_before_compact", async (event: any, ctx: any) => {
    const dir = getProjectDir(ctx);
    if (!(await isHarnessProject(dir))) return;
    try {
      // Capture current harness state (prefer in-memory, else file)
      let state = harnessState;
      if (!state.tasks.length) {
        try {
          const loaded = loadHarnessStateFromFile(dir);
          state = loaded.state;
        } catch {}
      }
      // Persist as custom entry outside model context
      const checkpointData = { rev: state.revision, tasks: state.tasks, fileSnapshot: harnessFileSnapshot };
      pi.appendEntry(CHECKPOINT_TYPE, checkpointData as any);
      pendingCheckpoint = { revision: state.revision, tasks: state.tasks.map((t)=> ({...t})) };
      needsCheckpointInject = true;
      ctx.ui.notify(`pi-harness: checkpoint rev ${state.revision} stored for compaction`, "info");
    } catch (e: any) {
      ctx.ui.notify(`pi-harness checkpoint error: ${e.message}`, "error");
    }
  });

  pi.on("session_compact", async (event: any, ctx: any) => {
    const dir = getProjectDir(ctx);
    if (!(await isHarnessProject(dir))) return;
    try {
      let state = harnessState;
      if (!state.tasks.length) {
        try {
          const loaded = loadHarnessStateFromFile(dir);
          state = loaded.state;
        } catch {}
      }
      const checkpointData = { rev: state.revision, tasks: state.tasks };
      // Ensure checkpoint is stored (session_before_compact may have already done)
      try { pi.appendEntry(CHECKPOINT_TYPE, checkpointData as any); } catch {}
      pendingCheckpoint = { revision: state.revision, tasks: state.tasks.map((t)=> ({...t})) };
      // If compaction will retry immediately, inject via steer
      if (event.willRetry || ctx.hasPendingMessages?.()) {
        needsCheckpointInject = false;
        llmCallCounter = 0;
        const hiddenText = `Harness checkpoint (revision ${state.revision}): ${state.tasks.map((t)=> `${t.key}:${t.status}`).join(", ") || "(no tasks)"}.`;
        // checkpoint via appendEntry already; no sendMessage during streaming
      } else {
        needsCheckpointInject = true;
      }
      ctx.ui.notify(`pi-harness: post-compaction checkpoint rev ${state.revision}`, "info");
    } catch {}
  });

  // ── Register harness_task_list tool ─────────────────────────────────────
  pi.registerTool({
    name: "harness_task_list",
    label: "Harness Task List",
    description: "Manage harness tasks atomically with baseRevision, omission=deletion, deps and status validation. Provide complete authoritative list; omitted keys are deleted. Use baseRevision for optimistic concurrency.",
    parameters: {
      type: "object",
      properties: {
        baseRevision: { type: "integer", minimum: 0, description: "Revision shown in current harness context; rejects stale writes" },
        tasks: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            required: ["key"],
            properties: {
              key: { type: "string", description: "Stable task key, ee.g. schema-5level" },
              subject: { type: "string" },
              description: { type: "string" },
              status: { type: "string", description: "pending | in_progress | complete | blocked" },
              dependsOn: { type: "array", items: { type: "string" } },
              subtasks: { type: "array", items: { type: "object", properties: { title: { type: "string" }, status: { type: "string" } } } },
            },
          },
        },
      },
      required: ["tasks"],
    } as any,
    async execute(toolCallId, params: any, _signal, _onUpdate, ctx) {
      const dir = getProjectDir(ctx as any);
      // Load with lock
      let lockRelease: (() => Promise<void>) | null = null;
      try {
        // Acquire lock on feature-list.json if possible
        try {
          const lockfile = await import("proper-lockfile");
          const targetPath = resolve(dir, "harness", "features", "feature-list.json");
          // Ensure directory exists
          mkdirSync(dirname(targetPath), { recursive: true });
          // Touch file if not exists to allow locking
          if (!existsSync(targetPath)) {
            writeFileSync(targetPath, JSON.stringify({ version: "0.1", baseRevision: 0, features: [{ id: "feature-001", name: "F", passes: false, tasks: [] }] }, null, 2));
          }
          lockRelease = (await lockfile.lock(targetPath, { retries: 5, stale: 8000, realpath: false }) as any);
        } catch {}

        const { state: currentState, file } = loadHarnessStateFromFile(dir);
        // Merge context's in-memory state if newer? Use file as source but if in-memory revision > file, use in-memory (handles branch replay without file write)
        // For correctness, prefer file's revision for concurrency check, but if in-memory came from session replay and has higher rev, use it
        let effectiveState = currentState;
        if (harnessState.revision > currentState.revision) {
          // Session branch state is ahead (e.g., after /tree to branch with newer tasks but file not updated)
          // Use session state for validation base, but still write to file
          effectiveState = harnessState;
        }

        let result: ReturnType<typeof atomicApply>;
        try {
          result = atomicApply(effectiveState, { baseRevision: params.baseRevision, tasks: params.tasks as any });
        } catch (e: any) {
          if (e instanceof ValidationError || e.name === "ValidationError") {
            return {
              content: [{ type: "text", text: `Validation error: ${e.message}` }],
              details: { error: e.message, rev: effectiveState.revision, tasks: effectiveState.tasks },
              isError: true,
            } as any;
          }
          throw e;
        }

        // Persist to file if changed
        if (result.revision !== effectiveState.revision || result.tasks.length !== effectiveState.tasks.length || JSON.stringify(result.tasks) !== JSON.stringify(effectiveState.tasks)) {
          const newFile = fileFromHarnessState(file, { revision: result.revision, tasks: result.tasks });
          // Preserve baseRevision exactly
          newFile.baseRevision = result.revision;
          const p = resolve(dir, "harness", "features", "feature-list.json");
          const tmp = `${p}.${process.pid}.${toolCallId}.tmp`;
          writeFileSync(tmp, JSON.stringify(newFile, null, 2) + "\n", "utf-8");
          renameSync(tmp, p);
          harnessState = { revision: result.revision, tasks: result.tasks.map((t) => ({ ...t })) };
          harnessFileSnapshot = newFile;
          llmCallCounter = 0;
          // Update widget
          try { updateWidget(ctx as any); } catch {}
          // Append hidden checkpoint for next-turn consistency? pi-todo does next-turn cleanup but we just store in details
          // Optionally append custom entry for compaction resilience (periodic)
          // We don't append every write; toolResult.details is sufficient for branch replay
        } else {
          harnessState = { revision: result.revision, tasks: result.tasks.map((t) => ({ ...t })) };
          // still reset counter
          llmCallCounter = 0;
        }

        const text = result.tasks.length === 0
          ? `Harness plan cleared (revision ${result.revision}).`
          : `Harness plan revision ${result.revision}: ${result.tasks.map((t) => `[${t.status}] ${t.key}: ${t.subject}${t.dependsOn.length ? ` ← ${t.dependsOn.join(",")}` : ""}`).join(" ")}`;

        return {
          content: [{ type: "text", text }],
          details: { rev: result.revision, revision: result.revision, tasks: result.tasks, change: result.change },
        } as any;
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `harness_task_list error: ${e.message}` }],
          details: { error: e.message },
          isError: true,
        } as any;
      } finally {
        if (lockRelease) {
          try { await lockRelease(); } catch {}
        }
      }
    },
    renderCall(args: any, theme: any, _context: any) {
      // Live preview while streaming — simple text without pi-tui Text dep at compile time
      try {
        const tasks = args.tasks ?? [];
        let text = theme.fg("toolTitle", theme.bold("harness_task_list ")) + theme.fg("muted", `${tasks.length} tasks`);
        if (args.baseRevision !== undefined) text += theme.fg("dim", ` @rev ${args.baseRevision}`);
        for (const t of tasks.slice(0, 8)) {
          const icon = t.status === "complete" ? "●" : t.status === "in_progress" ? "◐" : t.status === "blocked" ? "⚠" : "○";
          text += `\n${icon} ${t.key}${t.dependsOn?.length ? ` ← ${t.dependsOn.join(",")}` : ""}`;
        }
        if (tasks.length > 8) text += `\n${theme.fg("dim", `... +${tasks.length - 8} more`)}`;
        // Use dynamic Text if available
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { Text } = require("@earendil-works/pi-tui") as any;
          return new Text(text, 0, 0);
        } catch {
          return { render: () => [text] } as any;
        }
      } catch {
        return undefined as any;
      }
    },
    renderResult(result: any, _opts: any, theme: any, _context: any) {
      try {
        const details: any = (result as any).details as any;
        if (details?.error) {
          try {
            const { Text } = require("@earendil-works/pi-tui") as any;
            return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
          } catch {
            return { render: () => [`Error: ${details.error}`] } as any;
          }
        }
        const tasks: HarnessTask[] = details?.tasks ?? [];
        if (!tasks || tasks.length === 0) {
          try {
            const { Text } = require("@earendil-works/pi-tui") as any;
            return new Text(theme.fg("muted", "No harness tasks"), 0, 0);
          } catch {
            return { render: () => ["No harness tasks"] } as any;
          }
        }
        const expanded = _opts.expanded;
        const displayTasks = expanded ? tasks : tasks.slice(0, 3);
        let out = theme.fg("muted", `${tasks.length} task(s) @rev ${details.rev ?? details.revision ?? "?"}`) + "\n";
        for (const t of displayTasks) {
          const icon = t.status === "complete" ? theme.fg("success", "●") : t.status === "in_progress" ? theme.fg("warning", "◐") : t.status === "blocked" ? theme.fg("error", "⚠") : theme.fg("dim", "○");
          const depStr = t.dependsOn?.length ? theme.fg("dim", ` ← ${t.dependsOn.join(",")}`) : "";
          const subj = t.status === "in_progress" ? theme.bold(t.subject) : theme.fg("muted", t.subject);
          out += `${icon} ${theme.fg("accent", t.key)} ${subj}${depStr}\n`;
        }
        if (!expanded && tasks.length > 3) out += theme.fg("dim", `... +${tasks.length - 3} more (Ctrl+O to expand)`);
        try {
          const { Text } = require("@earendil-works/pi-tui") as any;
          return new Text(out.trim(), 0, 0);
        } catch {
          return { render: () => out.trim().split("\n") } as any;
        }
      } catch {
        return undefined as any;
      }
    },

  });

  // ── harness_spawn_worker: isolated worker helper (F3) ─────────────────
  // Exposes src/worker.ts isolation so a BUILD task can be delegated to a
  // fresh tmp/pi-harness/<run-id>/<feature>/<task>/attempt-N/ directory
  // without polluting the main session. The enforcer stays
  // notify-only (no stream injection during turn_end); this tool spawns
  // an isolated pi --print-style worker via src/worker.ts and records
  // prompt.md / output.log / fingerprint.json with proper-lockfile on
  // harness/features/feature-list.json so concurrent workers do not corrupt
  // baseRevision. Used by dev-harness run when it writes per-task
  // tmp/pi-harness/<run-id>/ isolated prompts.
  try {
    pi.registerTool({
      name: "harness_spawn_worker",
      label: "Harness Spawn Worker",
      description: "Spawn an isolated worker for a BUILD task to tmp/pi-harness/<run-id>/<feature>/<task>/attempt-N/{prompt.md,output.log,fingerprint.json} with proper-lockfile on feature-list.json. Params: runId, featureId, taskId, prompt, command?, timeoutMs?. Writes isolated prompt and records attempt without touching main session context.",
      parameters: {
        type: "object",
        properties: {
          runId: { type: "string", description: "Run identifier, e.g. run/2026-08-21T00-00-00" },
          featureId: { type: "string", description: "Feature id, e.g. feature-003" },
          taskId: { type: "string", description: "Task id, e.g. task-005" },
          prompt: { type: "string", description: "Full prompt to execute in isolated worker" },
          command: { type: "string", description: "Optional shell command template with {promptfile} placeholder; if omitted, just records the attempt" },
          timeoutMs: { type: "integer", minimum: 1000, description: "Timeout ms for the isolated command" },
          attempt: { type: "integer", minimum: 1, description: "Explicit attempt number (auto-increments if omitted)" },
          model: { type: "string", description: "Optional model override, e.g. opencode/muse-spark-1.2-contributor-free; if omitted resolves via harness/model-router.json" },
        },
        required: ["runId", "featureId", "taskId", "prompt"],
      } as any,
      async execute(toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
        const dir = getProjectDir(ctx as any);
        try {
          const workerMod: any = await import("../../src/worker.ts");
          // Resolve model via modelRouter if not supplied (fresh read each call)
          let resolvedModel: string | undefined = typeof params.model === "string" && params.model ? params.model : undefined;
          if (!resolvedModel) {
            try {
              const routerMod: any = await import("../../src/modelRouter.ts");
              // Try to infer task difficulty/modelHint from feature-list.json
              let difficulty: string | undefined;
              let modelHint: string | undefined;
              try {
                const fs = await import("node:fs");
                const path = await import("node:path");
                const flp = path.resolve(dir, "harness", "features", "feature-list.json");
                if (fs.existsSync(flp)) {
                  const raw = JSON.parse(fs.readFileSync(flp, "utf-8"));
                  outer: for (const f of raw.features ?? []) {
                    for (const task of f.tasks ?? []) {
                      const key = (task as any).key ?? (task as any).id;
                      if (key === params.taskId || (task as any).id === params.taskId) {
                        difficulty = (task as any).difficulty;
                        modelHint = (task as any).modelHint;
                        break outer;
                      }
                    }
                  }
                }
              } catch {}
              resolvedModel = routerMod.resolveModel({ projectDir: dir, task: { id: params.taskId, key: params.taskId, difficulty, modelHint } });
            } catch {}
          }
          const res: any = await workerMod.spawnIsolatedWorker({
            projectDir: dir,
            runId: params.runId,
            featureId: params.featureId,
            taskId: params.taskId,
            prompt: params.prompt,
            command: params.command,
            timeoutMs: params.timeoutMs,
            attempt: params.attempt,
            model: resolvedModel ?? params.model,
          });
          return {
            content: [{ type: "text", text: "Isolated worker " + params.runId + "/" + params.featureId + "/" + params.taskId + " attempt-" + res.attempt + " -> " + res.attemptDir + " (exit " + res.exitCode + ")" + (res.timedOut ? " timed out" : "") }],
            details: { attemptDir: res.attemptDir, attempt: res.attempt, fingerprint: res.fingerprint, exitCode: res.exitCode, output: (res.output || "").slice(-2000) },
          } as any;
        } catch (e: any) {
          return { content: [{ type: "text", text: "harness_spawn_worker error: " + e.message }], details: { error: e.message }, isError: true } as any;
        }
      },
    });
  } catch (e: any) {
    try { console.warn("pi-harness: harness_spawn_worker not registered:", e?.message); } catch {}
  }

  // ── pi_goal_task F4: Goal Loop with GOAL_SPEC.json + Reviewer Worker ──
  {
    const registerGoalTool = (toolName: string) => {
      pi.registerTool({
        name: toolName,
        label: toolName === "pi_goal_task" ? "Pi Goal Task" : "Harness Goal Loop",
        description: "Goal loop with GOAL_SPEC.json + reviewer worker. Run is tmp/pi-harness/goals/<runId>/ (GOAL_STATE.json+trace+iterations) mirrored to harness/goals/GOAL_SPEC.json via proper-lockfile. Reviewer isolated via spawnIsolatedWorker to tmp/pi-harness/<runId>/review/attempt-N/. Delegates to src/goalLoop.ts+src/goalState.ts+src/worker.ts.",
        parameters: { type: "object", properties: { goal: { type: "string", description: "Original goal" }, goalRunId: { type: "string" }, action: { type: "string", enum: ["create","start_iteration","record_todo","record_worker","review"] }, todoPath: { type: "string" }, todoSummary: { type: "string" }, workerStatus: { type: "string", enum: ["done","partial","blocked","failed"] }, workerSummary: { type: "string" }, reviewerPrompt: { type: "string" }, reviewerCommand: { type: "string" }, reviewerDecision: { type: "string", enum: ["complete","incomplete","blocked","failed"] }, remainingWork: { type: "array", items: { type: "string" } }, cwd: { type: "string" }, timeoutMs: { type: "integer" }, spec: { type: "object" }, model: { type: "string", description: "Optional model override for reviewer worker; if omitted resolves via harness/model-router.json" } }, required: ["goal"] } as any,
        async execute(toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
          const dir = getProjectDir(ctx as any);
          const projectDir = params.cwd || dir;
          try {
            const goalLoopMod: any = await import("../../src/goalLoop.ts");
            const goalStateMod: any = await import("../../src/goalState.ts");
            const workerMod: any = await import("../../src/worker.ts");
            const goalSpecMod: any = await import("../../src/goalSpec.ts");
            const { randomUUID } = await import("node:crypto");
            const goalRunId: string = params.goalRunId || randomUUID();
            const store = new goalStateMod.GoalStateStore({ cwd: projectDir, goalRunId });
            await store.ensureRunDir();
            const action: string = params.action || "review";
            let state: any = null;
            try { state = await store.loadState(); } catch {}
            if (!state) {
              state = goalLoopMod.createGoalLoopState({ goal: params.goal, goalRunId, cwd: projectDir });
              await store.saveState(state);
              await store.appendNewTraceEvents(0, state);
              let spec: any = params.spec;
              if (!spec) spec = goalSpecMod.createGoalSpecification({ goalRunId, originalGoal: params.goal });
              await store.saveGoalSpecificationWithCanonical(spec, projectDir);
            } else if (params.spec) {
              await store.saveGoalSpecificationWithCanonical(params.spec, projectDir);
            }
            const prevTraceLen = state.trace.length;
            if (action === "create") return { content: [{ type: "text", text: `Goal loop ${goalRunId} created at ${store.paths.goalRunDir}` }], details: { goalRunId, goalRunDir: store.paths.goalRunDir, statePath: store.paths.statePath, canonical: goalStateMod.canonicalGoalSpecPath(projectDir), state } } as any;
            if (action === "start_iteration") {
              const before = state.trace.length;
              state = goalLoopMod.startGoalIteration(state, { now: new Date() });
              await store.saveState(state);
              await store.appendNewTraceEvents(before, state);
              await store.writeIterationSnapshot(state.iterations[state.iterations.length - 1]);
              return { content: [{ type: "text", text: `Iteration ${state.currentIteration} started for ${goalRunId}` }], details: { goalRunId, iteration: state.currentIteration, state } } as any;
            }
            if (action === "record_todo") {
              const it = state.currentIteration || state.iterations.length;
              state = goalLoopMod.recordGeneratedTodo(state, it, { todoPath: params.todoPath || store.paths.goalSpecPath, summary: params.todoSummary }, { now: new Date() });
              await store.saveState(state);
              await store.appendNewTraceEvents(prevTraceLen, state);
              return { content: [{ type: "text", text: `Todo recorded iteration ${it}` }], details: { goalRunId, iteration: it, state } } as any;
            }
            if (action === "record_worker") {
              const it = state.currentIteration || state.iterations.length;
              state = goalLoopMod.recordWorkerResult(state, it, { status: params.workerStatus || "done", summary: params.workerSummary || "worker done", endedAt: new Date().toISOString() } as any, { now: new Date() });
              await store.saveState(state);
              await store.appendNewTraceEvents(prevTraceLen, state);
              return { content: [{ type: "text", text: `Worker recorded iteration ${it}` }], details: { goalRunId, iteration: it, state } } as any;
            }
            if (state.currentIteration === 0 || state.iterations.length === 0) state = goalLoopMod.startGoalIteration(state, { now: new Date() });
            const curIt = state.currentIteration || state.iterations.length;
            let iter = state.iterations.find((x: any) => x.iteration === curIt);
            if (!iter) { state = goalLoopMod.startGoalIteration(state, { now: new Date() }); iter = state.iterations[state.iterations.length - 1]; }
            if (iter.status === "pending") {
              state = goalLoopMod.recordGeneratedTodo(state, iter.iteration, { todoPath: params.todoPath || store.paths.goalSpecPath, summary: params.todoSummary || "todo" }, { now: new Date() });
              iter = state.iterations.find((x: any) => x.iteration === curIt)!;
            }
            if (iter.status === "todo_generated") state = goalLoopMod.recordWorkerResult(state, iter.iteration, { status: "done", summary: "worker done", endedAt: new Date().toISOString() } as any, { now: new Date() });
            const reviewPrompt: string = params.reviewerPrompt || `Review goal "${params.goal}" run ${goalRunId} iteration ${curIt}. Decide complete|incomplete|blocked|failed. JSON {"decision":"complete"}`;
            let reviewerModel: string | undefined = typeof params.model === "string" && params.model ? params.model : undefined;
            if (!reviewerModel) {
              try {
                const routerMod2: any = await import("../../src/modelRouter.ts");
                reviewerModel = routerMod2.resolveModel({ projectDir });
              } catch {}
            }
            try {
              const goalLoopMod2: any = goalLoopMod;
              if (goalLoopMod2.resolveReviewerModel) {
                const fromHelper = goalLoopMod2.resolveReviewerModel({ projectDir });
                if (!reviewerModel || !params.model) reviewerModel = reviewerModel ?? fromHelper;
              }
            } catch {}
            const attemptRes: any = await workerMod.spawnIsolatedWorker({ projectDir, runId: goalRunId, featureId: "review", taskId: "reviewer", prompt: reviewPrompt, command: params.reviewerCommand, timeoutMs: params.timeoutMs, model: reviewerModel });
            let decision: string = params.reviewerDecision || "incomplete";
            let remainingWork: string[] = params.remainingWork || [];
            if (attemptRes.output) { try { const m = attemptRes.output.match(/\{[^]*"decision"[^]*\}/); if (m) { const p2 = JSON.parse(m[0]); if (p2.decision) decision = p2.decision; if (Array.isArray(p2.remainingWork)) remainingWork = p2.remainingWork; } } catch {} }
            const reviewerResult: any = { decision, complete: decision === "complete", summary: decision === "complete" ? "reviewer marked complete" : `reviewer marked ${decision}`, rationale: decision === "complete" ? "all done" : "needs iteration", remainingWork, reviewedAt: new Date().toISOString() };
            const beforeReview = state.trace.length;
            const targetIter = state.iterations.find((x: any) => x.iteration === curIt)?.iteration ?? curIt;
            try { state = goalLoopMod.recordReviewerResult(state, targetIter, reviewerResult, { now: new Date() }); } catch (e: any) { return { content: [{ type: "text", text: `Review already recorded ${targetIter}: ${e.message}` }], details: { goalRunId, iteration: targetIter, state, attemptDir: attemptRes.attemptDir }, isError: true } as any; }
            await store.saveState(state);
            await store.appendNewTraceEvents(beforeReview, state);
            try { const s2 = await store.tryLoadGoalSpecification(); if (s2) await store.saveCanonicalGoalSpecification(s2, projectDir); } catch {}
            await store.writeIterationSnapshot(state.iterations.find((x: any) => x.iteration === targetIter) || state.iterations[state.iterations.length - 1]);
            return { content: [{ type: "text", text: `Reviewer isolated ${attemptRes.attemptDir} -> decision ${decision} status ${state.status}` }], details: { goalRunId, iteration: targetIter, decision, remainingWork, status: state.status, phase: state.phase, attemptDir: attemptRes.attemptDir, attempt: attemptRes.attempt, fingerprint: attemptRes.fingerprint, statePath: store.paths.statePath, tracePath: store.paths.tracePath, canonical: goalStateMod.canonicalGoalSpecPath(projectDir), state } } as any;
          } catch (e: any) { return { content: [{ type: "text", text: `pi_goal_task error: ${e.message}` }], details: { error: e.message }, isError: true } as any; }
        },
      });
    };
    try { registerGoalTool("pi_goal_task"); registerGoalTool("harness_goal_loop"); } catch (e: any) { try { console.warn("pi-harness: pi_goal_task not registered:", e?.message); } catch {} }
  }

  // -- pi_harness_remote F5: Remote Read-Only Web View -> 1.0.0 --
  {
    const registerRemoteTool = (toolName: string) => {
      pi.registerTool({
        name: toolName,
        label: toolName === "pi_harness_remote" ? "Pi Harness Remote" : "Harness Remote",
        description: "Read-only remote view of harness state (GET / HTML + GET /api/harness JSON + GET /api/health) via src/remote.ts. Actions: start launches ephemeral 127.0.0.1 server -> {url,port}, stop closes, status builds state without starting. Singleton per session, closed on session_shutdown. No baseRevision mutation.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["start", "stop", "status"], description: "start launches server, stop closes, status returns state" },
            port: { type: "integer", minimum: 0, maximum: 65535, description: "Port 0=ephemeral, used only for start" },
            host: { type: "string", description: "Bind host, default 127.0.0.1" },
            projectDir: { type: "string", description: "Project dir override, defaults to ctx cwd" },
          },
          required: ["action"],
        } as any,
        async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
          const dir: string = typeof params.projectDir === "string" && params.projectDir ? params.projectDir : getProjectDir(ctx as any);
          const action: string = params.action;
          try {
            const remoteMod: any = await import("../../src/remote.ts");
            if (action === "status") {
              const state = remoteMod.buildRemoteState(dir);
              return {
                content: [{ type: "text", text: "Remote status baseRevision " + state.baseRevision + " widget " + state.widgetLines.length + " lines" + (state.router ? " router " + (state.router.enabled ? "enabled" : "disabled") : "") + (state.rework?.active ? " rework->" + state.rework.returnTask : "") + (remoteServer ? " server " + remoteServer.url : " no server") }],
                details: { baseRevision: state.baseRevision, features: state.features, goals: state.goals, widgetLines: state.widgetLines, timestamp: state.timestamp, router: (state as any).router ?? null, rework: (state as any).rework ?? null, serverRunning: !!remoteServer, url: remoteServer?.url ?? null, host: remoteServer?.host ?? null, port: remoteServer?.port ?? null },
              } as any;
            }
            if (action === "stop") {
              if (!remoteServer) {
                return { content: [{ type: "text", text: "Remote server not running" }], details: { serverRunning: false } } as any;
              }
              const prevUrl = remoteServer.url;
              try { await remoteServer.close(); } catch {}
              remoteServer = null;
              remoteServerProjectDir = null;
              return { content: [{ type: "text", text: "Remote server stopped (was " + prevUrl + ")" }], details: { serverRunning: false, prevUrl } } as any;
            }
            if (remoteServer && remoteServerProjectDir === dir) {
              return {
                content: [{ type: "text", text: "Remote server already running " + remoteServer.url }],
                details: { url: remoteServer.url, host: remoteServer.host, port: remoteServer.port, serverRunning: true },
              } as any;
            }
            if (remoteServer) {
              try { await remoteServer.close(); } catch {}
              remoteServer = null;
              remoteServerProjectDir = null;
            }
            const host: string = typeof params.host === "string" && params.host ? params.host : "127.0.0.1";
            const port: number = typeof params.port === "number" ? params.port : 0;
            const srv = await remoteMod.createRemoteServer({ projectDir: dir, host, port });
            remoteServer = srv;
            remoteServerProjectDir = dir;
            try { (ctx as any)?.ui?.notify?.("pi-harness remote started " + srv.url, "info"); } catch {}
            return {
              content: [{ type: "text", text: "Remote server started " + srv.url }],
              details: { url: srv.url, host: srv.host, port: srv.port, serverRunning: true },
            } as any;
          } catch (e: any) {
            return { content: [{ type: "text", text: "pi_harness_remote error: " + e.message }], details: { error: e.message }, isError: true } as any;
          }
        },
      });
    };
    try { registerRemoteTool("pi_harness_remote"); registerRemoteTool("harness_remote"); } catch (e: any) { try { console.warn("pi-harness: pi_harness_remote not registered:", e?.message); } catch {} }
  }

  // ── turn_end: auto-validate + auto-phase-next (+ F7 auto-bounce/unstuck) ──
  pi.on("turn_end", async (_event: any, ctx: any) => {
    const dir = getProjectDir(ctx);
    if (!(await isHarnessProject(dir))) return;
    try {
      const { gates, state } = await loadHarnessLibs();
      const { config } = state.loadConfig(dir);
      if (!config || config.paused) return;
      const result = await gates.runChecks(dir, config.currentPhase);
      const allPass = result?.overall;
      if (allPass) {
        ctx.ui.notify(`pi-harness: validate PASS on ${config.currentPhase} — run dev-harness phase next`, "info");
        try { pi.appendEntry("harness:advance", { phase: config.currentPhase } as any); } catch {}
      } else {
        const details = result?.checks ? result.checks.filter((r: any) => !r.pass).map((r: any) => `- ${r.name}: ${r.detail}`).join("\n") || result.failures?.join(", ") || "validate failed" : "validate failed";
        ctx.ui.notify(`pi-harness: validate FAIL — ${details}`, "warning");
        try { pi.appendEntry("harness:gate-fail", { phase: config.currentPhase, details } as any); } catch {}
        // F7: auto-wire review bounce + unstuck suggestion (notify-only, budgets+hysteresis, fileDelta guard)
        try {
          let fileDelta = false;
          try {
            const { execSync } = await import("node:child_process");
            try {
              execSync("git diff --quiet", { cwd: dir, stdio: "ignore" });
              execSync("git diff --cached --quiet", { cwd: dir, stdio: "ignore" });
              const out = execSync("git status --porcelain 2>/dev/null | head -n 1", { cwd: dir, encoding: "utf-8" } as any);
              if (out && out.trim()) fileDelta = true;
              else fileDelta = false;
            } catch {
              fileDelta = true;
            }
          } catch { fileDelta = true; }
          if (config.currentPhase === "review") {
            try {
              const reviewMod: any = await import("../../src/review.ts");
              const r = reviewMod.shouldBounceToRework({ projectDir: dir, fileDelta });
              if (r.shouldBounce) {
                ctx.ui.notify(`pi-harness: \u21B7 rework eligible (bounce ${r.bounceCount}/${r.maxBounces}) — ${r.reason} — call startRework() to return-to-origin`, "warning");
                try { pi.appendEntry("harness:rework-eligible", r as any); } catch {}
              }
            } catch {}
          }
          try {
            const unstuckMod: any = await import("../../src/unstuck.ts");
            const sug = unstuckMod.chooseUnstuckStrategy({ projectDir: dir, fileDelta });
            if (sug && sug.strategy) {
              const modelPart = sug.nextModel ? ` \u2192 ${sug.nextModel}` : "";
              ctx.ui.notify(`pi-harness: unstuck suggest ${sug.strategy}${modelPart} — ${sug.reason}`, "info");
              try { pi.appendEntry("harness:unstuck", sug as any); } catch {}
            }
          } catch {}
        } catch {}
      }
    } catch (e: any) {
      try { ctx.ui.notify(`pi-harness turn_end error: ${e.message}`, "error"); } catch {}
    }
  });

  // ── tool_call: block phase-skipping ───────────────────────────────────────
  pi.on("tool_call", async (event: any, ctx: any) => {
    const dir = getProjectDir(ctx);
    if (!(await isHarnessProject(dir))) return;
    const tool = event.toolName || event.name || "";
    const input = event.input || {};
    const pathArg = input.path || input.file || input.filePath || "";
    if (typeof pathArg === "string" && pathArg.includes("harness/config.json") && tool.includes("write")) {
      const content = input.content || input.data || "";
      if (typeof content === "string" && content.includes("currentPhase")) {
        try {
          const { gates, state } = await loadHarnessLibs();
          const { config } = state.loadConfig(dir);
          const result = await gates.runChecks(dir, config?.currentPhase);
          const allPass = result?.overall;
          if (!allPass) {
            return { block: true, reason: "pi-harness: validate must PASS before hand-editing harness/config.json currentPhase. Run the validate command from the brief." };
          }
        } catch {}
      }
    }
    const cmd = input.command || input.cmd || "";
    if (typeof cmd === "string" && cmd.includes("dev-harness") && cmd.includes("phase") && cmd.includes("next")) {
      try {
        const { gates, state } = await loadHarnessLibs();
        const { config } = state.loadConfig(dir);
        const result = await gates.runChecks(dir, config?.currentPhase);
        const allPass = result?.overall;
        if (!allPass) {
          return { block: true, reason: "pi-harness: gate FAIL — phase next blocked. Fix the listed checks and re-validate." };
        }
      } catch {}
    }
  });

  // ── agent_start / sub-agent lock ──────────────────────────────────────────
  let lockRelease: (() => Promise<void>) | null = null;
  pi.on("agent_start", async (_event: any, ctx: any) => {
    const dir = getProjectDir(ctx);
    if (!(await isHarnessProject(dir))) return;
    try {
      const lockfile = await import("proper-lockfile");
      const cfgPath = resolve(dir, "harness", "config.json");
      if (existsSync(cfgPath)) {
        lockRelease = await lockfile.lock(cfgPath, { retries: 10, stale: 10000 }) as any;
        ctx.ui.setStatus("harness", "lock acquired");
      }
    } catch {}
    reconstructState(ctx);
    updateWidget(ctx);
  });
  pi.on("agent_end", async () => {
    if (lockRelease) {
      try { await lockRelease(); } catch {}
      lockRelease = null;
    }
  });
  pi.on("session_shutdown", async () => {
    if (remoteServer) {
      try { await remoteServer.close(); } catch {}
      remoteServer = null;
      remoteServerProjectDir = null;
    }
    if (lockRelease) {
      try { await lockRelease(); } catch {}
      lockRelease = null;
    }
    harnessState = { revision: 0, tasks: [] };
    harnessFileSnapshot = null;
    pendingCheckpoint = null;
    needsCheckpointInject = false;
    llmCallCounter = 0;
  });

  pi.registerCommand("harness:enforcer-status", {
    description: "Show pi-harness enforcer status (is the loop active?)",
    handler: async (_args: string, ctx: any) => {
      const dir = getProjectDir(ctx);
      const isHarness = await isHarnessProject(dir);
      const brief = isHarness ? await buildBriefText(dir) : "No harness in this project";
      ctx.ui.notify(`pi-harness: ${isHarness ? "active" : "no harness"} in ${dir}`, isHarness ? "info" : "warning");
      if (brief) ctx.ui.notify(brief.slice(0, 800), "info");
      const lines = getCurrentWidgetLines(dir);
      ctx.ui.notify(lines.slice(0, 20).join("\n"), "info");
    },
  });

  pi.registerCommand("harness:widget", {
    description: "Show pi-harness widget state",
    handler: async (_args: string, ctx: any) => {
      const dir = getProjectDir(ctx);
      const lines = getCurrentWidgetLines(dir);
      ctx.ui.notify(lines.join("\n"), "info");
      // Also show in-memory vs file
      ctx.ui.notify(`In-memory rev ${harnessState.revision} tasks ${harnessState.tasks.length}`, "info");
    },
  });
}
