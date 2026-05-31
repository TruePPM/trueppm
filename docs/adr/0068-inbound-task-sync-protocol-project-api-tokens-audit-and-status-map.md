# ADR-0068: Inbound Task-Sync Protocol — Project API Tokens, Audit, and Status Map

## Status
Accepted

## Context

Closes Gap 3 of ADR-0065 (Hybrid Bridge v1.1). Teams using Jira, Linear, or GitHub
Issues need a lightweight authenticated path to push tasks into TruePPM without
double entry. ADR-0049 defines outbound webhook extension points; no inbound push
protocol exists today. ADR-0065 sketches the endpoint shape, model fields, and a
default status map; this ADR fills in the gaps that VoC and threat-modeling
surfaced.

**P3M layer**: Operations / Programs and Projects — single project, no aggregation
across projects. The strongest VoC adoption signal sits with Priya (Team Member,
7/10 🟢) and Jordan (Product Owner, 6/10 🟢) — both Operations-layer personas.
Marcus (PMO) and Janet (COO) scored low because this is contributor plumbing, not
an executive surface; that signal correctly places the feature in OSS.

**VoC 🟡 items folded into the design**:
1. **Token governance gap (Marcus + Morgan)** — no audit on mint/revoke/use; no
   team-visible signal when a token is created.
2. **Pending-assignee queue invisible (Sarah)** — PM has no triage signal when
   imports land waiting for member onboarding.
3. **Bulk-import path (Jordan)** — 100 req/min would choke a 2000-ticket Jira
   backfill.
4. **Status_map portfolio drift (Marcus)** — per-token override without an
   org/portfolio default makes cross-project status roll-up incomparable.
   Documented as a known limitation; portfolio-default is deferred to Enterprise.
5. **Sprint landing (Alex + Morgan)** — v1 lands all imports in `BACKLOG`;
   sprint-binding from an external source is a future ADR.

**Infrastructure context** (from research):
- No existing custom DRF authentication classes — only JWT + Session.
- No rate-limiting infrastructure (`CACHES` not configured; no DRF throttle
  classes). Valkey is reachable via `REDIS_URL`.
- No dedicated audit-log model. `django-simple-history` provides field-level
  diffs on `Task`; `history_record_created` signal exposes a hook.
- No notification primitive. ADR-0049 defines `apps/notifications/` but it is
  not implemented yet.
- `broadcast_board_event()` + `enqueue_recalculate()` are the established
  patterns to wire on every task mutation; both must fire via
  `transaction.on_commit()`.

## Decision

### 1. Endpoint shape — confirms ADR-0065 with two refinements

```
POST /api/v1/projects/{project_id}/task-sync/
Authorization: Bearer <raw token>
X-Source: jira | linear | github | custom   # propagates into the outbound webhook
Content-Type: application/json

{
  "source": "jira",
  "external_id": "PROJ-123",
  "name": "...",
  "description": "...",
  "assignee_email": "...",
  "story_points": 3,
  "external_url": "https://...",
  "parent_external_id": "PROJ-001"     # optional
}

→ 201 {"task_id": "...", "short_id": "0000007B", "created": true|false,
       "assignee_resolved": true|false}
```

**Refinement A (write-through vs write-once)**: On upsert match, the endpoint
writes through `name`, `description`, `story_points`, `external_url`, and
`status` (after status-map translation). It does **not** rewrite `project`,
`source`, `external_id`, `assignee` (unless previously unresolved), or
`parent_external_id` once the link row exists. `assignee` is set only on
**resolve**: if the link row's `pending_assignee_email` was set and the new
push's `assignee_email` matches a project member, the assignee is filled in.
This prevents a compromised token from rewriting human-edited ownership.

**Refinement B (`assignee_resolved` in response)**: surface whether the
incoming `assignee_email` mapped to a project member so the caller (which
likely speaks to a human script author) can take action.

### 2. `ProjectApiToken` — hash, prefix, and lookup

```python
class ProjectApiToken(VersionedModel):
    project = FK(Project, on_delete=CASCADE, related_name="api_tokens")
    name = CharField(max_length=128)
    token_prefix = CharField(max_length=8, db_index=True)   # first 8 chars of the raw token
    token_hash = CharField(max_length=64, unique=True)      # SHA-256 hex of the raw token
    status_map = JSONField(default=dict)                    # source-status → TaskStatus
    created_by = FK(User, on_delete=SET_NULL, null=True)
    created_at = DateTimeField(auto_now_add=True)
    last_used_at = DateTimeField(null=True)
    revoked_at = DateTimeField(null=True)

    class Meta:
        db_table = "projects_api_token"
        indexes = [
            models.Index(fields=["project", "revoked_at"]),
        ]
```

- **Hash**: SHA-256 (single-shot, no per-row salt). The raw token is 256 bits of
  cryptographic randomness from `secrets.token_hex(32)`; collision and
  brute-force are not credible threats at this entropy, so a slow hash (Argon2,
  bcrypt) adds cost without buying security. Lookup is constant-time:
  `ProjectApiToken.objects.filter(token_hash=sha256(raw_token).hexdigest(),
  revoked_at__isnull=True)`. The hash uniqueness index makes lookup O(1).
- **Prefix**: first 8 hex chars of the raw token, stored separately. Used in
  audit-log entries and error responses so an operator can identify which token
  was used without revealing it (`tppm_a1b2c3d4...` in logs).
- **Constant-time compare** is unnecessary because the hash is the lookup key,
  not a compare target — the DB does the index lookup, and a non-match returns
  no row. Timing leaks only the hashing time, which is fixed.
- **Token format on creation**: `tppm_<64-hex-chars>` (prefix `tppm_` makes it
  greppable in client code and log scrubbers). The `tppm_` prefix is **not**
  stored in `token_prefix` — only the random part counts. Total length 69 chars.
- **No partial UNIQUE on `(project, name)`** — a project can have multiple
  tokens with the same human-readable name (e.g. "Jira Production" rotated
  twice). Distinguish by `token_prefix` in UI/audit.

### 3. `InboundTaskLink` — confirms ADR-0065 with minor field clarification

```python
class InboundTaskLink(VersionedModel):
    project = FK(Project, on_delete=CASCADE, related_name="inbound_links")
    task = FK(Task, on_delete=CASCADE, related_name="inbound_links")
    source = CharField(max_length=32)                       # "jira", "linear", "github", "custom"
    external_id = CharField(max_length=255)
    external_url = URLField(max_length=2000, null=True, blank=True)
    parent_external_id = CharField(max_length=255, null=True, blank=True)
    pending_assignee_email = EmailField(null=True, blank=True)
    created_via_token = FK(ProjectApiToken, on_delete=SET_NULL, null=True)
    last_synced_at = DateTimeField(auto_now=True)
    last_synced_via_token = FK(ProjectApiToken, on_delete=SET_NULL, null=True,
                               related_name="+")

    class Meta:
        db_table = "projects_inbound_task_link"
        constraints = [
            models.UniqueConstraint(
                fields=["project", "source", "external_id"],
                condition=models.Q(is_deleted=False),
                name="uniq_inbound_link_per_source",
            ),
        ]
        indexes = [
            models.Index(fields=["project", "pending_assignee_email"]),
        ]
```

- **Partial UNIQUE on `is_deleted=False`** — matches the soft-delete cascade
  from `Task.soft_delete()`. A re-push of the same external_id after the task
  is soft-deleted creates a new link + new task; the historical link row is
  preserved for audit.
- **`created_via_token` + `last_synced_via_token`** — token-of-origin for
  audit. Both `SET_NULL` so a token deletion doesn't cascade-delete the link.
- **Partial index on `pending_assignee_email`** — directly powers the
  "unresolved assignee count" PM signal (VoC 🟡 #2).
- **`InboundTaskLink` is itself a `VersionedModel`** so soft-delete is
  available; mobile sync of the link is not required (Task carries everything
  the contributor needs).

### 4. Rate limiting — Redis-backed, per-project, with a backfill window

Configure `CACHES` to use `django-redis` against `REDIS_URL` (currently
unconfigured — adds a settings dependency). Implement a custom DRF throttle:

```python
class TaskSyncThrottle(BaseThrottle):
    """Per-project rate limit, Redis-backed via Valkey.

    100 req/min steady-state; 1000 req/min for the first 60 minutes after
    the token's first successful use (the 'backfill window'). Resolves
    Jordan's bulk-import 🟡 — a 2000-ticket Jira backfill chunks to
    1000-req chunks for the first hour, then drops to 100/min steady-state.
    """
    def allow_request(self, request, view):
        token = getattr(request, "auth", None)  # ProjectApiToken set by authenticator
        if token is None:
            return True  # not our endpoint
        bucket_key = f"rate:task_sync:{token.project_id}"
        limit = 100
        if token.last_used_at and (now() - token.last_used_at) < timedelta(minutes=60):
            limit = 1000  # backfill window — first hour of token activity
        ...
```

- **Per-project**, not per-token, to prevent a multi-token-mint workaround.
- **Bucket key in Valkey** with `INCR` + `EXPIRE 60` — survives multi-worker
  Helm scale-out (settles all the LocMemCache concerns the infra scan
  surfaced).
- **Token-issuance endpoint** (`POST /api-tokens/`) gets a separate stricter
  throttle: `5 req/min` per user. Admin/PM scope is no defense against a
  scripted attacker who has compromised an admin's session.

### 5. Audit log — minimal model for SOC 2 evidence + history hook for task writes

```python
class ApiTokenAuditEntry(models.Model):
    """Append-only audit log for project API token lifecycle and use.

    Marcus + Morgan VoC 🟡 — every token mint/revoke/status_map_change/use is
    queryable for the auditor and for the team that owns the project.
    """
    id = UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = FK(Project, on_delete=CASCADE, related_name="api_token_audit")
    token = FK(ProjectApiToken, on_delete=SET_NULL, null=True)
    token_prefix = CharField(max_length=8)  # carried even after token deletion
    actor = FK(User, on_delete=SET_NULL, null=True)  # NULL for inbound uses (no Django user)
    action = CharField(max_length=32)  # "minted" | "revoked" | "status_map_changed" | "used"
    source_ip = GenericIPAddressField(null=True)
    detail = JSONField(default=dict)  # e.g. {"status_map_diff": {...}, "external_id": "PROJ-123"}
    created_at = DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "projects_api_token_audit"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["project", "-created_at"]),
        ]
```

- Append-only by convention (no UPDATE/DELETE views; soft-delete not used).
- A single `"used"` entry per inbound sync request, written **inside** the
  same DB transaction as the task upsert. `source_ip` from
  `request.META["REMOTE_ADDR"]` (X-Forwarded-For via existing middleware if
  present).
- `token_prefix` is carried on the entry so the token can be identified after
  it is deleted (FK is `SET_NULL`).
- **Task-level history** continues via `django-simple-history`. The custom
  authenticator sets `request.user = token.created_by` (the original token
  creator) so historical rows attribute changes to a real Django user. An
  `X-Source` header value (`jira` / `linear` / `github`) propagates to the
  outbound webhook payload's `source` field per ADR-0065 addendum.
- **Status-map changes** require re-issuance. To prevent a quiet remap of
  `"done"` to `"BACKLOG"` (Morgan's 🟡 #1 specific concern), changing the
  `status_map` on an existing token is **not allowed** — a status-map change
  is a new token, and revoking the old one is the team-visible signal.

### 6. Member-visible notification — defer to ADR-0049's notifications app

ADR-0049 specifies the right primitive (`apps/notifications/`) for
member-visible notifications on token lifecycle. The research confirmed it
is not yet implemented. Rather than build it as a side-quest in this ADR,
the team-visible signal in v1 is:

1. **Audit log is readable by all project members** via
   `GET /projects/{id}/api-token-audit/` (Viewer+ read; Admin/PM write via
   the token CRUD endpoints). This satisfies Morgan's 🟡 #1 ("team can see
   that a token exists and when it ran") without needing the notifications
   app.
2. **Real-time broadcast** of token mint/revoke fires
   `broadcast_board_event(project_id, "api_token_minted" | "api_token_revoked",
   {"token_prefix": ..., "name": ...})` inside `transaction.on_commit()` so
   live UI surfaces (when they exist) can react.
3. **Push notifications** to members (in-app or email) are explicitly
   deferred to the notifications-app implementation under ADR-0049.

### 7. Pending-assignee surface — count on the project detail response

Add a single computed field to `ProjectSerializer` (detail view only, not list):

```python
unresolved_assignee_count = serializers.SerializerMethodField()

def get_unresolved_assignee_count(self, obj):
    return InboundTaskLink.objects.filter(
        project=obj, is_deleted=False,
        pending_assignee_email__isnull=False,
    ).count()
```

The partial index `(project, pending_assignee_email)` makes this O(log n).
For projects with no inbound sync configured the index is empty and the
count is zero. Sarah's PM-visible signal is satisfied with one number on the
project page; a full triage UI is deferred to follow-up.

### 8. Bulk-import path — backfill window + chunking recipe in docs

The 1000 req/min backfill window in §4 handles the common case (2000-ticket
Jira project imported once, then incremental updates at 100/min).
`docs/integrations/inbound-sync.md` documents a chunked-backfill recipe:

```bash
# Chunk a 2000-ticket export into 1000-ticket batches with 60s pauses.
for batch in batch_1.jsonl batch_2.jsonl; do
  while read line; do
    curl -X POST "${API}/projects/${PROJ}/task-sync/" \
      -H "Authorization: Bearer ${TPPM_TOKEN}" -H "X-Source: jira" \
      -d "$line"
  done < "$batch"
  sleep 60
done
```

### 9. Status-map portfolio drift — documented limitation

A portfolio-default `status_map` shared across projects is a PMO governance
concern (Marcus is the buyer). It belongs in Enterprise via the
extension-point ADR-0029 slot pattern — Enterprise can register a
`DEFAULT_STATUS_MAP_REGISTRY` and the OSS endpoint will consult it before
falling back to the per-token map. Documented in `docs/integrations/
inbound-sync.md` as a known limitation with the workaround (manually
standardize `status_map` JSON across projects until Enterprise ships the
portfolio default).

### 10. Sprint landing — BACKLOG only, future ADR for sprint binding

All inbound tasks land with `status` from the status_map (default `BACKLOG`
when no match) and `sprint=NULL`. Binding inbound tasks to a sprint from a
`sprint_external_id` field on the payload is deferred; it requires a
companion `InboundSprintLink` model and is a future ADR after the
first-class Sprint entity (#482) stabilizes. Alex's 🟡 #1 is explicitly
deferred — documented in the ADR consequences below.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A: OAuth handshake per source** (full Jira/Linear/GitHub apps) | Bidirectional sync possible; no copy-paste tokens | Forces TruePPM to host OAuth callbacks for every source; multi-quarter scope; Enterprise problem, not OSS |
| **B: HMAC signature per request** (no DB-stored token, secret in env) | No token storage; revocation by env rotation | No per-source/per-project granularity; no audit trail; can't revoke a single integration without rotating all of them |
| **C: Reuse `Webhook.secret` field** (the outbound webhooks model) | Existing pattern; no new model | Outbound `Webhook` is project-scoped but conflates URL endpoint + signing secret; inbound is the opposite direction (we don't have a URL to call) |
| **D: chosen** — `ProjectApiToken` + audit + custom auth class | Smallest delta to existing patterns; SHA-256 lookup is O(1); per-project audit and revocation; backfill window resolves Jordan's 🟡 | New model + new auth class + new throttle + new audit table; touches `CACHES` settings to enable Redis-backed throttling |

## Consequences

**Easier**:
- Priya never opens TruePPM; her Linear tickets land in BACKLOG and roll up
  into Sarah's burn-up automatically.
- Jordan's epic→story hierarchy survives the trip via `parent_external_id`
  matching.
- SOC 2 evidence for token lifecycle is queryable from day one (the
  `ApiTokenAuditEntry` table); auditor can pull a per-project CSV without
  log-mining.
- Backfill window (1000 req/min for the first hour) means a 2000-ticket Jira
  project imports in ~2 minutes instead of 20.
- Adds the first DRF rate-limiting wire and the first Valkey-backed `CACHES`
  setting; both unlock future throttle work (login, schema export, etc.).

**Harder**:
- Adds the first custom DRF `BaseAuthentication` subclass to the codebase;
  future contributors will copy this pattern for any new bearer-token surface.
- No portfolio-wide token visibility from the OSS API — Marcus must query
  per-project. The Enterprise `GET /admin/api-tokens/` aggregator is the
  resolution; documented as a known limitation.
- Status-map drift across projects is a real risk; mitigated by docs and the
  audit log (an auditor or Marcus can see which projects diverged).

**Risks**:
- Token leakage via client-side commits (e.g., a `.env` checked into a public
  repo) — out of scope to prevent, but the `tppm_` prefix is greppable so
  secret-scanners (GitGuardian, GitHub secret scanning) can detect it. We
  will submit the prefix pattern to GitHub's secret-scanning partner program
  in a follow-up (`docs/security/secret-scanning.md`).
- Cache misconfiguration — if `CACHES` falls back to LocMemCache (e.g., a
  Helm upgrade drops `REDIS_URL`), throttling silently becomes per-worker
  instead of per-project. The new `make pre-push` lint should check for
  `LocMemCache` in production settings.
- Rate-limit bypass via project-mint (attacker creates 100 projects, mints
  one token per project). Mitigated by the 5 req/min per-user throttle on
  the token-issuance endpoint and by `IsProjectAdmin` on project creation.

## Implementation Notes

- **P3M layer**: Operations / Programs and Projects (single project, no
  cross-project aggregation).
- **Affected packages**: `api` (new model, view, auth class, throttle, audit
  model, migration, settings change), `helm` (Helm `REDIS_URL` already wired;
  `CACHES` will read from it via settings change — no chart change required),
  `website` (`docs/integrations/inbound-sync.md`, `docs/api/`).
- **Migration required**: yes — `projects/migrations/0034_*` adds
  `ProjectApiToken`, `InboundTaskLink`, `ApiTokenAuditEntry`. Metadata-only
  for existing rows (all three are net-new tables).
- **API changes**: yes —
  - `POST /api/v1/projects/{id}/task-sync/` (new, token-auth)
  - `GET /api/v1/projects/{id}/api-tokens/` (Admin/PM)
  - `POST /api/v1/projects/{id}/api-tokens/` (Admin/PM; returns raw token once)
  - `DELETE /api/v1/projects/{id}/api-tokens/{token_id}/` (Admin/PM)
  - `GET /api/v1/projects/{id}/api-token-audit/` (any member, Viewer+)
  - `unresolved_assignee_count` field on the project detail response (additive)
- **OSS or Enterprise**: OSS. Apache 2.0 boundary clean —
  `grep -r "trueppm_enterprise" packages/` confirms zero. Portfolio-wide
  token aggregation and OAuth/two-way sync are Enterprise (ADR-0049 already
  states this).

### Durable Execution

1. **Broker-down behaviour**: **N/A** for the inbound upsert itself — the
   request is synchronous (small payload, bounded work, caller expects 201).
   CPM recompute triggered by the upsert goes through the existing
   `enqueue_recalculate()` outbox pattern in `scheduling/services.py`.
2. **Drain task**: reuses existing `drain-schedule-queue` (every 30s) for
   CPM and existing `drain-webhook-queue` for outbound webhook delivery.
   No new drain.
3. **Orphan window**: 10 minutes (existing `ScheduleRequest` filter) applies
   to CPM dispatch from inbound upsert. No new window.
4. **Service layer**: `scheduling/services.py::enqueue_recalculate(project_id,
   reason=ScheduleRequestReason.TASK_CHANGE, changed_task_ids={task.id})`.
   Direct `.delay()` from the inbound view is forbidden, per ADR-0027.
   Outbound webhook dispatch goes through existing
   `webhooks/dispatch.py::dispatch_webhooks(project_id, "task.created"|
   "task.updated", payload)`.
5. **API response**: `201 {"task_id": ..., "short_id": ..., "created":
   true|false, "assignee_resolved": true|false}` — synchronous (no
   `{"queued": true}` 202 pattern). CPM recompute kicks off as a background
   side-effect; the caller does not need to poll for it.
6. **Outbox cleanup**: existing `ScheduleRequest` purge (7-day retention)
   applies; no new purge. `ApiTokenAuditEntry` is intentionally **not**
   purged — compliance evidence has indefinite retention, governed by
   product/legal at the org level (Enterprise concern).
7. **Idempotency**: idempotent by `(project, source, external_id)` partial
   unique constraint on `InboundTaskLink`. Duplicate pushes update the
   existing task; the `created` flag in the response tells the caller which
   path was taken. CPM recompute is idempotent per ADR-0017 (the
   `enqueue_recalculate` outbox row coalesces multiple requests).
8. **Dead-letter / failure handling**: an inbound request that hits any
   ValidationError (bad payload, unknown status, parent_external_id with
   no matching link) returns `400` with a structured error — no retry on
   the server side; the caller decides whether to retry. Token-auth
   failures return `401` with no body detail (defense against enumeration).
   Rate-limit hits return `429` with `Retry-After` header per RFC 6585.

## References

- ADR-0065 — Hybrid Bridge v1.1 (this ADR closes Gap 3)
- ADR-0049 — External Integration Extension Points (notifications app,
  outbound webhooks, OSS/Enterprise boundary)
- ADR-0019 — Outbound Webhooks (HMAC signing, retry policy, dispatch pattern)
- ADR-0027 — Incremental CPM Recompute (`enqueue_recalculate` pattern)
- ADR-0011 — Object Change History (`django-simple-history` integration,
  `_history_user` attribution)
- ADR-0029 — Frontend Slot Registry and Edition Detection (extension
  points for the Enterprise portfolio aggregator)

## Tracking

Tracking (follow-up): the full triage UI and push notifications (via ADR-0049) are
deferred — not yet filed.
