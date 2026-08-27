---
name: deep-research
description: Deep prior-art sweep, synthesis and tradeoff analysis — literature-review level when needed
tags: [research, literature, prior-art, synthesis, constraints, tradeoffs, recommendation, falsification]
when: research depth is standard/deep/comprehensive and the question needs more than a web search
phases: [research]
kind: process
---

# Deep research

Use when `config.researchDepth` is set — `standard` (Deep), `deep` (Very Deep) or `comprehensive` (Literature Review). The wizard only asks when `research` is in the pipeline.

## Depth — what the harness expects

| Depth | Tasks | Sources | Gate | What you deliver |
|-------|-------|---------|------|-----------------|
| `standard` (Deep) | 3 | ≥5 primary, all with URLs | ~800 chars | comparison table, constraints table, ≥3 options |
| `deep` (Very Deep) | 5 | ≥7 primary + gap analysis | ~1800 chars | above + competitive matrix, cost/risk model, risk register |
| `comprehensive` (Literature Review) | 7 | ≥15 annotated bibliography | ~5000 chars | above + benchmarks on a toy case, synthesis, gap analysis, ADR |

Deeper = longer `harness/docs/RESEARCH.md`. The gate reads `config.researchDepth` and enforces the char floor.

## Process

1. Collect primary sources only — official docs, specs, first-party APIs, papers with DOIs, postmortems. Every claim needs a URL or citation.
2. Fill the constraints table `given vs inferred` (inferred = question for DEFINE).
3. Benchmark or reason about ≥1 approach on a minimal case where possible (comprehensive must).
4. Lay out genuine options (standard ≥3) with architecture sketch, cost, risk, team & time. A list of one is a decision wearing a disguise.
5. Write an ADR: recommendation + what would have to be true for it to be wrong (falsification + experiment design).
6. Risk register: known unknowns vs unknown unknowns, mitigations.
7. Ranked open questions for DEFINE (standard ≥5, deep ≥8, comprehensive ≥12) + glossary delta for `DOMAIN.md`.

## Anti-patterns

- No open questions — you did not look hard enough.
- One option presented as inevitable.
- Findings with no source, stated as confidently as sourced ones.
