---
name: context-hygiene
description: Externalize state before it decays — write discoveries down, re-read instead of remember
tags: [meta, context, memory, handoff, session, notes, playbook]
when: any long session, and always before ending one
phases: []
kind: process
provenance: { origin: built-in, notes: frontier-playbook }
---

# Context Hygiene

Your working memory decays and your session will end — possibly mid-task.
Everything that matters must live in files, not in your head. The next
session (you, another agent, a human) starts from what was WRITTEN.

## Rules

- **Externalize at the moment of discovery**, not "later":
  - Surprise, gotcha, non-obvious behavior → `harness/lessons-decisions.md "..."`
  - Design choice with a why → `infinity-harness decision "..."`
  - Resolved terminology → `harness/docs/DOMAIN.md`
  - Verified fact about an API/tool → `docs/research/` (with frontmatter)
- **Re-read instead of remember.** Before acting on something you learned
  a while ago (a file's shape, a config value), read it again — it may
  have changed, and your memory of it degrades silently.
- **Carry one slice.** Work on the current task only; when adjacent
  problems surface, write them down (learn / feature-list backlog) and
  return to the slice. Holding five threads drops four.
- **Commit = checkpoint your understanding.** Commit after every validated
  step with a message that says WHY, not just what. Uncommitted work +
  ended session = archaeology for the next one.
- **Before exiting — the clock-out ritual:**
  1. Record any un-captured discoveries (`learn`) and choices (`decision`)
  2. Commit (`git commit -am "session: <state + what's next>"`)
  3. The harness writes `session-handoff.md` at boundaries — make sure
     what YOU know that it doesn't is in progress notes or lessons

## Anti-patterns

- **"I'll remember"** — across an iteration boundary, you won't exist.
  Write it down.
- **Giant uncommitted diffs** spanning multiple concerns — impossible to
  hand off, painful to bisect. Commit per validated slice.
- **Notes in chat/scratch only** — anything not in the repo doesn't exist
  for the next session.

## Checklist (end of any session)

- [ ] Lessons/decisions recorded for everything non-obvious found
- [ ] Working tree committed with a why-message
- [ ] A stranger could resume from handoff + progress + lessons alone
