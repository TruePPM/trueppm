---
title: Data export
description: Export a whole program to a canonical JSON seed file — endpoint, CLI, round-trip guarantee, and limitations.
---

Any program — or a single project — can be exported to a canonical JSON seed
file, the same format the [sample projects](/getting-started/sample-projects/)
ship in. Use it to back up your work, move it between instances, or hand it to a
developer to edit and re-import.

## Which format for which job

TruePPM writes three kinds of file, and they are not interchangeable.

| You want to… | Use | Why |
|---|---|---|
| Back up, archive, or move a project between instances | **JSON seed** (below) | The only format that carries a whole program |
| Do all of that *plus* attachments, time entries, and history | **Export bundle** (below) | The seed plus every sidecar, in one `.tar.gz` |
| Hand someone a table, or work in a spreadsheet | **[CSV](/features/csv-import-export/)** | One flat list — never a backup |
| Open the schedule in Microsoft Project | **[MS Project XML](/features/msproject-import-export/)** | The MSPDI interchange format |

The rule behind the table: **the JSON seed is the fidelity format, CSV is the
tabular format.** A CSV holds one flat list with no version and no way to
represent a project, so it is never a backup and never the input to a restore.

The normative contract for all of this — column sets, limits, error handling, and
what each surface guarantees — is the
[data interchange specification](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/specs/data-interchange.spec.md).

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

## Who can export, and where bundles are stored

Exporting a full project or program — the JSON seed **and** the async bundle — is
restricted to **project/program Admins and Owners**. A bundle is a complete copy of
the project's or program's data (including time entries, attachments, and history),
so a Viewer or Member cannot bulk-export it even though they can read individual
items through the app.

Async bundles are written to your configured object storage under the
`project-exports/` and `program-exports/` prefixes, downloaded only through the
authenticated API (never a raw or presigned storage URL), and purged automatically
once they expire (see [retention](/administration/retention/)). **Operator note:**
because a bundle is sensitive by nature, keep the storage location private — the
bucket/prefix hosting these archives must not be publicly readable. TruePPM never
emits a public URL for them, but the storage backend's own ACL is your
responsibility.

## Encryption and integrity checks

**Exported files are not encrypted, and they carry no checksum.** That is a
deliberate position for this release, not an oversight — but you should plan
around it rather than discover it.

What does protect an artifact today:

- generating one is **Admin-only**;
- downloading always goes through the **authenticated API** — never a raw or
  presigned storage URL;
- the download link **expires after a few days**, and a nightly job purges expired
  artifacts (see [retention](/administration/retention/));
- artifacts live in **your** object storage, under a prefix you are responsible for
  keeping private.

What that leaves to you: an export sitting in object storage is readable by anyone
who can read that bucket, and it contains member and resource **email addresses**
plus, at the Admin tier, team-private story points and velocity. If you move an
export offsite — to a laptop, a backup service, a ticket attachment — encrypt it
yourself at that point, and treat it as you would any file containing contact
information.

Two capabilities are planned for **0.5**:

| Planned | What it will add | Issue |
|---|---|---|
| **Integrity manifest** | A SHA-256 digest for every file inside a bundle plus one over the manifest, surfaced on download and verified on import — so you can prove an archive is intact before restoring from it | [#2399](https://gitlab.com/trueppm/trueppm/-/issues/2399) |
| **Optional encryption** | Opt-in encryption of the artifact at generation time, with a passphrase or a recipient key that TruePPM never stores | [#2400](https://gitlab.com/trueppm/trueppm/-/issues/2400) |

Both land in 0.5 — plan around their absence until then.

## Round-trip guarantee

Export is deterministic: exporting a program, re-importing the result into a
clean database, and exporting again produces a **byte-identical** file. This is
what makes the format safe to edit by hand — export, change the JSON, re-import.
Re-import is idempotent (a program with the same slug is replaced, not
duplicated), so you can iterate without piling up copies.

### What "re-import" does — and does not — mean

Re-import **reconstructs** a program; it does not **restore** one in place.

- Every object is created fresh, with **new internal IDs**. References inside the
  file resolve by slug and WBS path, not by ID, so the structure comes back intact
  — but the objects are new objects.
- A program whose slug matches an existing one is **replaced wholesale**, not
  merged field by field. There is no way to import only the fields that changed.
- Importing a **project** export creates a *new single-project program*, because
  the seed format always describes a program. It does not put the project back
  into its original parent program.
- Because of that, cross-project dependencies pointing at a sibling project are
  omitted from a single-project export — the sibling isn't in the file.

Importing in a way that updates the same objects in place, preserving their IDs,
is planned for 0.5
([issue #1959](https://gitlab.com/trueppm/trueppm/-/issues/1959)).

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

## Check a file before you import it

Importing a seed is **replace-then-rebuild on the program slug**: if the document
names a slug that matches a live program you own, that program is removed and
rebuilt from the file rather than merged with it. Validation runs before any
write, so a document that fails validation changes nothing — but you should not
have to find out at commit time.

The replacement is not silent, and it is not unconditional:

- **The REST endpoint refuses by default.** With a colliding slug and no
  confirmation, `POST /api/v1/programs/import/` returns `409 Conflict` with
  `code: "seed_replace_required"` and names the program it would replace,
  including its project and task counts. You confirm by re-sending with
  `replace=true` (optionally pinned to `expected_program_id`).
- **The `import_seed` management command defaults the other way** — it replaces,
  because re-running `make seed` in place is what it is for, and an operator at a
  shell has `--check` available to look first. Pass `--no-replace` to make the
  command refuse instead.
- **The replaced program's projects move to project Trash**, where each can be
  restored individually as a standalone project — the program shell itself is
  **not** recoverable, and a restored project does not return to it. Offline
  clients receive real deletion tombstones for the removed rows.
- **Demo samples still hard-delete.** `POST /api/v1/programs/load-sample/` and
  `load_sample_project` remove the previous copy outright; sample data is
  disposable by design, and a sample reload never replaces a program containing a
  real, non-sample project.

:::caution[Trash holds the projects, not the program]
"Moves to Trash" applies to the replaced program's **projects**, individually and
detached from their old parent. There is no program Trash and no program restore
endpoint ([#2587](https://gitlab.com/trueppm/trueppm/-/issues/2587)). If you need
the program itself back, export it to a seed file before you re-import over it.
:::

Both import paths have a dry run that validates the file and reports every
problem while writing nothing:

```console
$ python manage.py import_seed atlas.json --check
```

```console
$ curl -X POST https://your-instance/api/v1/programs/import/validate/ \
    -H "Authorization: Bearer $TOKEN" -F file=@atlas.json
```

The response echoes what the file claims to be — schema version, program name
and slug, and the project / task / resource counts — so you can confirm you
grabbed the right file, followed by every diagnostic anchored to its JSON path.

A document that fails validation comes back as `200` with `"valid": false` and
the diagnostics, not as an error status: the request succeeded, the *document*
is what failed, and you need the diagnostics either way. A `400` here means the
request itself was unusable — a payload over the size ceiling. The command's
equivalent is its exit code: `0` when valid, `1` when not.

`SEED_MAX_UPLOAD_MB` is enforced on **both** request shapes — a `multipart/form-data`
upload and a raw JSON body — so the ceiling cannot be sidestepped by posting the
document as the body.

The dry-run response also answers *what would this import destroy?* before you
run it. It carries a top-level `replaces` key: `null` when the slug is free, or
the same conflict object the import's `409` returns — `program_id`, `name`,
`code`, `project_count`, and `task_count` — for the program that would be
replaced. Send that `program_id` back as `expected_program_id` on the real
import and the request is refused if the collision moved in the meantime.

The dry run requires the same permissions as the real import.

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
