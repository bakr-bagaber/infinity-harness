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
import { withLock } from "../../src/core/lock.ts";
import { ValidationError, type FeatureList, type Phase } from "../../src/core/types.ts";
import { writeTaskList, summarizeApply, type TaskInput } from "../../src/taskList.ts";
import { renderWidget, renderStatusLine, type WidgetState } from "../../src/ui/widget.ts";
import { createStyler, detectGlyphs } from "../../src/ui/theme.ts";
import { decideNext, stopFilePath } from "../../src/loop.ts";

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
      return {
        list,
        phase: config.currentPhase,
        enabledPhases: config.phases?.enabled,
        paused: Boolean(config.paused),
        revision: list.baseRevision,
        retries: { task: config.taskRetryCount ?? 0, max: config.maxRetries ?? 10 },
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
      },
    } as never,
    async execute(_id: string, params: { baseRevision?: number; tasks?: TaskInput[] }, _signal, _onUpdate, ctx) {
      const dir = projectDir(ctx);

      if (!Array.isArray(params?.tasks)) {
        const { list } = loadFeatureList(dir);
        const p = computeProgress(list);
        const rows = (list.features ?? [])
          .flatMap((f) => (f.tasks ?? []).map((t) => `[${t.status}] ${t.key ?? t.id}: ${t.description}`))
          .join("\n");
        return {
          content: [
            {
              type: "text",
              text: `Plan revision ${list.baseRevision} — ${p.tasksDone}/${p.tasksTotal} tasks\n${rows || "(empty)"}`,
            },
          ],
          details: { revision: list.baseRevision, progress: p },
        };
      }

      try {
        // writeTaskList takes the plan lock itself, around the whole
        // read-apply-write. Wrapping it again here would only add a second
        // lock with weaker semantics.
        const result = writeTaskList(dir, { baseRevision: params.baseRevision, tasks: params.tasks! });
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

  // -- commands -------------------------------------------------------------

  pi.registerCommand("infinity:status", {
    description: "Show the current phase, plan and gate state",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const dir = projectDir(ctx);
      if (!isHarnessProject(dir)) {
        notify(ctx, "No harness in this project (harness/config.json not found).", "warning");
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
        notify(ctx, "No harness in this project.", "warning");
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

