#!/usr/bin/env bash
#
# run-hermes.sh — Session-enforcement wrapper for Hermes agent with fresh-session enforcement.
#
# Runs Hermes in a loop, each iteration in a FRESH session (no context carryover).
# The dev-harness CLI drives the pipeline; Hermes does the work per task.
# Every transition (task, feature, phase, role) happens in a new session.
#
# Usage:
#   ./run-hermes.sh [project-dir]
#
# If no project-dir is given, uses current directory.
# Requires: dev-harness CLI installed (npm install -g dev-harness-cli)
# Requires: hermes CLI available in PATH
# Requires: jq for JSON parsing
#
# Environment variables:
#   HERMES_BIN     — path to hermes binary (default: hermes)
#   DEV_HARNESS    — path to dev-harness CLI (default: dev-harness)
#   MAX_ITERATIONS — safety limit (default: 100)
#   VERBOSE        — set to 1 for verbose output

set -euo pipefail

PROJECT_DIR="${1:-.}"
HERMES_BIN="${HERMES_BIN:-hermes}"
DEV_HARNESS="${DEV_HARNESS:-dev-harness}"
MAX_ITERATIONS="${MAX_ITERATIONS:-100}"
VERBOSE="${VERBOSE:-0}"

log() { echo "[run-hermes] $*"; }
vlog() { [ "$VERBOSE" = "1" ] && echo "[run-hermes:verbose] $*" || true; }

# Verify dependencies
command -v jq >/dev/null 2>&1 || { echo "Error: jq is required"; exit 1; }
command -v "$HERMES_BIN" >/dev/null 2>&1 || { echo "Error: $HERMES_BIN not found in PATH"; exit 1; }
command -v "$DEV_HARNESS" >/dev/null 2>&1 || { echo "Error: $DEV_HARNESS not found in PATH"; exit 1; }

cd "$PROJECT_DIR"

# Verify this is a harness project
[ -f "harness/config.json" ] || { echo "Error: not a dev-harness project (no harness/config.json)"; exit 1; }

log "Starting session-enforcement loop with Hermes"
log "Project: $(pwd)"
log "Hermes:  $($HERMES_BIN --version 2>/dev/null || echo 'unknown')"
log "Harness: $($DEV_HARNESS --version)"

ITERATION=0
while [ "$ITERATION" -lt "$MAX_ITERATIONS" ]; do
  ITERATION=$((ITERATION + 1))
  vlog "=== Iteration $ITERATION ==="

  # Clock-in: get current state
  STATUS_JSON=$("$DEV_HARNESS" status --json 2>/dev/null || echo '{}')
  PIPELINE_STATUS=$(echo "$STATUS_JSON" | jq -r '.status // "unknown"')
  CURRENT_PHASE=$(echo "$STATUS_JSON" | jq -r '.currentPhase // "null"')
  CURRENT_ROLE=$(echo "$STATUS_JSON" | jq -r '.currentRole // "null"')
  CURRENT_FEATURE=$(echo "$STATUS_JSON" | jq -r '.currentFeature // "null"')
  CURRENT_TASK=$(echo "$STATUS_JSON" | jq -r '.currentTask // "null"')
  NEXT_ACTION=$(echo "$STATUS_JSON" | jq -r '.nextAction // "continue"')

  vlog "Phase: $CURRENT_PHASE | Role: $CURRENT_ROLE | Feature: $CURRENT_FEATURE | Task: $CURRENT_TASK"
  vlog "Next action: $NEXT_ACTION"

  # Check if pipeline is complete
  if [ "$PIPELINE_STATUS" = "complete" ] || [ "$CURRENT_PHASE" = "null" ] && echo "$NEXT_ACTION" | grep -qi "complete"; then
    log "Pipeline complete!"
    "$DEV_HARNESS" status
    exit 0
  fi

  # Determine the task for Hermes
  # Build a task prompt from the current state
  TASK_PROMPT="You are working on a dev-harness project. Current state:
- Phase: $CURRENT_PHASE
- Role: $CURRENT_ROLE
- Feature: $CURRENT_FEATURE
- Task: $CURRENT_TASK
- Next action: $NEXT_ACTION

Read AGENTS.md and harness/docs/phases/${CURRENT_PHASE}.md for instructions.
Follow the workflow: do the work, then call 'dev-harness validate' to check gates.
If gates pass, call 'dev-harness phase next' to advance.
If you are in BUILD phase with a specific feature/task, call 'dev-harness validate --feature $CURRENT_FEATURE --task $CURRENT_TASK'."

  # Run Hermes with a FRESH session (no context carryover)
  # --fresh-session: start a new session with no prior context
  # --exit-on-complete: exit when the task is done (enables the loop)
  log "Starting Hermes session $ITERATION (phase=$CURRENT_PHASE, role=$CURRENT_ROLE)"
  vlog "Task prompt: $TASK_PROMPT"

  $HERMES_BIN \
    --task "$TASK_PROMPT" \
    --fresh-session \
    --exit-on-complete \
    2>&1 | while IFS= read -r line; do echo "[hermes] $line"; done

  HERMES_EXIT=$?
  vlog "Hermes exited with code $HERMES_EXIT"

  # After Hermes exits, check if gates pass and advance
  log "Checking gates..."
  VALIDATE_JSON=$("$DEV_HARNESS" validate --json 2>/dev/null || echo '{}')
  GATES_PASS=$(echo "$VALIDATE_JSON" | jq -r '.overall // false')

  if [ "$GATES_PASS" = "true" ]; then
    log "Gates passed. Advancing to next phase."
    "$DEV_HARNESS" phase next --json 2>/dev/null || true
  else
    log "Gates failed or not all work done. Hermes will retry in next iteration."
    FAILURES=$(echo "$VALIDATE_JSON" | jq -r '.failures // [] | join(", ")')
    [ -n "$FAILURES" ] && log "Failures: $FAILURES"
  fi

  # Check if paused
  PAUSED=$(echo "$STATUS_JSON" | jq -r '.paused // false')
  if [ "$PAUSED" = "true" ]; then
    log "Pipeline is paused. Run 'dev-harness resume' to continue."
    exit 0
  fi
done

log "Reached max iterations ($MAX_ITERATIONS). Check pipeline state with 'dev-harness status'."
exit 1
