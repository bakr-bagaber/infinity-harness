import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SETTINGS,
  allSettings,
  coerce,
  findGroup,
  formatValue,
  humanizeMs,
  parseDuration,
  readAll,
  readSetting,
  writeSetting,
  type Setting,
} from "../src/core/settings.ts";
import { defaultConfig } from "../src/core/config.ts";
import { loadRouterConfig } from "../src/modelRouter.ts";
import { runConfigMenu, renderSettings, type ModelChoice, type Prompter } from "../src/ui/config.ts";
import { safeModelRef } from "../src/worker.ts";

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "infinity-settings-"));
  mkdirSync(join(dir, "harness", "features"), { recursive: true });
  writeFileSync(join(dir, "harness", "config.json"), JSON.stringify(defaultConfig(), null, 2), "utf-8");
  return dir;
}

const setting = (path: string): Setting => {
  const s = allSettings().find((x) => x.path === path);
  assert.ok(s, `no setting declared at ${path}`);
  return s;
};

// ── schema integrity ────────────────────────────────────────────────────────
{
  const paths = allSettings().map((s) => `${s.file}:${s.path}`);
  assert.equal(new Set(paths).size, paths.length, "every setting has a unique file+path");

  for (const s of allSettings()) {
    assert.ok(s.label.trim(), `${s.path} has a label`);
    assert.ok(s.help.trim().length > 10, `${s.path} explains itself`);
    assert.ok(["config", "router"].includes(s.file), `${s.path} names a real file`);
  }
  for (const g of SETTINGS) {
    assert.ok(g.settings.length > 0, `group ${g.id} is not empty`);
    assert.equal(findGroup(g.id), g);
  }
  // The tiers the product documents must all be reachable from the UI.
  for (const p of ["byDifficulty.easy", "byDifficulty.moderate", "byDifficulty.difficult", "master", "default"]) {
    assert.equal(setting(p).type.kind, "model", `${p} is offered as a model picker`);
  }
  console.log("✓ the settings schema is coherent and covers every tier");
}

// ── coercion ────────────────────────────────────────────────────────────────
{
  const num = setting("loop.noProgressLimit");
  assert.deepEqual(coerce(num, "4"), { ok: true, value: 4 });
  assert.equal(coerce(num, "0").ok, false, "below the minimum is refused");
  assert.equal(coerce(num, "999").ok, false, "above the maximum is refused");
  assert.equal(coerce(num, "abc").ok, false, "junk is refused, not coerced to NaN");

  const dur = setting("loop.maxWallClockMs");
  assert.deepEqual(coerce(dur, "24h"), { ok: true, value: 86_400_000 });
  assert.deepEqual(coerce(dur, "90m"), { ok: true, value: 5_400_000 });
  assert.deepEqual(coerce(dur, "600000"), { ok: true, value: 600_000 });
  assert.equal(coerce(dur, "soon").ok, false);
  assert.equal(coerce(dur, "30s").ok, false, "below the 60s floor is refused");

  const bool = setting("gates.enabled");
  assert.deepEqual(coerce(bool, "on"), { ok: true, value: true });
  assert.deepEqual(coerce(bool, "no"), { ok: true, value: false });
  assert.equal(coerce(bool, "maybe").ok, false);

  const choice = setting("mode");
  assert.deepEqual(coerce(choice, "autopilot"), { ok: true, value: "autopilot" });
  assert.equal(coerce(choice, "yolo").ok, false);

  const multi = setting("phases.enabled");
  // Order is canonical regardless of how they were typed — the pipeline is a
  // sequence, not a set.
  assert.deepEqual(coerce(multi, "ship,build,define"), { ok: true, value: ["define", "build", "ship"] });
  assert.equal(coerce(multi, "define,nope").ok, false);

  const model = setting("byDifficulty.easy");
  assert.deepEqual(coerce(model, "  "), { ok: true, value: "" }, "blank means inherit, and is legal");
  assert.deepEqual(coerce(model, " openai/gpt-x "), { ok: true, value: "openai/gpt-x" });

  console.log("✓ values are coerced and bounds-checked, junk is refused");
}

// ── formatting ──────────────────────────────────────────────────────────────
{
  assert.equal(formatValue(setting("byDifficulty.easy"), ""), "(pi's current model)");
  assert.equal(formatValue(setting("byDifficulty.easy"), "a/b"), "a/b");
  assert.equal(formatValue(setting("gates.enabled"), true), "on");
  assert.equal(formatValue(setting("commands.lint"), ""), "(not set)");
  assert.equal(formatValue(setting("phases.enabled"), ["a", "b"]), "a → b");
  assert.equal(formatValue(setting("gates.coverage.threshold"), 80), "80%");
  assert.equal(humanizeMs(86_400_000), "24h");
  assert.equal(humanizeMs(5_400_000), "1.5h", "anything over an hour reads as hours");
  assert.equal(humanizeMs(1_800_000), "30m");
  assert.equal(humanizeMs(45_000), "45000ms", "sub-minute stays exact");
  assert.equal(parseDuration("2.5h"), 9_000_000);
  assert.equal(parseDuration(""), null);
  console.log("✓ values render for humans, including the inherit case");
}

// ── read / write round-trip ─────────────────────────────────────────────────
{
  const dir = tmpProject();
  try {
    const before = readAll(dir);
    assert.equal(readSetting(before, setting("gates.enabled")), true);
    assert.equal(readSetting(before, setting("byDifficulty.easy")), "", "tiers start empty");

    writeSetting(dir, setting("gates.coverage.threshold"), 91);
    writeSetting(dir, setting("commands.test"), "npm test");
    writeSetting(dir, setting("byDifficulty.difficult"), "anthropic/big-model");
    writeSetting(dir, setting("enabled"), true);

    const after = readAll(dir);
    assert.equal(readSetting(after, setting("gates.coverage.threshold")), 91);
    assert.equal(readSetting(after, setting("commands.test")), "npm test");
    assert.equal(readSetting(after, setting("byDifficulty.difficult")), "anthropic/big-model");
    assert.equal(readSetting(after, setting("enabled")), true);

    // Config and router are separate files and neither clobbers the other.
    const cfg = JSON.parse(readFileSync(join(dir, "harness", "config.json"), "utf-8"));
    assert.equal(cfg.gates.coverage.threshold, 91);
    assert.equal(cfg.commands.test, "npm test");
    assert.equal(cfg.gates.enabled, true, "an unrelated key is untouched");

    const router = loadRouterConfig(dir);
    assert.equal(router.enabled, true);
    assert.equal(router.byDifficulty?.difficult, "anthropic/big-model");
    assert.equal(router.byDifficulty?.easy, "", "the other tiers are left alone");

    console.log("✓ settings persist to the right file without disturbing their neighbours");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── the menu, driven by a scripted prompter ─────────────────────────────────

type Scripted = { prompt: Prompter; asked: string[]; notices: string[] };

/**
 * A prompter that answers from a queue. Each entry is what the user "picks";
 * an entry may be a literal option, or a function that chooses from what was
 * offered.
 */
function scripted(answers: Array<string | ((opts: string[]) => string | undefined) | undefined>): Scripted {
  const asked: string[] = [];
  const notices: string[] = [];
  let i = 0;
  const next = (opts: string[]): string | undefined => {
    const a = answers[i++];
    if (typeof a === "function") return a(opts);
    return a;
  };
  return {
    asked,
    notices,
    prompt: {
      async select(title, opts) {
        asked.push(title);
        return next(opts);
      },
      async input(title) {
        asked.push(title);
        return next([]);
      },
      notify(message, level) {
        notices.push(`${level ?? "info"}: ${message}`);
      },
    },
  };
}

const MODELS: ModelChoice[] = [
  { ref: "anthropic/small", label: "anthropic/small · Small · 200k ctx" },
  { ref: "anthropic/big", label: "anthropic/big · Big · 1000k ctx · reasoning" },
];

{
  const dir = tmpProject();
  try {
    // Models group → Easy tier → pick the second model.
    const s = scripted([
      (opts) => opts.find((o) => o.startsWith("Models")),
      (opts) => opts.find((o) => o.startsWith("Easy tier")),
      (opts) => opts.find((o) => o.includes("anthropic/big")),
    ]);

    const changed = await runConfigMenu({
      targetDir: dir,
      prompt: s.prompt,
      models: () => MODELS,
      once: true,
    });

    assert.deepEqual(changed, ["byDifficulty.easy"]);
    assert.equal(loadRouterConfig(dir).byDifficulty?.easy, "anthropic/big");
    assert.ok(
      s.notices.some((n) => n.includes("Easy tier") && n.includes("anthropic/big")),
      "the user is told what changed",
    );
    console.log("✓ a difficulty tier is set by picking from pi's real model list");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = tmpProject();
  try {
    // Setting a tier back to "inherit" is a first-class choice, not a deletion.
    writeSetting(dir, setting("byDifficulty.easy"), "anthropic/big");
    const s = scripted([
      (opts) => opts.find((o) => o.startsWith("Models")),
      (opts) => opts.find((o) => o.startsWith("Easy tier")),
      (opts) => opts.find((o) => o.includes("current model")),
    ]);
    const changed = await runConfigMenu({ targetDir: dir, prompt: s.prompt, models: () => MODELS, once: true });
    assert.deepEqual(changed, ["byDifficulty.easy"]);
    assert.equal(loadRouterConfig(dir).byDifficulty?.easy, "", "inherit is stored as empty");
    console.log("✓ a tier can be handed back to pi's current model");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = tmpProject();
  try {
    // With no models configured, the flow degrades to typing an id rather than
    // presenting an empty list.
    const s = scripted([
      (opts) => opts.find((o) => o.startsWith("Models")),
      (opts) => opts.find((o) => o.startsWith("Difficult tier")),
      "someprovider/some-model",
    ]);
    const changed = await runConfigMenu({ targetDir: dir, prompt: s.prompt, models: () => [], once: true });
    assert.deepEqual(changed, ["byDifficulty.difficult"]);
    assert.equal(loadRouterConfig(dir).byDifficulty?.difficult, "someprovider/some-model");
    assert.ok(s.notices.some((n) => n.startsWith("warning:") && n.includes("no configured models")));
    console.log("✓ no models available degrades to typing an id, with a warning");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = tmpProject();
  try {
    // A rejected value must not be written, and must say why.
    const s = scripted([
      (opts) => opts.find((o) => o.startsWith("Continuous run")),
      (opts) => opts.find((o) => o.startsWith("No-progress strikes")),
      "banana",
    ]);
    const changed = await runConfigMenu({ targetDir: dir, prompt: s.prompt, models: () => MODELS, once: true });
    assert.deepEqual(changed, [], "nothing was changed");
    assert.equal(readAll(dir).config.loop.noProgressLimit, 3, "the stored value is untouched");
    assert.ok(s.notices.some((n) => n.startsWith("warning:") && n.includes("not a number")));
    console.log("✓ an invalid answer is refused and explained, and nothing is written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = tmpProject();
  try {
    // Multi-select toggles rather than asking for a retyped list.
    const s = scripted([
      (opts) => opts.find((o) => o.startsWith("Pipeline")),
      (opts) => opts.find((o) => o.startsWith("Enabled phases")),
      (opts) => opts.find((o) => o.includes("simplify")),
      (opts) => opts.find((o) => o.startsWith("✓")),
    ]);
    const changed = await runConfigMenu({ targetDir: dir, prompt: s.prompt, models: () => MODELS, once: true });
    assert.deepEqual(changed, ["phases.enabled"]);
    const phases = readAll(dir).config.phases.enabled;
    assert.ok(phases.includes("simplify"), "simplify was toggled on");
    assert.deepEqual(
      phases,
      ["define", "plan", "build", "verify", "simplify", "review", "ship"],
      "and lands in pipeline order, not click order",
    );
    console.log("✓ the phase list is toggled item by item and stays ordered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = tmpProject();
  try {
    // Backing out of every level leaves the file alone.
    const s = scripted([
      (opts) => opts.find((o) => o.startsWith("Gates")),
      (opts) => opts.find((o) => o.startsWith("←")),
      (opts) => opts.find((o) => o.startsWith("✓")),
    ]);
    const before = readFileSync(join(dir, "harness", "config.json"), "utf-8");
    const changed = await runConfigMenu({ targetDir: dir, prompt: s.prompt, models: () => MODELS });
    assert.deepEqual(changed, []);
    assert.equal(readFileSync(join(dir, "harness", "config.json"), "utf-8"), before, "byte-identical");
    console.log("✓ backing out changes nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── the text report ─────────────────────────────────────────────────────────
{
  const dir = tmpProject();
  try {
    writeSetting(dir, setting("byDifficulty.moderate"), "anthropic/small");
    const text = renderSettings(dir);
    for (const g of SETTINGS) assert.ok(text.includes(g.label), `report covers ${g.label}`);
    assert.ok(text.includes("anthropic/small"), "report shows a configured tier");
    assert.ok(text.includes("(pi's current model)"), "report shows inherited tiers");
    assert.ok(text.includes("harness/config.json"), "report says where the files are");
    console.log("✓ the text report covers every group and names the files");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── model refs reaching a shell ─────────────────────────────────────────────
{
  assert.equal(safeModelRef("anthropic/claude-x"), "anthropic/claude-x");
  assert.equal(safeModelRef("openai/gpt-4o:high"), "openai/gpt-4o:high");
  assert.equal(safeModelRef(""), null, "empty means inherit, so no flag");
  assert.equal(safeModelRef("  "), null);
  assert.equal(safeModelRef(undefined), null);
  // A model reference is interpolated into a shell command, so anything that
  // could change the command is refused rather than escaped.
  assert.equal(safeModelRef("a; rm -rf /"), null);
  assert.equal(safeModelRef("a$(whoami)"), null);
  assert.equal(safeModelRef("a`id`"), null);
  assert.equal(safeModelRef("a b"), null);
  assert.equal(safeModelRef("a\nb"), null);
  assert.equal(safeModelRef("x".repeat(200)), null);
  console.log("✓ a model reference cannot smuggle shell syntax into a worker command");
}

console.log("All settings tests PASS");
