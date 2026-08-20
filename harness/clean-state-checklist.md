# Clean State Checklist

Run this before starting any phase to ensure deterministic state.

## Git

- [ ] Working tree clean (`git status --porcelain` empty)
- [ ] On correct branch (not detached HEAD)
- [ ] No pending rebase/merge/cherry-pick

## Harness

- [ ] `harness/config.json` exists and valid
- [ ] Current phase matches what we're about to run
- [ ] `harness/progress.md` has latest Session State
- [ ] `harness/features/feature-list.json` up-to-date

## Environment

- [ ] Dependencies installed
- [ ] Required services running
- [ ] No stale background processes
