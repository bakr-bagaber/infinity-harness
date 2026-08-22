/**
 * replan — mid-BUILD plan amendment with DAG validation and maxReplansPerRun guard
 * Atomic via proper-lockfile + tmp+rename, bumps baseRevision, validates no cycles/missing deps
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";

export const REPLAN_FILE = "harness/replan.json";
export const FEATURE_LIST = "harness/features/feature-list.json";

export interface AmendPlanOpts {
  projectDir?: string;
  reason?: string;
  addSprints?: Array<{ id: string; name: string; goalId?: string; difficulty?: string }>;
  addFeatures?: Array<{
    id: string;
    name: string;
    description?: string;
    sprintId?: string;
    goalId?: string;
    passes?: boolean;
    tasks?: Array<any>;
    difficulty?: string;
  }>;
  addTasks?: Array<{
    featureId: string;
    task: {
      id: string;
      key?: string;
      description: string;
      status?: string;
      dependsOn?: string[];
      subtasks?: Array<{ id: string; title: string; status: string }>;
      difficulty?: string;
      modelHint?: string;
      acceptanceCriteria?: string[];
    };
  }>;
}

export interface AmendPlanResult {
  baseRevision: number;
  added: { sprints: number; features: number; tasks: number };
}

function projectDirOf(p?: string): string { return p ?? process.cwd(); }
function replanPath(projectDir: string): string { return resolve(projectDir, REPLAN_FILE); }
function featureListPath(projectDir: string): string { return resolve(projectDir, FEATURE_LIST); }

async function withFileLock<T>(filePathToLock: string, fn: () => Promise<T> | T): Promise<T> {
  let release: (() => Promise<void>) | null = null;
  try {
    const mod: any = await import("proper-lockfile");
    const lockfile = mod.default ?? mod;
    try { mkdirSync(dirname(filePathToLock), { recursive: true }); } catch {}
    if (!existsSync(filePathToLock)) {
      try { writeFileSync(filePathToLock, "{}", "utf-8"); } catch {}
    }
    release = await lockfile.lock(filePathToLock, { retries: { retries: 8, minTimeout: 25, maxTimeout: 100 }, stale: 10000, update: 2000 });
  } catch {
    try { mkdirSync(dirname(filePathToLock), { recursive: true }); } catch {}
    try { if (!existsSync(filePathToLock)) writeFileSync(filePathToLock, "{}", "utf-8"); } catch {}
    try {
      const mod2: any = await import("proper-lockfile");
      const lf2 = mod2.default ?? mod2;
      release = await lf2.lock(filePathToLock, { retries: { retries: 8, minTimeout: 25, maxTimeout: 100 } });
    } catch { release = null; }
  }
  try { return await fn(); } finally { if (release) try { await release(); } catch {} }
}

function loadFeatureList(projectDir: string): any {
  const p = featureListPath(projectDir);
  if (!existsSync(p)) throw new Error("feature-list.json missing: " + p);
  return JSON.parse(readFileSync(p, "utf-8"));
}
function saveFeatureList(projectDir: string, data: any): void {
  const p = featureListPath(projectDir);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  renameSync(tmp, p);
}

function resolveTaskKey(task: any): string { return task.key ?? task.id; }

function validateStatus(status: string): void {
  const allowed = new Set(["pending", "in_progress", "complete", "blocked", "rework"]);
  if (!allowed.has(status)) throw new Error(`invalid task status: ${status} (expected pending|in_progress|complete|blocked|rework)`);
}

function detectCycle(tasks: Array<{ key: string; dependsOn: string[] }>): void {
  const map = new Map(tasks.map((t) => [t.key, t.dependsOn ?? []]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const dfs = (key: string) => {
    if (visiting.has(key)) throw new Error(`dependency cycle detected at ${key}`);
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dep of map.get(key) ?? []) dfs(dep);
    visiting.delete(key);
    visited.add(key);
  };
  for (const k of map.keys()) dfs(k);
}

function validateDeps(tasks: Array<{ key: string; dependsOn: string[]; status: string }>): void {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  for (const t of tasks) {
    for (const dep of t.dependsOn ?? []) {
      if (!byKey.has(dep)) throw new Error(`dependsOn references missing task ${dep} (from ${t.key})`);
    }
    if (t.status === "in_progress" || t.status === "complete") {
      const unresolved = (t.dependsOn ?? []).filter((d) => byKey.get(d)?.status !== "complete");
      if (unresolved.length > 0) throw new Error(`${t.key} cannot be ${t.status} while dependencies are unresolved: ${unresolved.join(", ")}`);
    }
  }
}

function readMaxReplans(projectDir: string): number {
  try {
    const cfg = JSON.parse(readFileSync(resolve(projectDir, "harness/config.json"), "utf-8"));
    if (typeof cfg?.replan?.maxReplans === "number") return cfg.replan.maxReplans;
    if (typeof cfg?.replan?.maxReplansPerRun === "number") return cfg.replan.maxReplansPerRun;
    if (typeof cfg?.budgets?.maxReplansPerRun === "number") return cfg.budgets.maxReplansPerRun;
  } catch {}
  return 2;
}

function readReplanCount(projectDir: string): number {
  const rp = replanPath(projectDir);
  if (!existsSync(rp)) return 0;
  try {
    const raw = JSON.parse(readFileSync(rp, "utf-8"));
    if (Array.isArray(raw)) return raw.length;
    if (Array.isArray((raw as any).history)) return (raw as any).history.length;
    if ((raw as any).reason) return 1;
    return 0;
  } catch { return 0; }
}

function appendReplanHistory(projectDir: string, entry: any): void {
  const rp = replanPath(projectDir);
  let history: any[] = [];
  if (existsSync(rp)) {
    try {
      const raw = JSON.parse(readFileSync(rp, "utf-8"));
      if (Array.isArray(raw)) history = raw;
      else if (Array.isArray((raw as any).history)) history = (raw as any).history;
      else if ((raw as any).reason) history = [raw];
    } catch { history = []; }
  }
  history.push(entry);
  mkdirSync(dirname(rp), { recursive: true });
  const tmp = rp + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(history, null, 2) + "\n", "utf-8");
  try { renameSync(tmp, rp); } catch { writeFileSync(rp, JSON.stringify(history, null, 2) + "\n", "utf-8"); }
}

export async function amendPlan(opts: AmendPlanOpts): Promise<AmendPlanResult> {
  const projectDir = projectDirOf(opts.projectDir);
  const maxReplans = readMaxReplans(projectDir);
  const priorCount = readReplanCount(projectDir);
  if (priorCount >= maxReplans) throw new Error(`maxReplansPerRun exceeded: ${priorCount} >= ${maxReplans}`);

  // Lock feature-list for atomic read-modify-write
  const result = await withFileLock(featureListPath(projectDir), async () => {
    const data = loadFeatureList(projectDir);
    data.sprints = data.sprints ?? [];
    data.features = data.features ?? [];
    data.goals = data.goals ?? [];

    let addedSprints = 0, addedFeatures = 0, addedTasks = 0;

    // add sprints
    if (opts.addSprints) {
      for (const s of opts.addSprints) {
        if (!s.id || !s.name) throw new Error("sprint requires id and name");
        if (data.sprints.some((x: any) => x.id === s.id)) throw new Error(`duplicate sprint id: ${s.id}`);
        data.sprints.push({ id: s.id, name: s.name, ...(s.goalId ? { goalId: s.goalId } : {}), ...(s.difficulty ? { difficulty: s.difficulty } : {}) });
        addedSprints++;
      }
    }

    // add features
    if (opts.addFeatures) {
      for (const f of opts.addFeatures) {
        if (!f.id || !f.name) throw new Error("feature requires id and name");
        if (data.features.some((x: any) => x.id === f.id)) throw new Error(`duplicate feature id: ${f.id}`);
        data.features.push({
          id: f.id,
          name: f.name,
          description: f.description ?? "",
          passes: f.passes ?? false,
          sprintId: f.sprintId,
          goalId: f.goalId,
          difficulty: (f as any).difficulty,
          tasks: (f.tasks ?? []).map((t: any) => ({
            id: t.id,
            key: t.key,
            description: t.description,
            status: t.status ?? "pending",
            dependsOn: t.dependsOn ?? [],
            subtasks: t.subtasks ?? [],
            difficulty: t.difficulty,
            modelHint: t.modelHint,
            acceptanceCriteria: t.acceptanceCriteria ?? [],
          })),
        });
        addedFeatures++;
      }
    }

    // add tasks
    if (opts.addTasks) {
      for (const at of opts.addTasks) {
        const feat = data.features.find((f: any) => f.id === at.featureId);
        if (!feat) throw new Error(`feature not found for addTasks: ${at.featureId}`);
        const t = at.task;
        if (!t.id || !t.description) throw new Error("task requires id and description");
        const key = t.key ?? t.id;
        // check duplicate key within that feature and globally for cycle check we need global unique? We use global key for deps validation: key field if provided else id
        const globalKeys = new Set<string>();
        for (const f of data.features) for (const tt of f.tasks ?? []) globalKeys.add(resolveTaskKey(tt));
        if (globalKeys.has(key)) throw new Error(`duplicate task key: ${key}`);
        if ((feat.tasks ?? []).some((x: any) => x.id === t.id)) throw new Error(`duplicate task id in feature ${at.featureId}: ${t.id}`);
        if (t.status) validateStatus(t.status);
        feat.tasks = feat.tasks ?? [];
        feat.tasks.push({
          id: t.id,
          key: t.key,
          description: t.description,
          status: t.status ?? "pending",
          dependsOn: t.dependsOn ?? [],
          subtasks: t.subtasks ?? [],
          difficulty: t.difficulty,
          modelHint: t.modelHint,
          acceptanceCriteria: t.acceptanceCriteria ?? [],
        });
        addedTasks++;
      }
    }

    // Collect all tasks for DAG validation
    const allTasks: Array<{ key: string; dependsOn: string[]; status: string }> = [];
    for (const f of data.features) {
      for (const t of f.tasks ?? []) {
        const k = resolveTaskKey(t);
        allTasks.push({ key: k, dependsOn: t.dependsOn ?? [], status: t.status ?? "pending" });
      }
    }

    // validate missing deps and cycles
    validateDeps(allTasks);
    detectCycle(allTasks);

    // bump baseRevision if any change
    const hasChange = addedSprints > 0 || addedFeatures > 0 || addedTasks > 0;
    if (hasChange) {
      data.baseRevision = (typeof data.baseRevision === "number" ? data.baseRevision : 0) + 1;
    }

    saveFeatureList(projectDir, data);
    return { baseRevision: data.baseRevision as number, added: { sprints: addedSprints, features: addedFeatures, tasks: addedTasks } };
  });

  // Append replan history with its own lock (separate file)
  await withFileLock(replanPath(projectDir), async () => {
    appendReplanHistory(projectDir, {
      timestamp: new Date().toISOString(),
      reason: opts.reason ?? "amendPlan",
      added: result.added,
      baseRevision: result.baseRevision,
    });
  });

  return result;
}

export function loadReplanHistory(projectDir?: string): any[] {
  const p = replanPath(projectDirOf(projectDir));
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    if (Array.isArray(raw)) return raw;
    if (Array.isArray((raw as any).history)) return (raw as any).history;
    if ((raw as any).reason) return [raw];
    return [];
  } catch { return []; }
}

export async function clearReplanHistory(projectDir?: string): Promise<void> {
  const p = replanPath(projectDirOf(projectDir));
  await withFileLock(p, async () => { if (existsSync(p)) try { unlinkSync(p); } catch {} });
}
