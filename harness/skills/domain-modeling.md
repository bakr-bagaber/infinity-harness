---
name: domain-modeling
description: Pin down domain terminology — glossary discipline and decision records
tags: [domain, glossary, terminology, naming, model, ubiquitous, language, adr, decision]
when: defining specs, resolving fuzzy or conflicting terms, recording decisions
phases: [define, plan]
provenance: { origin: "mattpocock/skills", license: MIT, adapted: true }
---

# Domain Modeling

> Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT © Matt Pocock).
> Use during: DEFINE (before writing the spec), and whenever terminology gets fuzzy.

Actively build and sharpen the project's domain model as you design.
The glossary lives in `harness/docs/DOMAIN.md`; decisions live in
`harness/docs/DECISIONS.md`. Create `DOMAIN.md` the moment the first term
is resolved — not before, and not "later".

## The habits

### Sharpen fuzzy language
When a vague or overloaded term appears ("account", "job", "sync"), propose
a precise canonical term. "You're saying 'account' — do you mean the
Customer or the User? Those are different things." One concept, one name,
everywhere: spec, code, tests, docs.

### Challenge against the glossary
When new text conflicts with an existing definition in `DOMAIN.md`, call it
out immediately and resolve which meaning wins. Never let two meanings
coexist silently.

### Stress-test with concrete scenarios
When domain relationships are being defined, invent specific scenarios that
probe the edges. "A customer cancels half an order that already partially
shipped — what happens to the invoice?" Force the boundaries between
concepts to be precise.

### Cross-reference with code
When someone states how something works, check whether the code agrees. If
the code cancels entire Orders but the spec says partial cancellation is
possible — surface the contradiction now, not in BUILD.

### Update DOMAIN.md inline
When a term is resolved, write it down right there. Don't batch. Format:

```markdown
## Terms

### Order
A customer's confirmed request to purchase. Created at checkout; immutable
once `shipped`. NOT the same as a Cart (pre-checkout, mutable).
```

`DOMAIN.md` is a glossary and nothing else — no implementation details, no
scratch notes, no specs.

### Record decisions sparingly
Record a decision (`infinity-harness decision "..."`) only when all three hold:

1. **Hard to reverse** — changing your mind later costs something real
2. **Surprising without context** — a future reader would ask "why?"
3. **A real trade-off** — genuine alternatives existed and you picked one

If any is missing, skip it. Noise buries signal.
