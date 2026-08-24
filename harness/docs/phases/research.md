# RESEARCH Phase

## Overview
Turn an idea into evidence before anyone writes a specification. RESEARCH is
optional and runs first, before DEFINE. Its output is one document —
`harness/docs/RESEARCH.md` — that a human can read and disagree with.

The phase exists because "build me a thing" is not a specification, and the
cheapest hour of a long run is the one spent finding out what the thing has to
be. A run that gets BUILD wrong fails a gate and retries. A run that got the
idea wrong spends a weekend building the wrong product perfectly.

## When to Use
- The human gave an idea, not a specification
- The problem has prior art worth reading before reinventing it
- There is a real choice of approach and the trade-offs are not obvious
- Skip it when the work is well understood — this phase is off by default

## Craft Skills (read before working)
- `harness/skills/research.md` — answer blocking factual questions from primary sources
- `harness/skills/grilling.md` — attack your own conclusions before a human does
- `harness/skills/scope-discipline.md` — research is not the place to start building

## Process
1. Restate the idea in your own words, including what you are *not* sure about.
2. Find prior art. What already exists that does some of this? What did it get
   right, and where does it stop?
3. Name the constraints that are real: platform, data, budget, deadline, the
   humans who will operate it. Say which ones you were told and which ones you
   inferred, because an inferred constraint is a question for the human.
4. Lay out the genuine options — at least two — with what each costs and what
   each buys. An option list of one is a decision wearing a disguise.
5. Recommend one, and say what would have to be true for the recommendation to
   be wrong. That sentence is the most useful line in the document.
6. List the open questions a human has to answer. These become the DEFINE
   interview.
7. Write all of it to `harness/docs/RESEARCH.md`.
8. Run `infinity_validate`. On PASS the harness advances to DEFINE — or, if the
   human asked to approve this phase, it stops and waits for their signature.

## Rationalizations to Avoid
| Excuse | Rebuttal |
|--------|----------|
| "I already know how to build this" | Then the phase costs you ten minutes and confirms it |
| "I'll research as I go" | Research during BUILD arrives after the decisions it should have informed |
| "There's no prior art" | There is. You have not looked yet |

## Red Flags
- A document with no open questions — you did not look hard enough
- One option presented as inevitable
- Findings with no source, stated as confidently as findings with one
- Research that has already chosen the file layout: that is PLAN's job

## Verification
- [ ] `harness/docs/RESEARCH.md` exists and says something a human could argue with
- [ ] Prior art named, not gestured at
- [ ] At least two options, with costs
- [ ] A recommendation, and what would falsify it
- [ ] Open questions listed for DEFINE
- [ ] `infinity_validate` passes

## Handoff
On gate pass: the harness advances to DEFINE (Researcher → Planner). The open
questions from this document are the DEFINE interview.
