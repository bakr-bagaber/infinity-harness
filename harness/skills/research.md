---
name: research
description: Answer factual questions from primary sources; capture cited findings in the repo
tags: [research, docs, documentation, investigate, source, facts, api, spec, evidence]
when: a factual question about an API, library, protocol, or tool blocks progress
phases: [define, plan, build]
kind: process
provenance: { origin: "mattpocock/skills", license: MIT, adapted: true }
---

# Research

> Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT © Matt Pocock).
> Use during: DEFINE, or any time a factual question blocks progress.

When a question needs investigating (an API's real behavior, a library's
limits, a protocol detail):

1. Investigate against **primary sources** — official docs, source code,
   specs, first-party APIs — never a secondary write-up of them. Follow
   every claim back to the source that owns it.
2. Write the findings to a single Markdown file under `docs/research/`
   (create it if missing), citing each claim's source.
3. Keep conclusions separate from evidence: a short "Answer" section up
   top, the sourced detail below.
4. Record the headline insight so future sessions inherit it:
   `harness/lessons-decisions.md "research: X behaves like Y (see docs/research/...)"`.

Rules of evidence:

- A claim without a source is a guess. Label guesses as guesses.
- Version matters: note WHICH version of the tool/API the claim covers.
- If two sources disagree, the more primary one wins; note the conflict.
