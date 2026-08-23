---
name: self-review
description: Structured pass before claiming done — criteria re-check, real run, leftover hunt
tags: [meta, review, verify, done, quality, check, playbook]
when: before running validate on any task — every time
phases: [build, verify, simplify]
kind: process
provenance: { origin: built-in, notes: frontier-playbook }
---

# Self-Review — Before You Claim Done

Frontier models don't submit their first draft; they run this pass. It
takes two minutes and catches the majority of validate failures before
they burn a retry.

## The pass

1. **Re-read the acceptance criteria, one by one, against your diff.**
   For each: point at the line(s) that satisfy it. A criterion you can't
   point at is not met — no matter how done it feels.
2. **Run the thing once, for real.** Not just the tests — the actual entry
   point (start the server, invoke the CLI, render the page). Tests
   passing while the app crashes on boot is a classic.
3. **Hunt leftovers:** debug prints, commented-out code, TODO/FIXME stubs,
   hardcoded test values, files you created but abandoned. (The
   anti-placeholder gate will catch some — beat it to the punch.)
4. **Read the diff as a skeptic:** `git diff` top to bottom. Would a
   reviewer who dislikes you find something? Fix it now.
5. **Check the blast radius:** what ELSE uses what you touched? One
   caller-grep per changed public symbol.

## Rules

- Never validate as a formality — validate expecting to find problems.
- The criteria are the contract; "better than asked" and "close enough to
  asked" are both failures (see scope-discipline.md).
- If step 2 is impossible (no runnable surface), say so in the commit
  message rather than pretending you ran it.

## Checklist

- [ ] Every acceptance criterion mapped to specific lines
- [ ] Entry point actually executed post-change
- [ ] Leftover grep clean (debug/TODO/dead files)
- [ ] Diff read end-to-end; caller-grep done per public change
