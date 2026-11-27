---
title: "Projects, members and workspace API"
description: "Calendars, projects, project members, and workspace members, invites and groups."
documentedFor: "0.5"
---

## Calendars

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/calendars/` | List |
| POST | `/api/v1/calendars/` | Create |
| GET | `/api/v1/calendars/{id}/` | Retrieve |
| PUT / PATCH | `/api/v1/calendars/{id}/` | Update |
| DELETE | `/api/v1/calendars/{id}/` | Soft-delete |

Calendar exceptions (`/api/v1/calendars/{calendar_pk}/exceptions/` and `.../exceptions/{id}/`, standard CRUD) are described in [Managing exceptions](/features/calendars/#managing-exceptions).

## Labels

Project labels (`/api/v1/projects/{project_pk}/labels/`), task label assignment (`/api/v1/projects/{project_pk}/tasks/{task_pk}/labels/`) and the program-wide catalog (`/api/v1/programs/{program_pk}/label-catalog/`, `.../label-tasks/`) are described in [Labels](/features/labels/#for-integrations-and-agents).

## Projects

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/projects/` | List (scoped to your memberships) |
| POST | `/api/v1/projects/` | Create (caller becomes Owner) |
| GET | `/api/v1/projects/{id}/` | Retrieve |
| PUT / PATCH | `/api/v1/projects/{id}/` | Update |
| DELETE | `/api/v1/projects/{id}/` | Soft-delete |
| GET | `/api/v1/projects/{id}/status-summary/` | Health and recency summary for the shell — see [Status summary](#status-summary) |
| GET | `/api/v1/projects/{id}/cost/` | Budget, actual cost (hours × rate), earned value, cost variance, budget utilization (spend against budget, not a CPI), and CPI, EAC, ETC, VAC and TCPI with a reason when unavailable, a `provenance` block, per-person lines and definitions — **Project Manager or Owner** (ships in 0.5; see [Cost model](/features/cost-model/#the-project-cost-breakdown)) |
| GET | `/api/v1/projects/health-summary/` | One health row per project the caller is a member of: `id`, `name`, `health_band`, `health_band_source`, `at_risk_count`, `critical_count`. Same `health_band` and `health_band_source` rules as the status summary below |

### Status summary

`GET /api/v1/projects/{id}/status-summary/` returns task counts, health signals, and
recency metadata in one request, so a client rendering a project header does not have
to fan out.

| Field | Type | Meaning |
|---|---|---|
| `task_count` | `integer` | Live (non-deleted) tasks in the project |
| `health_band` | `on_track \| at_risk \| critical` | The project's health band — see [Read `health_band`, do not re-derive it](#read-health_band-do-not-re-derive-it) |
| `health_band_source` | `reported \| derived` | Which of the two branches below decided `health_band` — see [Which of the two produced the band](#which-of-the-two-produced-the-band) |
| `at_risk_count` | `integer` | Incomplete tasks with `total_float` ≤ 5 working days, including negative float. Leaf rows only — phase rows excluded, since a phase's `total_float` is a rollup of its children, not a fact about the phase row itself |
| `critical_count` | `integer` | Incomplete tasks on the critical path. Leaf rows only — phase rows excluded, since a phase's `is_critical` is a rollup of its children, not a fact about the phase row itself |
| `at_risk_tasks` | `array` | Up to 5 at-risk tasks as `{id, name, wbs}`, lowest float first |
| `critical_tasks` | `array` | Up to 5 critical tasks as `{id, name, wbs}`, in WBS order |
| `blocked_count` | `integer` | Live tasks flagged blocked, counted in full. The `count` on `GET /projects/{id}/blocked/` is that list's row count and stops at its cap |
| `monte_carlo_p80` | `date \| null` | An echo of `p80` on `GET /projects/{id}/monte-carlo/latest/`, which owns the figure. Reads the same latest result, so the two agree |
| `last_saved` | `date-time \| null` | Newest human-caused write to any live task |
| `recalculated_at` | `date-time \| null` | When the last CPM pass completed |
| `as_of` | `date-time` | When the server computed this payload |
| `definitions` | `object` | One sentence per figure (`health_band`, `at_risk_count`, `critical_count`, `blocked_count`). See [Metric vocabulary](/features/metric-vocabulary/) |

:::note[Ships in 0.5]
`blocked_count`, `as_of` and `definitions` ship in 0.5 (ADR-1314). In 0.4,
`monte_carlo_p80` reads only the persisted run, so it can lag the forecast
endpoint after a run that refreshed only the cache.
:::

#### Read `health_band`, do not re-derive it

`health_band` is the project's health in the three-word band vocabulary
(`on_track`, `at_risk`, `critical`). The server decides it in this order:

1. the **manual health report** a project manager set on the project (`health`, when
   it is not `AUTO`) — an explicit judgment call beats the arithmetic;
2. otherwise the counts on this same payload: `critical_count > 0` → `critical`,
   else `at_risk_count > 0` → `at_risk`, else `on_track`.

Because step 1 is invisible to the counts, **a client that computes a band from
`at_risk_count` and `critical_count` will contradict the project's own manager** — a
plan a PM reported Critical has clean counts by definition. Print this field. The
`health_band` on `GET /api/v1/projects/health-summary/` is the same value from the
same rule, so the two endpoints never disagree about one project.

`AUTO` is the "no report filed" value of `health`; it is never returned as a band.

Do not confuse `health_band` with `schedule_health` on
`GET /api/v1/projects/{id}/overview/`. That is a different signal — a
schedule-performance-index proxy, with a fourth value `unknown` for a project that
has no planned work to measure against — and it does not read the manual report at
all.

#### Which of the two produced the band

`health_band_source` says which of the two steps above ran: `reported` when a project
manager's manual report decided the band, `derived` when no report is filed and the
counts on this payload decided it. There is no third value — `AUTO` *is* the derived
case.

**A client cannot work this out for itself, which is why the server sends it.** A
report that happens to agree with the counts is indistinguishable from no report at
all: a PM who reports At risk on a plan whose float numbers also say at-risk produces
exactly the band the counts would. Comparing `health_band` against the counts
therefore misses that report silently — and on a reported `on_track` over a critical
plan it blames the counts for a disagreement a person created.

Read it whenever you show the band **next to the evidence the counts represent**. A
surface that prints `Critical` above a list of at-risk and critical tasks is claiming
those rows explain the word; when the source is `reported` they do not, and the
surface has to say so and point at the report instead. TruePPM's own shell health chip
does exactly this.

For **who** filed a reported band and **when**, read `GET
/api/v1/projects/{id}/history/` — `Project.health` is a tracked field. This field says
which branch ran, not who ran it.

**Read the nulls as facts.** Each of `monte_carlo_p80`, `last_saved` and
`recalculated_at` is `null` for exactly one reason,
and that reason is the answer rather than "not available yet":

- `monte_carlo_p80` — no Monte Carlo run has been recorded for this project, or the
  run produced no distribution to anchor on (a project with no committed tasks).
- `last_saved` — nobody has edited a task yet. A freshly seeded or imported project
  reports `null` until a person touches a row; a CPM recalculation is deliberately
  not an edit, so a schedule pass does not clear it.
- `recalculated_at` — the first CPM pass has not completed.

Projects and programs carry the inheritable sharing settings. The override fields
`public_sharing` and `allow_guests` are nullable (`null` = inherit from the parent
scope) and writable by a Project Manager or Program Manager and above; the resolved fields `effective_public_sharing`,
`inherited_public_sharing`, `effective_allow_guests`, and `inherited_allow_guests` are
read-only. See [Sharing & Access Inheritance](/administration/sharing-and-access/).

Projects and programs also carry the inheritable **attachment policy** (the same
Workspace → Program → Project chain). The override fields are writable by a
Project Manager or Program Manager and above:

| Field | Type | Meaning |
|-------|------|---------|
| `attachments_enabled` | `boolean \| null` | Whether file uploads are permitted. `null` = inherit from the parent scope. |
| `allowed_attachment_types` | `string[] \| null` | MIME allow-list (tri-state): `null` = inherit, `[]` = explicitly allow nothing, `[...]` = an explicit set. |

The resolved fields `effective_attachments_enabled`,
`inherited_attachments_enabled`, `effective_allowed_attachment_types`, and
`inherited_allowed_attachment_types` are read-only. `effective_*` is the value in
force after inheritance; `inherited_*` is what the parent scope would supply
(what `effective_*` falls back to when the override is `null`).

Writing a MIME type that is permanently security-denied (`text/html`,
`image/svg+xml`, `application/xhtml+xml`) into `allowed_attachment_types` returns
`400` — these can never be allowed, at any scope. An empty list is accepted. See
[Task collaboration](/features/task-collaboration/) for how the resolved policy
governs uploads.

## Baseline variance

`GET /api/v1/projects/{project_pk}/baselines/{baseline_pk}/variance/?min_days=1` will ship in 0.5, marked [experimental](/api/stability/#experimental-endpoints). Any project member will be able to read it: paginated working-day start and finish variance per task, with `added` and `removed` counts, each row's `cause` and `derivation_ref`, and a `summary` rollup over every row (tasks moved, total finish slip, the largest slip and the project-finish shift). See [Baselines](/features/baselines/#comparing-the-whole-project-against-a-baseline).

### Baseline changeset and decisions

:::note[Ships in 0.5]
These routes ship in 0.5. In the current release a committed plan's baseline is switched with `POST /api/v1/projects/{id}/baselines/{baseline_id}/activate/`.
:::

On a committed (`lifecycle: active`) plan, structural edits join an open changeset and the active baseline moves only through a recorded decision ([Baselines](/features/baselines/#changing-a-committed-plan-the-changeset), ADR-1477).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/projects/{project_pk}/changeset/` | Project member | Open entries (unreasoned first), counts by reason state, finish against the active baseline, `last_kept_at`, `entries_since_kept` and `_provenance`. |
| PATCH | `/api/v1/projects/{project_pk}/changeset/entries/{entry_pk}/` | Scheduler+ | Set an entry's `reason` once. A second write is `409 reason_already_set`. |
| GET | `/api/v1/projects/{project_pk}/baseline-decisions/` | Project member | The decision trail, newest first. Append-only. |
| GET | `/api/v1/projects/{project_pk}/baseline-decisions/preview/` | Admin+ | What taking a new baseline would do: finish from and to, working-day delta, milestones moved, tasks with new dates. |
| POST | `/api/v1/projects/{project_pk}/baseline-decisions/` | Admin+, signed-in session only | `kind: "taken"` (with `reason_code` and `reason`) or `kind: "kept"` (optional `note`), plus `expected_open_count`. Refused with `409 changeset_changed` when the open set moved, and `taken` with `409 changeset_unreasoned` while any entry lacks a reason. An API token is refused with 403. |

### Schedule export for a bug report

:::note[Ships in 0.5]
This endpoint ships in 0.5.
:::

`GET /api/v1/projects/{id}/schedule/bug-report-export/` returns the project's engine
input with names stripped, to attach to a scheduling bug report. Scheduler role and
up only. Archived projects can still be exported. It shares the `cpm_on_read`
throttle, and answers `503 schedule_busy` when no CPM slot is free. The response is
sent as a file download.

| Field | Type | Meaning |
|---|---|---|
| `format_version` | `integer` | Contract version of this payload (`1`) |
| `engine_version` | `string` | The `trueppm-scheduler` version installed on the server |
| `engine_input` | `object` | The `trueppm_scheduler.Project` JSON the CPM pass schedules, loadable with `Project.from_json`. The project is named `redacted`, tasks `task-1`, `task-2` and so on; ids are kept |
| `verdict` | `object` | The [scheduler self-check](/administration/observability/#scheduler-self-check) on this schedule: `engine_version`, `task_count`, `checks` (each `pass`, `fail`, `skipped` or `error`), `violations`, and `skipped_reason: "above_envelope"` when the project is over the self-check task ceiling |

See [How to report a scheduling bug](/overview/known-issues/#how-to-report-a-scheduling-bug).

### Driving chain

`GET /api/v1/projects/{id}/schedule/driving-chain/` (query: `task_id`, optional `depth`) returns the
chain of driving links through one task: upstream along the links that hold it to
the tasks nothing drives, downstream to the project finish. It is read from one
server-side CPM pass over the network the engine actually schedules, so a link on a
summary task arrives as the leaf edges it expands to — rebuilding the chain from
stored dependencies misses those. Any project member (Viewer and up) and an
`mcp:read` token may read it. It shares the `cpm_on_read` throttle with
`GET /projects/{id}/schedule/derivation/`.

| Field | Type | Meaning |
|---|---|---|
| `computable` | `boolean` | `false` for a task the CPM pass does not schedule; `nodes` and `edges` are then empty |
| `reason` | `string \| null` | Why it is not computable: `backlog`, `not_committed` (an epic or recurring task), `summary`, or `not_in_network` |
| `depth`, `node_cap` | `integer` | The limits applied: `depth` hops per direction (default 25, max 50) and at most 200 nodes |
| `schema_version` | `integer` | Contract version of this payload. Additive changes keep it |
| `truncated`, `truncated_reason` | `boolean`, `string \| null` | `true` when a limit cut the walk, with `depth` or `node_cap` |
| `total_links` | `integer` | Driving links in the whole chain, uncapped. Larger than `edges.length` exactly when the response is truncated |
| `omitted_non_driving_count` | `integer` | Non-driving links into the task or its upstream chain: predecessors that carry float and are not drawn |
| `near_critical_threshold` | `object` | `{value, unit: "working_days"}` — the effective [near-critical threshold](/administration/project-settings/#near-critical-threshold) the node bands were computed against |
| `calendar_id` | `string \| null` | Id of the base calendar the schedule is computed against: the project's own, else its program's, else the workspace's. `null` only when none resolves and the system default applies. Overlay layers (exceptions, resource calendars) are not named |
| `project_finish` | `date \| null` | The project finish date of the same pass |
| `nodes` | `array` | `{task_id, name, status, direction, hops, early_start, early_finish, total_float, band, is_critical, is_project_finish, sprint}`. `total_float` is `{value, unit: "working_days"}`. `band` is `complete` (finished: zero float but never critical), `critical`, `near_critical` or `ample`; the set is open, so a client must tolerate a value it does not know. `direction` is `self`, `upstream` or `downstream`; `sprint` is `{id, name, finish_date}` or `null`. No assignee, hours or velocity |
| `edges` | `array` | `{predecessor_id, successor_id, dep_type, lag, is_driving, via_summary}`. `lag` is `{value, unit: "calendar_days"}` — float counts working days and lag counts calendar days, so the unit always travels with the value. `via_summary` is a list of `{task_id, name}` for the summary task(s) the stored link was expanded from, or `null` for a direct link |
| `_provenance` | `object` | `{schema_version, engine_version, api_version, input_hash, computed_at}`. The same inputs give the same `input_hash` |

When the throttle is exceeded the endpoint answers `429` with the standard `Retry-After` header. There is no response cache: each call runs one schedule pass.

An unknown task id returns 404, and a `depth` outside 1–50 returns 400.

:::note[Ships in 0.5]
The driving-chain endpoint ships in 0.5 (ADR-1381). In 0.4, call
`GET /projects/{id}/schedule/derivation/` once per hop.
:::

### Derivation vocabulary

:::note[Ships in 0.5]
In 0.4 the schema declares `kind` and `dep_type` as open strings and the response union has no discriminator.
:::

From 0.5, each entry of `contributions` (and `binding`) from `GET /projects/{id}/schedule/derivation/` will be typed in the OpenAPI schema: `kind` as `ScheduleDerivationContributionKindEnum` and `dep_type` as `DepTypeEnum` or null. `ScheduleDerivationResponse` will carry a discriminator on `pass`: `forward`, `backward` and `float` select the CPM shape, `monte_carlo` the percentile shape. The kind enum is open, so a client must tolerate a value it does not know. The payload itself does not change.

## Project and program keys

Every project and program has a **key**, the short name that appears in its links
and IDs. The API field is still named `code`. Project keys are 2 to 10 letters and
digits and start with a letter (`PLAT`). Program keys are lowercase slugs of up to
40 characters (`atlas-platform-launch`). Keys are unique across the workspace for
each kind, compared case-insensitively, and a key is **never reissued**: renaming
a project keeps its old key as an alias that still resolves to it. After a
project is permanently deleted, its keys stay reserved, so an old link returns
`404` rather than opening a different project. A project reference is
`<KEY>-T-<n>` for a task, `<KEY>-SP-<n>` for a sprint, and `<KEY>-R-<n>` for a
risk.

- **Create.** `code` is optional on `POST /projects/` and `POST /programs/`. If
  you leave it out or send `""`, the server derives a key from the name (`PLAT`,
  or `PLAT2` when `PLAT` is taken) and returns it.
- **Rename.** Send a new `code` in a `PATCH` to rename. You need the same role you
  need to edit the General settings. The old key is retired. An object can have
  at most **10** retired keys; the next rename returns `400`. Project and program
  detail responses include `retired_key_count`.
- **Errors.** A `400` on `code` is one of: `This key is already in use.` (held now
  or in the past by any project, including one you can't see; the holder is
  never named), `That word is reserved.` (`new`, `settings`, `trash`, or a
  UUID-shaped value), or a format message.
- **Existing codes.** A project code created before keys were introduced may
  contain hyphens and be up to 12 characters (`GA-SEC`). It is kept and still
  resolves, and a `PATCH` that sends the unchanged value is accepted. A new value
  must use the current format.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/resolve/?kind=project\|program&ref=<ref>` | Resolve a key, a retired key, a UUID, or a `<KEY>-<T\|SP\|R>-<n>` reference to ids |
| GET | `/api/v1/keys/?kind=project\|program&name=<name>` | Suggest a free key for a name: `{suggestion}` |
| GET | `/api/v1/keys/?kind=project\|program&key=<key>[&object_id=<uuid>]` | Check a key: `{available, reason, suggestion}` |

Both endpoints require authentication and share the per-user `resolve` rate limit
(120/min, `TRUEPPM_THROTTLE_RESOLVE_RATE`).

### Resolve

`ref` can be a current key, a retired key, a UUID, or (for `kind=project`) a
reference such as `PLAT-T-10`. The server reads the reference from its **last**
marker, so a hyphenated key still works: `GA-SEC-T-10` is task 10 of `GA-SEC`.

```json
{
  "type": "task",
  "id": "5b0f…",
  "project_id": "9c1e…",
  "program_id": "2d44…",
  "key": "PLAT",
  "canonical_ref": "PLAT-T-10"
}
```

`type` is `project`, `program`, `task`, `sprint`, or `risk`. `key` and
`canonical_ref` are always the **current** form, so a client that holds a retired
key gets the new one back. A project with no key yet has `key: null` and uses
its UUID as `canonical_ref`.

The lookup only searches projects you're an active member of (and programs you
belong to). With a project- or program-scoped API token, it is further limited to
that token's scope. If nothing you can read matches, the response is
`404 {"detail": "Not found."}`. That response is the same whether the key doesn't
exist, belongs to a project you can't see, is outside your token's scope, or is a
retired key of a hidden project.

:::note[Ships in 0.5]
A program-scoped token also requires its minter to still be a member of the
program, at any role. Once the minter is removed from the program, the token
resolves nothing and every lookup returns the same `404`.
:::

### Key suggestion and availability

With `name`, the response is `{"suggestion": "PLAT"}`. With `key`, it is
`{"available": false, "reason": "taken", "suggestion": "PLAT2"}`. `reason` is
`taken`, `reserved`, `invalid`, or `null` when the key is available. Pass
`object_id` when you're renaming: that object's own current and retired keys
are reported as available, because renaming back is allowed. An `object_id` you
can't read is ignored.

This endpoint tells you whether **some** project holds a key, even one you can't
see. That is by design: a workspace-wide unique name can't be refused without
saying it's taken. It never says which project holds the key.

## Project members

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/projects/{id}/members/` | List (Viewer+) |
| POST | `/api/v1/projects/{id}/members/` | Add member (Project Admin only; see the target rule below) |
| GET | `/api/v1/projects/{id}/members/{mid}/` | Retrieve |
| PATCH | `/api/v1/projects/{id}/members/{mid}/` | Change role (Project Admin only). `role` only — `user` is not accepted |
| DELETE | `/api/v1/projects/{id}/members/{mid}/` | Remove (Project Admin, or self) |

Program membership is the same shape, one tier up:

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/v1/programs/{id}/members/` | List (Viewer+) |
| POST | `/api/v1/programs/{id}/members/` | Add member (Program Admin only; same target rule) |
| GET | `/api/v1/programs/{id}/members/{mid}/` | Retrieve |
| PATCH | `/api/v1/programs/{id}/members/{mid}/` | Change `role` (Program Admin) or `role_title` (Program Manager+). `user` is not accepted |
| DELETE | `/api/v1/programs/{id}/members/{mid}/` | Remove (Program Admin, or self). On a closed program only self-removal is accepted; removing another member returns `403` |

### Who `user` may name

From 0.4 the caller's role decides who they may add, not just whether they may add:

- a workspace **Admin** or **Owner** may name any active account;
- anyone else may name themselves, or an account already on a project or program
  roster they belong to — including one whose membership was revoked, so re-adding
  somebody you removed keeps working.

Deactivated accounts are never accepted. An id outside the caller's reach is refused
with `400` and a `user` error carrying the **same message a nonexistent id gets**, so
this field cannot be used to test whether an account exists. To bring in somebody
further out, send a [workspace invite](/administration/workspace-settings/) — it is
keyed on an email address the sender already holds.

`user` is not part of a `PATCH` body on either route. A membership's account is fixed
at creation; remove the member and add the other account instead. See
[API stability](/api/stability/) for the Breaking-change record.

See [RBAC](/administration/rbac/) for the permission matrix and role escalation rules.

## Project views

:::note[Ships in 0.5]
These routes ship in 0.5. On the current release, view visibility is the
workspace-wide `hidden_views` list on `/api/v1/auth/me/profile/`.
:::

Your own resolved tab set for one project, and why each view is shown or hidden.
Every route reads and writes **only the caller's own** row; no parameter names
another user. Any project member (Viewer and up) may call them, archived projects
included, because they change navigation, not project data. See
[Customize views](/features/view-focus/).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/projects/{id}/views/` | Your resolved view set. Your first read for a project seeds it from your role lens; an `mcp:read` agent token's read reports that seed without writing it |
| PATCH | `/api/v1/projects/{id}/views/` | Change your view state (body below) |
| POST | `/api/v1/projects/{id}/views/apply-seed/` | Preview (`dry_run: true`, the default) or apply another lens's suggestions |
| POST | `/api/v1/projects/{id}/views/reset/` | Restore your current lens's suggestions. No body |

The `GET` and `PATCH` response:

```json
{
  "views": [
    {"key": "board", "visible": false, "source": "seed", "binding": "advisory",
     "lens": "pm", "at": "2026-11-20T14:02:00Z"}
  ],
  "lens": "pm",
  "seeded_lens": "pm",
  "seed_line": {"lens": "pm", "hidden_count": 3},
  "lens_offer": null,
  "landing": "overview",
  "last_layouts": {"plan": "schedule"}
}
```

Each view's `source` says why it has its visibility:

| `source` | Meaning |
|----------|---------|
| `always` | A core view that cannot be hidden |
| `methodology` | The project's methodology does not include the view |
| `capability` | The workspace turned the area off |
| `seed` | Your role lens suggested hiding it (`lens` names which) |
| `user` | You hid or showed it yourself (`at` is when) |
| `default` | Shown, with no rule applied |

`seeded_lens` is the lens whose suggestions are in effect, or `null` when none
are (for example a `pm` lens on a Waterfall project, where the methodology already
hides what `pm` would). `lens_offer` names your current lens only after it has
changed since the project was first opened or since suggestions were last applied,
and it clears when you apply or dismiss it, including an apply that changes nothing.

`binding` is `enforced` only for `capability`: the web shows the area as off and
asks you to contact an admin. Every other hidden view is `advisory` and still opens
from **More** and by URL. Neither value is authorization; never read
`visible: false` as forbidden.

`PATCH` accepts any of these fields; send at least one:

| Field | Type | Effect |
|-------|------|--------|
| `key` + `hidden` | string + boolean | Record your own choice for one view. Sent together |
| `seed_line_dismissed` | boolean | Dismiss the "Shown for {lens}" line |
| `lens_offer_dismissed` | `pm` / `scrum_master` / `unified` | Dismiss the "Apply {lens} suggestions" offer for that lens |
| `clear_seed` | boolean | **Show all**: drop this project's seed hides, keeping your own choices |
| `last_layouts` | object | Remember the last layout per view, at most 8 entries |

`apply-seed/` takes `{"lens": "scrum_master", "dry_run": true}` (`pm`, `scrum_master` or `unified`). It and `reset/`
return the diff the confirm dialog shows, and change only `seed` entries; your own
choices come back under `kept`:

```json
{
  "lens": "scrum_master",
  "will_hide": ["calendar"],
  "will_show": ["board"],
  "will_open_on": "board",
  "kept": [{"view": "risk", "hidden": true}],
  "change_count": 2,
  "applied": false
}
```

A write that would hide the last visible Plan layout is refused with `400` on
`PATCH`, `apply-seed/` and `reset/`:

```json
{"code": "last_plan_layout", "detail": "Plan needs at least one layout. Show another layout first."}
```

## Workspace

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/workspace/` | Any active member | Retrieve workspace config. |
| PATCH | `/api/v1/workspace/` | Workspace Admin+ | Update workspace config (partial). |

`timezone` is an IANA identifier (there is no `auto` sentinel — unlike the per-user
profile timezone, this one is resolved server-side). From 0.4 a non-IANA value is
rejected with a `400` instead of stored, and the field is the quiet-hours fallback for
a project that sets no timezone of its own — not a display timezone. See
[Default timezone](/administration/workspace-settings/#default-timezone).

The workspace config includes `public_sharing` and `allow_guests` (the inheritance
defaults for all programs and projects) and `public_sharing_override_policy`
(`suggest`/`enforce`). `enforce` is an Enterprise-only lock and degrades to `suggest` in
the community edition. See [Sharing & Access Inheritance](/administration/sharing-and-access/).

The workspace config also carries the **attachment policy** root — the non-null
top of the Workspace → Program → Project inheritance chain (lower scopes leave
their override `null` to inherit these):

| Field | Type | Meaning |
|-------|------|---------|
| `attachments_enabled` | `boolean` | Whether task **file** uploads are permitted by default (external links are unaffected). |
| `allowed_attachment_types` | `string[]` | MIME allow-list (seeded from the system default). An empty list is a deliberate "no file types allowed" policy. |
| `attachments_override_policy` | `string` | `inherit` / `suggest` / `enforce` (default `suggest`). `enforce` is an Enterprise lock and is a no-op in the community edition. |

These three fields are writable by a Workspace Admin+. Writing a permanently
security-denied MIME type (`text/html`, `image/svg+xml`,
`application/xhtml+xml`) into `allowed_attachment_types` returns `400` — these
can never be allowed.

## Workspace members

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/workspace/members/` | Admin+ (non-admin sees own row only) | List workspace members. |
| PATCH | `/api/v1/workspace/members/{user_id}/` | Admin+ | Change a member's role or status, or their availability baseline (`availability_percent` 0–100, `availability_effective_from`, `availability_effective_to`, `availability_notes`). |
| DELETE | `/api/v1/workspace/members/{user_id}/` | Admin+ | Deactivate a member. |
| POST | `/api/v1/workspace/members/{user_id}/send-set-password-link/` | Admin+, session or JWT only (API tokens refused); member's role must be lower than the caller's | Email a member who has no password a one-time, 30-minute set-password link. The link is never returned. `200 {"sent": true}`; `409` with `code` `member_has_password`, `member_inactive`, `member_has_no_email` or `set_password_link_unavailable`; `503 email_delivery_failed`. 10/hour per caller. Ships in 0.5; see [Restoring access for a member with no password](/administration/single-sign-on/#restoring-access-for-a-member-with-no-password). |

## Workspace invites

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/workspace/invites/` | Admin+ | List invites. Defaults to `?status=pending`; pass a terminal status (`accepted`, `revoked`, `expired`, `failed`) or `all` to read the invite history. Rows carry `accepted_at` / `accepted_by`, both null unless the invite was taken up. |
| POST | `/api/v1/workspace/invites/` | Admin+ | Create an invite (email queued asynchronously). |
| DELETE | `/api/v1/workspace/invites/{id}/` | Admin+ | Revoke a pending invite. |
| POST | `/api/v1/workspace/invites/accept/` | **Public** | Accept an invite with a one-time token. Rate-limited: 20 req/min. |

See [Workspace Settings](/administration/workspace-settings/) for invite token security and the group-access cascade.

## Workspace groups

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/workspace/groups/` | Any member | List groups. |
| POST | `/api/v1/workspace/groups/` | Admin+ | Create a group. |
| GET | `/api/v1/workspace/groups/{id}/` | Any member | Retrieve a group. |
| PATCH | `/api/v1/workspace/groups/{id}/` | Admin+ | Update name, description, or lead. |
| DELETE | `/api/v1/workspace/groups/{id}/` | Admin+ | Delete group (removes group-conferred memberships). |
| POST | `/api/v1/workspace/groups/{id}/members/` | Admin+ | Add a member (triggers project-access cascade). |
| DELETE | `/api/v1/workspace/groups/{id}/members/{user_id}/` | Admin+ | Remove a member (triggers cascade). |
| POST | `/api/v1/workspace/groups/{id}/projects/` | Admin+ | Link group to a project with a conferred role (triggers cascade). |
| DELETE | `/api/v1/workspace/groups/{id}/projects/{project_id}/` | Admin+ | Unlink group from a project (removes group-conferred memberships). |

## Risk register export

:::note[Ships in 0.5]
This endpoint ships in 0.5. In the current release the risk CSV is built in the browser from the Risks view.
:::

```http
GET /api/v1/projects/{project_pk}/risks/export/
```

Returns the project's whole live risk register as `text/csv`
(`risks-<CODE>-<YYYY-MM-DD>.csv`), highest severity first, in the
[data-interchange CSV dialect](/features/csv-import-export/). Any project member
(Viewer and above) can call it. The columns are those of the Risks view's **Export
CSV** plus **Owner Name**; the file round-trips through the risk import. See
[Risk Register](/features/risk-register/).
