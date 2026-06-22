# ADR-0109: Canonical JSON Seed / Import-Export Schema

## Status
Accepted

## Context
TruePPM's adoption wedge is depth on scheduling and the agile/waterfall bridge,
but depth is invisible on an empty board. Epic #613 ships opinionated **sample
projects** as importable JSON so a new evaluator feels CPM, Monte Carlo, the
hybrid bridge, risks, and resources within five minutes of `make up`.

That requires one canonical JSON format that three consumers normalize to:

1. The bundled **sample projects** (#617–#620) — hand-authored fixtures.
2. The **universal import/export** (#615 / #616) — load a seed, export a live
   program back, re-import it.
3. Downstream **multi-format importers** (Planview/Monday/Asana, a later epic)
   — each adapter normalizes its source to this canonical JSON before persisting.

This ADR (foundation issue #614) defines the schema and the `validate_seed()`
contract only. The import command (#615), export command (#616), and the sample
fixtures are separate issues that build on this.

**P3M layer:** Programs and Projects (OSS). A seed describes a single program and
its projects — never cross-program aggregation. Per ADR-0070 the `Program` entity
is OSS; nothing here crosses the Apache 2.0 boundary. The same canonical schema is
the normalization target Enterprise multi-format importers will reuse, but the
schema, validator, and sample data all live in OSS.

### Forces
- Sample files are **hand-authored** — a typo'd field that silently vanishes is a
  real bug. Validation must be strict and report errors with JSON paths.
- Models use **UUID PKs** and have **no slug fields**. A seed file cannot ship
  UUIDs (they would collide across instances and re-imports). It needs stable,
  human-readable identifiers that survive re-import.
- The launch-demo sample (#620, "Atlas") spans **three projects with
  cross-project dependencies** — the schema must express edges between tasks in
  different projects.
- Three-point estimates obey an **all-or-none invariant** (ADR-0093): a task has
  all three of optimistic/most-likely/pessimistic, or none.
- CPM outputs (`early_start`, float, `is_critical`) and `server_version` are
  **derived** — they must not appear in seed files.

## Decision

A single JSON document, validated against a committed **JSON Schema (draft
2020-12)** at `packages/api/src/trueppm_api/apps/projects/schemas/seed_v1.json`,
exposing `validate_seed(payload) -> None` (raises `SeedValidationError` with a
JSON-path-anchored message) from
`trueppm_api.apps.projects.seed.validation`.

### Top-level shape
```jsonc
{
  "schema_version": "1.0",          // required; importer pins to a supported major.minor
  "program":  { … },                // required: one program (OSS single-program scope)
  "accounts": [ … ],                // user logins referenced by the seed
  "calendars":[ … ],                // working calendars
  "resources":[ … ],                // schedulable resources
  "risks":    [ … ],                // program-scoped risks
  "projects": [ { …, "tasks":[…], "dependencies":[…], "sprints":[…],
                  "baselines":[…], "board_columns":[…], "risks":[…] } ]
}
```

### Stable identity: slugs are a file-local symbol table, not columns
Every referenceable entity in a seed carries a `slug` (or, for tasks, a
`wbs_path`) that is **unique within the file**. Cross-references use those
strings, never UUIDs:

- `task.assignee` / `resource.account` / `risk.owner` / `program.lead` → an
  account `slug`
- `project.calendar` / `resource.calendar` → a calendar `slug`
- `task.sprint` → a sprint `slug`
- `dependency.predecessor` / `dependency.successor` → a task ref (below)
- `risk.tasks[]` / `sprint.target_milestone` → a task ref

At import (#615) these resolve to freshly-minted UUIDs through an in-memory
**symbol table** (slug → UUID). **No slug columns are added to any model** — the
slug is a seed-file concept only, so there is no migration and no schema churn on
the live models.

The one persisted natural key is the **program slug**, written into the existing
`Program.code` field (max 40 — comfortably fits a slug). Re-import idempotency
(#615) is therefore keyed on `(workspace, Program.code)`: re-importing a seed
replaces the program subtree it matches, following the wipe-then-recreate
precedent of ADR-0092's `creates_project` flag. Field-level upsert is a future
enhancement, explicitly out of scope — sample data is disposable.

### Task refs and cross-project dependencies
A task ref is the task's `wbs_path`. Within the enclosing project it is bare
(`"2.1"`); to point at another project it is qualified `"<project_slug>:<wbs_path>"`
(`"migration-tooling:3.4"`). `dependencies` are declared **under each project**
(locality) but may reference tasks in sibling projects, which is how Atlas's
cross-project edges (Platform Core → Migration Tooling → GTM Readiness) are
expressed. The importer resolves both forms through the symbol table.

### WBS as ltree paths
Tasks are identified by `wbs_path` (ltree string, `"1.2.3"`) — the same encoding
the live model stores (ADR-0024). The hierarchy is therefore **explicit and
self-describing in the hand-authored file**: parentage is readable, the importer
reconstructs the tree deterministically and can detect gaps/cycles, and the path
doubles as the per-project task identity used by dependency refs, risk linkage,
and sprint milestone targets. Milestones are tasks with `is_milestone: true`
(there is no separate Milestone entity); summary tasks are interior ltree nodes.

### Three-point estimate as a sub-object
```jsonc
"estimate": { "optimistic": 3, "most_likely": 5, "pessimistic": 9 }
```
not three flat fields. The sub-object makes the **all-or-none invariant
structurally enforceable**: JSON Schema can require all three keys when the
object is present, and forbid a partial estimate — something flat sibling fields
cannot express. It is also the natural extension point for a future
`distribution` discriminator (triangular vs PERT-beta). On import, seeded
estimates set `estimate_status = "ACCEPTED"` (ADR-0093: seed data is PM-authored,
bypassing estimation governance) and are **skipped on summary/milestone tasks**.

### accounts[] vs resources[]
Kept distinct. `accounts[]` are user **logins** (`username`, `email`,
`display_name`, optional program `role`), created only when import runs with
`--create-users`. `resources[]` are **schedulable capacity** (`name`,
`job_role`, `max_units`, `calendar`); a resource *may* link to an account via an
optional `account` slug (→ `Resource.user`), but advisors/contractors need not.

### Strictness and versioning
`additionalProperties: false` at **every** object level — an unknown key in a
hand-authored seed is an error surfaced with its JSON path, not a silent drop.
Forward compatibility is handled by the top-level `schema_version` (`"MAJOR.MINOR"`):
`validate_seed` rejects unsupported majors; the importer pins to the version it
understands. Derived fields (`server_version`, CPM outputs, `short_id`) are
absent from the schema entirely — including one is a validation error.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **Slugs as file-local symbol table (chosen)** | No model migration; seeds survive re-import; human-readable cross-refs | Re-import is subtree-replace, not field merge |
| Add `slug` columns to Program/Project/Resource/… | True field-level upsert | Migration on 6+ models; new uniqueness constraints; sync/`server_version` churn for a seed-only need |
| Ship UUIDs in seed files | Direct mapping | UUIDs collide across instances; not human-authorable; re-import duplicates |
| Three-point as flat fields | Flatter document | Cannot express all-or-none in schema; partial estimates slip through |
| `additionalProperties: true` | Lenient to new fields | Hand-authored typos silently dropped — the exact bug class samples must avoid |
| Parent-id task pointers instead of ltree | No path arithmetic | Every task needs a unique id; tree not readable in-file; diverges from stored model |

## Consequences
- **Easier:** one format for samples, round-trip I/O, and future importers;
  strict validation catches seed typos at author time; no model migration; the
  document is diff-friendly and human-readable.
- **Harder:** re-import replaces a program subtree rather than merging field
  changes (acceptable for disposable sample data; field-merge is a future
  version). Cross-project dependency refs add a small resolution step in the
  importer.
- **Risks:** the round-trip guarantee (#616: export → import → export is an empty
  diff) constrains the exporter to emit exactly the schema's canonical ordering
  and to omit all derived fields — enforced by the per-sample round-trip CI test
  (#616). A `schema_version` bump that changes required fields needs a migration
  shim in `validate_seed`; mitigated by keeping v1 additive-friendly within a
  major.

## Implementation Notes
- **P3M layer:** Programs and Projects
- **Affected packages:** api (this ADR: schema + validator only; web affordances land with #615/#616)
- **Migration required:** **no** — slugs are file-local; the only persisted key reuses the existing `Program.code` column
- **API changes:** none in #614 (`validate_seed` is an importable pure function); import/export endpoints land in #615/#616
- **OSS or Enterprise:** OSS (`trueppm-suite`)
- **New dependency:** `jsonschema` promoted to a direct dependency (already present transitively at 4.26.0; MIT-licensed, ubiquitous, Apache-2.0 compatible)

### Durable Execution
The #614 deliverable — `validate_seed()` — is a **pure, synchronous,
side-effect-free** function (parse + JSON Schema check + cross-reference
sanity); it touches no database, broker, or channel layer. The checklist below
therefore documents the import/export *machinery this schema enables* (#615/#616)
so the contract is fixed at design time.

1. **Broker-down behaviour:** N/A for `validate_seed` (pure function). Seed
   **import** (#615) is **synchronous within a single `transaction.atomic()`** —
   seed size is bounded (≤ ~150 tasks for the largest sample), so the async
   outbox of ADR-0092 (which exists for large/slow MSP parses) is unnecessary.
   The post-commit board broadcast is the only async effect and is deferred via
   `transaction.on_commit()`; if the broker is down the commit still succeeds and
   clients reconcile on reconnect via sync delta (best-effort, per `broadcast.py`).
2. **Drain task:** None required — synchronous import means no outbox rows to
   drain. Reuses nothing.
3. **Orphan window:** N/A — no outbox.
4. **Service layer:** new `seed/` subpackage under the projects app:
   `validation.py` (#614, `validate_seed`), `importer.py` (#615,
   `import_seed(payload, *, workspace, owner, create_users)`), `exporter.py`
   (#616, `export_program(program) -> dict`). The importer calls the existing
   `scheduling/services.py::enqueue_recalculate()` for the post-import CPM pass —
   never `recalculate_schedule.delay()` directly.
5. **API response on best-effort dispatch:** import (#615) returns **201** with
   the created program payload synchronously (transactional, not queued) — not a
   `{"queued": true}` 202, because the write completes in-request. The deferred
   broadcast is fire-and-forget after commit.
6. **Outbox cleanup:** N/A — no outbox rows.
7. **Idempotency:** re-import is keyed on `(workspace, Program.code)` where
   `code` holds the program slug; a matching program's subtree is replaced inside
   the transaction (ADR-0092 wipe-then-recreate). `validate_seed` itself is
   trivially idempotent (pure). The import endpoint additionally honors the
   `Idempotency-Key` header via the ADR-0083 mixin to collapse duplicate uploads.
8. **Dead-letter / failure handling:** any validation or persistence failure
   rolls back the whole `transaction.atomic()` — partial programs never persist.
   `validate_seed` raises `SeedValidationError` with the offending JSON path;
   #615's endpoint maps it to a 400 with a line/path-level error report. There is
   no retry queue because there is no async step.

---

## Addendum (#967): single-project export

Issue #530 shipped program export (#616) as `GET /api/v1/programs/{id}/export/`.
Issue #967 adds the project-grain counterpart so a PM can export **one project**
as a portable seed file from the project settings/archive page (closing the #669
dead-disabled-control anti-pattern on `ProjectArchivePage`).

**Decision.** Add `GET /api/v1/projects/{id}/export/`, mirroring program export:
a synchronous `HttpResponse` JSON attachment built from `exporter.export_project(project)`
+ `dump_seed(...)`. The endpoint is open to any project member
(`IsAuthenticated + IsProjectMember`) and remains available on **archived**
projects (the export action skips `IsProjectNotArchived`, matching program
export's "data portability stays available for archival/forensics" stance and
the `visit` action precedent). Export is read-only data portability, not a
mutation, so it is not Owner-gated; a member can already read every field the
export packages via existing endpoints.

**Single-project seed shape.** The canonical schema requires a `program` wrapper
(`required: ["schema_version","program","projects"]`, `projects.minItems: 1`), but
`Project.program` is nullable (ADR-0070 — standalone projects are first-class).
`export_project` therefore **synthesizes a minimal single-project program wrapper
from the project itself** (`slug` from `project.code` or the slugified name,
`name` = project name, `methodology` = project methodology) rather than emitting
the live parent program. This is uniform for standalone and program-attached
projects, and — because the synthesized slug is project-derived, not the parent
program's `code` — re-importing a project export creates a **fresh** program
instead of clobbering the live parent program's subtree (the wipe-then-recreate
idempotency is keyed on `Program.code`). The program *roster/roles* are not
exported (a project-scoped doc carries no `ProgramMembership`), but every user the
project actually references (task assignees, resource accounts, risk owners) is
still emitted in `accounts` so the doc re-imports with intact references. The #616
round-trip guarantee holds: `export_program(import_seed(export_project(p)))` is
byte-identical to a re-export.

**Scope.** This slice is the synchronous **JSON seed** export only. The richer
bundle in #967's original AC — `.mpp`, attachments, time entries, audit log, and
a queued-job/download-link state — is deferred to a follow-up issue; that path
would adopt the async export-job pattern (ADR-0092 workspace export), not this
in-request `HttpResponse`.

### Durable Execution (project export)
Synchronous, read-only endpoint — every item is N/A. (1) Broker-down: N/A, no
dispatch; the response is built and returned in-request. (2) Drain task: N/A.
(3) Orphan window: N/A. (4) Service layer: `seed/exporter.py::export_project`
(pure, returns a dict). (5) API response: synchronous `200` `application/json`
attachment, not a queued `202`. (6) Outbox cleanup: N/A. (7) Idempotency:
trivially idempotent (pure read; no writes, no broadcast). (8) Dead-letter: N/A —
no async step; a serialization error surfaces in-request.
