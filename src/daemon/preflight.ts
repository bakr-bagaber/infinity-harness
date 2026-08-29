/**
 * infinity-harness — daemon/preflight.ts
 *
 * Tier preflight: at arm time, prove each configured tier A/B/C/D/X can serve.
 * getModel() and getAvailable() are registry checks, not auth checks. Only a
 * real call proves a tier serves. A tier that fails preflight blocks arming
 * (naming the tier and reason) — not a warning buried in a log.
 *
 * Distinct tiers are probed once. Probe uses SessionManager.inMemory() + a
 * one-token prompt on a throwaway session with noTools.
 */

import type { TierId, TierSpec, HarnessConfig } from "../core/types.ts";
import type { TierResults, TierPreflight } from "../core/runState.ts";
import { loadConfig } from "../core/config.ts";

export type PreflightResult = { tier: TierId; ok: boolean; servedModel?: string; reason?: string };

export type PreflightOpts = {
  targetDir: string;
  tiers?: Partial<Record<TierId, TierSpec>>;
  /** For tests: inject a probe fn instead of doing the real SDK call. */
  probe?: (spec: TierSpec) => Promise<{ served: string }>;
};

function tiersFromConfig(config: HarnessConfig): Partial<Record<TierId, TierSpec>> {
  const t = (config as unknown as { tiers?: Partial<Record<TierId, TierSpec>> }).tiers;
  return t && typeof t === "object" && !Array.isArray(t) ? t : {};
}

function dedupeSpecs(tiers: Partial<Record<TierId, TierSpec>>): Map<string, { tiers: TierId[]; spec: TierSpec }> {
  const byKey = new Map<string, { tiers: TierId[]; spec: TierSpec }>();
  for (const [tier, spec] of Object.entries(tiers) as Array<[TierId, TierSpec]>) {
    if (!spec?.provider || !spec?.id) continue;
    const key = `${spec.provider}/${spec.id}`;
    const entry = byKey.get(key);
    if (entry) entry.tiers.push(tier);
    else byKey.set(key, { tiers: [tier], spec });
  }
  return byKey;
}

export async function runPreflight(opts: PreflightOpts): Promise<{ results: PreflightResult[]; tierResults: TierResults; blocked: PreflightResult | null }> {
  const configTiers = opts.tiers ?? tiersFromConfig(loadConfig(opts.targetDir).config);
  const unique = dedupeSpecs(configTiers);
  const results: PreflightResult[] = [];
  const tierResults: TierResults = {};

  if (unique.size === 0) {
    return { results: [], tierResults: {}, blocked: null };
  }

  for (const [key, entry] of unique) {
    let ok = false;
    let servedModel: string | undefined;
    let reason: string | undefined;
    try {
      if (opts.probe) {
        const r = await opts.probe(entry.spec);
        servedModel = r.served || key;
        ok = true;
      } else {
        // Real probe (SDK).
        const { ModelRuntime, SessionManager, createAgentSession, DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
        const runtime = await ModelRuntime.create();
        // getModel is a registry lookup; hasConfiguredAuth guards the credential existence.
        const model = runtime.getModel(entry.spec.provider, entry.spec.id);
        if (!model) throw new Error(`unknown model ${key}`);
        const hasAuth = typeof runtime.hasConfiguredAuth === "function" ? runtime.hasConfiguredAuth(entry.spec.provider) : true;
        if (!hasAuth) {
          let check: unknown = undefined;
          try { check = typeof runtime.checkAuth === "function" ? await runtime.checkAuth(entry.spec.provider) : hasAuth; } catch { check = undefined; }
          if (!check) throw new Error(`no credential for provider ${entry.spec.provider}`);
        }
        // Minimal prompt on an in-memory session.
        const { resolve } = await import("node:path");
        const cwd = opts.targetDir;
        const agentDir = "";
        const settingsManager = SettingsManager.create(cwd, agentDir);
        const loader = new DefaultResourceLoader({
          cwd,
          agentDir,
          settingsManager,
          noExtensions: true,
          noSkills: true,
          noContextFiles: true,
        } as unknown as ConstructorParameters<typeof DefaultResourceLoader>[0]);
        await loader.reload();
        const { session } = await createAgentSession({
          model,
          modelRuntime: runtime,
          cwd,
          resourceLoader: loader,
          sessionManager: SessionManager.inMemory(cwd),
          noTools: "all" as unknown as string,
          thinkingLevel: "minimal" as unknown as string,
        } as unknown as Parameters<typeof createAgentSession>[0]);
        try {
          // One-token probe — the only thing that proves the tier serves.
          await session.prompt("Reply with the single word: ok");
          servedModel = `${(session as { model?: { provider?: string; id?: string } }).model?.provider ?? entry.spec.provider}/${(session as { model?: { id?: string } }).model?.id ?? entry.spec.id}`;
          ok = true;
        } finally {
          try { (session as { dispose?: () => void }).dispose?.(); } catch {}
        }
      }
    } catch (e) {
      ok = false;
      reason = e instanceof Error ? e.message : String(e);
      servedModel = undefined;
    }
    for (const tier of entry.tiers) {
      const res: PreflightResult = { tier, ok, ...(servedModel ? { servedModel } : {}), ...(reason ? { reason } : {}) };
      results.push(res);
      tierResults[tier] = {
        provider: entry.spec.provider,
        id: entry.spec.id,
        preflight: ok ? "ok" : "fail",
        ...(servedModel ? { servedModel } : {}),
        ...(reason ? { reason } : {}),
      } as TierPreflight;
    }
  }

  const blocked = results.find(r => !r.ok) ?? null;
  return { results, tierResults, blocked };
}

export function formatPreflightResults(results: PreflightResult[]): string {
  if (!results.length) return "no tiers configured";
  return results.map(r => `${r.tier}:${r.ok ? "ok" : `fail(${r.reason ?? "unknown"})`}${r.servedModel ? `:${r.servedModel}` : ""}`).join(" | ");
}
