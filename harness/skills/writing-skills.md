---
name: writing-skills
description: How to author a skill worth keeping — scope, structure, frontmatter, quality bar
tags: [meta, skill, writing, author, documentation, checklist]
when: creating a new skill or adapting an acquired one
phases: []
kind: meta
provenance: { origin: "mattpocock/skills writing-great-skills", license: MIT, adapted: true }
---

# Writing Skills

A skill is a reusable instruction file that changes how the work gets done.
The test: **would a weak model do the right thing following ONLY this
file?** If not, it's not done.

## Rules

- **One job per skill.** "databases" not "backend-development". If you're
  writing "and also…", split it.
- **Rules + anti-patterns + checklist** — that structure, every time.
  Rules are imperative and checkable. Anti-patterns show what going wrong
  looks like AND the fix. The checklist is how the reader verifies they
  applied it.
- **≤120 lines of body.** Longer means it's two skills or it's a tutorial.
- **Concrete over abstract.** One short example beats three paragraphs of
  principle. Name real commands, real file paths, real error messages.
- **Frontmatter required** (the matcher is blind without it):

```yaml
---
name: kebab-case-name
description: One line, 10-300 chars — what this teaches
tags: [five, or, more, search, keywords]        # ≥3 required; think "what words appear in tasks that need this?"
when: the task signal that should trigger this skill
phases: [build]                                  # optional phase affinity
provenance: { origin: self-authored, authoredBy: agent }
---
```

Frontmatter uses a strict subset: `key: value`, `key: [a, b]`,
`key: { k: v }` — no multiline YAML.

- **Tag for the matcher.** Tags are matched against task text — use the
  nouns a task description would actually contain ("postgres", "auth",
  "migration"), not categories ("backend").

## Anti-patterns

- **The essay** — background, history, philosophy. Delete everything that
  doesn't change what the reader does next.
- **The mirror** — restating what the harness already enforces (gates,
  phases). Skills teach craft, not process.
- **The wishlist** — "consider…", "you might…". Skills say DO and DON'T.

## Checklist

- [ ] Frontmatter is complete: `name` matching the filename, `description`, `kind`, `tags`, `when`, `phases`
- [ ] A cold reader knows exactly what to do and how to check they did it
- [ ] Every rule is checkable; every anti-pattern has a fix
- [ ] Attribution line present if adapted from elsewhere
