/**
 * infinity-harness — daemon/isolation.ts
 *
 * Worker isolation: a worker session must not load the harness extension into
 * the Daemon's process, and must receive the harness tools as customTools.
 *
 * The SDK loads discovered extensions by default (DefaultResourceLoader with
 * reload()). infinity-harness IS an installed pi extension, so a default
 * loader would load it inside the Daemon and each worker would register
 * session_start, commands and widgets — sharing module state and driving runs.
 *
 * This module produces:
 *  - a harness-free ResourceLoader (noExtensions, noSkills where appropriate)
 *  - the harness ToolDefinitions to hand to workers as customTools
 *  - a helper to assert isolation in tests
 */

import type { ResourceLoader, ToolDefinition } from "@earendil-works/pi-coding-agent";

export type IsolationOpts = {
  cwd: string;
  agentDir?: string;
};

export type HarnessedLoader = ResourceLoader;

/**
 * Build a ResourceLoader that WILL NOT discover the harness extension.
 * Workers receive this as `resourceLoader`.
 */
export async function createIsolatedLoader(opts: IsolationOpts): Promise<HarnessedLoader> {
  const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const settingsManager = SettingsManager.create(opts.cwd, opts.agentDir);
  const loader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: opts.agentDir ?? "",
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
  } as unknown as ConstructorParameters<typeof DefaultResourceLoader>[0]);
  await loader.reload();
  return loader as HarnessedLoader;
}

/**
 * Minimal harness tools that a worker needs to function.
 * Daemon hands these as `customTools` so the worker's ability to record work
 * is declared, not discovered. A worker that cannot record is a worker whose
 * unit loops forever.
 */
export function harnessToolsForWorker(): ToolDefinition[] {
  return [
    {
      name: "infinity_plan",
      description: "Atomic plan editor: submit the full task list. Omission=deletion, baseRevision guard, cycle/missingDep checks.",
      parameters: {
        type: "object",
        properties: {
          baseRevision: { type: "number" },
          tasks: { type: "array", items: { type: "object" } },
          features: { type: "array", items: { type: "object" } },
          goal: { type: "string" },
        },
      },
      handler: async () => ({ content: [{ type: "text", text: "infinity_plan stub — Daemon replaces this handler" }] }),
    } as unknown as ToolDefinition,
    {
      name: "infinity_validate",
      description: "Run the deterministic gate; model never decides PASS/FAIL.",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ content: [{ type: "text", text: "infinity_validate stub" }] }),
    } as unknown as ToolDefinition,
    {
      name: "infinity_brief",
      description: "Return the rendered brief for the next unit.",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ content: [{ type: "text", text: "infinity_brief stub" }] }),
    } as unknown as ToolDefinition,
  ];
}

/**
 * Test assertion: a worker session's loader has zero harness extension instances.
 * The session's extensionsResult captures what was loaded; we count any factory
 * whose id contains "infinity-harness".
 */
export function assertZeroHarnessExtensions(extensionsResult: unknown): void {
  const result = extensionsResult as { extensions?: Array<{ id?: string; name?: string }> } | null | undefined;
  const list = result?.extensions ?? [];
  const found = list.filter((e) => String(e?.id ?? e?.name ?? "").includes("infinity-harness"));
  if (found.length !== 0) {
    throw new Error(`isolation violated: worker loaded ${found.length} harness extension(s): ${found.map(f => f.id ?? f.name).join(", ")}`);
  }
}
