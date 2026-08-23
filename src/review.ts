/**
 * review — bounce guard for REVIEW fail -> rework
 * Fresh-read each call from harness/config.json, respects allowBackward, maxBounces, bounceRequiresDelta + fileDelta
 * Pure helper used by enforcer/unstuck; does not mutate feature-list.json itself
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stripBom } from "./core/fsx.ts";

export interface ShouldBounceOpts {
  projectDir?: string;
  fileDelta: boolean;
  bounceCount?: number;
}
export interface ShouldBounceResult {
  shouldBounce: boolean;
  reason: string;
  maxBounces: number;
  bounceCount: number;
}

function projectDirOf(pr?: string): string { return pr ? resolve(pr) : process.cwd(); }
function readConfig(projectDir: string): any {
  try {
    const q = resolve(projectDir, "harness", "config.json");
    if (!existsSync(q)) return null;
    return JSON.parse(stripBom(readFileSync(q, "utf-8")));
  } catch { return null; }
}
function readBounceCount(projectDir: string): number {
  try {
    const rp = resolve(projectDir, "harness", "rework.json");
    if (!existsSync(rp)) return 0;
    const raw = JSON.parse(stripBom(readFileSync(rp, "utf-8")));
    if (Array.isArray((raw as any).history)) return (raw as any).history.length;
    if ((raw as any).returnTask) return 1;
    if (Array.isArray(raw)) return raw.length;
    return 0;
  } catch { return 0; }
}

export function shouldBounceToRework(opts: ShouldBounceOpts): ShouldBounceResult {
  const projectDir = projectDirOf(opts.projectDir);
  const cfg = readConfig(projectDir);
  const allowBackward = cfg?.review?.allowBackward ?? true;
  const maxBounces = typeof cfg?.review?.maxBounces === "number" ? cfg.review.maxBounces : 2;
  const bounceRequiresDelta = cfg?.review?.bounceRequiresDelta ?? true;
  const bounceCount = typeof opts.bounceCount === "number" ? opts.bounceCount : readBounceCount(projectDir);
  if (!allowBackward) return { shouldBounce: false, reason: "review.allowBackward false", maxBounces, bounceCount };
  if (bounceCount >= maxBounces) return { shouldBounce: false, reason: "maxBounces " + bounceCount + " >= " + maxBounces, maxBounces, bounceCount };
  if (bounceRequiresDelta && !opts.fileDelta) return { shouldBounce: false, reason: "bounceRequiresDelta true and no fileDelta", maxBounces, bounceCount };
  return { shouldBounce: true, reason: "bounce eligible", maxBounces, bounceCount };
}
