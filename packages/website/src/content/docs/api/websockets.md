---
title: WebSocket API
description: Real-time collaboration events over WebSocket — channels and event taxonomy.
documentedFor: "0.8"
---

TruePPM pushes real-time collaboration events over WebSocket. OpenAPI 3.0 cannot
describe WebSocket channels, so this page is the reference for the WS surface that
`docs/api/openapi.json` does not cover.

There are two endpoints, both scoped to a single project by its UUID.

| Endpoint | Consumer | Purpose |
|----------|----------|---------|
| `ws/v1/projects/{project_id}/` | `ProjectConsumer` | Board/schedule events + presence |

`{project_id}` is the project's UUID. Use `wss://` against a TLS deployment and
`ws://` only for local development.

:::caution[Ships in 0.8 — program-scoped channels; the five `program_*` events are not deliverable today]
There is no `ws/v1/programs/{program_id}/` endpoint, and no client can subscribe to a
program's channel group. The server does emit five program lifecycle events —
`program_closed`, `program_reopened`, `program_deleted`, `program_split`, and
`program_sponsorship_transferred` — but it fans them out on the group
`project_{program_id}`, and **nothing in the product can join that group**: the only WS
routes are the two project endpoints above, and `ProjectConsumer` resolves membership
against `ProjectMembership`, which a program UUID never matches. A handshake against a
program UUID is closed with `4003`.

So the five events below are **listed for completeness of the event taxonomy, not as a
subscribable surface**. Do not build a program-lifecycle subscriber against them — it
will connect to nothing. The channel that makes them deliverable is tracked as
[#836](https://gitlab.com/trueppm/trueppm/-/issues/836) and is sequenced for **0.8**.
Until then, subscribe to each member project's channel and refetch the program on the
project-level events you care about (the web app does exactly this).
:::

## Authentication

WebSocket handshakes cannot carry an `Authorization` header, so the credential
must travel in the URL. To keep the long-lived JWT out of access logs, load
balancer logs, and browser history, the handshake uses a **short-lived,
single-use ticket** (RFC 6750 §2.3) rather than the access token itself.

First mint a ticket with an authenticated REST call:

```
POST /api/v1/ws/ticket/
Authorization: Bearer <access_token>

→ 200 { "ticket": "<opaque>", "expires_in": 30 }
```

Then open the socket with the ticket as the `ticket` query parameter:

```
wss://trueppm.example.com/ws/v1/projects/3f9a…/?ticket=<ticket>
```

The ticket is valid for 30 seconds and is consumed on first use — request a fresh
one before every connection, including each reconnect. It carries authentication
only; the server still enforces project membership and role before accepting.

:::caution[Deprecated and off by default: `?token=<access_token>`]
Passing the raw access token as `?token=` is a deprecated fallback that is now
**disabled by default** — a raw JWT in the URL leaks into proxy and server access
logs, so the ticket flow above is the only path that reaches production. An
operator who still has clients on the old path can re-enable it for one last
release by setting `TRUEPPM_WS_LEGACY_TOKEN_AUTH_ENABLED=true`; the server logs a
deprecation warning for each such connection. With the flag off, a `?token=`
handshake is treated as no credential and closed with `4001`. The fallback is
removed entirely next release. Migrate clients to the ticket flow above.
:::

## Close codes

If the server rejects the connection it closes with one of these application
close codes (rather than accepting and then dropping):

| Code | Meaning |
|------|---------|
| `4001` | Missing, invalid, expired, or already-consumed ticket (or, on the deprecated path, an invalid token) |
| `4003` | Authenticated but lacks the required role on the project (Member+ to subscribe) |

A client that receives `4001` should mint a fresh ticket (refreshing the access
token first if needed) and reconnect; a persistent `4001` means the session has
expired and the user must re-authenticate.
Retryable transport drops (network loss, server restart) use the standard
`1006`/`1001` codes and should be reconnected with backoff.

## Board channel — server → client

Every board/schedule event on `ws/v1/projects/{project_id}/` arrives as a JSON
envelope:

```json
{ "protocol_version": 1, "event_type": "<name>", "payload": { ... } }
```

`event_type` is a `snake_case` name. Clients dispatch on it and typically
invalidate the corresponding cache (the web client maps these to TanStack Query
keys). `protocol_version` is a bare integer identifying the envelope wire
version (currently `1`); it is reserved so a future backward-incompatible
envelope change can be negotiated without breaking clients that ignore it today.
The set is open-ended and grows as features land; current event types include:

- **Tasks**: `task_created`, `task_updated`, `task_deleted`, `task_duration_changed`,
  `task_dates_updated`, `task_restored`, `tasks_reordered`, `tasks_restructured`,
  `tasks_bulk_mutated`
- **Dependencies**: `dependency_created`, `dependency_updated`, `dependency_deleted`,
  `dependency_accepted`, `dependency_rejected`
- **Task relations**: `task_relation_created`, `task_relation_updated`,
  `task_relation_deleted` (informational relates-to / blocks / duplicates links;
  payload carries the relation `id`). A cross-project relation fans to both
  endpoint projects. Inert — no schedule recompute follows.
- **Task links** — a **separate family from Task relations above**, despite the
  similar name: `task_link_created`, `task_link_updated`, `task_link_deleted`
  cover an external Git/Jira/GitHub/GitLab reference attached to a task (payload
  carries the link `id` and `task_id`), not an internal task-to-task
  cross-reference. If you are grepping for "link" events looking for the
  relates-to/blocks/duplicates feature, that is **Task relations** above, not
  this family.
- **Scheduling**: `cpm_complete`, `cpm_error`, `task_run_started`,
  `task_run_progress`, `task_run_completed`, `task_run_failed`, `task_run_cancelled`
- **Baselines**: `baseline_created`, `baseline_activated`, `baseline_deleted`
- **Risks**: `risk_created`, `risk_updated`, `risk_deleted`, `risks_imported`
- **Labels**: `label_created`, `label_updated`, `label_deleted` (catalog changes;
  payload carries the label `id`). Assigning or removing a label from a task emits
  `task_updated` with `changed_fields: ["labels"]`, not a distinct event.
- **Sprints**: `sprint_created`, `sprint_updated`, `sprint_deleted`,
  `sprint_activated`, `sprint_cancelled`, `sprint_closed`, `sprint_close_failed`,
  `sprint_reranked`, `sprint_retro_updated`, `milestone_rollup_updated`,
  `milestone_forecast_updated`, `poker_session_updated`, `demo_toggled`.
  `sprint_close_failed` is the negative counterpart of `sprint_closed`: closing a
  sprint is asynchronous (the endpoint returns `202` with a `request_id`), and
  this event fires when that request is abandoned and the sprint will stay open.
  It is emitted **only for a terminal outcome** — a failure the server still
  intends to retry emits nothing, so receiving it always means the close is
  dead. Payload: `{"id": <sprint_id>, "request_id": <uuid>, "failure_reason":
  <cancelled|not_closable|stalled|error>, "attempt_count": <int>, "terminal":
  true}`. It deliberately carries **no error text** — that field is role-gated
  and is read from `GET /api/v1/sprints/{id}/close-request/`, which returns the
  detail the calling identity is entitled to.
- **Retro board**: `retro_item_created`, `retro_item_updated`,
  `retro_item_moved`, `retro_item_deleted`
- **Comments / attachments**: `task_comment_created`, `task_comment_updated`,
  `task_comment_deleted`, `task_comment_ack_changed`,
  `task_comment_reaction_added`, `task_comment_reaction_removed`,
  `task_attachment_created`, `task_attachment_deleted`, `comment_created`
- **Notes log**: `task_note_created`, `task_note_updated`, `task_note_deleted`,
  `task_note_pinned`, `task_note_decision_toggled`
- **Roster / assignments**: `roster_changed`, `assignment_created`,
  `assignment_updated`, `assignment_deleted`
- **Board config**: `board_config_updated`, `board_view_created`,
  `board_view_updated`, `board_view_deleted`, `project_custom_fields_updated`
- **Membership / project**: `member_added`, `member_role_changed`,
  `member_removed`, `mention_group_changed`, `project_updated`,
  `project_archived`, `project_unarchived`, `project_restored`,
  `project_transferred`, `project_deleted`, `project_hard_deleted`
- **Programs** — ⚠️ **not deliverable** until the program channel ships in 0.8 (#836);
  emitted by the server but no client can subscribe, see the caution above:
  `program_closed`, `program_reopened`, `program_deleted`, `program_split`,
  `program_sponsorship_transferred`
- **Task suggestions**: `suggestion_created`, `suggestion_declined`,
  `suggestion_revoked` (decline/revoke carry only the suggestion + task id — never
  the actor — a silent state reconciliation, not a callout)
- **API tokens**: `api_token_minted`, `api_token_revoked` (project/program-scoped
  tokens only — payload carries `token_prefix` + `name`, never the raw token or
  hash; personal access tokens broadcast nothing, see
  [API reference](/api/reference/#personal-access-tokens-apiv1meapi-tokens-adr-0214))
- **Cross-project (ADR-0120)**: `slip_conflict_acknowledged`, `slip_conflicts_updated`
- **Velocity suggestions**: `velocity_suggestion_accepted`, `velocity_suggestion_dismissed`
  — the suggestion settling. An *accept* also emits a normal `task_updated`
  carrying `changed_fields: ["most_likely_duration"]`, because the task's own
  field changed and that field is a Monte Carlo input the CPM delta does not carry
- **Signal privacy (ADR-0104)**: `signal_privacy_changed` (an audience or ceiling
  moved), `signal_ceiling_proposal_changed` (a raise proposal opened, ratified,
  was rejected, expired, was superseded, or withdrawn), `signal_ceiling_vote_cast`
  (a vote that left the proposal open — the running tally). Payloads are ID-only:
  no vote values and no voter identities cross the wire, so a client re-reads
  through REST, which re-applies the privacy gate
- **Working-time calendar**: `project_calendar_changed` — the project's *effective*
  calendar changed. Fired on the affected projects for a Calendar edit, a
  calendar-exception edit, or a program/workspace calendar reassignment; Calendar
  itself is a shared org-level resource with no channel of its own. The payload
  carries `actor`, the display name of whoever made the edit (empty for a system or
  unauthenticated write) — a calendar edit can move finish dates on a project whose
  own members did nothing, so the event names who did it
- **Presence**: `presence_join`, `presence_leave`

> **Event-name convention.** WebSocket `event_type` values are **`snake_case`**
> across the board — including presence, which previously used a dot-namespaced
> `presence.join` / `presence.leave` (aligned to snake_case in 0.2, #828).
>
> Webhook event names are deliberately **dot-namespaced** (`task.created`,
> `task.updated`, …) — a different transport with a different audience
> (external integrations expect dotted topic-style names). So the *same* domain
> event is `task_created` over the WebSocket and `task.created` in a webhook
> payload. This is an intentional per-transport distinction, not drift.
>
> The naming pattern new events must follow (`<resource>_<past-tense-verb>`), the
> frozen-contract guarantee, and the steps to register a new event are documented
> in [WebSocket event conventions](/architecture/websocket-events/).

Treat broadcast delivery as **best-effort**: events may be missed during a
reconnect, so a client should refetch the affected resource on reconnect rather
than rely on having seen every event. Event payloads are intentionally minimal
(usually `{ "id": "<uuid>" }` or a small id set) — fetch the resource for the
full state.

An event's payload may be richer at some emitting sites than others, but **all
sites emitting a given `event_type` share at least one key**, so one handler can
always read every emission of an event it subscribes to. For the task events
(`task_created`, `task_updated`) that key is always `id`. This is enforced by a
conformance test over every broadcast call site, not by convention.

The `task_updated` event carries a richer **field-level delta** (ADR-0152):

```json
{
  "id": "<task uuid>",
  "changed_fields": ["status", "assignee"],
  "version": 42,
  "actor_id": "<user uuid or null>",
  "ts": "2026-06-20T16:00:00Z"
}
```

`changed_fields` lists the names of the fields that changed — **never their
values**, because task fields are role-gated (e.g. `story_points` is nulled below
the velocity audience); a client that needs the new values re-reads the task
through the serializer, which re-applies per-user gating. `version` is the
post-commit `server_version` (clients ignore an event whose version they have
already applied), and `actor_id` lets the originating client suppress its own echo
rather than re-fetching over its optimistic update. The `id` key is retained for
backward compatibility.

## WebSocket ↔ webhook event taxonomy

The *same* domain event uses two different naming conventions depending on the
transport: WebSocket `event_type` values are **`snake_case`** (`task_created`),
while webhook events are **dot-namespaced** `noun.verb` (`task.created`). This is
an intentional per-transport distinction, not drift — see the convention note
above. The two event sets also do not fully overlap: some WS events have no
webhook counterpart (and vice-versa).

### Board events broadcast over WebSocket

These are emitted via `broadcast_board_event()`. The table below highlights the
events with a webhook equivalent plus a representative selection of the
**WS-only** events. It is **illustrative, not exhaustive** — the complete,
authoritative set of WebSocket event types is frozen in the API test suite
(`packages/api/tests/apps/sync/test_broadcast.py`, `FROZEN_WS_EVENT_TYPES`), which
fails CI if a new `broadcast_board_event()` call introduces an event type without
adding it to that frozen set. Events with no webhook counterpart are marked
**WS-only**.

| WebSocket event (`snake_case`) | Webhook event (`noun.verb`) |
|--------------------------------|-----------------------------|
| `task_created` | `task.created` |
| `task_updated` | `task.updated` |
| `task_deleted` | `task.deleted` |
| `task_duration_changed` | **WS-only** |
| `task_dates_updated` | **WS-only** |
| `task_restored` | **WS-only** |
| `dependency_created` | `dependency.created` |
| `dependency_deleted` | `dependency.deleted` |
| `dependency_updated` | **WS-only** |
| `dependency_accepted` | **WS-only** |
| `dependency_rejected` | **WS-only** |
| `task_relation_created` | **WS-only** |
| `task_relation_updated` | **WS-only** |
| `task_relation_deleted` | **WS-only** |
| `task_link_created` | **WS-only** — distinct family from `task_relation_*` above, see the note above |
| `task_link_updated` | **WS-only** |
| `task_link_deleted` | **WS-only** |
| `task_comment_ack_changed` | **WS-only** |
| `task_comment_reaction_added` | **WS-only** |
| `task_comment_reaction_removed` | **WS-only** |
| `project_created` | `project.created` |
| `project_updated` | **WS-only** |
| `project_archived` | **WS-only** |
| `project_unarchived` | **WS-only** |
| `project_restored` | **WS-only** |
| `project_deleted` | **WS-only** |
| `project_custom_fields_updated` | **WS-only** |
| `api_token_minted` | **WS-only** |
| `api_token_revoked` | **WS-only** |
| `demo_toggled` | **WS-only** |
| `milestone_forecast_updated` | **WS-only** |
| `sprint_close_failed` | **WS-only** |
| `program_sponsorship_transferred` | **WS-only** — ⚠️ **not deliverable** until 0.8 (#836) |
| `backlog_reranked` | **WS-only** |
| `sprint_reranked` | **WS-only** |
| `baseline_activated` | **WS-only** |
| `baseline_deleted` | **WS-only** |
| `board_view_created` | **WS-only** |
| `board_view_updated` | **WS-only** |
| `board_view_deleted` | **WS-only** |
| `milestone_rollup_updated` | **WS-only** |
| `phases_reordered` | **WS-only** |
| `queue_reordered` | **WS-only** |
| `program_closed` | **WS-only** — ⚠️ **not deliverable** until 0.8 (#836) |
| `program_reopened` | **WS-only** — ⚠️ **not deliverable** until 0.8 (#836) |
| `program_deleted` | **WS-only** — ⚠️ **not deliverable** until 0.8 (#836) |
| `program_split` | **WS-only** — ⚠️ **not deliverable** until 0.8 (#836) |
| `risk_created` | **WS-only** |
| `risk_updated` | **WS-only** |
| `risk_deleted` | **WS-only** |
| `risks_imported` | **WS-only** |
| `sprint_created` | **WS-only** |
| `sprint_updated` | **WS-only** |
| `sprint_deleted` | **WS-only** |
| `sprint_scope_changed` | **WS-only** |
| `sprint_retro_updated` | **WS-only** |
| `retro_item_created` | **WS-only** |
| `retro_item_updated` | **WS-only** |
| `retro_item_moved` | **WS-only** |
| `retro_item_deleted` | **WS-only** |
| `demo_reordered` | **WS-only** |
| `demo_presenter_set` | **WS-only** |
| `review_note_set` | **WS-only** |
| `flagged_for_backlog` | **WS-only** |
| `tasks_bulk_mutated` | **WS-only** |
| `tasks_reordered` | **WS-only** |
| `tasks_restructured` | **WS-only** |
| `team_member_changed` | **WS-only** |
| `suggestion_created` | **WS-only** |
| `suggestion_declined` | **WS-only** |
| `suggestion_revoked` | **WS-only** |
| `slip_conflict_acknowledged` | **WS-only** |
| `slip_conflicts_updated` | **WS-only** |
| `velocity_suggestion_accepted` | **WS-only** |
| `velocity_suggestion_dismissed` | **WS-only** |
| `signal_privacy_changed` | **WS-only** |
| `signal_ceiling_proposal_changed` | **WS-only** |
| `signal_ceiling_vote_cast` | **WS-only** |
| `project_calendar_changed` | **WS-only** |

### WS-only events on other channels

Presence and scheduling-progress events are broadcast over channels other than
the board channel and have no webhook counterpart:

| WebSocket event | Channel / purpose |
|-----------------|-------------------|
| `presence_join` | Presence (a user connected) — **WS-only** |
| `presence_leave` | Presence (a user disconnected) — **WS-only** |
| `cpm_complete` | Scheduling progress (CPM run finished) — **WS-only**¹ |
| `cpm_error` | Scheduling progress (CPM run failed) — **WS-only**¹ |

¹ The `cpm_*` scheduling-progress events relate **approximately** to the webhook
`schedule.recalculated` event — both signal that a schedule recalculation
occurred — but they are not a one-to-one mapping (the webhook fires once per
recalculation; the WS events stream the lifecycle of a run). Treat the
correspondence as loose.

### Webhook-only events

These webhook events have **no** WebSocket broadcast — they are delivered only to
configured webhook endpoints:

| Webhook event | Notes |
|---------------|-------|
| `schedule.recalculated` | Loosely relates to the `cpm_*` WS events (see above). |
| `task.assigned` | No WS broadcast. |
| `task.assignee_changed` | No WS broadcast. |
| `task.mentioned` | No WS broadcast. |
| `task.due_date_changed` | No WS broadcast. |
| `sprint.activated` | No WS broadcast. First-party agile domain event (ADR-0147). |
| `sprint.closed` | No WS broadcast. Completion snapshot (velocity) is privacy-gated in its payload per ADR-0104. |
| `sprint.scope_changed` | No WS broadcast. Fires on post-activation scope injection (ADR-0102). |
| `risk.opened` | No WS broadcast under this name (a generic `risk_created` WS event exists). First-party domain event (ADR-0206). |
| `risk.escalated` | No WS broadcast under this name. Fires when computed severity (probability × impact) increases (ADR-0206). |
| `risk.closed` | No WS broadcast under this name. Fires on the transition into CLOSED (ADR-0206). |
| `baseline.captured` | No WS broadcast under this name (a generic `baseline_created` WS event exists). First-party domain event (ADR-0206). |
| `comment.created` | No WS broadcast under this name (a generic `task_comment_created` WS event exists). Carries no comment body (ADR-0206). |

The OSS webhook event set is capped at 19 events: `task.created`,
`task.updated`, `task.deleted`, `dependency.created`, `dependency.deleted`,
`schedule.recalculated`, `project.created`, `task.assigned`,
`task.assignee_changed`, `task.mentioned`, `task.due_date_changed`,
`sprint.activated`, `sprint.closed`, `sprint.scope_changed`, `risk.opened`,
`risk.escalated`, `risk.closed`, `baseline.captured`, and `comment.created`. The
agile trio (`sprint.*`) was added in ADR-0147, raising the cap from 11 to 14; the
risk/baseline/comment domain events were added in ADR-0206, raising it from 14 to
19. Adding a 20th event requires its own ADR — the cap is the gate against
per-customer event proliferation, which is the Enterprise upsell line.
