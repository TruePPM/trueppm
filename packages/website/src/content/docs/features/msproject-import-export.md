---
title: MS Project import & export
description: Import and export Microsoft Project .xml and .mpp files from the TruePPM Schedule view.
---

:::note[0.1 · UI added in 0.2]
The import/export REST endpoints shipped in 0.1. The in-app import and export
controls in the Schedule view shipped in **0.2**. Additional importers —
Primavera P6, GanttProject, OmniPlan, ProjectLibre, and the top-10 PM tools
(Jira, Asana, Trello, Notion, Linear, and more) — are planned for 0.5.
:::

TruePPM imports project schedules from Microsoft Project XML (`.xml`) and binary (`.mpp`) files, and exports any project back to MS Project XML. You can do both directly from the Schedule view, or call the REST endpoints. This page covers the in-app flow first, then the API, then which MS Project fields are mapped, ignored, and what warnings to expect for edge-case inputs.

## From the Schedule view

Both actions live in the Schedule view toolbar, under the **Project actions** (`···`) overflow menu:

- **Import from MS Project…** — opens the import modal.
- **Export to MS Project (.xml)** — downloads the project as MS Project XML.

### Import a file

1. Open the project's **Schedule** view.
2. Click the **Project actions** (`···`) overflow menu in the toolbar and choose **Import from MS Project…**.
3. Drag a file onto the dropzone (or click it to browse). Accepted formats are **`.mpp`** and **`.xml`**.
4. Confirm the import. The modal shows **"Import started"** and closes.

The import runs **asynchronously** — the worker parses the file in the background and the **schedule refreshes once it finishes**, so newly imported tasks appear shortly after the confirmation. There is no live progress bar yet; per-import progress display is tracked separately ([#61](https://gitlab.com/trueppm/trueppm/-/issues/61)).

:::note[Importing requires Project Admin]
The import action is enforced server-side: you must have the **Project Admin**
role on the project to import. Members below Admin do not see a usable import
control. Export is available to any project member (see below).
:::

:::caution[`.mpp` files need the server-side toolchain]
Importing a binary **`.mpp`** file requires the server to have the MS Project
(MPXJ / Java) toolchain installed. **`.xml`** imports always work. The import
modal shows a non-blocking note advising that, if a `.mpp` import fails, you can
open the file in MS Project, **Save As → XML**, and upload the `.xml` instead.
:::

### Export a project

Open the **Project actions** (`···`) overflow menu and choose **Export to MS Project (.xml)**. The browser downloads the current schedule as MS Project XML. Export is allowed for **any project member** — Viewer role and above.

## Using the API

Both operations are project-scoped and authenticated with a bearer token (`$JWT`); `$PROJECT_ID` is the project UUID.

### Import a file

```bash
# POST a .mpp or .xml file as multipart form-data (field name: "file").
# Requires project Admin. Default maximum file size 50 MB
# (configurable via MSPROJECT_MAX_UPLOAD_MB — see Configuration below).
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
| `<ExtendedAttributes>` | — | ⬜ Ignored |
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
| `<ExtendedAttribute>` values | — | ⬜ Ignored | Custom fields are not imported |

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

## Resource matching

When importing resources, TruePPM first searches for an existing `Resource` record with a name that matches case-insensitively. If a match is found the existing record is reused (no duplicate created). If no match exists, a new `Resource` record is created.

## Import warnings

The import summary includes a `warnings` list for non-fatal issues:

| Condition | Warning message |
|-----------|----------------|
| Task has no name | `"Task UID {n}: missing name, skipped"` |
| Dependency references an unknown predecessor | `"Predecessor UID {n} not found, skipping dependency"` |
| No tasks found in the file | `"No tasks found in MS Project file"` |

## Export

TruePPM exports projects to MS Project XML 2003+ format. All tasks, dependencies, resources, and assignments are written. Fields exported per task:

`UID`, `ID`, `Name`, `Duration` (hours), `Start`, `Finish`, `OutlineNumber`, `OutlineLevel`, `Milestone`, `PercentComplete`, `Notes`, `PredecessorLink` (with `Type` and `LinkLag`).

Resources: `UID`, `ID`, `Name`, `MaxUnits`.
Assignments: `UID`, `TaskUID`, `ResourceUID`, `Units`.

## Configuration

### Upload size limit

The per-file import cap defaults to **50 MB** and is set by the
`MSPROJECT_MAX_UPLOAD_MB` environment variable. See
[Configuration → MS Project import limit](/administration/configuration/#ms-project-import-limit)
for the full description and the hard ceiling.

### MPP import (MPXJ)

Binary `.mpp` import requires Java 11+ and the MPXJ CLI JAR:

```bash
# Default path (matches Docker image default)
MPXJ_JAR_PATH=/opt/mpxj/mpxj-cli.jar

# Override via Django settings or environment variable
```

If the toolchain is missing, `.mpp` imports fail and the in-app modal advises
saving the file as `.xml` and uploading that instead; `.xml` imports never
require MPXJ.

See [Configuration](/administration/configuration) for the full environment-variable reference.
