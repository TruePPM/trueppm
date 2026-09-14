---
title: "Webhooks, sync and sharing API"
description: "Webhooks, offline sync, integrations, notification preferences, mention groups, assets, public share links, agent actions and user search."
documentedFor: "0.4"
---

## Webhooks

Webhooks are scoped to a project or a program:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/projects/{id}/webhooks/` | List (also `/programs/{id}/webhooks/`) |
| POST | `/api/v1/projects/{id}/webhooks/` | Create |
| GET | `/api/v1/projects/{id}/webhooks/{wid}/` | Retrieve |
| PUT / PATCH | `/api/v1/projects/{id}/webhooks/{wid}/` | Update |
| DELETE | `/api/v1/projects/{id}/webhooks/{wid}/` | Delete |
| POST | `/api/v1/projects/{id}/webhooks/{wid}/test/` | Send a test ping (Project Manager+) |
| GET | `/api/v1/projects/{id}/webhooks/{wid}/deliveries/` | Delivery history, cursor-paginated (**Admin**) |

TruePPM emits **19 event types** across tasks, dependencies, schedule, projects,
sprints, risks, baselines, and comments. The full catalog — every event name, what
triggers it, the payload shape, HMAC signature verification, request headers,
delivery ordering and gap detection, and the retry schedule — is documented in
[Webhooks](/features/webhooks/). Start there before subscribing:

- [Event types](/features/webhooks/#event-types) — the 19-event catalog
- [Payload shape](/features/webhooks/#payload-shape)
- [Signature verification](/features/webhooks/#signature-verification)
- [Delivery ordering and gap detection](/features/webhooks/#delivery-ordering-and-gap-detection)
- [Delivery retries](/features/webhooks/#delivery-retries) — and which statuses are
  *not* retried
- [Automatic deactivation](/features/webhooks/#automatic-deactivation) — the
  consecutive-failure guard and the delivery-health fields it exposes

The signing `secret` (used to HMAC-sign delivered payloads) is **write-only** and
follows a one-time-secret model:

- It is **never** returned on `GET`, list, or update responses.
- It is echoed back **exactly once**, in the `201 Created` response body, so the
  caller can record it. Refetching the webhook afterward never exposes it again —
  if the secret is lost it must be rotated by supplying a new one.
- If omitted or left blank on create, a cryptographically strong secret is
  **auto-generated** (`token_urlsafe(32)`, ~43 URL-safe characters) and returned
  in that one-time create response.
- A supplied secret must be at least **32 characters**. A whitespace-only value
  is rejected; blank is treated as "auto-generate". Validation failures return
  `400`.
- Reads expose only `secret_set` — a boolean saying whether a secret is stored.
- It is **encrypted at rest**, so there is no path (API, database dump, or admin) to
  the plaintext after that one-time create response.
- Webhook create is **exempt from `Idempotency-Key`** for exactly this reason: the
  response carries a value that must not be persisted for replay. See
  [Idempotency](/api/idempotency/).

## Sync

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/projects/{id}/sync/` | Pull delta changes |
| POST | `/api/v1/projects/{id}/sync/` | Push a batch of offline changes |

See [Offline Sync](/features/offline-sync/).

The push endpoint accepts a batch of `created` / `updated` / `deleted` task rows
with a client-generated `client_batch_id` for idempotent replay. Two boundary
rules:

- **Idempotency replay is scoped per actor.** A repeated batch with the same
  `client_batch_id` from the **same** authenticated user replays the original
  stored response. A **different** user who reuses the same `client_batch_id`
  gets a **fresh** batch — never the original actor's response — because the
  stored response carries that actor's task ids, server versions, and sync
  watermark. Replay never crosses the project *or* the user boundary.
- **Cross-project id collisions return `409`.** A `created` row whose
  client-generated `id` collides with a task that lives in **another** project
  returns `409 Conflict` with a `detail` message telling the client to
  regenerate the id and re-upload — the server will not silently mutate a task
  in a project the caller's URL scope does not own. The exception is internally
  tagged `sync_id_collision`, but — verified against the current DRF exception
  path — that tag is **not** serialized onto the response body; branch on the
  `409` status, not on a `code` field. See
  [issue #2550](https://gitlab.com/trueppm/trueppm/-/issues/2550).

## Integrations

:::note[Ships in 0.4]
The inbound Git-event receiver's **uniform `404`** for every pre-verification refusal,
and its **1 MB body cap** (`413`), ship in **0.4**. On the current release
(`0.3.0-alpha.3`) that endpoint answers `401` for a bad or missing signature — which is
the disclosure the change removes — and enforces no webhook-specific body cap.
:::

| Method | Path | Description |
|--------|------|-------------|
| GET / POST / DELETE | `/api/v1/me/credentials/{provider}/` | Connect, read, or revoke your own credential for an external provider (ADR-0049) |
| GET / PUT / PATCH / DELETE | `/api/v1/me/connections/{source}/` | Your personal, read-only external task-source connection (ADR-0097 §3 — the OSS carve-out: user-scoped and one-way). `PATCH` takes `poll_enabled` alone |
| POST | `/api/v1/me/connections/{source}/sync/` | Trigger a manual pull of your connection; returns `202 {"queued": true}` |
| GET | `/api/v1/me/external-items/` | Your cached external work items, for the My Work external section |
| GET / PUT | `/api/v1/integrations/projects/{project_id}/git-automation/` | A project's Git-event board-automation config (Project Manager+, ADR-0158) |
| POST | `/api/v1/integrations/projects/{project_id}/git-automation/rotate-secret/` | Rotate the webhook signing secret |
| POST | `/api/v1/integrations/projects/{project_id}/git-webhook/` | Inbound Git-event receiver (unauthenticated by session; verified by the rotatable secret). Every refusal before signature verification — no automation, disabled, no secret, unknown provider, an undecryptable secret, bad signature — returns the **same** `404`, so the endpoint cannot be used to discover which projects have automation configured; bodies over 1 MB get a `413` |

`PUT /api/v1/me/connections/{source}/` takes `jql` and `project_keys`, which
compose rather than compete: `project_keys` is applied as an additional
`AND project IN (...)` on top of `jql` (or on top of the default
"assigned to me and not done" when `jql` is blank), so it can only narrow the
pull. Each key must be a Jira project key — a letter followed by letters, digits
or underscores — and is stored upper-cased and de-duplicated; anything else is a
`400` on the field. `jql` must have balanced parentheses and quotes for the same
reason (the narrowing wraps it), and an unbalanced value is likewise a `400`.

`GET /api/v1/me/connections/{source}/` returns a `last_sync` object describing
the **outcome** of the last pull: `{at, ok, reason, fetched, stored,
total_available, truncated}`. `fetched` is what the provider returned on this
pull; `stored` is what survived the cache cap and de-duplication, and is
therefore the "first N" a user is shown. `total_available` is the provider's own
count of everything matching your filter, or `null` when it did not report one —
`null` means *unknown*, never zero, so do not render it as a denominator.
`truncated` means the source had more than this pull carried (a pull is one page
— 100 items for Jira — and the cache is capped at 500 rows per source), so the
items you see are the first `stored` of your assigned work. On a failure `reason`
is a token from a fixed set — `auth_failed`, `invalid_filter`, `unreachable`,
`rate_limited`, `credential_unreadable` — deliberately never a formatted message,
so nothing from the request URL or the provider's response can reach it; an
unrecognized value is served as `""`.

`last_sync` is `null` in two cases: before the connection's first pull completes,
and after any successful `PUT /api/v1/me/connections/{source}/`. The `PUT`
rebuilds the stored config from its payload and deliberately discards the
previous outcome — that outcome described a pull made with the old token and
filter, so carrying it onto a re-connect would report a count, or a truncation,
that no longer applies. `PUT` returns the same summary object as `GET`.

The same `last_sync` object rides on each `external_sources` row of
`GET /api/v1/me/work/`.

`PATCH /api/v1/me/connections/{source}/` takes exactly one field,
`poll_enabled`, and turns the background poll (ADR-0097 §4) on or off for your
connection. It is a separate verb from `PUT` because `PUT` requires `secret`,
which is write-only and can never be read back — reusing it would make
re-entering your API token the price of changing one boolean. Anything else in
the body is ignored, so this endpoint cannot rewrite a host, a token, or a
filter. It returns the same summary object as `GET`, and `404`s when you have no
connection to that source; a connection belonging to another user is a `404` for
the same reason every other action here is scoped — the `(user, source)` filter
is the only lookup.

`poll_enabled` also appears on the summary and is accepted by `PUT`. On `PUT` it
is the one config key that is **preserved when omitted**: the rest of the stored
config is rebuilt from the payload, but silently switching a connection's polling
off on every token rotation would be a change the caller never asked for. Send
`poll_enabled: false` explicitly to turn it off. A connection whose `status` is
`auth_failed` or `invalid_filter` is skipped by the poll regardless of the flag —
those states need a re-connect, and polling them would spend a request per tick to
fail the same way.

The org-wide, admin-configured, bidirectional Integration Hub is Enterprise;
everything in this table is the OSS carve-out — a personal, one-way credential
or connection, or a single project's own Git automation. See
[Webhooks](/features/webhooks/) for the outbound event side.

## Notification preferences

The per-user notification matrix is one row per `(event_type, channel)` pair.
The first `GET` lazily backfills the default matrix for a user who has none.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/me/notification-preferences/` | Your full matrix (paginated) |
| PATCH | `/api/v1/me/notification-preferences/{id}/` | Toggle one row — only `enabled` is writable |
| POST | `/api/v1/me/notification-preferences/apply-preset/` | Apply a preset across the whole matrix |

Project-scoped routing is a separate, per-(project, user) document:

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/projects/{id}/notification-preferences/` | Any project member | Your routing for this project. Lazily created on first read. |
| PATCH | `/api/v1/projects/{id}/notification-preferences/` | Any project member | Partial update; the matrix is merged, not replaced. |

Each member reads and writes only their own row — there is no admin surface for
editing another member's routing, and the row is resolved from the authenticated
user rather than from a path segment.

Alongside the stored window (`quiet_hours_enabled`, `quiet_hours_from`,
`quiet_hours_until`), the response carries the zone that window is actually read in.
Both fields are read-only; `PATCH`ing them is ignored.

| Field | Type | Description |
|---|---|---|
| `quiet_hours_timezone` | string (IANA) | The zone `quiet_hours_from` / `quiet_hours_until` are interpreted in, e.g. `"Asia/Tokyo"`. |
| `quiet_hours_timezone_source` | enum | Which tier of the chain supplied it: `project`, `workspace`, `server`, or `fallback`. |

The chain is the project's own `timezone`, then the workspace `timezone`, then the
server's `TIME_ZONE`, then UTC; an unparseable value at any tier falls through to the
next. In normal operation only `project` and `workspace` occur — `server` means no
workspace row exists yet, and `fallback` means no tier was usable at all. These two
fields ship in 0.4; see [Project notifications](/features/settings/project-notifications/#which-timezone-the-window-is-read-in).

Both methods return the same document, published as the
`ProjectNotificationPreferenceDocument` schema — the stored row plus two fields the
view adds:

| Field | Type | Description |
|---|---|---|
| `event_delivery` | object of `event_type` → boolean | Whether a delivery path is wired for that matrix row. `false` means the row is stored and honored but nothing dispatches it yet, so render it as such rather than implying a delivery that never happens. |
| `channel_delivery` | object of `channel` → boolean | Whether TruePPM delivers on that matrix column at all. `false` means the column is rendered and the preference stored, but nothing delivers on it yet and no setting anywhere turns it on — so label it rather than imply a delivery that never happens. |

Both fields ship in 0.4. They are independent axes: a cell delivers only when its
event is dispatched **and** its channel delivers. Both are server-global — they
report server wiring, not anything about the user or project whose document carries
them — and both are read-only. Read them rather than hard-coding either list: a
client-side copy drifts the moment a delivery path lands.

`apply-preset` takes a preset name, not a preference row:

```json
{ "preset": "signal_only" }
```

`signal_only` turns in-app on for the two attention-worthy events (a task being
blocked, a due date moving) and turns every other pair off — the escape from a
noisy default without auditing the grid cell by cell. `everything` restores the
shipped defaults. Any other value returns `400`.

The response is the **full rewritten matrix as a bare JSON array**, not the
paginated `{count, results}` envelope the list route returns and not a single
preference object — apply the array to your local state directly rather than
refetching.

## Mention groups

A user-defined `@mention` group is a named alias for a curated set of people, so
a comment can address `@design-review` instead of five usernames. Groups are
scoped to a **project** or to a **program**; the two surfaces are mirrors of each
other and take identical payloads.

| Method | Path | Description |
|--------|------|-------------|
| GET / POST | `/api/v1/projects/{project_pk}/mention-groups/` | List / create a project group |
| GET / PATCH / DELETE | `/api/v1/projects/{project_pk}/mention-groups/{id}/` | Retrieve, rename, or soft-delete one |
| POST | `/api/v1/projects/{project_pk}/mention-groups/{id}/add-member/` | Add one member to the roster |
| POST | `/api/v1/projects/{project_pk}/mention-groups/{id}/remove-member/` | Remove one member from the roster |
| POST | `/api/v1/projects/{project_pk}/mention-groups/{id}/mute/` | Mute the group **for yourself** |
| POST | `/api/v1/projects/{project_pk}/mention-groups/{id}/unmute/` | Unmute it for yourself |
| GET / POST | `/api/v1/programs/{program_pk}/mention-groups/` | The program-scoped mirror of the whole table above |

**`add-member` and `remove-member` take a body**, and it is required:

```json
{ "user": "9c2d0f7e-…" }
```

The response to all four actions is the group's read shape — `id`, `name`,
`members` (user summaries), `member_count`, and `muted_by_me`, the per-user
override reflecting whether *the calling user* has muted it. Omitting `user`
returns `400 {"user": "This field is required."}`; naming someone who is not a
member of the project (or, for a program group, of any project in the program)
is likewise a `400`, because a non-member would be filtered out at mention
resolution anyway.

**`mute` and `unmute` take no body.** They act on the caller's own subscription
only — there is no way to mute a group on someone else's behalf.

Roles differ per action. On a project group: Project Manager+ creates, renames, and
deletes; Resource Manager+ curates the roster; **any** member mutes or unmutes.
On a program group the lifecycle actions are Program Admin-only and roster curation is
Program Manager+. A group in an archived project or a closed program is read-only.

## Assets (unified file/link feed)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/assets/?mine=&program=&kind=&label=&provider=&q=&cursor=&page_size=` | Workspace-wide feed across every project the caller can read |
| GET | `/api/v1/projects/{id}/assets/?kind=&label=&provider=&q=&cursor=&page_size=` | One project's feed (Viewer+; readable even on an archived project) |
| GET | `/api/v1/programs/{id}/assets/?kind=&label=&provider=&q=&cursor=&page_size=` | A program's feed, aggregated across its member projects |

Read-only, cursor-paginated aggregation of every task's file attachments and
external links (ADR-0215/ADR-0428). The workspace tier never surfaces an asset
from a project the caller cannot already open — it grants no new reach, which
is what keeps it OSS rather than a portfolio-governance surface. `?mine=true`
hard-scopes to the caller's own assigned tasks; there is no `?user=` escape
hatch. See [Assets](/features/assets/).

## Public share links

| Method | Path | Description |
|--------|------|-------------|
| GET / POST | `/api/v1/projects/{id}/share-links/` | List / mint a public link (Project Manager+) |
| POST | `/api/v1/projects/{id}/share-links/{link_id}/revoke/` | Revoke a link (Project Manager+, idempotent) |
| GET | `/api/v1/share/board/{token}/` | Public, unauthenticated board snapshot |
| GET | `/api/v1/share/schedule/{token}/` | Public, unauthenticated schedule/Gantt snapshot |

The two public endpoints return `410` for a revoked link and a uniform `404`
for an unknown token or a disabled instance-wide sharing kill switch (so a
caller cannot distinguish "never existed" from "feature disabled"), and
support `ETag`/`If-None-Match` (`304` on an unchanged snapshot). See
[Board sharing](/features/board-sharing/).

## Agent actions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/agent-actions/` | List the append-only, hash-chained log of MCP/agent decisions |
| GET | `/api/v1/agent-actions/{id}/` | Retrieve one action record |

Read-only team-visible audit trail (ADR-0112). See
[Agent oversight](/features/agent-oversight/).

## User search

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/users/search/` | Typeahead over workspace users, for the member-invite / mention-group pickers |

Throttled at `user_search` (60/min per user — see
[Rate limiting](/api/reference/#rate-limiting)) to bound bulk scraping of the user directory.
