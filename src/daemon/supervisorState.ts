/**
 * infinity-harness — daemon/supervisorState.ts
 *
 * Daemon-owned files: harness/supervisor.json (live worker) and harness/activity.json
 * (last ~400 lines). Only the Daemon writes them; Interfaces only read.
 *
 * SupervisorView captures askedModel vs servedModel per worker — the proof of
 * routing that v2.7 lacked.
 */

import { supervisorPath, activityPath } from "../core/paths.ts";
import { readJsonSafe, writeJsonAtomic, ensureDir } from "../core/fsx.ts";
import { existsSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

export const ACTIVITY_LIMIT = 400;

export type ActivityLevel = "info" | "work" | "warn" | "error" | "good";

export type ActivityLine = {
  at: string;
  level: ActivityLevel;
  worker: string | null;
  text: string;
};

export type SupervisorWorker = {
  name: string;
  unitKey: string;
  unitLabel: string;
  level: string;
  difficulty: string | null;
  model: string;
  askedModel: string;
  servedModel: string | null;
  thinking: string;
  state: "starting" | "working" | "idle" | "closed" | "failed";
  doing: string | null;
  startedAt: string;
  turns: number;
  recycles: number;
  tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost?: number; calls?: number };
  contextRatio: number | null;
  sessionId: string | null;
  unit?: string;
};

export type SupervisorState = {
  runId: string;
  updatedAt: string;
  worker: SupervisorWorker | null;
  workers?: SupervisorWorker[];
};

export function loadSupervisor(targetDir: string): SupervisorState | null {
  return readJsonSafe<SupervisorState | null>(supervisorPath(targetDir), null);
}

export function saveSupervisor(targetDir: string, state: SupervisorState): void {
  ensureDir(dirname(supervisorPath(targetDir)));
  writeJsonAtomic(supervisorPath(targetDir), { ...state, updatedAt: new Date().toISOString() });
}

export function loadActivity(targetDir: string): ActivityLine[] {
  const raw = readJsonSafe<ActivityLine[] | null>(activityPath(targetDir), null);
  return Array.isArray(raw) ? raw : [];
}

export function appendActivity(targetDir: string, line: Omit<ActivityLine, "at"> & { at?: string }): ActivityLine {
  const entry: ActivityLine = { at: line.at ?? new Date().toISOString(), level: line.level, worker: line.worker ?? null, text: line.text };
  const cur = loadActivity(targetDir);
  const next = [...cur, entry].slice(-ACTIVITY_LIMIT);
  ensureDir(dirname(activityPath(targetDir)));
  writeJsonAtomic(activityPath(targetDir), next);
  return entry;
}

export function clearSupervisor(targetDir: string): void {
  try {
    const p = supervisorPath(targetDir);
    if (existsSync(p)) unlinkSync(p);
  } catch {}
}
