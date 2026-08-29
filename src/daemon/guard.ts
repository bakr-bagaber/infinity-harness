/**
 * infinity-harness — daemon/guard.ts
 *
 * Single-owner lock + daemon.json heartbeat + bounded stop.
 * The Daemon is the single writer; Interfaces are readers. A second pi window
 * on the same project must become a viewer, not a rival Daemon.
 *
 * daemon.json is the trust root: { pid, port, token, startedAt, heartbeatAt, runId }.
 * Token is a random per-run secret; file is 0600. Server binds 127.0.0.1 only.
 * Guides: Daemon writes it, liveness is process.kill(pid,0), heartbeat every 20s,
 * stale after 90s. v2.7 shipped HEARTBEAT_MS/OWNER_STALE_MS at 20s/90s.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, writeFileSync, readFileSync, chmodSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { daemonPath } from "../core/paths.ts";
import { readJsonSafe, writeJsonAtomic, fileExists, ensureDir } from "../core/fsx.ts";
import { dirname } from "node:path";

export const HEARTBEAT_MS = 20_000;
export const OWNER_STALE_MS = 90_000;

export type DaemonInfo = {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
  heartbeatAt: string;
  runId: string;
};

function readDaemonRaw(targetDir: string): DaemonInfo | null {
  const raw = readJsonSafe<DaemonInfo | null>(daemonPath(targetDir), null);
  if (!raw || typeof raw.pid !== "number" || !raw.runId) return null;
  return raw as DaemonInfo;
}

export function loadDaemon(targetDir: string): DaemonInfo | null {
  const info = readDaemonRaw(targetDir);
  if (!info) return null;
  return info;
}

export function isDaemonAlive(info: DaemonInfo | null): boolean {
  if (!info) return false;
  // Heartbeat stale?
  const age = Date.now() - new Date(info.heartbeatAt).getTime();
  if (Number.isFinite(age) && age > OWNER_STALE_MS) {
    // Also check pid liveness as tiebreaker.
    try { process.kill(info.pid, 0); return false; } catch { return false; }
  }
  try { process.kill(info.pid, 0); return true; } catch { return false; }
}

export function isDaemonRunning(targetDir: string): boolean {
  const info = loadDaemon(targetDir);
  if (!info) return false;
  return isDaemonAlive(info);
}

export function writeDaemon(targetDir: string, info: DaemonInfo): void {
  ensureDir(dirname(daemonPath(targetDir)));
  writeJsonAtomic(daemonPath(targetDir), info);
  try { chmodSync(daemonPath(targetDir), 0o600); } catch {}
}

export function heartbeat(targetDir: string): DaemonInfo | null {
  const info = loadDaemon(targetDir);
  if (!info || !isDaemonAlive(info)) return null;
  const next: DaemonInfo = { ...info, heartbeatAt: new Date().toISOString() };
  writeDaemon(targetDir, next);
  return next;
}

export function clearDaemon(targetDir: string): void {
  try { if (existsSync(daemonPath(targetDir))) unlinkSync(daemonPath(targetDir)); } catch {}
}

export function newDaemonInfo(runId: string, port: number): DaemonInfo {
  return {
    pid: process.pid,
    port,
    token: randomBytes(24).toString("base64url"),
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    runId,
  };
}

/**
 * Guard: refuse to start a second Daemon when one is alive.
 * Returns null when clear, or the live DaemonInfo when blocked.
 */
export function guardSingleOwner(targetDir: string): DaemonInfo | null {
  const live = loadDaemon(targetDir);
  if (live && isDaemonAlive(live)) return live;
  // Stale file — clear it so the next start succeeds.
  if (live && !isDaemonAlive(live)) clearDaemon(targetDir);
  return null;
}

/**
 * Start heartbeat interval. Returns stop function.
 */
export function startHeartbeat(targetDir: string): () => void {
  const timer = setInterval(() => {
    try { heartbeat(targetDir); } catch {}
  }, HEARTBEAT_MS);
  // Don't keep process alive just for heartbeat if nothing else is running.
  if (typeof (timer as NodeJS.Timeout & { unref?: () => void }).unref === "function") (timer as unknown as { unref: () => void }).unref();
  return () => clearInterval(timer);
}
