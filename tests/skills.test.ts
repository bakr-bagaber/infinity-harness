/**
 * The skills we ship must load cleanly in pi.
 *
 * This file exists because they didn't. A `README.md` sitting beside the
 * skills made real pi print, on every single start:
 *
 *   [Skill conflicts]
 *     ~\.pi\agent\npm\node_modules\infinity-harness\harness\skills\README.md
 *       description is required
 *
 * Nothing in the build noticed, because nothing in the build had an opinion
 * about the contents of a documentation directory. Now it does.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  auditSkillsDir,
  formatAudit,
  nameProblems,
} from "../src/core/skillsAudit.ts";
import { readJson } from "../src/core/fsx.ts";
import { SKILL_KINDS, loadSkills, matchSkills } from "../src/core/skills.ts";
import { buildBrief, renderBrief } from "../src/core/brief.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function tmpSkills(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-skills-"));
  for (const [name, body] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body, "utf-8");
  }
  return dir;
}

function skill(name: string, description: string, extra = "kind: process"): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}\n---\n\n# ${name}\n`;
}

// ── the real thing ─────────────────────────────────────────────────────────
// The regression guard. If this fails, pi will print a conflict block on
// every start for whoever installs the package next.
{
  const dir = join(repoRoot, "harness", "skills");
  const audit = auditSkillsDir(dir);
  assert.equal(
    audit.problems.length,
    0,
    `harness/skills would make pi complain:\n${formatAudit(audit, repoRoot)}`,
  );
  assert.equal(audit.skills.length, 28, "every shipped skill is accounted for");
  console.log(`✓ all ${audit.skills.length} shipped skills load cleanly in pi`);
}

// Every directory the package declares as a skills source must exist and be
// clean — declaring one we don't ship is its own kind of broken.
{
  const pkg = readJson<{ pi?: { skills?: string[] }; files?: string[] }>(
    join(repoRoot, "package.json"),
  );
  assert.ok(pkg, "package.json is readable");
  const declared = pkg.pi?.skills ?? [];
  assert.ok(declared.length > 0, "package.json declares at least one skills directory");
  for (const entry of declared) {
    const dir = resolve(repoRoot, entry);
    const audit = auditSkillsDir(dir);
    assert.ok(audit.skills.length > 0, `${entry} ships no skills`);
    assert.equal(audit.problems.length, 0, `${entry}:\n${formatAudit(audit, repoRoot)}`);
    // ...and it has to actually reach npm.
    const packed = (pkg.files ?? []).some((f) => entry.replace(/^\.\//, "").startsWith(f.replace(/\/$/, "")));
    assert.ok(packed, `${entry} is declared to pi but not listed in package.json "files"`);
  }
  console.log("✓ every declared skills directory exists, is clean, and is published");
}

// ── the exact failure that started this ────────────────────────────────────
{
  const dir = tmpSkills({
    "tdd.md": skill("tdd", "Red to green loop"),
    "README.md": "# Craft Skills\n\nHow to do the work well.\n",
  });
  const audit = auditSkillsDir(dir);
  assert.equal(audit.skills.length, 1, "the README is not a skill");
  assert.equal(audit.problems.length, 1);
  assert.match(audit.problems[0]!.message, /no frontmatter block/);
  assert.match(audit.problems[0]!.file, /README\.md$/);
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ a README beside the skills is reported, not ignored");
}

// A file with frontmatter but no description is pi's literal wording.
{
  const dir = tmpSkills({ "a.md": "---\nname: a\nkind: process\ntags: [x]\n---\n\nbody\n" });
  const audit = auditSkillsDir(dir);
  assert.deepEqual(
    audit.problems.map((p) => p.message),
    ["description is required"],
  );
  assert.equal(audit.skills.length, 0, "a skill with no description does not load");
  rmSync(dir, { recursive: true, force: true });
}

// An empty or whitespace description is the same failure.
{
  const dir = tmpSkills({ "a.md": "---\nname: a\nkind: process\ndescription: '   '\n---\n" });
  const audit = auditSkillsDir(dir);
  assert.deepEqual(
    audit.problems.map((p) => p.message),
    ["description is required"],
  );
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ a missing or blank description fails the audit");
}

// ── the BOM, again ─────────────────────────────────────────────────────────
// pi checks `content.startsWith("---")` on the raw string, so three invisible
// bytes from a Windows editor hide the whole header.
{
  const dir = tmpSkills({ "a.md": `﻿${skill("a", "fine otherwise")}` });
  const audit = auditSkillsDir(dir);
  assert.equal(audit.skills.length, 0);
  assert.match(audit.problems[0]!.message, /BOM/);
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ a UTF-8 BOM is caught with a message that names the cause");
}

// ── names ──────────────────────────────────────────────────────────────────
{
  assert.deepEqual(nameProblems("tdd"), []);
  assert.deepEqual(nameProblems("http-apis"), []);
  assert.deepEqual(nameProblems("a1-b2"), []);
  assert.match(nameProblems("TDD")[0]!, /invalid characters/);
  assert.match(nameProblems("has space")[0]!, /invalid characters/);
  assert.match(nameProblems("under_score")[0]!, /invalid characters/);
  assert.match(nameProblems("-lead")[0]!, /start or end with a hyphen/);
  assert.match(nameProblems("trail-")[0]!, /start or end with a hyphen/);
  assert.match(nameProblems("double--hyphen")[0]!, /consecutive hyphens/);
  assert.match(nameProblems("x".repeat(MAX_NAME_LENGTH + 1))[0]!, /exceeds 64/);
  assert.deepEqual(nameProblems("x".repeat(MAX_NAME_LENGTH)), [], "the limit itself is allowed");
  console.log("✓ name rules match pi's validateName");
}

{
  const dir = tmpSkills({ "Bad_Name.md": skill("Bad_Name", "d") });
  const messages = auditSkillsDir(dir).problems.map((p) => p.message);
  assert.ok(messages.some((m) => /invalid characters/.test(m)));
  rmSync(dir, { recursive: true, force: true });
}

// pi falls back to the *parent directory* name when frontmatter omits one,
// which in a flat directory means every unnamed file claims the same name.
{
  const dir = tmpSkills({ "a.md": "---\nkind: process\ndescription: no name here\n---\n" });
  const messages = auditSkillsDir(dir).problems.map((p) => p.message);
  assert.ok(messages.some((m) => /name is required/.test(m)), messages.join("; "));
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmpSkills({ "a.md": skill("b", "name does not match the file") });
  const messages = auditSkillsDir(dir).problems.map((p) => p.message);
  assert.ok(messages.some((m) => /does not match filename/.test(m)), messages.join("; "));
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ a name that disagrees with its filename is reported");
}

// ── kind ──────────────────────────────────────────────────────────────────
// The brief routes on it: a `process` skill is offered for its whole phase, a
// `domain` one only when the task shares its vocabulary. Guess wrong by
// omission and the skill quietly stops being suggested.
{
  const missing = tmpSkills({ "a.md": "---\nname: a\ndescription: d\n---\n" });
  assert.ok(
    auditSkillsDir(missing).problems.some((p) => /kind is required/.test(p.message)),
  );
  rmSync(missing, { recursive: true, force: true });

  const wrong = tmpSkills({ "a.md": skill("a", "d", "kind: craft") });
  assert.ok(auditSkillsDir(wrong).problems.some((p) => /unknown kind "craft"/.test(p.message)));
  rmSync(wrong, { recursive: true, force: true });

  for (const k of SKILL_KINDS) {
    const dir = tmpSkills({ "a.md": skill("a", "d", `kind: ${k}`) });
    assert.equal(auditSkillsDir(dir).problems.length, 0, `kind: ${k} is legal`);
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("✓ every skill declares a kind the brief knows how to route");
}

// A phase name that isn't a phase means the skill is never offered, silently.
{
  const dir = tmpSkills({ "a.md": skill("a", "d", "kind: process\nphases: [verfiy]") });
  assert.ok(auditSkillsDir(dir).problems.some((p) => /unknown phase "verfiy"/.test(p.message)));
  rmSync(dir, { recursive: true, force: true });

  const ok = tmpSkills({ "a.md": skill("a", "d", "kind: process\nphases: [build, verify]") });
  assert.equal(auditSkillsDir(ok).problems.length, 0);
  rmSync(ok, { recursive: true, force: true });
  console.log("✓ a mistyped phase name is caught");
}

// ── duplicates ─────────────────────────────────────────────────────────────
// Two files claiming one name is the quiet failure: pi keys skills by name, so
// one of them simply does not exist and nothing says so.
{
  const dir = tmpSkills({
    "tdd.md": skill("tdd", "first"),
    "nested/SKILL.md": "---\nname: tdd\nkind: process\ndescription: second\n---\n",
  });
  const audit = auditSkillsDir(dir);
  assert.equal(audit.skills.length, 2);
  assert.equal(audit.problems.length, 1);
  assert.match(audit.problems[0]!.message, /duplicate skill name "tdd"/);
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ two skills claiming one name is reported");
}

// ── discovery matches pi's ─────────────────────────────────────────────────
{
  const dir = tmpSkills({
    "a.md": skill("a", "root file"),
    "notes.txt": "not markdown",
    ".hidden.md": "---\n---\n",
    "sub/SKILL.md": "---\nname: sub\nkind: process\ndescription: a skill root\n---\n",
    "sub/ignored.md": "no frontmatter, but pi never looks inside a skill root",
    "plain/nested.md": "no frontmatter, and pi only looks for SKILL.md down here",
  });
  const audit = auditSkillsDir(dir);
  assert.deepEqual(audit.skills.map((s) => s.name).sort(), ["a", "sub"]);
  assert.equal(audit.problems.length, 0, formatAudit(audit, dir));
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ discovery matches pi's: root .md files, SKILL.md roots, nothing else");
}

// A directory that isn't there is not an error — pi treats it as "no skills".
{
  const audit = auditSkillsDir(join(tmpdir(), "infinity-harness-does-not-exist"));
  assert.deepEqual(audit, { skills: [], problems: [] });
}

// ── description length ─────────────────────────────────────────────────────
{
  const ok = tmpSkills({ "a.md": skill("a", "x".repeat(MAX_DESCRIPTION_LENGTH)) });
  assert.equal(auditSkillsDir(ok).problems.length, 0, "the limit itself is allowed");
  rmSync(ok, { recursive: true, force: true });

  const over = tmpSkills({ "a.md": skill("a", "x".repeat(MAX_DESCRIPTION_LENGTH + 1)) });
  const audit = auditSkillsDir(over);
  assert.match(audit.problems[0]!.message, /description exceeds 1024/);
  assert.equal(audit.skills.length, 1, "an over-long description still loads, it just warns");
  rmSync(over, { recursive: true, force: true });
  console.log("✓ description length is bounded the way pi bounds it");
}

// ── frontmatter we refuse to guess at ──────────────────────────────────────
// Anything a hand-rolled reader and a real YAML parser could read differently
// is reported rather than assumed.
{
  const dir = tmpSkills({ "a.md": "---\nname: a\nkind: process\ndescription: |\n  a block scalar\n---\n" });
  assert.match(auditSkillsDir(dir).problems[0]!.message, /plain single-line value/);
  rmSync(dir, { recursive: true, force: true });

  const unclosed = tmpSkills({ "a.md": "---\nname: a\nkind: process\ndescription: d\n" });
  assert.match(auditSkillsDir(unclosed).problems[0]!.message, /never closed/);
  rmSync(unclosed, { recursive: true, force: true });
  console.log("✓ frontmatter that can't be read unambiguously is a problem, not a guess");
}

// Quoted values survive, and a trailing comment does not become part of one.
{
  const dir = tmpSkills({
    "a.md": `---\nname: "a"\nkind: process\ndescription: 'Quoted, with: a colon'\n---\n`,
    "b.md": "---\nname: b\nkind: process\ndescription: plain value # trailing comment\n---\n",
  });
  const audit = auditSkillsDir(dir);
  assert.equal(audit.problems.length, 0, formatAudit(audit, dir));
  assert.equal(audit.skills.find((s) => s.name === "a")?.description, "Quoted, with: a colon");
  assert.equal(audit.skills.find((s) => s.name === "b")?.description, "plain value");
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ quoted values and trailing comments are read the way YAML reads them");
}


// ── matching ───────────────────────────────────────────────────────────────
// What the brief actually does with all of this.

{
  const skills = loadSkills();
  assert.ok(skills.length >= 25, "the packaged skills load from the package, not the project");
  assert.ok(
    skills.every((s) => SKILL_KINDS.includes(s.kind)),
    "every loaded skill has a routable kind",
  );
  assert.ok(skills.some((s) => s.name === "tdd" && s.kind === "process"));
  assert.ok(skills.some((s) => s.name === "databases" && s.kind === "domain"));
  console.log(`✓ ${skills.length} skills load from the package itself`);
}

// A process skill belongs to its phase whatever the task says.
{
  const skills = loadSkills();
  const names = matchSkills(skills, { phase: "build", text: "do the thing" }).map((m) => m.skill.name);
  assert.ok(names.includes("tdd"), `expected tdd for a bare BUILD task, got ${names.join(", ")}`);
}

// A domain skill does not. Nobody in BUILD needs the database skill because
// they are in BUILD.
{
  const skills = loadSkills();
  const names = matchSkills(skills, { phase: "build", text: "do the thing", limit: 10 }).map(
    (m) => m.skill.name,
  );
  for (const domain of ["databases", "auth-security", "http-apis", "frontend-ui"]) {
    assert.ok(!names.includes(domain), `${domain} should not surface on vocabulary it never matched`);
  }
  console.log("✓ phase alone surfaces process skills and only process skills");
}

// ...but vocabulary brings it straight to the top.
{
  const skills = loadSkills();
  const top = matchSkills(skills, {
    phase: "build",
    text: "migrate the postgres schema and add an index for the slow query",
  })[0];
  assert.equal(top?.skill.name, "databases");
  assert.match(top!.why, /build phase/);
  assert.match(top!.why, /"postgres"/);
  console.log("✓ vocabulary outranks the phase when the task is specific");
}

// A phase a skill leads with beats one it merely also serves: diagnosing-bugs
// is `[verify, build]`, so it must not outrank tdd on a silent BUILD task.
{
  const skills = loadSkills();
  const ranked = matchSkills(skills, { phase: "build", text: "implement it", limit: 10 }).map(
    (m) => m.skill.name,
  );
  assert.ok(
    ranked.indexOf("tdd") < ranked.indexOf("diagnosing-bugs"),
    `tdd should lead BUILD: ${ranked.join(", ")}`,
  );
  console.log("✓ where a phase sits in a skill's list decides how strongly it counts");
}

// A tag matches its own plural — "two workers" is about the `worker` tag.
{
  const skills = loadSkills();
  const names = matchSkills(skills, {
    phase: "build",
    text: "spawn two workers and join the queues",
    limit: 10,
  }).map((m) => m.skill.name);
  assert.ok(names.includes("concurrency-async"), names.join(", "));
  console.log("✓ tags match their own plurals");
}

// One incidental tag hit is not a recommendation.
{
  const skills = loadSkills();
  const names = matchSkills(skills, { text: "resolve the merge conflict in package-lock.json" }).map(
    (m) => m.skill.name,
  );
  assert.ok(names.includes("resolving-merge-conflicts"));
  assert.ok(!names.includes("http-apis"), 'the "json" in a filename is not an HTTP task');
  console.log("✓ a single incidental tag hit does not earn a recommendation");
}

// Meta skills wait to be asked for. Every one of them is tagged `meta`, so
// counting that tag like any other would surface all four constantly.
{
  const skills = loadSkills();
  const bare = matchSkills(skills, { phase: "build", text: "meta", limit: 10 }).map((m) => m.skill.name);
  for (const m of ["writing-skills", "building-tools", "capability-acquisition"]) {
    assert.ok(!bare.includes(m), `${m} surfaced on the meta tag alone`);
  }
  const asked = matchSkills(skills, {
    phase: "build",
    text: "write a script to reset the fixtures, and make it executable",
    limit: 10,
  }).map((m) => m.skill.name);
  assert.ok(asked.includes("building-tools"), asked.join(", "));
  console.log("✓ meta skills surface when asked for, not by default");
}

// The same state always produces the same brief.
{
  const skills = loadSkills();
  const once = matchSkills(skills, { phase: "verify", text: "the suite is flaky on CI" });
  const twice = matchSkills([...skills].reverse(), { phase: "verify", text: "the suite is flaky on CI" });
  assert.deepEqual(
    once.map((m) => m.skill.name),
    twice.map((m) => m.skill.name),
    "ranking must not depend on directory order",
  );
  console.log("✓ ranking is deterministic regardless of load order");
}

// No phase, no text, no matches — and no crash.
{
  assert.deepEqual(matchSkills(loadSkills(), {}), []);
  assert.deepEqual(matchSkills([], { phase: "build", text: "x" }), []);
  assert.deepEqual(matchSkills(loadSkills(), { phase: "build", text: "x", limit: 0 }), []);
  assert.deepEqual(loadSkills(join(tmpdir(), "infinity-harness-nope")), []);
}

// The brief carries them, and renders them.
{
  const dir = mkdtempSync(join(tmpdir(), "pi-brief-skills-"));
  mkdirSync(join(dir, "harness", "features"), { recursive: true });
  writeFileSync(
    join(dir, "harness", "config.json"),
    JSON.stringify({ currentPhase: "build", phases: { enabled: ["build"] } }),
  );
  writeFileSync(
    join(dir, "harness", "features", "feature-list.json"),
    JSON.stringify({
      revision: 1,
      features: [
        {
          id: "feature-001",
          name: "Plan store",
          status: "in_progress",
          criteria: ["writes are atomic"],
          tasks: [
            {
              id: 1,
              description: "serialise plan writes so two concurrent workers cannot race on the lock",
              status: "pending",
            },
          ],
        },
      ],
    }),
  );

  const brief = await buildBrief(dir);
  assert.ok(brief.skills.length > 0, "the brief names skills for the work in hand");
  assert.equal(brief.skills[0]!.name, "concurrency-async");
  assert.ok(brief.skills[0]!.description.length > 0);

  const text = renderBrief(brief);
  assert.match(text, /SKILLS/);
  assert.match(text, /concurrency-async/);
  assert.ok(
    text.indexOf("SKILLS") < text.indexOf("THE LOOP"),
    "skills come before the instructions that tell you to start",
  );
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ the brief names the skill that matches the task, as the docs claim");
}

console.log("skills.test.ts ✓");
