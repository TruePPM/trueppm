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

Open **Program → Settings → General**, find the **Export program** control, and
choose **Export to JSON**. The program downloads as a seed file.

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

Requires **Admin** (a Program Admin or the Owner). The seed includes team-private
data raw — story points and committed/completed/capacity velocity — so it sits at
the same tier as the async export bundle rather than being open to every member.
The response is a JSON attachment.

## Export a project

A single project can be exported the same way, from its own settings.

### Web

Open **Project → Settings → Lifecycle** and choose **Export project…**. The
project downloads as a seed file.

### API

```
GET /api/v1/projects/{id}/export/
```

Requires **Admin** (a project Admin or the Owner), including on **archived**
projects (so data stays portable for archival). Like the program seed, the file
contains team-private points and velocity raw, so it is an Admin-tier action
rather than open to every member. The response is a JSON attachment.

Because the seed format always describes a program and its projects, a
project export wraps the project in a small synthesized single-project program
derived from the project itself. This keeps the file self-contained and
re-importable — a standalone project (one not grouped into a program) exports
just the same — and means re-importing a project export creates a fresh program
rather than overwriting the project's original parent program. Cross-project
dependencies that point at a *sibling* project are omitted, since the sibling is
not part of a single-project export.

:::note
This is the lightweight, synchronous portable **JSON** export. For the complete
archive — MS Project file, attachments, time entries, and change history — use
the **project export bundle** below. For a boardroom-ready document, use the
board PDF export instead.
:::

## Export a project bundle (async)

The JSON seed above is the schedule's declarative state. The **export bundle** is
the whole project: the JSON seed **plus** an MS Project file, every task
attachment, all logged time entries, and the project change history — assembled
into a single downloadable `.tar.gz`. Because a bundle can be large, it is built
in the background and offered as a download when it is ready.

### Web

Open **Project → Settings → Lifecycle** and choose **Export bundle…**. The card
shows the job move through *queued → building → ready*, then offers **Download
bundle**. A finished bundle's download link stays valid for a few days (see
[retention](/administration/retention/)); use **Rebuild** to make a fresh one.

Exporting a bundle is an **Admin+** action — it aggregates the full change
history, every member's time entries, and all attachment binaries, so it sits a
tier above the Viewer-and-above JSON export.

### API

```
POST /api/v1/projects/{id}/export/          # queue a bundle → 202 + job
GET  /api/v1/projects/{id}/export/jobs/{job_id}/           # poll status
GET  /api/v1/projects/{id}/export/jobs/{job_id}/download/  # download when ready
```

`POST` returns `202 Accepted` with a job whose `status` is `pending`. Poll the
job endpoint until `status` is `success` (or `failed`), then fetch `download_url`.
The download endpoint is authenticated (the archive is never served from a raw
storage URL); it returns `409` while the job is still building and `410 Gone`
once the link has expired. A bundle already `pending`/`running` for the project
is reused rather than queuing a duplicate build.

### What the bundle contains

| Member | Contents |
| --- | --- |
| `seed.json` | The canonical JSON seed (same as the synchronous export). |
| `msproject.xml` | The schedule as **MS Project XML** (MSPDI). |
| `attachments/…` | Every task attachment binary, plus an `index.json` manifest. |
| `time_entries.json` | All logged time entries for the project's tasks. |
| `history/*.json` | The project's change history (tasks, dependencies, risks, sprints, project). |
| `manifest.json` / `counts.json` | Archive metadata and per-member row counts. |

:::note
The MS Project artifact is **MS Project XML** (`.xml`, the MSPDI interchange
format), which Microsoft Project opens natively — not the proprietary binary
`.mpp`. TruePPM's MS Project integration can *read* binary `.mpp` files but does
not write them, so the bundle ships the round-trippable XML format instead. The
same credential-safety rule as the JSON export applies: **no passwords, tokens,
or internal secrets are ever included.**
:::

## Export a program bundle (async)

The program has the same complete archive as a project, at program grain. The
**program export bundle** is a single downloadable `.tar.gz` containing the
program's canonical JSON seed **plus**, for each member project, an MS Project
file, every task attachment, all logged time entries, and that project's change
history. Like the project bundle it is built in the background and offered as a
download when ready.

### Web

Open **Program → Settings → General** and choose **Export program bundle…**. The
card shows the job move through *queued → building → ready*, then offers
**Download bundle**. A finished bundle's download link stays valid for a few days
(see [retention](/administration/retention/)); use **Rebuild** to make a fresh one.

Exporting a program bundle is an **Admin+** action (a Program Admin or the Owner),
for the same reason as the project bundle — it aggregates the full change history,
every member's time entries, and all attachment binaries across the program.

### API

```
POST /api/v1/programs/{id}/export/          # queue a bundle → 202 + job
GET  /api/v1/programs/{id}/export/jobs/{job_id}/           # poll status
GET  /api/v1/programs/{id}/export/jobs/{job_id}/download/  # download when ready
```

`POST` returns `202 Accepted` with a job whose `status` is `pending`. Poll the
job endpoint until `status` is `success` (or `failed`), then fetch `download_url`.
The download endpoint is authenticated, returns `409` while the job is still
building and `410 Gone` once the link has expired, and reuses a bundle already
`pending`/`running` for the program rather than queuing a duplicate build.

Inside the archive, each member project's contents are nested under
`projects/<project-id>/` (its `msproject.xml`, `attachments/…`,
`time_entries.json`, and `history/*.json`), with one program-wide `seed.json`,
`manifest.json`, and `counts.json` at the top level.

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
- each project's board-card **labels** (name, color, and which tasks carry them),
  so a re-import restores the label catalog,
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
