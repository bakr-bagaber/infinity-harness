/**
 * infinity-harness — daemon/server.ts
 *
 * Tiny localhost HTTP for Interfaces -> Daemon control. Daemon binds port 0,
 * OS picks free, daemon.json records the port+token.
 *
 * GET /status  (open)  → state
 * POST /run | /halt | /pause | /resume | /approve | /replan | /rework   (token-checked)
 * GET /dashboard → dashboard.ts HTML
 */

import { createServer, type Server } from "node:http";
import { daemonPath } from "../core/paths.ts";
import { readJsonSafe } from "../core/fsx.ts";
import { isDaemonAlive, loadDaemon } from "./guard.ts";

export type ServerOpts = {
  targetDir: string;
  port?: number;
  token?: string;
  onRun?: (req: unknown) => Promise<unknown>;
  onHalt?: (req: unknown) => Promise<unknown>;
  onPause?: (req: unknown) => Promise<unknown>;
  onResume?: (req: unknown) => Promise<unknown>;
  onApprove?: (req: unknown) => Promise<unknown>;
  onReplan?: (req: unknown) => Promise<unknown>;
  onRework?: (req: unknown) => Promise<unknown>;
};

export function startServer(opts: ServerOpts): Promise<{ server: Server; port: number; token: string }> {
  const targetDir = opts.targetDir;
  // token comes from daemon.json if running, or fresh for a new Daemon — caller should supply.
  const expectedToken = opts.token ?? loadDaemon(targetDir)?.token ?? null;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const path = url.pathname;

    const writeJson = (code: number, body: unknown): void => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    const requireToken = (): boolean => {
      if (!expectedToken) return true;
      const auth = req.headers.authorization ?? "";
      const queryToken = url.searchParams.get("token") ?? "";
      const headerToken = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const bodyToken = "";
      // Token is in daemon.json; client reads it and sends via header or query.
      if (headerToken === expectedToken || queryToken === expectedToken) return true;
      return false;
    };

    if (req.method === "GET" && (path === "/status" || path === "/api/status")) {
      const daemon = loadDaemon(targetDir);
      const alive = isDaemonAlive(daemon);
      const run = readJsonSafe<unknown>(require("../core/paths.ts").runStatePath(targetDir), null);
      const supervisor = readJsonSafe<unknown>(require("../core/paths.ts").supervisorPath(targetDir), null);
      const activity = readJsonSafe<unknown>(require("../core/paths.ts").activityPath(targetDir), null);
      writeJson(200, { ok: true, alive, daemon, run, supervisor, activity: Array.isArray(activity) ? (activity as unknown[]).slice(-20) : [] });
      return;
    }

    if (req.method === "GET" && (path === "/dashboard" || path === "/" || path === "/api/harness")) {
      // Serve dashboard HTML or harness state JSON depending on path.
      if (path === "/api/harness") {
        const { loadFeatureList } = await import("../core/featureList.ts");
        const { list } = loadFeatureList(targetDir);
        writeJson(200, { baseRevision: list.baseRevision, features: list.features, goals: list.goals, sprints: list.sprints });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>infinity-harness</title>< meta name="viewport" content="width=device-width"><h1>infinity-harness</h1><p>Daemon at ${targetDir}</p><p><a href="/status">/status</a> <a href="/api/harness">/api/harness</a></p>`);
      return;
    }

    if (req.method === "POST") {
      if (!requireToken()) { writeJson(401, { ok: false, error: "invalid token" }); return; }
      let body = "";
      req.on("data", chunk => { body += String(chunk); if (body.length > 1_000_000) req.destroy(); });
      req.on("end", async () => {
        let parsed: unknown = null;
        try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = {}; }
        try {
          if (path === "/run" && opts.onRun) { const r = await opts.onRun(parsed); writeJson(200, r ?? { ok: true }); return; }
          if (path === "/halt" && opts.onHalt) { const r = await opts.onHalt(parsed); writeJson(200, r ?? { ok: true }); return; }
          if (path === "/pause" && opts.onPause) { const r = await opts.onPause(parsed); writeJson(200, r ?? { ok: true }); return; }
          if (path === "/resume" && opts.onResume) { const r = await opts.onResume(parsed); writeJson(200, r ?? { ok: true }); return; }
          if (path === "/approve" && opts.onApprove) { const r = await opts.onApprove(parsed); writeJson(200, r ?? { ok: true }); return; }
          if (path === "/replan" && opts.onReplan) { const r = await opts.onReplan(parsed); writeJson(200, r ?? { ok: true }); return; }
          if (path === "/rework" && opts.onRework) { const r = await opts.onRework(parsed); writeJson(200, r ?? { ok: true }); return; }
          writeJson(404, { ok: false, error: `unknown POST ${path}` });
        } catch (e) {
          writeJson(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      });
      return;
    }

    writeJson(404, { ok: false, error: `unknown ${req.method} ${path}` });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address() as { port: number } | null;
      const port = addr?.port ?? (opts.port ?? 0);
      resolve({ server, port, token: expectedToken ?? "" });
    });
  });
}

export function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
