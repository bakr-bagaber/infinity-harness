# Evaluator Rubric

Score each dimension 0-2:

| Score | Meaning |
|-------|---------|
| 0 | Unacceptable (blocker — must fix) |
| 1 | Acceptable with minor issues |
| 2 | Excellent (no issues) |

## Scorecard

| Dimension | Score | Evidence | Notes |
|-----------|-------|----------|-------|
| **Correctness** | 0-2 | [test results] | Does it work? |
| **Test Coverage** | 0-2 | [coverage report] | ≥80%? |
| **Code Quality** | 0-2 | [lint output] | Clean? Idiomatic? |
| **Security** | 0-2 | [scan results] | Vulnerabilities? |
| **Performance** | 0-2 | [benchmarks] | Regressions? |
| **Handoff Readiness** | 0-2 | [docs updated] | Next agent can continue? |

## Thresholds

| Total Score | Outcome |
|-------------|---------|
| 10-12 | Accept (pass gate) |
| 5-9 | Revise (fix issues, re-check) |
| 0-4 | Block (escalate to human) |
