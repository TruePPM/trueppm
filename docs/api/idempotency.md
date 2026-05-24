# Idempotency

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
risks, baselines, sprints, calendars, phases, custom fields, resources, skills, webhooks,
notifications, project/program memberships, integration credentials, comments,
attachments, and the board/task structural operations).

A few endpoints are intentionally exempt:

- **API token issuance** (`POST /api/v1/projects/{id}/api-tokens/`) — the response carries
  a one-time plaintext token that must never be persisted for replay.
- **MS Project import** (`POST /api/v1/projects/{id}/import/msproject/`) — multipart upload;
  already deduplicated server-side.
- **Inbound task sync** (`POST /api/v1/projects/{id}/task-sync/`) — already idempotent by
  `(project, source, external_id)` upsert (see the inbound task-sync protocol).

## Retention

Stored idempotency responses are retained for **24 hours** (configurable via
`IDEMPOTENCY_RETENTION_HOURS`; set to `None` to disable purging) and removed by an hourly
maintenance task. After expiry the key is free to be reused, and a retry that arrives after
the window re-runs the request.

## Client behavior

The web app and mobile SDK will attach an `Idempotency-Key` automatically when retrying a
failed mutation. (Those integrations build on this server contract and ship separately.)
Custom API integrations should generate one key per logical operation and reuse that same
key across retries of that operation.
