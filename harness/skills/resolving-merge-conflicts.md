---
name: resolving-merge-conflicts
description: Resolve git merge/rebase conflicts by original intent, verify, and finish
tags: [git, merge, rebase, conflict, branch, hunk]
when: an in-progress git merge or rebase has conflicting hunks
phases: []
provenance: { origin: "mattpocock/skills", license: MIT, adapted: true }
---

# Resolving Merge Conflicts

> Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT © Matt Pocock).
> Use during: any in-progress git merge/rebase conflict.

1. **See the current state** of the merge/rebase. Check git history and the
   conflicting files.
2. **Find the primary sources** for each conflict. Understand deeply why
   each change was made and what the original intent was: read commit
   messages, PRs, the feature list entries, and progress log
   (`harness/progress.md`).
3. **Resolve each hunk.** Preserve both intents where possible. Where
   incompatible, pick the one matching the merge's stated goal and note the
   trade-off. Do **not** invent new behaviour. Always resolve; never
   `--abort`.
4. **Run the project's automated checks** — typecheck, then tests, then
   lint (`the infinity_validate tool` runs the configured set). Fix anything the
   merge broke.
5. **Finish the merge/rebase.** Stage everything and commit. If rebasing,
   continue until all commits are rebased. Record anything surprising:
   `harness/lessons-decisions.md "..."`.
