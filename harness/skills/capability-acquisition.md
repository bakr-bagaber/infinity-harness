---
name: capability-acquisition
description: The capability ladder — HAVE, ACQUIRE, CREATE, KEEP — for skills, extensions and project scripts
tags: [meta, capability, acquire, search, skill, extension, tool, script, ladder, library]
when: a task needs knowledge, an integration, or an executable the project lacks
phases: []
kind: meta
provenance: { origin: built-in }
---

# Capability Acquisition — The Ladder

The task needs something you do not have. Work the ladder in order, and leave
the result behind so the next task starts one rung higher.

pi has three kinds of capability. Pick the right shape first — most wasted
effort here is building the wrong one.

| You need | Build | Lives in |
|---|---|---|
| Knowledge or method — how to do X well | a **skill** | `.pi/skills/<name>.md` |
| A repeatable action — reset fixtures, run a codemod | a **script** | the repo, run through bash |
| A tool the model can call, or a slash command | an **extension** | its own package, `pi install`ed |
| A fact — does API X support Y? | neither | `research.md`, written into `harness/docs/` |

## 1 — HAVE: check before you build

- **Skills already loaded.** This package ships 28. The brief names the ones
  that match the current task; `/skill:<name>` invokes any of them.
- **Scripts already in the repo.** `package.json` scripts, `Makefile`,
  `scripts/`. Read before you write — the thing you are about to build is
  often already there under a name you did not guess.
- **Extensions already installed.** `pi list`.

## 2 — ACQUIRE: take what exists

- **A skill** is plain markdown. Copy one in, then *adapt* it: trim to the
  useful core, re-point its references at this project's surfaces, and add an
  attribution line naming the source and its licence.
- **An extension**: `pi install npm:<pkg> -l` (project-local, so the team gets
  it through `.pi/settings.json`) or `pi install git:<host>/<repo>`. Pin the
  version, and read what it registers before you trust it.

**Choosing among candidates**, in order: actively maintained → widely used →
permissive licence (MIT/Apache/BSD) → small and composable. Never adopt
something that wants to own the whole process — the harness owns the process.

## 3 — CREATE: nothing usable exists

- **A skill** → write it per `writing-skills.md` into `.pi/skills/<name>.md`.
  pi loads it on the next start. There is nothing to register.
- **A script** → build it per `building-tools.md`, and name it where a cold
  reader will look (`AGENTS.md`, or `package.json` scripts).
- **An extension** → only when the capability has to be a tool the model calls
  or a slash command. It is a package with a `pi.extensions` entry;
  `pi install ./<dir> -l` loads it straight from a checkout.

## 4 — KEEP: or you will do this again

A capability that lives only in this session is not a capability.

- **Commit it.** A skill in `.pi/skills/` and a script in the repo both travel
  with the project.
- **Make it findable.** Tags in a skill's frontmatter are how the brief
  surfaces it later; a script nobody can find is a script nobody runs.

## 5 — Budget: never block the pipeline

Acquisition fits inside one working session. If it does not conclude, or you
have no network:

1. Record the gap in `harness/lessons-decisions.md` — what was needed, what
   you tried, what you would try next.
2. Carry on with general best practice. A missing skill is not a blocked task,
   and it is never a reason to mark work complete that is not.
