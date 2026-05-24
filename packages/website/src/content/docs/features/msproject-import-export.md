---
title: MS Project Import / Export
description: Import and export Microsoft Project .xml and .mpp files from TruePPM.
---

:::note[0.1]
MS Project import/export shipped in 0.1. Additional importers — Primavera P6, GanttProject, OmniPlan, ProjectLibre, and the top-10 PM tools (Jira, Asana, Trello, Notion, Linear, and more) — are planned for 0.5.
:::

TruePPM can import project schedules from Microsoft Project XML (`.xml`) and binary (`.mpp`) files, and export any project back to MS Project XML. This page documents which MS Project fields are mapped, which are silently ignored, and what warnings to expect for edge-case inputs.

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

### MPP import (MPXJ)

Binary `.mpp` import requires Java 11+ and the MPXJ CLI JAR:

```bash
# Default path (matches Docker image default)
MPXJ_JAR_PATH=/opt/mpxj/mpxj-cli.jar

# Override via Django settings or environment variable
```

See [Configuration](/administration/configuration) for full environment-variable reference.
