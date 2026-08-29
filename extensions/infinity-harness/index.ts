/**
 * infinity-harness — the pi extension.
 *
 * This file is deliberately thin. It owns pi's lifecycle and nothing else:
 * every decision about phases, gates, plans and looping lives in `src/`, where
 * it is typed and unit-tested. An earlier version inlined copies of the plan
 * engine and the widget here, which meant the tested code and the shipped code
 * were two different implementations that drifted apart. There is one
 * implementation now, and this adapter calls it.
 *
 * What the adapter is responsible for:
 *   - injecting the brief when a session starts
 *   - running the gate when the agent goes quiet, and advancing or re-briefing
 *   - keeping the plan widget truthful
 *   - surviving compaction without losing the plan
 *   - refusing tool calls that would skip a phase
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { isHarnessProject, loadConfig, saveConfig } from "../../src/core/config.ts";
import { loadFeatureList, computeProgress, nextActionableTask } from "../../src/core/featureList.ts";
import { buildBrief, renderBrief } from "../../src/core/brief.ts";
import { runChecks } from "../../src/core/gates.ts";
import { advancePhase } from "../../src/core/phases.ts";
import { configPath } from "../../src/core/paths.ts";
import { readJsonSafe } from "../../src/core/fsx.ts";
import { withLock } from "../../src/core/lock.ts";
import {
  DEFAULT_ENABLED_PHASES,
  ValidationError,
  type FeatureList,
  type Phase,
} from "../../src/core/types.ts";
import { writeTaskList, summarizeApply, type TaskInput } from "../../src/taskList.ts";
import { renderWidget, renderStatusLine, type WidgetState } from "../../src/ui/widget.ts";
import { createStyler, detectGlyphs } from "../../src/ui/theme.ts";
import { decideNext, fingerprint, stopFilePath, loopStatePath } from "../../src/loop.ts";
import { runConfigMenu, renderSettings, type ModelChoice, type Prompter } from "../../src/ui/config.ts";
import { SETTINGS, readAll, readSetting, formatValue } from "../../src/core/settings.ts";
import { detectStack, describeInit, initHarness, type StackId } from "../../src/core/init.ts";
import { startRework, loadRework, clearRework } from "../../src/rework.ts";
import { amendPlan, loadReplanHistory, type ReplanTaskInput } from "../../src/replan.ts";
import { chooseUnstuckStrategy } from "../../src/unstuck.ts";
import { escalationSummary } from "../../src/escalate.ts";
import { spawnIsolatedWorker } from "../../src/worker.ts";
import { executionPolicyOf } from "../../src/scheduler.ts";
import { isWorkerProcess } from "../../src/exec/piWorker.ts";
import {
  appendActivity,
  currentUnit,
  describeUnit,
  loadActivity,
  loadSupervisorState,
  isRefusal,
  startSupervisor,
  type ActivityLine,
  type RunningSupervisor,
  type SupervisorState,
} from "../../src/supervisor.ts";
import {
  startGoal,
  loadGoal,
  reviewGoal,
  cancelGoal,
  recordPipelinePass,
  viewOf,
  describeGoal,
  type ReviewInput,
} from "../../src/goal.ts";
import { flattenTasks } from "../../src/core/featureList.ts";
import {
  armRun,
  countSession,
  disarmRun,
  loadRunState,
  runIdFor,
} from "../../src/runState.ts";
import {
  clearHandoff,
  composeKickoff,
  describeHandoff,
  hasPendingHandoff,
  requestHandoff,
  shouldHandoff,
  takeHandoff,
  type HandoffReason,
} from "../../src/handoff.ts";
import { needsApproval, resolveApproval, approvedPhases } from "../../src/approval.ts";
import {
  buildDisplay,
  pickDisplay,
  pickWorkflow,
  runIntakeWizard,
  unattendedIntake,
} from "../../src/ui/wizard.ts";
import {
  applyWorkflow,
  findWorkflow,
  listWorkflows,
  matchWorkflow,
  renderWorkflow,
  signedPhases,
  summarizeWorkflow,
} from "../../src/workflow.ts";
import {
  findDisplay,
  listDisplays,
  normalizeDisplay,
  summarizeDisplay,
} from "../../src/ui/display.ts";
import type { DisplayPolicy } from "../../src/core/types.ts";
import { defaultView, scrollView, SCROLL_STEP, TASK_WINDOW, EXPANDED_WINDOW, type WidgetView } from "../../src/ui/widget.ts";
import { buildPlanRows } from "../../src/ui/planTree.ts";

/**
 * This file's own path.
 *
 * A background worker normally discovers the harness the same way this
 * session did, because the harness is an installed pi package. When it was
 * loaded from an explicit `-e` instead — a dev checkout, and every e2e run —
 * discovery finds nothing, and the supervisor restarts the worker with this
 * path so it still has the plan tools.
 */
const SELF_PATH: string | null = (() => {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return null;
  }
})();

const CHECKPOINT = "infinity:checkpoint";
const WIDGET_KEY = "infinity-harness";
const STATUS_KEY = "infinity";

/** Reminder cadence, in LLM calls, when the plan still has open tasks. */
const REMINDER_INTERVAL = 4;

function projectDir(ctx: unknown): string {
  const c = ctx as { cwd?: string; projectDir?: string } | undefined;
  return c?.cwd ?? c?.projectDir ?? process.cwd();
}

function notify(ctx: unknown, message: string, level: "info" | "warning" | "error" = "info"): void {
  try {
    (ctx as { ui?: { notify?: (m: string, t?: string) => void } }).ui?.notify?.(message, level);
  } catch {
    /* headless mode has no UI */
  }
}

export default function (pi: ExtensionAPI): void {
  // -- session-scoped state -------------------------------------------------
  //
  // Everything a *run* needs outlives this session and lives in `harness/`.
  // What is left here is genuinely per-session: this session's own id, and
  // where the human has scrolled the widget.
  const sessionId = randomUUID();
  let llmCalls = 0;
  let loopBusy = false;
  let handingOff = false;
  let lastBriefPhase: string | null = null;
  let remoteServer: { url: string; close: () => Promise<void> } | null = null;
  let remoteDir: string | null = null;
  let view: WidgetView = defaultView();

  /**
   * The background orchestrator, when one is running in this session.
   *
   * It is a plain async loop in this process — no LLM, no tokens — that keeps
   * one `pi` child working on the current unit. Only one session drives a run
   * at a time; a second pi window on the same project shows the widget and
   * the log, and leaves the driving alone.
   */
  let supervisor: RunningSupervisor | null = null;
  /** This session is a background worker, not the human's control panel. */
  const workerProcess = isWorkerProcess();
  /** Ring of activity lines mirrored into the widget. */
  let activity: ActivityLine[] = [];
  let supState: SupervisorState | null = null;

  /**
   * Is this instance's session still the live one?
   *
   * After `ctx.newSession()` pi tears the old runtime down and rebinds
   * extensions, but this closure and its registered handlers still exist. Any
   * of them that touches `pi` or a captured `ctx` afterwards gets
   * "This extension ctx is stale after session replacement" — which is what a
   * handoff produced on every single turn until this flag existed.
   */
  let sessionLive = true;

  /**
   * Is a continuous run armed?
   *
   * Read from disk, not from a closure variable. The old `let loopEnabled`
   * died with the pi session that held it, which meant the first session
   * handoff — the whole point of the fresh-session policy — silently ended
   * the run it was supposed to continue.
   */
  const loopArmed = (dir: string): boolean => loadRunState(dir)?.armed === true;

  /** The run this session belongs to, or this session, when nothing is armed. */
  const runFor = (dir: string): string => runIdFor(dir, sessionId);

  const styler = createStyler();
  const glyphs = detectGlyphs();

  // -- widget ---------------------------------------------------------------

  const handoffNoteFor = (h: import("../../src/core/types.ts").HandoffGranularity): string | null => {
    const map: Record<string, string> = {
      off: "Model per run (off/goal) — the whole run shares its hardest model; finer per-task routing requires task/subtask handoff",
      goal: "Model per run (off/goal) — the whole run shares its hardest model; finer per-task routing requires task/subtask handoff",
      phase: "Model per phase — tasks & subtasks in a phase share the hardest model in that phase",
      sprint: "Model per sprint — tasks & subtasks in a sprint share the hardest model in that sprint",
      feature: "Model per feature — tasks & subtasks in a feature share the hardest model in that feature",
      task: "Model per task — subtasks share their parent task's model",
      subtask: "Model per subtask — each subtask may use its own model (needs subtask difficulty)",
    };
    return map[h] ?? null;
  };

  const widgetStateFor = (dir: string): WidgetState | null => {
    try {
      const { list } = loadFeatureList(dir);
      const { config } = loadConfig(dir);
      const handoffModelNote: string | null = handoffNoteFor((config.session?.handoff as import("../../src/core/types.ts").HandoffGranularity) ?? "task");
      const spent = escalationSummary(dir);
      const loop = readJsonSafe<{ escalations?: { strategy: string }[] } | null>(
        loopStatePath(dir),
        null,
      );
      const lastRung = loop?.escalations?.[loop.escalations.length - 1]?.strategy ?? null;
      const pass = typeof config.goalPass === "number" ? config.goalPass : null;
      const maxPasses = typeof config.goalMaxPasses === "number" ? config.goalMaxPasses : null;
      const run = loadRunState(dir);
      const sup = supState ?? loadSupervisorState(dir);
      const worker = sup?.worker ?? null;
      return {
        list,
        view,
        engine: executionPolicyOf(config).engine,
        workers: worker
          ? [
              {
                name: worker.name,
                unit: worker.unitLabel,
                level: worker.level,
                model: worker.servedModel ?? worker.model,
                difficulty: worker.difficulty,
                state: worker.state,
                doing: worker.doing,
                tokens: worker.tokens.inputTokens + worker.tokens.outputTokens,
                contextRatio: worker.contextRatio,
              },
            ]
          : [],
        activity: (activity.length ? activity : loadActivity(dir)).slice(-40).map((l) => ({
          at: l.at,
          level: l.level,
          worker: l.worker,
          text: l.text,
        })),
        dashboardUrl: remoteServer?.url ?? null,
        handoffModelNote,
        sessions: run?.sessions ?? null,
        intake: typeof config.intake?.brief === "string" ? config.intake.brief : null,
        awaitingApproval: config.awaitingApproval ?? null,
        display: normalizeDisplay(config.display),
        phase: config.currentPhase,
        enabledPhases: config.phases?.enabled,
        paused: Boolean(config.paused),
        revision: list.baseRevision,
        retries: { task: config.taskRetryCount ?? 0, max: config.maxRetries ?? 10 },
        goalPass: pass && maxPasses ? { current: pass, max: maxPasses } : null,
        escalation:
          lastRung || spent.reworks || spent.replans
            ? { strategy: lastRung, reworks: spent.reworks, replans: spent.replans }
            : null,
      };
    } catch {
      return null;
    }
  };

  const refreshWidget = (ctx: ExtensionContext): void => {
    try {
      const dir = projectDir(ctx);
      const state = widgetStateFor(dir);
      if (!state) return;
      const lines = renderWidget(state, { width: 76, styler, glyphs });
      ctx.ui.setWidget(WIDGET_KEY, lines);
      ctx.ui.setStatus(STATUS_KEY, renderStatusLine(state, glyphs));
    } catch {
      /* the widget is never worth breaking a turn over */
    }
  };

  /** How many rows the plan currently has — the bound for scrolling. */
  const planRowCount = (dir: string): number => {
    try {
      const { list } = loadFeatureList(dir);
      return buildPlanRows(list, null, { expandSubtasks: view.expanded }).length;
    } catch {
      return 0;
    }
  };

  /**
   * The widget is a window onto the plan, and the window has to move.
   *
   * A fixed nine-row slice of a sixty-row plan is a widget that is *truncated*,
   * which is exactly how it read: the rows outside the window may as well not
   * exist. They exist; these keys reach them.
   */
  const moveView = (ctx: ExtensionContext, delta: number): void => {
    const dir = projectDir(ctx);
    const rows = planRowCount(dir);
    const windowRows = view.expanded ? EXPANDED_WINDOW : TASK_WINDOW;
    view = scrollView(view, delta, rows, windowRows);
    refreshWidget(ctx);
  };

  // -- brief ----------------------------------------------------------------

  const briefText = async (dir: string, includeGate = false): Promise<string> => {
    const { config } = loadConfig(dir);
    const brief = await buildBrief(dir, { includeGate });
    const routed = await routingSummaryForBrief(dir).catch(() => null as string | null);
    const text = renderBrief(brief, config);
    return routed ? `${text}\n\n${routed}` : text;
  };

  // -- configuration --------------------------------------------------------

  /**
   * The models this session can actually use.
   *
   * Prefers `scopedModels` when the user has scoped the session, because those
   * are the models they deliberately chose; otherwise every model pi holds
   * working credentials for. Models without auth are excluded — offering one
   * would produce a tier that fails at the first task rather than at setup.
   */
  const availableModels = (ctx: ExtensionContext): ModelChoice[] => {
    try {
      const scoped = ctx.scopedModels ?? [];
      const models =
        scoped.length > 0
          ? scoped.map((s) => s.model)
          : (ctx.modelRegistry?.getAvailable?.() ?? []);

      const seen = new Set<string>();
      const out: ModelChoice[] = [];
      for (const m of models) {
        if (!m?.id || !m?.provider) continue;
        const ref = `${m.provider}/${m.id}`;
        if (seen.has(ref)) continue;
        seen.add(ref);
        const bits: string[] = [ref];
        if (m.name && m.name !== m.id) bits.push(`· ${m.name}`);
        if (m.contextWindow) bits.push(`· ${Math.round(m.contextWindow / 1000)}k ctx`);
        if (m.reasoning) bits.push("· reasoning");
        out.push({ ref, label: bits.join(" ") });
      }
      out.sort((a, b) => a.ref.localeCompare(b.ref));
      return out;
    } catch {
      return [];
    }
  };

  /** Adapt pi's UI to the prompter the config flow expects. */
  const prompterFor = (ctx: ExtensionContext): Prompter => ({
    select: (title, opts) => ctx.ui.select(title, opts),
    input: (title, placeholder) => ctx.ui.input(title, placeholder),
    notify: (message, level) => notify(ctx, message, level ?? "info"),
  });

  // -- model + thinking routing (live session) --------------------------------
  const applyRouting = async (ctx: ExtensionContext, dir: string, source: string): Promise<void> => {
    try {
      const { resolveModel, resolveThinking } = await import("../../src/modelRouter.ts");
      const { effectiveDifficultyForTask } = await import("../../src/scheduler.ts");
      const { nextActionableTask, findFeature } = await import("../../src/core/featureList.ts");
      const { loadFeatureList: loadList } = await import("../../src/core/featureList.ts");
      const list = loadList(dir).list;
      const task = nextActionableTask(list);
      const cfg = loadConfig(dir).config;
      const handoff = (cfg.session?.handoff ?? "task") as import("../../src/core/types.ts").HandoffGranularity;
      // Effective difficulty honors handoff bucket: phase/feature/sprint tasks share hardest in that bucket.
      const effDiff = task && list ? (effectiveDifficultyForTask(task as import("../../src/core/featureList.ts").FlatTask, handoff, list) ?? (task as { difficulty?: string }).difficulty) : (task as { difficulty?: string } | null)?.difficulty;
      // Resolve against task/parent feature/sprint difficulty; fall through to default when no actionable.
      const feature = task ? findFeature(list, task.featureId) ?? undefined : undefined;
      const sprint = feature?.sprintId ? (list.sprints ?? []).find((s) => s.id === feature.sprintId) ?? undefined : undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type T = NonNullable<ReturnType<typeof nextActionableTask>>;
      const routedModel = resolveModel({
        projectDir: dir,
        task: effDiff || (feature as { difficulty?: string } | undefined)?.difficulty ? ({ difficulty: effDiff as string | undefined, modelHint: (task as T | undefined)?.modelHint, id: task?.id, key: (task as T | undefined)?.compositeKey ?? (task as T | undefined)?.key } as never) : undefined,
        feature: feature as never,
        sprint: sprint as never,
        phase: loadConfig(dir).config.currentPhase ?? undefined,
        role: loadConfig(dir).config.currentRole ?? undefined,
      });
      const routedThinking = resolveThinking({
        projectDir: dir,
        task: effDiff ? ({ difficulty: effDiff as string } as never) : (task as T | null | undefined) ? ({ difficulty: (task as T | undefined)?.difficulty, id: task?.id, key: (task as T | undefined)?.compositeKey ?? (task as T | undefined)?.key } as never) : undefined,
        feature: feature as never,
        sprint: sprint as never,
      });

      if (routedModel && routedModel.trim()) {
        // Map "provider/id" -> Model via registry.
        const ref = routedModel.trim();
        const slash = ref.indexOf("/");
        const provider = slash > 0 ? ref.slice(0, slash) : undefined;
        const modelId = slash > 0 ? ref.slice(slash + 1) : ref;
        const available: unknown[] = (() => { try { return (ctx.modelRegistry?.getAvailable?.() ?? []) as unknown[]; } catch { return []; } })();
        const found = (() => {
          if (!provider) return undefined;
          try { return (ctx.modelRegistry as unknown as { find(provider: string, id: string): unknown }).find(provider, modelId); } catch { return undefined; }
        })();
        const candidate = found ?? available.find((m) => {
          const id = (m as { id?: string })?.id;
          const prov = (m as { provider?: string })?.provider;
          return id && (prov ? `${prov}/${id}` === ref : id === ref || id === modelId);
        }) as { id?: string; provider?: string } | undefined;
        const modelObj = (found as { id?: string } | undefined) ?? candidate;
        if (modelObj && routedModel) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ok = await (ctx as unknown as { setModel(m: unknown): Promise<boolean> }).setModel(modelObj as never);
            (ctx.ui as unknown as { setStatus?: (k: string, v: string | undefined) => void })?.setStatus?.("infinity-model", routedModel);
            if (!ok) {
              notify(ctx, `infinity-harness: routed model ${ref} not available (no auth) — staying on current model.`, "warning");
            } else if (source) {
              notify(ctx, `infinity-harness: routed to ${ref}${routedThinking ? ` (${routedThinking})` : ""} for ${task?.compositeKey ?? task?.id ?? "next task"} [${source}]`, "info");
            }
          } catch (e) {
            notify(ctx, `infinity-harness: setModel(${ref}) — ${(e as Error)?.message ?? String(e)}`, "warning");
          }
        } else {
          // Model id present but not in registry — surface once per session, and in widget.
          ;(ctx.ui as unknown as { setStatus?: (k: string, v: string | undefined) => void })?.setStatus?.("infinity-model", routedModel);
          notify(ctx, `infinity-harness routing wants ${ref} for ${task?.compositeKey ?? "next task"} but that model is not in pi's registry (check auth / --models) [${source}]`, "warning");
        }
      } else {
        // No routed model → show inherited; do not call setModel.
        ;(ctx.ui as unknown as { setStatus?: (k: string, v: string | undefined) => void })?.setStatus?.("infinity-model", undefined);
      }

      if (routedThinking && routedThinking.trim()) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (ctx as unknown as { setThinkingLevel(l: string): void }).setThinkingLevel(routedThinking as never);
        } catch {}
      }
    } catch {}
  };

  const routingSummaryForBrief = async (dir: string): Promise<string | null> => {
    try {
      const { nextActionableTask, findFeature } = await import("../../src/core/featureList.ts");
      const { resolveModel, resolveThinking } = await import("../../src/modelRouter.ts");
      const { effectiveDifficultyForTask } = await import("../../src/scheduler.ts");
      const { list } = loadFeatureList(dir);
      const task = nextActionableTask(list);
      if (!task) return null;
      const cfg = loadConfig(dir).config;
      const handoff = (cfg.session?.handoff ?? "task") as import("../../src/core/types.ts").HandoffGranularity;
      const effDiff = effectiveDifficultyForTask(task as import("../../src/core/featureList.ts").FlatTask, handoff, list) ?? (task as { difficulty?: string }).difficulty;
      const feature = findFeature(list, task.featureId) ?? undefined;
      const sprint = feature?.sprintId ? (list.sprints ?? []).find((s) => s.id === feature.sprintId) ?? undefined : undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = resolveModel({ projectDir: dir, task: ({ difficulty: effDiff as string | undefined, modelHint: (task as any).modelHint, id: task.id, key: (task as any).compositeKey ?? (task as any).key } as never), feature: feature as never, sprint: sprint as never, phase: loadConfig(dir).config.currentPhase ?? undefined });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const th = resolveThinking({ projectDir: dir, task: ({ difficulty: effDiff as string | undefined } as never), feature: feature as never, sprint: sprint as never });
      if (!m || !m.trim()) return null;
      return `Routing: ${task.compositeKey} → ${m}${th ? ` · thinking ${th}` : ""}`;
    } catch { return null; }
  };


  // -- the background engine -------------------------------------------------

  /** Where work runs for this project, honouring the legacy escape hatch. */
  const engineFor = (dir: string): "background" | "main-session" => {
    try {
      return executionPolicyOf(loadConfig(dir).config).engine;
    } catch {
      return "background";
    }
  };

  /**
   * The model this session is on, as `provider/id`.
   *
   * A router slot left empty means "whatever pi is already configured with",
   * and a *child* process does not inherit that: it would fall back to pi's
   * default provider, which is not necessarily what the human is looking at.
   * So we read it here and hand it to the worker explicitly.
   */
  const baseModelOf = (ctx: unknown): string | null => {
    try {
      const m = (ctx as { model?: { id?: string; provider?: string } }).model;
      if (m?.id) return m.provider ? `${m.provider}/${m.id}` : m.id;
    } catch {
      /* pi without a model is a pi that cannot run anything anyway */
    }
    return null;
  };

  /**
   * Start the background orchestrator for this project.
   *
   * Everything it does happens in this process, in plain JavaScript. It costs
   * no tokens in this session: the only LLM calls a run makes are made by the
   * `pi` children it spawns, on the models the router chose for them.
   */
  const startEngine = async (ctx: ExtensionContext, dir: string): Promise<boolean> => {
    if (supervisor?.isRunning()) return true;
    if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
      // `pi -p` has no future in which to watch anything. Arming the run is
      // still right — the next interactive session picks it up.
      notify(ctx, "infinity-harness: run armed. Open pi interactively to drive it.", "info");
      return false;
    }
    const runId = runFor(dir);
    const started = startSupervisor({
      targetDir: dir,
      runId,
      sessionId,
      baseModel: baseModelOf(ctx),
      harnessExtension: SELF_PATH,
      hooks: {
        onState: (st) => {
          supState = st;
          if (sessionLive) refreshWidget(ctx);
        },
        onActivity: (line) => {
          activity = [...activity, line].slice(-120);
          if (!sessionLive) return;
          // Only the things a human would want interrupted for. Tool-by-tool
          // narration belongs in the widget's log, not in notifications.
          if (line.level === "error" || line.level === "warn" || line.level === "good") {
            notify(ctx, `infinity-harness: ${line.text}`, line.level === "error" ? "error" : line.level === "warn" ? "warning" : "info");
          }
          refreshWidget(ctx);
        },
        onApproval: (phase) => {
          if (sessionLive) void askForApproval(ctx, dir, phase);
        },
        onStop: (reason, detail) => {
          if (!sessionLive) return;
          notify(ctx, `infinity-harness: run finished — ${detail}`, reason === "complete" ? "info" : "warning");
          refreshWidget(ctx);
        },
      },
    });
    if (isRefusal(started)) {
      // A second pi window on the same project is a *viewer*. Saying so is
      // better than quietly putting two workers in one working tree.
      notify(ctx, `infinity-harness: ${started.reason} This window still shows the run.`, "warning");
      supervisor = null;
      refreshWidget(ctx);
      return false;
    }
    supervisor = started;
    return true;
  };

  const stopEngine = async (reason: string): Promise<void> => {
    const running = supervisor;
    supervisor = null;
    if (!running) return;
    try {
      await running.stop(reason);
    } catch {
      /* a supervisor that will not stop cleanly must not block the command */
    }
  };

  // -- session handoff ------------------------------------------------------

  /** The task/feature/sprint/goal/subtask the pipeline is on right now, or null. */
  const activePlanKeys = (dir: string): { task: string | null; feature: string | null; sprint: string | null; goal: string | null; subtask: string | null; } => {
    try {
      const { list } = loadFeatureList(dir);
      const { config } = loadConfig(dir);
      const phaseTask = nextActionableTask(list, config.currentPhase as string | null);
      const task = phaseTask ?? nextActionableTask(list);
      // Resolve sprint/goal via list, and active subtask of the focused task.
      const taskKey = task?.compositeKey ?? null;
      const featureId = task?.featureId ?? null;
      const feature = featureId ? (list.features ?? []).find((f) => f.id === featureId) ?? null : null;
      const sprintId = feature?.sprintId ?? null;
      const goalId = feature?.goalId ?? (sprintId ? (list.sprints ?? []).find((s) => s.id === sprintId)?.goalId ?? null : null) ?? (list.goals?.[0]?.id ?? null);
      const sprint = sprintId ? sprintId : null;
      const goal = goalId ? goalId : null;
      // First non-complete subtask of the active task.
      let subtask: string | null = null;
      const rawTask = feature && task ? feature.tasks.find((t) => t.id === task.id || t.key === task.key) ?? null : null;
      if (rawTask?.subtasks?.length) {
        const cur = rawTask.subtasks.find((s) => s.status !== "complete") ?? null;
        if (cur) subtask = `${taskKey}#${cur.id ?? cur.title}`;
      }
      return { task: taskKey, feature: featureId, sprint, goal, subtask };
    } catch {
      return { task: null, feature: null, sprint: null, goal: null, subtask: null };
    }
  };
  const activeTaskKey = (dir: string): string | null => activePlanKeys(dir).task;

  /** How full this session's context is, 0..1, or null when pi cannot say. */
  const contextRatio = (ctx: ExtensionContext): number | null => {
    try {
      const usage = ctx.getContextUsage?.();
      if (!usage || typeof usage.percent !== "number") return null;
      return usage.percent > 1 ? usage.percent / 100 : usage.percent;
    } catch {
      return null;
    }
  };

  /**
   * Continue the run in a fresh session, if the policy says to.
   *
   * Returns true when a handoff was started, in which case the caller must not
   * also send the brief — the replacement session will.
   *
   * `ctx.newSession` deadlocks if it is called from an event handler, so the
   * actual switch happens in the `/infinity:handoff` command. Queuing that
   * command as a follow-up user message is the documented way to reach a
   * command from a handler.
   */
  const maybeHandOff = async (
    ctx: ExtensionContext,
    dir: string,
    brief: string,
    fromPhase: Phase | null,
    toPhase: Phase | null,
    fromTask: string | null,
  ): Promise<boolean> => {
    // A handoff that was asked for and never happened would wedge the run:
    // this session stops driving and the replacement never arrives. One
    // attempt, then carry on here — a run that continues in a fat session is
    // far better than a run that stops.
    // A one-shot `pi -p` run has no next turn to hand anything to: replacing
    // its session mid-flight produces a stale-context error and nothing else.
    if (ctx.mode !== "tui" && ctx.mode !== "rpc") return false;

    if (handingOff) {
      if (hasPendingHandoff(dir)) {
        notify(ctx, "infinity-harness: the new session never started — continuing here.", "warning");
        clearHandoff(dir);
      }
      handingOff = false;
      return false;
    }
    try {
      const { config } = loadConfig(dir);
      const toKeys = activePlanKeys(dir);
      // Map caller's fromTask (a compositeKey) back to its feature/sprint etc for the "from" side.
      // We derive them from the plan so goal/sprint/feature boundaries are comparable.
      let fromGoal: string | null = null;
      let fromSprint: string | null = null;
      let fromFeature: string | null = null;
      try {
        const { list } = loadFeatureList(dir);
        if (fromTask) {
          const ft = ((): { featureId: string } | null => {
            for (const f of list.features ?? []) for (const t of f.tasks ?? []) if (t.key === fromTask || `${f.id}/${t.id}` === fromTask || t.id === fromTask) return { featureId: f.id };
            return null;
          })();
          if (ft) {
            fromFeature = ft.featureId;
            const feat = list.features.find((f) => f.id === ft.featureId) ?? null;
            fromSprint = feat?.sprintId ?? null;
            fromGoal = feat?.goalId ?? (fromSprint ? (list.sprints ?? []).find((s) => s.id === fromSprint)?.goalId ?? null : null) ?? null;
          }
        }
      } catch {}
      const decision = shouldHandoff({
        config,
        fromPhase,
        toPhase,
        fromTask,
        toTask: toKeys.task,
        fromGoal,
        toGoal: toKeys.goal,
        fromSprint,
        toSprint: toKeys.sprint,
        fromFeature,
        toFeature: toKeys.feature,
        fromSubtask: null, // subtask delta is derived from task payload; tracked via fromTask composite + activePlanKeys
        toSubtask: toKeys.subtask,
        contextRatio: contextRatio(ctx),
      });
      if (!decision.handoff) return false;

      requestHandoff(dir, {
        reason: decision.reason,
        detail: decision.detail,
        kickoff: composeKickoff(brief, decision.reason, decision.detail, carryNote(dir)),
        carry: carryNote(dir),
        runId: runFor(dir),
      });
      handingOff = true;
      // The replacement session announces itself on arrival; saying it twice
      // here would just make the log look like two handoffs happened.
      pi.sendUserMessage("/infinity:handoff", {
        deliverAs: "followUp",
        expandPromptTemplates: true,
      });
      return true;
    } catch (e) {
      // A handoff that cannot be arranged must never end the run. Fall back to
      // continuing in this session, which is exactly the old behaviour.
      notify(ctx, `infinity-harness: staying in this session — ${errMsg(e)}`, "warning");
      handingOff = false;
      clearHandoff(dir);
      return false;
    }
  };

  /** One line on where the run stands, carried into the next session. */
  const carryNote = (dir: string): string | null => {
    try {
      const { config } = loadConfig(dir);
      if (config.session?.carryNotes === false) return null;
      const { list } = loadFeatureList(dir);
      const p = computeProgress(list);
      const recent = (config.gateHistory ?? []).slice(-3).map((g) => `${g.phase}:${g.result}`);
      return (
        `  ${p.tasksDone}/${p.tasksTotal} tasks done, ${p.featuresDone}/${p.featuresTotal} features` +
        (recent.length ? `; recent gates ${recent.join(", ")}` : "")
      );
    } catch {
      return null;
    }
  };

  // -- approvals ------------------------------------------------------------

  /**
   * Collect the human's signature on a phase.
   *
   * With dialogs, ask straight away — the human is right there and the run is
   * stopped for them. Without dialogs there is nobody to ask, so the run parks
   * and says loudly what it is waiting for, because auto-approving a phase the
   * human explicitly asked to sign would make the setting a lie.
   */
  const askForApproval = async (ctx: ExtensionContext, dir: string, phase: Phase): Promise<void> => {
    if (!ctx.hasUI) {
      disarmRun(dir, `${phase} is waiting for approval`);
      notify(
        ctx,
        `infinity-harness: ${phase.toUpperCase()} needs your approval and this mode has no dialogs. ` +
          `Run \`/infinity:approve\` (optionally with what is wrong) to continue.`,
        "warning",
      );
      return;
    }

    const APPROVE = "approve — continue the run";
    const REJECT = "send it back — I will say what is wrong";
    const LATER = "not now — park the run";
    const choice = await ctx.ui.select(`${phase.toUpperCase()} is waiting for you`, [APPROVE, REJECT, LATER]);

    if (choice === REJECT) {
      const note = await ctx.ui.input("What needs to change?", "the criteria do not cover refunds");
      await applyApproval(ctx, dir, note ?? "");
      return;
    }
    if (choice === APPROVE) {
      await applyApproval(ctx, dir, "");
      return;
    }
    disarmRun(dir, `${phase} is waiting for approval`);
    notify(ctx, `infinity-harness: parked. \`/infinity:approve\` continues.`, "info");
    refreshWidget(ctx);
  };

  /** Record the verdict and get the run moving again. */
  const applyApproval = async (ctx: ExtensionContext, dir: string, note: string): Promise<void> => {
    // Pin a rejection to the project as it is right now, so the run knows
    // whether the agent has actually done anything about it before asking the
    // human the same question again.
    const outcome = resolveApproval(dir, note, note.trim() ? await fingerprint(dir) : "");
    if (!outcome.ok) {
      notify(ctx, `infinity-harness: ${outcome.error}`, "warning");
      return;
    }
    refreshWidget(ctx);

    if (outcome.approved) {
      notify(ctx, `infinity-harness: ${outcome.phase.toUpperCase()} approved.`, "info");
      // The gate already passed; re-settling lets the loop advance normally.
      const moved = await advancePhase(dir);
      refreshWidget(ctx);
      if (!moved.ok) {
        notify(ctx, `infinity-harness: could not advance — ${moved.error}`, "error");
        return;
      }
      const brief = await briefText(dir);
      lastBriefPhase = moved.to;
      if (loopArmed(dir) && (await maybeHandOff(ctx, dir, brief, outcome.phase, moved.to, null))) return;
      pi.sendUserMessage(brief, { deliverAs: "followUp" });
      return;
    }

    notify(
      ctx,
      `infinity-harness: ${outcome.phase.toUpperCase()} sent back — ${outcome.note}`,
      "warning",
    );
    pi.sendUserMessage(
      `A human reviewed ${outcome.phase.toUpperCase()} and sent it back:\n\n${outcome.note}\n\n` +
        `Address that, then validate again.\n\n${await briefText(dir)}`,
      { deliverAs: "followUp" },
    );
  };

  // -- lifecycle ------------------------------------------------------------

  pi.on("session_start", async (event, ctx) => {
    const dir = projectDir(ctx);
    if (!isHarnessProject(dir)) return;

    // A background worker loads this extension too — it needs the plan tools
    // and the phase guard. What it must not do is drive: no widget, no brief
    // injection, no loop, and above all no supervisor of its own, or one run
    // would fork into a tree of pi processes spawning pi processes.
    if (workerProcess) {
      try {
        pi.appendEntry("infinity:worker-session", {
          unit: process.env.INFINITY_HARNESS_UNIT ?? null,
          runId: process.env.INFINITY_HARNESS_RUN ?? null,
        });
      } catch {
        /* best effort */
      }
      return;
    }

    view = defaultView();
    refreshWidget(ctx);
    installTerminalShortcuts(ctx);
    const reason = (event as { reason?: string } | undefined)?.reason ?? "startup";
    const { config } = loadConfig(dir);
    lastBriefPhase = config.currentPhase;
    const engine = engineFor(dir);
    // Under the background engine this session is a control panel: its model
    // is the human's and stays the human's. Routing only ever applied to the
    // legacy engine, where the human's session *is* the worker.
    if (engine === "main-session") {
      try { await applyRouting(ctx, dir, `session_start:${reason}`); } catch {}
    }

    
    const run = reason === "startup" ? loadRunState(dir) : countSession(dir);
    const armed = run?.armed === true;

    notify(
      ctx,
      `infinity-harness active · ${config.currentPhase ?? "not started"}` +
        (armed ? ` · run continuing (session ${run?.sessions ?? 1})` : ""),
      "info",
    );
    try {
      pi.appendEntry("infinity:session", {
        sessionId,
        runId: runFor(dir),
        reason,
        dir,
        phase: config.currentPhase,
      });
    } catch {
      /* entry log is best-effort */
    }

    // A handoff written by the session this one replaces. It carries the brief
    // plus the reason the previous session ended, so the agent does not spend
    // its first turn working out why it woke up mid-run.
    // The background engine picks a run back up by restarting the supervisor:
    // the plan, the phase and every budget are on disk, so a pi that was
    // closed overnight resumes where it stopped rather than starting over.
    if (engine !== "main-session") {
      clearHandoff(dir);
      if (armed) {
        const ok = await startEngine(ctx, dir);
        if (ok) notify(ctx, "infinity-harness: continuing the run in background sessions.", "info");
      }
      // A short orientation note, not the brief. The brief is several
      // kilobytes and it is what makes a model start *working* the pipeline;
      // in a control panel it would be paid for on every turn the human takes
      // and would invite this session to do the work itself.
      try {
        pi.sendMessage(
          {
            customType: "infinity:brief",
            content: controlPanelNote(dir, armed),
            display: true,
            details: { phase: config.currentPhase, engine },
          },
          { triggerTurn: false },
        );
      } catch (e) {
        notify(ctx, `infinity-harness: ${errMsg(e)}`, "warning");
      }
      refreshWidget(ctx);
      return;
    }

    const pending = takeHandoff(dir);
    if (pending && pending.runId === runFor(dir)) {
      try {
        pi.sendUserMessage(pending.kickoff, { deliverAs: "followUp" });
        notify(ctx, `infinity-harness: ${describeHandoff(pending)}`, "info");
      } catch (e) {
        notify(ctx, `infinity-harness: handoff failed — ${errMsg(e)}`, "error");
      }
      return;
    }

    // The brief is delivered as a message rather than a notification so the
    // model actually reads it. Without this the agent starts from whatever
    // the user typed and ignores the pipeline entirely.
    //
    // `nextTurn` is right in a terminal, where a human is about to type. It is
    // a deadlock in `pi -p`, which has no next turn and waits forever for one:
    // the harness made every headless run hang on startup. Non-interactive
    // modes get `steer`, which folds the brief into the turn already starting.
    try {
      const text = await briefText(dir);
      const interactive = ctx.mode === "tui" || ctx.mode === "rpc";
      pi.sendMessage(
        { customType: "infinity:brief", content: text, display: true, details: { phase: config.currentPhase } },
        { triggerTurn: false, deliverAs: interactive ? "nextTurn" : "steer" },
      );
    } catch (e) {
      notify(ctx, `infinity-harness: could not build brief — ${errMsg(e)}`, "warning");
    }
  });

  /**
   * The harness contract, in the system prompt.
   *
   * Everything else the harness tells the model is a message in the
   * transcript, and every message in the transcript is something compaction
   * can summarise into "the assistant was working on a harness". That is how a
   * long run loses the plot: not by forgetting the plan — the plan is on disk
   * — but by forgetting that it is *supposed to* work from the plan, stop when
   * a gate fails, and never mark its own work complete.
   *
   * The system prompt is rebuilt from scratch every turn and is never
   * summarised. Anything the run cannot afford to forget belongs here.
   */
  pi.on("before_agent_start", async (event, ctx) => {
    if (!sessionLive) return;
    const dir = projectDir(ctx);
    if (!isHarnessProject(dir)) return;
    // Live-model routing rewrites *this* session's model, which is only ever
    // right when this session is the worker. Under the background engine the
    // human's model is theirs, and the routed model belongs to the child.
    if (engineFor(dir) === "main-session") {
      try { await applyRouting(ctx, dir, "before_agent_start"); } catch {}
    }
    try {
      const contract =
        engineFor(dir) === "main-session" ? harnessContract(dir) : controlPanelContract(dir);
      if (!contract) return;
      const base = (event as { systemPrompt?: string }).systemPrompt ?? ctx.getSystemPrompt();
      const routed = await routingSummaryForBrief(dir);
      const suffix = routed ? `\n\n${routed}` : "";
      return { systemPrompt: `${base}${suffix}\n\n${contract}` };
    } catch {
      return;
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    if (!sessionLive || workerProcess) return;
    refreshWidget(ctx);
  });

  /**
   * Periodic nudge. Long runs drift: the model finishes work and forgets to
   * record it, so the plan on disk and reality diverge. A short reminder every
   * few calls costs little and keeps the plan honest.
   */
  pi.on("context", async (event, ctx) => {
    if (!sessionLive || workerProcess) return;
    const dir = projectDir(ctx);
    if (!isHarnessProject(dir)) return;

    const messages = event.messages ?? [];
    // Drop any reminder we injected on a previous call; they are transient
    // scaffolding, not conversation, and accumulate into real token cost.
    const filtered = messages.filter((m) => !isOurReminder(m));
    const pruned = filtered.length !== messages.length ? { messages: filtered } : undefined;

    let list: FeatureList;
    try {
      list = loadFeatureList(dir).list;
    } catch {
      return pruned;
    }

    const progress = computeProgress(list);
    if (progress.tasksTotal === 0 || progress.tasksDone === progress.tasksTotal) {
      llmCalls = 0;
      return pruned;
    }

    llmCalls += 1;
    if (llmCalls < REMINDER_INTERVAL) return pruned;
    llmCalls = 0;

    const open = (list.features ?? [])
      .flatMap((f) => f.tasks ?? [])
      .filter((t) => t.status !== "complete")
      .slice(0, 12)
      .map((t) => `${t.key ?? t.id}=${t.status}`)
      .join(", ");

    const reminder = {
      role: "user",
      content: [
        {
          type: "text",
          text:
            `[infinity-harness] Plan revision ${list.baseRevision}. Open: ${open}. ` +
            `If the real state differs from this, call infinity_plan with baseRevision ${list.baseRevision} ` +
            `and the complete task list (omitted keys are deleted).`,
        },
      ],
      timestamp: Date.now(),
    } as (typeof messages)[number];

    return { messages: [...filtered, reminder] };
  });

  /**
   * Compaction drops the transcript.
   *
   * The plan survives — it is on disk — and since 2.3 so do the rules, because
   * they live in the system prompt (`before_agent_start`) where no summariser
   * can reach them. What is left to restore is the *current* brief, so the
   * agent picks up on the same task rather than re-deriving one from a summary
   * of a summary.
   */
  pi.on("session_before_compact", async (_event, ctx) => {
    const dir = projectDir(ctx);
    if (!isHarnessProject(dir)) return;
    try {
      const { list } = loadFeatureList(dir);
      const { config } = loadConfig(dir);
      pi.appendEntry(CHECKPOINT, {
        revision: list.baseRevision,
        phase: config.currentPhase,
        runId: runFor(dir),
        at: new Date().toISOString(),
      });
    } catch {
      /* checkpoint is advisory */
    }
  });

  pi.on("session_compact", async (event, ctx) => {
    if (!sessionLive) return;
    // A worker that compacts re-reads the brief from its own prompt; the
    // control-panel re-brief would put a second brief in front of it.
    if (workerProcess) return;
    const dir = projectDir(ctx);
    if (!isHarnessProject(dir)) return;
    try {
      const text = await briefText(dir);

      // Delivery mode is the whole bug here. `nextTurn` waits for a human to
      // type, which never happens in an unattended run — so the re-brief that
      // was supposed to rescue the agent after compaction sat in a queue while
      // the agent carried on without it. Overflow compaction retries the
      // aborted turn immediately, so the brief has to land *in* that turn.
      const willRetry = (event as { willRetry?: boolean } | undefined)?.willRetry === true;
      const running = willRetry || !ctx.isIdle?.();
      pi.sendMessage(
        {
          customType: "infinity:brief",
          content: text,
          display: false,
          details: { after: "compaction", reason: (event as { reason?: string })?.reason ?? null },
        },
        { triggerTurn: false, deliverAs: running ? "steer" : "nextTurn" },
      );
      refreshWidget(ctx);
    } catch {
      /* the next brief will catch it up */
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!sessionLive || workerProcess) return;
    refreshWidget(ctx);
  });

  /**
   * The loop. `agent_settled` fires when the agent has stopped working, which
   * is the only safe moment to run the gate and decide what happens next.
   *
   * The run's armed flag is read from disk on every tick rather than held in a
   * closure, so a run survives the session handoffs it now performs, plus
   * `/reload`, `/resume`, and pi being restarted.
   */
  pi.on("agent_settled", async (_event, ctx) => {
    if (!sessionLive || workerProcess) return;
    const dir = projectDir(ctx);
    if (!isHarnessProject(dir)) return;
    if (loopBusy || handingOff) return;
    if (!loopArmed(dir)) return;
    // The background engine drives the run from the supervisor, in this
    // process, with no LLM turn in this session at all. Driving it from here
    // too is what made the human's model pay for the whole run.
    if (engineFor(dir) !== "main-session") return;

    loopBusy = true;
    try {
      const before = loadConfig(dir).config;
      const beforeTask = activeTaskKey(dir);
      const { decision } = await decideNext({ targetDir: dir, runId: runFor(dir) });
      refreshWidget(ctx);

      switch (decision.action) {
        case "advanced": {
          notify(ctx, `infinity-harness: gate passed → ${decision.toPhase}`, "info");
          lastBriefPhase = decision.toPhase;
          if (await maybeHandOff(ctx, dir, decision.message, before.currentPhase, decision.toPhase, beforeTask)) {
            break;
          }
          pi.sendUserMessage(decision.message, { deliverAs: "followUp" });
          break;
        }
        case "continue": {
          // Say *why* it is going round again. "gate failed" was printed even
          // when the gate had passed and the run was waiting on a rejection
          // the agent had not acted on, which reads as a different bug.
          notify(ctx, `infinity-harness: ${decision.reason} — re-briefing`, "warning");
          // A failed gate on the same phase is normally the same session's
          // problem to fix. The exception is context pressure: carrying on in
          // a session that is about to compact is how a run degrades into
          // summaries of summaries.
          if (await maybeHandOff(ctx, dir, decision.message, before.currentPhase, before.currentPhase, beforeTask)) {
            break;
          }
          pi.sendUserMessage(decision.message, { deliverAs: "followUp" });
          break;
        }
        case "approve": {
          // Not a stop. The run is parked on a human, and the widget, the
          // status line and the notification all say so.
          notify(ctx, `infinity-harness: ${decision.detail}`, "warning");
          pi.sendUserMessage(decision.message, { deliverAs: "followUp" });
          await askForApproval(ctx, dir, decision.phase);
          break;
        }
        case "wait":
          disarmRun(dir, decision.detail);
          notify(ctx, `infinity-harness: ${decision.detail}`, "warning");
          break;
        case "stop":
          disarmRun(dir, decision.detail);
          notify(
            ctx,
            `infinity-harness: run finished — ${decision.detail}`,
            decision.reason === "complete" ? "info" : "warning",
          );
          try {
            pi.appendEntry("infinity:run-end", { reason: decision.reason, detail: decision.detail });
          } catch {
            /* best-effort */
          }
          break;
      }
      refreshWidget(ctx);
    } catch (e) {
      disarmRun(dir, `loop error: ${errMsg(e)}`);
      notify(ctx, `infinity-harness: loop error, stopping — ${errMsg(e)}`, "error");
    } finally {
      loopBusy = false;
    }
  });

  /**
   * The enforcement bit: refuse edits that would skip a phase.
   *
   * We only block writes that actually change `currentPhase`. Blocking every
   * touch of the config would stop the harness configuring itself.
   */
  pi.on("tool_call", async (event, ctx) => {
    if (!sessionLive) return;
    const dir = projectDir(ctx);
    if (!isHarnessProject(dir)) return;

    const e = event as { toolName?: string; name?: string; input?: Record<string, unknown> };
    const tool = String(e.toolName ?? e.name ?? "");
    const input = e.input ?? {};

    const path = String(input.path ?? input.file ?? input.filePath ?? "");
    const content = String(input.content ?? input.data ?? input.new_string ?? "");
    const command = String(input.command ?? input.cmd ?? "");

    const editsPhase =
      path.replace(/\\/g, "/").includes("harness/config.json") &&
      /write|edit|replace|patch/i.test(tool) &&
      /"currentPhase"/.test(content);

    const shellAdvance =
      /harness/.test(command) && /\bphase\b/.test(command) && /\bnext\b|\badvance\b/.test(command);

    if (!editsPhase && !shellAdvance) return;

    const { config } = loadConfig(dir);
    if (!config.currentPhase) return;

    const gate = await runChecks(dir, config.currentPhase, { record: false });
    if (gate.overall) return;

    const failing = gate.checks
      .filter((c) => !c.pass)
      .map((c) => `${c.name} (${c.detail})`)
      .join("; ");

    return {
      block: true,
      reason:
        `infinity-harness: the ${config.currentPhase.toUpperCase()} gate has not passed, so the phase ` +
        `cannot advance. Failing: ${failing}. Fix these, then let the harness advance the phase — ` +
        `do not edit harness/config.json by hand.`,
    };
  });

  pi.on("session_shutdown", async () => {
    sessionLive = false;
    // A pi that closes must not leave a worker running against the project.
    await stopEngine("this pi session closed");
    if (remoteServer) {
      try {
        await remoteServer.close();
      } catch {
        /* closing a dead server is fine */
      }
      remoteServer = null;
      remoteDir = null;
    }
    loopBusy = false;
  });

  // -- tools ----------------------------------------------------------------

  pi.registerTool({
    name: "infinity_plan",
    label: "Plan",
    description:
      "Read or rewrite the harness plan. Submit the COMPLETE task list — any key you omit is deleted. " +
      "Pass baseRevision (from the brief or a previous call) so a concurrent write cannot be clobbered; " +
      "a stale revision is rejected and you should re-read and resubmit. Omit `tasks` to read the plan.",
    parameters: {
      type: "object",
      properties: {
        baseRevision: {
          type: "integer",
          minimum: 0,
          description: "Revision you read. Rejected if the plan has moved on.",
        },
        tasks: {
          type: "array",
          maxItems: 200,
          description: "Complete authoritative task list. Omit to read without writing.",
          items: {
            type: "object",
            required: ["key"],
            properties: {
              key: { type: "string", description: 'Stable key, e.g. "task-004" or "feature-002/task-004"' },
              subject: { type: "string", description: "What the task is" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "complete", "blocked", "rework"],
              },
              dependsOn: { type: "array", items: { type: "string" }, maxItems: 20 },
              subtasks: {
                type: "array",
                items: {
                  type: "object",
                  required: ["title"],
                  properties: {
                    title: { type: "string" },
                    status: { type: "string", enum: ["pending", "in_progress", "complete"] },
                  },
                },
              },
              difficulty: { type: "string", enum: ["easy", "moderate", "difficult"] },
              modelHint: { type: "string" },
              criteria: { type: "array", items: { type: "string" } },
            },
          },
        },
        features: {
          type: "array",
          maxItems: 100,
          description:
            "Feature names and acceptance criteria, merged by id. Unlike tasks, omitting a feature " +
            "here leaves it alone rather than deleting it. The DEFINE gate requires criteria on " +
            "every feature, so this is how DEFINE is passed.",
          items: {
            type: "object",
            required: ["id"],
            properties: {
              id: { type: "string", description: 'Feature id, e.g. "feature-001"' },
              name: { type: "string", description: "What the feature is, in a few words" },
              description: { type: "string" },
              criteria: {
                type: "array",
                items: { type: "string" },
                description: "How you will know this feature is done. Observable, not aspirational.",
              },
            },
          },
        },
        goal: {
          type: "string",
          description: "One line: what this whole run is for. Shown at the top of every brief.",
        },
      },
    } as never,
    async execute(
      _id: string,
      params: {
        baseRevision?: number;
        tasks?: TaskInput[];
        features?: { id: string; name?: string; description?: string; criteria?: string[] }[];
        goal?: string;
      },
      _signal,
      _onUpdate,
      ctx,
    ) {
      const dir = projectDir(ctx);

      // A submission with no tasks, no features and no goal is a read.
      const writing =
        Array.isArray(params?.tasks) || Array.isArray(params?.features) || typeof params?.goal === "string";
      if (!writing) {
        const { list } = loadFeatureList(dir);
        const p = computeProgress(list);
        // Features and their criteria are printed, not just tasks: the DEFINE
        // gate judges criteria, so a plan view that hides them shows the model
        // everything except the thing it is being marked on.
        const rows = (list.features ?? [])
          .flatMap((f) => [
            `${f.id} · ${f.name}${f.criteria?.length ? "" : "  ← no acceptance criteria"}`,
            ...(f.criteria ?? []).map((c) => `    ✓ ${c}`),
            ...(f.tasks ?? []).map((t) => `    [${t.status}] ${t.key ?? t.id}: ${t.description}`),
          ])
          .join("\n");
        const goal = (list.goals ?? [])[0]?.title;
        return {
          content: [
            {
              type: "text",
              text:
                `Plan revision ${list.baseRevision} — ${p.tasksDone}/${p.tasksTotal} tasks` +
                `${goal ? `\nGoal: ${goal}` : ""}\n${rows || "(empty)"}`,
            },
          ],
          details: { revision: list.baseRevision, progress: p },
        };
      }

      try {
        // writeTaskList takes the plan lock itself, around the whole
        // read-apply-write. Wrapping it again here would only add a second
        // lock with weaker semantics.
        const result = writeTaskList(dir, {
          baseRevision: params.baseRevision,
          tasks: params.tasks,
          features: params.features,
          goal: params.goal,
        });
        refreshWidget(ctx as ExtensionContext);
        return {
          content: [{ type: "text", text: summarizeApply(result) }],
          details: {
            revision: result.revision,
            change: result.change,
            tasks: result.tasks.map((t) => ({
              key: t.compositeKey,
              status: t.status,
              description: t.description,
            })),
          },
        };
      } catch (e) {
        const isValidation = e instanceof ValidationError || (e as Error)?.name === "ValidationError";
        const { list } = loadFeatureList(dir);
        return {
          content: [
            {
              type: "text",
              text: `${isValidation ? "Rejected" : "Error"}: ${errMsg(e)}\nCurrent revision is ${list.baseRevision}.`,
            },
          ],
          details: { error: errMsg(e), revision: list.baseRevision },
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "infinity_validate",
    label: "Validate",
    description:
      "Run the deterministic gate for the current phase and report each check. This is the only way work is " +
      "judged complete — do not assert completion yourself. Optionally scope to one feature+task.",
    parameters: {
      type: "object",
      properties: {
        feature: { type: "string", description: "Scope to this feature id" },
        task: { type: "string", description: "Scope to this task id (requires feature)" },
      },
    } as never,
    async execute(_id: string, params: { feature?: string; task?: string }, _signal, _onUpdate, ctx) {
      const dir = projectDir(ctx);
      const { config } = loadConfig(dir);
      if (!config.currentPhase) {
        return {
          content: [{ type: "text", text: "No current phase — the harness is not initialised." }],
          details: { error: "no-phase" },
          isError: true,
        };
      }
      const gate = await runChecks(dir, config.currentPhase, {
        feature: params?.feature,
        task: params?.task,
        record: true,
      });
      refreshWidget(ctx as ExtensionContext);
      const lines = gate.checks
        .map((c) => `${c.advisory ? "·" : c.pass ? "+" : "x"} ${c.name}: ${c.detail}`)
        .join("\n");
      // Autopilot means auto-pilot: when the gate passes and the current
      // phase's phaseMode is autopilot, advance immediately (any phase). The
      // old allowlist stalled real autopilot builds after RESEARCH → DEFINE.
      // Copilot still parks via needsApproval check below.
      if (gate.overall && !params?.feature && !params?.task) {
        try {
          const { needsApproval } = await import("../../src/approval.ts");
          const fresh = loadConfig(dir).config;
          if (!needsApproval(fresh, fresh.currentPhase)) {
            const { advancePhase, ensurePhaseSeeded } = await import("../../src/core/phases.ts");
            const moved = await advancePhase(dir);
            if (moved.ok && moved.to) {
              try { ensurePhaseSeeded(dir, moved.to); } catch {}
              refreshWidget(ctx as ExtensionContext);
              const brief = await briefText(dir);
              return {
                content: [
                  {
                    type: "text",
                    text: `Gate PASS on ${gate.phase} → advanced ${moved.from} → ${moved.to}\n${lines}\n\n${brief}`,
                  },
                ],
                details: { ...gate, advanced: moved } as unknown as typeof gate,
              };
            }
          }
        } catch {}
      }
      return {
        content: [
          {
            type: "text",
            text: `Gate ${gate.overall ? "PASS" : "FAIL"} on ${gate.phase}\n${lines}`,
          },
        ],
        details: gate,
      };
    },
  });

  pi.registerTool({
    name: "infinity_advance",
    label: "Advance Phase",
    description:
      "Advance one phase. Refuses unless the current gate passes. Normally the harness does this for you " +
      "after a passing validate; call it only when you need to advance explicitly.",
    parameters: { type: "object", properties: {} } as never,
    async execute(_id: string, _params: unknown, _signal, _onUpdate, ctx) {
      const dir = projectDir(ctx);
      const { config } = loadConfig(dir);
      if (!config.currentPhase) {
        return {
          content: [{ type: "text", text: "No current phase." }],
          details: { error: "no-phase" },
          isError: true,
        };
      }
      const gate = await runChecks(dir, config.currentPhase, { record: true });
      if (!gate.overall) {
        return {
          content: [
            {
              type: "text",
              text:
                `Blocked: the ${config.currentPhase} gate failed — ${gate.failures.join(", ")}. ` +
                `Fix these and validate again.`,
            },
          ],
          details: gate,
          isError: true,
        };
      }
      const moved = await advancePhase(dir);
      refreshWidget(ctx as ExtensionContext);
      if (!moved.ok) {
        return {
          content: [{ type: "text", text: `Could not advance: ${moved.error}` }],
          details: { error: moved.error },
          isError: true,
        };
      }
      const text = await briefText(dir);
      return {
        content: [{ type: "text", text: `Advanced ${moved.from} → ${moved.to}\n\n${text}` }],
        details: { from: moved.from, to: moved.to },
      };
    },
  });

  pi.registerTool({
    name: "infinity_brief",
    label: "Next Step",
    description:
      "Get the current brief: phase, role, feature, task, acceptance criteria and the gate verdict. " +
      "Call this when you are unsure what to work on.",
    parameters: {
      type: "object",
      properties: {
        includeGate: { type: "boolean", description: "Run the gate to include a live verdict (slower)" },
      },
    } as never,
    async execute(_id: string, params: { includeGate?: boolean }, _signal, _onUpdate, ctx) {
      const dir = projectDir(ctx);
      const text = await briefText(dir, Boolean(params?.includeGate));
      const brief = await buildBrief(dir);
      return { content: [{ type: "text", text }], details: brief };
    },
  });

  pi.registerTool({
    name: "infinity_dashboard",
    label: "Dashboard",
    description:
      "Start, stop, or query the read-only web dashboard for this run. It binds to localhost and never " +
      "mutates harness state — it is for the human watching the run.",
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["start", "stop", "status"] },
        port: { type: "integer", minimum: 0, maximum: 65535, description: "0 picks a free port" },
        host: { type: "string", description: "Bind address, default 127.0.0.1" },
      },
    } as never,
    async execute(_id: string, params: { action: string; port?: number; host?: string }, _signal, _onUpdate, ctx) {
      const dir = projectDir(ctx);
      const remote = await import("../../src/remote.ts");

      if (params.action === "stop") {
        if (!remoteServer) {
          return { content: [{ type: "text", text: "Dashboard is not running." }], details: { running: false } };
        }
        const was = remoteServer.url;
        await remoteServer.close();
        remoteServer = null;
        remoteDir = null;
        return { content: [{ type: "text", text: `Dashboard stopped (${was}).` }], details: { running: false } };
      }

      if (params.action === "status") {
        const state = remote.buildRemoteState(dir);
        return {
          content: [
            {
              type: "text",
              text: remoteServer
                ? `Dashboard live at ${remoteServer.url} · plan revision ${state.baseRevision}`
                : `Dashboard not running · plan revision ${state.baseRevision}`,
            },
          ],
          details: { running: Boolean(remoteServer), url: remoteServer?.url ?? null, baseRevision: state.baseRevision },
        };
      }

      if (remoteServer && remoteDir === dir) {
        return {
          content: [{ type: "text", text: `Dashboard already live at ${remoteServer.url}` }],
          details: { running: true, url: remoteServer.url },
        };
      }
      if (remoteServer) {
        await remoteServer.close();
        remoteServer = null;
      }
      const srv = await remote.createRemoteServer({
        projectDir: dir,
        host: params.host ?? "127.0.0.1",
        port: typeof params.port === "number" ? params.port : 0,
      });
      remoteServer = srv;
      remoteDir = dir;
      notify(ctx, `infinity-harness dashboard: ${srv.url}`, "info");
      return {
        content: [{ type: "text", text: `Dashboard live at ${srv.url}` }],
        details: { running: true, url: srv.url, port: srv.port },
      };
    },
  });

  // -- init -----------------------------------------------------------------

  /**
   * Said wherever a command finds no harness.
   *
   * It used to be "No harness in this project." and nothing else — a dead end
   * with no exit, in a tool whose every other command needs a harness to work.
   * A warning that does not say what to do instead is only half a warning.
   */
  const NO_HARNESS = "No harness in this project yet. Run /infinity:init to create one.";

  /** The escalation ladder, in the order it climbs. */
  const DEFAULT_LADDER = ["retry", "reframe", "consult", "rework", "replan", "master"];

  /** Everything the pipeline can run. INIT is not a phase you choose. */
  // Everything except INIT, which is not a phase anyone chooses. RESEARCH is
  // here because it is a real, optional phase — omitting it from the picker
  // was the difference between a feature and a feature nobody can find.
  const SELECTABLE_PHASES: Phase[] = [
    "research",
    "define",
    "plan",
    "build",
    "verify",
    "simplify",
    "review",
    "ship",
  ];

  pi.registerTool({
    name: "infinity_init",
    label: "Init",
    description:
      "Create a harness in this project: config, an empty plan, the phase and role docs, and starters " +
      "for the documents the review gate demands. Detects the stack and its lint/test/build commands. " +
      "Refuses if a harness already exists unless force is set, and never overwrites an existing file.",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["copilot", "autopilot"], description: "copilot keeps the human in the loop" },
        stack: { type: "string", enum: ["node", "python", "rust", "go", "unknown"] },
        phases: {
          type: "array",
          items: { type: "string", enum: ["define", "plan", "build", "verify", "simplify", "review", "ship"] },
          description: "Which phases run. Omit for the default pipeline.",
        },
        force: { type: "boolean", description: "Restore missing files in a project that already has a harness" },
      },
    } as never,
    async execute(
      _id: string,
      params: { mode?: "copilot" | "autopilot"; stack?: StackId; phases?: Phase[]; force?: boolean },
      _signal,
      _onUpdate,
      ctx,
    ) {
      const dir = projectDir(ctx);
      const result = initHarness(dir, {
        mode: params?.mode,
        stack: params?.stack,
        phases: params?.phases,
        force: params?.force,
      });
      if (!result.ok) {
        return {
          content: [{ type: "text", text: result.error ?? "init failed" }],
          details: result,
          isError: true,
        };
      }
      refreshWidget(ctx as ExtensionContext);
      return { content: [{ type: "text", text: describeInit(result) }], details: result };
    },
  });

  pi.registerCommand("infinity:init", {
    description: "Set up a harness here — workflow, goal, sessions, display",
    handler: async (args: string, ctx: ExtensionContext) => {
      const dir = projectDir(ctx);
      const force = /\bforce\b/.test(args);
      const goalFromArgs = args.replace(/\bforce\b/g, "").trim();

      if (isHarnessProject(dir) && !force) {
        notify(
          ctx,
          "This project already has a harness. /infinity:config changes it; /infinity:init force restores missing files.",
          "warning",
        );
        return;
      }

      const detected = detectStack(dir);

      // Three things used to be wrong here, and they compounded.
      //
      // The wizard never asked what was being built — so picking "autopilot"
      // started a run with no idea and no scope, and the harness invented a
      // project and began building it.
      //
      // "mode" was the only question, and one switch cannot say "drive
      // yourself, but show me the plan before you build it".
      //
      // And even that switch only reached three phases. It is a mode per
      // phase now, chosen from a workflow the human can build, name and reuse.
      // `src/workflow.ts` owns what a workflow is, `src/intake.ts` what the
      // answers mean, `src/ui/wizard.ts` how they are asked.
      if (ctx.hasUI) {
        const cmds = Object.entries(detected.commands).filter(([, v]) => Boolean(v));
        const summary = cmds.length ? cmds.map(([k, v]) => `${k}: ${v}`).join(", ") : "no commands detected";
        const go = await ctx.ui.select(`Create a harness here? ${detected.label} · ${summary}`, [
          "yes",
          "cancel",
        ]);
        if (go === undefined || go === "cancel") {
          notify(ctx, "init cancelled — nothing was written.", "info");
          return;
        }
      }

      const wizard = ctx.hasUI
        ? await runIntakeWizard({ prompt: prompterFor(ctx), brief: goalFromArgs || null, models: () => availableModels(ctx) })
        : ({ cancelled: false, plan: unattendedIntake(goalFromArgs || null) } as const);

      if (wizard.cancelled) {
        notify(ctx, "init cancelled — nothing was written.", "info");
        return;
      }
      const plan = wizard.plan;

      const result = initHarness(dir, {
        mode: plan.mode,
        phases: plan.phases,
        approvals: plan.approvals,
        phaseModes: plan.phaseModes,
        workflow: plan.workflow,
        display: plan.display,
        session: plan.session,
        execution: { parallelAt: (plan as { execution?: { parallelAt?: import("../../src/core/types.ts").HandoffGranularity } }).execution?.parallelAt ?? "task", maxWorkers: (plan as { execution?: { maxWorkers?: number } }).execution?.maxWorkers ?? 3 },
        brief: plan.brief,
        router: plan.router
          ? ({
              enabled: !!plan.router.enabled,
              byDifficulty: plan.router.byDifficulty as unknown as Record<string, string>,
              thinkingByDifficulty: plan.router.thinkingByDifficulty as unknown as Record<string, string>,
              master: plan.router.master ?? "",
              thinkingMaster: plan.router.thinkingMaster as unknown as string,
              default: plan.router.default ?? "",
              thinkingDefault: plan.router.thinkingDefault as unknown as string,
            } as Partial<import("../../src/modelRouter.ts").RouterConfig>)
          : undefined,
        force,
      });
      if (!result.ok) {
        notify(ctx, result.error ?? "init failed", "error");
        return;
      }

      // The wizard already showed the summary before the human confirmed it;
      // repeating it verbatim here is noise. Warnings do repeat — they are the
      // part worth seeing twice.
      const lines = [describeInit(result)];
      if (plan.warnings.length) lines.push("", ...plan.warnings.map((w) => `! ${w}`));
      notify(ctx, lines.join("\n"), plan.warnings.length ? "warning" : "info");
      refreshWidget(ctx);

      // Hand the model the brief straight away, so the session that created
      // the harness is also the session that starts using it. Without a goal
      // the first thing it must do is ask for one — never guess one.
      const brief = await briefText(dir);
      const opener = plan.brief
        ? brief
        : `The human has not said what they want built yet. Ask them, in one short question, ` +
          `and do not start any work or invent a scope until they answer.\n\n${brief}`;
      pi.sendUserMessage(opener, { deliverAs: "followUp" });
    },
  });

  /**
   * Change the workflow mid-run.
   *
   * Any of this is editable at any time and takes effect on the next gate —
   * a run three phases deep is exactly when someone realises they do want to
   * see the review after all.
   */
  pi.registerCommand("infinity:workflow", {
    description: "Choose or build the workflow — which phases run, and which stop for you",
    handler: async (args: string, ctx: ExtensionContext) => {
      const dir = projectDir(ctx);
      if (!isHarnessProject(dir)) {
        notify(ctx, NO_HARNESS, "warning");
        return;
      }

      const { config } = loadConfig(dir);
      const arg = args.trim();

      if (arg === "" && !ctx.hasUI) {
        notify(ctx, describeCurrentWorkflow(dir), "info");
        return;
      }
      if (arg === "show" || arg === "list") {
        const rows = listWorkflows().map((w) => `  ${w.builtIn ? " " : "*"} ${w.name} — ${w.description}`);
        notify(
          ctx,
          `${describeCurrentWorkflow(dir)}\n\nAvailable (* = yours):\n${rows.join("\n")}`,
          "info",
        );
        return;
      }

      // `/infinity:workflow <name>` switches without a menu, which is what a
      // second run in the same terminal wants.
      let chosen = arg ? findWorkflow(arg) : undefined;
      if (arg && !chosen) {
        notify(ctx, `No workflow called "${arg}". \`/infinity:workflow list\` shows them.`, "warning");
        return;
      }
      if (!chosen) {
        if (!ctx.hasUI) {
          notify(ctx, "This mode has no dialogs — `/infinity:workflow <name>` switches directly.", "warning");
          return;
        }
        chosen = (await pickWorkflow(prompterFor(ctx))) ?? undefined;
        if (!chosen) {
          notify(ctx, "Unchanged.", "info");
          return;
        }
      }

      const { value } = await withLock(configPath(dir), () => {
        const fresh = loadConfig(dir);
        if (!fresh.ok) return false;
        applyWorkflow(fresh.config, chosen!);
        // Keep the legacy field in step so a 2.3 tool reading this config
        // still sees the same three answers it understands.
        fresh.config.approvals = {
          research: fresh.config.phaseModes?.research === "copilot",
          define: fresh.config.phaseModes?.define === "copilot",
          plan: fresh.config.phaseModes?.plan === "copilot",
        };
        fresh.config.mode = signedPhases(fresh.config).length > 0 ? "copilot" : "autopilot";
        return saveConfig(dir, fresh.config).ok;
      });

      if (!value) {
        notify(ctx, "Could not save the workflow — config unreadable.", "error");
        return;
      }
      notify(ctx, `${renderWorkflow(chosen)}\n\nIt takes effect at the next gate.`, "info");
      refreshWidget(ctx);
      void config;
    },
  });

  pi.registerCommand("infinity:display", {
    description: "Choose what the widget and the dashboard show, level by level",
    handler: async (args: string, ctx: ExtensionContext) => {
      const dir = projectDir(ctx);
      if (!isHarnessProject(dir)) {
        notify(ctx, NO_HARNESS, "warning");
        return;
      }
      const arg = args.trim();
      const current = normalizeDisplay(loadConfig(dir).config.display);

      if (arg === "show" || arg === "list") {
        const rows = listDisplays().map((d) => `  ${d.builtIn ? " " : "*"} ${d.name} — ${d.description}`);
        notify(
          ctx,
          `Now: ${summarizeDisplay(current)}\n\nTemplates (* = yours):\n${rows.join("\n")}`,
          "info",
        );
        return;
      }

      let next: DisplayPolicy | undefined;
      if (arg) {
        const template = findDisplay(arg);
        if (!template) {
          notify(ctx, `No template called "${arg}". \`/infinity:display list\` shows them.`, "warning");
          return;
        }
        next = template.policy;
      } else {
        if (!ctx.hasUI) {
          notify(ctx, `Now: ${summarizeDisplay(current)}. \`/infinity:display <template>\` switches.`, "info");
          return;
        }
        next = await pickDisplay(prompterFor(ctx));
        if (!next) {
          notify(ctx, "Unchanged.", "info");
          return;
        }
      }

      const { value } = await withLock(configPath(dir), () => {
        const fresh = loadConfig(dir);
        if (!fresh.ok) return false;
        fresh.config.display = normalizeDisplay(next);
        return saveConfig(dir, fresh.config).ok;
      });

      if (!value) {
        notify(ctx, "Could not save the display settings — config unreadable.", "error");
        return;
      }
      // The widget is the answer to "did that do what I wanted", so redraw it
      // before saying anything about it.
      view = defaultView();
      refreshWidget(ctx);
      notify(ctx, `Showing: ${summarizeDisplay(normalizeDisplay(next))}`, "info");
    },
  });

  /**
   * Continue the run in a replacement session.
   *
   * This is a command rather than something the loop does directly because
   * `ctx.newSession` is only safe from a command handler — pi deadlocks if an
   * event handler calls it. The loop queues `/infinity:handoff` as a follow-up
   * and this does the switch.
   *
   * Everything the next session needs is already on disk. `withSession` may
   * only touch the context it is handed: the old `pi` and `ctx` are dead by
   * the time it runs.
   */
  pi.registerCommand("infinity:handoff", {
    description: "Continue this run in a fresh session, carrying the brief",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const dir = projectDir(ctx);
      if (!isHarnessProject(dir)) {
        notify(ctx, NO_HARNESS, "warning");
        return;
      }

      // Asked for by hand, with no handoff queued: make one.
      if (!hasPendingHandoff(dir)) {
        const brief = await briefText(dir);
        requestHandoff(dir, {
          reason: "manual",
          detail: args.trim() || "requested by hand",
          kickoff: composeKickoff(brief, "manual", args.trim() || "requested by hand", carryNote(dir)),
          carry: carryNote(dir),
          runId: runFor(dir),
        });
      }

      const pending = takeHandoff(dir);
      if (!pending) {
        notify(ctx, "infinity-harness: nothing to hand off.", "warning");
        return;
      }

      // The replacement session reads this back from disk in `session_start`;
      // put it back so the claim above does not consume it.
      requestHandoff(dir, {
        reason: pending.reason,
        detail: pending.detail,
        kickoff: pending.kickoff,
        carry: pending.carry,
        runId: pending.runId,
      });

      handingOff = false;
      try {
        await ctx.waitForIdle?.();
        const parent = ctx.sessionManager?.getSessionFile?.() ?? undefined;
        const result = await ctx.newSession({ parentSession: parent ?? undefined });
        if (result?.cancelled) {
          clearHandoff(dir);
          notify(ctx, "infinity-harness: handoff cancelled — continuing here.", "warning");
          pi.sendUserMessage(pending.kickoff, { deliverAs: "followUp" });
        }
      } catch (e) {
        // A handoff that cannot happen must never end the run: fall back to
        // carrying on in this session, which is the pre-2.3 behaviour.
        //
        // Unless the session is already gone — `newSession` can fail *after*
        // replacing the runtime, and reaching for the old `pi` then is the
        // "stale ctx" error rather than a recovery.
        clearHandoff(dir);
        if (!sessionLive) return;
        notify(ctx, `infinity-harness: could not start a new session — ${errMsg(e)}`, "warning");
        pi.sendUserMessage(pending.kickoff, { deliverAs: "followUp" });
      }
    },
  });


  /**
   * What the background sessions are doing.
   *
   * The run's work is no longer in this transcript, so this is where a human
   * looks when they come back to the terminal. It prints rather than asking
   * the model anything: reading the log must never cost a turn.
   */
  pi.registerCommand("infinity:workers", {
    description: "Show the background pi sessions — which unit, which model, and the recent log",
    handler: async (args: string, ctx: ExtensionContext) => {
      const dir = projectDir(ctx);
      if (!isHarnessProject(dir)) {
        notify(ctx, NO_HARNESS, "warning");
        return;
      }
      const rows = Math.max(5, Math.min(120, Number.parseInt(args.trim(), 10) || 25));
      const st = loadSupervisorState(dir);
      const log = loadActivity(dir);
      const engine = engineFor(dir);
      const lines: string[] = [];
      lines.push(
        engine === "background"
          ? "Work runs in background pi sessions. This session spends nothing on it."
          : "Work runs in THIS session (execution.engine = main-session). Your model is paying for the run.",
      );
      if (st?.unit) lines.push(`Unit      ${describeUnit(st.unit, st.baseModel)}`);
      if (st?.worker) {
        const w = st.worker;
        lines.push(
          `Worker    ${w.name} · ${w.state} · ${w.unitLabel} · asked ${w.model || "pi default"}` +
            (w.servedModel && w.servedModel !== w.model ? ` · served ${w.servedModel}` : "") +
            ` · ${w.turns} turn(s) · ${w.tokens.inputTokens + w.tokens.outputTokens} tokens`,
        );
        if (w.doing) lines.push(`          ${w.doing}`);
      } else {
        lines.push("Worker    none running");
      }
      if (st?.history?.length) {
        lines.push("");
        lines.push("Finished sessions (newest last):");
        for (const h of st.history.slice(-6)) {
          lines.push(`  ${h.name} · ${h.unitLabel} · ${h.servedModel ?? (h.model || "pi default")} · ${h.turns} turn(s)`);
        }
      }
      lines.push("");
      lines.push(log.length ? `Background log (last ${Math.min(rows, log.length)}):` : "Background log is empty.");
      for (const l of log.slice(-rows)) {
        const when = l.at.slice(11, 16);
        lines.push(`  ${when} ${l.worker ? l.worker + " " : ""}${l.text}`);
      }
      pi.sendMessage(
        { customType: "infinity:workers", content: lines.join("\n"), display: true, details: { engine } },
        { triggerTurn: false },
      );
    },
  });

  pi.registerCommand("infinity:approve", {
    description: "Approve the phase waiting for you — or send it back with a note",
    handler: async (args: string, ctx: ExtensionContext) => {
      const dir = projectDir(ctx);
      if (!isHarnessProject(dir)) {
        notify(ctx, NO_HARNESS, "warning");
        return;
      }
      const { config } = loadConfig(dir);
      if (!config.awaitingApproval) {
        const signing = approvedPhases(config);
        notify(
          ctx,
          signing.length
            ? `Nothing is waiting. You are signing: ${signing.map((p) => p.toUpperCase()).join(", ")}.`
            : "Nothing is waiting, and you are not signing any phase. /infinity:config changes that.",
          "info",
        );
        return;
      }
      // Approving re-arms the run: the human answering is them saying carry on.
      if (!loopArmed(dir)) armRun(dir, sessionId);
      await applyApproval(ctx, dir, args.trim());
    },
  });

  // -- escalation, rework, replan --------------------------------------------  // -- escalation, rework, replan --------------------------------------------

  pi.registerTool({
    name: "infinity_rework",
    label: "Rework",
    description:
      "Send a task and everything that depends on it back to `rework`. Use when work built on a task " +
      "turns out not to hold up: the dependents were built on the broken thing, so they are suspect " +
      "until re-proved. Bounded by the rework budget.",
    parameters: {
      type: "object",
      required: ["task"],
      properties: {
        task: { type: "string", description: 'Task key, e.g. "feature-001/task-003"' },
        reason: { type: "string", description: "Why this is going backwards" },
        maxImpactDepth: { type: "integer", minimum: 1, maximum: 10 },
      },
    } as never,
    async execute(
      _id: string,
      params: { task: string; reason?: string; maxImpactDepth?: number },
      _signal,
      _onUpdate,
      ctx,
    ) {
      const dir = projectDir(ctx);
      const { list } = loadFeatureList(dir);
      const target = flattenTasks(list).find(
        (t) => t.compositeKey === params.task || t.key === params.task || t.id === params.task,
      );
      if (!target) {
        return {
          content: [{ type: "text", text: `No task matches "${params.task}".` }],
          details: { error: "no-such-task" },
          isError: true,
        };
      }
      try {
        const result = await startRework({
          projectDir: dir,
          featureId: target.featureId,
          taskId: target.id,
          key: target.key,
          reason: params.reason ?? "rework requested",
          runId: runFor(dir),
          maxImpactDepth: params.maxImpactDepth,
        });
        refreshWidget(ctx as ExtensionContext);
        const downstream = result.impacted.length
          ? `Also flipped ${result.impacted.length} dependent task(s): ${result.impacted.join(", ")}`
          : "Nothing depends on it, so this is contained.";
        return {
          content: [
            {
              type: "text",
              text: `${target.compositeKey} is back in rework (plan revision ${result.baseRevision}).\n${downstream}\nFix the root task first, then re-prove the rest.`,
            },
          ],
          details: result,
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
          details: { error: "rework-failed" },
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "infinity_replan",
    label: "Replan",
    description:
      "Add sprints, features or tasks to the plan mid-run, without resubmitting the whole task list. " +
      "Use when the work turns out to need something that was never planned — the plan is the record, " +
      "and building what it does not contain leaves it lying. Bounded by the replan budget.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "What the plan was missing" },
        addFeatures: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            required: ["id", "name"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              description: { type: "string" },
              difficulty: { type: "string", enum: ["easy", "moderate", "difficult"] },
            },
          },
        },
        addTasks: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            required: ["featureId", "task"],
            properties: {
              featureId: { type: "string" },
              task: {
                type: "object",
                required: ["id", "description"],
                properties: {
                  id: { type: "string" },
                  key: { type: "string" },
                  description: { type: "string" },
                  status: { type: "string", enum: ["pending", "in_progress", "complete", "blocked", "rework"] },
                  dependsOn: { type: "array", items: { type: "string" } },
                  difficulty: { type: "string", enum: ["easy", "moderate", "difficult"] },
                  acceptanceCriteria: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
      },
    } as never,
    async execute(
      _id: string,
      params: {
        reason?: string;
        addFeatures?: { id: string; name: string; description?: string; difficulty?: string }[];
        addTasks?: { featureId: string; task: ReplanTaskInput }[];
      },
      _signal,
      _onUpdate,
      ctx,
    ) {
      const dir = projectDir(ctx);
      try {
        const result = await amendPlan({
          projectDir: dir,
          reason: params.reason ?? "mid-run amendment",
          addFeatures: params.addFeatures,
          addTasks: params.addTasks,
        });
        refreshWidget(ctx as ExtensionContext);
        return {
          content: [
            {
              type: "text",
              text:
                `Plan amended to revision ${result.baseRevision}: ` +
                `+${result.added.features} feature(s), +${result.added.tasks} task(s), ` +
                `+${result.added.sprints} sprint(s).`,
            },
          ],
          details: result,
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
          details: { error: "replan-failed" },
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "infinity_unstuck",
    label: "Unstuck",
    description:
      "Ask the escalation ladder what to try next: retry, reframe, consult a stronger model, rework, " +
      "replan, or master. Read-only — it recommends, it does not act. /infinity:run consults it " +
      "automatically when a run stalls; call it yourself when you are stuck and want the next rung.",
    parameters: { type: "object", properties: {} } as never,
    async execute(_id: string, _params: unknown, _signal, _onUpdate, ctx) {
      const dir = projectDir(ctx);
      const { list } = loadFeatureList(dir);
      const task = flattenTasks(list).find((t) => t.status === "in_progress" || t.status === "rework");
      const choice = chooseUnstuckStrategy({
        projectDir: dir,
        featureId: task?.featureId,
        taskId: task?.id,
        currentDifficulty: task?.difficulty ?? null,
        requireDeltaForRework: false,
      });
      const spent = escalationSummary(dir);
      const text = choice.strategy
        ? `Next rung: ${choice.strategy} — ${choice.reason}` +
          (choice.nextModel ? `\nModel: ${choice.nextModel}` : "") +
          `\nSpent so far: ${spent.reworks} rework(s), ${spent.replans} replan(s)` +
          (spent.returnTo ? `, returning to ${spent.returnTo}` : "")
        : `The ladder has nothing left: ${choice.reason}. This needs a human.`;
      return { content: [{ type: "text", text }], details: { ...choice, spent } };
    },
  });

  pi.registerTool({
    name: "infinity_spawn_worker",
    label: "Spawn Worker",
    description:
      "Run one task in an isolated worker: its own attempt directory, prompt, output log and " +
      "fingerprint under tmp/. Use for a task worth attempting without the current conversation's " +
      "context — a clean-room retry. Records the attempt whether or not a command is configured.",
    parameters: {
      type: "object",
      required: ["task", "prompt"],
      properties: {
        task: { type: "string", description: 'Task key, e.g. "feature-001/task-003"' },
        prompt: { type: "string", description: "The complete instruction for the isolated worker" },
        command: { type: "string", description: "Shell command to run; {promptfile} is substituted" },
        model: { type: "string", description: "Model reference for the worker" },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 3_600_000 },
      },
    } as never,
    async execute(
      _id: string,
      params: { task: string; prompt: string; command?: string; model?: string; timeoutMs?: number },
      _signal,
      _onUpdate,
      ctx,
    ) {
      const dir = projectDir(ctx);
      const { list } = loadFeatureList(dir);
      const target = flattenTasks(list).find(
        (t) => t.compositeKey === params.task || t.key === params.task || t.id === params.task,
      );
      if (!target) {
        return {
          content: [{ type: "text", text: `No task matches "${params.task}".` }],
          details: { error: "no-such-task" },
          isError: true,
        };
      }
      try {
        const result = await spawnIsolatedWorker({
          projectDir: dir,
          runId: runFor(dir),
          featureId: target.featureId,
          taskId: target.id,
          prompt: params.prompt,
          command: params.command,
          model: params.model,
          timeoutMs: params.timeoutMs,
        });
        const ran = params.command
          ? `exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`
          : "recorded only — no command configured";
        return {
          content: [
            {
              type: "text",
              text:
                `Worker attempt ${result.attempt} for ${target.compositeKey}: ${ran}\n` +
                `${result.attemptDir}\n\n${result.output.slice(-4000) || "(no output)"}`,
            },
          ],
          details: result,
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
          details: { error: "worker-failed" },
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "infinity_goal",
    label: "Goal",
    description:
      "The outer loop. `start` states a goal and opens pass 1; `status` reports where it is; " +
      "`review` judges whether the work so far actually meets the goal and, if it does not, rewinds " +
      "the pipeline for another pass with the remaining work named; `cancel` stops pursuing it. " +
      "The phase gate decides whether the WORK is done; this decides whether the GOAL is done.",
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["start", "status", "review", "cancel"] },
        goal: { type: "string", description: "start: what this whole run is for, in one sentence" },
        maxIterations: { type: "integer", minimum: 1, maximum: 50, description: "start: how many passes at most" },
        decision: {
          type: "string",
          enum: ["complete", "incomplete", "blocked", "failed"],
          description: "review: does the work meet the goal?",
        },
        rationale: { type: "string", description: "review: why, judged against the goal not the plan" },
        remainingWork: {
          type: "array",
          items: { type: "string" },
          description: "review: required unless complete — what is still missing. The next pass is planned from this.",
        },
        reason: { type: "string", description: "cancel: why" },
      },
    } as never,
    async execute(
      _id: string,
      params: {
        action: string;
        goal?: string;
        maxIterations?: number;
        decision?: ReviewInput["decision"];
        rationale?: string;
        remainingWork?: string[];
        reason?: string;
      },
      _signal,
      _onUpdate,
      ctx,
    ) {
      const dir = projectDir(ctx);
      try {
        if (params.action === "start") {
          if (!params.goal?.trim()) {
            return {
              content: [{ type: "text", text: "A goal needs to say something." }],
              details: { error: "no-goal" },
              isError: true,
            };
          }
          const { state } = await startGoal({
            targetDir: dir,
            goal: params.goal,
            runId: `goal-${runFor(dir)}`,
            maxIterations: params.maxIterations,
          });
          refreshWidget(ctx as ExtensionContext);
          const view = viewOf(state);
          return {
            content: [
              {
                type: "text",
                text:
                  `Goal set: ${view.goal}\nPass 1 of at most ${view.maxIterations}. The pipeline is at the ` +
                  `first phase — define what this needs, plan it, build it. When the pipeline completes, ` +
                  `call infinity_goal with action "review" and judge it against the goal, not the plan.`,
              },
            ],
            details: view,
          };
        }

        if (params.action === "status") {
          const state = await loadGoal(dir);
          if (!state) {
            return {
              content: [{ type: "text", text: "No goal is being pursued in this project." }],
              details: { active: false },
            };
          }
          const view = viewOf(state);
          const remaining = view.remainingWork.length
            ? `\nStill missing:\n${view.remainingWork.map((w) => `  - ${w}`).join("\n")}`
            : "";
          return {
            content: [{ type: "text", text: `${describeGoal(view)}\nPhase: ${view.phase}${remaining}` }],
            details: view,
          };
        }

        if (params.action === "review") {
          if (!params.decision || !params.rationale?.trim()) {
            return {
              content: [{ type: "text", text: "A review needs a decision and a rationale." }],
              details: { error: "incomplete-review" },
              isError: true,
            };
          }
          const outcome = await reviewGoal(dir, {
            decision: params.decision,
            rationale: params.rationale,
            remainingWork: params.remainingWork,
          });
          refreshWidget(ctx as ExtensionContext);
          if (!outcome.terminal) {
            // A new goal pass is the largest context boundary there is: the
            // pipeline has rewound to its first phase and the next pass plans
            // for what is left, not for what the last one already built.
            // Carrying a whole finished pass of conversation into it is the
            // worst case of the problem session handoff exists to solve.
            const brief = await briefText(dir);
            const { config } = loadConfig(dir);
            if (config.session?.handoff !== "off" && loopArmed(dir)) {
              const detail = `goal pass ${config.goalPass ?? "next"}`;
              requestHandoff(dir, {
                reason: "goal-pass",
                detail,
                kickoff: composeKickoff(brief, "goal-pass", detail, carryNote(dir)),
                carry: carryNote(dir),
                runId: runFor(dir),
              });
              handingOff = true;
              pi.sendUserMessage("/infinity:handoff", {
                deliverAs: "followUp",
                expandPromptTemplates: true,
              });
            } else {
              // Rewinding the pipeline means the next brief is a different one.
              pi.sendUserMessage(brief, { deliverAs: "followUp" });
            }
          }
          return { content: [{ type: "text", text: outcome.message }], details: viewOf(outcome.state) };
        }

        if (params.action === "cancel") {
          const state = await cancelGoal(dir, params.reason ?? "cancelled by request");
          refreshWidget(ctx as ExtensionContext);
          return {
            content: [{ type: "text", text: state ? `Goal cancelled: ${state.goal}` : "No goal to cancel." }],
            details: state ? viewOf(state) : { active: false },
          };
        }

        return {
          content: [{ type: "text", text: `Unknown action "${params.action}".` }],
          details: { error: "unknown-action" },
          isError: true,
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
          details: { error: "goal-failed" },
          isError: true,
        };
      }
    },
  });

  // -- commands -------------------------------------------------------------

  pi.registerCommand("infinity:status", {
    description: "Show the current phase, plan and gate state",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const dir = projectDir(ctx);
      if (!isHarnessProject(dir)) {
        notify(ctx, NO_HARNESS, "warning");
        return;
      }
      const state = widgetStateFor(dir);
      if (state) {
        notify(ctx, renderWidget(state, { width: 76, styler, glyphs, boxed: true }).join("\n"), "info");
      }
      refreshWidget(ctx);
    },
  });

  pi.registerCommand("infinity:next", {
    description: "Print the current brief",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const dir = projectDir(ctx);
      // Without this guard it printed a brief for a project with no harness —
      // a page of pipeline instructions for a pipeline that does not exist.
      if (!isHarnessProject(dir)) {
        notify(ctx, NO_HARNESS, "warning");
        return;
      }
      notify(ctx, await briefText(dir), "info");
    },
  });

  pi.registerCommand("infinity:validate", {
    description: "Run the gate for the current phase",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const dir = projectDir(ctx);
      if (!isHarnessProject(dir)) {
        notify(ctx, NO_HARNESS, "warning");
        return;
      }
      const { config } = loadConfig(dir);
      if (!config.currentPhase) {
        notify(ctx, "No current phase.", "warning");
        return;
      }
      const gate = await runChecks(dir, config.currentPhase, { record: true });
      const lines = gate.checks.map((c) => `${c.advisory ? "·" : c.pass ? "+" : "x"} ${c.name}: ${c.detail}`);
      notify(ctx, `Gate ${gate.overall ? "PASS" : "FAIL"}\n${lines.join("\n")}`, gate.overall ? "info" : "warning");
      refreshWidget(ctx);
    },
  });

  pi.registerCommand("infinity:run", {
    description: "Start the continuous loop — validate, advance, re-brief, until done or stuck",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const dir = projectDir(ctx);
      if (!isHarnessProject(dir)) {
        notify(ctx, NO_HARNESS, "warning");
        return;
      }
      armRun(dir, sessionId);
      const engine = engineFor(dir);
      notify(
        ctx,
        `infinity-harness: continuous run armed. It stops on completion, on an exhausted retry budget, ` +
          `when no progress is detected, or when you create ${stopFilePath(dir)}. Use /infinity:halt to stop now.`,
        "info",
      );
      if (engine === "main-session") {
        const text = await briefText(dir);
        pi.sendUserMessage(text, { deliverAs: "followUp" });
        return;
      }
      // The background engine: this session says nothing to its own model. It
      // starts an orchestrator that spawns pi children on the routed models,
      // and from here on it is a control panel.
      const unit = currentUnit(dir, baseModelOf(ctx));
      await startEngine(ctx, dir);
      notify(
        ctx,
        unit
          ? `infinity-harness: working in background sessions — ${describeUnit(unit, baseModelOf(ctx))}. ` +
              `This session stays free; /infinity:workers shows what they are doing.`
          : "infinity-harness: background engine started.",
        "info",
      );
      refreshWidget(ctx);
    },
  });

  pi.registerCommand("infinity:goal", {
    description: "State a goal and pursue it across passes — or review, cancel, or check one",
    handler: async (args: string, ctx: ExtensionContext) => {
      const dir = projectDir(ctx);
      if (!isHarnessProject(dir)) {
        notify(ctx, NO_HARNESS, "warning");
        return;
      }
      const text = args.trim();

      if (text === "" || text === "status") {
        const state = await loadGoal(dir);
        if (!state) {
          notify(ctx, 'No goal set. `/infinity:goal <what you want built>` starts one.', "info");
          return;
        }
        const view = viewOf(state);
        const remaining = view.remainingWork.length
          ? `\nStill missing:\n${view.remainingWork.map((w) => `  - ${w}`).join("\n")}`
          : "";
        notify(ctx, `${describeGoal(view)}\nPhase: ${view.phase}${remaining}`, "info");
        return;
      }

      if (text === "cancel") {
        const state = await cancelGoal(dir, "cancelled from /infinity:goal");
        notify(ctx, state ? `Goal cancelled: ${state.goal}` : "No goal to cancel.", "info");
        refreshWidget(ctx);
        return;
      }

      try {
        const { state } = await startGoal({ targetDir: dir, goal: text, runId: `goal-${runFor(dir)}` });
        refreshWidget(ctx);
        notify(
          ctx,
          `Goal set: ${state.goal}\nPass 1 of at most ${state.limits.maxIterations}. ` +
            `The pipeline is back at its first phase.`,
          "info",
        );
        pi.sendUserMessage(await briefText(dir), { deliverAs: "followUp" });
      } catch (e) {
        notify(ctx, e instanceof Error ? e.message : String(e), "error");
      }
    },
  });

  pi.registerCommand("infinity:unstuck", {
    description: "What the escalation ladder would try next, and what it has spent",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const dir = projectDir(ctx);
      if (!isHarnessProject(dir)) {
        notify(ctx, NO_HARNESS, "warning");
        return;
      }
      const { list } = loadFeatureList(dir);
      const task = flattenTasks(list).find((t) => t.status === "in_progress" || t.status === "rework");
      const choice = chooseUnstuckStrategy({
        projectDir: dir,
        featureId: task?.featureId,
        taskId: task?.id,
        currentDifficulty: task?.difficulty ?? null,
        requireDeltaForRework: false,
      });
      const spent = escalationSummary(dir);
      const rework = loadRework(dir);
      const lines = [
        choice.strategy
          ? `Next rung: ${choice.strategy} — ${choice.reason}`
          : `The ladder has nothing left: ${choice.reason}`,
        choice.nextModel ? `Model: ${choice.nextModel}` : null,
        `Spent: ${spent.reworks} rework(s), ${spent.replans} replan(s)`,
        rework ? `Returning to ${rework.returnFeature}/${rework.returnTask} — ${rework.reason}` : null,
        `Ladder: ${DEFAULT_LADDER.join(" → ")}`,
      ].filter((l): l is string => l !== null);
      notify(ctx, lines.join("\n"), "info");
    },
  });

  pi.registerCommand("infinity:rework", {
    description: "Send a task and its dependents back to rework",
    handler: async (args: string, ctx: ExtensionContext) => {
      const dir = projectDir(ctx);
      if (!isHarnessProject(dir)) {
        notify(ctx, NO_HARNESS, "warning");
        return;
      }
      const key = args.trim();
      const { list } = loadFeatureList(dir);
      const tasks = flattenTasks(list);

      if (key === "clear") {
        await clearRework(dir);
        notify(ctx, "Rework record cleared.", "info");
        refreshWidget(ctx);
        return;
      }

      let target = tasks.find((t) => t.compositeKey === key || t.key === key || t.id === key);
      if (!target && ctx.hasUI) {
        const rows = tasks.map((t) => `${t.compositeKey} [${t.status}] ${t.description}`);
        const picked = await ctx.ui.select("Send which task back to rework?", rows);
        if (picked === undefined) return;
        target = tasks[rows.indexOf(picked)];
      }
      if (!target) {
        notify(ctx, key ? `No task matches "${key}".` : "Name a task: /infinity:rework <task-key>", "warning");
        return;
      }

      try {
        const result = await startRework({
          projectDir: dir,
          featureId: target.featureId,
          taskId: target.id,
          key: target.key,
          reason: "rework from /infinity:rework",
          runId: runFor(dir),
        });
        refreshWidget(ctx);
        notify(
          ctx,
          `${target.compositeKey} → rework (revision ${result.baseRevision}). ` +
            (result.impacted.length
              ? `${result.impacted.length} dependent task(s) went with it: ${result.impacted.join(", ")}`
              : "Nothing depends on it."),
          "info",
        );
      } catch (e) {
        notify(ctx, e instanceof Error ? e.message : String(e), "error");
      }
    },
  });

  pi.registerCommand("infinity:halt", {
    description: "Stop the continuous loop after the current turn",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const dir = projectDir(ctx);
      if (!isHarnessProject(dir)) {
        notify(ctx, NO_HARNESS, "warning");
        return;
      }
      disarmRun(dir, "halted from /infinity:halt");
      clearHandoff(dir);
      await stopEngine("halted from /infinity:halt");
      notify(ctx, "infinity-harness: continuous run stopped, background sessions closed.", "info");
      refreshWidget(ctx);
    },
  });

  pi.registerCommand("infinity:pause", {
    description: "Pause the pipeline (persisted in harness/config.json)",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const dir = projectDir(ctx);
      if (!isHarnessProject(dir)) {
        notify(ctx, NO_HARNESS, "warning");
        return;
      }
      const { value } = await withLock(configPath(dir), () => {
        const { config, ok } = loadConfig(dir);
        if (!ok) return false;
        config.paused = true;
        return saveConfig(dir, config).ok;
      });
      disarmRun(dir, "paused from /infinity:pause");
      await stopEngine("paused from /infinity:pause");
      notify(ctx, value ? "infinity-harness: paused, background sessions closed." : "Could not pause — config unreadable.", value ? "info" : "error");
      refreshWidget(ctx);
    },
  });

  pi.registerCommand("infinity:resume", {
    description: "Unpause the pipeline",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const dir = projectDir(ctx);
      if (!isHarnessProject(dir)) {
        notify(ctx, NO_HARNESS, "warning");
        return;
      }
      const { value } = await withLock(configPath(dir), () => {
        const { config, ok } = loadConfig(dir);
        if (!ok) return false;
        config.paused = false;
        return saveConfig(dir, config).ok;
      });
      if (value && loadRunState(dir)?.armed === true && engineFor(dir) !== "main-session") {
        await startEngine(ctx, dir);
      }
      notify(ctx, value ? "infinity-harness: resumed." : "Could not resume — config unreadable.", value ? "info" : "error");
      refreshWidget(ctx);
    },
  });

  pi.registerCommand("infinity:config", {
    description: "Configure the harness — models per difficulty tier, gates, commands, loop budgets",
    handler: async (args: string, ctx: ExtensionContext) => {
      const dir = projectDir(ctx);
      if (!isHarnessProject(dir)) {
        notify(ctx, NO_HARNESS, "warning");
        return;
      }

      // `\/infinity:config show` prints everything without prompting, which is
      // what you want over SSH, in a log, or when the UI has no dialogs.
      if (args.trim() === "show" || !ctx.hasUI) {
        notify(ctx, renderSettings(dir), "info");
        if (!ctx.hasUI && args.trim() !== "show") {
          notify(ctx, "This mode has no dialogs — edit harness/config.json directly.", "warning");
        }
        return;
      }

      const changed = await runConfigMenu({
        targetDir: dir,
        prompt: prompterFor(ctx),
        models: () => availableModels(ctx),
      });

      if (changed.length === 0) {
        notify(ctx, "infinity-harness: no changes.", "info");
      } else {
        notify(ctx, `infinity-harness: updated ${changed.join(", ")}`, "info");
      }
      refreshWidget(ctx);
    },
  });

  pi.registerCommand("infinity:models", {
    description: "Show which models pi has available, and how the harness is routing them",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const dir = projectDir(ctx);
      const models = availableModels(ctx);
      const lines: string[] = [];

      lines.push(`Models pi can use (${models.length})`);
      if (models.length === 0) {
        lines.push("  none — check provider auth, or run `pi models`");
      } else {
        for (const m of models) lines.push(`  ${m.label}`);
      }

      if (isHarnessProject(dir)) {
        lines.push("", "Routing");
        const io = readAll(dir);
        const group = SETTINGS.find((g) => g.id === "models");
        for (const s of group?.settings ?? []) {
          lines.push(`  ${s.label.padEnd(28)} ${formatValue(s, readSetting(io, s))}`);
        }
        lines.push("", "Change these with /infinity:config.");
      }
      notify(ctx, lines.join("\n"), "info");
    },
  });

  // -- keys -----------------------------------------------------------------
  //
  // The widget is nine rows of a plan that is routinely sixty. Without these
  // the other fifty-one are unreachable without opening the dashboard, which
  // is not a thing anyone does mid-glance.
  //
  // `alt+` and not `ctrl+`: pi already binds ctrl+j (newline), ctrl+k (delete
  // to line end) and ctrl+o (expand tool output). Shadowing an editor key to
  // scroll a widget would be a worse bug than the one being fixed.
  //
  // Shortcuts are editor-focused via registerShortcut, but also handled as a
  // raw terminal fallback so they work when an overlay or selector has focus
  // or when the terminal sends the legacy ESC+j sequence that the editor
  // otherwise swallows as text.

  const scrollDown = async (ctx: ExtensionContext): Promise<void> => moveView(ctx, SCROLL_STEP);
  const scrollUp = async (ctx: ExtensionContext): Promise<void> => moveView(ctx, -SCROLL_STEP);
  const toggleExpand = async (ctx: ExtensionContext): Promise<void> => {
    view = { ...view, expanded: !view.expanded };
    refreshWidget(ctx);
  };

  pi.registerShortcut("alt+j", { description: "infinity-harness: scroll the plan down", handler: scrollDown });
  pi.registerShortcut("alt+k", { description: "infinity-harness: scroll the plan up", handler: scrollUp });
  pi.registerShortcut("alt+o", { description: "infinity-harness: expand or collapse the plan widget", handler: toggleExpand });
  // Uppercase handling covered by the raw terminal fallback below which
  // lowercases data before matching; KeyId type only allows lowercase.

  // Fallback raw input handler — runs even when the editor is not the
  // focused component (e.g. a selector is open). Must be installed per-
  // session because onTerminalInput is a UI session thing, not a global.
  let removeTerminalShortcut: (() => void) | null = null;
  const installTerminalShortcuts = (ctx: ExtensionContext): void => {
    try {
      removeTerminalShortcut?.();
    } catch {}
    try {
      // matchesKey lives in pi-tui but re-exported by pi; use the extension
      // input raw matcher via string compare for ESC-prefixed alt.
      removeTerminalShortcut = ctx.ui.onTerminalInput((data: string) => {
        // Legacy alt+letter is ESC + lower letter. Kitty may send CSI-u; both
        // are handled by normalising to lookahead then matching via the same
        // strings registerShortcut uses.
        const lower = data.toLowerCase();
        // Fast path: alt+j/k/o as ESC + letter (\x1bj) or higher-plane.
        if (data === "\x1bj" || data === "\x1bJ" || lower === "\x1bj") {
          void scrollDown(ctx);
          return { consume: true };
        }
        if (data === "\x1bk" || data === "\x1bK" || lower === "\x1bk") {
          void scrollUp(ctx);
          return { consume: true };
        }
        if (data === "\x1bo" || data === "\x1bO" || lower === "\x1bo") {
          void toggleExpand(ctx);
          return { consume: true };
        }
        return undefined;
      });
    } catch {}
  };

  pi.registerCommand("infinity:scroll", {
    description: "Move the plan widget — up, down, top, bottom, expand, follow",
    handler: async (args: string, ctx: ExtensionContext) => {
      const dir = projectDir(ctx);
      if (!isHarnessProject(dir)) {
        notify(ctx, NO_HARNESS, "warning");
        return;
      }
      const what = args.trim().toLowerCase() || "down";
      const rows = planRowCount(dir);
      switch (what) {
        case "up":
          moveView(ctx, -SCROLL_STEP);
          return;
        case "down":
          moveView(ctx, SCROLL_STEP);
          return;
        case "top":
          view = { ...view, scroll: 0 };
          break;
        case "bottom":
          view = { ...view, scroll: rows };
          break;
        case "expand":
          view = { ...view, expanded: true };
          break;
        case "collapse":
          view = { ...view, expanded: false };
          break;
        case "follow":
          // Back to tracking the active task, which is where it starts.
          view = defaultView();
          break;
        default:
          notify(ctx, "Use: up · down · top · bottom · expand · collapse · follow", "warning");
          return;
      }
      refreshWidget(ctx);
    },
  });

  pi.registerCommand("infinity:dashboard", {
    description: "Open the read-only web dashboard for this run",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const dir = projectDir(ctx);
      if (!isHarnessProject(dir)) {
        notify(ctx, NO_HARNESS, "warning");
        return;
      }
      const remote = await import("../../src/remote.ts");
      if (remoteServer) {
        notify(ctx, `Dashboard already live at ${remoteServer.url}`, "info");
        return;
      }
      const srv = await remote.createRemoteServer({ projectDir: dir, host: "127.0.0.1", port: 0 });
      remoteServer = srv;
      remoteDir = dir;
      notify(ctx, `infinity-harness dashboard: ${srv.url}`, "info");
    },
  });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The workflow this project is on, and whether it still matches a named one. */
function describeCurrentWorkflow(dir: string): string {
  const { config } = loadConfig(dir);
  const named = matchWorkflow(config);
  const head = `Workflow: ${summarizeWorkflow(config)}`;
  const rail = (config.phases?.enabled ?? [])
    .map((p) => (config.phaseModes?.[p] === "copilot" ? `[${p}]` : p))
    .join(" → ");
  const drift = named
    ? ""
    : "\n\nThese settings do not match any saved workflow. `/infinity:workflow` can save them as one.";
  return `${head}\n  ${rail}\n  (a phase in [brackets] stops for you)${drift}`;
}

/**
 * What this session is, when the work is happening somewhere else.
 *
 * Deliberately a few lines rather than the brief. The brief is several
 * kilobytes, it is re-read on every turn once it is in the transcript, and it
 * is written to make a model start building — none of which belongs in a
 * window whose job is to show a human what is going on.
 */
function controlPanelNote(dir: string, armed: boolean): string {
  const { config } = loadConfig(dir);
  const { list } = loadFeatureList(dir);
  const p = computeProgress(list);
  const L: string[] = [];
  L.push("[infinity-harness] control panel");
  L.push(
    `${(config.currentPhase ?? "not started").toUpperCase()} · ${p.tasksDone}/${p.tasksTotal} tasks · ` +
      `${p.featuresDone}/${p.featuresTotal} features · plan rev ${list.baseRevision}` +
      (armed ? " · run armed" : ""),
  );
  L.push("");
  L.push(
    "The run works in separate background pi sessions, each on the model its difficulty tier " +
      "names. This session does not do that work and should not start it.",
  );
  L.push("");
  L.push("  /infinity:workers   what the background sessions are doing right now");
  L.push("  /infinity:status    where the run is");
  L.push(armed ? "  /infinity:halt      stop the run" : "  /infinity:run       start the run");
  L.push("  /infinity:approve   sign a phase that is waiting for you");
  return L.join("\n");
}

/**
 * The contract for a control panel.
 *
 * The pipeline contract tells a model to work the plan. Told that in a
 * session whose whole point is *not* to work the plan, a model helpfully
 * starts building — on the human's own model, which is the bug this engine
 * exists to fix. This says the opposite, in as few words.
 */
function controlPanelContract(dir: string): string | null {
  const { config, ok } = loadConfig(dir);
  if (!ok || !config.currentPhase) return null;
  const { list } = loadFeatureList(dir);
  const p = computeProgress(list);
  return [
    "## infinity-harness — you are the control panel",
    "",
    `This project runs an infinity-harness pipeline at **${config.currentPhase.toUpperCase()}**, ` +
      `${p.tasksDone}/${p.tasksTotal} tasks done. The work is being done by separate background ` +
      `pi sessions on their own models, not by you.`,
    "",
    "1. Do not implement plan tasks, advance phases, or edit `harness/` by hand. Answer the",
    "   human's questions about the run, and use `/infinity:workers` and `infinity_status`",
    "   to see what the background sessions are doing.",
    "2. If the human asks you to build something, say that the harness is driving it and offer",
    "   `/infinity:run`, `/infinity:halt`, or `/infinity:replan` instead.",
    "3. The plan of record is `harness/features/feature-list.json`; your memory of it is not.",
  ].join("\n");
}

/**
 * The few sentences the run cannot afford to have summarised away.
 *
 * Short on purpose: this is paid for on every single request, and a long
 * system prompt crowds out the work. It carries only what stops the agent
 * going freelance after a compaction — where the pipeline is, what it is
 * working on, and the three rules that make the harness a harness.
 */
function harnessContract(dir: string): string | null {
  const { config, ok } = loadConfig(dir);
  if (!ok || !config.currentPhase) return null;

  const { list } = loadFeatureList(dir);
  const progress = computeProgress(list);
  const phase = config.currentPhase.toUpperCase();
  const role = config.currentRole ?? "";

  const L: string[] = [];
  L.push("## infinity-harness");
  L.push("");
  L.push(
    `This project is driven by the infinity-harness pipeline. You are at **${phase}**` +
      (role ? ` wearing the ${role} hat` : "") +
      `, with ${progress.tasksDone}/${progress.tasksTotal} tasks done across ` +
      `${progress.featuresTotal} feature(s). Plan revision ${list.baseRevision}.`,
  );
  L.push("");
  L.push("Rules that do not change, whatever the conversation above says:");
  L.push("");
  L.push("1. The plan of record is `harness/features/feature-list.json`, reached through the");
  L.push("   `infinity_plan` tool. It is the truth; your memory of it is not.");
  L.push("2. You never advance a phase and never mark your own work complete. Call");
  L.push("   `infinity_validate`; the gate is the only referee. Do not edit");
  L.push("   `harness/config.json` by hand.");
  L.push("3. If you do not know what to do next, call `infinity_brief` rather than guessing.");
  if (config.awaitingApproval) {
    L.push(
      `4. ${String(config.awaitingApproval).toUpperCase()} is waiting for a human signature. Do not start the next phase.`,
    );
  }
  if (config.paused) {
    L.push("4. The pipeline is PAUSED. Do not continue autonomously — report and stop.");
  }
  return L.join("\n");
}

/** Our injected reminders, so they can be pruned before the next call. */
function isOurReminder(m: unknown): boolean {
  const msg = m as { role?: string; content?: Array<{ type?: string; text?: string }> };
  if (msg?.role !== "user" || !Array.isArray(msg.content)) return false;
  return msg.content.some((c) => c?.type === "text" && c.text?.startsWith("[infinity-harness]"));
}

