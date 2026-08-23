/**
 * infinity-harness — skill file audit.
 *
 * pi loads **every** `.md` file in a declared skills directory as a skill and
 * validates it. A file that fails validation is not quietly ignored: pi prints
 * a `[Skill conflicts]` block on every single start, naming the file and the
 * problem. A stray `README.md` beside the skills is enough to do it — that is
 * exactly how this module came to exist.
 *
 * The point is to turn a warning the user sees at runtime into a failure we
 * see at test time. This re-implements pi's validation rules (`core/skills.js`
 * in the agent) closely enough that a clean audit means a clean start, over
 * the discovery and header parsing in `skills.ts`.
 *
 * Two deliberate differences, both in the stricter direction — this must never
 * pass something pi would reject:
 *
 *   - pi honours `.gitignore` / `.ignore` / `.fdignore` inside the skills tree
 *     and skips what they exclude. We audit everything we find.
 *   - pi parses frontmatter with a real YAML parser. We accept only plain
 *     scalars and flow lists, and report anything else rather than guessing.
 *     Frontmatter clever enough to need a YAML parser is frontmatter nobody
 *     should be writing in a skill header.
 */

import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { KNOWN_PHASES, SKILL_KINDS, discoverSkillFiles, parseSkillFrontmatter } from "./skills.ts";

/** pi: MAX_NAME_LENGTH. */
export const MAX_NAME_LENGTH = 64;
/** pi: MAX_DESCRIPTION_LENGTH. */
export const MAX_DESCRIPTION_LENGTH = 1024;
/** pi: validateName. */
export const NAME_RE = /^[a-z0-9-]+$/;

export type SkillProblem = {
  /** Absolute path of the offending file. */
  file: string;
  /** Phrased the way pi phrases it, where pi has a phrasing. */
  message: string;
};

export type SkillEntry = {
  file: string;
  name: string;
  description: string;
};

export type SkillAudit = {
  /** Files that would load as skills. */
  skills: SkillEntry[];
  /** Everything wrong, in discovery order. */
  problems: SkillProblem[];
};

/**
 * Walk a skills directory the way pi does and report what it would say.
 *
 * A missing directory is not a problem — pi treats it as "no skills here", and
 * so do we; a package may legitimately declare a directory it does not ship.
 */
export function auditSkillsDir(dir: string): SkillAudit {
  const audit: SkillAudit = { skills: [], problems: [] };

  for (const file of discoverSkillFiles(dir)) {
    inspect(file, audit);
  }

  // pi keys skills by name, so two files claiming one name means one of them
  // simply does not exist — and nothing warns about that, which makes it worse
  // than the errors that do.
  const byName = new Map<string, string[]>();
  for (const skill of audit.skills) {
    const seen = byName.get(skill.name);
    if (seen) seen.push(skill.file);
    else byName.set(skill.name, [skill.file]);
  }
  for (const [name, files] of byName) {
    if (files.length < 2) continue;
    for (const file of files.slice(1)) {
      audit.problems.push({
        file,
        message: `duplicate skill name "${name}" (also declared by ${files[0]})`,
      });
    }
  }

  return audit;
}

/** Validate one file, appending to the audit. */
function inspect(file: string, audit: SkillAudit): void {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch (e) {
    audit.problems.push({ file, message: e instanceof Error ? e.message : "unreadable" });
    return;
  }

  // pi tests `content.startsWith("---")` against the raw string, so a UTF-8
  // BOM hides the frontmatter completely and the file reads as a skill with no
  // description at all — a confusing way to learn your editor added three
  // invisible bytes.
  if (raw.charCodeAt(0) === 0xfeff) {
    audit.problems.push({
      file,
      message: "starts with a UTF-8 BOM, which hides the frontmatter from pi",
    });
    return;
  }

  const parsed = parseSkillFrontmatter(raw);
  if (parsed.kind === "error") {
    audit.problems.push({ file, message: parsed.message });
    return;
  }

  for (const key of ["name", "description"]) {
    if (parsed.structured.has(key)) {
      audit.problems.push({ file, message: `\`${key}\` must be a plain single-line value` });
    }
  }
  if (parsed.structured.has("name") || parsed.structured.has("description")) return;

  const declaredName = parsed.scalars.get("name") ?? "";
  const description = parsed.scalars.get("description") ?? "";
  const stem = basename(file).replace(/\.md$/, "");
  const isSkillRoot = stem === "SKILL";
  // pi's fallback when frontmatter omits a name: the parent directory name.
  const name = declaredName || basename(dirname(file));
  let usable = true;

  if (description.trim() === "") {
    // pi's exact wording, so a search for the message people actually see
    // lands here.
    audit.problems.push({ file, message: "description is required" });
    usable = false;
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    audit.problems.push({
      file,
      message: `description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`,
    });
  }

  for (const message of nameProblems(name)) {
    audit.problems.push({ file, message });
  }

  // House rules pi does not enforce, both of which produce a skill that loads
  // and then never does anything.
  if (!declaredName) {
    audit.problems.push({
      file,
      message: "name is required (pi would fall back to the directory name)",
    });
  } else if (!isSkillRoot && declaredName !== stem) {
    audit.problems.push({
      file,
      message: `name "${declaredName}" does not match filename "${stem}.md"`,
    });
  }

  // The brief routes on `kind`, and a skill with no kind is silently filed as
  // `domain` — which means a process skill without one stops being offered for
  // its phase and nobody finds out.
  const kind = parsed.scalars.get("kind") ?? "";
  if (!kind) {
    audit.problems.push({ file, message: `kind is required (one of ${SKILL_KINDS.join(", ")})` });
  } else if (!SKILL_KINDS.includes(kind)) {
    audit.problems.push({
      file,
      message: `unknown kind "${kind}" (expected one of ${SKILL_KINDS.join(", ")})`,
    });
  }

  // A typo in `phases:` is invisible: the skill loads, and the brief never
  // offers it, because no phase is ever called `verfiy`.
  for (const phase of parsed.lists.get("phases") ?? []) {
    if (!KNOWN_PHASES.includes(phase)) {
      audit.problems.push({
        file,
        message: `unknown phase "${phase}" (expected one of ${KNOWN_PHASES.join(", ")})`,
      });
    }
  }
  if (parsed.structured.has("phases") || parsed.structured.has("tags")) {
    audit.problems.push({
      file,
      message: "`tags` and `phases` must be inline lists, e.g. `tags: [a, b]`",
    });
  }

  if (usable) audit.skills.push({ file, name: declaredName || name, description });
}

/** pi: validateName. */
export function nameProblems(name: string): string[] {
  const problems: string[] = [];
  if (name.length > MAX_NAME_LENGTH) {
    problems.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  }
  if (!NAME_RE.test(name)) {
    problems.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    problems.push("name must not start or end with a hyphen");
  }
  if (name.includes("--")) {
    problems.push("name must not contain consecutive hyphens");
  }
  return problems;
}

/** One line per problem, for a test failure message or a CLI. */
export function formatAudit(audit: SkillAudit, root?: string): string {
  if (audit.problems.length === 0) {
    return `${audit.skills.length} skills, no problems`;
  }
  const rel = (file: string) => (root && file.startsWith(root) ? file.slice(root.length + 1) : file);
  return audit.problems.map((p) => `${rel(p.file)}: ${p.message}`).join("\n");
}
