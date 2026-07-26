# ADR-0632: CSV/Excel import is a parser adapter onto `ProjectData`, not a seed-pipeline consumer

## Status
Accepted

## Context

Issue #743 (CSV/Excel import — API half of epic #111) carried a **blocking open
architecture question** on both children of the epic, restated here verbatim:

> Should this CSV import normalize to the #614 canonical seed and reuse the #615
> pipeline (parser-only adapter, no bespoke persistence), or ship its own path now
> and refactor onto the pipeline in 0.5?

The question was filed against milestone 0.2 and deferred because #614 (canonical JSON
seed schema) and #615 (JSON import pipeline) were unbuilt. **Both closed in 0.3**, so
the question is now answerable against code rather than intent. The epic that motivated
it — #624, multi-format importers — states the constraint that must be honored:

> All importers normalize to the canonical JSON schema and reuse the import pipeline;
> **no platform-specific persistence paths.**

Resolving this correctly matters because getting it wrong is expensive in one specific
direction: routing CSV through the seed pipeline would make CSV import **destructive**.

### What the two candidate pipelines actually do

Reading the code rather than the epic prose shows they are not two implementations of
one idea — they are two pipelines with **different, both-correct semantics**:

| | `seed.importer.import_seed` (#615) | `msproject.importer.import_project` (ADR-0021/0092) |
|---|---|---|
| Scope | A whole **program** + its projects | **One existing project** |
| Input | Canonical JSON seed doc (#614 schema) | `ProjectData` interchange dataclass |
| Idempotency | **Hard-deletes the matching program's subtree and rebuilds it** | Additive; `wipe_existing` opt-in, default off |
| Data assumption | Sample data is **disposable** (ADR-0109) | Live customer data |
| Creates | Program, projects, memberships, calendars, risks, sprints, baselines | Tasks, deps, resources, assignments, calendars in a project that already exists |

`import_seed`'s own docstring is explicit about the idempotency model:

> Re-import is idempotent on the program slug (persisted in `Program.code`): a matching
> live program's subtree is **hard-deleted and rebuilt**. Sample data is disposable
> (ADR-0109), so wipe-then-recreate — the ADR-0092 precedent — is the right idempotency
> model here rather than a field-level merge.

#743's endpoint is `POST /api/v1/projects/{pk}/import/csv/` — import a spreadsheet
**into a live project the PM is already running**. Wipe-then-recreate is exactly wrong
for that: a PM adding 40 rows from a stakeholder's spreadsheet would silently lose the
program's other projects.

### The pipeline #743 should reuse already exists, and already has two adapters

`ProjectData` (`msproject/dataclasses.py`) is the interchange struct for
file→existing-project imports, and `msproject.importer.import_project()` is its single
persistence path: WBS ltree paths from outline levels, dependencies, resource
match-or-create, assignments, calendars, summary rollups, `enqueue_recalculate`, and a
deferred `broadcast_board_event`.

It is **already shared**. The Jira adapter (ADR-0259) reuses it, and says so:

> The output is the shared `msproject` interchange dataclass (`ProjectData`) so the
> existing, battle-tested `msproject.importer.import_project` persists it.
> — `jiraimport/parser.py`

So the "no platform-specific persistence paths" constraint from #624 is already
satisfied by a pipeline — just not the one the epic named. There are two normalization
targets in this codebase, split by **what the import creates**, not by file format:

- **Create a program from a document** → canonical JSON seed (#614) → `import_seed` (#615)
- **Import a document into an existing project** → `ProjectData` → `import_project`

MS Project and Jira both take the second path. CSV/Excel is the same shape of operation
as both, and takes the same path.

**P3M layer:** Programs and Projects → **OSS**. Single-project migration on-ramp, no
cross-project aggregation. `grep -r trueppm_enterprise packages/` stays clean.

## Decision

**1. CSV/Excel is the third parser adapter onto `ProjectData` → `import_project`.**
The new code is a parser and a column mapper. It writes **zero** rows itself. #624's
constraint is honored in substance: no platform-specific persistence path is added.

**2. Do not route CSV through the #614 seed schema or the #615 pipeline.** Its
program-scoped wipe-then-recreate idempotency is unsafe for import-into-live-project,
and the seed schema requires structure (program, memberships, calendars, baselines,
sprints) that a spreadsheet cannot supply. Feed this back to #624: the epic's blanket
"all importers normalize to the canonical JSON schema" is accurate only for
create-a-program-from-a-file importers. Tier-1 importers that land in an existing
project normalize to `ProjectData`.

**3. New `csvimport` Django app with its own outbox.** `CsvImportRequest`,
`enqueue_csv_import()`, `drain_csv_import_queue`. This mirrors ADR-0259's decision
verbatim — a dedicated outbox rather than a `source` discriminator on
`msproject.ImportRequest` — so the three drains stay independent and no drain has to
branch on file type.

**4. Parse with stdlib `csv` and `openpyxl` (read-only mode).** openpyxl is MIT, one
MIT transitive dep, no compiler. Its two historical XXE CVEs were fixed in 2.4.2 (2017).
It auto-enables `defusedxml` hardening when `defusedxml` is importable — which it is,
already a direct dependency of `packages/api` — so XXE protection is inherited without
configuration. `lxml` is deliberately absent, so parsing runs on stdlib ElementTree
under defusedxml.

**5. Preview is synchronous, stateless, and persists nothing.**
`POST /api/v1/projects/{pk}/import/csv/preview/` parses in-request and returns the
detected mapping, the first 10 rows, and warnings. No outbox row, no Celery task, no
server-side draft. Justified by the same 10 MB / 5 000-row cap that bounds the commit
path, and it is what makes #746's "retry preserves the mapping already entered"
requirement free — the mapping lives in client state, so there is no server draft to
resume or expire.

**6. The commit response is `202 {"queued": true, "import_request_id": "<uuid>"}` —
not `{"celery_task_id": ...}`.** This is a deliberate deviation from the #743 issue
text. Under the transactional outbox, dispatch happens in a `transaction.on_commit`
callback *after* the response is serialized, so no Celery task id exists yet; on a
broker outage none exists until the drain runs. Returning a task id would require
either dropping the outbox (a durability regression) or fabricating a value. The
outbox row id is the durable, pollable handle. **#746 must be updated** — it currently
specifies polling `celery_task_id`.

**7. Fuzzy column mapping lives in a Django-free pure module** (`csvimport/mapping.py`),
so preview and commit share one implementation and it is unit-testable without a
database. A client-supplied `column_map` always overrides auto-detection, field by field.

**8. Row-level errors are data, not exceptions.** Each is
`{"row": int, "column": str | null, "code": str, "message": str}`; valid rows still
commit and the errors ride in the import summary. Partial success is the expected
outcome for a real spreadsheet, not an edge case.

**9. Limits are settings, and the zip-bomb guard is ours.** `CSV_IMPORT_MAX_UPLOAD_MB`
(default 10) and `CSV_IMPORT_MAX_ROWS` (default 5 000) per the issue. openpyxl's
defusedxml integration covers XXE but **not** decompression bombs: `.xlsx` is a zip
archive, so a 1 MB upload can inflate to gigabytes. Before parsing, sum the declared
uncompressed sizes in the zip central directory and reject above
`CSV_IMPORT_MAX_UNCOMPRESSED_MB` (default 100) — cheap, reads no member data, and
happens before any XML is touched.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Adapter onto `ProjectData` → `import_project`** (chosen) | Zero new persistence code; inherits WBS/dep/resource/calendar/broadcast/recalc handling already hardened over three ADRs; third adapter on a path with two existing ones; honors #624's real constraint | Couples CSV to a module named `msproject` — a naming wart, addressed below |
| B. Normalize to canonical JSON seed (#614) + `import_seed` (#615) | Literal reading of #624; one schema | **Destructive** — program-scoped wipe-then-recreate would delete sibling projects on import into a live program; seed schema demands structure a spreadsheet lacks; would force #743 to 0.5 to follow a pipeline that solves a different problem |
| C. Bespoke CSV persistence path | Fastest to write | Exactly what #624 forbids; duplicates ltree/dep/resource logic; a fourth place for WBS bugs to live |
| D. Extend `msproject.ImportRequest` with a `source` discriminator | One outbox, one drain | Contradicts ADR-0259, which rejected this for Jira; forces every drain to branch on file type and couples three release cadences |
| E. Stateful server-side preview (draft row) | Wizard could resume across sessions | Needs a draft table, expiry, and cleanup; makes #746's retry-preserves-mapping a server concern; no requirement asks for cross-session resume |

## Consequences

**Easier**
- #743 becomes parser + mapper + outbox. No task, dependency, resource, ltree, calendar,
  broadcast, or recalculation code is written or duplicated.
- CSV inherits fixes to `import_project` automatically, as Jira already does.
- The 0.5 Tier-1 importers (Asana, Monday.com, Planview) get a documented precedent:
  three adapters on one interchange is now the established pattern, not an exception.
- Fidelity is directly comparable across formats because all three normalize to one struct.

**Harder**
- `ProjectData` lives in an app named `msproject` while serving three formats. Renaming
  it now would touch the two shipped importers for cosmetic gain; **not done here.**
  Filed as a follow-up to lift `dataclasses.py` + `importer.py` into a neutral
  `apps/fileimport` package when a fourth adapter lands.
- `ProjectData` is keyed by `int uid` (an MSPDI artifact). The CSV parser must mint
  synthetic uids from row order, as the Jira parser already does for string keys.
- Three near-identical outbox/drain triples now exist. That is the deliberate ADR-0259
  trade — independence over DRY — but it is a real cost worth revisiting at a fourth.

**Risks**
- `ProjectData` has no field for a **fuzzy-mapping confidence** or per-row error, so the
  summary must carry them alongside rather than inside. Mitigated: `import_project`
  already returns a summary dict and `ProjectData.warnings` already exists.
- A spreadsheet with no recognizable name column produces zero tasks. The preview
  endpoint is what prevents this reaching commit — which is why preview is required in
  the wizard flow, not optional.

## Implementation Notes

- **P3M layer:** Programs and Projects
- **Affected packages:** api (new `csvimport` app; `packages/web` follows in #746)
- **Migration required:** yes — one `CreateModel` for `CsvImportRequest` in the new app
- **API changes:** yes — three endpoints:
  - `POST /api/v1/projects/{pk}/import/csv/` → `202 {"queued": true, "import_request_id"}`
  - `POST /api/v1/projects/{pk}/import/csv/preview/` → `200` mapping + 10 sample rows, no persistence
  - `GET  /api/v1/import-templates/csv/` → `200 text/csv` known-good template
- **OSS or Enterprise:** OSS (Apache 2.0)
- **RBAC:** Owner/Admin/Scheduler on the target project may import; Member/Viewer denied
  at object level. Preview is gated identically — it parses attacker-supplied files, so
  it is not a lighter-privilege surface just because it does not persist.

### Durable Execution

1. **Broker-down behaviour:** Transactional outbox. The view writes `CsvImportRequest`
   (file content base64, status `PENDING`) inside `transaction.atomic()` and defers
   `enqueue_csv_import(id)` to `transaction.on_commit`. A broker outage leaves the row
   `PENDING` with the file content durably committed; nothing is lost. The **preview**
   endpoint is fully synchronous with no async side effects — outbox N/A there.
2. **Drain task:** New — `drain_csv_import_queue`, Beat every 30 s,
   `@idempotent_task(on_contention="skip")`. Does **not** reuse `drain_import_queue` or
   `drain_jira_import_queue`: per ADR-0259 the drains stay independent so none has to
   branch on file type.
3. **Orphan window:** 10 minutes, matching the MS Project import drain. Rows inside an
   open `on_commit` callback are invisible until commit, so the drain filters to
   `requested_at` older than 10 minutes. A `DISPATCHED` row older than 15 minutes is
   treated as orphaned (worker died) and reset to `PENDING`, mirroring
   `_IMPORT_ORPHAN_MINUTES`.
4. **Service layer:** New `csvimport/services.py::enqueue_csv_import(import_request_id)`,
   mirroring `msproject.services.enqueue_import`. CPM recalculation is **not** called
   directly — `import_project` already routes through
   `scheduling/services.py::enqueue_recalculate()`.
5. **API response on best-effort dispatch:** `202 {"queued": true, "import_request_id":
   "<uuid>"}`. No `celery_task_id` — see decision 6; #746 must be updated to poll the
   outbox row.
6. **Outbox cleanup:** `file_content_b64` is cleared when the row reaches `DONE`/`DEAD`
   (the Jira convention — it is only needed for pre-terminal retry), and terminal rows
   are purged nightly at 7-day retention, matching the existing convention. Retention
   is deliberate rather than immediate: the row is the import's provenance record.
7. **Idempotency:** Key is the `CsvImportRequest` PK. `import_csv` is wrapped in
   `@idempotent_task`; the body re-reads the row and returns early unless it is
   `PENDING`/`DISPATCHED`. Because import into an existing project is **additive**
   (`wipe_existing=False`), a duplicate delivery that slipped past the guard would
   double-insert tasks, so the status check is load-bearing and is asserted in tests.
   `creates_project` is not used by this path.
8. **Dead-letter / failure handling:** `max_retries=3` with exponential backoff for
   infrastructure faults. **Parse and row-level errors are not retried** — a malformed
   spreadsheet is deterministic, and retrying it three times only delays the operator's
   feedback. On exhaustion or a parse failure the row goes `DEAD` with the error in its
   summary, which the project's import-provenance list surfaces so the failure is
   visible on the Schedule that launched it (#2151 defect class). Re-trigger is a new
   upload; the file content is retained until purge for diagnosis.
