---
name: capability-acquisition
description: The capability ladder — HAVE, ACQUIRE, CREATE, KEEP — for skills, MCP servers, and tools
tags: [meta, capability, acquire, search, skill, mcp, tool, ladder, library]
when: a task needs knowledge, system access, or an executable the project lacks
phases: []
provenance: { origin: built-in }
---

# Capability Acquisition — The Ladder

Your task needs something the library lacks. Resolve it with the ladder —
and register what you find so the NEXT task starts at Tier 0.

## Step 1 — Decide the capability TYPE

- Need **knowledge or method** (how to do X well) → a **skill**
- Need to **interact with an external system** (DB, API, browser, tracker) → an **MCP server**
- Need a **repeatable executable action** (reset fixtures, run a codemod) → a **tool**
- Need a **fact** (does API X support Y?) → follow `research.md` — findings
  saved under `docs/research/` with frontmatter become matchable facts

## Step 2 — ACQUIRE: search the sources

```
dev-harness capability search "<2-4 keywords>" --type skill|mcp|tool
```

This queries the machine-queryable registries directly (npm, MCP registry,
GitHub, crates, …). Browse-only sources are listed after — use them only
if you have web access.

**Choosing among hits** (in order): trust tier (official > curated >
community) → actively maintained → widely used → known author →
permissive license (MIT/Apache/BSD) → small and composable. NEVER adopt a
framework that wants to own your whole process — the harness owns the
process.

**Adapt, don't adopt.** Whatever you take: trim it to the useful core,
re-point references to harness surfaces (DOMAIN.md, feature-list,
learn/decision), add an attribution line (source + license), then register:

```
dev-harness capability add skill <path> --from <url>
dev-harness capability add mcp <name> --command npx --args -y,<pkg>@<exact-version> \
  --tags ... --description "..." --trust curated
dev-harness capability add tool <file> --run "..." --tags ... --description "..."
```

**MCP security (hard rules):** pin exact versions (`pkg@1.2.3`, never
`@latest`); community-tier servers need `--force` after you review their
source; secrets go through env indirection, never into configs.

## Step 3 — CREATE: nothing usable exists

```
dev-harness capability create skill|tool|mcp <name>
```

- skill → fill the stub per `writing-skills.md`
- tool → implement per `building-tools.md`
- mcp → the scaffold is a WORKING server; fill in handlers per
  `building-mcp-servers.md`, verify with its self-test, then register

## Step 4 — Budget and fallback (never block the pipeline)

Acquisition fits ONE working session. If the search didn't conclude, or you
have no network:

1. Record the gap: `dev-harness learn "capability gap: <what was needed>"`
2. Proceed with general best practices — a missing skill is not a blocked task
3. The gap resurfaces via `dev-harness capability gaps` for a later pass
