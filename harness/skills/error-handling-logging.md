---
name: error-handling-logging
description: Error taxonomy, fail-loud handling, structured logging that debugs itself
tags: [error, exception, logging, log, observability, retry, crash, handling, monitoring, trace]
when: task defines error paths, adds logging, or hardens failure behavior
phases: [build, verify]
provenance: { origin: built-in }
---

# Error Handling & Logging

## Rules

- **Two kinds of errors, two behaviors.** *Expected/operational* (bad
  input, not-found, downstream timeout): handle at the boundary, map to
  the API error shape, keep serving. *Unexpected/programmer* (undefined is
  not a function, invariant broken): crash loud — log, alert, restart.
  Catching-and-continuing a programmer error corrupts state downstream.
- **Catch where you can act.** A catch block must do one of: recover
  meaningfully, translate to the caller's vocabulary (wrapping the cause),
  or add context and rethrow. `catch (e) {}` and log-and-swallow are how
  systems lie about being healthy.
- **Preserve the chain.** When wrapping, keep the original (`cause`), the
  stack, and add what you know: which operation, which IDs, which inputs.
  "Database error" tells nothing; "saving order 123: unique violation on
  idempotency_key" tells everything.
- **Structured logs (JSON), one event per line:** timestamp, level, event
  name, and the IDs someone will grep for at 3am (request_id, user_id,
  order_id). A log line you can't query is decoration.
- **Correlate:** generate/propagate a request_id at the edge; include it
  in every log line and error response. One incident = one grep.
- **Levels mean things:** ERROR = a human should look (alertable);
  WARN = degraded but coping; INFO = state changes worth an audit trail;
  DEBUG = off in production. If ERROR fires routinely, it's WARN or a bug.
- **Never log secrets** — tokens, passwords, full card/PII. Scrub
  centrally at the logger, not at each call site.

## Anti-patterns

- **Stringly errors** (`throw "failed"`) → typed/coded errors the caller
  can switch on; strings can't be handled, only displayed.
- **Retry without classification** — retrying a 400 forever, or not
  retrying a timeout → retry only transient errors, bounded + backoff
  (see `concurrency-async.md` for idempotency).
- **The 500-catch-all that hides the cause** → boundary handler logs the
  full chained error with request_id, returns the safe shape.
- **printf debugging left behind** → tagged temp logs (`[DEBUG-x]`) and a
  cleanup grep before validate (the anti-placeholder gate will catch you).

## Checklist

- [ ] Every catch: recovers, translates, or rethrows with context — no swallows
- [ ] Error responses use the API error shape; internals never leak
- [ ] Logs structured; request_id flows edge→depths
- [ ] ERROR level = actionable only; alert noise is a bug
- [ ] Grep confirms: no secrets in logs, no leftover debug prints
