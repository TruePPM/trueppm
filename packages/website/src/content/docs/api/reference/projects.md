---
title: "Projects, members and workspace API"
description: "Calendars, projects, project members, and workspace members, invites and groups."
documentedFor: "0.4"
---

## Calendars

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/calendars/` | List |
| POST | `/api/v1/calendars/` | Create |
| GET | `/api/v1/calendars/{id}/` | Retrieve |
| PUT / PATCH | `/api/v1/calendars/{id}/` | Update |
| DELETE | `/api/v1/calendars/{id}/` | Soft-delete |

## Projects

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/projects/` | List (scoped to your memberships) |
| POST | `/api/v1/projects/` | Create (caller becomes Owner) |
| GET | `/api/v1/projects/{id}/` | Retrieve |
| PUT / PATCH | `/api/v1/projects/{id}/` | Update |
| DELETE | `/api/v1/projects/{id}/` | Soft-delete |
| GET | `/api/v1/projects/{id}/status-summary/` | Health and recency summary for the shell — see [Status summary](#status-summary) |
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
| `at_risk_count` | `integer` | Incomplete tasks with `total_float` ≤ 5 working days, including negative float |
| `critical_count` | `integer` | Incomplete tasks on the critical path |
| `at_risk_tasks` | `array` | Up to 5 at-risk tasks as `{id, name, wbs}`, lowest float first |
| `critical_tasks` | `array` | Up to 5 critical tasks as `{id, name, wbs}`, in WBS order |
| `monte_carlo_p80` | `date \| null` | P80 finish from the project's most recent Monte Carlo run |
| `last_saved` | `date-time \| null` | Newest human-caused write to any live task |
| `recalculated_at` | `date-time \| null` | When the last CPM pass completed |

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

**Read the nulls as facts.** Each of the last three is `null` for exactly one reason,
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
| DELETE | `/api/v1/programs/{id}/members/{mid}/` | Remove (Program Admin, or self) |

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
| PATCH | `/api/v1/workspace/members/{user_id}/` | Admin+ | Change a member's role or status. |
| DELETE | `/api/v1/workspace/members/{user_id}/` | Admin+ | Deactivate a member. |

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
