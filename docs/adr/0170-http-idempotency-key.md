# ADR-0170: HTTP Idempotency-Key Support on Unsafe Mutations

## Status
Proposed

## Context

TruePPM mutation endpoints have no client-driven idempotency mechanism. If a client
retries `POST /api/v1/projects/{id}/tasks/` after a network timeout, the server may
have already committed the first write — the retry double-applies. Mobile sync over
flaky cellular and CI-driven integrations are the most exposed.

Three outbox-protected paths already dedup at the table level via partial unique
indexes (`ScheduleRequest` CPM recompute, MS Project import, inbound task-sync per
ADR-0068). Every *other* mutation endpoint is vulnerable.

This ADR designs the **backend slice only** of issue #663: a Stripe-style
`Idempotency-Key` request header that lets a client mark a mutation so a retry with
the same key replays the original response instead of re-applying the write. Web
TanStack Query auto-attach and Mobile SDK auto-attach are deferred to follow-up issues
(#685 web, #686 mobile).

### Forces

- **`DATABASES['default']['ATOMIC_REQUESTS'] = True`** (`settings/base.py:111`). Every
  request runs inside a single DB transaction that wraps the **view call only**
  (`BaseHandler._get_response`). Django middleware `process_request`/`process_response`
  run *outside* that transaction, in autocommit. **A Django middleware therefore cannot
  write the idempotency record in the same transaction as the mutation** — there would
  be a window where the mutation committed but the idempotency row had not, so a crash
  in that window leaves a retry free to double-apply. The issue text says "DRF
  middleware", but DRF has no middleware concept; the faithful interpretation that
  *meets the stated atomicity requirement* is a hook at the DRF **dispatch layer**
  (`APIView.initial` / `finalize_response`), which runs inside the ATOMIC_REQUESTS
  transaction and after authentication.
- **Auth is at the view layer, not middleware.** simplejwt's `JWTAuthentication` runs
  inside `APIView.initial()`. In a plain Django middleware `request.user` is
  `AnonymousUser` for token-authenticated requests. The DRF dispatch layer is the first
  point where the authenticated principal is known — another reason the hook belongs
  there.
- **Default isolation is READ COMMITTED** (no override in settings). The
  concurrent-duplicate design below relies on this.
- **Established dedup pattern**: `ScheduleRequest` (`scheduling/models.py:29`) uses
  partial unique constraints as a race arbiter. We reuse the unique-constraint-as-arbiter
  idea for the `(user, key)` claim.

### P3M layer

Cross-cutting **Programs and Projects / Operations** infrastructure — it hardens every
OSS mutation endpoint. Not a portfolio or governance concern. **OSS repo.**

## Decision

### 1. Where the hook lives — DRF dispatch-layer mixin (not Django middleware)

Add an `IdempotencyMixin` applied at the DRF view layer. It runs inside the
ATOMIC_REQUESTS transaction and sees the authenticated user:

- **`initial(request, *args, **kwargs)`** (after auth, before the handler): if the
  method is unsafe (POST/PATCH/PUT/DELETE) and an `Idempotency-Key` header is present:
  1. Compute `request_hash` (see §3).
  2. `SELECT` the row for `(request.user, key)`.
     - **Hit, status `completed`, hash matches** → short-circuit: return the stored
       response (replay). No handler runs.
     - **Hit, hash mismatches** → raise `422` (`idempotency_key_conflict`).
     - **Miss** → insert a *claim* row (status `processing`, `response_*` null) inside
       a nested `transaction.atomic()` savepoint, then proceed to the handler.
       - The claim insert may raise `IntegrityError` if a concurrent request already
         claimed the same `(user, key)` (it blocks on the unique index until that
         request's transaction ends; see §2). On `IntegrityError`: roll back the
         savepoint, re-read the now-committed winner row, and replay it (or `422` on
         hash mismatch). The handler never runs, so no double-apply.
- **`finalize_response(request, response, ...)`** (still inside the transaction, before
  the response is rendered): if a claim row was created and the response is storable
  (see §5), `UPDATE` it to status `completed` with `response_status`, `response_body`,
  and a safelisted `response_headers` (e.g. `Location`).

Because storage is a same-transaction `UPDATE`, the invariant holds: **a committed
mutation always has a committed `completed` idempotency row; a rolled-back mutation (5xx
/ unhandled exception → ATOMIC_REQUESTS rollback) leaves no row, so a retry re-runs.**

**Coverage.** The mixin is applied to **every** view that handles an unsafe method:
the shared `ProjectScopedViewSet` base (`access/permissions.py:732`, which most mutation
viewsets already inherit) covers the bulk; the remaining standalone CRUD viewsets and
structural-action `APIView`s (resources, webhooks, notifications, integrations,
memberships, board/task structural ops, workshops) inherit it directly. Views that must
not participate carry the mixin **and** set `idempotency_exempt = True`, so the rule is
uniform. A pytest **enforcement test** walks the URLconf and asserts that every DRF view
resolving an unsafe method has `IdempotencyMixin` in its MRO. This mirrors ADR-0080's
contract-test philosophy: the test is the teeth against silent coverage gaps when a new
mutation view is added later.

**Exemptions** (`idempotency_exempt = True`): `ProjectApiTokenViewSet` (its `create`
response carries the one-time plaintext token, which must never be persisted for replay),
`MsProjectImportView` (multipart upload + already table-deduped via `ImportRequest`), and
`TaskSyncView` (token-principal auth, already idempotent by `(project, source,
external_id)` upsert per ADR-0068). The SimpleJWT auth/token endpoints don't inherit the
mixin at all (they are not in scope).

### 2. Atomicity and the in-flight race

- **Same-transaction storage** via the dispatch-layer `UPDATE` (above) — no
  `on_commit`, because `on_commit` would store in a *separate* post-commit transaction
  and reintroduce the orphan window the feature exists to close.
- **Claim-row-first** under the unique `(user, key)` constraint serializes concurrent
  duplicates. The second request's claim `INSERT` blocks on the unique index until the
  first request's transaction commits or rolls back (Postgres, READ COMMITTED):
  - First **commits** → second gets `IntegrityError` → rolls back its savepoint →
    re-reads the committed `completed` row → replays it. The second handler never ran.
  - First **rolls back** (mutation failed) → second's claim `INSERT` succeeds → second
    proceeds normally.
- **Why the savepoint matters under ATOMIC_REQUESTS**: the `IntegrityError` is isolated
  to the nested `atomic()` block, so rolling back the savepoint restores the outer
  request transaction to a usable state for the re-read.
- **Trade-off (documented):** a concurrent duplicate *blocks* for the duration of the
  in-flight original rather than returning an immediate `409`. Non-blocking in-flight
  detection would require committing the claim in a separate autocommit transaction
  before the handler runs, which sacrifices same-transaction atomicity. We prioritize
  atomicity; true concurrent duplicates (vs. the common retry-after-completion case) are
  rare and the block is bounded by the request's own runtime. A `statement_timeout`-based
  `409` upgrade is noted as a future enhancement.

### 3. `request_hash` composition and the mismatch contract

- `request_hash = sha256(method + "\n" + full_path_with_query + "\n" + raw_request_body).hexdigest()`.
- **Scope/uniqueness** is `(user, key)`, not the hash — this prevents one principal
  replaying another's stored response (defense-in-depth against a guessed/leaked key).
- **Mismatch → `422 Unprocessable Entity`**:
  `{"detail": "Idempotency-Key was reused with a different request.", "code": "idempotency_key_conflict"}`.

### 4. Methods and scoping

- Covers **POST, PATCH, PUT, DELETE**. Safe methods (GET/HEAD/OPTIONS) are a no-op.
- **Header is optional**: absent `Idempotency-Key` → pure no-op (today's behavior),
  preserving backward compatibility. Idempotency is opt-in per request.
- Scoped to views carrying the mixin (see §1 coverage + exemptions).

### 5. Response storage, non-JSON, and retention

- Store `response.data` as JSON in `response_body` (JSONField). The API is JSON-only on
  mutation endpoints.
- **Errors that roll back the request are not cached.** DRF's `exception_handler` calls
  `set_rollback()` for any handled `APIException` (validation `4xx`, `5xx`), which marks
  the whole `ATOMIC_REQUESTS` transaction — *including the claim row* — for rollback.
  `finalize_response` detects this via `connection.get_rollback()` and skips persistence
  entirely; the claim is discarded with the transaction, so a retry simply re-runs (correct
  for a deterministic validation error). Unhandled `5xx` propagate and roll back the same
  way. Only responses on a healthy transaction (the `2xx` success path, and any
  deterministic non-exception response a view returns directly) are stored and replayable.
- **Non-JSON / streaming / no `.data` / oversized** responses on a healthy transaction →
  `finalize_response` deletes the claim row (same transaction) so the key is not consumed
  and a retry re-runs.
- **Body size cap** `IDEMPOTENCY_MAX_BODY_BYTES` (default 1 MiB). Above the cap, skip
  storage (delete the claim) and log — mutation responses are single objects and
  effectively never approach this.
- **Retention/purge**: `created_at` (indexed). An **hourly** Beat task deletes rows
  older than `IDEMPOTENCY_RETENTION_HOURS` (default `24`; `None` disables, matching the
  `*_RETENTION_DAYS = None` enterprise-unlimited convention). Hourly cadence honors the
  issue's "auto-purged after 24h" (a nightly job would let rows live up to ~48h). After
  purge the key is free; a retry older than the window re-runs (the "expired key
  re-runs" acceptance criterion). Purge simply `DELETE`s rows, so there is no
  interaction with the unique index beyond freeing the `(user, key)` pair.

### Model

New app `idempotency` (one-app-per-domain; keeps the HTTP-idempotency concern — model +
mixin + purge task + settings — cohesive rather than muddying `taskruns`). Model **does
not** inherit `VersionedModel` (not synced to mobile):

```python
class IdempotencyKey(models.Model):
    """Stored response for a client-supplied Idempotency-Key on an unsafe mutation.

    Does NOT inherit VersionedModel — server-side request-dedup record, not synced
    to mobile clients. A committed row is always status='completed' (the claim is
    written and updated in the same ATOMIC_REQUESTS transaction; a rolled-back
    mutation leaves no row). See ADR-0170.
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
                             related_name="idempotency_keys")
    key = models.CharField(max_length=255)                 # client-supplied
    method = models.CharField(max_length=8)
    path = models.CharField(max_length=512)
    request_hash = models.CharField(max_length=64)          # sha256 hex
    status = models.CharField(max_length=10, default="processing")  # processing|completed
    response_status = models.SmallIntegerField(null=True, blank=True)
    response_body = models.JSONField(null=True, blank=True)
    response_headers = models.JSONField(null=True, blank=True)  # safelist (Location)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["user", "key"],
                                    name="idempotency_key_unique_per_user"),
        ]
        indexes = [models.Index(fields=["created_at"], name="idempotency_created_idx")]
```

**Migration**: `idempotency/migrations/0001_initial.py` — single `CreateModel`, additive,
no destructive operations, no NOT NULL backfill (new table).

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **DRF dispatch-layer mixin (chosen)** | Same-transaction atomicity; sees authed user; reuses unique-constraint arbiter | Coverage relies on a base mixin + enforcement test rather than blanket interception |
| Django middleware (issue's literal text) | Global, zero per-view wiring | Runs outside ATOMIC_REQUESTS → cannot store atomically (orphan window); `request.user` is Anonymous for JWT |
| Redis-cached responses (no DB) | Fast, auto-expiring | Not atomic with the DB mutation; broker-down loses the dedup record; replay survives only as long as the cache |
| `on_commit` to store the row | Simple | Stores in a separate post-commit transaction → reintroduces the exact orphan window the feature closes |
| Reuse `taskruns` app | No new app wiring | Muddies `taskruns`' single concern (Celery progress) with HTTP-request dedup |

## Consequences

- **Easier**: clients (mobile sync, CI integrations) can safely retry any covered
  mutation by attaching a stable `Idempotency-Key`. The web/mobile auto-attach
  follow-ups build against a merged, stable server contract.
- **Harder**: a new cross-cutting concern in the request path. New mutation views must
  inherit the shared base (or be allowlisted) — the enforcement test makes a missed view
  a test failure, not a silent gap.
- **Risks**: (a) concurrent duplicates *block* rather than 409 (documented trade-off);
  (b) the mixin reads `request.body`, which Django caches, so it does not interfere with
  the view re-reading it — covered by tests; (c) validation/server errors are not cached
  (they roll back the request), so a retry re-runs them — acceptable, since those responses
  are deterministic and re-running is safe.

## Implementation Notes
- P3M layer: Programs and Projects / Operations (cross-cutting infrastructure)
- Affected packages: `api` (new `idempotency` app; mixin wired into `ProjectScopedViewSet`); `docs`
- Migration required: yes — `idempotency/0001_initial.py` (additive `CreateModel`)
- API changes: yes — new optional `Idempotency-Key` request header on unsafe methods;
  new `422 idempotency_key_conflict` response; documented in `packages/website/src/content/docs/api/idempotency.md`
- OSS or Enterprise: **OSS** (Apache 2.0) — core API hardening every PM benefits from

### Durable Execution
1. **Broker-down behaviour**: N/A for the store — it is a synchronous DB write inside the
   request transaction, no async dispatch. The only async component is the hourly purge
   Beat task; broker-down skips a purge cycle and the next run catches up.
2. **Drain task**: N/A — no dispatched work to drain. The purge is self-scheduling via Beat.
3. **Orphan window**: N/A — storage is deliberately same-transaction (no `on_commit`), so
   there is no in-flight outbox row to race.
4. **Service layer**: no `.delay()` from view code, so no `services.py` dispatch function.
   Logic lives in `idempotency/mixins.py`; purge in `idempotency/tasks.py::_do_purge`.
5. **API response on best-effort dispatch**: N/A — fully synchronous; the response is the
   real mutation response (or its stored replay).
6. **Outbox cleanup**: the `IdempotencyKey` rows *are* the cleaned-up artifact — hourly
   Beat purge, `IDEMPOTENCY_RETENTION_HOURS=24` default, `None` disables.
7. **Idempotency**: this *is* the idempotency feature. Duplicate detection = unique
   `(user, key)` + `request_hash` comparison; a match replays the stored response, a hash
   mismatch returns `422`. The purge task itself is `@idempotent_task(on_contention="skip")`.
8. **Dead-letter / failure handling**: the purge task uses `autoretry_for=(OperationalError,)`
   with bounded backoff; a permanently failing cycle is retried next hour. No DLQ — a
   skipped purge only delays cleanup, it does not affect correctness.
