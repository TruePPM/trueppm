# TruePPM Data Interchange Specification — JSON seed and CSV

**Status:** Normative. **Decision of record:** [ADR-0634](../adr/0634-file-interchange-contract-json-seed-and-csv.md).
**Applies to:** every surface in `trueppm-suite` that writes or reads a `.json` seed, a
`.csv`, or an `.xlsx` file.

If this spec conflicts with an existing implementation, **this spec wins and the
implementation is non-conformant** — but a non-conformance is fixed under its own issue,
not silently. Surfaces known to be non-conformant today are listed in §7 with their
tracking issue. If this spec is ambiguous, treat the ambiguity as a bug and resolve it
here before implementing.

MS Project XML (MSPDI) and the Jira import are separate interchange paths with their own
specs (ADR-0021, ADR-0259); they appear in the capability matrix (§2) for completeness
but are not otherwise governed by this document.

---

## Table of contents

1. [The one-sentence rule](#1-the-one-sentence-rule)
2. [Capability matrix](#2-capability-matrix)
3. [Fidelity tiers](#3-fidelity-tiers)
4. [Format: canonical JSON seed](#4-format-canonical-json-seed)
5. [Format: CSV](#5-format-csv)
6. [Cross-cutting rules](#6-cross-cutting-rules)
7. [Conformance register](#7-conformance-register)
8. [Roadmap](#8-roadmap)

Sections 4 and 5 use **identical headings in identical order** so the two formats can be
read side by side:

> scope · direction · identity model · fidelity tier · encoding & dialect · structure ·
> limits · error model · RBAC tier · **limitations**

---

## 1. The one-sentence rule

> **The JSON seed is the fidelity format. CSV is the tabular format.**

A CSV file is **never** a backup, **never** a migration artifact, and **never** the input
to a restore. Every capability question resolves from this sentence. If a proposed CSV
feature only makes sense because CSV is being treated as a portable copy of the project,
the answer is a JSON seed export instead.

---

## 2. Capability matrix

Entity × format × direction × tier × release. "—" means the combination does not exist
and is not planned in the horizon shown.

| Entity | JSON seed export | JSON seed import | CSV export | CSV import |
|---|---|---|---|---|
| **Program** (with all its projects) | **T1** · shipped | **T1** · shipped | — | — |
| **Project** (single) | **T1** · shipped | via program envelope · shipped | — | — |
| **Tasks** (WBS, dates, estimates) | **T1** · shipped (inside a project) | **T1** · shipped | **T0** · shipped | **T1** · 0.4 (#743/#746) |
| **Dependencies** | **T1** · shipped | **T1** · shipped | — | 0.4 (predecessor column, #743) |
| **Risks** | **T1** · shipped | **T1** · shipped | **T1** · shipped | **T1** · shipped |
| **Sprints / baselines / board columns** | **T1** · shipped | **T1** · shipped | — | — |
| **Resources / calendars / accounts** | **T1** · shipped | **T1** · shipped | — | — |
| **Labels** | **T1** · shipped | **T1** · shipped | — | — |
| **Comments / attachments / time entries / history** | **T0** sidecars in the bundle | — | — | — |
| **Event timeline** (v2) | **T1** · shipped (`schema_version: 2.0`) | **T1** · shipped | — | — |

Transport surfaces, for reference:

| Surface | Endpoint | Sync/async | RBAC |
|---|---|---|---|
| Program seed export | `GET /api/v1/programs/{id}/export/` | sync | Program Admin+ |
| Project seed export | `GET /api/v1/projects/{id}/export/` | sync | Project Admin+ |
| Program seed import | `POST /api/v1/programs/import/` + `GET …/{id}/import/jobs/{job_id}/` | async (`202`) | Authenticated (parity with `Program.create`); job poll is Program Admin+ |
| Project export bundle | `POST /api/v1/projects/{id}/export/` + job endpoints | async | Project Admin+ |
| Program export bundle | `POST /api/v1/programs/{id}/export/` + job endpoints | async | Program Admin+ |
| Risk CSV import | `POST /api/v1/projects/{id}/risks/import_csv/` | sync | see §5.9 |
| Risk CSV export | client-side, no endpoint | sync | as the register read |
| Task CSV export | client-side, no endpoint | sync | as the Grid read |
| Task CSV/XLSX import | `POST /api/v1/projects/{id}/import/csv/` (+ `/preview/`) | async | 0.4, #743 |
| MS Project XML | `…/import/msproject/`, `…/export/msproject.xml` | async / sync | ADR-0021 |

Note the asymmetries — they are real and deliberate, not gaps to be papered over:

- **Import is program-grained; export is both.** There is no project-level import
  endpoint. A project export re-imports by way of a synthesized single-project program
  envelope (ADR-0109 #967 addendum), which means it lands as a **new program**, not back
  into its original parent.
- **CSV import and CSV export are not inverses for tasks.** See §5.10.

---

## 3. Fidelity tiers

Every interchange surface carries exactly one tier. The tier is the honest answer to
*"if I export this and import it back, what do I get?"*

### T0 — view snapshot

A rendering of what is on screen, **including computed values**. The column set is
presentational and may change when the view changes.

- **Not an input to any importer.** No importer is obliged to read a T0 file, and none
  currently does.
- May contain derived fields (CPM early/late dates, float, critical flag, severity).
- Suitable for: sending a status table to someone, pasting into a deck, a one-off
  analysis in a spreadsheet.
- **Not** suitable for: backup, migration, restore, or archival.

### T1 — structural re-import

Re-import reconstructs the structure faithfully but **mints new identity**: fresh UUIDs
and fresh `server_version`. Cross-references resolve through a file-local symbol table
(slugs; `wbs_path` for tasks) rather than through database ids.

- Re-importing a T1 export **creates a new object**, it does not update the original.
  For the program seed specifically, idempotency is keyed on `(workspace, Program.code)`:
  a program whose slug matches is **replaced wholesale**, not field-merged. The
  replacement is **not unconditional** — the REST endpoint refuses it with `409` until the
  caller sends `replace=true` — and on the non-sample path it is a **soft** delete
  (ADR-0726): the replaced program's projects move to project Trash, where each can be
  restored individually as a standalone project, and offline clients receive real
  tombstones. The program shell itself is **not** recoverable, and a restored project does
  not return to it. The disposable sample path (`is_sample`) still hard-deletes.
- Derived values are **absent by construction** — including one is a validation error.
- Suitable for: moving a program between instances, seeding a demo, hand-editing a plan
  in an editor, archival where re-creating (not restoring in place) is acceptable.

### T2 — identity-preserving

Re-import updates the *same* objects in place; UUIDs and sync bookkeeping survive, and
conflict resolution is defined.

**Not shipped.** Tracked as #1959 for 0.5. No surface may claim T2 today, and no
documentation may describe an import as "restoring" a project.

---

## 4. Format: canonical JSON seed

### 4.1 Scope

One **program** and the projects beneath it. The seed is deliberately single-program —
cross-program aggregation is out of scope for OSS (ADR-0070). A standalone project (no
parent program) exports the same way, wrapped in a synthesized single-project program.

### 4.2 Direction

Bidirectional. Export at program and project grain; import at program grain only.

### 4.3 Identity model

**Slugs are a file-local symbol table, not columns.** No model gains a slug field. Every
referenceable entity carries a `slug` unique *within the file*; tasks are referenced by
`wbs_path` (bare `"2.1"` within the enclosing project, qualified
`"<project_slug>:<wbs_path>"` across projects). At import these resolve to freshly minted
UUIDs through an in-memory map.

The one persisted natural key is the **program slug**, written to `Program.code`
(max 40 chars). Re-import idempotency keys on `(workspace, Program.code)`.

**No UUIDs, no `server_version`, no `short_id` appear in a seed file.** Including one is
a validation error, not a silent drop.

### 4.4 Fidelity tier

**T1.** See §3. `schema_version: "2.0"` additionally carries the event timeline (ADR-0114)
and replays it on import; that raises the *content* fidelity, not the *identity* tier.

### 4.5 Encoding & dialect

- **UTF-8**, no BOM.
- JSON as per RFC 8259. Not JSON5, not JSONL, no comments, no trailing commas.
- `schema_version` is a required top-level `"MAJOR.MINOR"` string. The validator rejects
  an unsupported **major**; a minor bump must stay additive within its major.
- **`additionalProperties: false` at every object level.** An unknown key is an error
  reported with its JSON path — a hand-authored seed with a typo'd field must fail loudly,
  not lose the field silently.
- Dates are ISO 8601. In v2, dates may instead be **anchor-relative offsets** resolved
  against the document `anchor` (ADR-0114).

### 4.6 Structure

```jsonc
{
  "schema_version": "1.0",   // required
  "anchor":   { … },         // v2 only — relative-date origin
  "program":  { … },         // required
  "accounts": [ … ],         // user logins referenced by the seed
  "calendars":[ … ],         // working calendars
  "resources":[ … ],         // schedulable capacity
  "risks":    [ … ],         // program-scoped risks
  "projects": [ {            // required, minItems 1
     …,
     "tasks": [ … ], "dependencies": [ … ], "sprints": [ … ],
     "baselines": [ … ], "board_columns": [ … ], "risks": [ … ], "labels": [ … ]
  } ],
  "events":   [ … ]          // v2 only — replayable event timeline
}
```

Required top level: `schema_version`, `program`, `projects` (both schema versions).

Two invariants worth restating because they are structurally enforced rather than
checked in code:

- **Three-point estimates are an all-or-none sub-object** (`{optimistic, most_likely,
  pessimistic}`), so a partial estimate is unrepresentable rather than merely rejected.
- **The WBS is an explicit ltree path per task**, so hierarchy is readable in the file and
  the importer can detect gaps and cycles deterministically.

The canonical field-by-field reference is the committed schema itself:
`packages/api/src/trueppm_api/apps/projects/schemas/seed_v1.json` and `seed_v2.json`.
The schema is the source of truth; this spec governs the *contract around* it.

### 4.7 Limits

| Limit | Value | Where |
|---|---|---|
| Payload size | 5 MB | `SEED_MAX_UPLOAD_MB` |
| Total entities in one seed | 100 000 | `MAX_SEED_NODES` |
| Program slug length | 40 | `Program.code` |
| Async bundle download TTL | 7 days | retention policy |
| Import job row + stored payload TTL | 7 days | `TRUEPPM_IMPORT_RETENTION_DAYS` |

`SEED_MAX_UPLOAD_MB` is enforced on **both** request shapes — the multipart `file` upload
and the raw JSON body. The JSON-body branch was previously bounded only by
`DATA_UPLOAD_MAX_MEMORY_SIZE` (100 MB), which made the 5 MB ceiling bypassable simply by
posting the document as the body; ADR-0726 closes that.

The gate is on **actual bytes**, not on a declared `Content-Length`: the multipart branch
checks `UploadedFile.size`, and the JSON branch checks `len(request.body)` before parsing.
A declared length is not sufficient — it can be absent entirely under chunked
transfer-encoding — and the branch is selected on `Content-Type` rather than by probing
`request.FILES`, because reading that property runs the parser the check exists to bound.

`MAX_SEED_NODES` stays at 100 000 and is **deliberately not raised**. At the bundled
fixtures' measured ~525 bytes/node the 5 MB payload cap already binds well below it; the
node ceiling is retained as a **worker-memory backstop**, since the importer holds a live
model instance per task for the duration of the build.

Import is **asynchronous** as of ADR-0726, in two parts. Inside the request: read and cap
the payload, validate it, resolve and perform any replacement under `select_for_update`,
create the `Program` shell, and write the `ProgramImportJob` row and its stored payload —
all in one `transaction.atomic()`, answered with `202` carrying `program_id` and
`import_request_id`. In the worker: the O(n) subtree build. The split is deliberate — a
destructive act belongs inside the request the operator authorized, and resolving the
collision there closes the TOCTOU window between "nothing collides" and a worker deleting
something. Dispatch is a transactional outbox (`transaction.on_commit`, broker errors
swallowed to a warning), drained by `projects.drain_program_imports`; the worker claims
the job row under `select_for_update` and no-ops unless `pending`/`running`, because after
the split it is purely additive and a duplicate delivery would double the whole subtree.

### 4.8 Error model

- Validation runs **before any write**, and before anything is queued. `validate_seed()`
  raises `SeedValidationError` carrying the offending **JSON path**; the endpoint maps it
  to a `400` with a path-anchored report. A `400` is therefore always synchronous, even
  though a successful import is not.
- A collision on `Program.code` that was not confirmed is a `409` with
  `code: "seed_replace_required"` and a `conflict` object (`program_id`, `name`, `code`,
  `project_count`, `task_count`). `expected_program_id` naming a different program is a
  `409` with `code: "seed_replace_mismatch"`. Both are raised before any write.
- Any validation or persistence failure rolls back the entire transaction. A partial
  program never persists. If the queued build fails, the job goes `failed` with
  `error_detail` and the empty program shell is deliberately left in place — the
  replaced subtree is in Trash and the Owner needs the failed job row to reason about
  what happened.
- The import endpoint honors `Idempotency-Key` (ADR-0170) so a retried upload collapses
  rather than duplicating.
- **There is no row-level / node-level tier, by design.** Unlike CSV (§5.8), a seed
  document never imports partially: a single bad reference fails the whole file. A seed
  is machine-generated and self-describing, so a malformed one is not messy input — it
  is not the document it claims to be. See
  [§6.6](#66-one-diagnostic-shape-two-strictness-policies).

### 4.9 RBAC tier

- **Export (both grains): Admin+.** The seed carries team-private points and velocity, so
  it sits at the same tier as the async bundle rather than being open to every member.
  This is deliberate and was tightened in #1957 — do not loosen it without revisiting
  ADR-0104.
- Export remains available on **archived** projects and programs, so data stays portable
  for archival.
- **Import: Authenticated**, matching `Program.create` — both mint a brand-new program
  owned by the caller. If `create` ever becomes workspace-gated, import moves with it.
  The *replace* is separately and more narrowly scoped: only programs on which the caller
  holds a live **Owner** `ProgramMembership` are ever candidates (#994), so the looser
  gate on create never widens what a seed can destroy. That is also why naming the
  colliding program back to the caller in the `409` leaks nothing.
- **Import job poll (`GET …/import/jobs/{job_id}/`): Program Admin+**, matching the
  export job poll — the result summary reports the program's entity counts and the error
  detail can echo diagnostics naming projects and tasks. The job is looked up against the
  membership-checked program, so a `job_id` from another program `404`s. The importing
  caller is the program's Owner by construction, so this never locks anyone out of a job
  they started.
- The REST import always runs with **user creation off**. Importing a seed on a live
  instance must never mint logins. Only the `import_seed` management command may pass
  `--create-users`, for local demos.

### 4.10 Limitations

Stated plainly, because these are the ones people discover the hard way:

1. **Re-import creates a new program.** It is not a restore. There is no update-in-place
   (T2 is #1959, 0.5).
2. **No project-level import endpoint.** A project export re-imports as a new
   single-project program, not back into its original parent.
3. **A matching program slug is replaced wholesale**, not merged. Field-level upsert does
   not exist. The REST endpoint refuses the replacement until you confirm it, and the
   replaced program's **projects** land in project Trash — but the **program shell itself
   is not recoverable**. There is no program Trash and no program restore endpoint
   (#2587), and a project restored from Trash comes back as a standalone project, not
   regrouped under the program it was removed from. Export before you re-import over a
   program you care about.
4. **The v1 seed is final-state only.** Comments, time entries, attachments, and change
   history are **not** in the round-trippable payload. The async bundle carries them as
   raw **sidecars** — readable, but not restorable through seed import.
5. **Cross-project dependencies pointing at a sibling project are omitted** from a
   single-project export, because the sibling is not in the file.
6. **Program roster and roles are not exported** by a project-grain export (a
   project-scoped document carries no `ProgramMembership`), though every user the project
   references still appears in `accounts` so references resolve.
7. **Member and resource email addresses are present in the file.** Treat an exported
   seed as a file containing contact information. No passwords, tokens, or internal
   secrets are ever exported.
8. **Artifacts are unencrypted and unchecksummed** in 0.4. See §6.4.

---

## 5. Format: CSV

### 5.1 Scope

**One entity type per file, flat.** A CSV file describes a list of tasks, or a list of
risks — never a project, never a program, never a mix. There is no CSV representation of
a program, and there will not be one.

`.xlsx` is accepted **on import only**, and is read as CSV-equivalent: first sheet only,
values only (no formula evaluation), other sheets warned about and ignored. TruePPM never
*writes* `.xlsx`.

### 5.2 Direction

Bidirectional but **asymmetric per entity** — see the matrix in §2 and the limitation in
§5.10. Export is client-side (the browser builds and downloads the file; there is no
export endpoint). Import is server-side.

### 5.3 Identity model

**Positional and by natural key, never by database id.**

- A row is identified by its **line number** for error reporting (header = line 1).
- Tasks are identified by **WBS path** or by **indent depth** in the name column.
- People are resolved through a **caller-supplied index scoped to project membership** —
  UUID, email, or username, matched case-insensitively. A CSV can therefore never assign
  work or ownership to a non-member; an unmatched value is a warning and the field is left
  empty. This is a security property, not a convenience: it is what stops a crafted file
  from reaching across projects.
- Exported id-shaped columns (a risk's `qualified_id`, a task's `WBS`) are **informational
  on export and ignored on import**. They round-trip visually without ever being trusted
  as identity.

### 5.4 Fidelity tier

- **Risk register CSV: T1** both directions. It is the one CSV surface where export and
  import are genuine counterparts.
- **Task CSV export: T0.** A view snapshot. Not an importer input.
- **Task CSV/XLSX import (0.4): T1.** It creates tasks; it does not update them.

### 5.5 Encoding & dialect

This is the normative dialect. Every TruePPM CSV producer and consumer obeys it.

| Aspect | Rule |
|---|---|
| Base standard | **RFC 4180** |
| Delimiter | **Comma.** Not negotiated, not sniffed, not locale-dependent. See §5.10.3 |
| Encoding | **UTF-8.** A leading BOM is **accepted on read** (Excel writes one) and **not written on export** |
| Line ending | **CRLF** on write; CRLF or LF accepted on read |
| Quoting | A field containing a comma, double-quote, CR, or LF is wrapped in double quotes; an embedded double-quote is doubled (`""`) |
| Header row | **Required**, line 1. Column **order is not significant on read**; header **names** are |
| Header matching | Case-insensitive, whitespace-trimmed, alias-aware |
| Unknown columns | **Ignored with a warning.** Never a hard failure |
| Blank rows | Skipped (a row whose every cell is empty after trimming) |
| Comment rows | A row whose first cell begins with `#` is skipped |
| Dates | **ISO 8601 `YYYY-MM-DD` on write.** Readers additionally accept `MMM D, YYYY` and `MMMM D, YYYY` as legacy tolerance |
| Enums | **Stored value on write.** Readers accept the stored value **or** the human label |
| Booleans | `true` / `false` on write; readers accept `true/false`, `yes/no`, `1/0`, case-insensitively |
| Empty vs. absent | An empty cell means "no value supplied". It never means "clear this field" |

### 5.6 Structure — canonical column sets

Column **order** below is the export order. On import, order is irrelevant; only names
matter.

#### 5.6.1 Risks (`T1`, both directions — ADR-0043)

| Column | Aliases accepted on import | On import |
|---|---|---|
| `ID` | `id` | ignored (export artifact) |
| `Title` | `title` | **required**; missing → row error |
| `Status` | `status` | blank → `OPEN`; unrecognized → warning + `OPEN` |
| `Category` | `category` | unrecognized → warning + blank |
| `Response` | `response` | unrecognized → warning + blank |
| `P` | `probability` | 1–5; blank → warning + `1`; out of range → row error |
| `I` | `impact` | 1–5; blank → warning + `1`; out of range → row error |
| `Severity` | `severity` | ignored (derived `P × I`) |
| `Owner` | `owner` | matched against project members; unmatched → warning + unassigned |
| `Mitigation Due Date` | `mitigation due date` | unparseable → warning + blank |
| `Trigger` | `trigger` | free text |
| `Contingency` | `contingency` | free text |
| `Description` | `description` | free text |

#### 5.6.2 Tasks — export (`T0`)

| Column | Nature |
|---|---|
| `WBS` | structural |
| `Name` | committed |
| `Start` | **computed** — CPM early start, not a committed date |
| `Finish` | **computed** — CPM early finish |
| `Duration (days)` | committed |
| `Progress (%)` | committed |
| `Status` | committed |
| `Critical` | **derived** — CPM critical-path flag |

Three of eight columns are computed or derived, and the set omits ids, predecessors,
assignees, estimates, and committed dates. That is why this is T0 and not merely "a CSV
we haven't written an importer for".

#### 5.6.3 Tasks — import (`T1`, 0.4, #743)

Header auto-detection is fuzzy (case-insensitive, plural- and alias-aware). The canonical
target fields and their accepted aliases:

| Target | Accepted header aliases |
|---|---|
| `Task.name` | Name, Task, Title, Task Name, Summary |
| `Task.duration` | Duration, Days, Effort, Duration (days) |
| `Task.planned_start` | Start, Begin, Start Date, Planned Start |
| `Task.planned_finish` | Finish, End, Due, Due Date, Finish Date, Planned Finish |
| `Task.percent_complete` | % Complete, Percent Complete, Done, Progress, Progress (%) |
| assignee → `Assignment.resource_name` | Assignee, Owner, Resource, Assigned To |
| dependency | Predecessor, Predecessors, Depends On, Blocked By |
| WBS hierarchy | WBS, Phase, Level, Outline Level, or leading-whitespace/dot indent in the name column |

Hierarchy is taken from an explicit WBS/outline column if present, else from indent depth
in the name column. Both resolve to ltree paths.

`Start`/`Finish` on **import** are read as **committed** (`planned_*`) dates — the mirror
of the export's computed ones. This is the single most important asymmetry in the whole
document and it is restated in §5.10.

### 5.7 Limits

| Limit | Risks (shipped) | Tasks (0.4, #743) |
|---|---|---|
| Max upload size | 2 MB | 10 MB |
| Max data rows | 500 | 5 000 |
| Over-limit behavior | **Rejected outright** (400) — never partially processed | same |
| Processing | synchronous | asynchronous (Celery) |

Over-limit is rejected rather than truncated, deliberately: a silently truncated import is
indistinguishable from a successful one, and the user finds out weeks later.

### 5.8 Error model

Two levels. The **file-level** tier mirrors §4.8; the **row-level** tier below has no
counterpart there, because the JSON seed is deliberately fatal-only — see
[§6.6](#66-one-diagnostic-shape-two-strictness-policies).

**File-level** → `400`, nothing persisted. Causes: undecodable bytes, empty file, missing
required column (`Title` for risks; the name column for tasks), row count over the limit.

**Row-level** → collected, never raised:

| Class | Effect | Examples |
|---|---|---|
| **Error** | That row is **skipped**; the rest of the file still imports | missing required value; a probability/impact present but outside 1–5 |
| **Warning** | Row **is imported** with a coerced or defaulted value | unrecognized enum → default; unparseable date → blank; unmatched owner → unassigned; blank P/I → defaulted |

Every issue carries a **1-based line number** (header = line 1) and the offending column
name.

**Partial success is a result, not a failure.** For a spreadsheet import it is the common
case. The API returns the created rows plus the error/warning lists, and the UI presents
it as an outcome with a per-line report — not an error state.

### 5.9 RBAC tier

- **Import: Project Manager+** (`IsProjectAdmin`, role ≥ 3) for task import; the risk
  importer runs under the risk register's own write gate. Member and Viewer are denied at
  the object level.
- **Export: the same tier as the equivalent seed export for the same data.** A CSV export
  is **not** a lower-privilege operation because the file is smaller (ADR-0634 §6). Any
  field gated in the seed exporter under ADR-0104 is gated identically in every CSV
  exporter.

### 5.10 Limitations

These are structural properties of CSV, not gaps waiting to be filled. They are the
reason for §1.

1. **A CSV holds one flat entity list.** No nesting, no cross-entity references, no
   schema version, no types. Everything is a string until someone parses it.

2. **Task CSV export and task CSV import are not inverses.** The 0.4 export is a T0 view
   snapshot (computed CPM dates, a derived critical flag, no predecessors or assignees);
   the 0.4 importer is a T1 creator that reads committed dates. Exporting tasks to CSV and
   re-importing that file does **not** reconstruct the project — it creates new tasks with
   CPM output mistaken for committed input. Do not describe them as a round trip.
   Conformance work: #2401.

3. **Comma delimiter breaks in `;`-list-separator locales.** In those locales Excel opens
   a comma-delimited file as a single column until the user runs Data → Text to Columns.
   This cost is accepted deliberately (ADR-0634 §3): sniffing or negotiating the delimiter
   would make a file's meaning depend on the machine that opens it. The workaround is
   documented for users rather than the format being made ambiguous.

4. **Excel reformats data on open and on save.** Leading zeros are stripped, long numeric
   strings become scientific notation, and anything date-shaped is re-rendered in the
   machine's locale. A file that has been opened and re-saved in Excel is no longer
   guaranteed to match what TruePPM wrote. Import tolerates the common damage (§5.5 legacy
   date formats); it cannot tolerate all of it.

5. **No identity, therefore no update.** CSV import always creates. There is no CSV path
   to modify an existing task, and adding one would require the T2 identity model that
   does not exist even for JSON (#1959).

6. **No dependencies on export, and only simple predecessors on import.** The export omits
   the dependency graph entirely; the importer reads a predecessor column but does not
   express lag, or the full four dependency types the engine supports.

7. **`.xlsx` is import-only, first sheet only, values only.** No formulas are evaluated,
   no other sheets are read (their presence is warned about), and TruePPM never writes an
   `.xlsx`.

8. **A CSV is not a backup.** It has no version, no manifest, no integrity information,
   and no way to represent most of a project. Use a JSON seed export (§4) or an export
   bundle.

---

## 6. Cross-cutting rules

### 6.1 Version everything that can be re-read

Any file TruePPM writes that TruePPM may later read carries a version discriminator
(ADR-0086, ADR-0204). The JSON seed carries `schema_version`. **CSV cannot**, which is
one more reason it is not a fidelity format — a CSV's meaning is fixed only by the header
names, so header names are a compatibility surface and renaming one is a breaking change.

### 6.2 Never emit a derived value into a T1 payload

CPM results (early/late dates, float, `is_critical`), `server_version`, and `short_id` are
computed. In a T1 payload they are absent by construction and their presence is a
validation error. They **may** appear in a T0 payload — that is what T0 is for — but the
surface must then be labeled T0 and excluded from importer inputs.

### 6.3 Privacy travels with the data, not with the format

Any field gated by ADR-0104 (team-private signals: story points, velocity) is gated
identically in every exporter regardless of format, and an export sits at the RBAC tier
of the *data*, not of the file type. The #1957 class of bug — a bulk export path that
bypassed the field-privacy model that every interactive read honored — is the failure mode
this rule exists to prevent.

### 6.4 Integrity and confidentiality: the 0.4 posture, stated

**As of 0.4, export artifacts are neither checksummed nor encrypted.** This is a
deliberate, documented position, not an oversight.

What protects an artifact today:

- generation is **Admin+ only**;
- download is **authenticated** — the archive is never served from a raw or presigned
  storage URL;
- the link **expires after 7 days** and a nightly job purges expired artifacts;
- artifacts live under `project-exports/` / `program-exports/` in storage the operator is
  documented as needing to keep **private**.

What is not protected, and must be said out loud: an artifact sitting in object storage is
readable by anyone who can read that bucket, and it contains member email addresses and —
at the Admin tier — team-private points and velocity.

Planned, and **explicitly not 0.4**:

| Capability | Design of record | Issue | Release |
|---|---|---|---|
| **SHA-256 integrity manifest** — a digest per bundle member, a digest over the manifest, exposed on download, verified on import | ADR-0634 §5 | #2399 | 0.5 |
| **Optional artifact encryption at rest** — opt-in per export, passphrase or recipient key, server retains no passphrase | ADR-0634 §5 | #2400 | 0.5 |

Signing is explicitly **rejected**, not deferred: a self-hosted single-tenant deployment
has no key-distribution story, and an unsigned digest that honestly detects corruption is
worth more than a signature nobody can verify (ADR-0634, alternatives).

### 6.5 Import is transactional; over-limit is rejected, never truncated

Every import runs inside one transaction. A file-level failure leaves nothing behind. A
file over the row or size limit is rejected with a `400` naming the limit and suggesting
a split — never partially processed, because a silently truncated import looks exactly
like a successful one.

### 6.6 One diagnostic *shape*; two strictness *policies*

The two formats emit the **same shape** of diagnostic and apply **deliberately opposite
defaults** about what is fatal. Both halves of that sentence are load-bearing, and the
second one is the one that gets "fixed" by mistake.

| | JSON seed | CSV |
|---|---|---|
| What it is | machine-generated, self-describing | hand-maintained, lossy by construction |
| Row/node-level degradation | **none** — every problem is fatal | **expected** — errors skip a row, warnings coerce a value |
| Partial success | impossible by design | the common case (§5.8) |

**Why JSON is fatal-only.** A seed document declares its own `schema_version` and is
produced by an exporter, not typed by a person. A dangling task reference is not a messy
cell — it means the file is not what it claims to be. Degrading would let a seed import
"successfully" minus some dependencies, which destroys the ADR-0109 byte-identical
round-trip guarantee: the whole reason the JSON seed is the fidelity format is that it is
all-or-nothing.

**Why CSV degrades.** A real spreadsheet has bad cells in it. Rejecting a 4,000-row sheet
over one unparseable date would make spreadsheet import useless, and spreadsheet import is
the migration path for teams whose plan currently lives in Excel (#111) — the single
largest source of new users. Degrading per row is not leniency; it is the feature.

**So:** do not "harmonize" these. The asymmetry is a decision about what each format *is*,
not drift between two implementations. What must stay identical is the diagnostic
**shape** — a stable machine-readable code, a location, a severity, and a human-readable
message — so one client can render a report from either importer without knowing which
produced it (#2420).

---

## 7. Conformance register

Surfaces that do not currently satisfy this spec. Each has a tracking issue; none is
fixed inside a docs change.

| Surface | Non-conformance | Issue |
|---|---|---|
| `riskExport.ts` | Writes humanized dates (`Jun 9, 2026`) instead of ISO, and humanized enum labels instead of stored values. `risk_import.py`'s three-format date fallback exists solely to read this. | #2401 |
| `exportCsv.ts` | Header spellings do not match the #743 importer's alias table, so the export is not readable by the import shipping beside it. (The computed/derived columns are **conformant** — this is a legitimate T0 surface, §5.6.2.) | #2401 |
| Task CSV import ↔ export | Not inverses (§5.10.2). Correct as specified for 0.4; promoting the export to T1 is a scoped follow-up. | #2401 |
| JSON seed validator | Emits unstructured `list[str]` diagnostics. No machine-readable code, no severity field, and the JSON path is embedded in the message prose rather than carried as a location — so a client cannot group or filter them the way it can CSV's (§6.6). | #2420 |
| JSON seed import | No dry-run counterpart to CSV's `/import/csv/preview/`. The validation exists and is thorough; there is no way to run it without committing to the import. | #2418 |
| JSON seed validator | Short-circuits on the `schema_version` checks, so a document missing its version reports one problem and hides the rest. §6.6 requires reporting the full set in one pass. | #2418 |
| All seed/bundle artifacts | No integrity manifest. | #2399 |
| All seed/bundle artifacts | No encryption at rest. | #2400 |
| All import surfaces | No T2 identity-preserving path. | #1959 |

A surface's presence here is not permission to ship new code that violates the spec. New
work conforms; only the listed pre-existing surfaces are grandfathered until their issue
lands.

---

## 8. Roadmap

| Release | Change |
|---|---|
| **0.3 and earlier** (shipped) | JSON seed v1/v2 export + program import; async project and program bundles; risk CSV import/export; MS Project XML both directions |
| **0.4** (underway) | Task CSV/Excel **import** with preview and fuzzy column mapping (#111 → #743 API, #746 wizard) · JSON seed dry-run validation (#2418) · confirmed, recoverable seed replacement and an asynchronous seed rebuild — `202` + job poll, `409 seed_replace_required`, soft-deleted replacement, `--no-replace` (#2581, #2574, ADR-0726). Artifacts remain unencrypted and unchecksummed — stated posture, §6.4 |
| **0.5** (planned) | Identity-preserving round trip, T2 (#1959) · integrity manifest (#2399) · optional artifact encryption (#2400) · CSV exporter conformance (#2401) · shared diagnostic model across both importers, §6.6 (#2420) |
| **0.6** (planned) | Multi-format import breadth — Jira, Asana, Monday, Wrike, ClickUp, Trello, Notion, Linear, Basecamp (epic #624), each normalizing to one of the two shared interchange targets rather than inventing a persistence path (see below) |

**Two normalization targets, split by what the import creates.** Epic #624 states that
every importer normalizes to the canonical JSON seed. That is accurate for importers that
**create a program from a file**, and inaccurate for importers that land in an **existing
project** — which is what the shipped MS Project and Jira adapters do, and what CSV does
(ADR-0632). Those normalize to the `ProjectData` interchange dataclass and persist through
`msproject.importer.import_project`. The constraint #624 actually cares about — *no
platform-specific persistence path* — is satisfied either way; what varies is which of the
two shared targets an adapter feeds:

| The import… | Normalizes to | Persists via |
|---|---|---|
| creates a program from a document | canonical JSON seed (§4) | `import_seed` |
| lands in an existing project | `ProjectData` | `import_project` |

Routing an into-existing-project import through the seed pipeline would be actively
unsafe: seed import is program-scoped replace-then-rebuild on the program slug (§3, T1), so
importing a spreadsheet into a live program would send that program's other projects to
Trash — recoverable individually, but detached from the program, which no longer exists.

The 0.6 line is the reason §4 matters beyond export: the canonical seed is the
**normalization target** every future importer converts *to*. An importer that writes
directly to the ORM instead of producing a seed is a design error.

---

## Related documents

- [ADR-0634](../adr/0634-file-interchange-contract-json-seed-and-csv.md) — the decision of record for this spec
- [ADR-0109](../adr/0109-canonical-json-seed-import-export-schema.md) — the seed schema and `validate_seed` contract
- [ADR-0114](../adr/0114-seed-schema-v2-relative-dates-event-replay.md) — v2 relative dates and event replay
- [ADR-0726](../adr/0726-seed-import-confirmed-replacement-and-async-rebuild.md) — confirmed, recoverable seed replacement and the asynchronous rebuild
- [ADR-0092](../adr/0092-import-project-from-file.md) — create-a-project-from-a-file
- [ADR-0219](../adr/0219-project-export-async-bundle.md) — the async export bundle
- [ADR-0043](../adr/0043-wave7-risks-risk-framework-matrix-filter-csv.md) — the risk register CSV columns
- [ADR-0104](../adr/0104-unified-team-signal-privacy-model.md) — the field-privacy model exports must honor
- `packages/api/src/trueppm_api/apps/projects/schemas/seed_v1.json`, `seed_v2.json` — the schemas themselves
