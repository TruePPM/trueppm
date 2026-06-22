---
title: Data export
description: Export a whole program to a canonical JSON seed file — endpoint, CLI, round-trip guarantee, and limitations.
---

Any program — or a single project — can be exported to a canonical JSON seed
file, the same format the [sample projects](/getting-started/sample-projects/)
ship in. Use it to back up your work, move it between instances, or hand it to a
developer to edit and re-import.

## Export a program

### Web

Open **Program → Settings → General** and choose **Export to JSON**. The program
downloads as a seed file.

### Command line

```bash
python manage.py export_program <program-slug> --out program.json
```

`<program-slug>` is the program's natural key (its `code`). Omit `--out` to
write to stdout.

### API

```
GET /api/v1/programs/{id}/export/
```

Available to any program member (Viewer and above). The response is a JSON
attachment.

## Export a project

A single project can be exported the same way, from its own settings.

### Web

Open **Project → Settings → Lifecycle** and choose **Export project…**. The
project downloads as a seed file.

### API

```
GET /api/v1/projects/{id}/export/
```

Available to any project member (Viewer and above), including on **archived**
projects (so data stays portable for archival). The response is a JSON
attachment.

Because the seed format always describes a program and its projects, a
project export wraps the project in a small synthesized single-project program
derived from the project itself. This keeps the file self-contained and
re-importable — a standalone project (one not grouped into a program) exports
just the same — and means re-importing a project export creates a fresh program
rather than overwriting the project's original parent program. Cross-project
dependencies that point at a *sibling* project are omitted, since the sibling is
not part of a single-project export.

:::note
This is the portable **JSON** export. For a boardroom-ready document, use the
board PDF export instead. A richer project bundle (MS Project `.mpp`,
attachments, time entries, and the audit log) is tracked as a follow-up.
:::

## Round-trip guarantee

Export is deterministic: exporting a program, re-importing the result into a
clean database, and exporting again produces a **byte-identical** file. This is
what makes the format safe to edit by hand — export, change the JSON, re-import.
Re-import is idempotent (a program with the same slug is replaced, not
duplicated), so you can iterate without piling up copies.

## What is and isn't exported

A seed file is the program's **declarative state**, not its database internals.

**Stripped** (recomputed on import, never written to the file):

- internal UUIDs and short IDs,
- schedule (CPM) results — early/late dates, float, the critical path,
- `server_version` and other sync bookkeeping.

**Included:**

- the program, its projects, tasks (WBS paths, three-point estimates,
  durations, statuses), dependencies, sprints, baselines, risks, resources, and
  memberships,
- the email addresses of the program's members and resources.

:::caution
Because member and resource email addresses are part of the program's data,
they are present in an exported file (the same details members already see in
the app). Treat exported files as you would any file containing contact
information. **No passwords, tokens, or internal IDs are ever exported.**
:::

## User accounts on import

The import counterpart (`import_seed` / `POST /api/v1/programs/import/`) decides
whether to create the user accounts a seed references:

- the **REST import endpoint always runs with user creation off** — importing a
  seed never mints logins on a live instance;
- the `import_seed` management command takes `--create-users` for local demos
  and `make seed`, which creates referenced accounts that don't already exist.

## Event history is not exported (yet)

Export writes the program's **final state**. A v2 sample (with its replayed,
backdated event timeline) therefore exports as a final-state document — and
re-importing it materializes that final state **without** re-running the event
history. Exporting the full event timeline is tracked as a follow-up
([#1109](https://gitlab.com/trueppm/trueppm/-/issues/1109)).

See [Sample projects & JSON import/export](/getting-started/sample-projects/)
for the import side and the bundled demos, and the
[seed data schema reference](/architecture/seed-data-schema/) for the format
itself.
