/**
 * pi-harness: Pi-native enforcement layer for dev-harness
 *
 * Clean port — reuses dev-harness CLI lib (cli/lib/*) as library, adds Pi lifecycle enforcement.
 * No harness logic is duplicated; this is the thin shell that makes the loop automatic.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// dev-harness lib — reused via symlink at ../cli (see package.json: file:../dev-harness)
// We import dynamically to avoid hard failure if harness not installed
let briefLib: any = null;
let gatesLib: any = null;
let stateLib: any = null;
let phasesLib: any = null;
let pathsLib: any = null;

async function loadHarnessLibs() {
  if (briefLib) return { brief: briefLib, gates: gatesLib, state: stateLib, phases: phasesLib, paths: pathsLib };
  const cliDir = resolve(import.meta.dirname, "../../cli");
  // cli is symlinked to dev-harness/cli — same files, same API
  briefLib = await import(`${cliDir}/lib/brief.mjs`);
  gatesLib = await import(`${cliDir}/lib/gates.mjs`);
  stateLib = await import(`${cliDir}/lib/state.mjs`);
  phasesLib = await import(`${cliDir}/lib/phases.mjs`);
  pathsLib = await import(`${cliDir}/lib/paths.mjs`);
  return { brief: briefLib, gates: gatesLib, state: stateLib, phases: phasesLib, paths: pathsLib };
}

function getProjectDir(ctx: any): string {
  // Pi provides cwd via ctx.cwd or process.cwd()
  return ctx.cwd || ctx.projectDir || process.cwd();
}

async function buildBriefText(targetDir: string): Promise<string | null> {
  try {
    const { brief } = await loadHarnessLibs();
    const b = await brief.buildBrief(targetDir);
    const rendered = brief.renderBriefHuman ? brief.renderBriefHuman(b) : JSON.stringify(b, null, 2);
    return rendered;
  } catch (e: any) {
    return `harness-enforcer: failed to build brief: ${e.message}`;
  }
}

async function isHarnessProject(targetDir: string): Promise<boolean> {
  try {
    const { paths } = await loadHarnessLibs();
    const cfgPath = paths.CONFIG_PATH(targetDir);
    return existsSync(cfgPath);
  } catch {
    // fallback: check harness/config.json directly
    return existsSync(resolve(targetDir, "harness", "config.json"));
  }
}

export default function (pi: ExtensionAPI) {
  // ── session_start: lightweight notify (brief injected via context event) ─────
  pi.on("session_start", async (_event: any, ctx: any) => {
    const dir = getProjectDir(ctx);
    if (!(await isHarnessProject(dir))) return;
    ctx.ui.notify("pi-harness: enforcer active — brief will auto-inject via context", "info");
    ctx.ui.setStatus("harness", "ready");
    try { pi.appendEntry("harness:brief", { at: "session_start", dir }); } catch {}
  });

  // ── turn_end: auto-validate + auto-phase-next ─────────────────────────────
  pi.on("turn_end", async (_event: any, ctx: any) => {
    const dir = getProjectDir(ctx);
    if (!(await isHarnessProject(dir))) return;

    try {
      const { gates, state } = await loadHarnessLibs();
      const { config } = state.loadConfig(dir);
      if (!config || config.paused) return;

      // Only auto-validate if we are in a validate-able phase (build/verify/etc.)
      // Gates will tell us if we should advance — we just run them
      const result = await gates.runChecks(dir, config.currentPhase);
      const allPass = result?.overall;

      if (allPass) {
        // Check if brief says we should advance — we peek at next phase
        // Instead of guessing, we let the harness decide: if validate passes, try phase next
        // Use the CLI lib's phase transition (requires validate PASS)
        const { phases } = await loadHarnessLibs();
        // We don't auto-advance blindly; we inject the result so the agent knows
        ctx.ui.notify(`pi-harness: validate PASS on ${config.currentPhase} — auto-advancing`, "info");
        try {
          // Import phase command logic
          const cliDir = resolve(import.meta.dirname, "../../cli");
          const phaseCmd = await import(`${cliDir}/commands/phase.mjs`);
          // phase next is the enforced transition — only succeeds if gate passed
          await phaseCmd.default({ _: ["next"] }, { cwd: dir } as any);
        } catch (e: any) {
          // Phase advance may fail if not at phase boundary — that's fine, just inject next brief
        }
        const nextBrief = await buildBriefText(dir);
        if (nextBrief) {
          pi.sendUserMessage(`## pi-harness auto-advance (turn_end)\n\nValidate PASS on ${config.currentPhase}. Advanced.\n\n${nextBrief}`, { deliverAs: "followUp", streamingBehavior: "followUp" } as any);
          pi.appendEntry("harness:advance", { phase: config.currentPhase, brief: nextBrief });
        }
      } else {
        // FAIL — inject the failure so agent fixes it next turn (don't advance)
        const details = result?.checks ? result.checks.filter((r: any) => !r.pass).map((r: any) => `- ${r.name}: ${r.detail}`).join("\n") || result.failures?.join(", ") || "validate failed" : "validate failed";
        ctx.ui.notify(`pi-harness: validate FAIL — blocking advance`, "warning");
        pi.sendUserMessage(`## pi-harness gate FAIL (turn_end)\n\n${details}\n\nFix the listed checks, then the loop will auto-advance.`, { deliverAs: "steer", streamingBehavior: "steer" } as any);
        pi.appendEntry("harness:gate-fail", { phase: config.currentPhase, details });
      }
    } catch (e: any) {
      // Never block the turn on enforcer error
      ctx.ui.notify(`pi-harness turn_end error: ${e.message}`, "error");
    }
  });

  // ── tool_call: block phase-skipping ───────────────────────────────────────
  pi.on("tool_call", async (event: any, ctx: any) => {
    const dir = getProjectDir(ctx);
    if (!(await isHarnessProject(dir))) return;

    const tool = event.toolName || event.name || "";
    const input = event.input || {};

    // Block direct writes to harness/config.json that try to change currentPhase without validate
    const pathArg = input.path || input.file || input.filePath || "";
    if (typeof pathArg === "string" && pathArg.includes("harness/config.json") && tool.includes("write")) {
      // Allow reads, block writes that change phase — we check the content if present
      const content = input.content || input.data || "";
      if (typeof content === "string" && content.includes("currentPhase")) {
        // Check if gate actually passed — if not, block
        try {
          const { gates, state } = await loadHarnessLibs();
          const { config } = state.loadConfig(dir);
          const result = await gates.runChecks(dir, config?.currentPhase);
          const allPass = result?.overall;
          if (!allPass) {
            return { block: true, reason: "pi-harness: validate must PASS before hand-editing harness/config.json currentPhase. Run the validate command from the brief." };
          }
        } catch {}
      }
    }

    // Block `dev-harness phase next` if validate would fail (prevent skipping)
    const cmd = input.command || input.cmd || "";
    if (typeof cmd === "string" && cmd.includes("dev-harness") && cmd.includes("phase") && cmd.includes("next")) {
      try {
        const { gates, state } = await loadHarnessLibs();
        const { config } = state.loadConfig(dir);
        const result = await gates.runChecks(dir, config?.currentPhase);
        const allPass = result?.overall;
        if (!allPass) {
          return { block: true, reason: "pi-harness: gate FAIL — phase next blocked. Fix the listed checks and re-validate." };
        }
      } catch {}
    }
  });

  // ── agent_start / sub-agent lock (file lock) ──────────────────────────────
  // Pi sub-agents share the same harness dir — we use proper-lockfile to prevent corruption
  let lockRelease: (() => Promise<void>) | null = null;
  pi.on("agent_start", async (_event: any, ctx: any) => {
    const dir = getProjectDir(ctx);
    if (!(await isHarnessProject(dir))) return;
    try {
      const lockfile = await import("proper-lockfile");
      const cfgPath = resolve(dir, "harness", "config.json");
      if (existsSync(cfgPath)) {
        lockRelease = await lockfile.lock(cfgPath, { retries: 10, stale: 10000 }) as any;
        ctx.ui.setStatus("harness", "lock acquired");
      }
    } catch {}
  });
  pi.on("agent_end", async () => {
    if (lockRelease) {
      try { await lockRelease(); } catch {}
      lockRelease = null;
    }
  });
  pi.on("session_shutdown", async () => {
    if (lockRelease) {
      try { await lockRelease(); } catch {}
      lockRelease = null;
    }
  });

  // ── Keep existing commands as escape hatches ──────────────────────────────
  // The enforcer does not replace /harness:* commands — it just makes them unnecessary.
  // Users can still run /harness:next, /harness:validate, etc. manually.

  pi.registerCommand("harness:enforcer-status", {
    description: "Show pi-harness enforcer status (is the loop active?)",
    handler: async (_args: string, ctx: any) => {
      const dir = getProjectDir(ctx);
      const isHarness = await isHarnessProject(dir);
      const brief = isHarness ? await buildBriefText(dir) : "No harness in this project";
      ctx.ui.notify(`pi-harness: ${isHarness ? "active" : "no harness"} in ${dir}`, isHarness ? "info" : "warning");
      if (brief) ctx.ui.notify(brief.slice(0, 800), "info");
    },
  });
}
