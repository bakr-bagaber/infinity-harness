/**
 * infinity-harness — cross-process file locking.
 *
 * Parallel workers all write the same plan file. Without a lock, two writes
 * that both read revision N produce two revision N+1 files and one set of
 * edits vanishes.
 *
 * The rule that keeps this safe over a multi-day run: **hold the lock only
 * around the write itself**. An earlier version took the lock at the start of
 * an agent turn and released it at the end, with an 8-second staleness
 * timeout — so any turn longer than 8 seconds (which is all of them) left a
 * lock another process was entitled to steal. Critical sections here are
 * measured in milliseconds, so the staleness window is never reached in
 * normal operation and genuinely reflects a crashed holder.
 */

import { dirname } from "node:path";
import { ensureDir, fileExists, writeTextAtomic } from "./fsx.ts";

export type LockHandle = { release: () => Promise<void> };

/** A lock left behind this long is assumed to belong to a dead process. */
export const STALE_MS = 30_000;
export const RETRIES = 12;
export const RETRY_MIN_MS = 20;

/**
 * Run `fn` while holding an exclusive lock on `path`.
 *
 * Always releases, including when `fn` throws. If the lock cannot be
 * acquired, `fn` still runs — a harness that refuses to record progress
 * because of a stuck lock is worse than one that risks a rare interleave, and
 * the `baseRevision` check is the real correctness guarantee. The caller is
 * told which happened via the `locked` flag.
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
