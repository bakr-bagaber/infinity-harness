/**
 * infinity-harness — bounded command execution.
 *
 * Every shell-out in the harness goes through here so that a hung lint or an
 * infinite test loop cannot wedge a multi-day run. `run` never throws: a
 * non-zero exit, a timeout, and a missing binary are all reported as data.
 */

import { spawn } from "node:child_process";

export type RunResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Command could not be started at all (ENOENT, EACCES, …). */
  spawnError: string | null;
  durationMs: number;
};

export const DEFAULT_TIMEOUT_MS = 30_000;
export const LONG_TIMEOUT_MS = 300_000;

/** Cap captured output so a runaway process cannot exhaust memory. */
const MAX_CAPTURE_BYTES = 512 * 1024;

export async function run(
  command: string,
  opts: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; shell?: boolean } = { cwd: process.cwd() },
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();

  return new Promise<RunResult>((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(command, {
      cwd: opts.cwd,
      shell: opts.shell ?? true,
      env: opts.env ?? process.env,
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs);

    const settle = (code: number | null, spawnError: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        ok: !timedOut && spawnError === null && code === 0,
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
        spawnError,
        durationMs: Date.now() - started,
      });
    };

    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < MAX_CAPTURE_BYTES) stdout += d.toString("utf-8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < MAX_CAPTURE_BYTES) stderr += d.toString("utf-8");
    });
    child.on("error", (e: Error) => settle(null, e.message));
    child.on("close", (code) => settle(code, null));
  });
}

// ── git helpers ─────────────────────────────────────────────────────────────

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await run("git rev-parse --is-inside-work-tree", { cwd, timeoutMs: 10_000 });
  return r.ok && r.stdout.trim() === "true";
}

export async function gitBranch(cwd: string): Promise<string | null> {
  const r = await run("git rev-parse --abbrev-ref HEAD", { cwd, timeoutMs: 10_000 });
  return r.ok ? r.stdout.trim() : null;
}

export async function gitIsClean(cwd: string): Promise<boolean> {
  const r = await run("git status --porcelain", { cwd, timeoutMs: 15_000 });
  // A failed git call must not be reported as "clean" — that would let a
  // git-clean gate pass on a repo the harness cannot actually inspect.
  if (!r.ok) return false;
  return r.stdout.trim() === "";
}

/** True when the working tree has *any* uncommitted change. Inverse of clean. */
export async function gitHasChanges(cwd: string): Promise<boolean> {
  const r = await run("git status --porcelain", { cwd, timeoutMs: 15_000 });
  if (!r.ok) return false;
  return r.stdout.trim() !== "";
}

export async function gitHasUpstream(cwd: string): Promise<boolean> {
  const r = await run("git rev-parse --abbrev-ref --symbolic-full-name @{u}", { cwd, timeoutMs: 10_000 });
  return r.ok && r.stdout.trim() !== "";
}

export async function gitLastCommitMessage(cwd: string): Promise<string | null> {
  const r = await run("git log -1 --pretty=%s", { cwd, timeoutMs: 10_000 });
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

export async function gitHasTag(cwd: string): Promise<boolean> {
  const r = await run("git tag --points-at HEAD", { cwd, timeoutMs: 10_000 });
  return r.ok && r.stdout.trim() !== "";
}

export async function gitBehindUpstream(cwd: string): Promise<number | null> {
  const r = await run("git rev-list --count HEAD..@{u}", { cwd, timeoutMs: 15_000 });
  if (!r.ok) return null;
  const n = Number.parseInt(r.stdout.trim(), 10);
  return Number.isNaN(n) ? null : n;
}
