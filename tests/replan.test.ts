import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { amendPlan, loadReplanHistory, clearReplanHistory } from "../src/replan.ts";

function tmpProject(): string {
  const d = mkdtempSync(join(tmpdir(), "pi-replan-"));
  mkdirSync(join(d, "harness", "features"), { recursive: true });
  return d;
}
function writeFeatureList(dir: string, tasks: any[], baseRevision = 0) {
  const features = [{ id: "feature-006", name: "F", passes: false, tasks }];
  writeFileSync(join(dir, "harness", "features", "feature-list.json"), JSON.stringify({ version: "0.1", baseRevision, features, goals: [], sprints: [] }, null, 2));
  writeFileSync(join(dir, "harness", "config.json"), JSON.stringify({ replan: { maxReplans: 10 } }, null, 2));
}

// --- amendPlan adds task, bumps, guards cycle/missing, maxReplans ---
{
  const proj = tmpProject();
  try {
    writeFeatureList(proj, [
      { id: "task-012", key: "schema-rework", description: "A", status: "complete", dependsOn: [] },
    ], 2);
    // add task
    let res = await amendPlan({ projectDir: proj, reason: "add feature", addFeatures: [{ id: "feature-007", name: "NewF", tasks: [{ id: "task-014", key: "router-core", description: "C", status: "pending", dependsOn: [] }] }] });
    assert.equal(res.added.features, 1);
    assert.equal(res.baseRevision, 3);
    // add task to existing feature
    res = await amendPlan({ projectDir: proj, reason: "add task", addTasks: [{ featureId: "feature-006", task: { id: "task-013", key: "rework-replan", description: "B", status: "pending", dependsOn: ["schema-rework"] } }] });
    assert.equal(res.added.tasks, 1);
    assert.equal(res.baseRevision, 4);
    // cycle rejected - add tasks that create cycle
    try {
      await amendPlan({ projectDir: proj, addTasks: [
        { featureId: "feature-006", task: { id: "task-015", key: "cyc-a", description: "Cyc", status: "pending", dependsOn: ["cyc-b"] } },
        { featureId: "feature-006", task: { id: "task-016", key: "cyc-b", description: "CycB", status: "pending", dependsOn: ["cyc-a"] } },
      ]});
      assert.fail("expected cycle");
    } catch (e:any) { assert.match(e.message, /cycle/); }
    // missing dep rejected
    try {
      await amendPlan({ projectDir: proj, addTasks: [{ featureId: "feature-006", task: { id: "task-017", key: "bad", description: "Bad", status: "pending", dependsOn: ["nonexistent"] } }] });
      assert.fail("expected missing");
    } catch (e:any) { assert.match(e.message, /missing|references/); }
    // maxReplans guard - separate project with max 2
    {
      const proj2 = tmpProject();
      try {
        writeFileSync(join(proj2, "harness", "config.json"), JSON.stringify({ replan: { maxReplans: 2 } }, null, 2));
        writeFileSync(join(proj2, "harness", "features", "feature-list.json"), JSON.stringify({ version: "0.1", baseRevision: 0, features: [{ id: "feature-006", name: "F", passes: false, tasks: [{ id: "task-012", key: "schema-rework", description: "A", status: "complete", dependsOn: [] }] }], goals: [], sprints: [] }, null, 2));
        await amendPlan({ projectDir: proj2, addTasks: [{ featureId: "feature-006", task: { id: "task-013", key: "rework-replan", description: "B2", status: "pending", dependsOn: ["schema-rework"] } }] });
        await amendPlan({ projectDir: proj2, addTasks: [{ featureId: "feature-006", task: { id: "task-014", key: "router-core", description: "C", status: "pending" } }] });
        try {
          await amendPlan({ projectDir: proj2, addTasks: [{ featureId: "feature-006", task: { id: "task-018", key: "extra", description: "Extra", status: "pending" } }] });
          assert.fail("expected maxReplans");
        } catch (e:any) { assert.match(e.message, /maxReplans/); }
      } finally { rmSync(proj2, { recursive: true, force: true }); }
    }
    // history
    const hist = loadReplanHistory(proj);
    assert.equal(hist.length, 2);
    await clearReplanHistory(proj);
    assert.ok(!existsSync(join(proj, "harness/replan.json")));
    assert.deepEqual(loadReplanHistory(proj), []);
    console.log("✓ amendPlan add, bump, cycle/missing, maxReplans, history");
  } finally { rmSync(proj, { recursive: true, force: true }); }
}

// --- a status alias is not an unresolved dependency ---
// This module used to parse feature-list.json raw, so a task stored as "done"
// never compared equal to "complete" and validateDeps rejected every amendment
// to a plan that used an alias — with the nonsense message that a task in
// flight had unresolved dependencies. Plan reads now go through the core
// loader, which normalises aliases on the way in.
{
  const proj = tmpProject();
  try {
    writeFeatureList(proj, [
      { id: "task-012", key: "schema-rework", description: "A", status: "done", dependsOn: [] },
      { id: "task-013", key: "rework-replan", description: "B", status: "in_progress", dependsOn: ["schema-rework"] },
    ], 1);
    const res = await amendPlan({
      projectDir: proj,
      reason: "alias",
      addTasks: [{ featureId: "feature-006", task: { id: "task-014", key: "router-core", description: "C", status: "pending" } }],
    });
    assert.equal(res.added.tasks, 1, "an aliased status must not read as an unresolved dependency");
    assert.equal(res.baseRevision, 2);
    const file = JSON.parse(readFileSync(join(proj, "harness", "features", "feature-list.json"), "utf-8"));
    const statuses = new Map(file.features[0].tasks.map((t: any) => [t.key, t.status]));
    assert.equal(statuses.get("schema-rework"), "complete", '"done" is normalised to the canonical status on write');
    assert.equal(statuses.get("rework-replan"), "in_progress", "the dependent is left where it was");
    console.log("✓ status aliases normalise instead of failing dependency validation");
  } finally { rmSync(proj, { recursive: true, force: true }); }
}

console.log("All replan tests PASS");
