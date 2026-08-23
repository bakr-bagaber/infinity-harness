---
name: databases
description: Relational database craft — schema design, migrations, transactions, indexing, query safety
tags: [database, db, sql, postgres, postgresql, mysql, sqlite, schema, migration, transaction, index, query, orm, persistence, storage]
when: task touches persistent data, schemas, queries, or migrations
phases: [plan, build, verify]
kind: domain
provenance: { origin: built-in }
---

# Databases

## Rules

- **Schema first, code second.** Write the DDL (tables, types, constraints)
  before the access code. Constraints in the database (`NOT NULL`, `UNIQUE`,
  `FOREIGN KEY`, `CHECK`) beat validation in code — code has bugs; the
  constraint never sleeps.
- **Every schema change is a migration file** — forward-only, numbered,
  committed, and runnable from scratch (`migrate` on an empty DB must
  produce the current schema). Never edit an applied migration; add a new one.
- **Transactions around invariants.** Any multi-statement change that must
  hold together goes in one transaction. Name the invariant in a comment.
- **Parameterized queries only.** String-built SQL is an injection —
  no exceptions, including "internal" tooling.
- **Index what you filter/join/sort on** — but only with evidence: add the
  index when a real query needs it (EXPLAIN shows a scan), not
  speculatively. Every index taxes writes.
- **IDs:** prefer surrogate keys (bigint identity or UUIDv7); natural keys
  get UNIQUE constraints instead.
- **Timestamps:** store UTC (`timestamptz` in Postgres), convert at the edge.
- **Money/decimals:** exact types (`NUMERIC`), never floats.

## The N+1 rule

If you query in a loop, you have an N+1. Fix with a join, an `IN` batch,
or a dataloader — before it ships, not after the incident. Tell: page
loads trigger a query count proportional to row count.

## Migration safety (live systems)

Expand → migrate → contract: add the new column/table (nullable or
defaulted) → backfill + dual-write → switch reads → drop the old thing in
a LATER migration once nothing references it. Never rename or drop in the
same deploy that changes code.

## Anti-patterns

- **SELECT \*** in application code → name the columns; schema drift breaks
  you silently otherwise.
- **Soft-delete everywhere by default** → only where restore/audit is a real
  requirement; otherwise it poisons every query with `WHERE deleted_at IS NULL`.
- **Business logic in triggers** → invisible control flow; keep triggers to
  bookkeeping (updated_at) if used at all.
- **Testing against mocks of the DB** → test against a real (local/ephemeral)
  database; SQLite-in-memory only when production is SQLite.

## Checklist

- [ ] Schema has constraints for every invariant you rely on
- [ ] Migrations replay clean on an empty database
- [ ] No string-concatenated SQL anywhere
- [ ] Hot queries EXPLAINed; indexes justified by a real plan
- [ ] Tests hit a real database engine matching production
