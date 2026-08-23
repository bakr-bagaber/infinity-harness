import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  hashLite,
  buildFingerprint,
  getWorkerRoot,
  getTaskRoot,
  getAttemptDir,
  getNextAttemptNumber,
  createWorkerRunDir,
  recordAttempt,
  createAndRecordAttempt,
  spawnIsolatedWorker,
  withFeatureListLock,
  withHarnessLocks,
  WORKER_ROOT_SEGMENT,
  PROMPT_FILE,
  OUTPUT_FILE,
  FINGERPRINT_FILE,
} from "../src/worker.ts";

function tmpProject(): string {
  const d = mkdtempSync(join(tmpdir(), "pi-worker-"));
  mkdirSync(join(d, "harness", "features"), { recursive: true });
  return d;
}

// --- constants & hashLite ---
assert.equal(WORKER_ROOT_SEGMENT, "tmp/pi-harness");
assert.equal(PROMPT_FILE, "prompt.md");
assert.equal(OUTPUT_FILE, "output.log");
assert.equal(FINGERPRINT_FILE, "fingerprint.json");
assert.equal(hashLite(""), 0);
{
  const h1 = hashLite("hello");
  const h2 = hashLite("hello");
  assert.equal(h1, h2, "deterministic");
  assert.notEqual(hashLite("hello"), hashLite("world"));
  console.log("✓ hashLite deterministic");
}

// --- getWorkerRoot / getTaskRoot / getAttemptDir ---
{
  const root = getWorkerRoot("/tmp/proj");
  assert.equal(root, resolve("/tmp/proj", "tmp/pi-harness"));
  const taskRoot = getTaskRoot("/tmp/proj", "run-1", "feature-003", "task-005");
  assert.ok(taskRoot.includes("run-1") && taskRoot.includes("feature-003") && taskRoot.includes("task-005"));
  const attemptDir = getAttemptDir("/tmp/proj", "run-1", "feature-003", "task-005", 2);
  assert.ok(attemptDir.endsWith("attempt-2"));
  console.log("✓ worker dir helpers");
}

// --- createWorkerRunDir + getNextAttemptNumber increment ---
{
  const proj = tmpProject();
  try {
    // first attempt
    const d1 = createWorkerRunDir(proj, "run-xyz", "feature-003", "task-005");
    assert.ok(existsSync(d1), "attempt-1 exists");
    assert.ok(d1.endsWith("attempt-1"));
    // second call without explicit attempt -> attempt-2
    const d2 = createWorkerRunDir(proj, "run-xyz", "feature-003", "task-005");
    assert.ok(d2.endsWith("attempt-2"));
    assert.ok(existsSync(d2));
    // explicit attempt
    const d5 = createWorkerRunDir(proj, "run-xyz", "feature-003", "task-005", 5);
    assert.ok(d5.endsWith("attempt-5"));
    // getNextAttemptNumber should be 6 (max 5 +1)
    const taskRoot = getTaskRoot(proj, "run-xyz", "feature-003", "task-005");
    assert.equal(getNextAttemptNumber(taskRoot), 6);
    console.log("✓ createWorkerRunDir increments");
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
}

// --- recordAttempt writes three files ---
{
  const proj = tmpProject();
  try {
    const dir = createWorkerRunDir(proj, "run-a", "f-1", "t-1");
    const fp = buildFingerprint({ projectDir: proj, runId: "run-a", featureId: "f-1", taskId: "t-1", attempt: 1, baseRevision: 2 });
    const res = recordAttempt(dir, { prompt: "hello prompt", output: "hello output", fingerprint: fp });
    assert.ok(existsSync(res.promptPath));
    assert.ok(existsSync(res.outputPath));
    assert.ok(existsSync(res.fingerprintPath));
    assert.equal(readFileSync(res.promptPath, "utf-8"), "hello prompt");
    assert.equal(readFileSync(res.outputPath, "utf-8"), "hello output");
    const saved = JSON.parse(readFileSync(res.fingerprintPath, "utf-8"));
    assert.equal(saved.runId, "run-a");
    assert.equal(saved.baseRevision, 2);
    assert.equal(saved.attempt, 1);
    console.log("✓ recordAttempt writes prompt/output/fingerprint");
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
}

// --- createAndRecordAttempt convenience ---
{
  const proj = tmpProject();
  try {
    const fp = buildFingerprint({ projectDir: proj, runId: "run-b", featureId: "feat-2", taskId: "task-006", attempt: 1, baseRevision: 0 });
    const { attemptDir, attempt, fingerprint } = createAndRecordAttempt(proj, "run-b", "feat-2", "task-006", {
      prompt: "p",
      output: "o",
      fingerprint: fp,
    });
    assert.equal(attempt, 1);
    assert.ok(existsSync(join(attemptDir, "prompt.md")));
    assert.equal(fingerprint.attempt, 1);
    // second call increments
    const r2 = createAndRecordAttempt(proj, "run-b", "feat-2", "task-006", { prompt: "p2", output: "o2", fingerprint: fp });
    assert.equal(r2.attempt, 2);
    console.log("✓ createAndRecordAttempt increments");
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
}

// --- buildFingerprint preserves baseRevision & featureListHash ---
{
  const proj = tmpProject();
  try {
    // write feature-list with baseRevision 7 to test reading
    writeFileSync(
      join(proj, "harness", "features", "feature-list.json"),
      JSON.stringify({ version: "0.1", baseRevision: 7, features: [] }, null, 2),
    );
    const fp = buildFingerprint({ projectDir: proj, runId: "run-c", featureId: "f", taskId: "t", attempt: 1 });
    assert.equal(fp.baseRevision, 7, "reads baseRevision from file");
    assert.ok(typeof fp.timestamp === "string" && fp.timestamp.includes("T"), "timestamp iso");
    assert.ok(typeof fp.featureListHash === "number");
    // explicit baseRevision overrides file
    const fp2 = buildFingerprint({ projectDir: proj, runId: "run-c", featureId: "f", taskId: "t", attempt: 2, baseRevision: 42 });
    assert.equal(fp2.baseRevision, 42);
    console.log("✓ buildFingerprint preserves baseRevision");
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
}

// --- baseRevision preserved through file helpers (integration with taskList) ---
{
  const proj = tmpProject();
  try {
    // Use the plan editor to create a file, then fingerprint should see its revision
    const { writeTaskList } = await import("../src/taskList.ts");
    // initial file rev 0 -> create task
    const r1 = writeTaskList(proj, { tasks: [{ key: "a", subject: "A", status: "pending" }] });
    assert.equal(r1.revision, 1);
    const fp = buildFingerprint({ projectDir: proj, runId: "run-d", featureId: "f", taskId: "t", attempt: 1 });
    assert.equal(fp.baseRevision, 1);
    // worker dir should not corrupt file
    const dir = createWorkerRunDir(proj, "run-d", "f", "t");
    const fp2 = buildFingerprint({ projectDir: proj, runId: "run-d", featureId: "f", taskId: "t", attempt: 1, baseRevision: 1 });
    recordAttempt(dir, { prompt: "p", output: "done", fingerprint: fp2 });
    // file still rev 1
    const after = JSON.parse(readFileSync(join(proj, "harness", "features", "feature-list.json"), "utf-8"));
    assert.equal(after.baseRevision, 1, "worker attempt does not corrupt baseRevision");
    console.log("✓ baseRevision preserved after worker record");
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
}

// --- proper-lockfile: concurrent workers do not corrupt baseRevision ---
{
  const proj = tmpProject();
  try {
    const { writeTaskList } = await import("../src/taskList.ts");
    writeTaskList(proj, { tasks: [{ key: "a", subject: "A", status: "pending" }] });
    // simulate two workers trying to update concurrently with lock
    const worker = async (id: number) => {
      return withFeatureListLock(proj, async () => {
        // read, apply, write under lock
        const before = JSON.parse(readFileSync(join(proj, "harness", "features", "feature-list.json"), "utf-8"));
        const rev = before.baseRevision;
        // small delay to increase race window
        await new Promise((r) => setTimeout(r, 10));
        // try to apply with current rev; one will succeed, other may see stale if not re-read
        // For this test, we just verify lock serializes: we do a simple file write under lock
        const p = join(proj, "harness", "features", "feature-list.json");
        const cur = JSON.parse(readFileSync(p, "utf-8"));
        cur.baseRevision = cur.baseRevision + 1;
        cur.features[0].tasks.push({ id: `c${id}`, key: `c${id}`, description: `C${id}`, status: "pending", dependsOn: [] });
        writeFileSync(p, JSON.stringify(cur, null, 2));
        return cur.baseRevision;
      });
    };
    const [r1, r2] = await Promise.all([worker(1), worker(2)]);
    const final = JSON.parse(readFileSync(join(proj, "harness", "features", "feature-list.json"), "utf-8"));
    // Both should have succeeded sequentially due to lock, final rev = initial 1 + 2 = 3
    assert.equal(final.baseRevision, 3, `expected rev 3 after two locked writes, got ${final.baseRevision} r1=${r1} r2=${r2}`);
    assert.equal(final.features[0].tasks.length, 3, "both tasks present");
    console.log("✓ proper-lockfile concurrent writes serialized");
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
}

// --- withHarnessLocks also works (locks both files) ---
{
  const proj = tmpProject();
  try {
    writeFileSync(join(proj, "harness", "config.json"), JSON.stringify({ phase: "build" }, null, 2));
    writeFileSync(join(proj, "harness", "features", "feature-list.json"), JSON.stringify({ version: "0.1", baseRevision: 0, features: [] }, null, 2));
    let ran = false;
    await withHarnessLocks(proj, async () => {
      ran = true;
      assert.ok(existsSync(join(proj, "harness", "features", "feature-list.json")));
      assert.ok(existsSync(join(proj, "harness", "config.json")));
    });
    assert.ok(ran);
    console.log("✓ withHarnessLocks");
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
}

// --- spawnIsolatedWorker: no command just records ---
{
  const proj = tmpProject();
  try {
    const res = await spawnIsolatedWorker({
      projectDir: proj,
      runId: "run-e",
      featureId: "feature-003",
      taskId: "task-005",
      prompt: "do the thing",
    });
    assert.ok(existsSync(join(res.attemptDir, "prompt.md")));
    assert.equal(readFileSync(join(res.attemptDir, "prompt.md"), "utf-8"), "do the thing");
    assert.equal(res.exitCode, 0);
    assert.equal(res.fingerprint.runId, "run-e");
    assert.equal(res.attempt, 1);
    // second spawn increments to 2
    const res2 = await spawnIsolatedWorker({
      projectDir: proj,
      runId: "run-e",
      featureId: "feature-003",
      taskId: "task-005",
      prompt: "second",
    });
    assert.equal(res2.attempt, 2);
    assert.ok(res2.attemptDir.endsWith("attempt-2"));
    console.log("✓ spawnIsolatedWorker no-command records");
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
}

// --- spawnIsolatedWorker with command writes output.log ---
{
  const proj = tmpProject();
  try {
    const res = await spawnIsolatedWorker({
      projectDir: proj,
      runId: "run-f",
      featureId: "feature-003",
      taskId: "task-005",
      prompt: "echo test",
      command: "echo hello-worker",
      timeoutMs: 5000,
    });
    assert.ok(existsSync(join(res.attemptDir, "output.log")));
    const out = readFileSync(join(res.attemptDir, "output.log"), "utf-8");
    assert.ok(out.includes("hello-worker"), `output should contain hello-worker, got ${out}`);
    assert.equal(res.exitCode, 0);
    console.log("✓ spawnIsolatedWorker with command writes output.log");
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
}

// --- fingerprint.json is valid JSON with required fields ---
{
  const proj = tmpProject();
  try {
    const res = await spawnIsolatedWorker({
      projectDir: proj,
      runId: "run-g",
      featureId: "feature-003",
      taskId: "task-005",
      prompt: "p",
      command: "echo ok",
    });
    const fpPath = join(res.attemptDir, "fingerprint.json");
    assert.ok(existsSync(fpPath));
    const fp = JSON.parse(readFileSync(fpPath, "utf-8"));
    assert.equal(fp.runId, "run-g");
    assert.equal(fp.featureId, "feature-003");
    assert.equal(fp.taskId, "task-005");
    assert.equal(typeof fp.baseRevision, "number");
    assert.ok(fp.timestamp);
    // gitHead may be undefined in temp repo without git, thats ok
    console.log("✓ fingerprint.json valid");
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
}

// --- tmp/pi-harness isolation does not corrupt harness files ---
{
  const proj = tmpProject();
  try {
    const { writeTaskList } = await import("../src/taskList.ts");
    writeTaskList(proj, { tasks: [{ key: "a", subject: "A", status: "pending" }] });
    const before = readFileSync(join(proj, "harness", "features", "feature-list.json"), "utf-8");
    const res = await spawnIsolatedWorker({
      projectDir: proj,
      runId: "run-h",
      featureId: "feature-003",
      taskId: "task-005",
      prompt: "isolated",
      command: "echo isolated",
    });
    const after = readFileSync(join(proj, "harness", "features", "feature-list.json"), "utf-8");
    assert.equal(before, after, "feature-list.json untouched by isolated worker");
    assert.ok(res.attemptDir.includes("tmp/pi-harness"));
    console.log("✓ tmp/pi-harness isolated from harness files");
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
}

console.log("All worker tests PASS");
