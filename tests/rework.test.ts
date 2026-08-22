import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeImpact, startRework, loadRework, clearRework } from "../src/rework.ts";

function tmpProject(): string {
  const d = mkdtempSync(join(tmpdir(), "pi-rework-"));
  mkdirSync(join(d, "harness", "features"), { recursive: true });
  return d;
}
function writeFeatureList(dir: string, tasks: any[], baseRevision = 0) {
  const features = [{ id: "feature-006", name: "F", passes: false, tasks }];
  writeFileSync(join(dir, "harness", "features", "feature-list.json"), JSON.stringify({ version: "0.1", baseRevision, features, goals: [], sprints: [] }, null, 2));
  writeFileSync(join(dir, "harness", "config.json"), JSON.stringify({ rework: { maxReworks: 3, maxImpactDepth: 3 } }, null, 2));
}

// --- computeImpact respects maxDepth and transitive ---
{
  const tasks = [
    { id: "a", key: "a", description: "A", status: "complete", dependsOn: [] },
    { id: "b", key: "b", description: "B", status: "pending", dependsOn: ["a"] },
    { id: "c", key: "c", description: "C", status: "pending", dependsOn: ["b"] },
    { id: "d", key: "d", description: "D", status: "pending", dependsOn: ["a"] },
    { id: "e", key: "e", description: "E", status: "pending", dependsOn: ["c"] },
  ];
  let impacted = computeImpact(tasks, "a", 1);
  assert.deepEqual(new Set(impacted), new Set(["b", "d"]), "depth 1 from a -> b,d");
  impacted = computeImpact(tasks, "a", 2);
  assert.deepEqual(new Set(impacted), new Set(["b", "d", "c"]), "depth2 adds c via b");
  impacted = computeImpact(tasks, "a", 3);
  assert.ok(impacted.includes("e"), "depth3 includes e");
  impacted = computeImpact(tasks, "b", 1);
  assert.deepEqual(impacted, ["c"]);
  console.log("✓ computeImpact BFS depth");
}

// --- startRework flips origin+impacted to rework, bumps baseRevision, writes rework.json ---
{
  const proj = tmpProject();
  try {
    writeFeatureList(proj, [
      { id: "task-012", key: "schema-rework", description: "A", status: "complete", dependsOn: [] },
      { id: "task-013", key: "rework-replan", description: "B", status: "pending", dependsOn: ["schema-rework"] },
      { id: "task-014", key: "router-core", description: "C", status: "pending", dependsOn: ["rework-replan"] },
    ], 2);
    const beforeRev = JSON.parse(readFileSync(join(proj, "harness", "features", "feature-list.json"), "utf-8")).baseRevision;
    const res = await startRework({ projectDir: proj, featureId: "feature-006", taskId: "schema-rework", reason: "test", maxImpactDepth: 1 });
    assert.ok(res.impacted.includes("rework-replan"), "depth1 impacts rework-replan");
    assert.ok(!res.impacted.includes("router-core"), "depth1 not router-core");
    assert.equal(res.baseRevision, beforeRev + 1, "baseRevision bump");
    const file = JSON.parse(readFileSync(join(proj, "harness", "features", "feature-list.json"), "utf-8"));
    const statuses = new Map(file.features[0].tasks.map((t: any) => [t.key, t.status]));
    assert.equal(statuses.get("schema-rework"), "rework", "origin rework");
    assert.equal(statuses.get("rework-replan"), "rework", "impacted rework");
    assert.equal(statuses.get("router-core"), "pending", "beyond depth stays pending");
    // rework.json
    assert.ok(existsSync(join(proj, "harness", "rework.json")));
    const rw = JSON.parse(readFileSync(join(proj, "harness", "rework.json"), "utf-8"));
    const rec = rw.history ? rw.history[rw.history.length-1] : rw;
    assert.equal(rec.returnFeature, "feature-006");
    assert.equal(rec.returnTask, "schema-rework");
    assert.deepEqual(rec.impacted, ["rework-replan"]);
    assert.ok(rec.timestamp);
    // loadRework
    const loaded = loadRework(proj);
    assert.ok(loaded);
    assert.equal(loaded!.returnTask, "schema-rework");
    // second call increments history and counts toward maxReworks guard
    await startRework({ projectDir: proj, featureId: "feature-006", taskId: "router-core", reason: "second", maxImpactDepth: 1 });
    const rw2 = JSON.parse(readFileSync(join(proj, "harness", "rework.json"), "utf-8"));
    assert.ok(rw2.history && rw2.history.length === 2, "history 2");
    // third ok, fourth should exceed max 3
    await startRework({ projectDir: proj, featureId: "feature-006", taskId: "router-core", reason: "third", maxImpactDepth: 1 });
    try {
      await startRework({ projectDir: proj, featureId: "feature-006", taskId: "schema-rework", reason: "fourth overflow" });
      assert.fail("expected maxReworks guard");
    } catch (e: any) {
      assert.match(e.message, /maxReworks/);
    }
    // clearRework
    await clearRework(proj);
    assert.ok(!existsSync(join(proj, "harness", "rework.json")));
    assert.equal(loadRework(proj), null);
    console.log("✓ startRework flips, bumps, rework.json, guard, clear");
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
}

// --- id vs key resolution and composite key ---
{
  const proj = tmpProject();
  try {
    writeFeatureList(proj, [
      { id: "task-012", key: "schema-rework", description: "A", status: "complete", dependsOn: [] },
      { id: "task-013", key: "rework-replan", description: "B", status: "pending", dependsOn: ["schema-rework"] },
    ], 5);
    const res = await startRework({ projectDir: proj, featureId: "feature-006", taskId: "task-012", maxImpactDepth: 3 });
    // task-012 id resolves to key schema-rework
    const file = JSON.parse(readFileSync(join(proj, "harness", "features", "feature-list.json"), "utf-8"));
    assert.equal(file.features[0].tasks.find((t:any)=>t.id==="task-012").status, "rework");
    assert.equal(file.baseRevision, 6);
    console.log("✓ id->key resolution via startRework");
  } finally { rmSync(proj, { recursive: true, force: true }); }
}

console.log("All rework tests PASS");
