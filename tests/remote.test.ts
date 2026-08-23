import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildApiPayload,
  buildHtml,
  buildRemoteState,
  createRemoteServer,
  escapeHtml,
} from "../src/remote.ts";
import { defaultConfig } from "../src/core/config.ts";
import type { HarnessConfig } from "../src/core/types.ts";

/**
 * A keep-alive socket pooled by undici from a previous server on the same
 * host:port can already be dead when the next server binds it; the first
 * request over it fails with "other side closed". Retry rather than let
 * connection pooling decide whether the suite passes.
 */
async function get(url: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  throw lastError;
}

function tmpProject(): string {
  const d = mkdtempSync(join(tmpdir(), "pi-remote-"));
  mkdirSync(join(d, "harness", "features"), { recursive: true });
  return d;
}

function writeFeatureList(dir: string, fl: any): void {
  writeFileSync(join(dir, "harness", "features", "feature-list.json"), JSON.stringify(fl, null, 2), "utf-8");
}

function writeConfig(dir: string, mutate: (c: HarnessConfig) => void = () => {}): void {
  const c = defaultConfig();
  mutate(c);
  writeFileSync(join(dir, "harness", "config.json"), JSON.stringify(c, null, 2), "utf-8");
}

function baseFeatureList(overrides?: any): any {
  return {
    version: "2.0",
    baseRevision: 7,
    goals: [{ id: "goal-001", title: "pi-harness v1.0 — superset visual harness", description: "test" }],
    sprints: [{ id: "sprint-005", name: "F5 — Remote", goalId: "goal-001" }],
    features: [
      {
        id: "feature-005",
        name: "Remote Read-Only Web View → 1.0.0",
        sprintId: "sprint-005",
        goalId: "goal-001",
        passes: false,
        tasks: [
          { id: "task-010", key: "remote-core", description: "Build src/remote.ts", status: "complete", dependsOn: [], subtasks: [] },
          { id: "task-011", key: "remote-wire", description: "Wire enforcer & bump", status: "pending", dependsOn: ["remote-core"], subtasks: [] },
        ],
      },
    ],
    ...(overrides ?? {}),
  };
}

// ── escapeHtml (re-exported for callers that build their own fragments) ─────
{
  assert.equal(escapeHtml(`a & b`), "a &amp; b");
  assert.equal(escapeHtml(`<x>"y"`), "&lt;x&gt;&quot;y&quot;");
  assert.equal(escapeHtml(`it's`), "it&#39;s");
  console.log("✓ escapeHtml");
}

// ── buildRemoteState: the snapshot the dashboard renders ───────────────────
{
  const dir = tmpProject();
  try {
    writeFeatureList(dir, baseFeatureList());
    writeConfig(dir, (c) => {
      c.currentPhase = "build";
      c.taskRetryCount = 3;
      c.maxRetries = 9;
    });

    const st = buildRemoteState(dir);
    assert.equal(st.baseRevision, 7, "baseRevision matches fixture");
    assert.ok(Array.isArray(st.features) && st.features.length === 1);
    assert.equal(st.features[0]!.id, "feature-005");
    assert.ok(Array.isArray(st.goals) && st.goals.length === 1);
    assert.equal(st.list.baseRevision, 7, "the whole plan comes along for the renderer");
    assert.equal(st.list.features[0]!.tasks.length, 2);

    // Progress is computed here so every consumer sees the same numbers.
    assert.equal(st.progress.tasksDone, 1);
    assert.equal(st.progress.tasksTotal, 2);
    assert.equal(st.progress.percent, 50);

    assert.equal(st.phase, "build", "the phase comes from the config, not the plan");
    assert.equal(st.paused, false);
    assert.deepEqual(st.enabledPhases, defaultConfig().phases.enabled);
    assert.deepEqual(st.retries, { task: 3, max: 9 });
    assert.equal(st.gate, null, "no gate has been recorded yet");
    assert.equal(st.router, null, "no model-router.json in this project");
    assert.equal(st.rework, null);
    assert.ok(typeof st.timestamp === "string" && new Date(st.timestamp).toISOString() === st.timestamp);
    console.log("✓ buildRemoteState shape: baseRevision, plan, progress, phase, retries, timestamp");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── buildRemoteState: the last recorded gate, never a fresh run ────────────
{
  const dir = tmpProject();
  try {
    writeFeatureList(dir, baseFeatureList());
    writeConfig(dir, (c) => {
      c.currentPhase = "build";
      c.commands.test = "exit 1"; // would fail if the gate were actually run
      c.gateHistory = [
        { phase: "define", result: "pass", timestamp: "2026-08-01T00:00:00.000Z" },
        { phase: "build", result: "fail", timestamp: "2026-08-02T00:00:00.000Z", feature: "feature-005", task: "remote-wire" },
      ];
    });

    const st = buildRemoteState(dir);
    assert.ok(st.gate, "the most recent verdict is reported");
    assert.equal(st.gate!.phase, "build", "the last entry wins, not the first");
    assert.equal(st.gate!.overall, false);
    assert.deepEqual(st.gate!.failures, ["see terminal for detail"]);
    assert.equal(st.gate!.feature, "feature-005");
    assert.equal(st.gate!.task, "remote-wire");
    assert.equal(st.gate!.checks.length, 1);
    assert.match(st.gate!.checks[0]!.name, /last recorded gate \(2026-08-02T00:00:00.000Z\)/);
    assert.match(st.gate!.checks[0]!.detail, /failed on build/);

    // Opening the page must not perturb the run: no gate history is appended.
    assert.equal(buildRemoteState(dir).gate!.checks.length, 1);
    const cfg = JSON.parse(readFileSync(join(dir, "harness", "config.json"), "utf-8"));
    assert.equal(cfg.gateHistory.length, 2, "reading the state records nothing");
    console.log("✓ buildRemoteState reports the last recorded gate without running one");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── buildRemoteState: missing plan -> empty state ──────────────────────────
{
  const dir = tmpProject();
  try {
    const st = buildRemoteState(dir);
    assert.equal(st.baseRevision, 0);
    assert.equal(st.features.length, 0);
    assert.deepEqual(st.goals, []);
    assert.equal(st.progress.tasksTotal, 0);
    assert.equal(st.phase, null, "an uninitialised project has no phase");
    assert.equal(st.paused, false);
    assert.ok(buildHtml(st).startsWith("<!doctype html>"), "an empty project still renders a page");
    console.log("✓ buildRemoteState missing file returns empty");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── router / rework side files are surfaced verbatim ───────────────────────
{
  const dir = tmpProject();
  try {
    writeFeatureList(dir, baseFeatureList());
    writeConfig(dir);
    writeFileSync(join(dir, "harness", "model-router.json"), JSON.stringify({ enabled: true, default: "m-1" }), "utf-8");
    writeFileSync(join(dir, "harness", "rework.json"), JSON.stringify({ active: true, impactedCount: 4 }), "utf-8");
    const st = buildRemoteState(dir);
    assert.deepEqual(st.router, { enabled: true, default: "m-1" });
    assert.deepEqual(st.rework, { active: true, impactedCount: 4 });
    const html = buildHtml(st);
    assert.match(html, /router/, "the router badge is rendered");
    assert.match(html, /4 impacted/, "the rework badge carries its one detail");

    // A corrupt side file must not take the page down.
    writeFileSync(join(dir, "harness", "rework.json"), "{ broken", "utf-8");
    assert.equal(buildRemoteState(dir).rework, null);
    console.log("✓ router/rework side files are surfaced and degrade safely");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── buildHtml: a self-contained page that escapes everything ───────────────
{
  const dir = tmpProject();
  try {
    const dangerous = baseFeatureList({
      features: [
        {
          id: "feature-005",
          name: "XSS <test>",
          sprintId: "sprint-005",
          tasks: [
            { id: "t1", key: "k1", description: `a & b <script>"x"</script>`, status: "pending", dependsOn: [], subtasks: [] },
          ],
        },
      ],
    });
    writeFeatureList(dir, dangerous);
    writeConfig(dir, (c) => {
      c.currentPhase = "build";
    });
    const st = buildRemoteState(dir);
    const html = buildHtml(st);
    assert.ok(html.includes("infinity-harness"), "html identifies the harness");
    assert.match(html, /rev 7/, "html shows the plan revision");
    assert.ok(!html.includes(`<script>"x"</script>`), "html escaped script");
    assert.ok(html.includes("&amp;") && html.includes("&lt;script&gt;"), "html escaped entities");
    assert.ok(html.includes("XSS &lt;test&gt;"), "the feature name is escaped, not stripped");
    assert.match(html, /fetch\(/, "the page polls itself");
    assert.ok(!html.includes("http://") && !html.includes("https://"), "no external references");
    console.log("✓ buildHtml escaping + self-contained page");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── buildApiPayload: compact, and no full plan ─────────────────────────────
{
  const dir = tmpProject();
  try {
    writeFeatureList(dir, baseFeatureList());
    writeConfig(dir, (c) => {
      c.currentPhase = "build";
    });
    const payload = buildApiPayload(buildRemoteState(dir));
    assert.equal(payload.baseRevision, 7);
    assert.equal(payload.phase, "build");
    assert.equal(payload.paused, false);
    assert.ok(!("list" in payload), "the full plan is left out to keep the payload small");
    const features = payload.features as any[];
    assert.equal(features.length, 1);
    assert.equal(features[0].tasks.length, 2);
    assert.equal(features[0].tasks[0].key, "remote-core");
    assert.deepEqual(features[0].tasks[1].dependsOn, ["remote-core"]);
    assert.equal(JSON.stringify(payload).length > 0, true);
    console.log("✓ buildApiPayload");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── createRemoteServer: ephemeral port shape + HTML + health ────────────────
{
  const dir = tmpProject();
  try {
    writeFeatureList(dir, baseFeatureList());
    writeConfig(dir, (c) => {
      c.currentPhase = "build";
    });
    const srv = await createRemoteServer({ projectDir: dir, host: "127.0.0.1", port: 0 });
    try {
      assert.ok(srv.url.startsWith("http://127.0.0.1:"), `url ${srv.url}`);
      assert.ok(srv.port > 0 && srv.port < 65536);

      // GET /api/harness shape
      const r1 = await get(`${srv.url}/api/harness`);
      assert.equal(r1.status, 200);
      const j1: any = await r1.json();
      assert.equal(j1.baseRevision, 7);
      assert.ok(Array.isArray(j1.features) && j1.features.length === 1);
      assert.equal(j1.progress.tasksTotal, 2);
      assert.equal(j1.phase, "build");
      assert.ok(typeof j1.timestamp === "string");
      const ct1 = r1.headers.get("content-type") ?? "";
      assert.ok(ct1.includes("application/json"));
      assert.equal(r1.headers.get("cache-control"), "no-store", "a dashboard must never be cached");

      // GET / serves the dashboard
      const r2 = await get(`${srv.url}/`);
      assert.equal(r2.status, 200);
      const html = await r2.text();
      assert.ok(html.includes("infinity-harness"), "GET / html identifies the harness");
      assert.ok(html.includes("Remote Read-Only Web View"), "GET / html shows the plan");
      assert.ok(html.includes(`rev ${j1.baseRevision}`), "GET / html mentions the revision");
      const ct2 = r2.headers.get("content-type") ?? "";
      assert.ok(ct2.includes("text/html"));
      // The page renders untrusted model output; the CSP is the second line of
      // defence behind escaping.
      const csp = r2.headers.get("content-security-policy") ?? "";
      assert.match(csp, /default-src 'none'/);
      assert.ok(!csp.includes("script-src 'self'"), "no remote script origin is allowed");
      assert.equal(r2.headers.get("x-content-type-options"), "nosniff");

      // GET /api/health
      const r3 = await get(`${srv.url}/api/health`);
      assert.equal(r3.status, 200);
      const j3: any = await r3.json();
      assert.equal(j3.ok, true);
      assert.ok(typeof j3.timestamp === "string");

      // HEAD is allowed; the surface is read-only, not GET-only.
      const rh = await get(`${srv.url}/api/health`, { method: "HEAD" });
      assert.equal(rh.status, 200);

      // 404 unknown
      const r4 = await get(`${srv.url}/not-here`);
      assert.equal(r4.status, 404);

      // 405 POST rejected — nothing here writes.
      const r5 = await get(`${srv.url}/api/harness`, { method: "POST" });
      assert.equal(r5.status, 405);
      assert.equal(r5.headers.get("allow"), "GET, HEAD");
      const r6 = await get(`${srv.url}/`, { method: "DELETE" });
      assert.equal(r6.status, 405);

      console.log("✓ createRemoteServer ephemeral port shape + HTML + health + 404/405");
    } finally {
      await srv.close();
      await srv.close(); // second close no throw
      console.log("✓ close frees port (idempotent)");
      // verify port freed: can bind same port again quickly
      const srv2 = await createRemoteServer({ projectDir: dir, host: "127.0.0.1", port: srv.port });
      const r = await get(`${srv2.url}/api/harness`);
      assert.equal(r.status, 200);
      await srv2.close();
      console.log("✓ close frees port -> re-bind same port works");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── a non-loopback bind has to be asked for explicitly ─────────────────────
{
  const dir = tmpProject();
  const prior = process.env.INFINITY_HARNESS_ALLOW_REMOTE;
  try {
    delete process.env.INFINITY_HARNESS_ALLOW_REMOTE;
    await assert.rejects(
      () => createRemoteServer({ projectDir: dir, host: "0.0.0.0", port: 0 }),
      /refusing to bind the dashboard to 0.0.0.0/,
      "the page exposes source paths and task text",
    );
    console.log("✓ non-loopback binds are refused by default");
  } finally {
    if (prior === undefined) delete process.env.INFINITY_HARNESS_ALLOW_REMOTE;
    else process.env.INFINITY_HARNESS_ALLOW_REMOTE = prior;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── concurrent fetches x5 serialized ────────────────────────────────────────
{
  const dir = tmpProject();
  try {
    writeFeatureList(dir, baseFeatureList());
    const srv = await createRemoteServer({ projectDir: dir, host: "127.0.0.1", port: 0 });
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => get(`${srv.url}/api/harness`).then((r) => r.json())),
      );
      for (const j of results) assert.equal((j as any).baseRevision, 7);
      console.log("✓ concurrent fetches x5 serialized (all same baseRevision)");
    } finally {
      await srv.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── read-only: repeated reads do not mutate baseRevision / file ─────────────
{
  const dir = tmpProject();
  try {
    const fl = baseFeatureList();
    writeFeatureList(dir, fl);
    writeConfig(dir, (c) => {
      c.currentPhase = "build";
    });
    const planBefore = readFileSync(join(dir, "harness", "features", "feature-list.json"), "utf-8");
    const configBefore = readFileSync(join(dir, "harness", "config.json"), "utf-8");
    const srv = await createRemoteServer({ projectDir: dir, host: "127.0.0.1", port: 0 });
    try {
      for (let i = 0; i < 3; i++) {
        const j: any = await get(`${srv.url}/api/harness`).then((r) => r.json());
        assert.equal(j.baseRevision, 7);
        await get(`${srv.url}/`).then((r) => r.text());
      }
      assert.equal(
        readFileSync(join(dir, "harness", "features", "feature-list.json"), "utf-8"),
        planBefore,
        "the plan file is byte-identical after serving the dashboard",
      );
      assert.equal(
        readFileSync(join(dir, "harness", "config.json"), "utf-8"),
        configBefore,
        "the config file is byte-identical too — no gate history, no counters",
      );
      console.log("✓ read-only: GETs do not mutate any harness file");
    } finally {
      await srv.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("All remote tests PASS");
