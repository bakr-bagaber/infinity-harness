/**
 * infinity-harness — daemon/worktree.ts
 *
 * Git worktree per concurrent worker. Gate in worktree, merge lock, unlock.
 *
 * v3.0 is sequential (maxWorkers:1) — this file is the isolation that will be
 * used when we lift that. Kept isolated in its own module so it cannot leak
 * into the single-owner path prematurely.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { worktreePath, worktreesDir } from "../core/paths.ts";
import { run } from "../core/exec.ts";
import { ensureDir } from "../core/fsx.ts";

export async function isWorktreeSupported(targetDir: string): Promise<boolean> {
  const r = await run("git rev-parse --is-inside-work-tree", { cwd: targetDir, timeoutMs: 10_000 });
  return r.ok && r.stdout.trim() === "true";
}

export async function createWorktree(targetDir: string, branch: string): Promise<{ path: string; error: string | null }> {
  if (!await isWorktreeSupported(targetDir)) return { path: "", error: "not a git repo — cannot create worktree" };
  const worktree = worktreePath(targetDir, branch);
  if (existsSync(worktree)) return { path: worktree, error: null };
  try { ensureDir(worktreesDir(targetDir)); } catch {}
  // Safe to create on current HEAD: `git worktree add <path>` with no branch creates detached worktree
  const r = await run(`git worktree add --detach "${worktree.replace(/"/g, '\\"')}"`, { cwd: targetDir, timeoutMs: 30_000 });
  if (!r.ok) return { path: "", error: (r.stderr || r.stdout || r.spawnError || `git worktree add exited ${r.code}`).slice(0, 400) };
  return { path: worktree, error: null };
}

export async function removeWorktree(targetDir: string, branch: string): Promise<{ ok: boolean; error: string | null }> {
  const worktree = worktreePath(targetDir, branch);
  if (!existsSync(worktree)) return { ok: true, error: null };
  const r = await run(`git worktree remove --force "${worktree.replace(/"/g, '\\"')}"`, { cwd: targetDir, timeoutMs: 30_000 });
  if (!r.ok && !r.stderr?.includes("not a valid path")) return { ok: false, error: (r.stderr || r.stdout || r.spawnError || `exit ${r.code}`).slice(0,400) };
  // Also prune any stale branch/worktree registration
  await run("git worktree prune", { cwd: targetDir, timeoutMs: 15_000 });
  return { ok: true, error: null };
}

export async function removeAllWorktrees(targetDir: string): Promise<void> {
  await run("git worktree prune", { cwd: targetDir, timeoutMs: 15_000 });
  // Best-effort remove each directory under harness/worktrees
  const root = worktreesDir(targetDir);
  if (!existsSync(root)) return;
  let entries: string[] = [];
  try { const { readdirSync } = await import("node:fs"); entries = readdirSync(root); } catch {}
  for (const e of entries) {
    await removeWorktree(targetDir, e);
  }
}

export async function gateInWorktree(targetDir: string, worktree: string, phase: string): Promise<{ pass: boolean; reason?: string }> {
  const { runChecks } = await import("../core/gates.ts");
  const g = await runChecks(worktree, phase as never, { record: false });
  if (g.overall) return { pass: true };
  return { pass: false, reason: g.failures.join(", ") };
}

export async function mergeWorktreeBranch(targetDir: string, branch: string, worktree: string, gatePhase?: string): Promise<{ ok: boolean; conflict?: boolean; reason?: string }> {
  // We use a harness/<unit> branch name when creating the worktree. Merge with `git merge`.
  const branchName = `harness/${branch}`;
  // Ensure branch exists (worktree add --detach doesn't create one). Create branch from worktree HEAD.
  const currentHead = (await run(`git -C "${worktree.replace(/"/g,'\\"')}" rev-parse HEAD`, { cwd: targetDir, timeoutMs: 10_000 })).stdout?.trim() ?? null;
  if (currentHead) {
    const create = await run(`git branch "${branchName}" "${currentHead}"`, { cwd: targetDir, timeoutMs: 15_000 });
    // exists is ok — we will merge the branch if already there.
    if (!create.ok && !(create.stderr||"").includes("already exists")) {
      // best-effort: continue to merge attempt
    }
  }
  const merge = await run(`git merge --no-ff --no-edit "${branchName}"`, { cwd: targetDir, timeoutMs: 30_000 });
  if (merge.ok) {
    await run(`git branch -D "${branchName}"`, { cwd: targetDir, timeoutMs: 10_000 });
    const { runChecks: _runChecks } = await import("../core/gates.ts");
    const { loadConfig } = await import("../core/config.ts");
    const phase = gatePhase ?? ((loadConfig(targetDir).config?.currentPhase as unknown as string) ?? "build");
    const post = await _runChecks(targetDir, phase as never, { record: false });
    if (!post.overall) {
      await run("git reset --hard HEAD~1", { cwd: targetDir, timeoutMs: 15_000 }).catch(()=>null as never);
      return { ok: false, conflict: false, reason: `post-merge gate FAIL: ${post.failures.join(", ")}` };
    }
    return { ok: true };
  }
  const out = (merge.stdout ?? "") + "\n" + (merge.stderr ?? "");
  const conflict = /conflict/i.test(out);
  if (conflict) {
    await run("git merge --abort", { cwd: targetDir, timeoutMs: 10_000 }).catch(()=>null as never);
    return { ok: false, conflict: true, reason: out.slice(0,500) };
  }
  await run("git merge --abort", { cwd: targetDir, timeoutMs: 10_000 }).catch(()=>null as never);
  return { ok: false, conflict: false, reason: out.slice(0,500) };
}
