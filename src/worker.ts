/**
 * worker — isolated worker per BUILD task with attempt history
 *
 * Pure helpers for `tmp/infinity-harness/<run-id>/<feature>/<task>/attempt-N/`
 * Uses `proper-lockfile` on `harness/features/feature-list.json` and
 * `harness/config.json` so concurrent workers do not corrupt `baseRevision`.
 * The plan itself is read here and never written: `src/taskList.ts` is its only
 * writer, and the only place that has to preserve unknown task fields.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { spawn, execSync } from "node:child_process";

// ── constants ───────────────────────────────────────────────────────────────
export const WORKER_ROOT_SEGMENT = "tmp/infinity-harness";
export const PROMPT_FILE = "prompt.md";
export const OUTPUT_FILE = "output.log";
export const FINGERPRINT_FILE = "fingerprint.json";

// ── hashLite + fingerprint ─────────────────────────────────────────────────
export function hashLite(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

export type Fingerprint = {
  runId: string;
  featureId: string;
  taskId: string;
  attempt: number;
  baseRevision: number;
  timestamp: string;
  gitHead?: string;
  featureListHash?: number;
  extra?: Record<string, unknown>;
};

function sanitizeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "unknown";
}

function gitHeadSync(projectDir: string): string | undefined {
  try {
    const out = execSync("git rev-parse HEAD 2>/dev/null", { cwd: projectDir, encoding: "utf-8" }) as string;
    return out.trim().slice(0, 40) || undefined;
  } catch {
    return undefined;
  }
}

function readBaseRevision(projectDir: string): number {
  try {
    const p = resolve(projectDir, "harness", "features", "feature-list.json");
    if (!existsSync(p)) return 0;
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    return typeof raw.baseRevision === "number" ? raw.baseRevision : 0;
  } catch {
    return 0;
  }
}

export function buildFingerprint(opts: {
  projectDir?: string;
  runId: string;
  featureId: string;
  taskId: string;
  attempt: number;
  baseRevision?: number;
  extra?: Record<string, unknown>;
}): Fingerprint {
  const projectDir = opts.projectDir ?? process.cwd();
  const baseRevision = opts.baseRevision ?? readBaseRevision(projectDir);
  let featureListHash: number | undefined;
  try {
    const p = resolve(projectDir, "harness", "features", "feature-list.json");
    if (existsSync(p)) featureListHash = hashLite(readFileSync(p, "utf-8"));
  } catch {}
  return {
    runId: opts.runId,
    featureId: opts.featureId,
    taskId: opts.taskId,
    attempt: opts.attempt,
    baseRevision,
    timestamp: new Date().toISOString(),
    gitHead: gitHeadSync(projectDir),
    featureListHash,
    ...(opts.extra ? { extra: opts.extra } : {}),
  };
}

// ── worker dirs ─────────────────────────────────────────────────────────────
export function getWorkerRoot(projectDir = process.cwd()): string {
  return resolve(projectDir, WORKER_ROOT_SEGMENT);
}

export function getTaskRoot(
  projectDir: string,
  runId: string,
  featureId: string,
  taskId: string,
): string {
  return join(getWorkerRoot(projectDir), sanitizeSegment(runId), sanitizeSegment(featureId), sanitizeSegment(taskId));
}

export function getAttemptDir(
  projectDir: string,
  runId: string,
  featureId: string,
  taskId: string,
  attempt: number,
): string {
  return join(getTaskRoot(projectDir, runId, featureId, taskId), `attempt-${attempt}`);
}

export function getNextAttemptNumber(taskRoot: string): number {
  if (!existsSync(taskRoot)) return 1;
  let max = 0;
  try {
    const entries = readdirSync(taskRoot, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const m = e.name.match(/^attempt-(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
  } catch {}
  return max + 1;
}

export function createWorkerRunDir(
  projectDir: string,
  runId: string,
  featureId: string,
  taskId: string,
  attempt?: number,
): string {
  const taskRoot = getTaskRoot(projectDir, runId, featureId, taskId);
  mkdirSync(taskRoot, { recursive: true });
  const n = attempt ?? getNextAttemptNumber(taskRoot);
  const dir = getAttemptDir(projectDir, runId, featureId, taskId, n);
  mkdirSync(dir, { recursive: true });
  // ensure parent exists
  mkdirSync(dirname(dir), { recursive: true });
  return dir;
}

// ── lock helpers (proper-lockfile) ────────────────────────────────────────
async function withLock<T>(targetPath: string, fn: () => Promise<T> | T): Promise<T> {
  let release: (() => Promise<void>) | null = null;
  try {
    // dynamic import to stay tsc-clean without @types/proper-lockfile
    const mod: any = await import("proper-lockfile");
    const lockfile = mod.default ?? mod;
    // ensure file exists (lockfile requires it)
    const dir = dirname(targetPath);
    mkdirSync(dir, { recursive: true });
    if (!existsSync(targetPath)) writeFileSync(targetPath, "", "utf-8");
    // lock expects file, not dir; use retries for concurrency
    release = (await lockfile.lock(targetPath, { retries: { retries: 8, minTimeout: 20, maxTimeout: 80 }, stale: 10000, realpath: false })) as any;
  } catch {
    // if lock unavailable, proceed without lock (best-effort for tests)
    release = null;
  }
  try {
    return await fn();
  } finally {
    if (release) {
      try {
        await (release as any)();
      } catch {}
    }
  }
}

export async function withFeatureListLock<T>(projectDir: string, fn: () => Promise<T> | T): Promise<T> {
  const p = resolve(projectDir, "harness", "features", "feature-list.json");
  return withLock(p, fn);
}

export async function withConfigLock<T>(projectDir: string, fn: () => Promise<T> | T): Promise<T> {
  const p = resolve(projectDir, "harness", "config.json");
  return withLock(p, fn);
}

export async function withHarnessLocks<T>(projectDir: string, fn: () => Promise<T> | T): Promise<T> {
  // lock feature-list then config sequentially to avoid deadlock; proper-lockfile is per-file
  return withFeatureListLock(projectDir, () => withConfigLock(projectDir, fn));
}

// ── attempt history ─────────────────────────────────────────────────────────
export type RecordAttemptInput = {
  prompt: string;
  output: string;
  fingerprint: Fingerprint;
  baseRevision?: number;
};

export function recordAttempt(attemptDir: string, input: RecordAttemptInput): { promptPath: string; outputPath: string; fingerprintPath: string } {
  mkdirSync(attemptDir, { recursive: true });
  const promptPath = join(attemptDir, PROMPT_FILE);
  const outputPath = join(attemptDir, OUTPUT_FILE);
  const fingerprintPath = join(attemptDir, FINGERPRINT_FILE);
  writeFileSync(promptPath, input.prompt, "utf-8");
  writeFileSync(outputPath, input.output, "utf-8");
  const fp: Fingerprint & { baseRevision: number } = {
    ...input.fingerprint,
    baseRevision: input.baseRevision ?? input.fingerprint.baseRevision,
  };
  writeFileSync(fingerprintPath, JSON.stringify(fp, null, 2) + "\n", "utf-8");
  return { promptPath, outputPath, fingerprintPath };
}

// Convenience: create dir + record in one call, returning attemptDir
export function createAndRecordAttempt(
  projectDir: string,
  runId: string,
  featureId: string,
  taskId: string,
  input: RecordAttemptInput & { attempt?: number },
): { attemptDir: string; attempt: number; fingerprint: Fingerprint } {
  const taskRoot = getTaskRoot(projectDir, runId, featureId, taskId);
  const attempt = input.attempt ?? getNextAttemptNumber(taskRoot);
  const attemptDir = getAttemptDir(projectDir, runId, featureId, taskId, attempt);
  const fingerprint: Fingerprint = {
    ...input.fingerprint,
    attempt,
    baseRevision: input.baseRevision ?? input.fingerprint.baseRevision,
  };
  recordAttempt(attemptDir, { prompt: input.prompt, output: input.output, fingerprint });
  return { attemptDir, attempt, fingerprint };
}

// ── isolated worker spawn ───────────────────────────────────────────────────
export type SpawnWorkerOpts = {
  projectDir?: string;
  runId: string;
  featureId: string;
  taskId: string;
  prompt: string;
  /**
   * Shell command to run isolated. Use `{promptfile}` placeholder if needed
   * by tooling. If omitted, worker just records the attempt without spawning.
   */
  command?: string;
  timeoutMs?: number;
  attempt?: number;
  /** Optional model override recorded in fingerprint.extra.model and injected into pi --model if applicable */
  model?: string;
};

export type SpawnWorkerResult = {
  attemptDir: string;
  attempt: number;
  fingerprint: Fingerprint;
  exitCode: number | null;
  output: string;
  timedOut?: boolean;
};

function renderCommand(template: string, promptFile: string): string {
  return template.replaceAll("{promptfile}", promptFile).replaceAll("{prompt}", `"$(cat ${promptFile})"`);
}

/**
 * A model reference is interpolated into a shell command, so anything outside
 * the characters a real reference uses is refused rather than escaped. The
 * value comes from a config file a human edits; a typo should not become a
 * command substitution.
 */
const MODEL_REF_RE = /^[A-Za-z0-9._:@\/-]{1,120}$/;

export function safeModelRef(model: string | undefined): string | null {
  const v = (model ?? "").trim();
  if (!v) return null;
  return MODEL_REF_RE.test(v) ? v : null;
}

export async function spawnIsolatedWorker(opts: SpawnWorkerOpts): Promise<SpawnWorkerResult> {
  const projectDir = opts.projectDir ?? process.cwd();
  const baseRevision = readBaseRevision(projectDir);
  const taskRoot = getTaskRoot(projectDir, opts.runId, opts.featureId, opts.taskId);
  const attempt = opts.attempt ?? getNextAttemptNumber(taskRoot);
  const attemptDir = getAttemptDir(projectDir, opts.runId, opts.featureId, opts.taskId, attempt);
  mkdirSync(attemptDir, { recursive: true });

  const fingerprint = buildFingerprint({
    projectDir,
    runId: opts.runId,
    featureId: opts.featureId,
    taskId: opts.taskId,
    attempt,
    baseRevision,
    ...(opts.model ? { extra: { model: opts.model } } : {}),
  });

  // Always write prompt.md upfront so attempt history exists even if spawn fails
  const promptPath = join(attemptDir, PROMPT_FILE);
  writeFileSync(promptPath, opts.prompt, "utf-8");

  if (!opts.command) {
    // No command — record attempt with empty output (useful for unit tests)
    const r = recordAttempt(attemptDir, { prompt: opts.prompt, output: "", fingerprint });
    return { attemptDir, attempt, fingerprint, exitCode: 0, output: "" };
  }

  let cmd = renderCommand(opts.command, promptPath);
  // An empty model means "inherit whatever model pi is already on" — the
  // router's default — so no flag is injected at all.
  const model = safeModelRef(opts.model);
  if (model && cmd.includes(" pi ") && !cmd.includes("--model")) {
    cmd = cmd.replace(" pi ", ` pi --model ${model} `);
  } else if (model && cmd.startsWith("pi ") && !cmd.includes("--model")) {
    cmd = cmd.replace("pi ", `pi --model ${model} `);
  }
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;

  const result = await new Promise<{ exitCode: number | null; output: string; timedOut?: boolean }>((resolveP) => {
    const child = spawn(cmd, { cwd: projectDir, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const onData = (d: Buffer) => {
      out = (out + d.toString()).slice(-20000);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ exitCode: code, output: out, timedOut: timedOut || undefined });
    });
    child.on("error", (e: any) => {
      clearTimeout(timer);
      resolveP({ exitCode: -1, output: (out + "\n" + e.message).slice(-20000) });
    });
  });

  // Record final output + fingerprint
  recordAttempt(attemptDir, { prompt: opts.prompt, output: result.output, fingerprint });

  return { attemptDir, attempt, fingerprint, exitCode: result.exitCode, output: result.output, timedOut: result.timedOut };
}
