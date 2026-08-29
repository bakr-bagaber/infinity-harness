/**
 * infinity-harness — daemon/worker.ts
 *
 * One AgentSession: create → prompt → settle → dispose, plus the
 * events->TurnResult adapter. prompt() returns void in the SDK, so every
 * turn field (servedModel, usage, tools, summary, contextRatio, compacted)
 * comes via subscribe().
 *
 * v2.7's WorkerSession.prompt returned TurnResult; the SDK's prompt returns void.
 * This file rebuilds the same shape by accumulating events.
 */

// Usage type is from pi session — use a loose shape to avoid hard dep on pi-ai path
type Usage = { input?: number; output?: number; inputTokens?: number; outputTokens?: number; cacheRead?: number; cacheWrite?: number; cost?: number };

export type TurnResult = {
  summary: string;
  tools: Array<{ name: string; ok: boolean }>;
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost?: number };
  contextRatio: number | null;
  servedModel: string | null;
  askedModel: string;
  compacted: boolean;
  aborted: boolean;
  error: string | null;
  modelFallbackMessage?: string | null;
};

export type WorkerEvents = {
  onMessageStart?: (ev: unknown) => void;
  onMessageUpdate?: (ev: unknown) => void;
  onMessageEnd?: (ev: unknown) => void;
  onToolStart?: (ev: unknown) => void;
  onToolEnd?: (ev: unknown) => void;
  onCompactionStart?: (ev: unknown) => void;
};

export type CreateWorkerOpts = {
  cwd: string;
  agentDir?: string;
  modelSpec: { provider: string; id: string; thinkingLevel?: string };
  askedModel: string;
  sessionManagerDir?: string;
  customTools?: unknown[];
  thinkingLevel?: string;
  resourceLoader?: unknown;
  runId?: string;
  unitKey?: string;
  isolationBypassForTest?: boolean;
};

export type PromptOpts = {
  text: string;
  timeoutMs?: number;
};

/**
 * Create one SDK AgentSession with harness-free loader + customTools.
 * Returns session + unsubscribe + dispose handles.
 */
export async function createWorker(opts: CreateWorkerOpts): Promise<{
  session: unknown;
  unsubscribe: () => void;
  dispose: () => void;
  modelFallbackMessage?: string | null;
  events: { servedModel: string | null; usage: Usage | null; tools: TurnResult["tools"]; summary: string; compacted: boolean };
}> {
  const mod = await import("@earendil-works/pi-coding-agent");
  const { createAgentSession, ModelRuntime, SessionManager, DefaultResourceLoader, SettingsManager } = mod as unknown as {
    createAgentSession: (opts: unknown) => Promise<{ session: unknown; modelFallbackMessage?: string | null; extensionsResult?: unknown }>;
    ModelRuntime: { create: () => Promise<{ getModel: (p: string, id: string) => unknown; hasConfiguredAuth: (p: string) => boolean; checkAuth: (p: string) => Promise<unknown> }> };
    SessionManager: { create: (cwd: string, dir?: string) => unknown; inMemory: (cwd: string) => unknown };
    DefaultResourceLoader: new (opts: unknown) => { reload: () => Promise<void> };
    SettingsManager: { create: (cwd: string, agentDir?: string) => unknown };
  };

  const runtime = await ModelRuntime.create();
  const model = runtime.getModel(opts.modelSpec.provider, opts.modelSpec.id);
  if (!model) throw new Error(`unknown model ${opts.modelSpec.provider}/${opts.modelSpec.id}`);

  let loader: unknown = opts.resourceLoader;
  if (!loader && !opts.isolationBypassForTest) {
    const sm = SettingsManager.create(opts.cwd, opts.agentDir);
    const l = new DefaultResourceLoader({
      cwd: opts.cwd,
      agentDir: opts.agentDir ?? "",
      settingsManager: sm,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    } as unknown as ConstructorParameters<typeof DefaultResourceLoader>[0]);
    await l.reload();
    loader = l;
  }

  // Verify isolation: if loader discovery includes harness, fail fast (unless bypassed for test).
  if (!opts.isolationBypassForTest && loader && typeof (loader as { getExtensions?: () => unknown }).getExtensions === "function") {
    try {
      const ext = (loader as { getExtensions: () => { extensions?: Array<{ id?: string }> } }).getExtensions();
      const found = (ext?.extensions ?? []).filter(e => String(e?.id ?? "").includes("infinity-harness"));
      if (found.length) throw new Error(`isolation violated: loader has ${found.length} harness extension(s)`);
    } catch (e) {
      if (e instanceof Error && e.message.includes("isolation violated")) throw e;
    }
  }

  const sessionManager = opts.sessionManagerDir
    ? SessionManager.create(opts.cwd, opts.sessionManagerDir)
    : SessionManager.inMemory(opts.cwd);

  const thinkingLevel = (opts.thinkingLevel ?? opts.modelSpec.thinkingLevel ?? "medium") as unknown as string;

  const agentTools = opts.customTools as unknown as import("@earendil-works/pi-coding-agent").ToolDefinition[] | undefined;

  const created = await createAgentSession({
    model: model as never,
    modelRuntime: runtime as never,
    cwd: opts.cwd,
    thinkingLevel: thinkingLevel as never,
    resourceLoader: loader as never,
    customTools: agentTools as never,
    sessionManager: sessionManager as never,
  } as never);

  const session = created.session as {
    subscribe: (fn: (ev: { type: string; [k: string]: unknown }) => void) => () => void;
    prompt: (text: string, opts?: unknown) => Promise<void>;
    steer: (text: string) => Promise<void>;
    dispose: () => void;
    abort?: () => void;
    model?: { provider?: string; id?: string };
  };

  if (created.modelFallbackMessage) throw new Error(`modelFallbackMessage: ${created.modelFallbackMessage}`);

  const state = { servedModel: null as string | null, usage: null as Usage | null, tools: [] as TurnResult["tools"], summary: "", compacted: false };

  const unsubscribe = session.subscribe((ev: { type: string; [k: string]: unknown }) => {
    if (ev.type === "message_start") {
      // message_start carries provider/model in some SDK versions
      const prov = (ev as { provider?: string }).provider ?? (ev as { model?: { provider?: string } }).model?.provider;
      const mid = (ev as { modelId?: string }).modelId ?? (ev as { model?: { id?: string } }).model?.id;
      if (prov || mid) state.servedModel = `${prov ?? "?"}:${mid ?? "?"}`;
    } else if (ev.type === "message_end") {
      // usage is cumulative per session
      const usage = (ev as { usage?: Usage }).usage;
      if (usage) state.usage = usage as Usage;
      const text = (ev as { content?: unknown }).content ?? (ev as { text?: string }).text;
      if (typeof text === "string" && text) state.summary = text;
      else if (Array.isArray((ev as { content?: unknown }).content)) {
        const c = (ev as { content?: unknown }).content as Array<{ type?: string; text?: string }>;
        const t = c.filter(x => x?.type === "text").map(x => x.text ?? "").join("\n");
        if (t) state.summary = t;
      }
    } else if (ev.type === "tool_execution_start" || ev.type === "tool_execution_end") {
      const name = String((ev as { toolName?: string }).toolName ?? (ev as { name?: string }).name ?? "tool");
      const ok = ev.type === "tool_execution_end" ? ((ev as { ok?: boolean }).ok ?? true) : true;
      // dedupe: keep last ok per name per end event
      if (ev.type === "tool_execution_end") state.tools.push({ name, ok: Boolean(ok) });
      else if (ev.type === "tool_execution_start") state.tools.push({ name, ok: true });
    } else if (ev.type === "compaction_start") {
      state.compacted = true;
    } else if (ev.type === "entry_appended") {
      // session entries include model_change and compaction; capture compaction usage
      const entry = (ev as { entry?: { type?: string; usage?: Usage } }).entry;
      if (entry?.type === "compaction" && entry.usage) state.compacted = true;
    }
  });

  return {
    session,
    unsubscribe,
    dispose: () => { try { unsubscribe(); } catch {} try { session.dispose(); } catch {} },
    modelFallbackMessage: created.modelFallbackMessage ?? null,
    events: state,
  };
}

export async function promptWorker(
  worker: { session: { prompt: (t: string, o?: unknown) => Promise<void> }; events: { servedModel: string | null; usage: Usage | null; tools: TurnResult["tools"]; summary: string; compacted: boolean } },
  opts: PromptOpts,
): Promise<TurnResult> {
  // We need the askedModel — fall back to events.servedModel if not known.
  const askedModel = "asked";
  const startedUsage = worker.events.usage;
  try {
    const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
    let settled = false;
    const timer = timeoutMs > 0 ? setTimeout(() => { if (!settled) try { (worker.session as { abort?: () => void }).abort?.(); } catch {} }, timeoutMs) : null;
    try {
      await worker.session.prompt(opts.text);
      settled = true;
    } finally {
      if (timer) clearTimeout(timer);
      settled = true;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // CredentialSynchronizationError is handled by caller; bubble it.
    if (msg.includes("CredentialSynchronizationError") || (e as { name?: string })?.name === "CredentialSynchronizationError") throw e;
    return {
      summary: worker.events.summary,
      tools: worker.events.tools,
      usage: toUsageTotals(worker.events.usage, startedUsage),
      contextRatio: null,
      servedModel: worker.events.servedModel,
      askedModel,
      compacted: worker.events.compacted,
      aborted: msg.toLowerCase().includes("abort"),
      error: msg,
    };
  }
  return {
    summary: worker.events.summary,
    tools: worker.events.tools,
    usage: toUsageTotals(worker.events.usage, startedUsage),
    contextRatio: null,
    servedModel: worker.events.servedModel,
    askedModel,
    compacted: worker.events.compacted,
    aborted: false,
    error: null,
  };
}

function toUsageTotals(cur: Usage | null, _prev: Usage | null): { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost?: number } {
  if (!cur) return { input: 0, output: 0 };
  // pi usage is cumulative per session; the last reading IS the total.
  const input = typeof (cur as { input?: number }).input === "number" ? (cur as { input: number }).input
    : typeof (cur as { inputTokens?: number }).inputTokens === "number" ? (cur as unknown as { inputTokens: number }).inputTokens : 0;
  const output = typeof (cur as { output?: number }).output === "number" ? (cur as { output: number }).output
    : typeof (cur as { outputTokens?: number }).outputTokens === "number" ? (cur as unknown as { outputTokens: number }).outputTokens : 0;
  const cacheRead = (cur as { cacheRead?: number }).cacheRead ?? 0;
  const cacheWrite = (cur as { cacheWrite?: number }).cacheWrite ?? 0;
  const cost = (cur as { cost?: number }).cost ?? 0;
  return { input, output, cacheRead, cacheWrite, cost };
}
