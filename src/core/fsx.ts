/**
 * infinity-harness — filesystem helpers.
 *
 * Two guarantees callers depend on:
 *   - `writeJsonAtomic` never leaves a half-written file, and never leaves a
 *     stray temp file behind when the write fails.
 *   - `readJson` distinguishes "absent" (null) from "corrupt" (throws), so
 *     callers can seed defaults without silently discarding real state.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/**
 * Strip a leading UTF-8 byte-order mark.
 *
 * Windows writes one routinely — PowerShell's `Set-Content -Encoding utf8`,
 * Notepad, and several editors all do — and `JSON.parse` rejects it. Without
 * this, a user who opens harness/config.json in Notepad, changes one value and
 * saves gets "config is missing or unreadable" and no clue why. The files are
 * explicitly documented as hand-editable, so they have to survive the editors
 * people actually have.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function readText(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return stripBom(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Read and parse JSON.
 * @returns parsed value, or `null` when the file does not exist.
 * @throws when the file exists but does not parse — callers must not paper
 *   over a corrupt state file by overwriting it with defaults.
 */
export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  const raw = stripBom(readFileSync(path, "utf-8"));
  if (raw.trim() === "") return null;
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new SyntaxError(`${path} is not valid JSON: ${msg}`);
  }
}

/** Read JSON, falling back to `fallback` on absence *or* corruption. */
export function readJsonSafe<T>(path: string, fallback: T): T {
  try {
    const v = readJson<T>(path);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

/**
 * Write JSON atomically: temp file in the same directory, then rename.
 * The temp name includes pid + random bytes so concurrent writers in the same
 * process (or across processes) never collide on the temp path.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  writeTextAtomic(path, JSON.stringify(value, null, 2) + "\n");
}

export function writeTextAtomic(path: string, contents: string): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, contents, "utf-8");
    renameSync(tmp, path);
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw e;
  }
}

/**
 * Keep one `.bak` beside a state file before overwriting it.
 * Cheap insurance for multi-day runs: a corrupt write leaves the prior good
 * revision recoverable without reaching for git.
 */
export function backupOnce(path: string): void {
  if (!existsSync(path)) return;
  try {
    copyFileSync(path, `${path}.bak`);
  } catch {
    /* best effort — a failed backup must never block the write */
  }
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}
