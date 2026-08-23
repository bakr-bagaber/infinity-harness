/**
 * infinity-harness — cross-process file locking.
 *
 * Parallel workers all write the same plan file. Without mutual exclusion,
 * two writers that both read revision N both pass the `baseRevision` check and
 * both write N+1 — one set of edits vanishes. `baseRevision` detects a stale
 * *read*; it cannot serialise a read-modify-write. Only a lock can.
 *
 * Two flavours, deliberately:
 *
 *   - `withLockSync` wraps the plan's read-apply-write in one atomic section.
 *     It is synchronous because the critical section is, and it **fails
 *     closed**: if the lock cannot be taken, the write is refused rather than
 *     racing. Losing an edit silently is worse than an error the caller can
 *     retry.
 *   - `withLock` is the async, best-effort variant for coarse advisory
 *     locking where proceeding un-locked is acceptable.
 *
 * Both hold the lock only for the duration of the work, never across a turn.
 * An earlier version took a lock at the start of an agent turn with an
 * 8-second staleness timeout, so every turn longer than 8 seconds left a lock
 * another process was entitled to steal.
 */

import { dirname } from "node:path";
import { mkdirSync, rmdirSync, statSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { ensureDir, fileExists, writeTextAtomic } from "./fsx.ts";

export type LockHandle = { release: () => Promise<void> };

/** A lock held longer than this is assumed to belong to a dead process. */
export const STALE_MS = 30_000;
export const RETRIES = 12;
export const RETRY_MIN_MS = 20;
/** Total time `withLockSync` will wait before refusing. */
export const SYNC_LOCK_TIMEOUT_MS = 10_000;

export class LockTimeoutError extends Error {
  override readonly name = "LockTimeoutError";
  constructor(path: string, waitedMs: number) {
    super(
      `could not lock ${path} after ${waitedMs}ms — another process is holding it. ` +
        `Retry; if this persists, remove ${path}.ilock`,
    );
    Object.setPrototypeOf(this, LockTimeoutError.prototype);
  }
}

// ── Synchronous lock ────────────────────────────────────────────────────────

/**
 * Lock directory name.
 *
 * Deliberately NOT `<path>.lock` — that is exactly what `proper-lockfile`
 * uses, and it is a directory there too. Sharing the name means a caller that
 * wraps `withLock` around something that calls `withLockSync` deadlocks
 * against itself: it holds the async lock, then blocks the event loop waiting
 * for the same directory it already owns, until the timeout fires. Distinct
 * names make nesting the two merely redundant instead of fatal.
 */
function lockDirFor(path: string): string {
  return `${path}.ilock`;
}

/**
 * Block the current thread for `ms`.
 *
 * `Atomics.wait` on a never-notified buffer is the only real synchronous sleep
 * in Node. Busy-waiting on `Date.now()` would spin a core, and the critical
 * sections here are short enough that blocking is the right trade.
 */
function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function isStale(lockDir: string): boolean {
  try {
    return Date.now() - statSync(lockDir).mtimeMs > STALE_MS;
  } catch {
    // Vanished between the EEXIST and the stat — treat as free.
    return true;
  }
}

function breakStaleLock(lockDir: string): void {
  try {
    for (const entry of readdirSync(lockDir)) {
      try {
        unlinkSync(`${lockDir}/${entry}`);
      } catch {
        /* best effort */
      }
    }
    rmdirSync(lockDir);
  } catch {
    // Another process broke it first, or it is no longer stale. Either way the
    // next acquire attempt settles it.
  }
}

/**
 * Run `fn` while holding an exclusive lock on `path`.
 *
 * `mkdir` is the primitive: it either creates the directory or fails with
 * EEXIST, atomically, on every filesystem we care about — unlike a
 * check-then-create on a lock *file*, which has the same race we are trying to
 * close.
 *
 * @throws LockTimeoutError when the lock cannot be acquired in time.
 */
export function withLockSync<T>(path: string, fn: () => T, timeoutMs = SYNC_LOCK_TIMEOUT_MS): T {
  const lockDir = lockDirFor(path);
  ensureDir(dirname(path));

  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  let backoff = RETRY_MIN_MS;

  while (!acquired) {
    try {
      mkdirSync(lockDir);
      acquired = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (isStale(lockDir)) {
        breakStaleLock(lockDir);
        continue;
      }
      if (Date.now() >= deadline) throw new LockTimeoutError(path, timeoutMs);
      sleepSync(Math.min(backoff, 250));
      backoff = Math.min(backoff * 2, 250);
    }
  }

  try {
    // Owner marker: purely diagnostic, so a stuck lock names a pid.
    try {
      writeFileSync(`${lockDir}/owner`, `${process.pid}\n`, "utf-8");
    } catch {
      /* the directory is the lock; the marker is a nicety */
    }
    return fn();
  } finally {
    breakStaleLock(lockDir);
  }
}

// ── Asynchronous, best-effort lock ──────────────────────────────────────────

/**
 * Run `fn` while holding an advisory lock on `path`.
 *
 * Best-effort by design: if the lock cannot be acquired, `fn` still runs and
 * `locked` reports false. Use this only where an interleave is tolerable —
 * never for a read-modify-write. Plan writes use `withLockSync`.
 */
export async function withLock<T>(
  path: string,
  fn: () => Promise<T> | T,
): Promise<{ value: T; locked: boolean }> {
  const handle = await acquire(path);
  try {
    const value = await fn();
    return { value, locked: handle !== null };
  } finally {
    if (handle) {
      try {
        await handle.release();
      } catch {
        /* the lock times out on its own */
      }
    }
  }
}

async function acquire(path: string): Promise<LockHandle | null> {
  try {
    ensureDir(dirname(path));
    // proper-lockfile refuses to lock a path that does not exist.
    if (!fileExists(path)) writeTextAtomic(path, "");
    const lockfile = await import("proper-lockfile");
    const release = await lockfile.lock(path, {
      retries: { retries: RETRIES, minTimeout: RETRY_MIN_MS, maxTimeout: 500, factor: 1.6 },
      stale: STALE_MS,
      realpath: false,
    });
    return { release: async () => release() };
  } catch {
    return null;
  }
}
