import assert from "node:assert/strict";
import {
  GOAL_SPEC_SCHEMA_VERSION,
  createGoalSpecification,
  validateGoalSpecification,
  goalSpecificationToMarkdown,
  GoalSpecificationError,
} from "../src/goalSpec.ts";

// --- create basic ---
{
  const spec = createGoalSpecification({ goalRunId: "run-1", originalGoal: "  ship a checklist app  " });
  assert.equal(spec.schemaVersion, 1);
  assert.equal(spec.schemaVersion, GOAL_SPEC_SCHEMA_VERSION);
  assert.equal(spec.goalRunId, "run-1");
  assert.equal(spec.originalGoal, "ship a checklist app");
  assert.equal(spec.summary, "ship a checklist app");
  assert.equal(spec.traceability.originalUserGoal, "ship a checklist app");
  assert.equal(spec.traceability.goalRunId, "run-1");
  assert.equal(spec.traceability.source, "user_goal");
  assert.ok(spec.createdAt);
  assert.ok(spec.updatedAt);
  // empty defaults
  assert.deepEqual(spec.scopedRequirements, { inScope: [], outOfScope: [], assumptions: [], openQuestions: [] });
  assert.deepEqual(spec.milestones, []);
  console.log("✓ createGoalSpecification defaults");
}

// --- create with summary + traceability source discovery_consolidation ---
{
  const spec = createGoalSpecification({
    goalRunId: "run-2",
    originalGoal: "goal with discovery",
    summary: "custom summary",
    traceability: { source: "discovery_consolidation", sourceArtifacts: [{ label: "artifact", path: "/tmp/foo" }] },
  });
  assert.equal(spec.summary, "custom summary");
  assert.equal(spec.traceability.source, "discovery_consolidation");
  assert.equal(spec.traceability.sourceArtifacts[0].label, "artifact");
  console.log("✓ create with discovery_consolidation");
}

// --- validate rejects bad schemaVersion ---
{
  const spec: any = createGoalSpecification({ goalRunId: "run-1", originalGoal: "hello" });
  spec.schemaVersion = 999;
  assert.throws(() => validateGoalSpecification(spec), GoalSpecificationError);
  console.log("✓ validate rejects bad schemaVersion");
}

// --- validate rejects traceability mismatch originalGoal ---
{
  const spec: any = createGoalSpecification({ goalRunId: "run-1", originalGoal: "hello" });
  spec.traceability.originalUserGoal = "different";
  assert.throws(() => validateGoalSpecification(spec), /traceability\.originalUserGoal/);
  console.log("✓ validate rejects traceability originalUserGoal mismatch");
}

// --- validate rejects traceability mismatch goalRunId ---
{
  const spec: any = createGoalSpecification({ goalRunId: "run-1", originalGoal: "hello" });
  spec.traceability.goalRunId = "other";
  assert.throws(() => validateGoalSpecification(spec), /traceability\.goalRunId/);
  console.log("✓ validate rejects traceability goalRunId mismatch");
}

// --- validate rejects invalid priority ---
{
  const spec: any = createGoalSpecification({ goalRunId: "run-1", originalGoal: "hello" });
  spec.scopedRequirements.inScope = [
    { id: "r1", title: "t", description: "d", priority: "invalid", acceptanceCriterionIds: [], milestoneIds: [] },
  ];
  assert.throws(() => validateGoalSpecification(spec), /priority/);
  console.log("✓ validate rejects invalid priority");
}

// --- validate rejects empty originalGoal / goalRunId on create ---
{
  assert.throws(() => createGoalSpecification({ goalRunId: "", originalGoal: "hello" }), /goalRunId/);
  assert.throws(() => createGoalSpecification({ goalRunId: "run-1", originalGoal: "   " }), /originalGoal/);
  console.log("✓ create rejects empty fields");
}

// --- goalSpecificationToMarkdown contains Spec markers ---
{
  const spec = createGoalSpecification({
    goalRunId: "run-md",
    originalGoal: "build me a todo app with categories",
    scopedRequirements: {
      inScope: [{ id: "r1", title: "CRUD", description: "Create items", priority: "must", acceptanceCriterionIds: ["ac1"], milestoneIds: ["m1"] }],
      outOfScope: [],
      assumptions: ["users have browser"],
      openQuestions: ["auth required?"],
    },
    milestones: [{ id: "m1", title: "MVP", description: "minimal", requirementIds: ["r1"], acceptanceCriterionIds: ["ac1"], doneWhen: ["tests pass"] }],
    acceptanceCriteria: [{ id: "ac1", description: "can create item", requirementIds: ["r1"], verificationGateIds: ["g1"] }],
    verificationGates: [{ id: "g1", title: "tests", description: "unit tests pass", required: true, successCriteria: ["exit 0"] }],
  });
  const md = goalSpecificationToMarkdown(spec);
  assert.ok(md.includes("## Persisted goal specification"), "md has heading");
  assert.ok(md.includes("Schema version: 1"), "md has schema version");
  assert.ok(md.includes("Goal run: run-md"), "md has run");
  assert.ok(md.includes("Original user goal: build me a todo app with categories"), "md has originalGoal");
  assert.ok(md.includes("### Scoped requirements"), "md has scoped");
  assert.ok(md.includes("### Milestones"), "md has milestones");
  assert.ok(md.includes("### Acceptance criteria"), "md has criteria");
  assert.ok(md.includes("### Verification gates"), "md has gates");
  assert.ok(md.includes("### Design constraints"), "md has design");
  assert.ok(md.includes("### Product constraints"), "md has product");
  assert.ok(md.includes("### Definition of done"), "md has done");
  assert.ok(md.includes("r1 (must): CRUD"), "md formats requirement");
  assert.ok(md.includes("m1: MVP"), "md formats milestone");
  console.log("✓ goalSpecificationToMarkdown markers");
}

// --- discovery_consolidation role output valid ---
{
  const spec = createGoalSpecification({
    goalRunId: "run-disc",
    originalGoal: "goal with discovery",
    discovery: {
      approach: "parallel roles",
      roleOutputs: [
        {
          role: "product_owner",
          title: "PO output",
          objective: "define scope",
          findings: ["finding"],
          decisions: ["decision"],
          risks: [],
          requirementIds: ["r1"],
          milestoneIds: ["m1"],
          acceptanceCriterionIds: ["ac1"],
          verificationGateIds: ["g1"],
          constraintIds: [],
        },
      ],
      consolidationNotes: ["note"],
    },
    traceability: { source: "discovery_consolidation" },
  });
  // should validate
  validateGoalSpecification(spec);
  const md = goalSpecificationToMarkdown(spec);
  assert.ok(md.includes("### Discovery planning"), "md has discovery");
  assert.ok(md.includes("PO output"), "md has role output");
  console.log("✓ discovery_consolidation valid");
}

// --- validateDiscoveryRole invalid role ---
{
  const spec: any = createGoalSpecification({ goalRunId: "run-1", originalGoal: "hello" });
  spec.discovery = {
    approach: "x",
    roleOutputs: [{ role: "invalid_role", title: "t", objective: "o", findings: [], decisions: [], risks: [], requirementIds: [], milestoneIds: [], acceptanceCriterionIds: [], verificationGateIds: [], constraintIds: [] }],
    consolidationNotes: [],
  };
  assert.throws(() => validateGoalSpecification(spec), /discovery planning role/);
  console.log("✓ validate rejects invalid discovery role");
}

console.log("All goalSpec tests PASS");
