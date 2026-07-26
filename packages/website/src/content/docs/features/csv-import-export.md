---
title: CSV import & export
description: What TruePPM's CSV files can and cannot do — the file format, the column sets, the limits, and why a CSV is not a backup.
---

TruePPM reads and writes CSV so your data can move between a spreadsheet and a
schedule. This page tells you exactly what each CSV surface does, what it does
**not** do, and which file to use when CSV is the wrong tool.

:::caution[A CSV is not a backup]
A CSV file holds one flat list — tasks, or risks — with no hierarchy beyond a WBS
column, no version, and no way to represent a whole project. It is for moving a
table between tools.

To back up, archive, or move a project between instances, export a
**[JSON seed or an export bundle](/administration/data-export/)** instead. That is
the format built for it.
:::

## What round-trips, and what doesn't

"Round-trips" means: export it, import it back, and get the same thing.

| Surface | Export | Import | Round-trips? |
|---|---|---|---|
| **Risks** | Yes | Yes | **Yes** — the two are counterparts |
| **Tasks** | Yes | Ships in 0.4 | **No** — see below |
| Sprints, resources, calendars, dependencies, labels | No | No | — |

### Why tasks don't round-trip

The task CSV export is a **snapshot of what's on your screen**. Three of its eight
columns are values TruePPM *calculated* rather than values you entered:

| Column | Where it comes from |
|---|---|
| `WBS` | your outline |
| `Name` | you |
| `Start` | **calculated** — the earliest the scheduler can start this task |
| `Finish` | **calculated** — the earliest it can finish |
| `Duration (days)` | you |
| `Progress (%)` | you |
| `Status` | you |
| `Critical` | **calculated** — whether it's on the critical path |

The task import that ships in 0.4 reads `Start` and `Finish` as dates *you are
committing to*. So if you export tasks to CSV and import that file back, you get
new tasks whose committed dates are yesterday's calculated output — not a copy of
your project.

Use the export to hand someone a status table. Use a
[JSON seed](/administration/data-export/) to move the project.

Making the two into genuine counterparts is planned — see
[issue #2401](https://gitlab.com/trueppm/trueppm/-/issues/2401).

## Risks

The Risk Register's **Export CSV** and **Import CSV** actions are symmetric: a file
exported from one project imports cleanly into another. See
[Risk register](/features/risk-register/) for the workflow.

Columns: `ID`, `Title`, `Status`, `Category`, `Response`, `P`, `I`, `Severity`,
`Owner`, `Mitigation Due Date`, `Trigger`, `Contingency`, `Description`.

Only `Title` is required. On import:

- `ID` and `Severity` are ignored — IDs are assigned per project, and severity is
  always calculated from probability × impact.
- `Owner` is matched against **the project's own members** by email, username, or
  ID. Someone who isn't a member of the project can't be assigned by a file; that
  row imports with the risk unassigned and a warning.
- An unrecognized status, category, or response imports the row anyway and warns.
- A probability or impact outside 1–5 skips that row — a stray value there usually
  means the columns were mapped wrong, and guessing would be worse.

**Limits:** 2 MB, 500 rows. A larger file is rejected outright rather than
partially imported, so a truncated import can never look like a successful one.

## Tasks

Task CSV **export** is available today from the Table view's **CSV** toolbar
action. It exports the rows currently shown — your filters and sort apply.

Task CSV and Excel **import** ships in 0.4. It will accept `.csv` and `.xlsx`,
auto-detect your column headers, show you the mapping and the first ten rows to
confirm before anything is written, and report problems by line number.

**Planned limits:** 10 MB, 5 000 rows.

Headers it will recognize, case-insensitively:

| Your column becomes | Headers accepted |
|---|---|
| Task name | Name, Task, Title, Task Name, Summary |
| Duration | Duration, Days, Effort |
| Start date | Start, Begin, Start Date |
| Finish date | Finish, End, Due, Due Date |
| Percent complete | % Complete, Percent Complete, Done, Progress |
| Assignee | Assignee, Owner, Resource, Assigned To |
| Predecessor | Predecessor, Predecessors, Depends On, Blocked By |
| Hierarchy | WBS, Phase, Level, Outline Level — or indentation in the name column |

Excel files are read as one sheet of values: the **first sheet only**, **no
formulas evaluated**. If your workbook has other sheets, the import warns and
ignores them. TruePPM never writes `.xlsx`.

## The file format

Every CSV TruePPM writes or reads follows the same rules
([RFC 4180](https://www.rfc-editor.org/rfc/rfc4180)):

| | |
|---|---|
| **Separator** | Comma |
| **Encoding** | UTF-8. A byte-order mark is accepted on import (Excel adds one) |
| **Line endings** | CRLF written; either accepted |
| **Quoting** | Fields containing a comma, quote, or newline are wrapped in `"`; embedded quotes are doubled |
| **First row** | Column headers. Their **order doesn't matter** on import — only their names |
| **Dates** | `YYYY-MM-DD` |
| **Blank rows** | Skipped |
| **Rows starting with `#`** | Skipped — use them for comments |
| **Unrecognized columns** | Ignored, with a warning. They never fail the import |

The full normative definition is the
[data interchange specification](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/specs/data-interchange.spec.md).

## Working with Excel

Two things will bite you, and neither is specific to TruePPM.

### Your file opens as a single column

If your regional settings use a semicolon as the list separator (common across
much of Europe), Excel will open a comma-delimited file as one column. Fix it
without changing the file:

1. Open Excel, then **Data → From Text/CSV** (rather than double-clicking the file).
2. Choose **Comma** as the delimiter.

TruePPM always writes comma-delimited files on purpose. Adapting the separator to
each machine would mean the same file meant different things on different
computers — which is exactly what disqualifies CSV as an authoritative format.

### Excel changed your data

Opening a CSV in Excel and saving it can silently alter the contents: leading
zeros disappear, long numeric strings become scientific notation, and anything
that looks like a date is rewritten in your machine's local format.

TruePPM's importers tolerate the common damage — including dates written back as
`Jun 9, 2026`. They can't tolerate all of it. If an import produces unexpected
values, re-export from the source tool and import the file **without** opening it
in Excel first.

## Errors, warnings, and partial imports

An import reports two kinds of problem, both by line number (the header is line 1):

- **Errors** skip that one row. The rest of the file still imports.
- **Warnings** import the row with a substituted value — an unrecognized status
  becomes the default, an unreadable date is left blank, an unmatched owner is left
  unassigned.

**A partial import is a result, not a failure.** For spreadsheet data it's the
normal outcome. You get the rows that landed plus a list of what didn't and why, so
you can fix those lines and re-import just them.

Whole-file problems — an unreadable file, a missing required column, too many rows
— reject the upload and write **nothing**. You never end up with half an import.

## Who can import and export

- **Importing tasks** requires Project Manager or above.
- **Importing risks** requires Member or above.
- **Exporting** requires the same permission as the equivalent
  [JSON export](/administration/data-export/) of the same data. A CSV export isn't a
  lower-privilege action just because the file is smaller.

## What CSV can't do

Collected in one place, because these are properties of the format rather than
things still to be built:

1. **One flat list per file.** No nesting, no cross-references between entity
   types, no version marker.
2. **No identity, so no updates.** Import always *creates*. There is no CSV path to
   modify a task or risk that already exists.
3. **No dependencies on export**, and only simple predecessors on import — no lag,
   and not the four dependency types the scheduler supports.
4. **No comments, attachments, time entries, or history.**
5. **Excel reformats data**, so a file that has been opened and re-saved is no
   longer guaranteed to match what TruePPM wrote.
6. **Not a backup.** No version, no manifest, no integrity check, and no way to
   represent most of a project.

For anything on that list, use
[JSON export or an export bundle](/administration/data-export/).

## Related

- [Data export](/administration/data-export/) — JSON seeds and full project bundles
- [Risk register](/features/risk-register/) — the risk CSV workflow
- [MS Project import & export](/features/msproject-import-export/) — for schedules coming from Project
- [Seed data schema](/architecture/seed-data-schema/) — the canonical JSON format
