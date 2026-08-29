/**
 * infinity-harness — ui/viewState.ts
 *
 * View states — "not running" is a state, not an absence.
 * Every Interface reads daemon.json BEFORE rendering, and derives a view state.
 * Heartbeat 20s, stale after 90s — v2.7 shipped values, kept deliberately.
 * Only the single place these numbers are defined.
 */

import { readJsonSafe } from "../core/fsx.ts";
import { daemonPath, runStatePath, supervisorPath } from "../core/paths.ts";

export const HEARTBEAT_MS = 20_000;
export const OWNER_STALE_MS = 90_000;

export type ViewState =
  | "running"
  | "stale"
  | "not-running"
  | "never-armed"
  | "awaiting-approval"
  | "stopped";

export type ViewSnapshot = {
  state: ViewState;
  daemon: { pid?: number; heartbeatAt?: string; runId?: string } | null;
  run: { armed?: boolean; stopReason?: string | null; runId?: string } | null;
  supervisor: { state?: string; updatedAt?: string } | null;
  reason?: string;
};

export function deriveViewState(targetDir: string): ViewSnapshot {
  const run = readJsonSafe<Record<string, unknown> | null>(runStatePath(targetDir), null);
  const daemon = readJsonSafe<Record<string, unknown> | null>(daemonPath(targetDir), null);
  const supervisor = readJsonSafe<Record<string, unknown> | null>(supervisorPath(targetDir), null);

  if (!run || !run.runId) {
    return { state: "never-armed", daemon: daemon as ViewSnapshot["daemon"], run: run as ViewSnapshot["run"], supervisor: supervisor as ViewSnapshot["supervisor"], reason: "No run has been armed. Run the wizard." };
  }
  if (run && (run as { armed?: boolean }).armed === false) {
    const stopReason = typeof (run as { stopReason?: unknown }).stopReason === "string" ? (run as { stopReason?: string }).stopReason : null;
    return { state: "stopped", daemon: daemon as ViewSnapshot["daemon"], run: run as ViewSnapshot["run"], supervisor: supervisor as ViewSnapshot["supervisor"], reason: stopReason ?? "Run stopped." };
  }
  // Armed but no daemon file
  if (!daemon) {
    return { state: "not-running", daemon: null, run: run as ViewSnapshot["run"], supervisor: supervisor as ViewSnapshot["supervisor"], reason: "Daemon not running — /infinity:run to start." };
  }
  const heartbeatAt = typeof (daemon as { heartbeatAt?: unknown }).heartbeatAt === "string" ? (daemon as { heartbeatAt: string }).heartbeatAt : null;
  const ageMs = heartbeatAt ? Date.now() - new Date(heartbeatAt).getTime() : Infinity;
  if (Number.isFinite(ageMs) && ageMs > OWNER_STALE_MS) {
    // Check pid liveness as tiebreaker: stale heartbeat but pid still alive => stale, else not-running.
    const pid = typeof (daemon as { pid?: unknown }).pid === "number" ? (daemon as { pid: number }).pid : undefined;
    let pidAlive = false;
    if (typeof pid === "number") { try { process.kill(pid, 0); pidAlive = true; } catch { pidAlive = false; } }
    if (pidAlive) {
      return { state: "stale", daemon: daemon as ViewSnapshot["daemon"], run: run as ViewSnapshot["run"], supervisor: supervisor as ViewSnapshot["supervisor"], reason: `Daemon unresponsive since ${heartbeatAt ?? "?"}` };
    }
    return { state: "not-running", daemon: null, run: run as ViewSnapshot["run"], supervisor: supervisor as ViewSnapshot["supervisor"], reason: "Daemon process is gone." };
  }
  // Check awaiting-approval (supervisor state)
  const supState = typeof (supervisor as { state?: unknown } | null)?.state === "string" ? String((supervisor as { state: string }).state) : null;
  if (supState === "awaiting-approval") {
    return { state: "awaiting-approval", daemon: daemon as ViewSnapshot["daemon"], run: run as ViewSnapshot["run"], supervisor: supervisor as ViewSnapshot["supervisor"] };
  }
  return { state: "running", daemon: daemon as ViewSnapshot["daemon"], run: run as ViewSnapshot["run"], supervisor: supervisor as ViewSnapshot["supervisor"] };
}

export function viewStateLabel(s: ViewState): string {
  switch (s) {
    case "running": return "running";
    case "stale": return "stale";
    case "not-running": return "not running";
    case "never-armed": return "never armed";
    case "awaiting-approval": return "awaiting approval";
    case "stopped": return "stopped";
  }
}
