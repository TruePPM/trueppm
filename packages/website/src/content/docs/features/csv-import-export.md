---
title: CSV / Excel import & export
description: What TruePPM's CSV and Excel surfaces can and cannot do — the round-trip table, the file format, the import wizard, the column-alias reference, the limits, and why a CSV is not a backup.
documentedFor: "0.4"
---

TruePPM reads and writes CSV and Excel files so data can move between a
spreadsheet and a schedule. This page tells you exactly what each surface does,
what it does **not** do, and which file to use when CSV is the wrong tool —
then covers the import wizard and the reference tables for anyone scripting
against the endpoints directly.

:::note[Ships in 0.4 — task CSV / Excel import]
Task **export** to CSV is available today from the Table view. Task **import**
from CSV or Excel ships in **TruePPM 0.4**, the first beta — on unreleased
builds the column aliases and endpoints may still be changing. Risk CSV
import and export are both shipped today and are true counterparts of each
other.
:::

:::caution[A CSV is not a backup]
A CSV file holds one flat list — tasks, or risks — with no hierarchy beyond a
WBS column, no version, and no way to represent a whole project. It is for
moving a table between tools.

To back up, archive, or move a project between instances, export a
**[JSON seed or an export bundle](/administration/data-export/)** instead. That is
the format built for it.
:::

Most teams that have never used dedicated project software still run a real
schedule — in Excel, or in a Google Sheet shared over email. For them the
barrier to adopting TruePPM is not features, it is **getting the existing plan
in without retyping it**. CSV / Excel import removes that barrier: upload the
sheet, confirm what each column means, and TruePPM builds a CPM-schedulable
network from it — tasks, durations, dates, a WBS hierarchy, dependencies, and
assignees. This is also the import path for the many tools that export CSV —
Asana, Trello, Basecamp and others all produce a CSV you can feed directly to
this endpoint.

:::note[An offline import, not a live connector]
Like [MS Project](/features/msproject-import-export/) and
[Jira](/features/jira-import/) import, this is a **one-way, file-based,
point-in-time** migration. TruePPM never talks to your spreadsheet's source,
never authenticates against it, and never writes anything back.
:::

## What round-trips, and what doesn't

"Round-trips" means: export it, import it back, and get the same thing.

| Surface | Export | Import | Round-trips? |
|---|---|---|---|
| **Risks** | Yes | Yes | **Yes** — the two are counterparts |
| **Tasks** | Yes | Ships in 0.4 | **No** — see below |
| **Labels** | No | Yes | **No** — import-only; there is no label export to round-trip from |
| Sprints, resources, calendars, dependencies | No | No | — |

### Why tasks don't round-trip

The task CSV export is a **snapshot of what's on your screen**. Three of its
eight columns are values TruePPM *calculated* rather than values you entered:

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

A larger file than the [risk import limit](#limits) is rejected outright
rather than partially imported, so a truncated import can never look like a
successful one.

## Tasks

Task CSV **export** is available today from the Table view's **CSV** toolbar
action. It exports the rows currently shown — your filters and sort apply.

Task CSV and Excel **import** ships in 0.4. Upload the sheet, confirm what
each column means in the wizard below, and TruePPM builds a
CPM-schedulable network from it — tasks, durations, dates, a WBS hierarchy,
dependencies, and assignees.

## What a good spreadsheet looks like

The importer expects a **header row** followed by task rows. Nothing else is
required — every column below is optional except the task name. Download the
[known-good template](#download-the-template) if you want a target shape to
paste into.

The commonest spellings, per field. This table is **hand-copied from the
importer's alias map and is not exhaustive** — a previous version of this page
claimed it could not drift from itself, and by the time anyone checked it was
missing fourteen aliases (#2892). For the authoritative list, read
`available_fields` in the preview response
([`POST …/import/csv/preview/`](#1-preview--nothing-is-saved)), which the wizard's
own column dropdown is built from. And you never need the list at all: any header
the importer does not recognize is one you can map by hand on step 2.

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

**Either decimal convention works.** `3.5` and `3,5` both mean three and a half
days, and `0,5` means 50 % complete exactly as `0.5` does. Where a separator is
genuinely ambiguous the importer resolves it by convention: a comma with exactly
three digits after it is thousands grouping (`1,500` is fifteen hundred), a
period is always a decimal point (`1.500` is 1.5), and when both appear the last
one is the decimal mark (`1.234,56` and `1,234.56` are both 1234.56).

**Dates** are read as `YYYY-MM-DD` unambiguously. For slash dates the importer
scans the **whole file** before deciding: if any row is unambiguously
day-first (`13/04/2026` cannot be a month), every slash date is read day-first.

The wizard's map step has a **Date order** control, and it states the evidence
for whatever it chose — naming the row, the column and the value that settled
it, so you can check the claim against your own file:

> **Auto read this file as D/M/Y (day first).** Row 14 is “13/04/2026” — there
> is no 13th month, so the file can only be day-first. All 486 values in Start
> and Finish fit that reading.

Four settings are offered:

| Setting | What it does |
| --- | --- |
| **Auto** (default) | Scan the file and settle the order from the first self-identifying value |
| **M/D/Y** | Read every slash date month-first |
| **D/M/Y** | Read every slash date day-first |
| **ISO** | Accept only `YYYY-MM-DD`; a slash date is reported as unreadable rather than guessed at |

### When the file identifies nothing

`Design,03/04/2026,05/04/2026` is a valid date pair under **both** conventions,
and the difference is a three-day task or a sixty-two-day one. Auto cannot
resolve that, and says so rather than quietly picking: the block shows both
readings with the duration each produces, and the button reads **Confirm M/D/Y
and continue** so the convention being accepted is named before you press it.

Nothing is blocked — a genuinely ambiguous file still imports — but the choice
is explicit, and the convention the import ran under is recorded on the import
request.

### Scripting against the endpoint

Both `POST …/import/csv/preview/` and `POST …/import/csv/` accept a
`date_order` field: `auto` (the default), `mdy`, `dmy`, or `iso`. An unknown
value is rejected with a `400` rather than silently falling back to `auto` — a
misspelled parameter that quietly reverted would import March dates while the
caller believed they had asserted day-first.

The preview response reports what it resolved and why: `date_order_resolved`,
`date_order_ambiguous`, `date_order_evidence` (`{row, column, value, reason}`),
`values_matched` / `values_failed`, and — for an ambiguous file —
`date_order_readings`, both conventions with the dates and duration each
produces for one sample row.

## The wizard

### Getting to it

There are two ways in, and which one you want depends on whether the project
already exists.

**Starting from a spreadsheet.** Choose **Create & import spreadsheet** in the
new-project flow. TruePPM creates the project and opens the wizard on arrival, so
you go from "I have a plan in Excel" to mapping columns without stopping at an
empty project in between. The same option is offered as **Import a spreadsheet**
on the sidebar and the My Work screen when you have no projects yet — the two
places you land as a brand-new user.

**Importing into a project you already have.** Open its **Schedule**, then
**Project actions → Import from spreadsheet (CSV/Excel)…**.

Both routes open the same wizard. The import always needs a project to import
*into*, which is why the first route creates one for you rather than deferring it
— but that is a detail of the plumbing, not a step you perform.

Importing requires the **Scheduler** role or above on the project. Creating a
project does not require any project role (you become its Owner), so the
create-and-import route is open to anyone who can create a project.

### The three steps

The wizard walks the three steps below so you never have to call the API
yourself.

**Step 1 — Upload.** Drag a `.csv`, `.tsv`, `.txt`, `.xlsx`, or `.xlsm` file onto
the drop zone, or pick one. Files over the size cap are rejected before the
upload runs, so you do not wait on a request that is certain to fail.
**Download a template** here if you want a known-good shape to paste into —
it is the same file the [template endpoint](#download-the-template) serves.

**Step 2 — Map columns.** Every detected column is listed with the TruePPM field
it will import into, already filled in from auto-detection — you confirm rather
than map from scratch. Change any dropdown that is wrong, or set one to
**Don't import** to ignore that column. The first parsed rows sit underneath, so
you can see what the mapping actually produces.

Columns the importer had to guess at are flagged **Guessed — check this**, and a
count above the table tells you how many are waiting on you. A column that lost a
tie for a field — two headers both matching `Name`, say — reads **Not imported —
another column already uses this field**, so it is never just mysteriously blank.
Columns matched exactly carry no note at all: silence is the confident state, and
badging all of them would bury the ones that need an eye.

Anything the parser decided about the **file as a whole** appears under **How we
read this file** — which worksheet was read, how ambiguous dates were resolved,
whether the row cap bit. These are not row problems; they are choices made on
your behalf, and they are repeated on step 3 because that is the last screen
before the import commits.

If a **required** field has no column mapped to it, **Next is disabled** and the
wizard says which field is missing. This is deliberate: a spreadsheet with no
recognizable task-name column imports *zero tasks*, and a silent no-op is a worse
outcome than a blocked button.

Changing a mapping and pressing **Re-check mapping** re-runs the preview **on the
server**, so what you confirm on step 3 is what the parser genuinely produced —
not a client-side guess at what your change would do. Only the columns *you*
changed are pinned; everything else is detected fresh, so a guess you never
looked at still comes back flagged as a guess rather than quietly counting as
reviewed.

**Step 3 — Confirm and import.** The wizard shows the row count, how many tasks
and resources will be created, and **names every column that will not be
imported** rather than dropping them quietly. Rows that will be *lost* and rows
that will merely *land with a field defaulted* are counted separately, because
they are different decisions.

If your file is over the row cap, the count reads **5,000 of 6,000** — never a
bare `5,000` that would look like the whole file arrived. What was dropped is
spelled out under **How we read this file**.

**When it finishes**, you get the number of tasks created and, if any rows had
problems, a list of them **by spreadsheet line number** so you can fix them at
source. **View schedule** takes you to the imported plan.

On a clean import — every row landed and the parser had nothing to report — that
button is already focused, so <kbd>Enter</kbd> takes you straight to the
schedule. When there *is* something to read, it is **Close** that is focused
instead, so you are not walked past the line numbers on your way out.

## The three endpoints

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

A real spreadsheet has a few bad cells in it, and for spreadsheet data that's
the normal outcome — not an exceptional one. A row with an unreadable date, an
unreadable duration, or a predecessor that matches nothing **still imports**,
minus that one field, and the problem is reported against its row number — the
same number you see in Excel's row gutter.

```json
{
  "tasks_created": 5,
  "plan_tasks_created": 5,
  "parked_row_count": 0,
  "review_branch_name": "",
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

### Nothing is silently dropped: the Import review branch

Some rows cannot become a task at all — today, a row with no name in the column
you mapped to **Name**. Those rows are **not discarded**. They are imported into
an **Import review** summary branch appended at the bottom of the outline, one
task per row, each named for the spreadsheet row it came from and carrying that
row's original cell values in its notes.

```
1  Discovery
   1.1  Stakeholder interviews
   1.2  Requirements draft
2  Build
3  Import review              ← added by the import
   3.1  Row 7 — no task name
   3.2  Row 9 — no task name
```

Fixing one is an ordinary edit: rename it and it becomes a normal task, or
delete it. Both are undoable and both broadcast to anyone else on the project,
because they are the same operations you would use on any other task — the
import creates no special repair mode. Once the branch is empty, delete it too.

The wizard says this **before** you commit, on the confirm step, so the branch is
never something you discover afterwards.

:::caution[Parked rows are project data, and they stay]
A parked row's original cell values are stored on a real task and are readable by
everyone on the project, down to the **Viewer** role — the same as any other
imported task. Before this, an unresolvable row's values were discarded. So if a
sheet carries columns you did not intend to import (rates, personal contact
details), delete the review branch once you have worked through it rather than
leaving it in the plan.
:::

Three summary fields describe it:

| Field | Meaning |
|---|---|
| `tasks_created` | Every task row written, the review branch included. |
| `plan_tasks_created` | Your plan alone — what "imported N tasks" is allowed to claim. |
| `parked_row_count` | Rows that landed in the review branch instead. |

The preview endpoint reports the same split before you commit, as `task_count`
(the plan) and `parked_row_count`.

### Undo an import

:::note[Ships in 0.4]
Import undo ships in **0.4**, alongside CSV/Excel import itself.
:::

The wizard's result step carries an **Undo import (⌘Z)** action once a completed import
has created or parked any rows. Applying it removes every row the import wrote — plan
rows and Import review placeholders alike — except any you (or a teammate) have already
edited since; those are left in place, and the confirmation names how many. Undo is a
single step per import and is only offered for a completed import, never a failed or
still-running one.

### Severity: did the row become a task?

Every diagnostic carries a `severity`, and it answers exactly one question:

| Severity | Meaning |
|---|---|
| `warning` | The row **imported**, with one field dropped or defaulted — a bad date, an unreadable duration, a predecessor that matched nothing. |
| `error` | The row **did not join the plan**. It is parked in the Import review branch instead, with its values intact. Today the only cause is a row with no task name. |

They are counted separately (`error_count` / `warning_count`) rather than totalled,
because the two are not the same event: seven warnings means seven tasks landed slightly
lossy, while one error means a row of your spreadsheet is waiting for you rather than
being part of the schedule. Both are returned by the preview endpoint too, so you can
see the split **before** committing.

The terminal screen groups the diagnostics **by cause** rather than listing one
line per row — four hundred rows with the same wrong date format is one edit,
not four hundred — and offers them as a CSV download so you can work through
them next to your spreadsheet.

Only a **structurally unusable** file fails outright: no header row, no column
that could be the task name, unreadable bytes, or a cyclic predecessor column —
and in that case nothing is written.

### Imported dates are a starting point, not gospel

Dates you import are constraints the scheduling engine **re-derives** on the
project's calendar, so a date can move — a task starting on a non-working day
will not stay there. The confirm step says so before you commit, whenever a
column is mapped to a date field.

## Who can import and export

- **Importing tasks** requires the **Scheduler** role or above (Scheduler,
  Admin, or Owner) on the destination project. Members and Viewers are denied.
  The preview endpoint is gated identically — it parses an uploaded file, so it
  is not a lighter-privilege surface just because it saves nothing.
- **Importing risks** requires the **Member** role or above (Member,
  Scheduler, Admin, or Owner).
- **Exporting** requires the same permission as the equivalent
  [JSON export](/administration/data-export/) of the same data. A CSV export
  isn't a lower-privilege action just because the file is smaller.

## Limits

| Limit | Default | Setting |
|---|---|---|
| Task import upload size | 10 MB | `CSV_IMPORT_MAX_UPLOAD_MB` |
| Task import data rows | 5 000 | `CSV_IMPORT_MAX_ROWS` |
| Task import `.xlsx` uncompressed size | 100 MB | `CSV_IMPORT_MAX_UNCOMPRESSED_MB` |
| Risk import upload size | 2 MB | — |
| Risk import data rows | 500 | — |

Rows past the task-import cap are **reported back to you** as skipped, not
silently dropped. A risk import over its cap is **rejected outright** rather
than partially imported. See
[CSV / Excel import limits](/administration/configuration/#csv--excel-import-limits)
for operator configuration.

## Excel specifics

- **Only the first worksheet is imported.** Extra sheets are ignored and you are
  told how many were skipped.
- **Values, not formulas.** The workbook is read with cached values, so a cell
  containing `=SUM(...)` imports as the number Excel last computed.
- `.xlsx` and `.xlsm` are accepted. The legacy `.xls` format is not — re-save it
  as `.xlsx` or export it as CSV.

Two more things will bite you when working with Excel, and neither is specific
to TruePPM:

### Your file opens as a single column

If your regional settings use a semicolon as the list separator (common across
much of Europe), Excel will open a comma-delimited file as one column. Fix it
without changing the file:

1. Open Excel, then **Data → From Text/CSV** (rather than double-clicking the file).
2. Choose **Comma** as the delimiter.

TruePPM always writes comma-delimited files on purpose. Adapting the separator to
each machine would mean the same file meant different things on different
computers — which is exactly what disqualifies CSV as an authoritative format.

### Your file imports as gibberish, or is refused

Excel's **"Unicode Text (\*.txt)"** export writes UTF-16, not UTF-8. TruePPM reads
it correctly when it carries a byte-order mark, which Excel adds. A UTF-16 file
saved *without* that mark is indistinguishable from Windows-1252 bytes, so the
importer **refuses it** with "the decoded content contains NUL bytes" rather than
importing every cell with a NUL between each letter. Re-save as **CSV UTF-8** and
upload again.

The same refusal covers a `.xlsx` renamed to `.csv`, and any other binary file
that reaches the CSV reader.

### Excel changed your data

Opening a CSV in Excel and saving it can silently alter the contents: leading
zeros disappear, long numeric strings become scientific notation, and anything
that looks like a date is rewritten in your machine's local format.

TruePPM's importers tolerate the common damage — including dates written back as
`Jun 9, 2026`. They can't tolerate all of it. If an import produces unexpected
values, re-export from the source tool and import the file **without** opening it
in Excel first.

## Download the template

**Download a template** on step 1 of the wizard saves a known-good CSV with the
canonical headers and a worked example demonstrating nesting, a lagged
dependency, a Start-to-Start link, a zero-duration milestone, and a multi-value
Labels cell.

The same file is served by `GET /api/v1/import-templates/csv/` for scripted use.
The endpoint requires authentication, so it needs your bearer token — pasting the
URL into a browser address bar will not work.

## The file format

Every CSV TruePPM writes or reads follows the same rules
([RFC 4180](https://www.rfc-editor.org/rfc/rfc4180)):

| | |
|---|---|
| **Separator** | Comma |
| **Encoding** | UTF-8 written. On import, a byte-order mark decides the encoding — UTF-8, UTF-16 and UTF-32 marks are all honored, so Excel's "Unicode Text" export reads correctly. Without a mark the importer tries UTF-8 then the Windows-1252 / Latin-1 fallbacks, and **refuses** the file if the result is not readable text rather than importing mojibake |
| **Decimal mark** | Period or comma; see [Dates, durations and percentages](#dates-durations-and-percentages) |
| **Line endings** | CRLF written; either accepted |
| **Quoting** | Fields containing a comma, quote, or newline are wrapped in `"`; embedded quotes are doubled |
| **First row** | Column headers. Their **order doesn't matter** on import — only their names |
| **Dates** | `YYYY-MM-DD` |
| **Blank rows** | Skipped |
| **Rows starting with `#`** | Skipped — use them for comments |
| **Unrecognized columns** | Ignored, with a warning. They never fail the import |

The full normative definition is the
[data interchange specification](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/specs/data-interchange.spec.md).

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
7. **Calendars and working-time exceptions don't import.** Imported tasks use
   the project's calendar.
8. **Baselines, sprints, and board columns don't import.** Set these up in
   TruePPM after import.
9. **Three-point (PERT) estimates don't import.** A single duration column
   maps to duration only.
10. **Cross-project dependencies don't import.** Import is scoped to one project.
11. **Resource rates, capacity, and calendars don't import.** Assignees are
    matched or created by name; everything else about them stays unset.

For anything on that list, use
[JSON export or an export bundle](/administration/data-export/).

## Related

- [Data export](/administration/data-export/) — JSON seeds and full project bundles
- [Risk register](/features/risk-register/) — the risk CSV workflow
- [MS Project import & export](/features/msproject-import-export/) — for schedules coming from Project
- [Jira import](/features/jira-import/) — for issue sets coming from Jira Server / Data Center
- [Bring your existing plan in](/getting-started/bring-your-plan-in/) — decision table for which importer to use
- [Seed data schema](/architecture/seed-data-schema/) — the canonical JSON format
