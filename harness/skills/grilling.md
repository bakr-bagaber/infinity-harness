---
name: grilling
description: Stress-test a spec or plan with relentless one-at-a-time questions before committing
tags: [grill, spec, requirements, questions, stress, interview, scope, clarify]
when: before proposing the sprint contract, or when a plan feels underspecified
phases: [research, define]
kind: process
provenance: { origin: "mattpocock/skills", license: MIT, adapted: true }
---

# Grilling — Stress-Test the Spec

> Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT © Matt Pocock).
> Use during: DEFINE (before the sprint contract is agreed).

A spec that hasn't been grilled is a guess. Before proposing the sprint
contract, interrogate the plan until it stops changing.

## With a human available (copilot mode)

Interview the human relentlessly about every aspect of the spec until you
reach shared understanding. Walk down each branch of the decision tree,
resolving dependencies between decisions one by one.

- Ask questions **one at a time** — wait for each answer before continuing.
  Multiple questions at once are bewildering.
- For each question, provide your **recommended answer**.
- If a *fact* can be found by exploring the environment (filesystem, code,
  docs), look it up rather than asking. The *decisions* are the human's —
  put each one to them.
- Do not propose the contract until the human confirms shared understanding.

## Without a human (autopilot mode) — self-grill

Ask the questions anyway, and answer each with your best recommendation.
Write the question + answer pairs into `specs/prd.md` under
"## Resolved Questions" so a human can audit them later. Standard probes:

- Who uses this, and what do they do the moment it works?
- What is explicitly OUT of scope this sprint?
- What's the smallest end-to-end slice that proves the concept?
- What breaks first under bad input / no network / concurrent use?
- How will we KNOW it works — what command or check proves it?
- What existing code/library already does part of this?
- What's the most likely way this plan fails, and what's the fallback?

Any question you cannot answer confidently becomes an exclusion in the
sprint contract or a research task (`harness/skills/research.md`) — never
a silent assumption.
