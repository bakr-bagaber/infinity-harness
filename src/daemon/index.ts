/**
 * infinity-harness — daemon/index.ts
 *
 * Detached entry: owns the run, heartbeat, bounded stop.
 * Spawned via: spawn(process.execPath, [daemonEntry, targetDir], { detached:true, stdio:["ignore", logFd, logFd], windowsHide:true, env:{..., WORKER_ENV:"1"} }) + child.unref().
 * The extension captures ctx.model -> run.json.baseModel at arm time before spawning.
 *
 * Lifecycle: arm run.json -> preflight tiers -> run sequential units (one worker at a time v3.0)
 * -> decideNext via Core loop, stream to supervisor.json+activity.json, gate, advance/steer/stop.
 * Budget (token+cost+X tripwire), worker recycling on compaction, CredentialSynchronizationError handling.
 */

import { resolve } from "node:path";
import { createWriteStream, existsSync } from "node:fs";
import { daemonPath, planPath, runStatePath } from "../core/paths.ts";
import { readJsonSafe, writeJsonAtomic, ensureDir } from "../core/fsx.ts";
import { loadConfig, saveConfig } from "../core/config.ts";
import { loadFeatureList } from "../core/featureList.ts";
import { loadRunState, saveRunState, disarmRun, type RunState } from "../core/runState.ts";
import { decideNext, fingerprint, type LoopDecision } from "../loop.ts";
import { buildBrief, renderBrief } from "../core/brief.ts";
import { runChecks } from "../core/gates.ts";
import { guardSingleOwner, isDaemonAlive, loadDaemon, writeDaemon, newDaemonInfo, startHeartbeat, clearDaemon, HEARTBEAT_MS } from "./guard.ts";
import { startServer, stopServer } from "./server.ts";
import { saveSupervisor, appendActivity, type SupervisorWorker } from "./supervisorState.ts";
import { runPreflight } from "./preflight.ts";
import { addUsageForTier, isCapExceeded, hasXLeak, xLeakReason, type Tier } from "./budget.ts";
import { createWorker, promptWorker, type TurnResult } from "./worker.ts";
import { routeModel, effectiveDifficultyForTask as effectiveDifficulty } from "../core/modelRouter.ts";
import { dirname } from "node:path";
import type { Server } from "node:http";

export const WORKER_ENV = "INFINITY_HARNESS_WORKER";

let stopping = false;
let heartbeatStop: (() => void) | null = null;
let server: Server | null = null;

async function main(): Promise<void> {
  const targetDir = process.argv[2] ?? process.cwd();
  const logPath = resolve(targetDir, "harness", "daemon.log");
  try { ensureDir(dirname(logPath)); } catch {}

  // Guard: single owner
  const existing = guardSingleOwner(targetDir);
  if (existing && isDaemonAlive(existing)) {
    console.error(`infinity-harness daemon already running pid ${existing.pid}`);
    process.exit(0);
  }

  const runState = loadRunState(targetDir);
  if (!runState?.armed) {
    console.error("no armed run — run.json is not armed");
    process.exit(1);
  }
  if (!runState.baseModel) {
    console.error("no baseModel in run.json — extension must capture ctx.model at arm time");
    // Refuse to arm: this is the path that silently used pi's default (the X leak).
    process.exit(1);
  }

  // Preflight distinct tiers
  const { loadConfig: _loadConfig } = await import("../core/config.ts");
  const cfg = _loadConfig(targetDir).config;
  const tiersRaw = (cfg as unknown as { tiers?: Record<string, { provider: string; id: string }> }).tiers ?? {};
  const hasTier = Object.keys(tiersRaw).length > 0;
  if (hasTier) {
    const pre = await runPreflight({ targetDir, tiers: tiersRaw as never });
    if (pre.blocked) {
      console.error(`tier preflight failed: ${pre.blocked.tier} ${pre.blocked.reason}`);
      // Record to run.json and stop
      const rs = loadRunState(targetDir);
      if (rs) {
        rs.tiers = pre.tierResults;
        saveRunState(targetDir, rs);
      }
      appendActivity(targetDir, { level: "error", worker: null, text: `preflight failed ${pre.blocked.tier}: ${pre.blocked.reason}` });
      process.exit(1);
    }
    if (runState) {
      runState.tiers = pre.tierResults;
      saveRunState(targetDir, runState);
    }
  }

  // Start server (port 0, token from run)
  const { server: srv, port, token } = await startServer({
    targetDir,
    onHalt: async () => { await boundedStop(targetDir, "halted by user"); return { ok: true }; },
    onRun: async () => ({ ok: true, daemon: loadDaemon(targetDir) }),
    onApprove: async (body) => {
      try {
        const note = typeof (body as { note?: unknown })?.note === "string" ? String((body as { note: string }).note) : "";
        const { resolveApproval: _resolveApproval } = await import("../approval.ts");
        await _resolveApproval(targetDir, note || true as unknown as string);
        appendActivity(targetDir, { level: "good", worker: null, text: `approved: ${note || "(no note)"}` });
      } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
      return { ok: true };
    },
    onReplan: async (body) => {
      try {
        const b = body as { reason?: string; addFeatures?: Array<{ id: string; name: string }>; addTasks?: Array<{ featureId: string; task: unknown }> };
        const { amendPlan: _amendPlan } = await import("../replan.ts");
        const r = await _amendPlan({ projectDir: targetDir, reason: typeof b.reason === "string" ? b.reason : undefined, addFeatures: b.addFeatures as never, addTasks: b.addTasks as never });
        appendActivity(targetDir, { level: "info", worker: null, text: `replan +${r.added.features}f +${r.added.tasks}t rev ${r.baseRevision}` });
        return { ok: true, ...r };
      } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    },
    onRework: async (body) => {
      try {
        const b = body as { task?: string; key?: string; reason?: string };
        const needle = String(b.task ?? b.key ?? "").trim();
        if (!needle) return { ok: false, error: "task required" };
        const { flattenTasks } = await import("../core/featureList.ts");
        const list = loadFeatureList(targetDir).list;
        const target = flattenTasks(list).find(t => t.compositeKey === needle || t.key === needle || t.id === needle);
        if (!target) return { ok: false, error: `no task ${needle}` };
        const { startRework: _startRework } = await import("../rework.ts");
        const rs = loadRunState(targetDir);
        const runId = rs?.runId ?? "daemon";
        const res = await _startRework({ projectDir: targetDir, featureId: target.featureId, taskId: target.id, key: target.key, reason: typeof b.reason === "string" ? b.reason : "rework via daemon", runId });
        appendActivity(targetDir, { level: "warn", worker: null, text: `rework ${target.compositeKey} → ${res.impacted.length} deps rev ${res.baseRevision}` });
        return { ok: true, ...res };
      } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    },
    onPilot: async (body) => {
      try {
        const b = body as { pilot?: string };
        const p = String(b.pilot ?? "").trim().toLowerCase();
        if (!["copilot","autopilot","full"].includes(p)) return { ok: false, error: `pilot must be copilot|autopilot|full, got ${JSON.stringify(b.pilot)}` };
        const { loadConfig: _lc, saveConfig: _sc } = await import("../core/config.ts");
        const { applyPilotPreset: _app } = await import("../core/config.ts");
        const { withLock: _wl } = await import("../core/lock.ts");
        const { configPath: _cp } = await import("../core/paths.ts");
        await (_wl as unknown as (path: string, fn: ()=>unknown)=>Promise<unknown>)(_cp(targetDir), () => {
          const l = _lc(targetDir);
          if (!l.ok) throw new Error(l.error ?? "cannot load config");
          (l.config as unknown as { pilot: string }).pilot = p;
          _app(l.config as Parameters<typeof _app>[0], p as "copilot"|"autopilot"|"full");
          const ok = _sc(targetDir, l.config).ok;
          if (!ok) throw new Error("cannot save config");
          return true;
        });
        appendActivity(targetDir, { level: "info", worker: null, text: `pilot → ${p}` });
        return { ok: true, pilot: p };
      } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    },
  });
  server = srv;

  const info = newDaemonInfo(runState.runId, port);
  // Preserve token from server (which may have generated one if daemon.json absent)
  (info as unknown as { token: string }).token = token || (info as unknown as { token: string }).token;
  writeDaemon(targetDir, info);
  heartbeatStop = startHeartbeat(targetDir);

  const onSignal = async (sig: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`daemon signal ${sig}, stopping`);
    await boundedStop(targetDir, `signal ${sig}`);
    process.exit(0);
  };
  process.on("SIGTERM", () => void onSignal("SIGTERM"));
  process.on("SIGINT", () => void onSignal("SIGINT"));

  // Main loop: one unit at a time (v3.0 sequential). Continuous handoff in autopilot/full.
  await runLoop(targetDir);
}

async function boundedStop(targetDir: string, reason: string): Promise<void> {
  stopping = true;
  if (heartbeatStop) try { heartbeatStop(); } catch {}
  if (server) try { await stopServer(server); } catch {}
  server = null;
  try { disarmRun(targetDir, reason); } catch {}
  try { clearDaemon(targetDir); } catch {}
}

async function runLoop(targetDir: string): Promise<void> {
  let iterations = 0;
  const maxRecycles = (() => { try { const c = loadConfig(targetDir).config as unknown as { limits?: { maxRecycles?: number } }; return c.limits?.maxRecycles ?? 2; } catch { return 2; } })();
  const recycleCount = new Map<string, number>();

  // Outer run loop: decideNext -> prompt worker (or general A work) -> gate -> advance/steer/stop
  while (!stopping) {
    const runState = loadRunState(targetDir);
    if (!runState?.armed) { await boundedStop(targetDir, runState?.stopReason ?? "disarmed"); break; }

    // Budget caps (token/cost) and X tripwire
    try {
      const capCheck = isCapExceeded(runState.budget ?? { byTier: {}, cap: {} });
      if (capCheck.exceeded) { appendActivity(targetDir, { level: "warn", worker: null, text: capCheck.reason ?? "cap exceeded" }); await boundedStop(targetDir, capCheck.reason ?? "cap exceeded"); break; }
      // X leak is a defect signal, not a budget — check it regardless of cap
      const hasConsultWorker = false; // v3.0 sequential: no consultation parallel workers yet
      const { hasXLeak: _hasXLeak } = await import("./budget.ts");
      if (_hasXLeak(runState.budget ?? { byTier: {}, cap: {} }, hasConsultWorker)) {
        const reason = xLeakReason(runState.budget ?? { byTier: {}, cap: {} });
        appendActivity(targetDir, { level: "error", worker: null, text: reason });
        await boundedStop(targetDir, reason);
        break;
      }
    } catch {}

    const decision = await decideNext({ targetDir, runId: runState.runId, skipGate: false });
    const action = decision.decision.action as string;

    if (action === "stop") {
      const d = decision.decision as Extract<LoopDecision, { action: "stop" }>;
      appendActivity(targetDir, { level: "info", worker: null, text: d.detail ?? d.reason });
      await boundedStop(targetDir, d.detail ?? d.reason);
      break;
    }
    if (action === "wait") {
      const d = decision.decision as Extract<LoopDecision, { action: "wait" }>;
      appendActivity(targetDir, { level: "info", worker: null, text: d.detail ?? d.reason });
      // Paused / awaiting approval — keep daemon alive but idle; poll.
      await new Promise(r => setTimeout(r, 5_000));
      continue;
    }
    if (action === "approve") {
      const d = decision.decision as Extract<LoopDecision, { action: "approve" }>;
      appendActivity(targetDir, { level: "warn", worker: null, text: `awaiting approval: ${d.phase} — /infinity:approve to continue` });
      saveSupervisor(targetDir, { runId: runState.runId, updatedAt: new Date().toISOString(), worker: null });
      await new Promise(r => setTimeout(r, 5_000));
      continue;
    }
    // continue / advanced both have a brief to work. We need to determine unit + routing.
    const brief = await buildBrief(targetDir);
    const list = loadFeatureList(targetDir).list;
    const phase = brief.phase ?? loadConfig(targetDir).config.currentPhase;
    // Derive unit: prefer current task, else nextActionableTask
    let unitKey: string | null = brief.task?.key ?? brief.task?.id ?? null;
    let difficulty: string | undefined = undefined;
    let tierSpec: { provider: string; id: string; thinkingLevel?: string } | null = null;
    try {
      if (unitKey) {
        const diff = effectiveDifficulty(list, unitKey, (loadConfig(targetDir).config.session as { handoff: string }).handoff) as string | undefined;
        difficulty = diff;
      }
    } catch {}
    // Fallback: use phase+feature hints when no task
    const cfgForRouting = loadConfig(targetDir).config;
    const tiers = (cfgForRouting as unknown as { tiers?: Record<string, { provider: string; id: string; thinkingLevel?: string }> }).tiers ?? {};
    // General work (no unit) -> A
    let askedTier: Tier = (difficulty ? (difficulty === "difficult" ? "D" : difficulty === "moderate" ? "C" : "B") : "A") as Tier;
    let routed: { provider: string; id: string } | null = null;
    if (askedTier && (tiers as Record<string, { provider: string; id: string }>)[askedTier]) {
      tierSpec = (tiers as Record<string, { provider: string; id: string }>) [askedTier] as never;
      routed = tierSpec as { provider: string; id: string };
    }
    // Fallback to baseModel when tier slot empty
    if (!routed) {
      const bm = runState.baseModel;
      if (bm) routed = { provider: bm.provider, id: bm.id };
    }
    if (!routed) {
      appendActivity(targetDir, { level: "error", worker: null, text: `no model for tier ${askedTier}: set config.tiers or baseModel` });
      await new Promise(r => setTimeout(r, 2_000));
      continue;
    }
    const askedModel = `${routed.provider}/${routed.id}`;

    // Start one SDK worker for this unit (or general A work when unitKey null)
    const workerLabel = unitKey ?? `_phase-${phase ?? "general"}`;
    saveSupervisor(targetDir, {
      runId: runState.runId,
      updatedAt: new Date().toISOString(),
      worker: {
        name: "W1",
        unitKey: workerLabel,
        unitLabel: brief.task?.description ?? brief.feature?.name ?? String(phase ?? "general"),
        level: brief.task ? "task" : "phase",
        difficulty: difficulty ?? null,
        model: askedModel,
        askedModel,
        servedModel: null,
        thinking: (tierSpec as { thinkingLevel?: string } | null)?.thinkingLevel ?? "medium",
        state: "starting",
        doing: "starting",
        startedAt: new Date().toISOString(),
        turns: 0,
        recycles: recycleCount.get(workerLabel) ?? 0,
        tokens: { input: 0, output: 0 },
        contextRatio: null,
        sessionId: null,
      } as SupervisorWorker,
    });
    appendActivity(targetDir, { level: "work", worker: "W1", text: `working ${workerLabel} on ${askedModel}` });

    const briefMarkdown = renderBrief(brief, cfgForRouting);
    let recycles = recycleCount.get(workerLabel) ?? 0;

    // Worker session lifecycle with recycle on compaction
    let turn: TurnResult | null = null;
    let workerHandle: Awaited<ReturnType<typeof createWorker>> | null = null;
    try {
      const workerFactory = await import("./worker.ts");
      workerHandle = await workerFactory.createWorker({
        cwd: targetDir,
        modelSpec: { provider: routed.provider, id: routed.id, thinkingLevel: (tierSpec as { thinkingLevel?: string } | null)?.thinkingLevel ?? "medium" },
        askedModel,
        sessionManagerDir: `harness/sessions/${workerLabel.replace(/[^a-z0-9._-]/gi, "-")}`,
        customTools: (await import("./isolation.ts")).harnessToolsForWorker() as unknown[],
      });
      // Capture served model lazily from events after prompt
      turn = await workerFactory.promptWorker(workerHandle as unknown as never, { text: briefMarkdown, timeoutMs: (cfgForRouting as unknown as { limits?: { unitWallClockMs?: number } }).limits?.unitWallClockMs ?? 30*60*1000 });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const isCredentialSync = msg.includes("CredentialSynchronizationError") || (e as { name?: string })?.name === "CredentialSynchronizationError";
      if (isCredentialSync) {
        appendActivity(targetDir, { level: "warn", worker: "W1", text: `credential sync error — retrying once: ${msg}` });
        await new Promise(r => setTimeout(r, 1500));
        // Retry once
        try {
          const workerFactory = await import("./worker.ts");
          if (!workerHandle) {
            workerHandle = await workerFactory.createWorker({
              cwd: targetDir,
              modelSpec: { provider: routed.provider, id: routed.id, thinkingLevel: (tierSpec as { thinkingLevel?: string } | null)?.thinkingLevel ?? "medium" },
              askedModel,
              sessionManagerDir: `harness/sessions/${workerLabel.replace(/[^a-z0-9._-]/gi, "-")}`,
              customTools: (await import("./isolation.ts")).harnessToolsForWorker() as unknown[],
            });
          }
          turn = await workerFactory.promptWorker(workerHandle as unknown as never, { text: briefMarkdown, timeoutMs: (cfgForRouting as unknown as { limits?: { unitWallClockMs?: number } }).limits?.unitWallClockMs ?? 30*60*1000 });
        } catch (e2) {
          appendActivity(targetDir, { level: "error", worker: "W1", text: `credential sync retry failed: ${e2 instanceof Error ? e2.message : String(e2)}` });
        }
      } else {
        appendActivity(targetDir, { level: "error", worker: "W1", text: `worker failed: ${msg}` });
      }
    } finally {
      if (workerHandle) { try { workerHandle.dispose(); } catch {} }
    }

    if (!turn) {
      // Worker never produced a turn — treat as non-event, re-brief next loop.
      await new Promise(r => setTimeout(r, 1_000));
      continue;
    }

    // Record asked vs served, usage, tools
    const asked = askedModel;
    const served = turn.servedModel ?? turn.askedModel ?? asked;
    if (served && served !== asked) {
      appendActivity(targetDir, { level: "warn", worker: "W1", text: `asked ${asked} but ${served} answered` });
    }

    // Budget accounting (per-tier, last reading IS total per session — we add it as one session's spend)
    try {
      const rs = loadRunState(targetDir);
      if (rs) {
        const tier: Tier = askedTier;
        const inc = { input: turn.usage?.input ?? 0, output: turn.usage?.output ?? 0, cacheRead: turn.usage?.cacheRead ?? 0, cacheWrite: turn.usage?.cacheWrite ?? 0, cost: turn.usage?.cost ?? 0, calls: 1 };
        addUsageForTier(rs.budget ?? { byTier: {}, cap: {} }, tier, inc);
        rs.budget.byTier = (rs.budget as { byTier: Record<string, unknown> }).byTier as never;
        saveRunState(targetDir, rs);
        const capCheck = isCapExceeded(rs.budget as never);
        if (capCheck.exceeded) { appendActivity(targetDir, { level: "warn", worker: "W1", text: capCheck.reason ?? "cap exceeded" }); await boundedStop(targetDir, capCheck.reason ?? "cap exceeded"); break; }
        const hasConsult = false;
        const { hasXLeak: _hasXLeak } = await import("./budget.ts");
        if (_hasXLeak(rs.budget as never, hasConsult)) { await boundedStop(targetDir, xLeakReason(rs.budget as never)); break; }
      }
    } catch {}

    // Compaction => recycle the worker (fresh session, same unit, brief from disk)
    if (turn.compacted) {
      recycles += 1;
      recycleCount.set(workerLabel, recycles);
      appendActivity(targetDir, { level: "warn", worker: "W1", text: `compaction observed on ${workerLabel} — recycling (${recycles}/${maxRecycles})` });
      if (recycles > maxRecycles) {
        appendActivity(targetDir, { level: "error", worker: "W1", text: `maxRecycles exceeded for ${workerLabel} — stopping` });
        await boundedStop(targetDir, `maxRecycles exceeded for ${workerLabel}`);
        break;
      }
      // Dispose and re-loop the same unit with a fresh session (brief from disk, not transcript).
      continue;
    }

    // Zero-tool-calls settle => re-brief once, then it feeds no-progress fingerprint
    if (!turn.tools || turn.tools.length === 0) {
      appendActivity(targetDir, { level: "warn", worker: "W1", text: `worker settled with no tool calls — ${turn.summary?.slice(0,120) ?? "(no summary)"}` });
    }

    // Run gate to decide next action (decideNext will run it again next loop, but we can steer immediately on FAIL).
    // For now let decideNext be the referee: the loop top will call decideNext again and pick continue/advance/stop.
    // Update supervisor with served/usage
    try {
      const sup = (await import("./supervisorState.ts")).loadSupervisor(targetDir);
      if (sup?.worker) {
        sup.worker.servedModel = served;
        sup.worker.tokens = { input: turn.usage?.input ?? 0, output: turn.usage?.output ?? 0, cacheRead: turn.usage?.cacheRead ?? 0, cacheWrite: turn.usage?.cacheWrite ?? 0, cost: turn.usage?.cost ?? 0, calls: (sup.worker.tokens as { calls?: number })?.calls ?? 1 } as never;
        sup.worker.turns = (sup.worker.turns ?? 0) + 1;
        (await import("./supervisorState.ts")).saveSupervisor(targetDir, sup);
      }
    } catch {}

    // If loop wants to steer on FAIL, it will do so next iteration. We just close the worker (handoff).
    // One worker = one unit = one session; closing it is the handoff.
    iterations += 1;
    if (iterations > 10_000) { await boundedStop(targetDir, "iteration guard"); break; }

    // Small yield to keep dashboard/heartbeat flowing
    await new Promise(r => setTimeout(r, 200));
  }

  await boundedStop(targetDir, "loop ended");
}

// Only run when executed as the daemon entry (not when imported).
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname) || process.env[WORKER_ENV] !== "1") {
  // Allow both: `node dist/daemon/index.js <dir>` or `node src/daemon/index.ts <dir>` with --experimental-strip-types.
  // Detect daemon entry by checking argv[2] is a directory with harness.
  const arg = process.argv[2];
  if (arg && existsSync(resolve(arg, "harness"))) {
    main().catch(e => { console.error(e); process.exit(1); });
  } else if (!arg) {
    // In WSL/tests the daemon is not started automatically.
  }
}
