/**
 * Every name we tell someone to type is a name that exists.
 *
 * This file exists because the brief spent months ending with:
 *
 *   THE LOOP
 *     2. Run: harness validate
 *
 * `harness` is a command line that stopped existing when the CLI was ported
 * into `src/`. Every brief — the text injected at session start, the thing the
 * whole design rests on — closed by telling the model to run a command that
 * would fail. Four shipped skills had the same disease, pointing at an
 * `infinity-harness capability …` CLI this package never had.
 *
 * Nothing caught either one, because a wrong string in a template is invisible
 * to a type checker and a passing test. So: extract the tools and commands the
 * extension actually registers, then hold every document and every rendered
 * brief to that list.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBrief, renderBrief } from "../src/core/brief.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The markdown this repository actually ships, from git rather than from a
 * directory walk.
 *
 * A walk finds what the harness *wrote* as well as what we publish. Run the
 * pipeline in this repo once and `harness/session-handoff.md` and
 * `harness/.run-prompt.md` appear — git-ignored scratch, full of whatever
 * commands were current when they were generated. Holding those to today's
 * command list fails the suite for anyone who has actually used the tool, and
 * says nothing about the package.
 */
function trackedMarkdown(...dirs: string[]): string[] {
  const listed = execFileSync("git", ["ls-files", "-z", "--", ...dirs], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
  const files = listed
    .split("\0")
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(repoRoot, f));
  assert.ok(files.length > 0, `git ls-files found no markdown under ${dirs.join(", ")}`);
  return files;
}
const extensionSource = readFileSync(
  join(repoRoot, "extensions", "infinity-harness", "index.ts"),
  "utf-8",
);

// What the adapter actually hands to pi.
const TOOLS = new Set(
  [...extensionSource.matchAll(/registerTool\(\{\s*\n\s*name:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]!),
);
const COMMANDS = new Set(
  [...extensionSource.matchAll(/registerCommand\("([a-z0-9:_-]+)"/g)].map((m) => m[1]!),
);

{
  assert.ok(TOOLS.size >= 5, `expected the tool set, parsed ${TOOLS.size}: ${[...TOOLS]}`);
  assert.ok(COMMANDS.size >= 9, `expected the command set, parsed ${COMMANDS.size}: ${[...COMMANDS]}`);
  assert.ok(TOOLS.has("infinity_validate"));
  assert.ok(COMMANDS.has("infinity:run"));
  console.log(`✓ the extension registers ${TOOLS.size} tools and ${COMMANDS.size} commands`);
}

/** Every `infinity_x` / `/infinity:x` mentioned in a piece of text. */
function mentioned(text: string): { tools: string[]; commands: string[] } {
  return {
    tools: [...new Set([...text.matchAll(/\binfinity_[a-z0-9_]+/g)].map((m) => m[0]))],
    commands: [...new Set([...text.matchAll(/\/infinity:[a-z0-9-]+/g)].map((m) => m[0].slice(1)))],
  };
}

function checkText(label: string, text: string): string[] {
  const { tools, commands } = mentioned(text);
  const bad: string[] = [];
  for (const tool of tools) if (!TOOLS.has(tool)) bad.push(`${label}: no such tool ${tool}`);
  for (const cmd of commands) if (!COMMANDS.has(cmd)) bad.push(`${label}: no such command /${cmd}`);
  return bad;
}

// ── the brief ──────────────────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "pi-surface-"));
  mkdirSync(join(dir, "harness", "features"), { recursive: true });
  const write = (phase: string, tasksDone: boolean) => {
    writeFileSync(
      join(dir, "harness", "config.json"),
      JSON.stringify({ currentPhase: phase, phases: { enabled: ["define", "plan", "build", "verify", "review", "ship"] } }),
    );
    writeFileSync(
      join(dir, "harness", "features", "feature-list.json"),
      JSON.stringify({
        revision: 1,
        features: [
          {
            id: "feature-001",
            name: "Checkout",
            status: "in_progress",
            criteria: ["it charges the right amount"],
            tasks: [
              {
                id: 1,
                description: "handle partial refunds across split tenders",
                status: tasksDone ? "complete" : "pending",
              },
            ],
          },
        ],
      }),
    );
  };

  const problems: string[] = [];
  for (const phase of ["define", "plan", "build", "verify", "review", "ship"]) {
    write(phase, false);
    const brief = await buildBrief(dir);
    const text = renderBrief(brief);
    problems.push(...checkText(`brief(${phase})`, text));
    // The whole point of the brief is that the model knows what to do next.
    assert.match(text, /THE LOOP/, `brief(${phase}) lost its instructions`);
    assert.ok(
      mentioned(text).tools.length > 0,
      `brief(${phase}) tells the model to act but names no tool`,
    );
  }

  // The paused and complete briefs return early — they must still be clean.
  write("ship", true);
  const brief = await buildBrief(dir);
  problems.push(...checkText("brief(complete)", renderBrief(brief)));

  assert.deepEqual(problems, [], problems.join("\n"));
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ every brief names tools and commands the extension registers");
}

// ── the documents ──────────────────────────────────────────────────────────
{
  // CHANGELOG is deliberately absent: a changelog's job is to say what a
  // release removed or renamed, so it has to be able to name things that no
  // longer exist. Everything else here is instructions someone will follow.
  const docs = [
    join(repoRoot, "README.md"),
    join(repoRoot, "AGENTS.md"),
    ...trackedMarkdown("harness/docs", "harness/skills"),
  ];

  const problems: string[] = [];
  for (const doc of docs) {
    problems.push(...checkText(doc.slice(repoRoot.length + 1), readFileSync(doc, "utf-8")));
  }
  assert.deepEqual(problems, [], problems.join("\n"));
  console.log(`✓ ${docs.length} shipped documents name only tools and commands that exist`);
}

// ── the CLI that isn't ─────────────────────────────────────────────────────
// This package ships no executable. It descends from one that did, and the
// instructions came with it: `infinity-harness capability add`, `contract
// propose`, `decision "..."`, `rollback list`, `checkpoint create`, `init`.
// Every one was a command-not-found waiting for whoever followed the document.
//
// A hardcoded list of banned verbs only ever catches the ones already found.
// So this looks at where the claim is made instead: inside a code fence or a
// code span, the package name followed by a word is a command line, and there
// is no command line. In prose — "infinity-harness drives the agent" — it is
// just the name.
{
  const problems: string[] = [];
  const CLI = /\b(?:infinity-harness|dev-harness|pi-harness)\s+([a-z][a-z-]*)/g;

  /** Fenced blocks and inline spans — the places a command is written. */
  function codeOnly(text: string): string {
    const parts: string[] = [];
    for (const [, body] of text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) parts.push(body);
    for (const [, body] of text.matchAll(/`([^`\n]+)`/g)) parts.push(body);
    return parts.join("\n");
  }

  const check = (label: string, text: string) => {
    for (const [hit, verb] of codeOnly(text).matchAll(CLI)) {
      // `pi install npm:infinity-harness` is the one legitimate form.
      if (/\b(?:pi|npm|npx|git)\b/.test(hit)) continue;
      problems.push(`${label}: names a CLI that does not exist — "${verb}" in \`${hit.trim()}\``);
    }
  };
  const files = [
    join(repoRoot, "README.md"),
    join(repoRoot, "AGENTS.md"),
    ...trackedMarkdown("harness"),
  ];
  for (const file of files) check(file.slice(repoRoot.length + 1), readFileSync(file, "utf-8"));
  assert.deepEqual(problems, [], problems.join("\n"));
  console.log("✓ nothing shipped tells anyone to run a command line this package does not have");
}

// ── the rename artefact ────────────────────────────────────────────────────
// A mechanical rename once turned "the `harness validate` command" into
// "`the infinity_validate tool`" in 36 places across 11 shipped documents —
// broken English in the very files the brief tells the agent to read, and in
// three of them a tool name that never existed.
{
  const files = [
    join(repoRoot, "README.md"),
    join(repoRoot, "AGENTS.md"),
    ...trackedMarkdown("harness"),
  ];

  const problems: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf-8");
    for (const [hit] of text.matchAll(/`the (?:infinity|harness|pi)[a-z_:-]* (?:tool|command)`/g)) {
      problems.push(`${file.slice(repoRoot.length + 1)}: ${hit}`);
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
  console.log("✓ no document carries the mechanical-rename artefact");
}

console.log("surface.test.ts ✓");
