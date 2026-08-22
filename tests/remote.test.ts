import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRemoteState, buildHtml, escapeHtml, createRemoteServer } from "../src/remote.ts";

function tmpProject(): string {
  const d = mkdtempSync(join(tmpdir(), "pi-remote-"));
  mkdirSync(join(d, "harness", "features"), { recursive: true });
  return d;
}

function writeFeatureList(dir: string, fl: any): void {
  writeFileSync(join(dir, "harness", "features", "feature-list.json"), JSON.stringify(fl, null, 2), "utf-8");
}

function baseFeatureList(overrides?: any): any {
  return {
    version: "0.1",
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

// ── escapeHtml ──────────────────────────────────────────────────────────────
{
  assert.equal(escapeHtml(`a & b`), "a &amp; b");
  assert.equal(escapeHtml(`<x>"y"`), "&lt;x&gt;&quot;y&quot;");
  assert.equal(escapeHtml(`it's`), "it&#39;s");
  console.log("✓ escapeHtml");
}

// ── buildRemoteState: reads baseRevision, features, widgetLines ─────────────
{
  const dir = tmpProject();
  try {
    writeFeatureList(dir, baseFeatureList());
    const st = buildRemoteState(dir);
    assert.equal(st.baseRevision, 7, "baseRevision matches fixture");
    assert.ok(Array.isArray(st.features) && st.features.length === 1);
    assert.ok(Array.isArray(st.widgetLines) && st.widgetLines.length > 0);
    assert.ok(typeof st.timestamp === "string" && new Date(st.timestamp).toISOString() === st.timestamp);
    const hasProgress = st.widgetLines.some((l) => l.includes("Progress:"));
    assert.ok(hasProgress, "widgetLines contains Progress");
    const hasFeature = st.widgetLines.some((l) => l.includes("Feature:"));
    assert.ok(hasFeature, "widgetLines contains Feature");
    console.log("✓ buildRemoteState shape baseRevision/widgetLines/timestamp");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── buildRemoteState: missing file -> empty state baseRevision 0 ────────────
{
  const dir = tmpProject();
  try {
    const st = buildRemoteState(dir);
    assert.equal(st.baseRevision, 0);
    assert.equal(st.features.length, 0);
    assert.ok(Array.isArray(st.widgetLines));
    console.log("✓ buildRemoteState missing file returns empty");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── buildHtml: contains pi-harness + baseRevision + escaping ────────────────
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
    const st = buildRemoteState(dir);
    const html = buildHtml(st);
    assert.ok(html.includes("pi-harness"), "html contains pi-harness");
    assert.ok(html.includes(`baseRevision 7`) || html.includes("baseRevision"), "html contains baseRevision");
    assert.ok(!html.includes(`<script>"x"</script>`), "html escaped script");
    assert.ok(html.includes("&amp;") && html.includes("&lt;script&gt;"), "html escaped entities");
    assert.ok(html.includes(`fetch("/api/harness"`) || html.includes("fetch"), "html contains polling fetch");
    console.log("✓ buildHtml escaping + pi-harness + baseRevision");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── createRemoteServer: ephemeral port shape + HTML + health ────────────────
{
  const dir = tmpProject();
  try {
    writeFeatureList(dir, baseFeatureList());
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pi-harness", version: "0.5.0" }), "utf-8");
    const srv = await createRemoteServer({ projectDir: dir, host: "127.0.0.1", port: 0 });
    try {
      assert.ok(srv.url.startsWith("http://127.0.0.1:"), `url ${srv.url}`);
      assert.ok(srv.port > 0 && srv.port < 65536);

      // GET /api/harness shape
      const r1 = await fetch(`${srv.url}/api/harness`);
      assert.equal(r1.status, 200);
      const j1: any = await r1.json();
      assert.equal(j1.baseRevision, 7);
      assert.ok(Array.isArray(j1.features) && j1.features.length === 1);
      assert.ok(Array.isArray(j1.widgetLines) && j1.widgetLines.length > 0);
      assert.ok(typeof j1.timestamp === "string");
      const ct1 = r1.headers.get("content-type") ?? "";
      assert.ok(ct1.includes("application/json"));

      // GET / serves HTML containing pi-harness + Progress/Todos
      const r2 = await fetch(`${srv.url}/`);
      assert.equal(r2.status, 200);
      const html = await r2.text();
      assert.ok(html.includes("pi-harness"), "GET / html has pi-harness");
      assert.ok(html.includes("widget") || html.includes("Progress"), "GET / html has widget/Progress");
      assert.ok(html.includes(String(j1.baseRevision)), "GET / html mentions baseRevision");
      const ct2 = r2.headers.get("content-type") ?? "";
      assert.ok(ct2.includes("text/html"));

      // GET /api/health
      const r3 = await fetch(`${srv.url}/api/health`);
      assert.equal(r3.status, 200);
      const j3: any = await r3.json();
      assert.equal(j3.ok, true);
      assert.equal(j3.version, "0.5.0");

      // 404 unknown
      const r4 = await fetch(`${srv.url}/not-here`);
      assert.equal(r4.status, 404);

      // 405 POST rejected
      const r5 = await fetch(`${srv.url}/api/harness`, { method: "POST" });
      assert.equal(r5.status, 405);

      console.log("✓ createRemoteServer ephemeral port shape + HTML + health + 404/405");
    } finally {
      await srv.close();
      await srv.close(); // second close no throw
      console.log("✓ close frees port (idempotent)");
      // verify port freed: can bind same port again quickly
      const srv2 = await createRemoteServer({ projectDir: dir, host: "127.0.0.1", port: srv.port });
      const r = await fetch(`${srv2.url}/api/harness`);
      assert.equal(r.status, 200);
      await srv2.close();
      console.log("✓ close frees port -> re-bind same port works");
    }
  } finally {
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
        Array.from({ length: 5 }, () => fetch(`${srv.url}/api/harness`).then((r) => r.json())),
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
    const srv = await createRemoteServer({ projectDir: dir, host: "127.0.0.1", port: 0 });
    try {
      for (let i = 0; i < 3; i++) {
        const j: any = await fetch(`${srv.url}/api/harness`).then((r) => r.json());
        assert.equal(j.baseRevision, 7);
      }
      const after = JSON.parse(readFileSync(join(dir, "harness", "features", "feature-list.json"), "utf-8"));
      assert.equal(after.baseRevision, 7, "file baseRevision unchanged after reads");
      console.log("✓ read-only baseRevision not mutated by GETs");
    } finally {
      await srv.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("All remote tests PASS");
