<!--
Kept in docs/, not in harness/skills/.

pi loads every .md in a declared skills directory as a skill and requires
`name` and `description` frontmatter on each. A README has neither, so leaving
it beside the skills made pi print a skill conflict on every start.
`tests/skills.test.ts` now fails if anything in harness/skills/ would do that.
-->

# Craft Skills

How to do the work WELL — the engineering discipline behind each pipeline
phase. The phase docs (`harness/docs/phases/`) say *what* to produce; these
skills say *how* an expert produces it.

They ship with the package, so pi loads them wherever it is installed: the
model can invoke any of them by name, and `/skill:<name>` lists them.

**The brief names the ones that match the work in hand.** Each skill declares
what it is for, so the brief can route:

```yaml
kind: domain                                    # process | domain | meta
phases: [plan, build, verify]                   # leading phase counts most
tags: [concurrency, race, lock, mutex, deadlock] # vocabulary a task would use
```

- **`process`** — how to work in a phase. Belonging to the phase is enough;
  TDD is the right answer for a BUILD task whatever the task says.
- **`domain`** — a subject area. Surfaces only when the task shares its
  vocabulary. Nobody needs the database skill for being in BUILD.
- **`meta`** — growing the toolkit. Vocabulary only, never a phase.

Read the one the brief names before you start. Each is short, and it changes
what you do.

## Process skills

| Skill | Leads | One-liner |
|-------|-------|-----------|
| `grilling.md` | DEFINE | Stress-test the spec with relentless questions |
| `domain-modeling.md` | DEFINE | Pin down domain terms before writing code |
| `research.md` | DEFINE | Answer questions from primary sources only |
| `planning-tasks.md` | PLAN | Break specs into tracer-bullet vertical slices |
| `codebase-design.md` | PLAN | Design deep modules behind small interfaces |
| `prototype.md` | PLAN | Throwaway code that answers a design question |
| `tdd.md` | BUILD | Red → green loop; tests worth keeping |
| `self-review.md` | BUILD | The pass that runs before every validate |
| `diagnosing-bugs.md` | VERIFY | Build a feedback loop before hypothesising |
| `code-review.md` | REVIEW | Two-axis review: standards + spec |
| `resolving-merge-conflicts.md` | any | Resolve conflicts by original intent |
| `context-hygiene.md` | any | Externalise discoveries the moment they happen |
| `scope-discipline.md` | any | The contract is the boundary; park everything else |
| `stuck-protocol.md` | any | Stop thrashing, escalate cleanly |

## Domain skills

Matched by vocabulary, not by phase:

`databases` · `http-apis` · `auth-security` · `frontend-ui` ·
`testing-infra` · `concurrency-async` · `performance` ·
`error-handling-logging` · `config-and-secrets` · `cli-design` ·
`pi-todo-adapted`

## Meta skills

| Skill | Purpose |
|-------|---------|
| `capability-acquisition.md` | HAVE → ACQUIRE → CREATE → KEEP |
| `writing-skills.md` | How to author a skill worth keeping |
| `building-tools.md` | Standards for a project script anyone can run |

Growing the library is part of the job. A skill you write into
`.pi/skills/<name>.md` is loaded by pi on the next start — there is nothing to
register — and committing it means the next session starts one rung higher.

## Adding one here

Frontmatter is a strict subset: `key: value`, `key: [a, b]`, `key: { k: v }`.
No block scalars, no multi-line values. `name` must match the filename, be
lowercase `a-z0-9-`, and `description`, `kind` and `phases` must all be
present and valid — `npm test` enforces every one of those, because pi only
warns and it warns on every single start.

## Attribution

Skills marked "Adapted from mattpocock/skills" derive from
[Matt Pocock's skills repository](https://github.com/mattpocock/skills)
(MIT License, © 2026 Matt Pocock), adapted for the infinity-harness pipeline.
