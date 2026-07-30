---
title: Bring your existing plan in
description: A decision table routing an existing MS Project file, spreadsheet, or Jira export to the right importer, with shipped-vs-planned status and the Jira Cloud caveat up front.
---

If your plan already lives somewhere else, you don't have to retype it.
TruePPM reads several source formats as **one-way, file-based, point-in-time**
imports — you upload a file, TruePPM builds a CPM-schedulable project from it,
and nothing you import ever writes back to the source. Pick your source below.

## Which importer do I want?

| Your plan lives in... | Use | Status | Watch for |
|---|---|---|---|
| Microsoft Project (`.mpp` or `.xml`) | [MS Project import & export](/features/msproject-import-export/) | **Shipped** — REST endpoints since 0.1, in-app wizard since 0.2 | `.mpp` needs the optional MPXJ dependency installed; export as `.xml` from Project if it isn't |
| A spreadsheet you built by hand, or exported from Asana, Trello, Basecamp, or a similar tool | [CSV / Excel import & export](/features/csv-import-export/) | **Ships in 0.4** — the column-mapping wizard is not live yet | Column headers are auto-detected, but always check the mapping before you commit |
| Jira **Server or Data Center** (XML issue export) | [Jira import](/features/jira-import/) | **Ships in 0.4** | **Jira Cloud has no XML export** — Cloud has no file this importer can read. Cloud migration is a separate, out-of-scope track |
| Another TruePPM instance, or a hand-edited file matching the seed schema | [Data export](/administration/data-export/#check-a-file-before-you-import-it) (JSON seed import) | **Shipped** today, with a dry-run validator | Replace-then-rebuild on the program slug — a colliding program is replaced, not merged, and only its projects are recoverable. Read the re-import semantics before you run it |

Not sure which row fits? If the source tool can export a CSV at all, the CSV
importer is the safest default — it's the one built for "a table from
somewhere else," not for one specific tool's file format.

## What none of them import

Regardless of source, a one-way file import is deliberately **not** a live
sync and **not** a full-fidelity replica:

- **No write-back.** TruePPM never authenticates against your source tool and
  never pushes a change to it. Re-importing the same file again creates new
  tasks; it does not update the ones you imported before.
- **No baselines, sprints, board columns, or working-time exceptions.** Set
  these up in TruePPM after the import lands.
- **No resource rates, capacity, or calendars.** Assignees are matched or
  created by name; everything else about them stays unset.
- **No cross-project dependencies.** Every import is scoped to a single
  project.

See each importer's own page for the exact list of what it does and doesn't
carry over — the constraints above are the ones every source shares.

## Related

- [MS Project import & export](/features/msproject-import-export/)
- [CSV / Excel import & export](/features/csv-import-export/)
- [Jira import](/features/jira-import/)
- [Data export](/administration/data-export/) — JSON seeds, export bundles, and the round-trip guarantee
- [Quickstart](/getting-started/quickstart/) — if you'd rather start from the demo data or the API instead
