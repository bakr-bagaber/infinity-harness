/**
 * infinity-harness — the settings TUI.
 *
 * Every option is reachable and editable from inside pi. Editing the JSON by
 * hand still works and always will, but nobody should *have* to: a harness you
 * can only configure by opening a file in another window is a harness people
 * configure once, wrongly, and never touch again.
 *
 * The menu is generated from `core/settings.ts`, so adding an option there
 * makes it appear here automatically.
 *
 * This module never imports pi. It talks to a `Prompter`, which the extension
 * satisfies with `ctx.ui` and a test satisfies with a scripted fake — which is
 * why the whole flow is testable without a terminal.
 */

import type { Setting, SettingsGroup } from "../core/settings.ts";
import { summarizeWorkflow } from "../workflow.ts";
import { normalizeDisplay, summarizeDisplay } from "./display.ts";
import {
  SETTINGS,
  coerce,
  formatValue,
  readAll,
  readSetting,
  writeSetting,
} from "../core/settings.ts";

/** The subset of pi's UI this flow needs. */
export type Prompter = {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, level?: "info" | "warning" | "error"): void;
};

/** A model pi has configured and can actually authenticate. */
export type ModelChoice = {
  /** How the harness stores it: `provider/id`. */
  ref: string;
  /** What the user sees. */
  label: string;
};

export type ConfigMenuOptions = {
  targetDir: string;
  prompt: Prompter;
  /** Models offered for any `model`-typed setting. */
  models: () => ModelChoice[] | Promise<ModelChoice[]>;
  /** Stop after one edit instead of returning to the menu. Used by tests. */
  once?: boolean;
};

const BACK = "← back";
const DONE = "✓ done";
const INHERIT = "(use pi's current model)";
const CUSTOM = "type a model id…";

/**
 * Run the settings menu until the user leaves.
 *
 * Returns the paths that were changed, so the caller can report what happened
 * and refresh anything that reads config.
 */
export async function runConfigMenu(options: ConfigMenuOptions): Promise<string[]> {
  const { targetDir, prompt } = options;
  const changed: string[] = [];

  for (;;) {
    const io = readAll(targetDir);
    const labels = SETTINGS.map((g) => `${g.label}  ·  ${summarize(g, io)}`);
    const choice = await prompt.select("infinity-harness settings", [...labels, DONE]);
    if (choice === undefined || choice === DONE) break;

    const group = SETTINGS[labels.indexOf(choice)];
    if (!group) break;

    const edited = await runGroup(group, options, changed);
    if (options.once && edited) break;
  }

  return changed;
}

/** One line per group so the top menu says something at a glance. */
function summarize(group: SettingsGroup, io: ReturnType<typeof readAll>): string {
  switch (group.id) {
    case "models": {
      const enabled = io.router.enabled;
      if (!enabled) return "routing off";
      const tiers = ["easy", "moderate", "difficult"]
        .map((t) => (io.router.byDifficulty as Record<string, string> | undefined)?.[t])
        .filter((v): v is string => Boolean(v && v.trim()));
      return tiers.length ? `${tiers.length}/3 tiers set` : "routing on, no tiers set";
    }
    case "pipeline":
      return (io.config.phases?.enabled ?? []).join(" → ") || "(none)";
    case "workflow":
      return summarizeWorkflow(io.config);
    case "display":
      return summarizeDisplay(normalizeDisplay(io.config.display));
    case "commands": {
      const set = Object.entries(io.config.commands ?? {}).filter(([, v]) => Boolean(v));
      return set.length ? set.map(([k]) => k).join(", ") : "none set";
    }
    case "gates":
      return io.config.gates?.enabled === false ? "DISABLED" : "on";
    case "loop":
      return `${io.config.loop?.maxIterations ?? "?"} turns · ${formatValue(
        { type: { kind: "number", unit: "ms" } } as Setting,
        io.config.loop?.maxWallClockMs,
      )}`;
    case "retries":
      return `${io.config.maxRetries ?? "?"} per task`;
    default:
      return "";
  }
}

async function runGroup(
  group: SettingsGroup,
  options: ConfigMenuOptions,
  changed: string[],
): Promise<boolean> {
  const { targetDir, prompt } = options;
  let edited = false;

  for (;;) {
    const io = readAll(targetDir);
    const rows = group.settings.map((s) => `${s.label}: ${formatValue(s, readSetting(io, s))}`);
    const choice = await prompt.select(`${group.label} — ${group.help}`, [...rows, BACK]);
    if (choice === undefined || choice === BACK) return edited;

    const setting = group.settings[rows.indexOf(choice)];
    if (!setting) return edited;

    const applied = await editSetting(setting, options);
    if (applied) {
      changed.push(setting.path);
      edited = true;
      if (options.once) return true;
    }
  }
}

/** Prompt for one setting and persist it. Returns whether anything changed. */
async function editSetting(setting: Setting, options: ConfigMenuOptions): Promise<boolean> {
  const { targetDir, prompt } = options;
  const io = readAll(targetDir);
  const current = readSetting(io, setting);

  let raw: string | undefined;

  switch (setting.type.kind) {
    case "boolean": {
      const picked = await prompt.select(`${setting.label} — ${setting.help}`, ["on", "off", BACK]);
      if (picked === undefined || picked === BACK) return false;
      raw = picked;
      break;
    }
    case "choice": {
      const picked = await prompt.select(`${setting.label} — ${setting.help}`, [
        ...setting.type.choices,
        BACK,
      ]);
      if (picked === undefined || picked === BACK) return false;
      raw = picked;
      break;
    }
    case "model": {
      raw = await pickModel(setting, options, typeof current === "string" ? current : "");
      if (raw === undefined) return false;
      break;
    }
    case "multi": {
      // Toggling one at a time beats asking someone to retype a whole list.
      const selected = new Set(Array.isArray(current) ? (current as string[]) : []);
      for (;;) {
        const rows = setting.type.choices.map((c) => `${selected.has(c) ? "[x]" : "[ ]"} ${c}`);
        const picked = await prompt.select(
          `${setting.label} — ${setting.help}`,
          [...rows, DONE, BACK],
        );
        if (picked === undefined || picked === BACK) return false;
        if (picked === DONE) break;
        const idx = rows.indexOf(picked);
        const key = setting.type.choices[idx];
        if (key === undefined) return false;
        if (selected.has(key)) selected.delete(key);
        else selected.add(key);
      }
      raw = [...selected].join(",");
      break;
    }
    default: {
      const shown = formatValue(setting, current);
      const answer = await prompt.input(
        `${setting.label} — ${setting.help}  [now: ${shown}]`,
        setting.type.kind === "text" ? setting.type.placeholder : undefined,
      );
      if (answer === undefined) return false;
      raw = answer;
      break;
    }
  }

  const result = coerce(setting, raw);
  if (!result.ok) {
    prompt.notify(`${setting.label}: ${result.error}`, "warning");
    return false;
  }

  if (JSON.stringify(result.value) === JSON.stringify(current)) return false;

  try {
    writeSetting(targetDir, setting, result.value);
  } catch (e) {
    prompt.notify(
      `could not save ${setting.label}: ${e instanceof Error ? e.message : String(e)}`,
      "error",
    );
    return false;
  }

  prompt.notify(`${setting.label} → ${formatValue(setting, result.value)}`, "info");
  return true;
}

/**
 * Offer the models pi actually has, rather than asking someone to remember an
 * id. Inheriting pi's current model is the first option because it is the
 * right answer for most tiers most of the time.
 */
async function pickModel(
  setting: Setting,
  options: ConfigMenuOptions,
  current: string,
): Promise<string | undefined> {
  const { prompt } = options;
  let models: ModelChoice[] = [];
  try {
    models = await options.models();
  } catch {
    models = [];
  }

  if (models.length === 0) {
    prompt.notify(
      "pi reports no configured models — falling back to typing an id. Check `pi models` / your provider auth.",
      "warning",
    );
    const typed = await prompt.input(`${setting.label} — ${setting.help}`, current || "provider/model-id");
    return typed;
  }

  const rows = models.map((m) => (m.ref === current ? `${m.label}  ← current` : m.label));
  const picked = await prompt.select(`${setting.label} — ${setting.help}`, [
    INHERIT,
    ...rows,
    CUSTOM,
    BACK,
  ]);

  if (picked === undefined || picked === BACK) return undefined;
  if (picked === INHERIT) return "";
  if (picked === CUSTOM) {
    const typed = await prompt.input(`${setting.label} — model id`, current || "provider/model-id");
    return typed;
  }
  const model = models[rows.indexOf(picked)];
  return model?.ref;
}

/**
 * A plain-text report of the whole configuration.
 *
 * Used by `/infinity:config show` and worth having on its own: it is the
 * fastest way to answer "what is this run actually going to do?".
 */
export function renderSettings(targetDir: string): string {
  const io = readAll(targetDir);
  const lines: string[] = ["infinity-harness settings", ""];
  for (const group of SETTINGS) {
    lines.push(`${group.label}`);
    for (const s of group.settings) {
      const value = formatValue(s, readSetting(io, s));
      lines.push(`  ${s.label.padEnd(28)} ${value}`);
    }
    lines.push("");
  }
  lines.push("Stored in harness/config.json and harness/model-router.json — both safe to edit by hand.");
  return lines.join("\n");
}
