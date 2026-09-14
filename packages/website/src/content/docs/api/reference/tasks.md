---
title: "Tasks and dependencies API"
description: "Tasks, attachments, dependencies, cross-project slip conflicts, Monte Carlo, task relations, acceptance criteria and recurrence rules."
documentedFor: "0.4"
---

## Tasks

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/tasks/` | List (filter: `?project=`, `?is_critical=true`) |
| GET | `/api/v1/tasks/search/` | Board card search (required: `?project=`, `?q=`); returns slim `{id, name, status, short_id}` matches |
| POST | `/api/v1/tasks/` | Create |
| GET | `/api/v1/tasks/{id}/` | Retrieve |
| PUT / PATCH | `/api/v1/tasks/{id}/` | Update |
| DELETE | `/api/v1/tasks/{id}/` | Soft-delete (cascades to edges) |
| POST | `/api/v1/projects/{id}/tasks/bulk/` | Apply many task writes, and optionally dependency edges, in one request — returns `207`, see [Batch task writes](/api/reference/templates/#batch-task-writes) |
| PATCH | `/api/v1/projects/{id}/tasks/classification/` | Classify a subtree on the governance and delivery axes — see [Subtree classification](/api/reference/templates/#subtree-classification) |
| POST | `/api/v1/projects/{id}/tasks/group/` | Wrap a selection of rows in a new phase, in one transaction — see [Grouping and ungrouping](/api/reference/templates/#grouping-and-ungrouping) |
| POST | `/api/v1/projects/{id}/tasks/ungroup/` | Dissolve a phase and lift its rows one level — see [Grouping and ungrouping](/api/reference/templates/#grouping-and-ungrouping) |
| POST | `/api/v1/tasks/delete-untouched-seeded/` | Bulk soft-delete every untouched-seeded row in a project — see [Seed provenance](#seed-provenance) |

CPM fields (`early_start`, `early_finish`, `late_start`, `late_finish`, `total_float`, `is_critical`) are read-only — set by the auto-scheduler. `early_start`/`early_finish` name the **remaining-work window** for an in-progress task, not its span — a 4-day task at 83% carries a one-day `early_start`..`early_finish` (ADR-0132). `scheduled_start` (paired with `early_finish` as `scheduled_finish` for symmetry — not a separate stored field, always identical to `early_finish`) and `remaining_duration` (also read-only) instead name the task's **span** and the working days of work left on it, so a consumer never has to branch on task state to know which quantity a date field means (ADR-0752). Any client that assumes `finish − start ≈ duration` should read `scheduled_start`/`scheduled_finish`, not `early_start`/`early_finish`.

Those eight fields (the six above plus `free_float` and `scheduled_start`) are **null if and only if the task is outside the schedulable set** — `status=BACKLOG`, `type=EPIC`, a recurring template or occurrence, or soft-deleted — or has never been scheduled (ADR-1152). The scheduler clears them when a task leaves that set, so a value in any of them means the engine computed it *for that task*, and a null means "not in the plan" rather than "not calculated yet". Do not treat a missing date on a backlog card as a scheduling gap to fill; treat `is_critical: null` as "no answer", distinct from `false` ("computed, and not on the critical path"). `duration` is **not** one of these fields — it is a user-owned estimate and is never cleared.

Assigning a **phase** (a task that rolls up one or more real child tasks) to a sprint is rejected unconditionally with `400` and a standard field error on `sprint` carrying the stable code `phase_in_sprint_forbidden`. This is a hard invariant — it is *not* affected by the project's guardrail policy and cannot be escalated or relaxed by an Owner (assigning a phase to a sprint double-counts velocity). Assign the child tasks inside the phase instead. Other sprint-composition guardrails (`summary_in_sprint`, `task_outside_sprint_window`, `recurring_in_sprint`) remain Warn-by-default and are configurable via the guardrail policy.

### Who may create a task

`POST /api/v1/tasks/` requires **Team Member or above, minus the Resource Manager
band (ordinals 200–299)** — the same rule the batch endpoint enforces. Read
`can_author` on the project resource rather than comparing role ordinals yourself:
Resource Manager sits *above* Team Member in the role order and is nonetheless
refused task content, so `role >= Member` gets exactly that role wrong.

:::note[Ships in 0.4]
The single-row refusal ships in **TruePPM 0.4**. On `v0.3.0-alpha.3` (the latest
release) `POST /api/v1/tasks/` accepts a Resource Manager's create and then refuses
every subsequent `PATCH` and `DELETE` on the row it just made, because create gates
on `IsProjectMemberWrite` while update and destroy gate on the per-task rule. The
batch endpoint already refuses the band on that release; only the single-row path
changes.
:::

### Placement on create

:::note[Ships in 0.4]
The request schema below ships in **TruePPM 0.4**. In `v0.3.0-alpha.3` (the latest
release) the server honors `parent_id` and `is_subtask` on `POST` exactly as
described, but neither key appears in the published `TaskRequest` schema, and
sending either on a `PATCH` is a silent no-op with no warning.
:::

A task's position in the WBS is **server-derived**. `wbs_path` is read-only on every
path (ADR-0743) — the create body names a *parent*, and the server allocates the
child number under the same lock as the insert, so two concurrent creates cannot race
to the same path.

| Field | Type | Meaning |
|---|---|---|
| `parent_id` | `uuid` | Place the new task as the last child of this task. Omit to append at root level |
| `is_subtask` | `boolean` | Create a drawer subtask rather than a structural WBS node. Requires `parent_id` |

Both are **create-only, write-only**. They are accepted on `POST /api/v1/tasks/` and
ignored on `PUT`/`PATCH`, which report them back under
[`dropped_fields`](#write-warnings) rather than discarding them. To move an existing
task, use `POST /api/v1/projects/{project_pk}/tasks/{id}/reparent/`.

`is_subtask` accepts `true`/`false`, `1`/`0`, `yes`/`no` and `on`/`off` in any case,
plus a JSON boolean. **Anything else is a `400`** — the flag decides whether the row
becomes a checklist item or a WBS node, which are different objects with different
rollup and delete semantics, so a value the server cannot interpret is refused rather
than defaulted.

Three placement guards reject a structurally impossible parent with a `400` on
`parent_id`: a milestone cannot have children (it is a zero-duration gate, not a
container); nothing may be created under a subtask (subtasks are leaves, ADR-0060);
and a phase that already has a structural child will not accept drawer subtasks,
which would conflate the two decomposition models.

**Dependencies are not part of this body.** There is no `predecessors` field on the
task serializer — create each edge with `POST /api/v1/dependencies/` after the task
exists. A `predecessors` key in a task body is reported under `dropped_fields`.

### Write warnings

:::note[Ships in 0.4]
The `dropped_fields` rule and the declared `warnings` array on the create/update
response ship in **TruePPM 0.4**. In `v0.3.0-alpha.3` a `warnings` array is returned
on `PUT`/`PATCH` for tripped guardrails only, is not part of the published response
schema, and an unrecognized body key is discarded with no signal at all.
:::

A successful task write may carry a `warnings` array. Warnings never change the
status code — the write succeeded; they are non-blocking notices for the client.

```json
{
  "id": "…", "name": "Pour foundation",
  "warnings": [
    {
      "rule": "dropped_fields",
      "detail": "Ignored key(s) not written by this request: predecessors. Dependencies are not part of the task body — create each edge with POST /api/v1/dependencies/."
    }
  ]
}
```

| Rule | Raised when |
|---|---|
| `dropped_fields` | The body carried keys this write did not apply — a key the serializer does not recognize at all, or `parent_id` / `is_subtask` on an update, where placement is create-only |
| *guardrail rule id* | A Warn-level sprint-composition guardrail tripped (ADR-0101) — e.g. `summary_in_sprint`, `task_outside_sprint_window`, `recurring_in_sprint` |

The array is **absent** on a clean write rather than present-and-empty, so test for
the key before iterating.

`dropped_fields` deliberately does **not** fire for keys that are declared in the
schema and marked `readOnly`. A client round-tripping a whole task object sends
dozens of those, and warning on them would bury the keys that carry no signal
anywhere — which is the case the notice exists for: an integrator migrating
dependency-bearing tasks out of Jira or MS Project used to get a `201` for every task
and no way to learn that not one edge had landed.

### Seed provenance

:::note[Ships in 0.4]
The six fields in this section ship in **TruePPM 0.4**. In `v0.3.0-alpha.3` (the
latest release) the task payload carries none of them, and there is no way to tell
a row a template or an import wrote from a row somebody typed.
:::

Every task records where it came from and whether a person has touched it since.
All six fields are **read-only** — a client cannot assert its own provenance, and
cannot clear the edited stamp on a row it edited.

| Field | Meaning |
|---|---|
| `source_kind` | What wrote the row: `hand`, `template`, `seed_import`, `csv_import`, `msproject_import`, `jira_import`, `paste`. Defaults to `hand`, which is also what every row created before 0.4 reports |
| `source_id` | Id of the template or import job that wrote it; `null` for hand-authored rows |
| `source_version` | Template version the row was seeded from; empty string for every other source |
| `seeded_at` | When a machine wrote the row; `null` on hand-authored rows |
| `edited_at` | Last human-caused write; `null` means nobody has ever touched the row |
| `is_untouched_seed` | The server's verdict: `seeded_at` is set **and** `edited_at` is not |

Read `is_untouched_seed` rather than re-deriving it from the two timestamps. It is
the predicate behind the seeded-project landing's "Delete untouched rows (N)"
offer, so a client copy that drifts by one clause would disagree with the server
about what a sweep is going to delete. It carries **no time window** — the
seven-day offer applies the window itself.

A recalculation never counts as an edit: the scheduling engine persists CPM output
through a path that does not touch `edited_at`, so a freshly seeded project still
reports its rows as untouched after the first schedule pass.

**`POST /api/v1/tasks/delete-untouched-seeded/`** carries out the "Delete untouched
rows (N)" offer. The body is `{"project": "<uuid>"}` and nothing else — there is no
way to pass an explicit id list. The server recomputes the untouched set itself
(the same `is_untouched_seed` predicate, unwindowed) rather than trusting a
client-supplied one, because the affordance's entire safety story is "these rows
were never touched," and only the server can assert that. Returns
`200 {"deleted": N}`. Requires **Project Manager (Admin)** or above on the project —
checked explicitly rather than through the usual project-scoped permission class,
since this route is not nested under `/projects/{id}/` and carries no URL-level
project id to gate on.

## Task attachments

Each attachment is **either** an uploaded file **or** an external URL — never both.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/projects/{id}/tasks/{task_id}/attachments/` | List (Viewer+) |
| POST | `/api/v1/projects/{id}/tasks/{task_id}/attachments/` | Add (Team Member+); multipart `file` **xor** `external_url` |
| GET | `/api/v1/projects/{id}/tasks/{task_id}/attachments/{att_id}/` | Retrieve (Viewer+) |
| DELETE | `/api/v1/projects/{id}/tasks/{task_id}/attachments/{att_id}/` | Soft-delete (uploader or Project Manager+) |
| GET | `/api/v1/projects/{id}/tasks/{task_id}/attachments/{att_id}/signed-url/` | Issue a short-lived download URL (file attachments only) |

**File uploads** are governed by the project's resolved attachment policy
(`effective_attachments_enabled` / `effective_allowed_attachment_types` on the
project — see [Projects](/api/reference/projects/#projects)):

- If the resolved `attachments_enabled` is `false`, a **file** upload returns
  `403`. External-URL attachments are **not** affected by `attachments_enabled`.
- The uploaded file's MIME type must be in the project's *resolved* allow-list
  (not a fixed list). A disallowed type returns `415` with code
  `attachment_unsupported_mime`. The declared MIME is also content-sniffed
  against the real bytes, so a payload that masquerades as an allowed type is
  rejected with `415` and code `attachment_content_mismatch`.
- External-URL attachments must use an `http(s)` scheme.

**Signed URLs** require an object-storage backend that actually signs its URLs
(S3/MinIO, GCS, or Azure Blob via `django-storages` — see
[Configuration](/administration/configuration/advanced/#optional--advanced-settings)).
On `FileSystemStorage` (the default) or an unrecognized backend, the
`signed-url` action returns `501` rather than a link claiming an `expires_at`
it can't honor.

## Dependencies

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/dependencies/` | List (filter: `?project=`, `?dep_type=FS`, `?task=`) |
| POST | `/api/v1/dependencies/` | Create |
| GET | `/api/v1/dependencies/{id}/` | Retrieve |
| PUT / PATCH | `/api/v1/dependencies/{id}/` | Update |
| DELETE | `/api/v1/dependencies/{id}/` | Soft-delete |
| POST | `/api/v1/dependencies/{id}/accept/` | Accept a pending cross-project edge (downstream Resource Manager+) — **no body** |
| POST | `/api/v1/dependencies/{id}/reject/` | Reject (soft-delete) a pending cross-project edge — **no body** |

Predecessor and successor may belong to the **same project** or to two projects in the **same [program](/features/programs/)**. Cross-**program** edges return `HTTP 400` (the [Enterprise boundary](/license/) is unchanged). A cross-project edge whose successor sits in a project the creator cannot schedule is created **pending**: it is inert until the downstream project's Resource Manager+ accepts it via `accept/`. Once accepted, the program's schedule recomputes across the boundary so floats and criticality are program-true on every member project's own schedule (not only the [program schedule view](/features/program-schedule/)).

The read-only **`is_driving`** flag marks each link whose relationship free float is zero — the predecessor that actually controls (drives) its successor's early date. It is a CPM output set by the auto-scheduler (clients cannot write it), used by the schedule view to weight driving links above slack ones.

## Cross-project slip conflicts

When an accepted cross-project dependency pushes a committed task in an **active sprint** past its sprint boundary, the program recompute records a **slip conflict** for the downstream team. The dates stay honest — the firewall never moves a sprint, its membership, or its commitment math; it only surfaces the conflict for the team to acknowledge and resolve their own way.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/slip-conflicts/` | List (filter: `?program=`, `?project=`, `?sprint=`, `?open=true`) — scoped to your member projects |
| GET | `/api/v1/slip-conflicts/{id}/` | Retrieve |
| POST | `/api/v1/slip-conflicts/{id}/acknowledge/` | Acknowledge (downstream Scrum Master / Product Owner facet, or Project Manager+) |

Acknowledgment is an audit act — "seen, handling it" — not a schedule change; only a member of the threatened project with the Scrum Master / Product Owner facet (or Project Manager or above) may acknowledge. A conflict that stops slipping (the task moves out, the sprint is extended, the edge is rejected) auto-resolves on the next recompute.

## Monte Carlo

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/projects/{id}/monte-carlo/` | Run a probabilistic schedule simulation synchronously and return P50/P80/P95 (no state written) |
| GET | `/api/v1/projects/{id}/monte-carlo/latest/` | Retrieve the most recently recorded simulation run for the project |
| GET | `/api/v1/projects/{id}/monte-carlo/history/` | List recorded simulation runs for the project |

The run endpoint accepts an optional `n_simulations` in the body; it must not
exceed the OSS simulation cap or the request returns `402`. See
[Monte Carlo](/features/monte-carlo/) and the `MC_*` caps in
[Configuration](/administration/configuration/).

## Task relations

| Method | Path | Description |
|--------|------|-------------|
| GET / POST | `/api/v1/task-relations/` | List / create an informational task-to-task relation |
| GET / PUT / PATCH / DELETE | `/api/v1/task-relations/{id}/` | Retrieve, update, or remove one relation |

A relation (`relates_to` / `blocks` / `duplicates`, ADR-0455) is a
cross-reference, **not** a scheduling [dependency](#dependencies) — it is
inert: no CPM effect, no lag, no cycle check, and no schedule recompute on
write. Endpoints may sit in the same project or in two projects of the same
program; a cross-*program* relation is rejected. Returns a bare array (not
the paginated envelope) since a task's relations are inherently few. See the
[WebSocket event taxonomy](/api/websockets/#board-channel--server--client) for
the corresponding `task_relation_*` events — and note that `task_link_*` is a
**different, unrelated** family (external Jira/GitHub/GitLab links via the
[integrations](/api/reference/collaboration/#integrations) surface below), not a naming variant of this one.

## Acceptance criteria

| Method | Path | Description |
|--------|------|-------------|
| GET / POST | `/api/v1/acceptance-criteria/?task=` | List a task's acceptance criteria / add one (Team Member+) |
| GET / PATCH / DELETE | `/api/v1/acceptance-criteria/{id}/` | Read, tick met/unmet, or remove one criterion |

Stamps `met_by`/`met_at` when `met` flips (ADR-0105 §2); surfaced on
drill-down only, never aggregated to a PMO rollup. See
[Product backlog](/features/product-backlog/#definition-of-ready) for the
Definition-of-Ready meter this powers, and the [PAT section](/api/reference/authentication/#personal-access-tokens-apiv1meapi-tokens-adr-0214)
above for the separate CI-facing `POST /api/v1/projects/{id}/acceptance-results/`
ingest endpoint that flips these same flags from a test run.

## Recurrence rules

CRUD via `/api/v1/recurrence-rules/` (Resource Manager+ to write; any member
may read). Attaching a rule pulls its template task out of the CPM graph and
triggers a recompute; detaching puts it back. See
[Recurring tasks](/features/recurring-tasks/) for the UI and field reference.
