/**
 * infinity-harness — the background pi worker.
 *
 * The harness used to do all of its work inside the session the human was
 * typing into. That is the wrong shape for this product, for three reasons:
 *
 *   - every token the run spends comes out of the human's own session, on the
 *     human's own model, however carefully the router was configured
 *   - a "session handoff" that replaces the human's session takes their REPL
 *     away from them mid-run
 *   - one model does every task, so the difficulty tiers the wizard collects
 *     have nowhere to be applied
 *
 * A unit of work runs in a *separate pi process* instead: its own session
 * file, its own model, its own context window, started with the brief and
 * nothing else. The main session keeps the widget and the log, and speaks
 * only when the human speaks to it.
 *
 * The child is driven over pi's RPC protocol rather than `--print`, because a
 * unit is not always one turn. With handoff at `feature`, one worker must
 * carry a whole feature across several gate cycles — same session, same
 * model, growing context — and only *then* be replaced. `--print` would end
 * the session after every turn, which is a handoff nobody asked for.
 *
 * This module owns exactly one thing: turning a `WorkerSpec` into a running
 * pi and a stream of events. It has no idea what a phase is.
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

/** Env flag the child sets so the harness extension there does not drive a loop of its own. */
export const WORKER_ENV = "INFINITY_HARNESS_WORKER";
/** Env var naming the unit the child was started for, for the child's own logging. */
export const WORKER_UNIT_ENV = "INFINITY_HARNESS_UNIT";
export const WORKER_RUN_ENV = "INFINITY_HARNESS_RUN";
/** Escape hatch: point at a pi CLI explicitly when discovery cannot find one. */
export const PI_CLI_ENV = "INFINITY_HARNESS_PI_CLI";

export const PROMPT_FILE = "prompt.md";
export const OUTPUT_FILE = "output.log";
export const EVENTS_FILE = "events.jsonl";

/** True when this process *is* a background worker rather than the human's session. */
export function isWorkerProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[WORKER_ENV] === "1";
}

// ── locating pi ─────────────────────────────────────────────────────────────

export type PiCli = {
  /** Executable to spawn. */
  command: string;
  /** Leading arguments before pi's own flags (e.g. the path to cli.js). */
  leading: string[];
  /** Where this came from, for the "could not find pi" message. */
  source: string;
  /**
   * Spawn through a shell.
   *
   * Only ever true for a Windows `.cmd`/`.bat` shim: Node refuses to execute
   * those directly (it has since the 2024 command-injection fix), so the npm
   * `pi.cmd` wrapper cannot be spawned any other way. Every other case runs
   * the executable directly, which is what keeps arguments out of a shell.
   */
  shell?: boolean;
};

/** A Windows batch shim — spawnable only through a shell. */
function isBatchShim(command: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

/**
 * The npm global-bin layout puts `pi.cmd` next to
 * `node_modules/@earendil-works/pi-coding-agent/dist/cli.js`. Finding the real
 * script means we can run it with this very node instead of going through a
 * shell — faster, and with no quoting to get wrong.
 */
function cliBesideShim(shimPath: string): string | null {
  try {
    const cli = join(dirname(shimPath), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
    return existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

/**
 * Find the pi that should run the worker.
 *
 * Order matters, and the first entry is the one that is almost always right:
 * this code is running *inside* pi, so the CLI that started us is by
 * definition a working pi with the user's config, on this machine, at the
 * version they installed. Everything after it is a fallback for tests and for
 * the odd embedding where argv is not what we expect.
 */
export function resolvePiCli(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): PiCli {
  const override = (env[PI_CLI_ENV] ?? "").trim();
  if (override) {
    // "node /path/cli.js" and "/path/to/pi" are both reasonable things to set.
    const parts = override.split(/\s+/).filter(Boolean);
    const [command, ...leading] = parts;
    if (command) return { command, leading, source: PI_CLI_ENV };
  }

  const entry = argv[1] ?? "";
  if (entry && /(^|[\\/])(cli|pi)(\.[cm]?js)?$/i.test(entry) && existsSync(entry)) {
    // A compiled single-file pi has no separate script: argv[1] === execPath.
    if (resolve(entry) === resolve(argv[0] ?? "")) return { command: entry, leading: [], source: "argv" };
    return { command: process.execPath, leading: [entry], source: "argv" };
  }

  try {
    const req = createRequire(import.meta.url);
    const pkg = req.resolve("@earendil-works/pi-coding-agent/package.json");
    const cli = join(dirname(pkg), "dist", "cli.js");
    if (existsSync(cli)) return { command: process.execPath, leading: [cli], source: "node_modules" };
  } catch {
    /* not installed beside us — fall through */
  }

  // Last resort: whatever `pi` means on PATH. On Windows that is a `.cmd`
  // shim, so look for the script it wraps before resorting to a shell.
  if (process.platform === "win32") {
    const found = whichSync("pi");
    const beside = found ? cliBesideShim(found) : null;
    if (beside) return { command: process.execPath, leading: [beside], source: "PATH (script beside shim)" };
    const command = found ?? "pi.cmd";
    return { command, leading: [], source: "PATH", shell: isBatchShim(command) };
  }
  return { command: "pi", leading: [], source: "PATH" };
}

/** Where a command lives, or null. Sync on purpose: it runs once per worker. */
function whichSync(name: string): string | null {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const out = String(execFileSync(cmd, [name], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }));
    const first = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
    return first && existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

// ── the event stream ────────────────────────────────────────────────────────

/**
 * What the supervisor and the widget care about, distilled from pi's RPC
 * stream. The raw stream is far richer; none of the rest belongs on a human's
 * screen while several workers are running.
 */
export type WorkerEvent =
  | { kind: "spawn"; argv: string[] }
  | { kind: "model"; provider: string | null; model: string | null }
  | { kind: "tool"; tool: string; summary: string }
  | { kind: "text"; text: string }
  | { kind: "usage"; inputTokens: number; outputTokens: number }
  | { kind: "compaction" }
  | { kind: "settled" }
  | { kind: "exit"; code: number | null }
  | { kind: "error"; message: string };

export type WorkerUsage = { inputTokens: number; outputTokens: number };

export type TurnResult = {
  /** What the worker said it did, trimmed. */
  summary: string;
  /** Tool calls it made this turn, newest last. */
  tools: string[];
  usage: WorkerUsage;
  /** Fraction of the child's context window in use, or null when pi cannot say. */
  contextRatio: number | null;
  /** True when the worker stopped because it died or was killed, not because it settled. */
  aborted: boolean;
  /** Set when the turn could not run at all. */
  error: string | null;
};

export type WorkerSpec = {
  projectDir: string;
  /** Where prompt.md, output.log and events.jsonl for this worker go. */
  attemptDir: string;
  /** "provider/id", or empty to let the child use pi's configured default. */
  model?: string | null;
  thinking?: string | null;
  /** Session files go here so a human can `/resume` any worker afterwards. */
  sessionDir?: string | null;
  sessionName?: string | null;
  unitKey?: string | null;
  runId?: string | null;
  /** Cap on one prompt→settled cycle. */
  turnTimeoutMs?: number;
  /** Extra argv for the child. Tests use it; nothing else should need to. */
  extraArgs?: string[];
  /**
   * Load the harness extension explicitly.
   *
   * Normally the child discovers it exactly as the parent did — the harness
   * is an installed pi package — and the worker gets `infinity_task_list` and
   * friends for free. When the parent was started with `-e <path>` (a dev
   * checkout, and every e2e run) discovery finds nothing, and a worker with
   * no plan tools cannot record the work it just did. `harnessExtension` is
   * the path to fall back to; `probeCommands` decides whether it is needed.
   */
  harnessExtension?: string | null;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests: anything with the shape of node:child_process.spawn. */
  spawnFn?: typeof spawn;
};

const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;
const KILL_GRACE_MS = 5000;
const OUTPUT_TAIL_BYTES = 40000;
const START_TIMEOUT_MS = 60_000;

/**
 * A model reference reaches the command line, so anything outside the
 * characters a real reference uses is refused rather than escaped. The value
 * comes from a config file a human edits; a typo must not become an argument
 * injection. Nothing is passed through a shell here, but a leading `-` would
 * still be read as a flag.
 */
const MODEL_REF_RE = /^[A-Za-z0-9._:@/-]{1,160}$/;

export function safeModelRef(model: string | null | undefined): string | null {
  const v = (model ?? "").trim();
  if (!v || v.startsWith("-")) return null;
  return MODEL_REF_RE.test(v) ? v : null;
}

const THINKING_RE = /^(off|minimal|low|medium|high|xhigh|max)$/;

export function safeThinking(level: string | null | undefined): string | null {
  const v = (level ?? "").trim();
  return v && THINKING_RE.test(v) ? v : null;
}

/** Compact one-liner for a tool call: `edit src/loop.ts`, `bash npm test`. */
export function describeToolCall(tool: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = a[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };
  const detail =
    pick("path", "file", "filePath", "file_path") ||
    pick("command", "cmd", "script") ||
    pick("pattern", "query", "regex") ||
    pick("task", "name", "title", "url");
  const oneLine = detail.replace(/\s+/g, " ").trim();
  const clipped = oneLine.length > 68 ? oneLine.slice(0, 67) + "…" : oneLine;
  return clipped ? `${tool} ${clipped}` : tool;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: string };
    if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("").trim();
}

/**
 * Turn one RPC line into an event, or null.
 *
 * Unknown event types are dropped rather than surfaced: pi adds them over
 * time, and a harness that shows every one of them is a harness whose log is
 * unreadable on the day pi ships a new event.
 */
export function parseEventLine(line: string): WorkerEvent | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== "{") return null;
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (typeof ev.type === "string" ? ev.type : "") {
    case "message_start": {
      const msg = ev.message as { role?: string; provider?: string; model?: string } | undefined;
      if (!msg || msg.role !== "assistant" || !msg.model) return null;
      // Proof of which model actually served the turn. A routed reference that
      // silently fell back to pi's default is otherwise invisible.
      return { kind: "model", provider: msg.provider ?? null, model: msg.model };
    }
    case "tool_execution_start":
      return {
        kind: "tool",
        tool: String(ev.toolName ?? "tool"),
        summary: describeToolCall(String(ev.toolName ?? "tool"), ev.args),
      };
    case "message_end": {
      const msg = ev.message as { role?: string; content?: unknown } | undefined;
      if (!msg || msg.role !== "assistant") return null;
      const text = textOf(msg.content);
      return text ? { kind: "text", text } : null;
    }
    case "message_update": {
      const usage = ev.usage as Record<string, unknown> | undefined;
      if (!usage) return null;
      const inputTokens = num(usage.inputTokens ?? usage.input);
      const outputTokens = num(usage.outputTokens ?? usage.output);
      if (!inputTokens && !outputTokens) return null;
      return { kind: "usage", inputTokens, outputTokens };
    }
    case "compaction_end":
      return { kind: "compaction" };
    case "agent_settled":
      return { kind: "settled" };
    case "error":
      return { kind: "error", message: String((ev as { message?: unknown }).message ?? "error") };
    default:
      return null;
  }
}

// ── argv ────────────────────────────────────────────────────────────────────

export function buildWorkerArgs(spec: WorkerSpec): string[] {
  const args: string[] = ["--mode", "rpc", "--approve"];
  const model = safeModelRef(spec.model);
  if (model) args.push("--model", model);
  const thinking = safeThinking(spec.thinking);
  if (thinking) args.push("--thinking", thinking);
  if (spec.sessionDir) args.push("--session-dir", spec.sessionDir);
  else args.push("--no-session");
  if (spec.sessionName) args.push("--name", spec.sessionName);
  if (spec.harnessExtension) args.push("--no-extensions", "--extension", spec.harnessExtension);
  if (spec.extraArgs?.length) args.push(...spec.extraArgs);
  return args;
}

/**
 * The one line of prompt that is not the brief.
 *
 * Sent with every unit so a worker that has been running for an hour still
 * knows there is nobody to ask.
 */
export const WORKER_DIRECTIVE =
  "Work autonomously — there is no human in this session, so never ask a question or wait " +
  "for confirmation. Carry out the brief above until the work it names is done or genuinely " +
  "blocked, then stop and state in one short paragraph what you changed and what remains.";

// ── the worker session ──────────────────────────────────────────────────────

/**
 * One background pi session, alive across several prompts.
 *
 * Alive matters. The unit of *model choice* is the unit of *session*, so a
 * worker that owns a feature keeps its context across the three or four gate
 * cycles that feature takes, exactly as a human's session would — and is torn
 * down, not compacted into uselessness, when the run moves to the next one.
 */
export class WorkerSession {
  readonly spec: WorkerSpec;
  readonly argv: string[];
  private child: ChildProcess | null = null;
  private buffer = "";
  private output = "";
  private seq = 0;
  private pending = new Map<string, (msg: Record<string, unknown>) => void>();
  private listeners = new Set<(e: WorkerEvent) => void>();
  private settledWaiters: Array<() => void> = [];
  private exitWaiters: Array<(code: number | null) => void> = [];
  private eventsPath: string;

  /** What actually served the last turn, as `provider/id`. */
  servedModel: string | null = null;
  sessionId: string | null = null;
  usage: WorkerUsage = { inputTokens: 0, outputTokens: 0 };
  exited = false;
  exitCode: number | null = null;
  startError: string | null = null;
  /** Tool calls seen since the last `takeTools()`. */
  private tools: string[] = [];
  private lastText = "";

  constructor(spec: WorkerSpec) {
    this.spec = spec;
    mkdirSync(spec.attemptDir, { recursive: true });
    this.eventsPath = join(spec.attemptDir, EVENTS_FILE);
    const cli = resolvePiCli(spec.env ?? process.env);
    this.argv = [cli.command, ...cli.leading, ...buildWorkerArgs(spec)];
  }

  on(listener: (e: WorkerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: WorkerEvent): void {
    try {
      appendFileSync(this.eventsPath, JSON.stringify({ at: new Date().toISOString(), ...e }) + "\n", "utf-8");
    } catch {
      /* the log is a convenience, never a reason to fail a run */
    }
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* a broken listener must not kill the worker */
      }
    }
  }

  start(): void {
    const cli = resolvePiCli(this.spec.env ?? process.env);
    const args = [...cli.leading, ...buildWorkerArgs(this.spec)];
    const env: NodeJS.ProcessEnv = {
      ...(this.spec.env ?? process.env),
      [WORKER_ENV]: "1",
      ...(this.spec.unitKey ? { [WORKER_UNIT_ENV]: this.spec.unitKey } : {}),
      ...(this.spec.runId ? { [WORKER_RUN_ENV]: this.spec.runId } : {}),
      // A worker's terminal is a pipe. Colour codes in the log help nobody.
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    };
    const spawnImpl = this.spec.spawnFn ?? spawn;
    try {
      this.child = spawnImpl(cli.command, args, {
        cwd: this.spec.projectDir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        ...(cli.shell ? { shell: true } : {}),
      });
    } catch (e) {
      this.startError = `could not start pi (${cli.source}) — ${e instanceof Error ? e.message : String(e)}`;
      this.exited = true;
      this.emit({ kind: "error", message: this.startError });
      return;
    }
    this.emit({ kind: "spawn", argv: this.argv });

    // A worker that exits while we are writing to it turns the next write
    // into an asynchronous EPIPE on the socket. With no listener, Node throws
    // it as an unhandled 'error' — inside the human's pi process, which is how
    // a dead child would take down the terminal it was supposed to serve.
    this.child.stdin?.on("error", (e: Error) => {
      this.emit({ kind: "error", message: `worker stdin: ${e.message}` });
    });
    this.child.stdout?.on("error", () => {});
    this.child.stderr?.on("error", () => {});
    this.child.stdout?.setEncoding("utf-8");
    this.child.stderr?.setEncoding("utf-8");
    this.child.stdout?.on("data", (c: string) => this.ingest(c));
    this.child.stderr?.on("data", (c: string) => {
      this.output = (this.output + c).slice(-OUTPUT_TAIL_BYTES);
    });
    this.child.on("error", (e: Error) => {
      this.startError = e.message;
      this.emit({ kind: "error", message: e.message });
      this.finish(-1);
    });
    this.child.on("close", (code: number | null) => this.finish(code));
  }

  private finish(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    try {
      writeFileSync(join(this.spec.attemptDir, OUTPUT_FILE), this.output, "utf-8");
    } catch {
      /* best effort */
    }
    this.emit({ kind: "exit", code });
    // Anything waiting on this child must be released, or the supervisor
    // parks forever on a process that is already gone. This is the failure
    // mode that turns "the run stopped" into "the run hung".
    for (const w of this.settledWaiters.splice(0)) w();
    for (const w of this.exitWaiters.splice(0)) w(code);
    for (const [, resolveP] of this.pending) resolveP({ success: false, error: "worker exited" });
    this.pending.clear();
  }

  private ingest(chunk: string): void {
    this.output = (this.output + chunk).slice(-OUTPUT_TAIL_BYTES);
    this.buffer += chunk;
    // RPC is strict JSONL on LF. Node's readline also splits U+2028/U+2029,
    // which are legal inside a JSON string, so it cannot be used here.
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (msg.type === "response" && typeof msg.id === "string") {
        const waiter = this.pending.get(msg.id);
        if (waiter) {
          this.pending.delete(msg.id);
          waiter(msg);
        }
        continue;
      }
      const ev = parseEventLine(line);
      if (!ev) continue;
      if (ev.kind === "model") this.servedModel = ev.provider ? `${ev.provider}/${ev.model}` : ev.model;
      else if (ev.kind === "tool") this.tools.push(ev.summary);
      else if (ev.kind === "text") this.lastText = ev.text;
      else if (ev.kind === "usage") {
        // pi reports cumulative usage; the last word wins rather than the sum.
        this.usage.inputTokens = Math.max(this.usage.inputTokens, ev.inputTokens);
        this.usage.outputTokens = Math.max(this.usage.outputTokens, ev.outputTokens);
      }
      this.emit(ev);
      if (ev.kind === "settled") for (const w of this.settledWaiters.splice(0)) w();
    }
  }

  private send(command: Record<string, unknown>, timeoutMs = 20_000): Promise<Record<string, unknown>> {
    if (!this.child?.stdin || this.exited) return Promise.resolve({ success: false, error: "worker not running" });
    const id = `ih-${++this.seq}`;
    return new Promise((resolveP) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolveP({ success: false, error: "timeout" });
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolveP(msg);
      });
      try {
        this.child?.stdin?.write(JSON.stringify({ id, ...command }) + "\n");
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolveP({ success: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  }

  /**
   * Does this child have the harness's own commands?
   *
   * A worker without them can edit code but cannot tell the harness what it
   * did, so the gate never sees the work and the run loops forever on a task
   * that is actually finished. Cheap to ask, and the answer decides whether
   * the session has to be restarted with an explicit `-e`.
   */
  async hasHarnessTools(): Promise<boolean> {
    const res = await this.send({ type: "get_commands" });
    if (res.success !== true) return true; // cannot tell — assume the normal case
    const data = res.data as { commands?: Array<{ name?: string }> } | undefined;
    const names = (data?.commands ?? []).map((c) => String(c.name ?? ""));
    return names.some((n) => n.startsWith("infinity:"));
  }

  /** Wait until the child has answered anything at all, so a dead pi fails fast. */
  async ready(timeoutMs = START_TIMEOUT_MS): Promise<boolean> {
    if (this.startError) return false;
    const res = await this.send({ type: "get_session_stats" }, timeoutMs);
    if (res.success === true) {
      const data = res.data as { sessionId?: string } | undefined;
      if (data?.sessionId) this.sessionId = data.sessionId;
      return true;
    }
    return false;
  }

  /** Context pressure inside the worker, 0..1, or null when pi cannot say. */
  async contextRatio(): Promise<number | null> {
    const res = await this.send({ type: "get_session_stats" });
    if (res.success !== true) return null;
    const data = res.data as { contextUsage?: { percent?: number | null }; sessionId?: string } | undefined;
    if (data?.sessionId) this.sessionId = data.sessionId;
    const pct = data?.contextUsage?.percent;
    if (typeof pct !== "number") return null;
    return pct > 1 ? pct / 100 : pct;
  }

  /** Send one prompt and wait for the session to settle. Never throws. */
  async prompt(text: string, timeoutMs = this.spec.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS): Promise<TurnResult> {
    this.tools = [];
    this.lastText = "";
    if (this.exited) {
      return { summary: "", tools: [], usage: { ...this.usage }, contextRatio: null, aborted: true, error: this.startError ?? "worker exited" };
    }
    try {
      writeFileSync(join(this.spec.attemptDir, PROMPT_FILE), text, "utf-8");
    } catch {
      /* the transcript is a convenience */
    }
    let releaseSettled: () => void = () => {};
    const settled = new Promise<void>((resolveP) => {
      releaseSettled = resolveP;
      this.settledWaiters.push(resolveP);
    });
    const res = await this.send({ type: "prompt", message: text });
    if (res.success !== true) {
      // Drop the waiter we just queued, or it leaks for the life of the run.
      const i = this.settledWaiters.indexOf(releaseSettled);
      if (i >= 0) this.settledWaiters.splice(i, 1);
      return {
        summary: "",
        tools: [],
        usage: { ...this.usage },
        contextRatio: null,
        aborted: this.exited,
        error: String(res.error ?? "prompt rejected"),
      };
    }
    let timedOut = false;
    await Promise.race([
      settled,
      new Promise<void>((resolveP) => {
        const t = setTimeout(() => {
          timedOut = true;
          resolveP();
        }, timeoutMs);
        t.unref?.();
      }),
    ]);
    if (timedOut) {
      // A turn that will not settle is a wedged worker. Abort the turn, and
      // let the supervisor decide whether to keep the session.
      await this.send({ type: "abort" }, 5000);
    }
    return {
      summary: this.lastText,
      tools: [...this.tools],
      usage: { ...this.usage },
      contextRatio: await this.contextRatio(),
      aborted: timedOut || this.exited,
      error: timedOut ? "turn timed out" : null,
    };
  }

  /** Stop the child. Resolves once it is actually gone. */
  async close(): Promise<void> {
    if (this.exited || !this.child) {
      this.exited = true;
      return;
    }
    const gone = new Promise<void>((resolveP) => this.exitWaiters.push(() => resolveP()));
    try {
      this.child.stdin?.end();
    } catch {
      /* already closed */
    }
    try {
      this.child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    const killer = setTimeout(() => {
      try {
        this.child?.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, KILL_GRACE_MS);
    killer.unref?.();
    await Promise.race([
      gone,
      new Promise<void>((resolveP) => {
        const t = setTimeout(resolveP, KILL_GRACE_MS * 2);
        t.unref?.();
      }),
    ]);
    clearTimeout(killer);
    this.exited = true;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get tail(): string {
    return this.output;
  }
}

/** Start a worker and wait for it to answer, or return null with the reason on the session. */
export async function startWorkerSession(spec: WorkerSpec): Promise<WorkerSession> {
  const session = new WorkerSession(spec);
  session.start();
  await session.ready();
  return session;
}

/** Where a worker's session files live, so `/resume` can reach them. */
export function workerSessionDir(projectDir: string): string {
  return resolve(projectDir, "tmp", "infinity-harness", "sessions");
}
