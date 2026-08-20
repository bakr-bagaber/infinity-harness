---
name: planning-tasks
description: Break specs into tracer-bullet vertical slices with checkable acceptance criteria
tags: [plan, planning, slice, ticket, decompose, criteria, backlog, breakdown, refactor]
when: writing or restructuring the feature list from a spec
phases: [plan]
provenance: { origin: "mattpocock/skills", license: MIT, adapted: true }
---

# Planning Tasks — Tracer-Bullet Vertical Slices

> Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT © Matt Pocock, "to-tickets").
> Use during: PLAN (writing harness/features/feature-list.json).

Break the spec into **tracer-bullet vertical slices** and record them as
features + tasks in `harness/features/feature-list.json`.

## Vertical slice rules

- Each slice cuts a narrow but COMPLETE path through every layer (schema,
  logic, interface, tests) — vertical, NOT a horizontal slice of one layer.
- A completed slice is demoable or verifiable on its own.
- Each task is sized to fit one working session / fresh context window.
- Prefactoring goes first: "make the change easy, then make the easy change."
- Order features so each builds on completed ones — the harness works them
  top to bottom.

## Writing the feature list

```json
{
  "version": "0.1",
  "features": [
    {
      "id": "feature-001",
      "name": "User can create a note",
      "description": "End-to-end: POST /notes → stored → retrievable",
      "passes": false,
      "definitionOfDone": [
        "POST /notes with valid body returns 201 + id",
        "GET /notes/:id returns the stored note",
        "Invalid body returns 400 with error message"
      ],
      "tasks": [
        {
          "id": "task-001",
          "description": "Note model + storage with create/get",
          "status": "pending",
          "acceptanceCriteria": [
            "createNote(data) returns note with generated id",
            "getNote(id) returns the created note",
            "getNote(unknown) returns null"
          ]
        }
      ]
    }
  ]
}
```

Rules for criteria:

- **acceptanceCriteria** (task) — 1–3 concrete, checkable statements about
  observable behavior. "Works correctly" is not a criterion; "getNote(unknown)
  returns null" is. Gates reject empty or placeholder criteria.
- **definitionOfDone** (feature) — user-visible outcomes proving the whole
  slice works end-to-end.
- Name features in **user terms** ("User can X"), not layer terms ("Add DB
  table").
- Use the project's domain vocabulary (`harness/docs/DOMAIN.md`).

## Wide refactors — the exception

A **wide refactor** (rename a shared symbol, retype a column) breaks
thousands of call sites at once; no vertical slice can land green. Sequence
it as **expand–contract**: one task to add the new form beside the old, then
migration tasks in batches (per package/directory) that stay green because
the old form still exists, then one task to delete the old form once no
caller remains.

## Sanity check before finishing PLAN

- Does each feature deliver something demoable?
- Is anything blocked by a feature that comes AFTER it? (Reorder.)
- Too coarse (task needs multiple sessions) or too fine (trivial edits)?
- Zero placeholder text left anywhere in the file.
