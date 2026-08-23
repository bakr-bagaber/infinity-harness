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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";

import { isHarnessProject, loadConfig, saveConfig } from "../../src/core/config.ts";
import { loadFeatureList, computeProgress } from "../../src/core/featureList.ts";
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
import { decideNext, stopFilePath, loopStatePath } from "../../src/loop.ts";
import { runConfigMenu, renderSettings, type ModelChoice, type Prompter } from "../../src/ui/config.ts";
import { SETTINGS, readAll, readSetting, formatValue } from "../../src/core/settings.ts";
import { detectStack, describeInit, initHarness, type StackId } from "../../src/core/init.ts";
import { startRework, loadRework, clearRework } from "../../src/rework.ts";
import { amendPlan, loadReplanHistory, type ReplanTaskInput } from "../../src/replan.ts";
import { chooseUnstuckStrategy } from "../../src/unstuck.ts";
import { escalationSummary } from "../../src/escalate.ts";
import { spawnIsolatedWorker } from "../../src/worker.ts";
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
  const runId = randomUUID();
  let llmCalls = 0;
  let loopEnabled = false;
  let loopBusy = false;
  let lastBriefPhase: string | null = null;
  let remoteServer: { url: string; close: () => Promise<void> } | null = null;
  let remoteDir: string | null = null;

  const styler = createStyler();
  const glyphs = detectGlyphs();

  // -- widget ---------------------------------------------------------------

  const widgetStateFor = (dir: string): WidgetState | null => {
    try {
      const { list } = loadFeatureList(dir);
      const { config } = loadConfig(dir);
      const spent = escalationSummary(dir);
      const loop = readJsonSafe<{ escalations?: { strategy: string }[] } | null>(
        loopStatePath(dir),
        null,
      );
      const lastRung = loop?.escalations?.[loop.escalations.length - 1]?.strategy ?? null;
      const pass = typeof config.goalPass === "number" ? config.goalPass : null;
      const maxPasses = typeof config.goalMaxPasses === "number" ? config.goalMaxPasses : null;
      return {
        list,
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

  // -- brief ----------------------------------------------------------------

  const briefText = async (dir: string, includeGate = false): Promise<string> => {
    const { config } = loadConfig(dir);
    const brief = await buildBrief(dir, { includeGate });
    return renderBrief(brief, config);
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

  // -- lifecycle ------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    const dir = projectDir(ctx);
    if (!isHarnessProject(dir)) return;

    refreshWidget(ctx);
    const { config } = loadConfig(dir);
    lastBriefPhase = config.currentPhase;

    notify(ctx, `infinity-harness active · ${config.currentPhase ?? "not started"}`, "info");
    try {
      pi.appendEntry("infinity:session", { runId, dir, phase: config.currentPhase });
    } catch {
      /* entry log is best-effort */
    }

    // The brief is delivered as a message rather than a notification so the
    // model actually reads it. Without this the agent starts from whatever
    // the user typed and ignores the pipeline entirely.
    try {
      const text = await briefText(dir);
      pi.sendMessage(
        { customType: "infinity:brief", content: text, display: true, details: { phase: config.currentPhase } },
        { triggerTurn: false, deliverAs: "nextTurn" },
      );
    } catch (e) {
      notify(ctx, `infinity-harness: could not build brief — ${errMsg(e)}`, "warning");
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    refreshWidget(ctx);
  });

  /**
   * Periodic nudge. Long runs drift: the model finishes work and forgets to
   * record it, so the plan on disk and reality diverge. A short reminder every
   * few calls costs little and keeps the plan honest.
   */
  pi.on("context", async (event, ctx) => {
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
   * Compaction drops the transcript. The plan lives on disk so it survives,
   * but the model's *awareness* of it does not — so we re-state it afterwards.
   */
  pi.on("session_before_compact", async (_event, ctx) => {
    const dir = projectDir(ctx);
    if (!isHarnessProject(dir)) return;
    try {
      const { list } = loadFeatureList(dir);
      pi.appendEntry(CHECKPOINT, { revision: list.baseRevision, at: new Date().toISOString() });
    } catch {
      /* checkpoint is advisory */
    }
  });

  pi.on("session_compact", async (_event, ctx) => {
    const dir = projectDir(ctx);
    if (!isHarnessProject(dir)) return;
    try {
      const text = await briefText(dir);
      pi.sendMessage(
        { customType: "infinity:brief", content: text, display: false, details: { after: "compaction" } },
        { triggerTurn: false, deliverAs: "nextTurn" },
      );
      refreshWidget(ctx);
    } catch {
      /* the next brief will catch it up */
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    refreshWidget(ctx);
  });

  /**
   * The loop. `agent_settled` fires when the agent has stopped working, which
   * is the only safe moment to run the gate and decide what happens next.
   */
  pi.on("agent_settled", async (_event, ctx) => {
    const dir = projectDir(ctx);
    if (!isHarnessProject(dir)) return;
    if (!loopEnabled || loopBusy) return;

    loopBusy = true;
    try {
      const { decision } = await decideNext({ targetDir: dir, runId });
      refreshWidget(ctx);

      switch (decision.action) {
        case "advanced":
          notify(ctx, `infinity-harness: gate passed → ${decision.toPhase}`, "info");
          lastBriefPhase = decision.toPhase;
          pi.sendUserMessage(decision.message, { deliverAs: "followUp" });
          break;
        case "continue":
          notify(ctx, `infinity-harness: gate failed — re-briefing`, "warning");
          pi.sendUserMessage(decision.message, { deliverAs: "followUp" });
          break;
        case "wait":
          loopEnabled = false;
          notify(ctx, `infinity-harness: ${decision.detail}`, "warning");
          break;
        case "stop":
          loopEnabled = false;
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
    } catch (e) {
      loopEnabled = false;
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
    if (remoteServer) {
      try {
        await remoteServer.close();
      } catch {
        /* closing a dead server is fine */
      }
      remoteServer = null;
      remoteDir = null;
    }
    loopEnabled = false;
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
  const SELECTABLE_PHASES: Phase[] = ["define", "plan", "build", "verify", "simplify", "review", "ship"];

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
    description: "Create a harness in this project",
    handler: async (args: string, ctx: ExtensionContext) => {
      const dir = projectDir(ctx);
      const force = /\bforce\b/.test(args);

      if (isHarnessProject(dir) && !force) {
        notify(
          ctx,
          "This project already has a harness. /infinity:config changes it; /infinity:init force restores missing files.",
          "warning",
        );
        return;
      }

      const detected = detectStack(dir);
      let mode: "copilot" | "autopilot" = "copilot";
      let phases: Phase[] | undefined;

      // With dialogs, ask the two questions whose answers we cannot infer.
      // Without them, take the detected defaults and say so — an unattended
      // run must not stall on a prompt nobody will answer.
      if (ctx.hasUI) {
        const cmds = Object.entries(detected.commands).filter(([, v]) => Boolean(v));
        const summary = cmds.length ? cmds.map(([k, v]) => `${k}: ${v}`).join(", ") : "no commands detected";
        const go = await ctx.ui.select(
          `Create a harness here? ${detected.label} · ${summary}`,
          ["yes, use these defaults", "yes, but let me choose the phases", "cancel"],
        );
        if (go === undefined || go === "cancel") {
          notify(ctx, "init cancelled — nothing was written.", "info");
          return;
        }
        const picked = await ctx.ui.select("How should it run?", [
          "copilot — you stay in the loop",
          "autopilot — it drives itself",
        ]);
        if (picked?.startsWith("autopilot")) mode = "autopilot";

        if (go.includes("phases")) {
          const chosen = new Set<Phase>(DEFAULT_ENABLED_PHASES);
          for (;;) {
            const rows = SELECTABLE_PHASES.map((p) => `${chosen.has(p) ? "[x]" : "[ ]"} ${p}`);
            const hit = await ctx.ui.select("Phases to run", [...rows, "✓ done"]);
            if (hit === undefined || hit === "✓ done") break;
            const key = SELECTABLE_PHASES[rows.indexOf(hit)];
            if (!key) break;
            if (chosen.has(key)) chosen.delete(key);
            else chosen.add(key);
          }
          phases = [...chosen];
        }
      }

      const result = initHarness(dir, { mode, phases, force });
      if (!result.ok) {
        notify(ctx, result.error ?? "init failed", "error");
        return;
      }

      notify(ctx, describeInit(result), "info");
      refreshWidget(ctx);
      // Hand the model the brief straight away, so the session that created
      // the harness is also the session that starts using it.
      pi.sendUserMessage(await briefText(dir), { deliverAs: "followUp" });
    },
  });


  // -- escalation, rework, replan --------------------------------------------

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
          runId,
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
          runId,
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
            runId: `goal-${runId}`,
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
            // Rewinding the pipeline means the next brief is a different one.
            pi.sendUserMessage(await briefText(dir), { deliverAs: "followUp" });
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
      notify(ctx, await briefText(dir), "info");
    },
  });

  pi.registerCommand("infinity:validate", {
    description: "Run the gate for the current phase",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const dir = projectDir(ctx);
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
      loopEnabled = true;
      notify(
        ctx,
        `infinity-harness: continuous run armed. It stops on completion, on an exhausted retry budget, ` +
          `when no progress is detected, or when you create ${stopFilePath(dir)}. Use /infinity:halt to stop now.`,
        "info",
      );
      const text = await briefText(dir);
      pi.sendUserMessage(text, { deliverAs: "followUp" });
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
        const { state } = await startGoal({ targetDir: dir, goal: text, runId: `goal-${runId}` });
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
          runId,
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
      loopEnabled = false;
      notify(ctx, "infinity-harness: continuous run stopped.", "info");
    },
  });

  pi.registerCommand("infinity:pause", {
    description: "Pause the pipeline (persisted in harness/config.json)",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const dir = projectDir(ctx);
      const { value } = await withLock(configPath(dir), () => {
        const { config, ok } = loadConfig(dir);
        if (!ok) return false;
        config.paused = true;
        return saveConfig(dir, config).ok;
      });
      loopEnabled = false;
      notify(ctx, value ? "infinity-harness: paused." : "Could not pause — config unreadable.", value ? "info" : "error");
      refreshWidget(ctx);
    },
  });

  pi.registerCommand("infinity:resume", {
    description: "Unpause the pipeline",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const dir = projectDir(ctx);
      const { value } = await withLock(configPath(dir), () => {
        const { config, ok } = loadConfig(dir);
        if (!ok) return false;
        config.paused = false;
        return saveConfig(dir, config).ok;
      });
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

  pi.registerCommand("infinity:dashboard", {
    description: "Open the read-only web dashboard for this run",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const dir = projectDir(ctx);
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

/** Our injected reminders, so they can be pruned before the next call. */
function isOurReminder(m: unknown): boolean {
  const msg = m as { role?: string; content?: Array<{ type?: string; text?: string }> };
  if (msg?.role !== "user" || !Array.isArray(msg.content)) return false;
  return msg.content.some((c) => c?.type === "text" && c.text?.startsWith("[infinity-harness]"));
}

