---
title: "Programs API"
description: "Programs, program membership sync, and the program backlog."
documentedFor: "0.4"
---

## Programs

A program is a container for related projects (see [Programs](/features/programs/)).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/programs/` | List (scoped to your memberships) |
| POST | `/api/v1/programs/` | Create (caller becomes Owner) |
| GET | `/api/v1/programs/{id}/` | Retrieve |
| PUT / PATCH | `/api/v1/programs/{id}/` | Update |
| DELETE | `/api/v1/programs/{id}/` | Soft-delete |
| GET | `/api/v1/programs/{id}/projects/` | The program's project roster — an unpaginated array of **roster rows**, not full project objects (see below). Any program member, Viewer included. Optional `?search=` (project name or code) and `?ordering=name` / `-name`; default order is start date, then name |
| GET | `/api/v1/programs/samples/` | List the bundled samples available to the demo loader |
| POST | `/api/v1/programs/load-sample/` | Load a bundled sample program (the in-app "Load demo data" action); body `{"sample": "<key>"}` |
| POST | `/api/v1/programs/import/` | Import a JSON seed document as a new program (raw JSON body or multipart `file` upload); caller becomes Owner. Returns `202 Accepted` — the program shell is created synchronously, the subtree is built by a worker. Optional `replace` / `expected_program_id` fields confirm a replacement; `409` without them |
| GET | `/api/v1/programs/{id}/import/jobs/{job_id}/` | Poll one seed import job (Program Manager+). A `job_id` belonging to another program `404`s |
| POST | `/api/v1/programs/import/validate/` | **Dry run** — validate a JSON seed document and return every diagnostic, **persisting nothing**. Same request shapes and permissions as `import/`. An invalid document is `200 {"valid": false, "errors": [...]}`, not a `400`: the request succeeded, the document is what failed. Also echoes the schema version, program slug/name, project/task/resource counts the file claims, and a `replaces` object naming the program this import would replace (`null` when the slug is free), so you can confirm you grabbed the right file — and see what it would cost — before running the destructive import |
| GET | `/api/v1/programs/{id}/export/` | Download the program as a canonical JSON seed file (`Content-Disposition: attachment`) |
| GET | `/api/v1/programs/{id}/rollup-config/` | Read the program rollup KPIs config (enabled KPIs + aggregation policy) |
| PATCH | `/api/v1/programs/{id}/rollup-config/` | Update the program rollup KPIs config (Program Manager+) |
| GET | `/api/v1/programs/{id}/risk-policy/` | Read the program risk & dependencies policy |
| PATCH | `/api/v1/programs/{id}/risk-policy/` | Update the program risk & dependencies policy (Program Manager+) |
| POST | `/api/v1/programs/bulk-fields/` | Bulk-set inherited settings (methodology, iteration label, risk policy) across multiple programs; body `{"ids": [...], "fields": {...}}` — only the named rows and fields change (Workspace Admin) |
| POST | `/api/v1/programs/{id}/bulk-project-fields/` | Bulk-set inherited settings (methodology, iteration label) across this program's projects; body `{"ids": [...], "fields": {...}}` (Program Manager+) |
| GET | `/api/v1/programs/{id}/resource-contention/` | Within-program resource contention across member projects (Resource Manager+; optional `?start=` / `?end=` window, repeatable `?resource=` / `?status=`) |
| GET | `/api/v1/programs/{id}/schedule/` | Program-true cross-project critical path — merges every member project's tasks and every accepted cross-project dependency into one CPM run, computed on read. Tasks in projects you cannot read are redacted to a minimal card (title + forecast dates only); links are flagged cross-project (any program member) |
| POST | `/api/v1/programs/{id}/split/` | Split a program into sub-programs — **planned, not yet implemented** (returns `501`) |

Both write endpoints carry a `6/min` per-account scoped limit (see
[Rate limiting](/api/reference/#rate-limiting) below).

### The program project roster is a narrow row

:::note[Ships in 0.4]
The narrowed roster row and the `search` / `ordering` parameters described in this
section ship in **TruePPM 0.4** (#3439, #3420). In `v0.3.0-alpha.3` (the latest
release) this endpoint returns the **full project object** — the same 86-field shape as
`GET /api/v1/projects/{id}/`, for every project in the program including ones you hold
no membership on — and it accepts `search` and `ordering` while ignoring both.
:::

`GET /api/v1/programs/{id}/projects/` is gated on **program** membership, and the
lowest program role passes it. It therefore lists every non-draft project in the
program — including projects you hold no project membership on — and each row is
deliberately much narrower than a project object:

```text
id  name  code  program  start_date
methodology  effective_methodology  inherited_methodology
iteration_label  effective_iteration_label
health  lifecycle  is_archived
overdue_count  at_risk_count
is_pinned  my_role  my_role_label  can_author  can_undo_batch_operations
```

The row answers *which projects are in this program, and how are they doing*. It
carries nothing about how a project is configured or who runs it — no project lead,
no sharing or guest posture, no `mcp_enabled` consent state, no attachment policy, no
surface-visibility map. Those are project settings, and they are served by
`GET /api/v1/projects/{id}/`, which requires membership on that project.

The last five fields answer only about **you**: your role on the row's project
(`null` when you hold none), whether you may author its plan or reverse a batch write
there, and whether you have pinned it. No field on this route reports another user's
role, pin, or identity.

### Seed import is asynchronous

`POST /api/v1/programs/import/` returns **`202 Accepted`**:

```json
{
  "queued": true,
  "program_id": "0f3a…",
  "import_request_id": "b71c…",
  "replaced_program_id": null
}
```

The program shell exists at `program_id` the moment this returns — validation,
the replace decision, the replacement itself, and the shell creation all happen
inside the request — so a client can navigate straight to it. Only the O(n)
subtree build (projects, tasks, sprints, dependencies) is queued. Poll:

```http
GET /api/v1/programs/{program_id}/import/jobs/{import_request_id}/
```

which returns `{ id, program, status, filename, replace, replaced_program_id,
result_summary, error_detail, expires_at, created_at, started_at, completed_at }`.
`status` is one of `pending`, `running`, `success`, `failed`. On success,
`result_summary` carries the entity counts `{ projects, tasks, sprints,
dependencies }`; on failure, `error_detail` carries the reason and the (empty)
program shell is deliberately left in place so you can see what happened and
retry or delete it. The poll endpoint requires **Program Manager+**, and a
`job_id` from another program `404`s.

A malformed or oversized seed document still returns `400` synchronously —
validation runs before anything is queued. `SEED_MAX_UPLOAD_MB` is enforced on
both the multipart upload and the raw JSON body.

### Replacing a program requires confirmation

A seed's `program.slug` is persisted as `Program.code`. If a **live program you
own** already uses that code, the import refuses:

```http
HTTP/1.1 409 Conflict
{
  "detail": "A program you own already uses the code \"atlas\". Re-importing moves its projects to Trash. Confirm to continue.",
  "code": "seed_replace_required",
  "conflict": {
    "program_id": "9c2d…",
    "name": "Atlas Platform Launch",
    "code": "atlas",
    "project_count": 3,
    "task_count": 214
  }
}
```

Two optional request fields confirm it — sent as multipart form fields alongside
`file`, or as sibling keys on a JSON body:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `replace` | boolean | `false` | Authorizes replacing whatever collides |
| `expected_program_id` | UUID | — | Compare-and-swap: must equal the program that would actually be replaced |

`expected_program_id` exists so a client acting on an earlier dry run cannot
destroy the wrong program if the collision moved in between; a mismatch is
refused with `409` and `code: "seed_replace_mismatch"`, carrying the same
`conflict` object. Only programs on which you hold a live **Owner** membership
are ever candidates, which is why naming one back to you leaks nothing.

The replaced program's projects move to project Trash, where each can be
restored individually as a standalone project — the program shell itself is
**not** recoverable, and a restored project does not return to it. Offline
clients receive real deletion tombstones for the removed rows.

### Loading a bundled sample is unchanged

`POST /api/v1/programs/load-sample/` still runs **synchronously** and returns
`201 Created` with a `{program, landing_project_id, sample_key}` envelope —
`landing_project_id` is the project board to land a contributor on so their
assigned work is visible (`null` when the sample has no open sprint), and
`sample_key` echoes the loaded sample. Its payload is a server-curated bundled
fixture of at most a few hundred entities, so a call takes seconds; allow a
generous request timeout and do not poll it. Reloading a sample still deletes
the previous copy outright — demo data is disposable — and never replaces a
program containing a real, non-sample project. See
[Sample projects](/getting-started/sample-projects/).

The `rollup-config` and `risk-policy` endpoints use a method-level permission
split: `GET` is open to any program member (closed programs remain readable for
audit), while `PATCH` requires Program Manager or above and is blocked on closed programs.
Both are partial updates — send only the fields you want to change — and every
successful `PATCH` is audited automatically.

`resource-contention` returns each resource with their task spans across every
member project of the program, each span tagged with its source project, so the
client can surface people over-allocated across sibling projects in overlapping
windows. Overallocation detection is intentionally client-side. The window
defaults to the earliest span start and latest finish across member projects; it
returns `409` if no member project has a computed schedule yet, and `400` for an
invalid date or a `start` after `end`. This is within-program visibility only —
cross-program leveling and the portfolio heat map remain Enterprise.

Both `resource-contention` and the per-project `resource-allocation` cap how many
assignment rows one response carries. When the cap is reached the response sets
`truncated: true` and `resource_count` reports how many resources were in scope, so a
client can tell a complete roster from a cut one. **The cut always falls on a resource
boundary**: a resource is either returned with every one of its in-window spans or left
out entirely, never returned half-complete. That matters because overallocation is
detected client-side by summing a resource's spans — a partial resource would report a
*lower* load than the real one, which is the one error a contention view must not make.
The cap is set clear of the supported project size — it is a backstop against a
pathological project, not a page size, and a project inside the documented envelope does
not reach it. If a response does come back truncated, narrow the window or pass
`?resource=` to see the resources it omitted.

`resource-contention` and the per-project `resource-allocation` share a response
shape but not a meaning for `max_units`: from 0.4 the per-project endpoint states
the resource's capacity **on that project** (the roster's `units_override` when one
is set), while `resource-contention` spans several projects at once and therefore
states the whole person — the resource's catalog-wide `max_units`. A client that
joins the two must not compare one against the other.

Each task span in `resource-contention` (and the per-project
`resource-allocation`) windows and renders on `scheduled_start`
through `early_finish` — the task's **span** — not `early_start` through
`early_finish`, the narrower *remaining-work* window `early_start` shrinks
toward as an in-progress task's `percent_complete` rises (ADR-0752). `early_start`
is still returned for tasks CPM has not populated `scheduled_start` on yet, in
which case the client falls back to it.

Program `split` is a **planned** endpoint that validates the request payload and
the caller's Program Admin role, then returns `501 Not Implemented` with a `detail`
message and a `tracking_issue` number. The request contract it accepts is
`{"splits": [{"name": str, "project_ids": [uuid]}, ...]}`; the working
implementation is not yet available.

## Program membership sync

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/sync/user/programs/` | Pull-only delta sync for `Program` and `ProgramMembership` rows — every program the caller belongs to, plus every co-member's membership row. No path parameter (scope is derived entirely from the caller's own live memberships, so there is no per-user IDOR surface). Complements `projects/{id}/sync/`, which cannot reach the user-scoped program layer |

## Program backlog

The program backlog is the intake pool for a program: ideas and requests live
here until one is **pulled** into a specific project's backlog as a task.

| Method | Path | Description |
|--------|------|-------------|
| GET / POST | `/api/v1/programs/{program_pk}/backlog-items/` | List / create (filters: `?item_type=`, `?status=`, repeatable `?tags=`, fuzzy `?q=`) |
| GET / PATCH / DELETE | `/api/v1/programs/{program_pk}/backlog-items/{id}/` | Retrieve, edit, archive, or soft-delete one item |
| POST | `/api/v1/programs/{program_pk}/backlog-items/{id}/pull/` | Pull a `PROPOSED` item into a project's backlog |

`pull` takes the target project, not a backlog item:

```json
{ "project_id": "9c2d0f7e-…" }
```

It responds `201` with a **two-key envelope** — the task it created and the item
it transitioned, so a client needs no follow-up read:

```json
{ "task": { … }, "backlog_item": { … } }
```

The created task lands in the project backlog (`status=BACKLOG`, no sprint);
`pull` never assigns a sprint. `?status=` defaults to `PROPOSED` on list, so the
default read is the active pool. The caller needs program-write **and** Team
Member+ on the target project — program authority alone cannot drop a task into
a project. A `project_id` outside this program returns `400`; an item that is no
longer `PROPOSED` returns `409`.

:::note[Ships in 0.4]
From **0.4**, a pull into an **archived** target project is refused with a `403`.
On the current release only the *program's* closed state is checked, so a pull
into an archived project succeeds. The archived refusal clears for no role — the
project has to be unarchived.
:::
