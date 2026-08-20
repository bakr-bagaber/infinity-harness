# SHIP Phase

## Overview
Prepare and execute the release. Tag the version, finalize changelog, verify
clean working tree, and ensure all ship gates pass.

## When to Use
- REVIEW phase complete
- Ready to release

## Process
1. Read `harness/progress.md` and `AGENTS.md`
2. Run `dev-harness status` to see current state
3. Finalize `CHANGELOG.md` with version, date, and changes
4. Verify working tree is clean: `git status`
5. Create version tag: `git tag v<version>`
6. Ensure LICENSE, CONTRIBUTING.md exist
7. Run `dev-harness validate` to check ship gates
8. If PASS → `dev-harness phase next` (pipeline complete!)
9. Create checkpoint: `dev-harness checkpoint create release-<version>`

## Rationalizations to Avoid
| Excuse | Rebuttal |
|--------|----------|
| "I'll tag after deploying" | Tag before deploying — you want a known-good rollback point |
| "CHANGELOG can wait" | Users need to know what changed — write it now |
| "Working tree has minor changes" | Ship from clean tree only — commit or stash first |

## Red Flags
- Uncommitted changes in working tree
- No version tag created
- CHANGELOG.md missing or empty
- LICENSE or CONTRIBUTING.md missing

## Verification
- [ ] Working tree clean: `git status` shows no changes
- [ ] Version tag created: `git tag -l "v*"`
- [ ] CHANGELOG.md updated with version + changes
- [ ] README.md, LICENSE, CONTRIBUTING.md exist
- [ ] `dev-harness validate` passes

## Handoff
On gate pass: Pipeline complete! `dev-harness status` shows "Pipeline complete".
