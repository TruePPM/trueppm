---
title: MS Project import & export
description: Create a project from a Microsoft Project file, import tasks into an existing project, export to MS Project XML, round-trip three-point / PERT estimates, and review import history.
---

:::note[Added in 0.2 (alpha)]
The import/export REST endpoints shipped in 0.1. The in-app create-from-import
flow (with the format picker), the import-into-existing dialog,
three-point / PERT round-trip, and the project import-history surface were all
**added in 0.2**, available since the `0.2.0-alpha.1` pre-release. 0.2 is an
alpha release; the first beta is planned for 0.4. Additional importers — Primavera P6,
GanttProject, OmniPlan, ProjectLibre, and the top-10 PM tools (Jira, Asana,
Trello, Notion, Linear, and more) — are planned for 0.6.
:::

TruePPM treats Microsoft Project as a peer interchange format. You can:

- **Create a new project from an MS Project file** — fastest path for migrators.
- **Import tasks into an existing project** — refresh or land tasks alongside the existing record.
- **Export any project back to MS Project XML** — round-trip with another tool.
- **Round-trip PERT three-point estimates** for Monte Carlo.
- **See the import history** on a project's Overview ("Imported from … on … by …").

Two file formats are supported on import: human-readable **`.xml`** (MSPDI; always supported), and binary **`.mpp`** when the server has the optional MPXJ / Java toolchain installed. Export is always `.xml`.

This page is organized by what you want to do. Start with the in-app flow, drop down to the REST API when you need automation, then consult the field-coverage tables for round-trip semantics.

## Create a project from a file

The fastest path for migrating a schedule into TruePPM. Two entry points open the same dialog:

- **Sidebar → New project → Import** — for a standalone project you own.
- **Program settings → Projects → Import project** — to land the new project inside an existing program. Requires program **Admin**.

In the dialog:

1. Pick a **format**. **TruePPM** is reserved for an upcoming native bundle and is currently disabled. **MS Project** is selected by default.
2. Pick a **file type**. **`.xml`** is enabled; **`.mpp`** and **`.mpx`** are visually present but disabled (see callout below). Click **"How do I get an .xml file from MS Project?"** for inline guidance — *"In MS Project (desktop): File → Save As, choose XML Format (*.xml), then Save."*
3. Drop the `.xml` file on the dropzone (or click to browse) and confirm.

You're navigated to the new project immediately. While the worker parses the file in the background, the project name is provisionally derived from the filename and the start date is today. Once the import finishes, both are **overwritten from the file header** and the schedule refreshes. The TopBar shows a quiet background-task indicator for the duration; a failed parse stays **terminal** — the project record remains so you can retry or delete it without losing the upload trail.

:::note[Any authenticated user can create a project this way]
Creating a standalone project from a file makes you its **Owner** automatically.
Assigning the new project to an existing **program** requires program **Admin**
on that program (matches the standard "New project" rules).
:::

:::caution[`.mpp` and `.mpx` are disabled by design]
The file-type picker currently disables `.mpp` (binary MS Project) and `.mpx`
(legacy / ProjectLibre) imports. The server can still accept `.mpp` if the
MPXJ / Java toolchain is installed (see
[Configuration → `.mpp` and Java](/administration/msproject-configuration/#mpp-and-java)),
but the in-app flow gates on file type to keep the experience predictable.
Use **File → Save As → XML Format** in MS Project and upload the `.xml`.
:::

## Import tasks into an existing project

Use this when the destination project already exists. From the project's **Schedule** view:

1. Open the **Project actions** (`···`) overflow menu in the toolbar.
2. Choose **Import from MS Project…**.
3. Drop a `.xml` (or `.mpp`, if the server supports it) file on the dropzone.
4. Confirm. The modal shows **"Import started"** and closes.

The import runs **asynchronously** — the worker parses the file in the background and the **schedule refreshes once it finishes**. There is no live per-import progress bar yet ([#61](https://gitlab.com/trueppm/trueppm/-/issues/61)).

:::note[Import-into-existing requires Project Admin]
The import action is enforced server-side: you must have the **Project Admin**
role on the project. Members below Admin do not see the import control. Export
is available to any project member (see below).
:::

## Export a project

Open the **Project actions** (`···`) overflow menu in the Schedule view and choose **Export to MS Project (.xml)**. The browser downloads the current schedule as MS Project XML 2003+. Export is allowed for **any project member** — Viewer role and above.

When the project has [three-point estimates](#three-point--pert-estimates) set on at least one work task, the export emits the standard PERT custom-field definitions and per-task values so the file round-trips with a `.xml` re-import (your own or another tool's).

## Project history

After any file import (successful or failed), the project's **Overview** page shows a **Project history** section listing recent imports — filename, when, who initiated it, status pill (Queued / Running / Complete / Failed), and tasks imported. The section is self-hiding: projects with no recorded imports don't see an empty placeholder.

This is the **recent-activity** view, not a durable audit log. Rows are retained for **7 days** (default `TRUEPPM_IMPORT_RETENTION_DAYS`), then purged. Long-lived audit retention lives on the enterprise overlay.

Reading the section requires **Member+** on the project — Viewer role and above. Programmatic access is via [`GET /projects/{pk}/imports/`](#list-recent-imports-project-history).

## Using the API

All operations authenticate with a bearer token (`$JWT`); `$PROJECT_ID` is the project UUID.

### Create a project from a file

```bash
# POST a .xml (or .mpp if MPXJ is installed) as multipart form-data (field: "file").
# Optional "program" field assigns the new project to a program — requires program Admin.
# Default upload cap 50 MB; configurable via MSPROJECT_MAX_UPLOAD_MB.
curl -X POST \
  -H "Authorization: Bearer $JWT" \
  -F "file=@plan.xml" \
  https://trueppm.example.com/api/v1/projects/import/msproject/
# 202 Accepted:
# {"queued": true, "project_id": "<uuid>", "import_request_id": "<uuid>"}
```

The project shell is created **synchronously** (you get back a usable `project_id`); tasks import asynchronously via the same outbox path as import-into-existing. The worker overwrites the shell's `name` and `start_date` from the file header once parsing succeeds. Parse failures stay **terminal** (DEAD `ImportRequest`, no retry), leaving the empty shell so you can retry the upload or delete the project.

### Import a file into an existing project

```bash
# POST a .mpp or .xml file as multipart form-data (field name: "file").
# Requires project Admin.
curl -X POST \
  -H "Authorization: Bearer $JWT" \
  -F "file=@plan.mpp" \
  https://trueppm.example.com/api/v1/projects/$PROJECT_ID/import/msproject/
# 202 Accepted: {"detail": "Import queued.", "import_request_id": "<uuid>"}
```

The import runs **asynchronously** — a `202` means the file was accepted and queued, not
that parsing is finished. Imports are durable: if the task broker is briefly unavailable
the request stays queued and is picked up automatically within ~30 seconds.

### Export a project

```bash
# GET MS Project XML (2003+). Requires project Member (viewer or above).
curl -H "Authorization: Bearer $JWT" \
  https://trueppm.example.com/api/v1/projects/$PROJECT_ID/export/msproject.xml \
  -o project.xml
```

### List recent imports (project history)

```bash
# GET recent imports for a project, newest first. Member+ read.
# Returns at most ~14 days' worth of activity; rows older than the configured
# TRUEPPM_IMPORT_RETENTION_DAYS (default 7) are purged.
curl -H "Authorization: Bearer $JWT" \
  https://trueppm.example.com/api/v1/projects/$PROJECT_ID/imports/
# 200 OK:
# {
#   "results": [
#     {
#       "id": "<uuid>",
#       "filename": "cloud_migration.xml",
#       "status": "done",
#       "creates_project": true,
#       "requested_at": "2026-05-28T13:11:54Z",
#       "initiated_by": 17,
#       "initiated_by_username": "marcus",
#       "task_count": 28
#     }
#   ]
# }
```

`task_count` is read from the linked Celery task's result summary, so it stays `null` until the import worker writes its summary (PENDING / DISPATCHED rows) and for parse failures (DEAD rows). `initiated_by_username` is `null` if the originating user was later deleted — the `ImportRequest` row survives the user purge.

## Import formats

| Format | Extension | Parser | Notes |
|--------|-----------|--------|-------|
| MS Project XML (2003+) | `.xml` | `parse_xml` | Preferred path; human-readable; supported by MS Project 2003–365, ProjectLibre, GanttProject, Primavera interop |
| MS Project XML (pre-2003) | `.xml` | `parse_xml` | Same parser; handles missing XML namespace |
| MS Project binary | `.mpp` | `parse_mpp` → `parse_xml` | Converted to XML by MPXJ CLI before parsing; requires Java 11+ and `MPXJ_JAR_PATH` |

## XML field-coverage matrix

### Project-level fields

| MS Project XML field | TruePPM field | Status |
|----------------------|---------------|--------|
| `<Name>` | `Project.name` | ✅ Mapped |
| `<StartDate>` | `Project.start_date` | ✅ Mapped |
| `<Title>` | — | ⬜ Ignored |
| `<CreationDate>` | — | ⬜ Ignored |
| `<FinishDate>` | — | ⬜ Ignored |
| `<DefaultStartTime>` | — | ⬜ Ignored |
| `<DefaultFinishTime>` | — | ⬜ Ignored |
| `<MinutesPerDay>` | — | ⬜ Ignored |
| `<MinutesPerWeek>` | — | ⬜ Ignored |
| `<DaysPerMonth>` | — | ⬜ Ignored |
| `<Calendars>` | — | ⬜ Ignored |
| `<ExtendedAttributes>` (PERT only) | three-point estimate mapping | ✅ Partial | Recognizes the four PERT `Duration1`–`Duration4` definitions; other custom-field families are ignored. See [Three-point / PERT estimates](#three-point--pert-estimates). |
| `<OutlineCodes>` | — | ⬜ Ignored |

### Task-level fields

| MS Project XML field | TruePPM field | Status | Notes |
|----------------------|---------------|--------|-------|
| `<UID>` | internal mapping key | ✅ Required | UID 0 (project summary) is always skipped |
| `<Name>` | `Task.name` | ✅ Required | Tasks missing a name are skipped with a warning |
| `<Duration>` | `Task.duration` | ✅ Mapped | ISO 8601 duration; converted to working days at 8 h/day |
| `<OutlineNumber>` | `Task.wbs_path` | ✅ Mapped | Dot-separated WBS code (e.g. `1.2.3`) |
| `<OutlineLevel>` | hierarchy depth | ✅ Mapped | Used for parent/child detection |
| `<Milestone>` | `Task.is_milestone` | ✅ Mapped | `1` → `is_milestone=True`; milestone duration is always imported as 0 |
| `<PercentComplete>` | `Task.percent_complete` | ✅ Mapped | Integer 0–100 → decimal 0.0–1.0 |
| `<Notes>` | `Task.notes` | ✅ Mapped | Free-text notes |
| `<Start>` | `Task.planned_start` | ✅ Mapped | Date portion only; time component ignored |
| `<PredecessorLink>/<PredecessorUID>` | `Dependency.predecessor` | ✅ Mapped | |
| `<PredecessorLink>/<Type>` | `Dependency.dep_type` | ✅ Mapped | 0→FF, 1→FS, 2→SF, 3→SS |
| `<PredecessorLink>/<LinkLag>` | `Dependency.lag` | ✅ Mapped | Tenths-of-minutes → working days (4800 = 1 day) |
| `<ID>` | — | ⬜ Ignored | |
| `<Summary>` | — | ⬜ Ignored | Summary status derived from WBS hierarchy |
| `<Finish>` | — | ⬜ Ignored | Derived from `start + duration` after CPM |
| `<WBS>` | — | ⬜ Ignored | Modern WBS field; `OutlineNumber` is used instead |
| `<GUID>` | — | ⬜ Ignored | |
| `<CalendarUID>` | — | ⬜ Ignored | |
| `<LagFormat>` | — | ⬜ Ignored | Lag always interpreted as tenths-of-minutes |
| `<ExtendedAttribute>` `Duration1` | `Task.optimistic_duration` | ✅ Mapped | PERT Optimistic; FieldID `188743783`. See [Three-point / PERT estimates](#three-point--pert-estimates). |
| `<ExtendedAttribute>` `Duration2` | `Task.most_likely_duration` | ✅ Mapped | PERT Most Likely; FieldID `188743784`. |
| `<ExtendedAttribute>` `Duration3` | `Task.pessimistic_duration` | ✅ Mapped | PERT Pessimistic; FieldID `188743785`. |
| `<ExtendedAttribute>` `Duration4` | — | ⬜ Ignored | PERT-Expected formula slot; MS Project re-derives it on file open. |
| `<ExtendedAttribute>` (other) | — | ⬜ Ignored | Cost / Text / Flag / Number / Date custom fields are not imported. |

### Resource fields

| MS Project XML field | TruePPM field | Status |
|----------------------|---------------|--------|
| `<UID>` | internal mapping key | ✅ Required | UID 0 (unassigned) is always skipped |
| `<Name>` | `Resource.name` | ✅ Required | Case-insensitive match against existing resources |
| `<MaxUnits>` | `Resource.max_units` | ✅ Mapped | Decimal 0.0–1.0 |
| `<GUID>` | — | ⬜ Ignored |
| `<EmailAddress>` | — | ⬜ Ignored |
| `<NTAccount>` | — | ⬜ Ignored |
| `<CalendarUID>` | — | ⬜ Ignored |

### Assignment fields

| MS Project XML field | TruePPM field | Status |
|----------------------|---------------|--------|
| `<TaskUID>` | `TaskResource.task` | ✅ Required |
| `<ResourceUID>` | `TaskResource.resource` | ✅ Required | Assignments to UID 0 (unassigned) are skipped |
| `<Units>` | `TaskResource.units` | ✅ Mapped | Decimal allocation (0.5 = 50 %) |

## Duration encoding

MS Project XML stores duration as ISO 8601 strings. TruePPM converts to whole working days using an 8-hour working day:

| MS Project duration | Working days | Notes |
|--------------------|--------------|-------|
| `PT0H0M0S` | 0 | Milestone (zero-duration task) |
| `PT8H0M0S` | 1 | Standard 1-day task |
| `PT16H0M0S` | 2 | 2-day task |
| `P3D` | 3 | `PnD` format (less common) |
| `P1DT8H0M0S` | 2 | Mixed days + hours |

## Dependency type mapping

| MS Project `<Type>` | TruePPM `dep_type` | Description |
|--------------------|--------------------|-------------|
| `0` | `FF` | Finish-to-Finish |
| `1` | `FS` | Finish-to-Start (default) |
| `2` | `SF` | Start-to-Finish |
| `3` | `SS` | Start-to-Start |

Unrecognized type values default to `FS`.

## Three-point / PERT estimates

MS Project has no native PERT fields since 2013. The idiomatic storage — shared by Microsoft's published guidance, MPXJ, and the third-party PPM ecosystem — is four aliased custom `Duration` fields:

| MS Project | Alias | TruePPM field |
|---|---|---|
| `Duration1` | Optimistic | `Task.optimistic_duration` |
| `Duration2` | Most Likely | `Task.most_likely_duration` |
| `Duration3` | Pessimistic | `Task.pessimistic_duration` |
| `Duration4` | PERT Expected (formula) | — (derived) |

TruePPM imports and exports this convention on both create-from-import and import-into-existing flows, and uses the values directly for [Monte Carlo](/features/scheduler/#monte-carlo-simulation) PERT-Beta sampling.

**On import**, TruePPM detects the PERT slots by their canonical numeric **FieldIDs** (sourced from MPXJ, not guessed; see [ADR-0093](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0093-msproject-three-point-pert-mapping.md) for the locked values and rationale). The alias text is treated as a confirmation: if the FieldID matches `Duration1` but the alias contradicts (e.g. someone repurposed `Duration1` as "Risk Score"), the binding is **refused** and a warning is added to the import summary. This protects Monte Carlo input from silent corruption when files reuse the slots for other purposes.

**All-or-none.** A task is imported with three-point values only when all three (Optimistic, Most Likely, Pessimistic) are present in the file. Partial data — e.g. `Duration1` and `Duration2` set but `Duration3` missing — drops all three and emits a warning. This matches the scheduler engine's invariant: PERT-Beta sampling requires all three.

**Summaries and milestones are skipped** in both directions. MS Project files conventionally leave `Duration1–3` empty on these rows; if a file violates the convention, TruePPM still drops them to keep the round-trip stable.

**`estimate_status` on import.** Imported three-point values are written with `estimate_status = "accepted"` regardless of the project's `estimation_mode`. The uploader holds project-admin permission and the values are PM-authored migration data, not contributor suggestions — re-approval per task under `SUGGEST_APPROVE` would be busywork.

**Round-trip tolerance.** Durations that are integer multiples of 8 hours round-trip losslessly. Non-multiples (e.g. `PT23H`) round down to the next lower working-day count on import; subsequent re-export emits the rounded value. This is the same tolerance the primary `Duration` field has had since the importer shipped.

**On export**, the four `<ExtendedAttributes>` definitions are emitted at project level (`Duration4` carries the formula `([Duration1] + 4*[Duration2] + [Duration3]) / 6`) only when at least one non-summary, non-milestone task has all three values set. Per-task `<ExtendedAttribute>` values are emitted for leaf work tasks. Re-opening the exported file in MS Project shows the four custom-field columns populated and `Duration4` computed.

## Resource matching

When importing resources, TruePPM first searches for an existing `Resource` record with a name that matches case-insensitively. If a match is found the existing record is reused (no duplicate created). If no match exists, a new `Resource` record is created.

## Import warnings

The import summary includes a `warnings` list for non-fatal issues:

| Condition | Warning message |
|-----------|----------------|
| Task has no name | `"Task UID {n}: missing name, skipped"` |
| Dependency references an unknown predecessor | `"Predecessor UID {n} not found, skipping dependency"` |
| No tasks found in the file | `"No tasks found in MS Project file"` |
| PERT slot has a contradicting alias | `"Project ExtendedAttribute FieldID {fid} has non-standard alias '{alias}'; three-point estimate ({role}) skipped"` |
| Task has partial three-point data | `"Task '{name}': partial three-point estimate (missing {fields}), all three values skipped"` |

The import summary also includes two counts you can use to confirm three-point coverage at a glance:

- `tasks_with_three_point_estimates` — leaf tasks that received all three values.
- `tasks_skipped_partial_three_point` — tasks for which the file supplied a subset (1 or 2 of the three values).

## Export details

TruePPM exports projects to MS Project XML 2003+ format. All tasks, dependencies, resources, and assignments are written. Fields exported per task:

`UID`, `ID`, `Name`, `Duration` (hours), `Start`, `Finish`, `OutlineNumber`, `OutlineLevel`, `Milestone`, `PercentComplete`, `Notes`, `PredecessorLink` (with `Type` and `LinkLag`), and the four PERT `ExtendedAttribute` values when three-point estimates are present (see above).

Resources: `UID`, `ID`, `Name`, `MaxUnits`.
Assignments: `UID`, `TaskUID`, `ResourceUID`, `Units`.

## Configuration

Operator-facing configuration — upload size limit, the optional MPXJ / Java toolchain for `.mpp` import, the import-history retention window, and a quick reference to the security boundaries on parsed files — lives at **[MS Project configuration](/administration/msproject-configuration/)**.

At a glance: the per-file upload cap defaults to **50 MB** (`MSPROJECT_MAX_UPLOAD_MB`); `.xml` imports always work; `.mpp` imports need `MPXJ_JAR_PATH` and a Java 11+ runtime in the container; `ImportRequest` history rows are retained for **7 days** by default (`TRUEPPM_IMPORT_RETENTION_DAYS`).
