---
title: MS Project import & export
description: Create a project from a Microsoft Project file, import tasks into an existing project, export to MS Project XML, round-trip three-point / PERT estimates, review import history, and see exactly which fields do not survive the trip.
documentedFor: "0.4"
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

:::note[Ships in 0.4 — everything about constraints, actuals, dropped-field
reporting, and the `.xml`-only file pickers]
Five things on this page land in **TruePPM 0.4**, the first beta. On
`0.3.0-alpha.3` and earlier:

1. **Constraint dates and actual start / finish dates are not imported at all** —
   the rows for `<ConstraintType>`, `<ConstraintDate>`, `<ActualStart>` and
   `<ActualFinish>` in the [task field matrix](#task-level-fields) describe 0.4.
2. **Nothing tells you what was dropped.** The
   [What the import does not carry over](#what-the-import-does-not-carry-over)
   section and the last three rows of the
   [import-warnings table](#import-warnings) describe 0.4; before it, an MS
   Project file carrying constraints, deadlines and baselines imported with an
   empty warnings list.
3. **`GET /projects/{pk}/imports/` returns no `warnings` key.** The
   [List recent imports](#list-recent-imports-project-history) example shows the
   0.4 response — on the latest release the field is absent entirely, not empty.
4. **Export writes no `ConstraintType` / `ConstraintDate` / `ActualStart` /
   `ActualFinish`**, so a round trip through 0.3 or earlier still promotes
   computed dates to committed ones. See the caution under
   [Export details](#export-details).
5. **The import-into-existing dialog offers `.mpp`** alongside `.xml`, even
   though the reference image cannot parse it — see
   [`.mpp` — what actually works](#mpp--what-actually-works).

Everything else on this page describes shipped behavior.
:::

**`.xml` (MSPDI) is the import format**, in both file pickers and on both
endpoints. Binary **`.mpp`** is accepted by the API *only* on a deployment where
an operator has installed the optional MPXJ / Java toolchain — the reference
image bundles neither, so `.mpp` is not offered in the UI. Export is always
`.xml`. See [`.mpp` — what actually works](#mpp--what-actually-works).

This page is organized by what you want to do. Start with the in-app flow, drop down to the REST API when you need automation, then consult the field-coverage tables for round-trip semantics — including [what is *not* carried over](#what-the-import-does-not-carry-over), which for a migrating plan is the more important table.

## Create a project from a file

The fastest path for migrating a schedule into TruePPM. Two entry points open the same dialog:

- **Sidebar → New project → Import** — for a standalone project you own.
- **Program settings → Projects → Import project** — to land the new project inside an existing program. Requires program **Admin**.

In the dialog:

1. Pick a **format**. **TruePPM** is reserved for an upcoming native bundle and is currently disabled. **MS Project** is selected by default.
2. Pick a **file type**. **`.xml`** is enabled; **`.mpp`** and **`.mpx`** are visually present but disabled (see [`.mpp` — what actually works](#mpp--what-actually-works)). Click **"How do I get an .xml file from MS Project?"** for inline guidance — *"In MS Project (desktop): File → Save As, choose XML Format (*.xml), then Save."*
3. Drop the `.xml` file on the dropzone (or click to browse) and confirm.

You're navigated to the new project immediately. While the worker parses the file in the background, the project name is provisionally derived from the filename and the start date is today. Once the import finishes, both are **overwritten from the file header** and the schedule refreshes. The TopBar shows a quiet background-task indicator for the duration; a failed parse stays **terminal** — the project record remains so you can retry or delete it without losing the upload trail.

:::note[Any authenticated user can create a project this way]
Creating a standalone project from a file makes you its **Owner** automatically.
Assigning the new project to an existing **program** requires program **Admin**
on that program (matches the standard "New project" rules).
:::

### `.mpp` — what actually works

Three surfaces used to give three different answers to "can I upload a `.mpp`?".
Here is the single one, top to bottom:

| Surface | `.mpp` | Why |
|---|---|---|
| Create-from-import file-type picker | Disabled, labelled "Not yet supported" | First-class `.mpp` import is [#128](https://gitlab.com/trueppm/trueppm/-/issues/128), sequenced for 0.6 |
| Import-into-existing dropzone | Rejected before upload | Ships in 0.4 — it previously accepted `.mpp` and showed a caveat banner |
| `POST …/import/msproject/` (REST) | **Accepted** | The operator escape hatch, unchanged |
| Reference Docker image | Cannot parse it | Bundles neither the MPXJ JAR nor a JRE |

So on a stock deployment a `.mpp` uploaded through the API returns `202`, and the
worker then fails with `"MPXJ JAR not found"`. That reason has nowhere to surface
today ([#2714](https://gitlab.com/trueppm/trueppm/-/issues/2714)), which is why
the file pickers no longer offer a path that ends there.

To enable `.mpp` on your own deployment, install the toolchain and point
`MPXJ_JAR_PATH` at the JAR — see
[Configuration → `.mpp` and Java](/administration/msproject-configuration/#mpp-and-java).
`MPXJ_JAR_PATH` is a settings-module value with no environment-variable binding.
Even then, the *UI* stays `.xml`-only until 0.6; the escape hatch is the API.

Otherwise: **File → Save As → XML Format** in MS Project and upload the `.xml`.
Nothing TruePPM reads is lost in that conversion.

## Import tasks into an existing project

Use this when the destination project already exists. From the project's **Schedule** view:

1. Open the **Project actions** (`···`) overflow menu in the toolbar.
2. Choose **Import from MS Project…**.
3. Drop a `.xml` file on the dropzone. A `.mpp` is rejected here with the Save-As-XML instruction; see [`.mpp` — what actually works](#mpp--what-actually-works).
4. Confirm. The modal shows **"Import started"** and closes.

The import runs **asynchronously** — the worker parses the file in the background and the **schedule refreshes once it finishes**. There is no live per-import progress bar yet ([#61](https://gitlab.com/trueppm/trueppm/-/issues/61)).

:::note[Import-into-existing requires Project Admin]
The import action is enforced server-side: you must have the **Project Admin**
role on the project. Members below Admin do not see the import control. Export
is available to any project member (see below).
:::

:::caution[A circular predecessor link rejects the whole file]
If the file's predecessor links form a cycle (task 1 depends on 2, and 2 depends
on 1), or a task lists itself as its own predecessor, the import is rejected
**before anything is written** — no tasks, no dependencies, and no change to the
project name or start date. A cyclic network has no critical path, so importing
it would produce a schedule the engine cannot compute. Fix the loop in MS Project
and re-upload.

This applies to both entry points — creating a project from a file and importing
into an existing one.
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
# Rows older than TRUEPPM_IMPORT_RETENTION_DAYS (default 7) are purged, so this
# returns at most that many days' worth of activity.
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
#       "task_count": 28,
#       "warnings": [
#         "Not imported: deadline dates (TruePPM has no deadline field) — set on 6 of 28 tasks."
#       ]
#     }
#   ]
# }
```

`task_count` is read from the linked Celery task's result summary, so it stays `null` until the import worker writes its summary (PENDING / DISPATCHED rows) and for parse failures (DEAD rows). `initiated_by_username` is `null` if the originating user was later deleted — the `ImportRequest` row survives the user purge.

`warnings` is read from the same summary and is `[]` for a queued or failed import. It is where an automated migration checks whether the file lost anything — see [What the import does not carry over](#what-the-import-does-not-carry-over).

:::caution[Match the marker, never the whole warning string]
The warning **strings are prose, not a contract** — they are formatted messages
meant for a person, and a copy edit will reword any of them without that counting
as an API change. What *is* stable is the leading marker: every entry begins
`Not imported: `, `Partially imported: `, or names a per-task condition from the
[warnings table](#import-warnings). Key your check on the marker and treat the
remainder as display text.

The **order** is deterministic but not part of the contract either: dropped
field families first in the order of the matrix, then unmappable constraint types
by ascending MS Project code, then the partially-imported line. Do not depend on
positions.
:::

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
| `<Calendars>` | `Calendar` / `CalendarException` | ✅ Mapped | Base calendars only. See [Working calendars](#working-calendars). |
| `<CalendarUID>` | `Project.calendar` | ✅ Mapped | Selects which base calendar the project is scheduled on. |
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
| `<PercentComplete>` | `Task.percent_complete` | ✅ Mapped | Integer 0–100 (same scale both sides) |
| `<Notes>` | `Task.notes` | ✅ Mapped | Free-text notes |
| `<Start>` | `Task.planned_start` | ✅ Mapped | Date portion only; time component ignored. A `<ConstraintDate>` on a supported constraint type wins over this — see the next two rows. |
| `<ConstraintType>` | `Task.planned_start` (codes 2, 4 only) | 🟡 Partial | `4` Start No Earlier Than is exactly `planned_start`'s meaning and is carried across. `2` Must Start On becomes the same start floor **and warns**, because TruePPM cannot also stop the task starting later. `0` As Soon As Possible is TruePPM's own default. `1` ALAP, `3` Must Finish On, `5` SNLT, `6` FNET and `7` FNLT have no TruePPM equivalent and are reported in the import warnings with a task count. |
| `<ConstraintDate>` | `Task.planned_start` | 🟡 Partial | Read only alongside a code TruePPM applies (2 or 4). This is the date the PM *committed to*, so it takes precedence over the computed `<Start>` — importing the computed date instead was how a migrated plan quietly lost its commitments. |
| `<ActualStart>` | `Task.actual_start` | ✅ Mapped | Date portion only. `NA` and unparseable values import as empty rather than as a date. |
| `<ActualFinish>` | `Task.actual_finish` | ✅ Mapped | Date portion only. |
| `<Deadline>` | — | ⬜ Ignored | TruePPM has no deadline field. Reported in the import warnings with a task count. |
| `<Baseline>` | — | ⬜ Ignored | Reported with a count. Capture a [TruePPM baseline](/features/baselines/) after the import lands instead — it will then reflect the imported dates. |
| `<Priority>` | — | ⬜ Ignored | MS Project's 0–1000 weight is not `Task.priority_rank`, which is an ordinal position. Reported with a count when the value is not the 500 default. |
| `<Work>` | — | ⬜ Ignored | TruePPM schedules on duration, not effort. Reported with a count when non-zero. |
| `<Cost>` | — | ⬜ Ignored | TruePPM tracks no task cost. Reported with a count when non-zero. |
| `<ActualDuration>` / `<RemainingDuration>` | — | ⬜ Ignored | Derived from `duration` and `percent_complete` after CPM. |
| `<PredecessorLink>/<PredecessorUID>` | `Dependency.predecessor` | ✅ Mapped | |
| `<PredecessorLink>/<Type>` | `Dependency.dep_type` | ✅ Mapped | 0→FF, 1→FS, 2→SF, 3→SS |
| `<PredecessorLink>/<LinkLag>` | `Dependency.lag` | ✅ Mapped | Tenths-of-minutes → working days (4800 = 1 day) |
| `<ID>` | — | ⬜ Ignored | |
| `<Summary>` | — | ⬜ Ignored | Summary status derived from WBS hierarchy |
| `<Finish>` | — | ⬜ Ignored | Derived from `start + duration` after CPM |
| `<WBS>` | — | ⬜ Ignored | Modern WBS field; `OutlineNumber` is used instead |
| `<GUID>` | — | ⬜ Ignored | |
| `<CalendarUID>` | — | 🟡 Partial | TruePPM has no per-task calendars. A task referencing a calendar other than the project calendar imports with a warning and is scheduled on the project calendar. |
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
| `<CalendarUID>` | — | ⬜ Ignored | Resource calendars (`IsBaseCalendar=0`) have no TruePPM equivalent |

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

## Working calendars

The file's `<Calendars>` block round-trips with TruePPM's working calendars, so a plan built on holidays or a non-5×8 week (4×10s, etc.) keeps its dates after import instead of being rescheduled on the default Monday–Friday / 8-hour calendar.

**On import**, the base calendar selected by the project-level `<CalendarUID>` (or the file's only base calendar, when the header omits the UID) becomes the project's working calendar:

- **Weekdays** — each `<WeekDay>` entry maps onto the `Calendar.working_days` mask. Files that list all seven days (as MS Project itself writes) map exactly; sparse files only adjust the days they mention, starting from the Monday–Friday default.
- **Hours per day** — TruePPM stores a single daily hour total, not shift times. Per-day `<WorkingTimes>` collapse to the most common daily total across working days. Shift start/end times are not preserved.
- **Exceptions** — non-working `<Exception>` ranges (holidays, shutdowns) become `CalendarException` rows, names included. Both the `<TimePeriod>` and `EnteredStartDate`/`EnteredFinishDate` encodings are read, as is the legacy `DayType=0` form. Exceptions that *add* working time (`DayWorking=1`, e.g. a make-up Saturday) cannot be represented and are skipped with a warning.
- **Library reuse** — the calendar row is reused from the shared calendar library when an existing calendar has the same name *and* identical semantics (mask, hours, exception ranges); otherwise a new row is created. Repeated imports converge on one row.
- **Overwrite policy** — create-from-import treats the file's calendar as authoritative. Import-into-existing keeps a project's already-configured calendar and warns when the file's calendar differs (imported dates may shift in that case).
- **Degraded**: per-task calendars (task `<CalendarUID>`) — TruePPM schedules every task on the project calendar and warns once per referenced calendar. Per-resource calendars (`IsBaseCalendar=0`) are not imported.

**On export**, the project's applied calendars are emitted as a single base calendar (`UID` 1) referenced by the project-level `<CalendarUID>`. [Composable calendar layers](/features/calendars/) have no MSPDI equivalent, so they are folded the same way the scheduler composes them — weekday masks AND-ed, exception ranges unioned — and each working day is written as one continuous shift starting at 08:00. The exported file schedules on the same non-working mask TruePPM computed.

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

## What the import does not carry over

TruePPM's schedule is computed — durations, dependencies and a calendar produce
the dates. Several MS Project fields describe things TruePPM has no column for,
so they are not imported. Every one of them is **reported** in the import
`warnings` with a per-family task count, so a migration can be checked rather
than assumed:

| Not imported | Why | Do this instead |
|---|---|---|
| Constraint types other than Start No Earlier Than and Must Start On | `Task.planned_start` is a start-no-earlier-than floor and is the only constraint TruePPM models | Express a finish commitment as a milestone with a predecessor, or track it outside the schedule |
| `<Deadline>` | No deadline field | Same — a milestone is the closest equivalent |
| `<Baseline>` blocks | TruePPM baselines are captured from the live schedule, not imported | Capture a [baseline](/features/baselines/) once the import lands |
| `<Priority>` (0–1000 weight) | `Task.priority_rank` is an ordinal position within the project, not a weight — mapping one onto the other would invent an ordering | Re-rank on the board after import |
| `<Work>` / `<Cost>` | TruePPM schedules on duration and tracks no task cost | Keep effort and cost in the system that owns them |

A "Must Start On" constraint is the one partial case: its date becomes the task's
start floor and the import says so, because TruePPM enforces the "no earlier"
half and cannot enforce the "no later" half.

:::caution[Exported `<Start>` is a computed date — re-importing promotes it]
Export writes each task's CPM `early_start` as `<Start>`, and per
[ADR-0132](/architecture/decisions/) that is a *remaining-work* date on a
partially-complete task, not the date work began. From 0.4 the export will also
write `<ConstraintType>`/`<ConstraintDate>` for any task with a
`planned_start`, so a TruePPM → MS Project → TruePPM round trip preserves the
commitment rather than replacing it with whatever CPM had computed. A file
exported by **0.3 or earlier** carries no constraint, so re-importing it still
turns computed starts into committed ones — re-export from 0.4 before you round
trip. The same caveat applies to the [CSV path](/features/csv-import-export/).
:::

## Import warnings

The import summary includes a `warnings` list for non-fatal issues:

| Condition | Warning message |
|-----------|----------------|
| Task has no name | `"Task UID {n}: missing name, skipped"` |
| Dependency references an unknown predecessor | `"Predecessor UID {n} not found, skipping dependency"` |
| No tasks found in the file | `"No tasks found in MS Project file"` |
| PERT slot has a contradicting alias | `"Project ExtendedAttribute FieldID {fid} has non-standard alias '{alias}'; three-point estimate ({role}) skipped"` |
| Task has partial three-point data | `"Task '{name}': partial three-point estimate (missing {fields}), all three values skipped"` |
| Tasks reference a non-project calendar | `"{n} task(s) reference calendar '{name}' (UID {uid}); TruePPM has no per-task calendars — they are scheduled on the project calendar"` |
| Calendar exception adds working time | `"Calendar '{name}': working-time exception '{exception}' is not supported and was skipped"` |
| File calendar conflicts with the project's configured calendar | `"File calendar '{name}' differs from the project's configured calendar '{name}'; the project calendar was kept — imported dates may shift"` |
| Project `CalendarUID` not found among base calendars | `"Project calendar UID {uid} not found among the file's base calendars; project calendar left unchanged"` |
| A field family TruePPM has no column for | `"Not imported: {what} — set on {n} of {total} tasks."` (see [What the import does not carry over](#what-the-import-does-not-carry-over)) |
| A constraint type TruePPM cannot express | `"Not imported: '{MS Project name}' constraints — set on {n} of {total} tasks. TruePPM models only start-no-earlier-than, so these tasks are scheduled from their dependencies alone."` |
| A Must Start On constraint | `"Partially imported: 'Must Start On' constraints on {n} of {total} tasks became start-no-earlier-than dates. The start is pinned; TruePPM cannot also stop the task starting later."` |

The import summary also includes two counts you can use to confirm three-point coverage at a glance:

- `tasks_with_three_point_estimates` — leaf tasks that received all three values.
- `tasks_skipped_partial_three_point` — tasks for which the file supplied a subset (1 or 2 of the three values).

## Export details

TruePPM exports projects to MS Project XML 2003+ format. All tasks, dependencies, resources, and assignments are written. Fields exported per task:

`UID`, `ID`, `Name`, `Duration` (hours), `Start`, `Finish`, `OutlineNumber`, `OutlineLevel`, `Milestone`, `PercentComplete`, `Notes`, `ConstraintType`, `ConstraintDate` (when the task has a `planned_start`), `ActualStart` / `ActualFinish` (when set), `PredecessorLink` (with `Type` and `LinkLag`), and the four PERT `ExtendedAttribute` values when three-point estimates are present (see above).

`ConstraintType` is always written: `4` (Start No Earlier Than) with the task's
`planned_start` as `ConstraintDate`, or `0` (As Soon As Possible) when the task
has no start floor. Omitting it would let MS Project infer a constraint from the
computed `<Start>` — the same computed-becomes-committed promotion described in
the caution above, in the other direction.

Resources: `UID`, `ID`, `Name`, `MaxUnits`.
Assignments: `UID`, `TaskUID`, `ResourceUID`, `Units`.

When the project has a working calendar applied, the export also writes the project-level `CalendarUID` and a `<Calendars>` block with the folded calendar — weekdays, working times, and exceptions (see [Working calendars](#working-calendars)).

## Configuration

Operator-facing configuration — upload size limit, the optional MPXJ / Java toolchain for `.mpp` import, the import-history retention window, and a quick reference to the security boundaries on parsed files — lives at **[MS Project configuration](/administration/msproject-configuration/)**.

At a glance: the per-file upload cap defaults to **50 MB** (`MSPROJECT_MAX_UPLOAD_MB`); `.xml` imports always work; `.mpp` imports need `MPXJ_JAR_PATH` and a Java 11+ runtime in the container; `ImportRequest` history rows are retained for **7 days** by default (`TRUEPPM_IMPORT_RETENTION_DAYS`).
