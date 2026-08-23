import assert from "node:assert/strict";
import { escapeHtml, renderDashboard, type DashboardState } from "../src/ui/dashboard.ts";
import type { FeatureList, GateResult, Task, TaskStatus } from "../src/core/types.ts";

function mkTask(id: string, status: TaskStatus, extra: Record<string, unknown> = {}): Task {
  return { id, description: `Do ${id}`, status, dependsOn: [], subtasks: [], ...extra };
}

function baseState(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    list: {
      version: "2.0",
      baseRevision: 7,
      goals: [{ id: "goal-001", title: "Ship the harness" }],
      sprints: [{ id: "sprint-001", name: "S1", goalId: "goal-001" }],
      features: [
        {
          id: "feature-001",
          name: "The first feature",
          description: "does a thing",
          sprintId: "sprint-001",
          goalId: "goal-001",
          passes: false,
          tasks: [
            mkTask("task-1", "complete"),
            mkTask("task-2", "in_progress", {
              key: "explicit-key",
              dependsOn: ["task-1"],
              difficulty: "difficult",
              subtasks: [
                { id: "st-1", title: "first subtask", status: "complete" },
                { id: "st-2", title: "second subtask", status: "pending" },
              ],
            }),
            mkTask("task-3", "blocked"),
            mkTask("task-4", "rework"),
            mkTask("task-5", "pending"),
          ],
        },
      ],
    },
    phase: "build",
    enabledPhases: null,
    paused: false,
    gate: null,
    baseRevision: 7,
    timestamp: "2026-08-23T10:11:12.000Z",
    retries: { task: 2, max: 10 },
    ...overrides,
  };
}

// ── escapeHtml ─────────────────────────────────────────────────────────────
{
  assert.equal(escapeHtml("a & b"), "a &amp; b");
  assert.equal(escapeHtml("<script>"), "&lt;script&gt;");
  assert.equal(escapeHtml('say "hi"'), "say &quot;hi&quot;");
  assert.equal(escapeHtml("it's"), "it&#39;s");
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;", "all five, in one pass");
  assert.equal(escapeHtml("plain text 42"), "plain text 42", "innocent text is untouched");
  assert.equal(escapeHtml(""), "");

  // The ampersand must be escaped first, or every other entity is double-broken.
  assert.equal(escapeHtml("&lt;"), "&amp;lt;", "an already-escaped entity is escaped again, not decoded");
  assert.equal(escapeHtml("&amp;amp;"), "&amp;amp;amp;");

  // The type says string, but these values come out of JSON.parse of files the
  // harness does not control.
  assert.equal(escapeHtml(42 as unknown as string), "42");
  assert.equal(escapeHtml(null as unknown as string), "null");
  assert.equal(escapeHtml(undefined as unknown as string), "undefined");
  assert.equal(escapeHtml({ toString: () => "<x>" } as unknown as string), "&lt;x&gt;");

  // Attribute-breaking characters are covered, so the same helper is safe in
  // both element text and quoted attribute values.
  for (const c of ['"', "'", "<", ">", "&"]) {
    assert.ok(!escapeHtml(`v${c}v`).includes(c) || c === "&", `${c} must not survive escaping`);
  }
  console.log("✓ escapeHtml covers & < > \" '");
}

// ── renderDashboard produces a complete, self-contained document ───────────
{
  const html = renderDashboard(baseState());

  assert.ok(html.startsWith("<!doctype html>"), "a complete document, not a fragment");
  assert.ok(html.trimEnd().endsWith("</html>"));
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /<title>[^<]*BUILD[^<]*<\/title>/, "the tab title carries the phase");
  assert.match(html, /<style>/);
  assert.match(html, /<script>/);
  assert.match(html, /<\/body>\n<\/html>/);

  // Self-contained: the page is served from a localhost server with no asset
  // routes, so any external reference is a broken page (or a privacy leak).
  assert.ok(!html.includes("http://"), "no http:// reference anywhere in the document");
  assert.ok(!html.includes("https://"), "no https:// reference anywhere in the document");
  assert.ok(!/<link[^>]+href="(?!data:)/.test(html), "the only <link> is the inline data: favicon");
  assert.ok(!/<img/.test(html), "no remote images");
  assert.ok(!/<script[^>]+src=/.test(html), "no external scripts");
  assert.ok(!/@import/.test(html), "no imported stylesheets");
  assert.match(html, /<link rel="icon" href="data:,">/, "the favicon is inline so the server never 404s");

  // The state the human came to read.
  assert.match(html, /Ship the harness/, "the goal");
  assert.match(html, /The first feature/, "the feature");
  assert.match(html, /Do task-2/, "the task descriptions");
  assert.match(html, /first subtask/, "subtasks of the active task");
  assert.match(html, /rev 7/, "the plan revision");
  assert.match(html, /1 blocked task/, "the alert strip counts blocked work");
  assert.match(html, /1 in rework/);
  assert.match(html, /retry budget 2 \/ 10/);
  assert.match(html, /2026-08-23 10:11:12Z/, "the state timestamp");
  assert.match(html, /#1/, "dependencies are labelled by plan position");

  assert.match(html, /second subtask/, "the active task's subtasks are all listed");
  console.log("✓ renderDashboard produces a complete self-contained document");
}

// ── XSS: every interpolated value comes back escaped ───────────────────────
{
  const goalPayload = `<script>alert('goal')</script>`;
  const taskPayload = `<script>alert("task")</script>`;
  const gatePayload = `<script>alert(1)</script>`;
  const featurePayload = `<img src=x onerror="alert('feature')">`;
  const subtaskPayload = `<script>alert('sub')</script>`;

  const gate: GateResult = {
    phase: "build",
    overall: false,
    failures: [`<script>alert('failure')</script>`],
    checks: [
      {
        name: `<script>alert('name')</script>`,
        pass: false,
        detail: gatePayload,
      },
    ],
  };

  const list: FeatureList = {
    version: "2.0",
    baseRevision: 1,
    goals: [{ id: "goal-001", title: goalPayload, description: `" onmouseover="alert(1)` }],
    sprints: [{ id: "sprint-001", name: `</span><script>alert('sprint')</script>` }],
    features: [
      {
        id: `feature-001`,
        name: featurePayload,
        description: `<b>bold</b>`,
        sprintId: "sprint-001",
        goalId: "goal-001",
        passes: false,
        tasks: [
          mkTask("task-1", "in_progress", {
            description: taskPayload,
            difficulty: `<script>alert('difficulty')</script>`,
            dependsOn: [`<script>alert('dep')</script>`],
            subtasks: [{ id: "st-1", title: subtaskPayload, status: "pending" }],
          }),
        ],
      },
    ],
  };

  const html = renderDashboard(baseState({ list, gate, phase: "build" }));

  // Nothing executable survives.
  assert.ok(!html.includes("<script>alert"), "no injected <script> tag survives");
  assert.ok(!html.includes(goalPayload), "the goal title payload is not echoed raw");
  assert.ok(!html.includes(taskPayload), "the task description payload is not echoed raw");
  assert.ok(!html.includes(gatePayload), "the gate check detail payload is not echoed raw");
  assert.ok(!html.includes(featurePayload), "the feature name payload is not echoed raw");
  assert.ok(!html.includes(subtaskPayload), "the subtask payload is not echoed raw");
  // The escaped text still reads "onerror=", which is fine — what matters is
  // that no quote survives to close an attribute and open a handler.
  assert.ok(!html.includes(`onerror="`), "no event handler is smuggled through an attribute");
  assert.ok(!html.includes(`onmouseover="`), "no attribute break-out through the goal description");
  assert.ok(!html.includes("<b>bold</b>"), "even harmless markup is escaped, not rendered");

  // The only <script> in the document is the one the renderer itself emits.
  assert.equal(html.split("<script>").length - 1, 1, "exactly one script tag: the polling loop");

  // …and the text is still there, escaped, so the human can see what happened.
  assert.ok(html.includes("&lt;script&gt;alert(&#39;goal&#39;)&lt;/script&gt;"), "the goal payload is shown escaped");
  assert.ok(html.includes("&lt;script&gt;alert(&quot;task&quot;)&lt;/script&gt;"), "the task payload is shown escaped");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "the gate detail is shown escaped");
  assert.ok(html.includes("&lt;img src=x onerror=&quot;"), "the feature payload is shown escaped");

  // A dangling dependency reference prints verbatim (escaped) rather than
  // being hidden — it is a real planning bug.
  assert.ok(html.includes("&lt;script&gt;alert(&#39;dep&#39;)&lt;/script&gt;"));
  console.log("✓ XSS payloads in goal, task, subtask and gate detail come back escaped");
}

// ── degenerate states still render a page ──────────────────────────────────
{
  const empty = renderDashboard({
    list: { version: "2.0", baseRevision: 0, features: [] },
    phase: null,
    baseRevision: 0,
    timestamp: "not-a-timestamp",
  });
  assert.ok(empty.startsWith("<!doctype html>"));
  assert.match(empty, /No plan yet/);
  assert.match(empty, /not started/, "an un-started run says so");
  assert.match(empty, /not-a-timestamp/, "an unparseable timestamp is shown as-is rather than as Invalid Date");
  assert.ok(!empty.includes("NaN"), "no NaN leaks into the page");

  // Junk statuses must not take the page down — a monitoring page that 500s
  // because one task has a typo is worse than useless.
  const junk = renderDashboard(
    baseState({
      list: {
        version: "2.0",
        baseRevision: 1,
        features: [
          {
            id: "f",
            name: "F",
            tasks: [
              { id: "a", description: "A", status: "nonsense" as TaskStatus },
              { id: "b", description: "B", status: "done" as TaskStatus, subtasks: null as never },
              { id: "c", description: "C", status: "in-progress" as TaskStatus, dependsOn: null as never },
            ],
          },
        ],
      },
    }),
  );
  assert.ok(junk.startsWith("<!doctype html>"));
  assert.match(junk, /pending/, "an unknown status degrades to pending");
  assert.match(junk, /complete/, "the legacy alias is normalised so the meter and the list agree");
  assert.ok(!junk.includes("NaN"));
  assert.ok(!junk.includes("undefined%"), "no broken width style");

  // Paused is stated plainly.
  const paused = renderDashboard(baseState({ paused: true }));
  assert.match(paused, /paused/);
  assert.match(paused, /<title>PAUSED · BUILD/);
  console.log("✓ empty, junk and paused states still render");
}

// ── the numbers on the page agree with each other ──────────────────────────
{
  const html = renderDashboard(baseState());
  // 1 of 5 tasks complete.
  assert.match(html, /<span class="count">1<\/span><span class="count-of"> \/ 5<\/span> tasks/);
  assert.match(html, /<div class="pct">20<span class="pct-sign">%<\/span><\/div>/);
  assert.match(html, /<span class="pct-inline">20%<\/span>/, "the masthead percentage matches the meter");
  assert.match(html, /<title>BUILD · 20% · infinity-harness<\/title>/);
  assert.match(html, /<span class="feature-count mono">1\/5<\/span>/, "the per-feature count agrees too");
  console.log("✓ the progress numbers agree across the page");
}

console.log("All dashboard tests PASS");
