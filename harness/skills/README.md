# Craft Skills

How to do the work WELL — the engineering discipline behind each pipeline
phase. The phase docs (`harness/docs/phases/`) say *what* to produce; these
skills say *how* an expert produces it.

`the infinity_brief tool` matches skills to your current task and points you at
the right ones. Read the referenced skill BEFORE working — it is short and
it will change what you do. Find skills yourself:
`infinity-harness capability match "<your task>"`.

## Process skills (phase-mapped)

| Skill | Use during | One-liner |
|-------|-----------|-----------|
| `grilling.md` | DEFINE | Stress-test the spec with relentless questions |
| `domain-modeling.md` | DEFINE | Pin down domain terms before writing code |
| `research.md` | DEFINE, anytime | Answer questions from primary sources only |
| `planning-tasks.md` | PLAN | Break specs into tracer-bullet vertical slices |
| `codebase-design.md` | PLAN, SIMPLIFY | Design deep modules behind small interfaces |
| `tdd.md` | BUILD | Red → green loop; tests worth keeping |
| `prototype.md` | BUILD | Throwaway code that answers a design question |
| `diagnosing-bugs.md` | VERIFY, anytime | Build a feedback loop before hypothesizing |
| `code-review.md` | REVIEW | Two-axis review: standards + spec |
| `resolving-merge-conflicts.md` | anytime | Resolve conflicts by original intent |

## Domain skills (task-matched by tags)

`databases` · `http-apis` · `auth-security` · `frontend-ui` ·
`testing-infra` · `concurrency-async` · `performance` ·
`error-handling-logging` · `config-and-secrets` · `cli-design`

## Frontier playbook (how a strong model operates)

| Skill | Delivery surface |
|-------|-----------------|
| `self-review.md` | Its pass runs before EVERY validate (briefs remind you) |
| `stuck-protocol.md` | Referenced when retries fail — stop thrashing, escalate cleanly |
| `context-hygiene.md` | Externalize discoveries the moment they happen |
| `scope-discipline.md` | The contract is the boundary; park everything else |

## The capability ladder (meta-skills)

| Skill | Purpose |
|-------|---------|
| `capability-acquisition.md` | HAVE → ACQUIRE → CREATE → KEEP, for skills/MCP/tools |
| `writing-skills.md` | How to author a skill worth keeping |
| `building-mcp-servers.md` | Scaffold, fill handlers, self-test, register |
| `building-tools.md` | Project tool standards + registration |

Growing the library IS part of the job: acquired and created capabilities
are registered (`infinity-harness capability add ...`) so the next task starts
ahead. Export your accumulated skills across projects:
`infinity-harness capability export`.

## Attribution

Skills marked "Adapted from mattpocock/skills" derive from
[Matt Pocock's skills repository](https://github.com/mattpocock/skills)
(MIT License, © 2026 Matt Pocock), adapted for the infinity-harness pipeline.
