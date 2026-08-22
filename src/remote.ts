/**
 * remote — read-only HTTP view of harness state
 *
 * Reuses src/widget.ts (buildWidgetLines) and reads harness/features/feature-list.json
 * via readFileSync (no baseRevision increment). Exposes buildRemoteState and
 * createRemoteServer (node:http 127.0.0.1 ephemeral -> GET / HTML + GET /api/harness JSON + GET /api/health).
 * Reads are lock-free; writes already use proper-lockfile+tmp+rename.
 */

import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildWidgetLines, type FeatureList } from "./widget.ts";

// ── types ───────────────────────────────────────────────────────────────────
export interface RemoteOptions {
  projectDir?: string;
  host?: string;
  port?: number;
}

export interface RemoteState {
  baseRevision: number;
  features: any[];
  goals: any[];
  widgetLines: string[];
  timestamp: string;
  router: { enabled: boolean; budgets: any; byDifficulty: any; default?: string } | null;
  rework: { active: boolean; impactedCount: number; returnFeature?: string; returnTask?: string; impacted?: string[] } | null;
}

export interface RemoteServer {
  url: string;
  host: string;
  port: number;
  close(): Promise<void>;
}

// ── html escaping ───────────────────────────────────────────────────────────
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── buildRemoteState ────────────────────────────────────────────────────────
export function buildRemoteState(projectDir?: string): RemoteState {
  const dir = projectDir ? resolve(projectDir) : process.cwd();
  let data: any = null;
  let baseRevision = 0;
  let features: any[] = [];
  let goals: any[] = [];
  let sprints: any[] = [];
  try {
    const fp = resolve(dir, "harness", "features", "feature-list.json");
    if (existsSync(fp)) {
      const raw = readFileSync(fp, "utf-8");
      data = JSON.parse(raw);
      baseRevision = typeof data.baseRevision === "number" ? data.baseRevision : 0;
      features = Array.isArray(data.features) ? data.features : [];
      goals = Array.isArray(data.goals) ? data.goals : [];
      sprints = Array.isArray(data.sprints) ? data.sprints : [];
      try {
        const goalSpecPath = resolve(dir, "harness", "goals", "GOAL_SPEC.json");
        if (existsSync(goalSpecPath)) {
          const graw = readFileSync(goalSpecPath, "utf-8");
          const gspec = JSON.parse(graw);
          if (goals.length === 0 && gspec && gspec.originalGoal) {
            goals = [
              {
                id: gspec.goalRunId ?? "goal-goalSpec",
                title: gspec.summary ?? gspec.originalGoal,
                description: gspec.originalGoal,
              },
            ];
          }
        }
      } catch {}
    }
  } catch {
    // read/parse failure -> empty state
  }

  let widgetLines: string[] = [];
  try {
    const fl: FeatureList = {
      version: data?.version ?? "0.1",
      baseRevision,
      goals,
      sprints,
      features,
    } as FeatureList;
    widgetLines = buildWidgetLines(fl, { width: 80 });
  } catch {
    widgetLines = [`Progress: 0/0`];
  }

  let router: RemoteState["router"] = null;
  try {
    const routerPath = resolve(dir, "harness", "model-router.json");
    if (existsSync(routerPath)) {
      const rraw = readFileSync(routerPath, "utf-8");
      const rcfg = JSON.parse(rraw);
      router = {
        enabled: !!rcfg.enabled,
        budgets: rcfg.budgets ?? null,
        byDifficulty: rcfg.byDifficulty ?? null,
        default: typeof rcfg.default === "string" ? rcfg.default : undefined,
      };
    }
  } catch {}

  let rework: RemoteState["rework"] = null;
  try {
    const reworkPath = resolve(dir, "harness", "rework.json");
    if (existsSync(reworkPath)) {
      const rraw2 = readFileSync(reworkPath, "utf-8");
      const rj: any = JSON.parse(rraw2);
      let rec: any = null;
      if (Array.isArray((rj as any).history) && (rj as any).history.length) {
        const h = (rj as any).history;
        rec = h[h.length - 1];
      } else if (rraw2.trim().startsWith("[")) {
        const arr = rj as any[];
        rec = arr.length ? arr[arr.length - 1] : null;
      } else {
        rec = rj;
      }
      if (rec && rec.returnTask) {
        rework = {
          active: true,
          impactedCount: Array.isArray(rec.impacted) ? rec.impacted.length : 0,
          returnFeature: rec.returnFeature,
          returnTask: rec.returnTask,
          impacted: Array.isArray(rec.impacted) ? rec.impacted : [],
        };
      } else {
        rework = { active: false, impactedCount: 0 };
      }
    } else {
      rework = { active: false, impactedCount: 0 };
    }
  } catch {
    rework = { active: false, impactedCount: 0 };
  }

  return {
    baseRevision,
    features,
    goals,
    widgetLines,
    timestamp: new Date().toISOString(),
    router,
    rework,
  };
}

// ── html builder ────────────────────────────────────────────────────────────
export function buildHtml(state: RemoteState): string {
  const esc = escapeHtml;
  const linesEsc = state.widgetLines.map(esc).join("\n");
  const features = state.features ?? [];
  const goals = state.goals ?? [];

  const goalsHtml = goals.length
    ? `<section><h2>Goals (${goals.length})</h2><ul>` +
      goals
        .map(
          (g: any) =>
            `<li>${esc(String(g.title ?? g.id ?? ""))}${g.description ? " — " + esc(String(g.description)) : ""}</li>`,
        )
        .join("") +
      `</ul></section>`
    : `<section><h2>Goals</h2><p>(none)</p></section>`;

  const featuresHtml = features.length
    ? `<section><h2>Features (${features.length})</h2>` +
      features
        .map((f: any) => {
          const tasks = Array.isArray(f.tasks) ? f.tasks : [];
          const done = tasks.filter((t: any) => t.status === "complete" || t.status === "done").length;
          const total = tasks.length;
          const taskRows = tasks
            .map((t: any) => {
              const label = esc(String(t.description ?? t.key ?? t.id ?? ""));
              const status = esc(String(t.status ?? ""));
              const deps =
                Array.isArray(t.dependsOn) && t.dependsOn.length
                  ? ` \u2190 ${t.dependsOn.map((d: any) => esc(String(d))).join(", ")}`
                  : "";
              return `<tr><td>${esc(String(t.key ?? t.id))}</td><td>${label}${deps}</td><td>${status}</td></tr>`;
            })
            .join("");
          return (
            `<div class="feature"><h3>${esc(String(f.name ?? f.id))} <small>Progress: ${done}/${total}</small></h3>` +
            (tasks.length
              ? `<table><thead><tr><th>key</th><th>subject</th><th>status</th></tr></thead><tbody>${taskRows}</tbody></table>`
              : `<p>(no tasks)</p>`) +
            `</div>`
          );
        })
        .join("") +
      `</section>`
    : `<section><h2>Features</h2><p>(none)</p></section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>pi-harness \u2014 baseRevision ${state.baseRevision}</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;margin:24px;line-height:1.5;color:#111;background:#fff}
  h1{font-size:20px;margin:0 0 8px}
  h2{font-size:16px;margin:16px 0 8px}
  h3{font-size:14px;margin:12px 0 6px}
  pre{white-space:pre-wrap;word-break:break-word;background:#f6f8fa;border:1px solid #e1e4e8;border-radius:6px;padding:12px;overflow:auto}
  table{border-collapse:collapse;width:100%;margin:8px 0}
  th,td{border:1px solid #e1e4e8;padding:6px 8px;text-align:left;font-size:13px}
  th{background:#f6f8fa}
  small{color:#666;font-weight:400}
  .meta{color:#666;font-size:13px}
  section{margin-top:16px}
</style>
</head>
<body>
<h1>pi-harness \u2014 baseRevision ${state.baseRevision}</h1>
<p class="meta">timestamp: ${esc(state.timestamp)} \u00b7 <a href="/api/harness">/api/harness</a> \u00b7 <a href="/api/health">/api/health</a></p>
<pre id="widget">${linesEsc}</pre>
${goalsHtml}
${featuresHtml}
<script>
(function(){
  var interval=2000;
  async function poll(){
    try{
      var r=await fetch("/api/harness",{cache:"no-store"});
      if(!r.ok) return;
      var j=await r.json();
      var pre=document.getElementById("widget");
      if(pre && Array.isArray(j.widgetLines)) pre.textContent=j.widgetLines.join("\\n");
      var h1=document.querySelector("h1");
      if(h1) h1.textContent="pi-harness \\u2014 baseRevision "+j.baseRevision;
    }catch(e){}
  }
  setInterval(poll, interval);
})();
</script>
</body>
</html>`;
}

// ── server ──────────────────────────────────────────────────────────────────
function getVersion(projectDir: string): string {
  try {
    const pkgPath = resolve(projectDir, "package.json");
    if (existsSync(pkgPath)) {
      const raw = readFileSync(pkgPath, "utf-8");
      const j = JSON.parse(raw);
      if (typeof j.version === "string" && j.version) return j.version;
    }
  } catch {}
  return "0.0.0";
}

export async function createRemoteServer(opts?: RemoteOptions): Promise<RemoteServer> {
  const projectDir = opts?.projectDir ? resolve(opts.projectDir) : process.cwd();
  const host = opts?.host ?? "127.0.0.1";
  const requestedPort = typeof opts?.port === "number" ? opts.port : 0;

  const server: Server = createServer((req, res) => {
    const method = (req.method ?? "GET").toUpperCase();
    const url = req.url ?? "/";
    const path = url.split("?")[0];

    if (method !== "GET") {
      res.writeHead(405, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ error: { code: "METHOD_NOT_ALLOWED", message: "Only GET allowed" } }));
      return;
    }

    if (path === "/" || path === "/index.html") {
      try {
        const state = buildRemoteState(projectDir);
        const html = buildHtml(state);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(html);
      } catch (e: any) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: { code: "INTERNAL", message: e?.message ?? String(e) } }));
      }
      return;
    }

    if (path === "/api/harness") {
      try {
        const state = buildRemoteState(projectDir);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify(state));
      } catch (e: any) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: { code: "INTERNAL", message: e?.message ?? String(e) } }));
      }
      return;
    }

    if (path === "/api/health") {
      const version = getVersion(projectDir);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, version }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found: " + path } }));
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });

  const addr = server.address() as any;
  const actualPort = typeof addr === "object" && addr !== null ? addr.port : requestedPort;
  const actualHost = typeof addr === "object" && addr !== null ? addr.address : host;
  const url = `http://${actualHost}:${actualPort}`;

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((err) => (err ? rejectClose(err) : resolveClose()));
    });
  }

  return { url, host: actualHost, port: actualPort, close };
}
