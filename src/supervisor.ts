/**
 * infinity-harness — the supervisor.
 *
 * This is the piece that makes the main session a control panel instead of a
 * worker. It runs entirely in the extension's own process — plain JavaScript,
 * no LLM — and its only job is to keep exactly one background pi session
 * doing the right work with the right model.
 *
 * Why it exists
 * -------------
 * Before this, the loop pushed the brief back into the human's own session
 * with `pi.sendUserMessage`. Everything followed from that one line: the
 * human's model did every task regardless of difficulty, the human's context
 * window carried the whole run, the human's token budget paid for it, and a
 * "session handoff" meant replacing the terminal the human was typing into.
 * The difficulty tiers the wizard collects had nowhere to be applied, because
 * a session only ever has one model and it was the human's.
 *
 * The shape now
 * -------------
 *   main session  the human, the widget, the log. No harness turns at all.
 *   supervisor    this file. Decides, spawns, watches, records.
 *   worker        a separate `pi --mode rpc` process with its own model,
 *                 its own context window and its own session file.
 *
 * The unit is the session is the model
 * ------------------------------------
 * `session.handoff` names one level of the plan — goal, phase, sprint,
 * feature, task, subtask. That level is the *unit*: one worker owns one unit
 * from start to finish, in one session, on one model. When the run crosses a
 * unit boundary the worker is closed and a new one starts, and *that* is the
 * handoff. Because the model is chosen when the worker starts, the model
 * boundary and the session boundary are the same boundary by construction —
 * which is why the difficulty of a unit, not of a task, decides the model
 * (see `effectiveDifficultyForTask`).
 *
 * Nothing in here holds run state in memory. The plan, the phase, the budgets
 * and the ladder are all files, so a supervisor that dies mid-run is restarted
 * by the next session with nothing lost.
 */

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import type { HandoffGranularity, Phase } from "./core/types.ts";
import { loadConfig } from "./core/config.ts";
import { loadFeatureList, nextActionableTask, findFeature, type FlatTask } from "./core/featureList.ts";
import { harnessDir } from "./core/paths.ts";
import { readJsonSafe, writeJsonAtomic, fileExists } from "./core/fsx.ts";
import { decideNext, stopFilePath, type LoopDecision } from "./loop.ts";
import { loadRunState, countSession, disarmRun } from "./runState.ts";
import { effectiveDifficultyForTask } from "./scheduler.ts";
import { resolveModel, resolveThinking, loadRouterConfig } from "./modelRouter.ts";
import {
  WorkerSession,
  WORKER_DIRECTIVE,
  workerSessionDir,
  type WorkerEvent,
} from "./exec/piWorker.ts";

// ── on-disk state ───────────────────────────────────────────────────────────

export const SUPERVISOR_FILE = "supervisor.json";
export const ACTIVITY_FILE = "activity.json";
/** Activity lines kept. Enough to scroll back through a phase, not a run. */
export const ACTIVITY_LIMIT = 400;

export function supervisorStatePath(targetDir: string): string {
  return resolve(harnessDir(targetDir), SUPERVISOR_FILE);
}

export function activityPath(targetDir: string): string {
  return resolve(harnessDir(targetDir), ACTIVITY_FILE);
}

export type ActivityLevel = "info" | "work" | "warn" | "error" | "good";

export type ActivityLine = {
  at: string;
  level: ActivityLevel;
  /** Which worker said it, e.g. "W3". Null for the supervisor itself. */
  worker: string | null;
  text: string;
};

export type WorkerView = {
  /** Short stable label: W1, W2, … */
  name: string;
  unitKey: string;
  unitLabel: string;
  level: UnitLevel;
  difficulty: string | null;
  /** What we asked for. */
  model: string;
  /** What actually answered, once a turn has run. */
  servedModel: string | null;
  thinking: string;
  state: "starting" | "working" | "idle" | "closed" | "failed";
  /** The last thing it did, for the log line the human reads. */
  doing: string | null;
  startedAt: string;
  turns: number;
  tokens: { inputTokens: number; outputTokens: number };
  contextRatio: number | null;
  sessionId: string | null;
  attemptDir: string;
};

/**
 * Who is driving, and when they last said so.
 *
 * Two pi windows open on the same project would otherwise both start a
 * supervisor, and the run would get two workers editing the same tree — the
 * exact corruption every lock in this codebase exists to prevent. The second
 * one reads this, sees a fresh heartbeat, and stays a viewer.
 */
export type SupervisorOwner = {
  pid: number;
  sessionId: string;
  at: string;
  /** The pi child this owner has running, so a crash can be cleaned up after. */
  workerPid: number | null;
};

/** A heartbeat older than this means the owner is gone, not busy. */
export const OWNER_STALE_MS = 90_000;
/** How often the owner refreshes its claim. Comfortably inside the stale window. */
export const HEARTBEAT_MS = 20_000;

export type SupervisorState = {
  version: 1;
  runId: string;
  owner?: SupervisorOwner | null;
  status: "idle" | "running" | "stopped";
  startedAt: string | null;
  updatedAt: string;
  /** The model the main session is on — what an empty router slot means. */
  baseModel: string | null;
  handoff: HandoffGranularity;
  unit: WorkUnit | null;
  worker: WorkerView | null;
  /** Finished workers, newest last, capped. */
  history: WorkerView[];
  sessions: number;
  lastDecision: string | null;
  stopReason: string | null;
};

const HISTORY_LIMIT = 20;

export function emptySupervisorState(runId: string): SupervisorState {
  return {
    version: 1,
    runId,
    owner: null,
    status: "idle",
    startedAt: null,
    updatedAt: new Date().toISOString(),
    baseModel: null,
    handoff: "task",
    unit: null,
    worker: null,
    history: [],
    sessions: 0,
    lastDecision: null,
    stopReason: null,
  };
}

export function loadSupervisorState(targetDir: string): SupervisorState | null {
  const raw = readJsonSafe<Partial<SupervisorState> | null>(supervisorStatePath(targetDir), null);
  if (!raw || typeof raw.runId !== "string") return null;
  return { ...emptySupervisorState(raw.runId), ...raw } as SupervisorState;
}

/** Is someone else already driving this project? Returns their claim, or null. */
export function activeOwner(targetDir: string, selfPid = process.pid, now = Date.now()): SupervisorOwner | null {
  const st = loadSupervisorState(targetDir);
  const owner = st?.owner ?? null;
  if (!owner || typeof owner.pid !== "number") return null;
  if (owner.pid === selfPid) return null;
  const at = Date.parse(owner.at ?? "");
  if (!Number.isFinite(at) || now - at > OWNER_STALE_MS) return null;
  // A heartbeat can be fresh and the process still gone — a hard kill leaves
  // the last one behind. Ask the OS rather than trusting the timestamp alone.
  if (!processAlive(owner.pid)) return null;
  return owner;
}

/** Does this pid exist? `kill(pid, 0)` throws ESRCH when it does not. */
export function processAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string })?.code === "EPERM";
  }
}

/**
 * Kill a pi child left behind by a supervisor that died.
 *
 * A `SIGKILL`ed pi cannot close its worker, and that worker keeps editing the
 * project — with nothing watching it and nothing able to stop it. The next
 * session picks up the pid from the state file and ends it.
 */
export function reapOrphanWorker(targetDir: string): number | null {
  const st = loadSupervisorState(targetDir);
  const pid = st?.owner?.workerPid ?? null;
  if (!pid || !processAlive(pid)) return null;
  if (processAlive(st?.owner?.pid)) return null; // its supervisor is alive; not an orphan
  try {
    process.kill(pid, "SIGKILL");
    return pid;
  } catch {
    return null;
  }
}

export function saveSupervisorState(targetDir: string, state: SupervisorState): void {
  state.updatedAt = new Date().toISOString();
  writeJsonAtomic(supervisorStatePath(targetDir), state);
}

export function loadActivity(targetDir: string): ActivityLine[] {
  const raw = readJsonSafe<{ lines?: ActivityLine[] } | null>(activityPath(targetDir), null);
  return Array.isArray(raw?.lines) ? (raw!.lines as ActivityLine[]) : [];
}

/**
 * Append one line to the background log.
 *
 * This is the only channel the human has into what the workers are doing, so
 * it is a file rather than a notification: a run that spans days outlives
 * every terminal that watched part of it.
 */
export function appendActivity(targetDir: string, line: Omit<ActivityLine, "at">): ActivityLine[] {
  const lines = loadActivity(targetDir);
  const next = [...lines, { at: new Date().toISOString(), ...line }].slice(-ACTIVITY_LIMIT);
  try {
    writeJsonAtomic(activityPath(targetDir), { lines: next });
  } catch {
    /* a log that cannot be written must not stop the run */
  }
  return next;
}

// ── the unit ────────────────────────────────────────────────────────────────

export type UnitLevel = "run" | "goal" | "phase" | "sprint" | "feature" | "task" | "subtask";

export type WorkUnit = {
  level: UnitLevel;
  /** Identity. A change here is a session boundary, and therefore a model boundary. */
  key: string;
  /** One line for the widget: "feature-002 · Checkout". */
  label: string;
  phase: Phase | null;
  difficulty: string | null;
  /** Resolved model reference, or "" meaning "whatever the base model is". */
  model: string;
  thinking: string;
  taskKey: string | null;
  featureId: string | null;
  /** What the worker is told its remit is, in one sentence. */
  scope: string;
};

/** The handoff knob, as a unit level. `off` and `goal` both mean one session. */
export function unitLevelFor(handoff: HandoffGranularity): UnitLevel {
  switch (handoff) {
    case "off":
      return "run";
    case "goal":
      return "goal";
    case "phase":
      return "phase";
    case "sprint":
      return "sprint";
    case "feature":
      return "feature";
    case "subtask":
      return "subtask";
    default:
      return "task";
  }
}

const SCOPE_TEXT: Record<UnitLevel, string> = {
  run: "You own this entire run. Keep going through every phase until the harness stops you.",
  goal: "You own this goal. Keep going until every feature under it is done.",
  phase: "You own this whole phase. Work through every task in it before you stop.",
  sprint: "You own this sprint. Work through every feature and task in it before you stop.",
  feature: "You own this feature. Work through all of its tasks before you stop.",
  task: "You own this one task. Finish it, then stop — the harness starts the next one.",
  subtask: "You own this one subtask. Finish it, then stop — the harness starts the next one.",
};

/**
 * What is being worked on right now, at the configured granularity.
 *
 * Returns null when there is nothing actionable: an empty plan in an early
 * phase is normal, and the phase's own seeded work is what the brief will
 * name, so the unit falls back to the phase.
 */
export function currentUnit(targetDir: string, baseModel?: string | null): WorkUnit | null {
  const { config } = loadConfig(targetDir);
  const { list } = loadFeatureList(targetDir);
  const handoff = (config.session?.handoff ?? "task") as HandoffGranularity;
  const level = unitLevelFor(handoff);
  const phase = (config.currentPhase ?? null) as Phase | null;

  const phaseTask = phase ? nextActionableTask(list, phase) : null;
  const task = (phaseTask ?? nextActionableTask(list)) as FlatTask | null;
  const feature = task ? findFeature(list, task.featureId) ?? null : null;
  const sprintId = (feature as { sprintId?: string } | null)?.sprintId ?? null;
  const sprint = sprintId ? (list.sprints ?? []).find((s) => s.id === sprintId) ?? null : null;
  const goalId =
    (feature as { goalId?: string } | null)?.goalId ??
    (sprint as { goalId?: string } | null)?.goalId ??
    (list.goals ?? [])[0]?.id ??
    null;

  const difficulty = task
    ? (effectiveDifficultyForTask(task, handoff, list) ?? (task as { difficulty?: string }).difficulty ?? null)
    : null;

  // The active subtask, when the plan goes that deep.
  let subtaskKey: string | null = null;
  let subtaskTitle: string | null = null;
  if (task && Array.isArray((task as { subtasks?: Array<{ id?: string; title: string; status: string }> }).subtasks)) {
    const subs = (task as { subtasks?: Array<{ id?: string; title: string; status: string }> }).subtasks ?? [];
    const open = subs.find((s) => s.status !== "complete") ?? null;
    if (open) {
      subtaskKey = `${task.compositeKey}#${open.id ?? open.title}`;
      subtaskTitle = open.title;
    }
  }

  const identity = ((): { key: string; label: string } | null => {
    switch (level) {
      case "run":
        return { key: "run", label: "whole run" };
      case "goal":
        return goalId ? { key: `goal:${goalId}` , label: goalGuess(list, goalId) } : { key: "goal:*", label: "the goal" };
      case "phase":
        return phase ? { key: `phase:${phase}`, label: phase.toUpperCase() } : null;
      case "sprint":
        return sprintId
          ? { key: `sprint:${sprintId}`, label: `${sprintId}${sprint?.name ? ` · ${sprint.name}` : ""}` }
          : phase
            ? { key: `phase:${phase}`, label: phase.toUpperCase() }
            : null;
      case "feature":
        return feature
          ? { key: `feature:${feature.id}`, label: `${feature.id} · ${feature.name}` }
          : phase
            ? { key: `phase:${phase}`, label: phase.toUpperCase() }
            : null;
      case "subtask":
        if (subtaskKey) return { key: `subtask:${subtaskKey}`, label: `${task!.compositeKey} › ${subtaskTitle}` };
        return task ? { key: `task:${task.compositeKey}`, label: task.compositeKey } : phase ? { key: `phase:${phase}`, label: phase.toUpperCase() } : null;
      default:
        return task
          ? { key: `task:${task.compositeKey}`, label: `${task.compositeKey} · ${short(task.description)}` }
          : phase
            ? { key: `phase:${phase}`, label: phase.toUpperCase() }
            : null;
    }
  })();
  if (!identity) return null;

  const routed = resolveModel({
    projectDir: targetDir,
    task: task
      ? ({
          difficulty: difficulty ?? undefined,
          modelHint: (task as { modelHint?: string }).modelHint,
          id: task.id,
          key: task.compositeKey,
        } as never)
      : undefined,
    feature: (feature ?? undefined) as never,
    sprint: (sprint ?? undefined) as never,
    phase: phase ?? undefined,
    role: (config.currentRole ?? undefined) as string | undefined,
  });
  const thinking = resolveThinking({
    projectDir: targetDir,
    task: difficulty ? ({ difficulty } as never) : undefined,
    feature: (feature ?? undefined) as never,
    sprint: (sprint ?? undefined) as never,
  });

  return {
    level,
    key: identity.key,
    label: identity.label,
    phase,
    difficulty,
    model: (routed && routed.trim()) || (baseModel ?? "") || "",
    thinking: thinking || "",
    taskKey: task?.compositeKey ?? null,
    featureId: feature?.id ?? null,
    scope: SCOPE_TEXT[level],
  };
}

function goalGuess(list: { goals?: Array<{ id: string; title: string }> }, goalId: string): string {
  const g = (list.goals ?? []).find((x) => x.id === goalId);
  return g ? `${g.id} · ${short(g.title)}` : goalId;
}

function short(s: string | undefined, n = 44): string {
  const v = (s ?? "").replace(/\s+/g, " ").trim();
  return v.length > n ? v.slice(0, n - 1) + "…" : v;
}

/** One line for the widget: what this unit is and which model owns it. */
export function describeUnit(unit: WorkUnit, baseModel?: string | null): string {
  const model = unit.model || baseModel || "pi default";
  const diff = unit.difficulty ? ` (${unit.difficulty})` : "";
  return `${unit.level} ${unit.label}${diff} → ${model}${unit.thinking ? ` · ${unit.thinking}` : ""}`;
}

// ── the loop ────────────────────────────────────────────────────────────────

export type SupervisorHooks = {
  /** Called whenever the state file changes, so the host can redraw. */
  onState?: (state: SupervisorState) => void;
  /** Called for every activity line, so the host can notify sparingly. */
  onActivity?: (line: ActivityLine) => void;
  /** A phase's gate passed and a human has to sign it. */
  onApproval?: (phase: Phase, message: string) => void;
  /** The run ended, for whatever reason. */
  onStop?: (reason: string, detail: string) => void;
};

export type SupervisorOptions = {
  targetDir: string;
  runId: string;
  /** What the main session is on. An empty router slot inherits this. */
  baseModel?: string | null;
  hooks?: SupervisorHooks;
  /** Ceiling on units, so a test can bound the loop. */
  maxCycles?: number;
  /** Cap on one prompt→settled cycle inside a worker. */
  turnTimeoutMs?: number;
  /** Extra argv for every worker. The e2e rig points workers at its mock model. */
  workerArgs?: string[];
  workerEnv?: NodeJS.ProcessEnv;
  /**
   * Path to the harness extension, used only if a worker turns out not to
   * have discovered it. See `WorkerSpec.harnessExtension`.
   */
  harnessExtension?: string | null;
  /** Injected for tests. */
  createWorker?: (spec: ConstructorParameters<typeof WorkerSession>[0]) => WorkerSession;
  decide?: typeof decideNext;
  /** Pause between cycles, so a fast failure loop cannot spin the CPU. */
  idleMs?: number;
  /** Identifies this driver in the ownership claim. Defaults to the pid. */
  sessionId?: string;
  /** Drive even when another session holds the claim. Only a human asks for this. */
  takeOver?: boolean;
};

/** Returned instead of a supervisor when another session is already driving. */
export type SupervisorRefusal = { started: false; reason: string; owner: SupervisorOwner };

export function isRefusal(r: RunningSupervisor | SupervisorRefusal): r is SupervisorRefusal {
  return (r as SupervisorRefusal).started === false;
}

/**
 * A running supervisor.
 *
 * `stop()` is safe to call from anywhere, including a pi shutdown handler; it
 * closes the worker and resolves once the loop has actually left.
 */
export type RunningSupervisor = {
  readonly runId: string;
  stop(reason?: string): Promise<void>;
  readonly done: Promise<void>;
  isRunning(): boolean;
};

const DEFAULT_IDLE_MS = 750;

/** The shape `WorkerSession.prompt` resolves to; kept local so tests can fake it. */
type TurnLike = {
  summary: string;
  tools: string[];
  usage: { inputTokens: number; outputTokens: number };
  contextRatio: number | null;
  aborted: boolean;
  error: string | null;
};

export function startSupervisor(options: SupervisorOptions): RunningSupervisor | SupervisorRefusal {
  const dir = options.targetDir;
  if (!options.takeOver) {
    const owner = activeOwner(dir);
    if (owner) {
      return {
        started: false,
        reason:
          `another pi session (pid ${owner.pid}) is already driving this run. ` +
          `Two supervisors would put two workers in the same tree.`,
        owner,
      };
    }
  }
  // A supervisor that was killed cannot close its worker, and that worker
  // keeps editing the project with nothing watching it.
  const orphan = reapOrphanWorker(dir);
  const decide = options.decide ?? decideNext;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  let stopping = false;
  let stopReason: string | null = null;
  /**
   * Resolved by `stop()`. The loop races every await that can block for a
   * long time against it, so halting is immediate even when the thing being
   * awaited is a wedged worker rather than a healthy one.
   */
  let signalStop: () => void = () => {};
  const stopSignal = new Promise<void>((r) => {
    signalStop = r;
  });
  let worker: WorkerSession | null = null;
  let workerView: WorkerView | null = null;
  let workerSeq = 0;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  /** True once the loop has left: the ownership claim must never come back. */
  let released = false;

  const state = loadSupervisorState(dir) ?? emptySupervisorState(options.runId);
  state.runId = options.runId;
  state.owner = { pid: process.pid, sessionId: options.sessionId ?? String(process.pid), at: new Date().toISOString(), workerPid: null };
  state.status = "running";
  state.startedAt = new Date().toISOString();
  state.baseModel = options.baseModel ?? null;
  state.stopReason = null;
  state.worker = null;
  saveSupervisorState(dir, state);

  const publish = (): void => {
    state.worker = workerView;
    // The claim is refreshed on every publish, which happens on every worker
    // event — far more often than the stale window, so a live run never looks
    // abandoned and an abandoned one always does. Once released it stays
    // released: re-stamping it on the way out would leave a dead claim behind
    // for the next session to wait out.
    state.owner = released
      ? null
      : {
          pid: process.pid,
          sessionId: options.sessionId ?? String(process.pid),
          at: new Date().toISOString(),
          workerPid: worker?.pid ?? null,
        };
    saveSupervisorState(dir, state);
    try {
      options.hooks?.onState?.(state);
    } catch {
      /* a broken host must not stop the run */
    }
  };

  const say = (level: ActivityLevel, text: string, who: string | null = null): void => {
    const line: ActivityLine = { at: new Date().toISOString(), level, worker: who, text };
    appendActivity(dir, { level, worker: who, text });
    try {
      options.hooks?.onActivity?.(line);
    } catch {
      /* ditto */
    }
  };

  const closeWorker = async (why: string): Promise<void> => {
    if (!worker) return;
    const name = workerView?.name ?? "worker";
    await worker.close();
    if (workerView) {
      workerView.state = "closed";
      workerView.doing = why;
      state.history = [...state.history, workerView].slice(-HISTORY_LIMIT);
    }
    worker = null;
    workerView = null;
    say("info", `${name} finished — ${why}`, name);
    publish();
  };

  const openWorker = async (unit: WorkUnit): Promise<WorkerSession | null> => {
    const name = `W${++workerSeq}`;
    const attemptDir = join(
      resolve(dir, "tmp", "infinity-harness"),
      sanitize(options.runId),
      sanitize(unit.key),
      `session-${workerSeq}`,
    );
    mkdirSync(attemptDir, { recursive: true });
    workerView = {
      name,
      unitKey: unit.key,
      unitLabel: unit.label,
      level: unit.level,
      difficulty: unit.difficulty,
      model: unit.model || options.baseModel || "",
      servedModel: null,
      thinking: unit.thinking,
      state: "starting",
      doing: "starting a fresh pi session",
      startedAt: new Date().toISOString(),
      turns: 0,
      tokens: { inputTokens: 0, outputTokens: 0 },
      contextRatio: null,
      sessionId: null,
      attemptDir,
    };
    publish();
    say(
      "info",
      `${name} starting — ${unit.level} ${unit.label} on ${workerView.model || "pi's default model"}` +
        (unit.difficulty ? ` (${unit.difficulty})` : ""),
      name,
    );

    const spec = {
      projectDir: dir,
      attemptDir,
      model: unit.model || options.baseModel || null,
      thinking: unit.thinking || null,
      sessionDir: workerSessionDir(dir),
      sessionName: `infinity ${unit.key}`,
      unitKey: unit.key,
      runId: options.runId,
      turnTimeoutMs: options.turnTimeoutMs,
      extraArgs: options.workerArgs,
      env: options.workerEnv,
    };
    let session = options.createWorker ? options.createWorker(spec) : new WorkerSession(spec);
    session.on((e) => onWorkerEvent(name, e));
    session.start();
    let ok = await session.ready();
    // A worker that did not discover the harness cannot record what it did,
    // and a run whose gate never sees the work loops forever on a finished
    // task. Restart it once with the extension named explicitly.
    if (ok && options.harnessExtension && !(await session.hasHarnessTools())) {
      say("warn", `${name} started without the harness tools — restarting it with the extension loaded`, name);
      await session.close();
      const withExt = { ...spec, harnessExtension: options.harnessExtension };
      session = options.createWorker ? options.createWorker(withExt) : new WorkerSession(withExt);
      session.on((e) => onWorkerEvent(name, e));
      session.start();
      ok = await session.ready();
    }
    if (!ok) {
      if (workerView) workerView.state = "failed";
      say("error", `${name} could not start pi — ${session.startError ?? "no response"}`, name);
      publish();
      await session.close();
      worker = null;
      workerView = null;
      return null;
    }
    if (workerView) {
      workerView.state = "working";
      workerView.sessionId = session.sessionId;
      workerView.doing = "reading the brief";
    }
    worker = session;
    state.sessions += 1;
    countSession(dir);
    publish();
    return session;
  };

  const onWorkerEvent = (name: string, e: WorkerEvent): void => {
    if (!workerView || workerView.name !== name) return;
    switch (e.kind) {
      case "tool":
        workerView.doing = e.summary;
        say("work", e.summary, name);
        break;
      case "model":
        workerView.servedModel = e.provider ? `${e.provider}/${e.model}` : e.model;
        break;
      case "usage":
        workerView.tokens = { inputTokens: e.inputTokens, outputTokens: e.outputTokens };
        break;
      case "compaction":
        say("warn", `${name} compacted its context`, name);
        break;
      case "error":
        say("error", e.message, name);
        break;
      default:
        return;
    }
    publish();
  };

  const humanStopped = (): string | null => {
    if (fileExists(stopFilePath(dir))) return "a STOP file is present";
    const run = loadRunState(dir);
    if (!run || !run.armed) return run?.stopReason ?? "the run is not armed";
    const { config } = loadConfig(dir);
    if (config.paused) return "the run is paused";
    return null;
  };

  const loop = async (): Promise<void> => {
    let cycles = 0;
    try {
      if (orphan) say("warn", `killed an orphaned worker (pid ${orphan}) left by a previous session`);
      say("info", `supervisor started — handoff at ${loadConfig(dir).config.session?.handoff ?? "task"} level`);
      // A long quiet turn must not let the claim go stale under a second
      // session that would then start a worker of its own.
      heartbeat = setInterval(() => {
        if (stopping) return;
        try {
          publish();
        } catch {
          /* a claim that cannot be written is not worth crashing a run for */
        }
      }, HEARTBEAT_MS);
      heartbeat.unref?.();
      while (!stopping) {
        if (options.maxCycles !== undefined && cycles >= options.maxCycles) {
          stopReason = stopReason ?? "cycle ceiling reached";
          break;
        }
        cycles += 1;

        const brake = humanStopped();
        if (brake) {
          stopReason = brake;
          break;
        }

        const { decision } = await decide({ targetDir: dir, runId: options.runId });
        state.lastDecision = decision.action;
        state.handoff = (loadConfig(dir).config.session?.handoff ?? "task") as HandoffGranularity;

        if (decision.action === "stop" || decision.action === "wait") {
          stopReason = decision.detail;
          await closeWorker(decision.action === "stop" ? "run finished" : "run parked");
          disarmRun(dir, decision.detail);
          say(decision.reason === "complete" ? "good" : "warn", `run ${decision.action}: ${decision.detail}`);
          try {
            options.hooks?.onStop?.(decision.reason, decision.detail);
          } catch {
            /* host */
          }
          publish();
          return;
        }

        if (decision.action === "approve") {
          // A signature is a human boundary, so the worker is closed rather
          // than left holding a context window open for however long the
          // human takes to come back.
          await closeWorker(`waiting for your signature on ${decision.phase.toUpperCase()}`);
          state.unit = null;
          publish();
          say("warn", `${decision.phase.toUpperCase()} passed its gate and needs your signature — /infinity:approve`);
          try {
            options.hooks?.onApproval?.(decision.phase, decision.message);
          } catch {
            /* host */
          }
          await Promise.race([waitWhile(() => !stopping && stillAwaiting(dir), idleMs, 0), stopSignal]);
          continue;
        }

        // -- continue / advanced: there is work, and someone has to do it ----
        const unit = currentUnit(dir, options.baseModel);
        if (!unit) {
          stopReason = "nothing actionable and no phase to work on";
          break;
        }
        state.unit = unit;

        if (decision.action === "advanced") {
          say("good", `gate passed → ${decision.toPhase.toUpperCase()}`);
        }

        // The unit boundary IS the handoff: a different unit means a different
        // session and, because the model is chosen at spawn, a different model.
        if (worker && workerView && workerView.unitKey !== unit.key) {
          await closeWorker(`handoff — ${workerView.unitLabel} → ${unit.label}`);
        }
        // An escalation that names a stronger model is also a model boundary,
        // and therefore also a new session: `set_model` mid-session would put
        // the stronger model in front of the weaker one's failed reasoning,
        // which is the context we are trying to get away from.
        const escalated = decision.action === "continue" ? (decision.escalation ?? null) : null;
        if (escalated?.model && worker && workerView && workerView.model !== escalated.model) {
          await closeWorker(`escalating to ${escalated.model} (${escalated.strategy})`);
          say("warn", `escalation: ${escalated.strategy} → ${escalated.model}`);
          unit.model = escalated.model;
        } else if (escalated?.model) {
          unit.model = escalated.model;
        }
        // Context pressure inside a worker is the other reason to replace it,
        // and it is the one that matters on a small model: a session that
        // compacts has already lost the detail the next turn needed.
        if (worker && workerView) {
          const threshold = loadConfig(dir).config.session?.contextThreshold ?? 0;
          const ratio = workerView.contextRatio;
          if (threshold > 0 && typeof ratio === "number" && ratio >= threshold) {
            await closeWorker(`context ${Math.round(ratio * 100)}% full — fresh session`);
          }
        }

        if (!worker) {
          const started = await openWorker(unit);
          if (!started) {
            stopReason = "could not start a background pi session";
            break;
          }
        }
        if (!worker || !workerView) break;

        // A fresh session needs the whole brief. A session that has been on
        // this unit since the last cycle already has it, and re-sending it
        // every cycle is the largest avoidable cost in a long run.
        const returning = workerView.turns > 0;
        const body = returning ? (decision.headline ?? decision.message) : decision.message;
        const prompt = returning
          ? `${body}\n\n${WORKER_DIRECTIVE}`
          : `${body}\n\n---\n\nYOUR REMIT: ${unit.scope}\n\n${WORKER_DIRECTIVE}`;
        workerView.turns += 1;
        workerView.state = "working";
        publish();
        const turn = await Promise.race([
          worker.prompt(prompt, options.turnTimeoutMs),
          stopSignal.then(
            (): TurnLike => ({ summary: "", tools: [], usage: { inputTokens: 0, outputTokens: 0 }, contextRatio: null, aborted: true, error: null }),
          ),
        ]);
        if (stopping) break;
        if (workerView) {
          workerView.contextRatio = turn.contextRatio;
          workerView.state = "idle";
          workerView.doing = short(turn.summary, 96) || "waiting for the gate";
          publish();
        }
        if (turn.error) {
          say("warn", `${workerView?.name ?? "worker"} — ${turn.error}`, workerView?.name ?? null);
          // A worker that cannot take a prompt is not a worker. Replace it
          // rather than asking a corpse the same question forever.
          await closeWorker(turn.error);
        } else if (turn.summary) {
          say("info", short(turn.summary, 160), workerView?.name ?? null);
        }
        if (idleMs > 0) await Promise.race([sleep(idleMs), stopSignal]);
      }
    } catch (e) {
      stopReason = `supervisor error: ${e instanceof Error ? e.message : String(e)}`;
      say("error", stopReason);
      disarmRun(dir, stopReason);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      released = true;
      await closeWorker(stopReason ?? "stopped");
      state.status = "stopped";
      state.stopReason = stopReason;
      state.unit = null;
      publish();
      if (stopReason) say("info", `supervisor stopped — ${stopReason}`);
    }
  };

  const done = loop();

  return {
    runId: options.runId,
    isRunning: () => !stopping && state.status === "running",
    async stop(reason = "stopped by the human"): Promise<void> {
      if (stopping) {
        await done;
        return;
      }
      stopping = true;
      stopReason = stopReason ?? reason;
      signalStop();
      // Kill the child first: the loop may be parked on its turn, and that
      // turn is the only thing keeping the loop from noticing the stop.
      if (worker) {
        try {
          await worker.close();
        } catch {
          /* already gone */
        }
      }
      await done;
    },
    done,
  };
}

function stillAwaiting(targetDir: string): boolean {
  try {
    return Boolean(loadConfig(targetDir).config.awaitingApproval);
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

/** Poll a predicate. `limit` of 0 means forever (until the supervisor stops). */
async function waitWhile(pred: () => boolean, everyMs: number, limit: number): Promise<void> {
  let waited = 0;
  while (pred()) {
    await sleep(Math.max(200, everyMs));
    waited += Math.max(200, everyMs);
    if (limit > 0 && waited >= limit) return;
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "unit";
}

/** Read-only view for the widget, the dashboard and `/infinity:workers`. */
export function supervisorView(targetDir: string): {
  state: SupervisorState | null;
  activity: ActivityLine[];
  routerEnabled: boolean;
} {
  return {
    state: loadSupervisorState(targetDir),
    activity: loadActivity(targetDir),
    routerEnabled: (() => {
      try {
        return loadRouterConfig(targetDir).enabled;
      } catch {
        return false;
      }
    })(),
  };
}

export type { LoopDecision };
