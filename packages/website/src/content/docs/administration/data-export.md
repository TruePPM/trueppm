---
title: Data export
description: Export a whole program to a canonical JSON seed file — endpoint, CLI, round-trip guarantee, and limitations.
documentedFor: "0.5"
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

```http
GET /api/v1/programs/{id}/export/
```

Requires **Program Manager or above** (the Admin and Owner tiers). The seed
includes team-private data raw — story points and committed/completed/capacity
velocity — so it sits at the same tier as the async export bundle rather than
being open to every member. The response is a JSON attachment.

A program export includes only the member projects you hold project membership on.
A Program Admin who is not a member of a project does not receive that project's content.
A bundle's download link is shown only to the admin who requested it. A requester removed
from a member project can still download their own bundle until its `expires_at`; the
download is not re-checked against current membership.
A backlog item that was pulled into a project you cannot read exports with status `archived`
and no `pulled_to` reference, because its target task is withheld. See
[Upgrading to 0.4](/getting-started/upgrade/#program-exports-and-program-and-project-webhooks-honor-project-membership)
for what changed from earlier betas.

## Export a project

A single project can be exported the same way, from its own settings.

### Web

Open **Project → Settings → Lifecycle** and choose **Export project…**. The
project downloads as a seed file.

### API

```http
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

Exporting a bundle requires **Project Manager** or above — it aggregates the full change
history, every member's time entries, and all attachment binaries, so it sits a
tier above the Viewer-and-above JSON export.

### API

```http
POST /api/v1/projects/{id}/export/          # queue a bundle → 202 + job
GET  /api/v1/projects/{id}/export/jobs/{job_id}/           # poll status
GET  /api/v1/projects/{id}/export/jobs/{job_id}/download/  # download when ready
```

`POST` returns `202 Accepted` with a job whose `status` is `pending`. Poll the
job endpoint until `status` is `success` (or `failed`), then fetch `download_url`.
The download endpoint is authenticated (the archive is never served from a raw
storage URL); it returns `409` while the job is still building and `410 Gone`
once the link has expired. A bundle already `pending`/`running` for the project
**for the same requester** is reused rather than queuing a duplicate build — a
second Admin's `POST` always gets a job of their own.

The jobs list, the poll endpoint, and the download endpoint are all scoped to the
admin who requested the job, in addition to the project: another project Admin's
job id — even for the same project — 404s the same way a job id from an unrelated
project would, and never appears in another Admin's jobs list. The bundle's
contents depend on who asked for it (see the email and blocker-text notes below),
so a job and its archive are visible only to their own requester.

### What the bundle contains

| Member | Contents |
| --- | --- |
| `seed.json` | The canonical JSON seed (same as the synchronous export). |
| `msproject.xml` | The schedule as **MS Project XML** (MSPDI). |
| `attachments/…` | Every task attachment binary, plus an `index.json` manifest. |
| `time_entries.json` | All logged time entries for the project's tasks. |
| `history/*.json` | The project's change history (tasks, dependencies, risks, sprints, project). |
| `manifest.json` / `counts.json` | Archive metadata, per-member row counts, and (from 0.5) the [integrity manifest](#encryption-and-integrity-checks). |

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

Exporting a program bundle is a **Program Manager or above** action, for the
same reason as the project bundle — it aggregates the full change history, every
member's time entries, and all attachment binaries across the program.

### API

```http
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
restricted to the **Admin and Owner tiers**: Project Manager or Project Admin on a
project, Program Manager or Program Admin on a program. A bundle is a complete copy of
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

**In the current release, exported files are not encrypted.** That is a deliberate
position, not an oversight — but you should plan around it rather than discover it.
From 0.5 a bundle can be [encrypted when it is built](#optional-encryption), by
choice, per export; a bundle you do not choose to encrypt is still written in the clear.

What does protect an artifact today:

- generating one is **Admin-only**;
- downloading always goes through the **authenticated API** — never a raw or
  presigned storage URL;
- the download link **expires after a few days**, and a nightly job purges expired
  artifacts (see [retention](/administration/retention/));
- artifacts live in **your** object storage, under a prefix you are responsible for
  keeping private.

What that leaves to you: an export sitting in object storage is readable by anyone
who can read that bucket, and — when it was generated by a **workspace Admin or
Owner** (see [What is and isn't exported](#what-is-and-isnt-exported)) — it
contains member and resource **email addresses**, plus, at the Admin tier,
team-private story points and velocity. If you move an export offsite — to a
laptop, a backup service, a ticket attachment — encrypt it yourself at that
point, and treat it as you would any file containing contact information.

### Integrity manifest

:::note[Ships in 0.5]
The integrity manifest ships in 0.5. Bundles built by 0.4 carry no digests; they still import, but cannot be verified.

Program Trash and restore also ship in 0.5, which changes the `The program comes back without its code` note under "Check a file before you import it". In the current release the replaced program shell is not recoverable.
:::

From 0.5, every export bundle records SHA-256 digests so you can prove an archive
is intact before restoring from it. A digest detects **corruption and casual
editing**; it is not a signature, so it does not prove who made the file.

- **Per member.** `manifest.json` carries `members`, a map of every other file in
  the bundle (its path inside the archive) to its lowercase hex SHA-256.
  `manifest.json` is the last file in the archive, because it records the files
  before it.
- **Over the manifest.** `manifest_sha256` is the SHA-256 of the manifest with the
  `manifest_sha256` key removed, serialized as UTF-8 JSON with sorted keys, no
  whitespace (`,` and `:` separators) and ASCII escapes. Because `members` is
  inside that form, one digest covers the whole bundle.
- **Whole artifact.** The export job's `file_sha256` field and the download
  response's `X-Export-SHA256` header carry the SHA-256 of the `.tar.gz` file
  itself. Check it before you move the file:

```bash
sha256sum project-APOLLO.tar.gz     # compare with the X-Export-SHA256 header / file_sha256
```

The whole-artifact (`.tar.gz`) digest is **not** stable across two builds of identical
data: the gzip header and each tar entry header carry a build timestamp, and
`manifest.json` records a `generated_at` time. Treat it as a fingerprint of one specific
file, not of the data. The per-member digests in `members` cover decompressed content
only, so they are identical across two builds of unchanged data.

**On import.** Uploading a bundle (`.tar.gz`) to the program import endpoint
verifies the manifest first. A digest mismatch, a file missing from or not listed in
the manifest, or a truncated archive is refused with `400` before anything is
written. Verification also refuses an archive that inflates past a size bound
(the larger of 64 times `SEED_MAX_UPLOAD_MB` and 256 MiB) or holds more than 10,000
members, so a small crafted upload cannot force the server to hash gigabytes. A bundle with no digests (built before 0.5) is imported without the check.

### Optional encryption

:::note[Ships in 0.5]
Opt-in encryption of export bundles ships in 0.5. In the current release every bundle is a plain `.tar.gz`; encrypt it yourself before it leaves your storage.
:::

From 0.5 the project and program **Export bundle** cards offer **Encryption
(optional)**. It is off unless you choose it, because an encrypted file you cannot
open is worse than a plain one you chose. Two ways to encrypt:

| Choice | What you supply | How the bundle is opened |
|---|---|---|
| **Passphrase** | A passphrase of at least 12 characters, typed twice | Send it to the program import API with the same passphrase (below) |
| **age public key** | An [age](https://age-encryption.org) public key (`age1…`) you already manage | `age -d -i <your key file> project-APOLLO.tar.gz.age > project-APOLLO.tar.gz` |

**TruePPM never keeps the passphrase**, nor anything computed from it alone. The
server turns it into a public key while it handles your request and, while the
bundle is being built, stores only that public key, a random salt and the work
factor. None of them can open the bundle. The passphrase is also removed from a
request before TruePPM hashes it for an `Idempotency-Key` or the agent audit
trail, so no stored digest depends on it. **If you lose the passphrase, nobody
can open the bundle** — build a new one instead. The card asks you to confirm you
understand that before it starts. For an offsite archive where nobody wants to
hold a passphrase, use an age public key; TruePPM only ever sees the public half.

Know what passphrase mode does and does not protect against:

- **It gives confidentiality, not authenticity.** Anyone who has the public key
  can build a file that your passphrase opens, and the integrity manifest inside
  is not a signature, so a forger can rewrite it too. To check that a bundle is
  the one TruePPM built, compare the digest of the decrypted `.tar.gz` with the
  job's `file_sha256` as the API reports it (below), not with anything inside the
  file, and not on the strength of it having decrypted.
- **While a bundle is being built, its job row holds the public key, salt and
  work factor.** Someone who can read the database in that window can test
  passphrase guesses offline, at the cost of one scrypt (2<sup>17</sup>, about
  128 MiB) per guess, and could build a forged bundle that opens under your
  passphrase. TruePPM clears those values as soon as the build finishes or
  fails; a finished job keeps only `encryption_mode`. A build whose worker was
  lost (a killed pod, a dropped queue message) never finishes on its own, so
  TruePPM marks any job still pending or running after two hours as failed and
  clears its values then. That is the longest the window lasts, and it also
  frees you to request a new encrypted export after a lost build. The file itself carries the
  salt and work factor, as every passphrase-encrypted format must, so anyone who
  holds the file can attempt the same offline guessing. Choose a long passphrase.
- **Retrying with an `Idempotency-Key`**: two requests that differ only in the
  passphrase count as the same request, so a retry under the same key replays
  the first response instead of returning `422`. Use a fresh key for a new
  passphrase.

An encrypted bundle is easy to tell apart from a plain one:

- it downloads as `….tar.gz.age`, typed `application/octet-stream`, with an
  `X-Export-Encryption: passphrase` (or `recipient`) response header;
- the job's `encryption_mode` is `passphrase` or `recipient` (`none` for a plain
  bundle), and the card says **Encrypted with a passphrase** or **Encrypted to an
  age public key**;
- inside, `manifest.json` records `"encryption"`.

`file_sha256` and `X-Export-SHA256` are the digest of the **decrypted** `.tar.gz`,
so they describe the content, not one ciphertext. Check them after you decrypt.

The file is in the age v1 format (X25519, ChaCha20-Poly1305). A key-encrypted
bundle is meant to open with any age tool. CI checks it against an independent
decoder written from the age v1 specification, not against the `age` or `rage`
programs themselves; it was checked by hand once with `rage` (through its
`pyrage` Python bindings) while this feature was built. Try one bundle with your
own age tool before you rely on it for an archive. A passphrase bundle carries an extra
`trueppm-scrypt` header line, which standard age tools do not read, so open it
through the program import API rather than `age -d`. The web **Import program**
button takes a JSON seed only, for plain and encrypted bundles alike.

**API.** `POST …/export/` takes an optional body:

```json
{"encryption": {"mode": "passphrase", "passphrase": "correct horse battery staple"}}
{"encryption": {"mode": "recipient", "recipient": "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p"}}
```

An empty body builds a plain bundle, as before. A passphrase under 12 characters,
an invalid key, or a pasted age **secret** key is a `400`. If you already have a
bundle building with **different** encryption settings, the request is a `409`
rather than handing you a build that does not match; a passphrase request never
reuses an in-flight build. To import a passphrase bundle, send its passphrase
beside the file: `POST /api/v1/programs/import/` with multipart fields `file` and
`passphrase`. A wrong passphrase and a damaged file both return the same `400`.
A file whose header asks for a heavier scrypt work factor than TruePPM writes
(2<sup>17</sup>) is refused as damaged before any key is derived, so an upload
cannot make the server spend more memory than an export of its own would.
TruePPM cannot decrypt a key-encrypted bundle, since it never has your secret key:
decrypt it with `age` first and upload the `.tar.gz`.

The JSON seed export (`GET …/export/`) is not encrypted. It is returned straight to
you and is never stored on the server, so there is nothing at rest to protect.

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

:::note[Ships in 0.5]
Restoring sprint-review history (the sprint bullet below) on re-import ships in 0.5. In 0.4 the sprint-review "what didn't finish" panel is empty after a re-import for tasks a close carried or returned.
:::

- the program, its projects, tasks (WBS paths, three-point estimates,
  durations, statuses), dependencies, sprints, baselines, risks, resources, and
  memberships,
- sprint-review history (what each closed sprint carried to the next sprint or
  returned to the backlog) — **only in a timeline export** (`with_events`, seed
  schema v2). The plain v1 export records each task under its current sprint
  only, so the sprint-review "what didn't finish" panel is empty after
  re-importing one,
- each project's board-card **labels** (name, color, and which tasks carry them),
  so a re-import restores the label catalog,
- the email addresses of the program's members and resources — **only when the
  export is generated by a workspace Admin or Owner.**
- each blocked task's type, age, "waiting on" link, and who flagged it.
  The **free-text blocker reason is exported only to the task's assignee or a
  user @-mentioned on the task** — the same people who can read it in the app.
  A project or program Admin who is neither gets the blocker without its reason:
  the seed omits `reason`, the bundle's `history/tasks.json` blanks
  `blocked_reason`, and re-importing such a file marks the task blocked with the
  placeholder reason `(private)`.

:::caution
When an export does carry email addresses (see above), treat the file as you
would any file containing contact information — the same details members
already see in the app. **No passwords, tokens, or internal IDs are ever
exported.**
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

:::caution[The program comes back without its code]
"Moves to Trash" applies to the replaced program's **projects**, individually and
detached from their old parent. The program shell goes to program Trash too, but its
code moves to the rebuilt program, and there is no program Trash page in the web app
yet. A Program Admin restores it through the API: `GET /api/v1/programs/trash/`, then
`POST /api/v1/programs/{id}/restore/`. The restored program gets a fresh code and its
old projects re-attached; projects still in project Trash stay there until each is
restored. If you need the program back exactly as it was, export it to a seed file
before you re-import over it.
:::

Both import paths have a dry run that validates the file and reports every
problem while writing nothing:

```bash
python manage.py import_seed atlas.json --check
```

```bash
curl -X POST https://your-instance/api/v1/programs/import/validate/ \
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
