---
title: "Resources and time API"
description: "Resources, task-resource assignments, the project roster, teams, skills, and time tracking."
documentedFor: "0.4"
---

## Resources

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/resources/` | List (per-user throttle: 60 req/min) |
| POST | `/api/v1/resources/` | Create |
| GET | `/api/v1/resources/{id}/` | Retrieve |
| PUT / PATCH | `/api/v1/resources/{id}/` | Update |
| DELETE | `/api/v1/resources/{id}/` | Soft-delete (deactivate) — also removes the resource from every project roster; **workspace Admin only from 0.4** |
| POST | `/api/v1/resources/{id}/restore/` | Reactivate a deactivated resource, restoring the roster rows the deactivation removed — **no body**; `400` if it is not deactivated; **workspace Admin only from 0.4** |
| GET | `/api/v1/resources/{id}/assignments/` | Cross-project task assignments for one resource — **workspace Admin only from 0.4** |

Creating and updating catalog rows requires the Project Manager or Project Admin
role on at least one **active** project. From 0.4, deactivating and restoring a
row, listing the deactivated pool with `?include_deleted=true`, and reading
`assignments/` require the **workspace Admin** role.
Those surfaces reach every project in the installation, and a project role cannot
bound them: project creation is deliberately open, so any account can hold Owner
on a project of its own.

The resource catalog is readable by any authenticated user, so the `email` field
is **gated** to prevent org-wide address harvesting. From 0.4 only a workspace
Admin receives `email` on catalog rows (previously any org admin), and a caller
always sees their own email (`is_me: true`). For all other callers the `email`
field is **omitted** from the payload entirely — absent means *withheld*, not
"this person has no address". `?search=` matches `email` only for a workspace Admin;
everyone else searches by name alone. A per-user throttle of **60 req/min**
applies to the list endpoint to bound bulk scraping; exceeding it returns
`429 Too Many Requests`.

:::caution[Catalog endpoints only]
This gating covers the resource **catalog**. The project and program
`resource-allocation` endpoints and `GET /api/v1/projects/{id}/export/` build their
responses separately and still include `email` for resources attached to a project
you administer.
:::

The list endpoint's two project-scoped filters are gated the same way, for the
same reason. `?exclude_project=<project id>` drops the resources already on that
project's roster, and `?task=<task id>` annotates each row with its fit against
that task's skill requirements — both reach through an open catalog read into one
project's data, so both are honored **only for members of the project they name**.
For a non-member the parameter is ignored and the response is identical to
omitting it, so neither filter can be used to confirm that a project or task id
exists. `?include_deleted=true` is likewise honored only for a workspace Admin.

`assignments/` returns every task the resource is assigned to, across **all**
projects, ordered by project then task name (soft-deleted tasks excluded;
completed tasks included; a deactivated resource still returns its assignments).
Because it carries task and project **names** — project-scoped confidential data
that the base catalog read deliberately withholds — from 0.4 it requires the
**workspace Admin** role; every other caller, project
admins included, receives `403 Forbidden`. For the membership-scoped view of one
person's assignments, use `GET /api/v1/task-resources/?resource=<id>`, which needs
no elevated role. It is a read-only projection: no utilization score, no
overallocation flag, and no cross-program rollup. Each row carries:

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Assignment (allocation) id |
| `task` | UUID | Task id |
| `task_name` | string | Task name |
| `project` | UUID | Project id (client group key) |
| `project_name` | string | Project name |
| `status` | string | Task status |
| `percent_complete` | number | Task completion percentage |
| `units` | decimal | Allocated fraction of the resource's capacity (`0.5` = 50%) |

## Task-resource assignments

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/task-resources/` | List |
| POST | `/api/v1/task-resources/` | Assign |
| GET | `/api/v1/task-resources/{id}/` | Retrieve |
| PUT / PATCH | `/api/v1/task-resources/{id}/` | Update |
| DELETE | `/api/v1/task-resources/{id}/` | Remove |

Writes on this route require **Resource Manager (Scheduler)** or above — it is the
allocation-management surface. To assign an owner *while composing a task*, use the
task write's `owners` field below, which takes the authority of the task write itself.

### Assigning owners inline on a task write

`POST /api/v1/tasks/` and `PATCH /api/v1/tasks/{id}/` accept a **write-only** `owners`
array that creates `TaskResource` rows in the same request:

```json
{
  "name": "Draft the migration plan",
  "owners": [{ "resource": "8e2b…", "units": "0.5" }]
}
```

| Field | Type | Notes |
|-------|------|-------|
| `resource` | uuid | Must be on the **destination project's** roster (`/project-resources/`). An id outside it is a `400` on the `owners` field — never a silent drop, and never a match-or-create against the workspace-wide resource library. |
| `units` | decimal | Fraction of full capacity, `0.01`–`2.0` (`0.5` = 50%). Defaults to `1.0`. |

The array is capped at **100 entries** per task write. The cap counts *entries*, not
distinct resources: repeating a resource id is legal and meaningful (see the audit note
below), and each repeat spends one of the 100. A longer list is refused with `400` before
any roster lookup runs, under `owners` → `non_field_errors`:

```json
{
  "owners": {
    "non_field_errors": [
      "A task write may name at most 100 owners. Remove duplicate resource ids (naming the same resource twice only records an extra units change), or split the assignment across several task writes — owners are upserted, so a later write never removes an owner named by an earlier one."
    ]
  }
}
```

Splitting is always safe because the field upserts: no later write removes an owner named
by an earlier one. The cap is a bound on one *write*, not on a task — a task can still
accumulate more than 100 owners across several writes.

Every surface that validates a task through this serializer inherits the cap:

| Surface | How the refusal reaches you |
|---------|-----------------------------|
| `POST /api/v1/tasks/`, `PATCH /api/v1/tasks/{id}/` | the `400` above |
| `POST /api/v1/projects/{id}/tasks/bulk/` | `207` with the row in `rejected[]`, `code: "invalid"` and the same sentence in `message`. Bounded at 100 owners **per operation** on top of the endpoint's own 500-operation cap |
| Offline-sync push (`POST /api/v1/projects/{id}/sync/`) | a pushed task row carrying more than 100 `owners` is refused like any other row the task serializer rejects |

**The per-operation/per-row cap is not the only bound on these two batch surfaces.**
`POST /api/v1/projects/{id}/tasks/bulk/` builds one task serializer per operation — up to
500 of them — so the 100-per-row cap alone still let one request compose
500 × 100 = 50,000 owner entries. Both batch surfaces also enforce a **batch-wide**
budget, summed across every operation/row in the request, independent of the per-row
cap:

| Surface | Batch-wide cap | Refusal shape |
|---------|-----------------|----------------|
| `POST /api/v1/projects/{id}/tasks/bulk/` | 500 owner entries total across `operations` | Whole-request `400` before any operation applies — never a partial `207`, because the budget is spent across the batch and there is no single operation to blame |
| Offline-sync push (`POST /api/v1/projects/{id}/sync/`) | 500 owner entries total across the `created`/`updated` buckets | Whole-request `400` before the write transaction opens, alongside the existing row-count cap |

A batch under both the per-row and the batch-wide cap on either endpoint also fires only
**one** `tasks_bulk_mutated` WebSocket event for the whole request — an inline `owners`
write no longer fires its own `assignment_*` event on `POST /api/v1/projects/{id}/tasks/bulk/`
or the offline-sync push, because each endpoint's own `tasks_bulk_mutated` already covers
every task id its batch touched. Only the single-task REST write
(`POST /api/v1/tasks/`, `PATCH /api/v1/tasks/{id}/`) still fires `assignment_*` per changed
assignment — it has no coarser event of its own to fall back on.

Semantics worth pinning down:

- **Write-only.** The read projection is the nested `assignments` array on the task.
- **Upsert, not replace-set.** Naming a resource already assigned updates its `units`;
  naming a new one adds it. Owners *not* listed are left alone, so a one-owner write can
  never delete a co-assignee. `[]` is a no-op, not "remove everyone" — removal goes
  through `DELETE /api/v1/task-resources/{id}/`.
- **Authority is the task write's.** `owners` adds no permission class: it is gated by
  whatever gates the surrounding create or update.
- **Never sets `assignee`.** `Task.assignee` is the legacy quick-assign field and carries
  no units; every capacity, utilization, heat-map and sprint-capacity computation reads
  `TaskResource` only. `owners` is the field that makes assigned work count.
- Assigned resources are auto-added to the project roster, so an owner is never assigned
  yet invisible in Team → Roster.
- A summary task rejects an inline owner (`400`) — summary rows roll up from children.

See ADR-0774.

## Project resource roster

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/project-resources/` | List the roster (filter: `?project=`) |
| POST | `/api/v1/project-resources/` | Add a resource to a project's roster (Resource Manager+) |
| GET | `/api/v1/project-resources/{id}/` | Retrieve |
| PUT / PATCH | `/api/v1/project-resources/{id}/` | Update (Resource Manager+) |
| DELETE | `/api/v1/project-resources/{id}/` | Remove from roster (Resource Manager+) |
| DELETE | `/api/v1/project-resources/{id}/?force=true` | Force-remove and cascade-delete the resource's task assignments |

A roster entry carries `units_override`, a per-project capacity override, and the
read-only `effective_max_units` it resolves to (`units_override` when set — `0`
included — else the resource's catalog-wide `max_units`).

From 0.4 `effective_max_units` will be the denominator behind
`GET /projects/{id}/utilization/` (`max_units`, `load_pct`, `load_band`,
`overallocated`), `/resources/heatmap/`, `/resources/summary/`,
`/resource-allocation/` (`max_units`), the `overallocation` items on
`/projects/{id}/attention/`, `Task.assignee_is_overallocated`, the
`resource_overallocated` warning on `POST /task-resources/`, and
`GET /sprints/{id}/capacity/`. Cross-project reads keep `Resource.max_units` — see
the note under **Programs** above.

A plain `DELETE` returns `409 Conflict` with code `roster_has_assignments` if the
resource has live task assignments on the project; the response body lists the
`affected_tasks`, a sample of `task_names`, and the `assignment_count`. Passing
`?force=true` cascades the deletion to the resource's `TaskResource` rows on the
project and triggers a CPM recalculation for the affected tasks, returning `200`
with `cascaded_assignment_count`. All write and delete operations require the
Resource Manager role or higher on the project.

Deactivating a resource (`DELETE /api/v1/resources/{id}/`) removes it from every
roster: the list no longer returns its row, and `POST` refuses the resource with
`400`. `POST /api/v1/resources/{id}/restore/` puts back exactly the rows the
deactivation removed — a membership already removed by hand stays removed. Task
assignment rows are retained throughout, so assignment history survives an
off-boarding; it is the roster and every capacity read that drop the person.

From **0.4**, every write on `/api/v1/project-resources/`, `/api/v1/task-resources/`
and `/api/v1/task-skill-requirements/` — create, update, delete, and the
`?force=true` cascade — is refused with a `403` when the project is archived, at
every role including Owner. Reads are unaffected. Before 0.4, those writes still
succeeded on an archived project.

## Teams

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/projects/{project_id}/teams/` | List a project's teams |
| GET | `/api/v1/teams/{team_id}/members/` | List a team's roster |
| PATCH | `/api/v1/teams/{team_id}/members/{id}/` | Change a member's role/facets |

This release ships the read + role/facet-patch slice only; team create/delete
and the team activity feed are tracked for a later release (#599). See
[Multi-team lens](/features/multi-team-lens/) for the UI this powers.

## Skills and resource-skills

`/api/v1/skills/`, `/api/v1/resource-skills/`, and
`/api/v1/task-skill-requirements/` are documented alongside the rest of the
resource catalog in [Resources](/features/resources/) — see that page for
the full CRUD surface and the skill-match warning codes.

`/api/v1/resource-skills/` lists tags for **active** resources only. A
deactivated resource's catalog row is already admin-only, and its skill tags
follow it: they leave the list for every caller, and `POST` refuses the resource
with `400`. An org admin still sees them expanded on the resource itself via
`GET /api/v1/resources/?include_deleted=true`.

## Time tracking

Logging time requires **Team Member** role or above on the task's project
(`can_log_time`); a Viewer who reads a task sees `can_log_time: false`. Every entry
is owned by the logged-in user — the owner is server-set and cannot be supplied in
the request body. Each contributor sees only their own hours; there is no
cross-contributor rollup in the community edition.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/tasks/{task_pk}/time-entries/` | Log time against a task (`minutes` 1–1440, optional `entry_date`, `note`); Member+ |
| GET | `/api/v1/tasks/{task_pk}/time-entries/` | The caller's own entries on the task plus `total_logged_minutes`; Viewer+ (theirs may be empty) |
| PATCH | `/api/v1/me/time-entries/{id}/` | Edit `minutes` / `entry_date` / `note` — author only (others get `404`) |
| DELETE | `/api/v1/me/time-entries/{id}/` | Soft-delete an entry — author only |
| GET | `/api/v1/me/time-entries/?from=&to=` | Weekly cross-project rollup (`results` + `totals.by_day` / `by_cell` / `today_minutes` / `week_minutes`); defaults to the current week |
| GET | `/api/v1/me/timer/` | The caller's running timer with server-computed `elapsed_seconds` / `stale`, or `{active: false}` |
| POST | `/api/v1/me/timer/start` | Start a timer (`{task, note?}`); a second start atomically stops and logs the running timer first, returning it as `finalized_entry`; Member+ |
| POST | `/api/v1/me/timer/stop` | Stop the running timer and log it as a `TimeEntry` (`source: "timer"`); `409` if no timer is running |

A manual `entry_date` cannot be in the future, nor older than the backdate window
(`TIMETRACKING_BACKDATE_DAYS`, default 60 days). A timer left running past the stale
ceiling (`TIMETRACKING_TIMER_MAX_MINUTES`, default 600) is flagged `stale: true`, and
on stop its logged minutes are capped at the ceiling rather than the raw elapsed time.

Time cannot be logged against a **phase** (a task with structural children — see
[Phase rollup locks](/api/reference/templates/#phase-rollup-locks)): a phase rolls up the logged time of its
child tasks, so a direct entry would double-count. Logging time or starting a timer
on a phase returns `400` with code `time_log_on_phase`.
