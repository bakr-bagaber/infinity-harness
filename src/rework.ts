/**
 * rework — backward edge with return-to-origin
 * Computes impact BFS via dependsOn DAG, flips origin+impacted to "rework" (reversible), bumps baseRevision, writes harness/rework.json
 * Atomic via proper-lockfile + tmp+rename
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";

export const REWORK_FILE = "harness/rework.json";

export interface ReworkRecord {
  runId: string;
  returnFeature: string;
  returnTask: string;
  impacted: string[];
  reason: string;
  timestamp: string;
  remainingBudgets?: { reworks: number; replans: number; bounces: number };
  maxImpactDepth?: number;
}

export interface StartReworkOpts {
  projectDir?: string;
  featureId: string;
  taskId: string;
  reason?: string;
  runId?: string;
  maxImpactDepth?: number;
  key?: string;
}

function projectDirOf(p?: string): string { return p ?? process.cwd(); }
function reworkPath(projectDir: string): string { return resolve(projectDir, REWORK_FILE); }
function filePath(projectDir: string): string { return resolve(projectDir, "harness/features/feature-list.json"); }

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
  const p = filePath(projectDir);
  if (!existsSync(p)) throw new Error("feature-list.json missing: " + p);
  return JSON.parse(readFileSync(p, "utf-8"));
}
function saveFeatureList(projectDir: string, data: any): void {
  const p = filePath(projectDir);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  renameSync(tmp, p);
}
function resolveTaskKey(task: any): string { return task.key ?? task.id; }

export function computeImpact(allTasks: any[], originKey: string, maxDepth: number): string[] {
  const impacted: string[] = [];
  const visited = new Set<string>([originKey]);
  let frontier: Array<{ key: string; depth: number }> = [{ key: originKey, depth: 0 }];
  while (frontier.length) {
    const next: Array<{ key: string; depth: number }> = [];
    for (const cur of frontier) {
      if (cur.depth >= maxDepth) continue;
      for (const t of allTasks) {
        const k = resolveTaskKey(t);
        if (visited.has(k)) continue;
        const deps: string[] = t.dependsOn ?? [];
        if (deps.includes(cur.key)) {
          visited.add(k);
          impacted.push(k);
          next.push({ key: k, depth: cur.depth + 1 });
        }
      }
    }
    frontier = next;
  }
  return impacted;
}

export async function startRework(opts: StartReworkOpts): Promise<{ impacted: string[]; baseRevision: number; rework: ReworkRecord }> {
  const projectDir = projectDirOf(opts.projectDir);
  const maxDepth = opts.maxImpactDepth ?? 3;
  const explicitKey = opts.key ?? opts.taskId;
  const data0 = loadFeatureList(projectDir);
  let originKey = explicitKey;
  const allTasks0: any[] = [];
  for (const f of data0.features ?? []) for (const t of f.tasks ?? []) allTasks0.push(t);
  const candidates: string[] = [explicitKey, opts.featureId + "/" + opts.taskId, opts.taskId];
  let foundById: string | null = null;
  for (const t of allTasks0) {
    if (t.id === opts.taskId && t.key) { foundById = t.key; break; }
    if (t.id === opts.taskId) { foundById = t.id; break; }
  }
  if (foundById) candidates.unshift(foundById);
  for (const cand of candidates) {
    if (allTasks0.some((t) => resolveTaskKey(t) === cand)) { originKey = cand; break; }
  }
  let remainingReworks = 3;
  try {
    const cfg = JSON.parse(readFileSync(resolve(projectDir, "harness/config.json"), "utf-8"));
    remainingReworks = cfg?.rework?.maxReworks ?? cfg?.budgets?.maxReworksPerRun ?? 3;
  } catch {}
  const rp = reworkPath(projectDir);
  let priorCount = 0;
  if (existsSync(rp)) {
    try {
      const prev = JSON.parse(readFileSync(rp, "utf-8"));
      if (Array.isArray((prev as any).history)) priorCount = (prev as any).history.length;
      else if ((prev as any).returnTask) priorCount = 1;
    } catch {}
  }
  if (priorCount >= remainingReworks) throw new Error("maxReworksPerRun exceeded: " + priorCount + " >= " + remainingReworks);

  const result = await withFileLock(filePath(projectDir), async () => {
    const data = loadFeatureList(projectDir);
    const allTasks: any[] = [];
    for (const f of data.features ?? []) for (const t of f.tasks ?? []) allTasks.push(t);
    const originExists = allTasks.some((t) => resolveTaskKey(t) === originKey);
    if (!originExists) throw new Error("origin task not found: " + originKey);
    const impacted = computeImpact(allTasks, originKey, maxDepth);
    const toRework = new Set<string>([originKey, ...impacted]);
    let changed = false;
    for (const f of data.features ?? []) {
      for (const t of f.tasks ?? []) {
        const k = resolveTaskKey(t);
        if (toRework.has(k) && t.status !== "rework") { t.status = "rework"; changed = true; }
      }
    }
    if (changed) data.baseRevision = (typeof data.baseRevision === "number" ? data.baseRevision : 0) + 1;
    saveFeatureList(projectDir, data);
    const runId = opts.runId ?? ("run-" + Date.now());
    const record: ReworkRecord = {
      runId, returnFeature: opts.featureId, returnTask: opts.taskId, impacted, reason: opts.reason ?? "rework via startRework",
      timestamp: new Date().toISOString(), remainingBudgets: { reworks: remainingReworks - priorCount - 1, replans: 2, bounces: 2 }, maxImpactDepth: maxDepth,
    };
    return { impacted, baseRevision: data.baseRevision as number, record };
  });

  await withFileLock(rp, async () => {
    mkdirSync(dirname(rp), { recursive: true });
    let toWrite: any = { ...result.record };
    if (existsSync(rp)) {
      try {
        const prev = JSON.parse(readFileSync(rp, "utf-8"));
        if (prev && typeof prev === "object") {
          let history: any[];
          if (Array.isArray((prev as any).history)) history = [...(prev as any).history];
          else if ((prev as any).returnTask) {
            const { history: _h, ...rest } = prev as any;
            history = [rest];
          } else history = [];
          history.push({ ...result.record });
          toWrite = { history };
        }
      } catch {}
    }
    const tmp = rp + "." + process.pid + ".tmp";
    writeFileSync(tmp, JSON.stringify(toWrite, null, 2) + "\n", "utf-8");
    try { renameSync(tmp, rp); } catch { writeFileSync(rp, JSON.stringify(toWrite, null, 2) + "\n", "utf-8"); }
  });

  return { impacted: result.impacted, baseRevision: result.baseRevision, rework: result.record };
}

export function loadRework(projectDir?: string): ReworkRecord | null {
  const p = reworkPath(projectDirOf(projectDir));
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    if ((raw as any).history && Array.isArray((raw as any).history)) {
      const h = (raw as any).history as ReworkRecord[];
      return h[h.length - 1] ?? null;
    }
    return raw as ReworkRecord;
  } catch { return null; }
}

export async function clearRework(projectDir?: string): Promise<void> {
  const p = reworkPath(projectDirOf(projectDir));
  await withFileLock(p, async () => { if (existsSync(p)) try { unlinkSync(p); } catch {} });
}
