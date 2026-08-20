---
name: http-apis
description: HTTP/REST API design — resources, status codes, errors, versioning, pagination, idempotency
tags: [api, http, rest, endpoint, route, json, status, error, versioning, pagination, webhook, request, response]
when: task designs or implements HTTP endpoints or consumes external APIs
phases: [plan, build]
provenance: { origin: built-in }
---

# HTTP APIs

## Rules

- **Resources, not verbs.** `POST /orders`, `GET /orders/:id` — the verb is
  the method. RPC-ish actions get a sub-resource: `POST /orders/:id/cancel`.
- **Status codes carry meaning:** 200 ok · 201 created (+ `Location`) ·
  204 no body · 400 client sent garbage · 401 unauthenticated ·
  403 unauthorized · 404 absent (also for "exists but not yours") ·
  409 conflict · 422 validation · 429 throttled · 5xx = OUR bug, never the
  client's. Don't return 200 with `{"error": ...}`.
- **One error shape everywhere:**

  ```json
  { "error": { "code": "ORDER_NOT_CANCELLABLE", "message": "Order already shipped", "details": [] } }
  ```

  `code` is machine-stable (clients switch on it); `message` is for humans
  and may change.
- **Validate at the edge.** Reject unknown fields, wrong types, and
  out-of-range values with 400/422 naming the field. Never let bad input
  deep into the system.
- **Mutations are idempotent or idempotency-keyed.** PUT/DELETE naturally;
  POST that charges/creates accepts an `Idempotency-Key` header and
  dedupes retries — networks WILL retry.
- **Paginate every list** from day one (cursor > offset for anything that
  grows). Return `next_cursor`; cap page size.
- **Version in the path** (`/v1/`) and only break within a version never.
  Additive changes (new optional fields) don't need a bump.
- **Timeouts + retries on everything you CALL:** explicit connect/read
  timeouts, retry only idempotent calls, exponential backoff + jitter,
  honor `Retry-After`.

## Anti-patterns

- **Chatty endpoints** — client needs 5 calls to render one screen → add a
  composed read endpoint; don't make the client an orchestrator.
- **Tunneling through POST /doThing** with a type field → separate routes;
  observability and auth depend on it.
- **Leaking internals** — DB column names, stack traces, ORM errors in
  responses → map to the error shape at the boundary.
- **Webhooks without verification** — sign payloads (HMAC), verify
  signature + timestamp, respond 2xx fast and process async.

## Checklist

- [ ] Every endpoint: documented method+path, request/response example, error codes
- [ ] Error shape uniform; codes machine-stable
- [ ] Lists paginated; mutations idempotent or keyed
- [ ] Outbound calls have timeouts, bounded retries, backoff
- [ ] Contract exercised by an integration test hitting real routes
