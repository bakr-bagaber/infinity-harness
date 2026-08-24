#!/usr/bin/env node
/**
 * infinity-harness — a real-pi driver for the end-to-end suite.
 *
 * Spawns `pi --mode rpc` against a scripted model server and speaks the RPC
 * protocol to it, which is as close to being the human at the keyboard as a
 * test can get:
 *
 *   - typing a prompt or a slash command             → `prompt`
 *   - answering a wizard dialog                      → `extension_ui_response`
 *   - reading the plan widget and the status line    → captured `setWidget` /
 *                                                       `setStatus` requests
 *   - reading notifications                          → captured `notify`
 *   - watching compaction happen                     → `compaction_*` events
 *
 * Everything the extension pushes at the UI is recorded, so a scenario can
 * assert on what the human would actually have seen, not on what the module
 * that produced it returned.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PI_BIN = resolve(
  import.meta.dirname,
  "../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
);

/** Wait helper that never rejects on a missing event — callers assert. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class PiDriver {
  /**
   * @param {object} opts
   * @param {string} opts.cwd            project directory pi runs in
   * @param {string} opts.configDir      PI_CODING_AGENT_DIR (isolated per run)
   * @param {number} opts.port           mock model server port
   * @param {string[]} [opts.extensions] extension files to load
   * @param {string} [opts.sessionDir]   session storage
   * @param {number} [opts.contextWindow] declared context window of the mock model
   */
  constructor(opts) {
    this.opts = opts;
    this.events = [];
    this.uiRequests = [];
    this.responses = new Map();
    this.widgets = new Map();
    this.statuses = new Map();
    this.notifications = [];
    this.stderr = "";
    this.exited = false;
    this.buffer = "";
    /** Answers queued for dialogs, matched in order by a predicate. */
    this.answers = [];
    this.seq = 0;
  }

  start() {
    const { cwd, configDir, port, extensions = [], sessionDir, contextWindow = 40000 } = this.opts;

    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      resolve(configDir, "models.json"),
      JSON.stringify(
        {
          providers: {
            mock: {
              baseUrl: `http://127.0.0.1:${port}`,
              api: "openai-completions",
              apiKey: "mock",
              compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
              models: [{ id: "mock-1", name: "Mock", contextWindow, maxTokens: 4096 }],
            },
          },
        },
        null,
        2,
      ),
    );

    // Compaction thresholds live in settings, and the suite needs to be able
    // to force compaction on a small session rather than burning a hundred
    // turns to reach a real one.
    const settings = this.opts.settings ?? {};
    writeFileSync(resolve(configDir, "settings.json"), JSON.stringify(settings, null, 2));

    const args = [
      PI_BIN,
      "--mode",
      "rpc",
      "-a",
      "--offline",
      "--provider",
      "mock",
      "--model",
      "mock-1",
      "--api-key",
      "mock",
    ];
    for (const e of extensions) args.push("-e", e);
    if (sessionDir) args.push("--session-dir", sessionDir);
    else args.push("--no-session");

    this.child = spawn(process.execPath, args, {
      cwd,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: configDir,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.#ingest(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (c) => {
      this.stderr += c;
    });
    this.child.on("exit", () => {
      this.exited = true;
    });
    return this;
  }

  #ingest(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.#handle(msg);
    }
  }

  #handle(msg) {
    this.events.push(msg);
    if (msg.type === "response" && msg.id) this.responses.set(msg.id, msg);
    if (msg.type !== "extension_ui_request") return;

    this.uiRequests.push(msg);
    switch (msg.method) {
      case "setWidget":
        if (msg.widgetLines === undefined) this.widgets.delete(msg.widgetKey);
        else this.widgets.set(msg.widgetKey, msg.widgetLines);
        return;
      case "setStatus":
        if (msg.statusText === undefined) this.statuses.delete(msg.statusKey);
        else this.statuses.set(msg.statusKey, msg.statusText);
        return;
      case "notify":
        this.notifications.push({ message: msg.message, level: msg.notifyType ?? "info" });
        return;
      case "select":
      case "confirm":
      case "input":
      case "editor":
        this.#answerDialog(msg);
        return;
      default:
        return;
    }
  }

  #answerDialog(request) {
    const idx = this.answers.findIndex((a) => a.when(request));
    if (idx === -1) {
      // Nothing queued: cancel, which is what a human walking away does.
      this.send({ type: "extension_ui_response", id: request.id, cancelled: true });
      return;
    }
    const [answer] = this.answers.splice(idx, 1);
    const body = { type: "extension_ui_response", id: request.id };
    if (answer.cancel) body.cancelled = true;
    else if (request.method === "confirm") body.confirmed = answer.value !== false;
    else body.value = typeof answer.value === "function" ? answer.value(request) : answer.value;
    this.send(body);
  }

  /**
   * Queue an answer for the next dialog matching `when`.
   * `value` may be a string, or a function of the request (to pick an option
   * by substring rather than by exact text, which is how a human reads a menu).
   */
  answer(when, value) {
    const predicate = typeof when === "string" ? (r) => JSON.stringify(r).includes(when) : when;
    this.answers.push({ when: predicate, value });
    return this;
  }

  answerCancel(when) {
    const predicate = typeof when === "string" ? (r) => JSON.stringify(r).includes(when) : when;
    this.answers.push({ when: predicate, cancel: true });
    return this;
  }

  send(obj) {
    if (this.exited) return;
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  /** Send a command and wait for its response. */
  async command(obj, timeoutMs = 60_000) {
    const id = `rig-${++this.seq}`;
    this.send({ ...obj, id });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = this.responses.get(id);
      if (r) return r;
      if (this.exited) throw new Error(`pi exited before responding to ${obj.type}\n${this.stderr}`);
      await sleep(20);
    }
    throw new Error(`timed out waiting for response to ${obj.type}`);
  }

  /** Type something, as the human would. Slash commands work too. */
  async prompt(message, opts = {}) {
    return this.command({ type: "prompt", message, ...opts });
  }

  /** Wait until the agent has fully settled after the given event index. */
  async settle(fromIndex = 0, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (let i = fromIndex; i < this.events.length; i += 1) {
        if (this.events[i].type === "agent_settled") return i + 1;
      }
      if (this.exited) throw new Error(`pi exited before settling\n${this.stderr}`);
      await sleep(20);
    }
    throw new Error("timed out waiting for agent_settled");
  }

  /** Wait for an event matching a predicate. */
  async waitFor(predicate, timeoutMs = 60_000, label = "event") {
    const deadline = Date.now() + timeoutMs;
    let seen = 0;
    while (Date.now() < deadline) {
      for (; seen < this.events.length; seen += 1) {
        if (predicate(this.events[seen])) return this.events[seen];
      }
      if (this.exited) throw new Error(`pi exited while waiting for ${label}\n${this.stderr}`);
      await sleep(20);
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  /** Wait for a UI request matching a predicate (widget refresh, notify, …). */
  async waitForUi(predicate, timeoutMs = 30_000, label = "ui request") {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.uiRequests.find(predicate);
      if (hit) return hit;
      if (this.exited) throw new Error(`pi exited while waiting for ${label}\n${this.stderr}`);
      await sleep(20);
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  /** Every user/assistant message pi actually recorded, flattened to text. */
  transcript() {
    const out = [];
    for (const e of this.events) {
      if (e.type !== "message_end" || !e.message) continue;
      const content = Array.isArray(e.message.content)
        ? e.message.content.map((c) => c.text ?? c.content ?? "").join("")
        : String(e.message.content ?? "");
      out.push({ role: e.message.role, text: content });
    }
    return out;
  }

  widget(key = "infinity-harness") {
    return this.widgets.get(key) ?? null;
  }

  notes() {
    return this.notifications.map((n) => n.message).join("\n");
  }

  async stop() {
    if (this.exited) return;
    try {
      this.send({ type: "interrupt" });
      this.child.stdin.end();
    } catch {
      /* already gone */
    }
    const deadline = Date.now() + 5000;
    while (!this.exited && Date.now() < deadline) await sleep(20);
    if (!this.exited) this.child.kill("SIGKILL");
  }
}

/** Start the scripted model server and resolve with { port, stop }. */
export async function startMockModel(scriptPath, logPath) {
  const child = spawn(
    process.execPath,
    [resolve(import.meta.dirname, "mock-model.mjs"), scriptPath, logPath],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.setEncoding("utf8");
  const port = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error("mock model did not start")), 10_000);
    child.stdout.on("data", (d) => {
      const m = /PORT=(\d+)/.exec(d);
      if (m) {
        clearTimeout(timer);
        res(Number(m[1]));
      }
    });
  });
  return {
    port,
    stop: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    },
  };
}
