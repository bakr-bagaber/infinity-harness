---
name: stuck-protocol
description: What to do after repeated failures — stop, write down, reframe once, escalate cleanly
tags: [meta, stuck, retry, failure, escalate, blocked, playbook]
when: the same step has failed 2-3 times, or you notice you are looping
phases: []
provenance: { origin: built-in, notes: frontier-playbook }
---

# Stuck Protocol

Thrashing — trying variations of the same failing approach — burns retries
and context while teaching nothing. Frontier models notice the loop and
break it deliberately.

## The trigger

**Three failed attempts at the same step = STOP.** Also stop when you
catch any of these tells:

- You're re-running the same command hoping for a different result
- Each "fix" is a small mutation of the last failed fix
- You can no longer say what NEW information the last attempt produced

## The protocol

1. **Write down what you know** (before trying anything else):
   what you're trying to achieve, the exact error/failure, the attempts
   made, and what each attempt ruled out. Writing this usually exposes the
   gap — half the time you solve it here.
2. **Re-read the brief and the skill** (`dev-harness next`; the skill it
   references). Stuck often means a constraint was missed, not that the
   problem is hard.
3. **Reframe ONCE** — one genuinely different angle, not a variation:
   different seam, smaller slice, different tool, the inverse operation,
   or build the feedback loop you skipped (`diagnosing-bugs.md` Phase 1).
4. **Escalate cleanly** if the reframe fails:
   - `dev-harness learn "BLOCKED <step>: tried A, B, C; ruled out X, Y; suspect Z"`
   - Leave the tree committed and green-adjacent (no half-applied change)
   - Let validate fail honestly — the retry ladder and the human exist for
     exactly this. A clean escalation with evidence is a GOOD outcome;
     a fourth identical attempt is not.

## Rules

- Never delete the failing evidence (test, error output) to make the step
  "pass".
- Never widen scope to route around the blocker ("I'll just rewrite the
  module") — that's thrash with more damage.
- The write-down in step 1 is mandatory, not optional — it's what makes
  the human's (or next session's) job possible.
