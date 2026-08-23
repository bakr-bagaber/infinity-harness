/**
 * infinity-harness — the craft skills that ship with the package.
 *
 * 29 short documents on how to do the work well: how to write a test worth
 * keeping, how to debug something intermittent, how to design a module
 * boundary. pi loads them as skills so the model can invoke any of them by
 * name — but a model with 29 skills available and no idea which one applies
 * reads none of them.
 *
 * So the brief names the one or two that match what is being worked on right
 * now. That matching is what this module does. Each skill declares the phases
 * it belongs to and the vocabulary it covers:
 *
 *     ---
 *     name: concurrency-async
 *     description: Concurrency and async correctness — races, idempotency, …
 *     tags: [concurrency, async, race, lock, mutex, deadlock, atomic]
 *     when: task involves parallel work, background jobs, or shared state
 *     phases: [plan, build, verify]
 *     ---
 *
 * and a task called "serialise plan writes so two workers can't clobber each
 * other" hits `lock` and `race` in BUILD, so the brief says to read it.
 *
 * The skills live in the package, not the user's project: they travel with the
 * install, and no project needs to vendor them.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PHASE_ORDER, type Phase } from "./types.ts";

/**
 * What a skill is for, which decides how it earns a place in a brief.
 *
 *   - `process` — how to work in a phase. Belonging to the phase is enough:
 *     TDD is the right answer for a BUILD task whatever the task says.
 *   - `domain` — a subject area. Must share vocabulary with the task; nobody
 *     needs the database skill because they happen to be in BUILD.
 *   - `meta` — growing the toolkit. Vocabulary only, never a phase.
 */
export type SkillKind = "process" | "domain" | "meta";

export type SkillMeta = {
  /** As pi knows it — `/skill:<name>`. */
  name: string;
  description: string;
  kind: SkillKind;
  /** Vocabulary that should pull this skill in. */
  tags: string[];
  /** Phases it belongs to. Empty means "any phase" — the meta skills. */
  phases: string[];
  /** Prose condition from the header, shown when nothing better is available. */
  when: string;
  file: string;
};

export type SkillMatch = {
  skill: SkillMeta;
  score: number;
  /** Why it surfaced, in words: `build phase · matches "lock", "race"`. */
  why: string;
};

/**
 * Where the shipped skills live.
 *
 * Resolved from this module's own location, so it is right in a checkout
 * (`<repo>/src/core` → `<repo>/harness/skills`) and right inside an install
 * (`node_modules/infinity-harness/src/core` → `…/harness/skills`).
 *
 * pi loads extensions through jiti, which provides `import.meta.url` but not
 * `import.meta.dirname` — hence the long way round.
 */
export function packagedSkillsDir(): string {
  try {
    return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "harness", "skills");
  } catch {
    return "";
  }
}

/**
 * pi's discovery rules, reproduced:
 *   - a directory containing `SKILL.md` is a skill root; that file is the
 *     skill and nothing below it is scanned
 *   - otherwise direct `.md` children of the root are skills
 *   - subdirectories are recursed into, but only to find `SKILL.md`
 *   - dotfiles and `node_modules` are skipped
 */
export function discoverSkillFiles(dir: string, includeRootFiles = true): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  if (entries.includes("SKILL.md") && isFile(join(dir, "SKILL.md"))) {
    return [join(dir, "SKILL.md")];
  }

  const found: string[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (isDir(full)) {
      found.push(...discoverSkillFiles(full, false));
      continue;
    }
    if (!includeRootFiles || !entry.endsWith(".md") || !isFile(full)) continue;
    found.push(full);
  }
  return found;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// ── Frontmatter ─────────────────────────────────────────────────────────────

export type Frontmatter =
  | {
      kind: "ok";
      /** Plain single-line values. */
      scalars: Map<string, string>;
      /** Flow lists: `tags: [a, b]`. */
      lists: Map<string, string[]>;
      /** Keys whose value is a map, a block scalar, or otherwise not plain. */
      structured: Set<string>;
    }
  | { kind: "error"; message: string };

const SCALAR_KEYS = new Set(["name", "description", "when", "kind"]);
const LIST_KEYS = new Set(["tags", "phases"]);

/**
 * Read a skill header without a YAML dependency.
 *
 * pi uses a real YAML parser; this reads the subset a skill header is allowed
 * to use, and records anything else as `structured` rather than guessing at
 * it. The audit turns that into a failure, so the two readers can never
 * silently disagree about what a skill is called or what it does.
 *
 * The `startsWith("---")` test is pi's, and it is why a UTF-8 BOM hides an
 * entire header: three invisible bytes and the file has no frontmatter at all.
 */
export function parseSkillFrontmatter(raw: string): Frontmatter {
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!text.startsWith("---")) {
    return {
      kind: "error",
      message: "no frontmatter block (pi requires `---` on the very first line)",
    };
  }
  const end = text.indexOf("\n---", 3);
  if (end === -1) {
    return { kind: "error", message: "frontmatter block is never closed with `---`" };
  }

  const scalars = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const structured = new Set<string>();

  for (const line of text.slice(4, end).split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    // An indented line belongs to whatever structured value came before it.
    if (/^\s/.test(line)) continue;
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    const value = match[2]!.trim();

    if (LIST_KEYS.has(key)) {
      if (value.startsWith("[") && value.endsWith("]")) {
        lists.set(key, splitFlowList(value.slice(1, -1)));
      } else if (value === "") {
        // A block list (`tags:` then `  - a`) is legal YAML but not the house
        // style; record it as structured rather than reading half of it.
        structured.add(key);
      } else {
        lists.set(key, splitFlowList(value));
      }
      continue;
    }

    if (!SCALAR_KEYS.has(key)) continue;

    if (value === "" || value === "|" || value === ">" || value.startsWith("[") || value.startsWith("{")) {
      structured.add(key);
      continue;
    }
    scalars.set(key, unquote(value));
  }

  return { kind: "ok", scalars, lists, structured };
}

function splitFlowList(inner: string): string[] {
  return inner
    .split(",")
    .map((s) => unquote(s.trim()))
    .filter((s) => s.length > 0);
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  // A YAML plain scalar ends at an unquoted ` #`.
  const comment = value.indexOf(" #");
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}

// ── Loading ─────────────────────────────────────────────────────────────────

/**
 * Load every skill in a directory. Malformed files are skipped rather than
 * thrown on — a broken skill must never stop a brief from being issued. The
 * audit (`skillsAudit.ts`) is what refuses to let one ship.
 *
 * Deliberately uncached: 29 small files read once per brief costs nothing, and
 * a cache would serve a stale header to anyone editing a skill mid-run.
 */
export function loadSkills(dir: string = packagedSkillsDir()): SkillMeta[] {
  if (!dir || !existsSync(dir)) return [];
  const out: SkillMeta[] = [];
  for (const file of discoverSkillFiles(dir)) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const parsed = parseSkillFrontmatter(raw);
    if (parsed.kind !== "ok") continue;
    const description = parsed.scalars.get("description") ?? "";
    if (!description.trim()) continue;
    const stem = basename(file).replace(/\.md$/, "");
    const name = parsed.scalars.get("name") || (stem === "SKILL" ? basename(dirname(file)) : stem);
    const kind = parsed.scalars.get("kind");
    out.push({
      name,
      description,
      kind: kind === "process" || kind === "domain" || kind === "meta" ? kind : "domain",
      tags: parsed.lists.get("tags") ?? [],
      phases: parsed.lists.get("phases") ?? [],
      when: parsed.scalars.get("when") ?? "",
      file,
    });
  }
  return out;
}

// ── Matching ────────────────────────────────────────────────────────────────

const PHASE_WEIGHT = 4;
const TAG_WEIGHT = 2;
const NAME_WEIGHT = 3;
/** Three tag hits already means "yes, this one"; more shouldn't drown a phase. */
const MAX_TAG_HITS = 3;
/**
 * A single incidental tag hit is not a recommendation. "package-lock.json"
 * contains `json`, which is on the HTTP skill's tag list, and nobody resolving
 * a merge conflict needs to read about REST.
 */
const MIN_SCORE = 3;

export type MatchOptions = {
  phase?: Phase | null;
  /** Everything known about the current work: task, feature, goal, criteria. */
  text?: string;
  limit?: number;
};

/**
 * Rank skills against the work in hand.
 *
 * A skill earns its place by belonging to this phase, by sharing vocabulary
 * with the task, or both — but only `process` skills can qualify on the phase
 * alone. That distinction is the whole difference between a useful section and
 * a section people learn to skip: without it, every BUILD task in the world
 * gets told to read about authentication, because `auth-security` lists BUILD
 * among its phases and sorts early in the alphabet.
 *
 * Where a phase appears in a skill's list matters too. `diagnosing-bugs`
 * declares `[verify, build]` — it is a VERIFY skill that is also useful in
 * BUILD — so it should not outrank `tdd`, which leads with BUILD, on a BUILD
 * task that says nothing about bugs.
 *
 * Skills that score nothing are left out entirely. An empty section is honest;
 * a padded one is noise.
 */
export function matchSkills(skills: SkillMeta[], options: MatchOptions = {}): SkillMatch[] {
  const { phase = null, text = "", limit = 3 } = options;
  const haystack = text.toLowerCase();
  const tokens = new Set(haystack.split(/[^a-z0-9]+/).filter(Boolean));

  const matches: SkillMatch[] = [];
  for (const skill of skills) {
    let score = 0;
    const reasons: string[] = [];

    const hits: string[] = [];
    for (const tag of skill.tags) {
      const t = tag.toLowerCase();
      // Hyphenated tags don't survive tokenisation, so look for them whole.
      // Everything else matches its own plural: a task about "two workers"
      // is about the `worker` tag, and pretending otherwise loses the match
      // that mattered.
      const hit = t.includes("-") ? haystack.includes(t) : hasWord(tokens, t);
      if (hit && !hits.includes(t)) hits.push(t);
    }

    const position = phase ? skill.phases.indexOf(phase) : -1;
    const phaseCounts = position >= 0 && (skill.kind === "process" || hits.length > 0);
    if (phaseCounts) {
      score += Math.max(1, PHASE_WEIGHT - position);
      reasons.push(`${phase} phase`);
    }

    if (hits.length && skill.kind !== "meta") {
      score += TAG_WEIGHT * Math.min(hits.length, MAX_TAG_HITS);
    } else if (hits.length) {
      // A meta skill has to be asked for: `meta` is on all of their tag lists,
      // so counting it like any other hit would surface all four constantly.
      const real = hits.filter((h) => h !== "meta");
      if (real.length === 0) continue;
      score += TAG_WEIGHT * Math.min(real.length, MAX_TAG_HITS);
    }
    if (hits.length) {
      const shown = hits.filter((h) => h !== "meta" || skill.kind !== "meta").slice(0, MAX_TAG_HITS);
      if (shown.length) reasons.push(`matches ${shown.map((h) => `"${h}"`).join(", ")}`);
    }

    // Naming the skill in the task means it, and outranks any guess.
    if (skill.name && haystack.includes(skill.name.toLowerCase())) {
      score += NAME_WEIGHT;
    }

    if (score < MIN_SCORE) continue;
    matches.push({ skill, score, why: reasons.join(" · ") });
  }

  // Ties break by phase specificity then name, so the same state always
  // produces the same brief — one that reshuffles between turns reads as new
  // information when nothing has changed.
  matches.sort(
    (a, b) =>
      b.score - a.score ||
      a.skill.phases.length - b.skill.phases.length ||
      a.skill.name.localeCompare(b.skill.name),
  );
  return matches.slice(0, Math.max(0, limit));
}

/** Token match, tolerant of a trailing plural on either side. */
function hasWord(tokens: Set<string>, tag: string): boolean {
  if (tokens.has(tag)) return true;
  if (tokens.has(`${tag}s`)) return true;
  return tag.endsWith("s") && tokens.has(tag.slice(0, -1));
}

/** Every kind a skill header may legally declare. */
export const SKILL_KINDS: readonly string[] = ["process", "domain", "meta"];

/** Every phase name a skill header may legally declare. */
export const KNOWN_PHASES: readonly string[] = PHASE_ORDER;
