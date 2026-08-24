/**
 * infinity-harness — the read-only dashboard server.
 *
 * A developer running the harness unattended wants to glance at progress
 * without attaching to the terminal session. This serves that view over plain
 * HTTP on loopback.
 *
 * Two properties are non-negotiable:
 *
 *   - **Read-only.** Nothing here writes, and nothing bumps `baseRevision`.
 *     Opening the dashboard must never perturb the run it is observing.
 *   - **Loopback by default.** The page exposes source paths, task text and
 *     gate output. Binding it to a public interface would leak the project.
 *     A non-loopback host has to be asked for explicitly.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import type { FeatureList, Feature, Goal, GateResult, Phase, Sprint } from "./core/types.ts";
import { loadFeatureList, computeProgress } from "./core/featureList.ts";
import { loadConfig } from "./core/config.ts";
import { modelRouterPath, reworkPath } from "./core/paths.ts";
import { readJsonSafe } from "./core/fsx.ts";
import { loadRunState } from "./runState.ts";
import { renderDashboard, escapeHtml, type DashboardState } from "./ui/dashboard.ts";

export { escapeHtml };

export interface RemoteOptions {
  projectDir?: string;
  host?: string;
  port?: number;
}

export interface RemoteState {
  baseRevision: number;
  phase: Phase | null;
  enabledPhases: readonly string[] | null;
  paused: boolean;
  features: Feature[];
  goals: Goal[];
  list: FeatureList;
  progress: ReturnType<typeof computeProgress>;
  gate: GateResult | null;
  retries: { task: number; max: number };
  timestamp: string;
  router: unknown;
  rework: unknown;
  sprints: Sprint[];
  /** A phase whose gate passed and which is waiting for a human signature. */
  awaitingApproval: string | null;
  /** pi sessions this run has spent — proof the handoff is doing its job. */
  sessions: number | null;
  goalPass: { current: number; max: number } | null;
}

export interface RemoteServer {
  url: string;
  host: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Snapshot everything the dashboard needs, from disk, without mutating a thing.
 *
 * The gate is *not* run here — running lint and tests because someone opened a
 * web page would be a surprising and expensive side effect. The last recorded
 * verdict from `gateHistory` is reported instead, which is what the human
 * actually wants: what the harness last decided.
 */
export function buildRemoteState(projectDir?: string): RemoteState {
  const dir = projectDir ? resolve(projectDir) : process.cwd();
  const { list } = loadFeatureList(dir);
  const { config } = loadConfig(dir);

  const lastGate = [...(config.gateHistory ?? [])].reverse()[0] ?? null;
  const gate: GateResult | null = lastGate
    ? {
        phase: lastGate.phase,
        overall: lastGate.result === "pass",
        failures: lastGate.result === "pass" ? [] : ["see terminal for detail"],
        checks: [
          {
            name: `last recorded gate (${lastGate.timestamp})`,
            pass: lastGate.result === "pass",
            detail:
              lastGate.result === "pass"
                ? `passed on ${lastGate.phase}`
                : `failed on ${lastGate.phase} — run validate for the per-check breakdown`,
          },
        ],
        ...(lastGate.feature ? { feature: lastGate.feature } : {}),
        ...(lastGate.task ? { task: lastGate.task } : {}),
      }
    : null;

  return {
    baseRevision: list.baseRevision,
    phase: config.currentPhase,
    enabledPhases: config.phases?.enabled ?? null,
    paused: Boolean(config.paused),
    features: list.features ?? [],
    goals: list.goals ?? [],
    list,
    progress: computeProgress(list),
    gate,
    retries: { task: config.taskRetryCount ?? 0, max: config.maxRetries ?? 10 },
    timestamp: new Date().toISOString(),
    router: readJsonSafe<unknown>(modelRouterPath(dir), null),
    rework: readJsonSafe<unknown>(reworkPath(dir), null),
    awaitingApproval: config.awaitingApproval ?? null,
    sessions: loadRunState(dir)?.sessions ?? null,
    goalPass:
      typeof config.goalPass === "number" && typeof config.goalMaxPasses === "number"
        ? { current: config.goalPass, max: config.goalMaxPasses }
        : null,
    sprints: list.sprints ?? [],
  };
}

function toDashboardState(s: RemoteState): DashboardState {
  return {
    list: s.list,
    phase: s.phase,
    enabledPhases: s.enabledPhases,
    paused: s.paused,
    gate: s.gate,
    baseRevision: s.baseRevision,
    timestamp: s.timestamp,
    retries: s.retries,
    router: s.router,
    rework: s.rework,
    awaitingApproval: s.awaitingApproval,
    sessions: s.sessions,
    goalPass: s.goalPass,
  };
}

export function buildHtml(state: RemoteState): string {
  return renderDashboard(toDashboardState(state));
}

/** JSON payload for `/api/harness`. Excludes the full list to stay compact. */
export function buildApiPayload(state: RemoteState): Record<string, unknown> {
  return {
    baseRevision: state.baseRevision,
    phase: state.phase,
    paused: state.paused,
    progress: state.progress,
    retries: state.retries,
    timestamp: state.timestamp,
    gate: state.gate,
    router: state.router,
    rework: state.rework,
    awaitingApproval: state.awaitingApproval,
    sessions: state.sessions,
    goalPass: state.goalPass,
    sprints: state.sprints,
    features: state.features.map((f) => ({
      id: f.id,
      name: f.name,
      passes: f.passes ?? false,
      tasks: (f.tasks ?? []).map((t) => ({
        id: t.id,
        key: t.key ?? t.id,
        description: t.description,
        status: t.status,
        dependsOn: t.dependsOn ?? [],
        subtasks: t.subtasks ?? [],
      })),
    })),
    goals: state.goals,
  };
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export async function createRemoteServer(opts?: RemoteOptions): Promise<RemoteServer> {
  const projectDir = opts?.projectDir ? resolve(opts.projectDir) : process.cwd();
  const host = opts?.host ?? "127.0.0.1";
  const port = opts?.port ?? 0;

  if (!LOOPBACK.has(host) && process.env.INFINITY_HARNESS_ALLOW_REMOTE !== "1") {
    throw new Error(
      `refusing to bind the dashboard to ${host}: it exposes project source and task text. ` +
        `Set INFINITY_HARNESS_ALLOW_REMOTE=1 if you really mean to.`,
    );
  }

  const server: Server = createServer((req, res) => {
    // Read-only surface: anything that is not a GET is refused outright.
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" });
      res.end("method not allowed");
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const noStore = { "cache-control": "no-store" };

    try {
      if (url.pathname === "/api/health") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", ...noStore });
        res.end(JSON.stringify({ ok: true, timestamp: new Date().toISOString() }));
        return;
      }
      if (url.pathname === "/api/harness") {
        const payload = buildApiPayload(buildRemoteState(projectDir));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", ...noStore });
        res.end(JSON.stringify(payload, null, 2));
        return;
      }
      if (url.pathname === "/") {
        const html = buildHtml(buildRemoteState(projectDir));
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          // The page renders untrusted model output; a tight CSP means an
          // escaping slip cannot become script execution.
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:",
          "x-content-type-options": "nosniff",
          ...noStore,
        });
        res.end(html);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", ...noStore });
      res.end("not found");
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8", ...noStore });
      res.end(`dashboard error: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(port, host, () => {
      server.removeListener("error", rej);
      res();
    });
  });

  const addr = server.address() as AddressInfo;
  const shownHost = addr.address === "::1" ? "[::1]" : addr.address;

  let closed = false;
  return {
    url: `http://${shownHost}:${addr.port}`,
    host: addr.address,
    port: addr.port,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((res) => {
        server.close(() => res());
        // Idle keep-alive sockets would otherwise hold the server open past
        // session shutdown, leaking a port for the life of the process.
        server.closeAllConnections?.();
      });
    },
  };
}
