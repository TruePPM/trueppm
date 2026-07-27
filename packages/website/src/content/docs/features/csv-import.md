---
title: CSV / Excel import
description: Import a CSV or Excel spreadsheet into an existing TruePPM project — fuzzy column auto-detection, a preview that persists nothing, WBS hierarchy from indentation or an outline column, and row-level errors that never block the rows that are fine.
---

:::note[Coming in 0.4]
CSV / Excel import lands in **TruePPM 0.4**, the first beta. On unreleased
builds the column aliases and endpoints may still be changing.
:::

Most teams that have never used dedicated project software still run a real
schedule — in Excel, or in a Google Sheet shared over email. For them the barrier
to adopting TruePPM is not features, it is **getting the existing plan in without
retyping it**. CSV / Excel import removes that barrier: upload the sheet, confirm
what each column means, and TruePPM builds a CPM-schedulable network from it —
tasks, durations, dates, a WBS hierarchy, dependencies, and assignees.

This is also the import path for the many tools that export CSV. Asana, Trello,
Basecamp and others all produce a CSV you can feed directly to this endpoint.

:::note[An offline import, not a live connector]
Like [MS Project](/features/msproject-import-export/) and
[Jira](/features/jira-import/) import, this is a **one-way, file-based,
point-in-time** migration. TruePPM never talks to your spreadsheet's source,
never authenticates against it, and never writes anything back.
:::

## What a good spreadsheet looks like

The importer expects a **header row** followed by task rows. Nothing else is
required — every column below is optional except the task name.

Download the [known-good template](#download-the-template) if you want a target
shape to paste into.

| TruePPM field | Header spellings recognized |
|---|---|
| Task name **(required)** | `Name`, `Task`, `Title`, `Task Name`, `Activity`, `Summary` |
| ID | `ID`, `Task ID`, `UID`, `No`, `Number`, `Ref`, `Key` |
| WBS / phase | `WBS`, `WBS Code`, `Phase`, `Level`, `Outline`, `Outline Number` |
| Duration | `Duration`, `Days`, `Effort`, `Estimate`, `Work Days` |
| Start | `Start`, `Begin`, `Start Date`, `Planned Start` |
| Finish | `Finish`, `End`, `Due`, `Due Date`, `Planned Finish` |
| % complete | `% Complete`, `Percent Complete`, `Done`, `Progress` |
| Assignee | `Assignee`, `Owner`, `Resource`, `Assigned To`, `Responsible` |
| Predecessors | `Predecessors`, `Depends On`, `Dependency`, `Blocked By`, `After` |
| Milestone | `Milestone` |
| Notes | `Notes`, `Description`, `Comment`, `Detail` |
| Labels | `Labels`, `Label`, `Tags`, `Tag`, `Category`, `Component`, `Stream`, `Workstream` |

Matching is **case-insensitive, punctuation-insensitive, and plural-aware**, so
`% Complete`, `%complete` and `Percent Completes` all resolve to the same field.
Anything the importer cannot place is shown to you as unmapped rather than
silently dropped, and you can assign it yourself before committing.

### Columns that can appear more than once

Most fields take exactly one column — two `Name` columns is a mistake, so the
second is reported as a duplicate and dropped rather than merged.

**Labels and Predecessors are the exceptions.** Both accept several source
columns, and the values are unioned onto the task:

- A sheet carrying `Tags`, `Component` **and** `Team` gets all three as labels.
- An MS Project export that spreads dependencies across `Predecessor 1` and
  `Predecessor 2` gets both links. The same reference appearing in two columns
  is one relationship, not two.

If auto-detection places only one of them, map the others to the same field
yourself in the [column overrides](#2-override-any-column-you-disagree-with).

### Labels

One cell can carry several labels, separated by `,` `;` or `/` — the same
convention the assignee column uses. `safety, rework` becomes two labels.

Names are matched against your project's **existing label catalog,
case-insensitively**, so importing a sheet that says `Safety` into a project
that already has `safety` reuses the existing label instead of creating a
near-duplicate you then have to merge. The catalog's spelling wins. Labels that
do not exist yet are created and given distinct colors.

Labels are **project-scoped**: a label of the same name in another project is a
different label and is not matched.

An import is capped at 100 distinct labels and 20 per task, and label names are
shortened to 50 characters. Exceeding a cap does not fail the import — the
excess is reported as a row warning and everything else is imported.

### Rows that are skipped

- **Blank rows** — ignored entirely.
- **Rows whose first cell starts with `#`** — treated as comments, so you can
  annotate the sheet without breaking the import.

## How the hierarchy is read

TruePPM builds a real WBS tree, and it recognizes the two ways spreadsheets
actually encode one:

**A WBS / outline column.** Dotted codes map straight to the tree:

```
WBS   Name
1     Discovery
1.1   Stakeholder interviews
1.2   Requirements draft
2     Build
2.1   Data model
```

**Indentation in the name column.** Two spaces (or one tab, or one leading dot)
per level — the convention most hand-built sheets use:

```
Name
Phase One
  Design
  Build
    Backend
    Frontend
```

Both produce the same nested schedule.

## How dependencies are read

The predecessor column accepts the MS Project shorthand, comma- or
semicolon-separated:

| Cell | Meaning |
|---|---|
| `3` | Finish-to-Start on task 3 |
| `3FS+2d` | Finish-to-Start on task 3, with 2 days of lag |
| `5SS` | Start-to-Start with task 5 |
| `9FS-1d` | Finish-to-Start with 1 day of lead |
| `6,7` | Two Finish-to-Start predecessors |

References resolve against your **ID column** when the sheet has one, and against
**row position** otherwise — so both an MS Project-style export and a hand-typed
sheet work without changes.

:::caution[A circular predecessor column rejects the whole file]
If your predecessors form a cycle (task 1 depends on 2, and 2 depends on 1) the
import is rejected **before anything is written**. A cyclic network has no
critical path, so importing it would produce a schedule the engine cannot
compute. Fix the loop in the sheet and re-upload.
:::

## Dates, durations and percentages

**Durations** may be written as `5`, `5d`, `5 days`, `16 hours` (converted on an
8-hour day) or `2 weeks`. A duration of `0` marks the row as a milestone.

**Percent complete** accepts `50`, `50%`, or Excel's native `0.5`.

**Dates** are read as `YYYY-MM-DD` unambiguously. For slash dates the importer
scans the **whole file** before deciding: if any row is unambiguously
day-first (`13/04/2026` cannot be a month), every slash date is read day-first.
With no evidence either way it assumes month/day/year and **tells you which
convention it used** in the import warnings — a silently-guessed date order is
a data-integrity bug, not a formatting detail.

## The wizard

Open a project's **Schedule**, then **Project actions → Import from spreadsheet
(CSV/Excel)…**. The wizard walks the three steps below so you never have to call
the API yourself.

**Step 1 — Upload.** Drag a `.csv`, `.tsv`, `.txt`, `.xlsx`, or `.xlsm` file onto
the drop zone, or pick one. Files over the size cap are rejected before the
upload runs, so you do not wait on a request that is certain to fail.

**Step 2 — Map columns.** Every detected column is listed with the TruePPM field
it will import into, already filled in from auto-detection — you confirm rather
than map from scratch. Change any dropdown that is wrong, or set one to
**Don't import** to ignore that column. The first parsed rows sit underneath, so
you can see what the mapping actually produces.

If a **required** field has no column mapped to it, **Next is disabled** and the
wizard says which field is missing. This is deliberate: a spreadsheet with no
recognizable task-name column imports *zero tasks*, and a silent no-op is a worse
outcome than a blocked button.

Changing a mapping and pressing **Re-check mapping** re-runs the preview **on the
server**, so what you confirm on step 3 is what the parser genuinely produced —
not a client-side guess at what your change would do.

**Step 3 — Confirm and import.** The wizard shows the row count, how many tasks
and resources will be created, and **names every column that will not be
imported** rather than dropping them quietly. Rows that will be *lost* and rows
that will merely *land with a field defaulted* are counted separately, because
they are different decisions.

**When it finishes**, you get the number of tasks created and, if any rows had
problems, a list of them **by spreadsheet line number** so you can fix them at
source. **View schedule** takes you to the imported plan.

## The three steps

The wizard is a client of the same three endpoints, documented here for anyone
scripting an import.

### 1. Preview — nothing is saved

`POST /api/v1/projects/{id}/import/csv/preview/` parses the file and returns the
detected column mapping, the first ten parsed rows, the task and resource counts,
and any row-level problems. **It writes nothing.** Use it to confirm the mapping
before committing.

### 2. Override any column you disagree with

Send a `column_map` alongside the file — a JSON object of
`{"header": "field"}` — to pin a column explicitly. An override always beats
auto-detection. Map a column to `""` to have it ignored.

### 3. Commit

`POST /api/v1/projects/{id}/import/csv/` queues the import and returns
**`202`** with an `import_request_id`. The import runs asynchronously; poll
`GET /api/v1/projects/{id}/import/csv/{import_request_id}/` for its terminal
status and summary.

## Partial success is a result, not a failure

A real spreadsheet has a few bad cells in it. The importer treats that as
normal: a row with an unreadable date, an unreadable duration, or a predecessor
that matches nothing **still imports**, minus that one field, and the problem is
reported against its row number — the same number you see in Excel's row gutter.

```json
{
  "tasks_created": 5,
  "row_error_count": 2,
  "error_count": 0,
  "warning_count": 2,
  "row_errors": [
    { "row": 3, "column": "Start", "code": "bad_date", "severity": "warning",
      "message": "Could not read 'not-a-date' as a date; the start was left unset." },
    { "row": 5, "column": "Predecessors", "code": "unknown_predecessor", "severity": "warning",
      "message": "Predecessor '99' does not match any row; the link was skipped." }
  ]
}
```

### Severity: did the row survive?

Every diagnostic carries a `severity`, and it answers exactly one question:

| Severity | Meaning |
|---|---|
| `warning` | The row **imported**, with one field dropped or defaulted — a bad date, an unreadable duration, a predecessor that matched nothing. |
| `error` | The row **did not import** at all. Today the only cause is a row with no task name. |

They are counted separately (`error_count` / `warning_count`) rather than totalled,
because the two are not the same event: seven warnings means seven tasks landed slightly
lossy, while one error means a row of your spreadsheet is simply not there. Both are
returned by the preview endpoint too, so you can see the split **before** committing.

Only a **structurally unusable** file fails outright: no header row, no column
that could be the task name, unreadable bytes, or a cyclic predecessor column.

## Who can import

Import requires the **Scheduler** role or above (Scheduler, Admin, or Owner) on
the destination project. Members and Viewers are denied. The preview endpoint is
gated identically — it parses an uploaded file, so it is not a lighter-privilege
surface just because it saves nothing.

## Limits

| Limit | Default | Setting |
|---|---|---|
| Upload size | 10 MB | `CSV_IMPORT_MAX_UPLOAD_MB` |
| Data rows | 5 000 | `CSV_IMPORT_MAX_ROWS` |
| `.xlsx` uncompressed size | 100 MB | `CSV_IMPORT_MAX_UNCOMPRESSED_MB` |

Rows past the cap are **reported back to you** as skipped, not silently dropped.
See [CSV / Excel import limits](/administration/configuration/#csv--excel-import-limits)
for operator configuration.

## Excel specifics

- **Only the first worksheet is imported.** Extra sheets are ignored and you are
  told how many were skipped.
- **Values, not formulas.** The workbook is read with cached values, so a cell
  containing `=SUM(...)` imports as the number Excel last computed.
- `.xlsx` and `.xlsm` are accepted. The legacy `.xls` format is not — re-save it
  as `.xlsx` or export it as CSV.

## Download the template

`GET /api/v1/import-templates/csv/` returns a known-good CSV with the canonical
headers and a worked example demonstrating nesting, a lagged dependency, a
Start-to-Start link, a zero-duration milestone, and a multi-value Labels cell.

## What does *not* map

Deliberate exclusions — a spreadsheet does not carry them, and inventing them
would be worse than leaving them out:

- **Calendars and working-time exceptions.** Imported tasks use the project's
  calendar.
- **Baselines, sprints, and board columns.** Set these up in TruePPM after import.
- **Three-point (PERT) estimates.** A single duration column maps to duration only.
- **Cross-project dependencies.** Import is scoped to one project.
- **Resource rates, capacity, and calendars.** Assignees are matched or created
  by name; everything else about them stays unset.
