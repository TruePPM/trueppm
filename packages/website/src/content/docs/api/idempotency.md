---
title: Idempotency
description: Stripe-style Idempotency-Key header for safe retries of unsafe requests.
---

TruePPM supports a Stripe-style `Idempotency-Key` request header so that **retrying an
unsafe request is safe** — a retry after a network timeout replays the original response
instead of applying the write a second time.

This is opt-in per request and applies to `POST`, `PUT`, `PATCH`, and `DELETE`.

## How it works

1. Generate a unique key per logical operation — a UUIDv4 is recommended — and send it
   in the `Idempotency-Key` header:

   ```http
   POST /api/v1/tasks/ HTTP/1.1
   Authorization: Bearer <jwt>
   Idempotency-Key: 9f1c2e7a-3b4d-4f5a-8c6e-2d1b0a9f8e7d
   Content-Type: application/json

   {"project": "…", "name": "Build", "duration": 3}
   ```

2. The **first** request runs normally. Its response (status, body, and the `Location`
   header if present) is stored atomically with the database write.

3. A **retry with the same key and the same request** replays the stored response. The
   replay carries an `Idempotent-Replay: true` response header, and the underlying write
   is **not** repeated.

The stored response is written inside the same database transaction as the mutation, so a
committed write always has a replayable response, and a failed (rolled-back) request
stores nothing — a later retry re-runs it.

## Rules and edge cases

| Situation | Result |
|-----------|--------|
| No `Idempotency-Key` header | Normal behavior — the key is opt-in. |
| `GET` / `HEAD` / `OPTIONS` | Header ignored (safe methods). |
| Same key, **same** request | Stored response replayed (`Idempotent-Replay: true`). |
| Same key, **different** request body/path | `422 Unprocessable Entity`, code `idempotency_key_conflict`. |
| Validation error (`4xx`) or server error (`5xx`) | Not cached — these roll back the request, so a retry re-runs it (the error is deterministic). |
| Key older than the retention window | Purged; a later retry re-runs the request. |

**Send byte-identical retries.** The key is bound to a hash of the method, full path
(including query string), and the raw request body. A literal retry of the same request
matches; a semantically-equivalent request serialized differently (e.g. reordered JSON
keys, or `multipart/form-data` whose boundary changes per request) will not match and is
rejected with `422`. Use `application/json` and resend the exact same payload bytes.

**Keys are scoped per authenticated user.** One user cannot replay another user's stored
response, even with the same key value.

### 422 conflict response

```json
{
  "detail": "Idempotency-Key was reused with a different request.",
  "code": "idempotency_key_conflict"
}
```

## Scope

The header is honored on all standard mutation endpoints (tasks, dependencies, projects,
risks, baselines, sprints, calendars, phases, custom fields, resources, skills,
notifications, project/program memberships, integration credentials, comments,
attachments, and the board/task structural operations).

A number of endpoints are intentionally exempt — each view opts out with
`idempotency_exempt = True` (`trueppm_api.apps.idempotency.mixins.IdempotencyMixin`),
for one of four reasons. This lists the exemptions by reason rather than
naming every view, since the set can grow without this page being updated in
lockstep — if you rely on the header against an endpoint not covered by the
categories below, send a real request first and confirm you get an
`Idempotent-Replay` header on a byte-identical retry:

- **The response carries a one-time plaintext secret that must never be
  persisted for replay** — API token issuance
  (`POST /api/v1/projects/{id}/api-tokens/` and
  `POST /api/v1/me/api-tokens/`, personal access tokens), webhook registration
  (`POST /api/v1/{projects,programs}/{id}/webhooks/`), and Git-automation
  secret rotation (`POST .../git-automation/rotate-secret/`).
- **Multipart file uploads already deduplicated server-side** by their own
  request-tracking table, so the generic key store would only add overhead —
  MS Project import, both into an existing project
  (`POST /api/v1/projects/{id}/import/msproject/`) and as a new project
  (`POST /api/v1/projects/import/msproject/`); Jira XML import
  (`POST /api/v1/projects/{id}/import/jira/`); and CSV/Excel import, both the
  stateless preview and the commit (`POST /api/v1/projects/{id}/import/csv/`
  and its `/preview/` sibling).
- **Already idempotent by a different, purpose-built mechanism**, so a second
  layer would be redundant — inbound task sync
  (`POST /api/v1/projects/{id}/task-sync/`, idempotent by
  `(project, source, external_id)` upsert; see the inbound task-sync
  protocol), offline sync push (`POST /api/v1/projects/{id}/sync/`, idempotent
  by `client_batch_id`), the inbound Git webhook receiver (an unauthenticated
  endpoint with no JWT user to key a store on — replay safety comes from a
  Redis delivery claim and a forward-only status guard instead), the
  Git-automation config toggle (`PUT .../git-automation/`, which converges to
  the same state on replay), the CI-verdict / acceptance-criteria endpoint (a
  repeated verdict is a no-op), and SSO provider create
  (`POST /api/v1/workspace/sso/providers/`, which keys on a unique
  `(workspace, slug)` constraint and answers `409` on a duplicate).
- **Replaying a stored response would bypass read-time redaction** —
  notification updates (`PATCH /api/v1/notifications/{id}/` and snooze). A
  notification's subject, body, and project are redacted when the recipient is no
  longer a member of that project; a cached response captured while they still
  were would replay the unredacted content. Both mutations are already naturally
  idempotent (marking read or archived twice is a no-op, and snooze overwrites its
  timestamp), so the header would add no double-submit protection here.

Several of these also carry a token-principal or unauthenticated caller rather
than a JWT/session user, which the generic Idempotency-Key store keys on — a
second, independent reason several of the above are exempt rather than simply
covered by it.

## Retention

Stored idempotency responses are retained for **24 hours** (configurable via
[`TRUEPPM_IDEMPOTENCY_RETENTION_HOURS`](/administration/configuration/#optional--advanced-settings);
set the Django setting to `None` to disable purging — the legacy bare
`IDEMPOTENCY_RETENTION_HOURS` is still read as a fallback when the prefixed variable is
unset) and removed by an hourly maintenance task. After expiry the key is free to be
reused, and a retry that arrives after the window re-runs the request.

## Client behavior

The web app and mobile SDK will attach an `Idempotency-Key` automatically when retrying a
failed mutation. (Those integrations build on this server contract and ship separately.)
Custom API integrations should generate one key per logical operation and reuse that same
key across retries of that operation.
