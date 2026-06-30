# ADR-0158: OSS Git-Event Board Card Automation (Inbound Webhook Auto-Move)

## Status
Accepted — implemented on main; status corrected 2026-06-30 after ADR audit (verified: class BoardAutomation)

## Context

Issue #329 (VoC board wishlist, 2026-05-04 panel). Alex (Scrum Master, 6) made an
explicit panel ask: *"Auto-move on PR merge is great; auto-recompute commitments is
dangerous."* Priya (6) — "saves a click." The request is narrow and deliberate: when a
Git event arrives for a task that already carries a linked PR/MR (via the #637
git-aware-task link layer, ADR-0049), auto-transition that card's status — **PR opened →
`REVIEW`; PR/MR merged → `COMPLETE`** — and nothing else. This is explicitly **not** a
rules engine; arbitrary trigger/action rules, sprint-scope changes, and time-tracking
automation are out of scope indefinitely (Alex's "auto-recompute is dangerous" line is
the guardrail).

**P3M layer:** Programs and Projects (single-project board automation). A Scrum Master /
team needs this to run their board; it is not cross-program coordination or org
governance.

### The boundary force (the hard part)

ADR-0049 §"webhook ingest" set the default: *"Webhook ingest (PR merged → task closed) →
New Enterprise app, separate URL prefix, separate Celery queue."* Taken literally, #329 —
the exact PR-merged→card example — would be Enterprise. But two subsequent ADRs
established that **narrow, single-purpose inbound ingest is carved into OSS** against that
default, case by case:

- **ADR-0148** (Inbound CI Acceptance-Result Ingestion, #1075, merged OSS) — a narrow,
  token-authenticated, idempotent, throttled inbound endpoint that mutates one field
  (`AcceptanceCriterion.met`). Its docstring draws the line: *"The general multi-provider
  bidirectional ingest hub remains Enterprise."*
- **ADR-0097** codes the **Enterprise** integration bundle as the *full* durable two-way
  machinery: org-admin-configured connectors, bidirectional sync workers, OAuth app
  registration, conflict resolution, reconciliation loops, per-tenant rate budgets,
  audit trail.

The `enterprise-check` verdict (2026-06-20) placed #329 **OSS**, mirroring ADR-0148's
narrowness: #329 has **none** of the Enterprise bundle's markers — no bidirectional sync,
no OAuth, no org connector configuration, no conflict resolution, no reconciliation loop,
no per-tenant rate budgets, no new immutable audit trail. It is one project-scoped
endpoint that maps one inbound event to one forward-only status write, off by default.
This ADR is the explicit, narrow carve-out of ADR-0049's webhook-ingest reservation for
this single case — exactly the precedent ADR-0148 set, and no broader.

## Decision

Ship a **single-purpose, per-project, off-by-default inbound Git-event receiver** in the
existing OSS `apps/integrations` app. It verifies a per-provider signature, matches the
incoming PR/MR URL to an existing `TaskLink`, and applies a **forward-only** card status
transition through the **existing** `TaskSerializer` write path — no parallel transition
logic, no RBAC/WIP bypass.

### 1. Home: `apps/integrations` (one cold migration, no `projects` migration)

Everything lives in `apps/integrations`, which already owns `TaskLink`, the
`TASK_LINK_PROVIDERS` registry, and the GitHub/GitLab URL parsers
(`_parse_github_url`, `_parse_gitlab_url` in `providers.py`). This keeps the feature
cohesive in one app and adds exactly **one migration — `integrations/0005`** — avoiding
the contested `projects/0089` migration slot. Cross-app import `integrations → projects`
is already established (the `TaskLink.task` FK), so calling the projects serializer is
clean and one-directional.

### 2. Config model: `BoardAutomation` (plain `models.Model`, 1:1 Project)

```python
class BoardAutomation(models.Model):
    """Per-project Git-event card automation config (#329, ADR-0158).

    Plain models.Model (not VersionedModel) — like BoardColumnConfig and
    ApiTokenAuditEntry, this is project config, never synced to mobile offline.
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.OneToOneField("projects.Project", on_delete=models.CASCADE,
                                   related_name="git_automation")
    enabled = models.BooleanField(default=False)              # git_automation_enabled (AC1)
    secret_ciphertext = models.BinaryField()                  # Fernet(INTEGRATION_ENCRYPTION_KEY)
    secret_set_at = models.DateTimeField(null=True, blank=True)
    configured_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
                                      null=True, blank=True)   # accountable admin (request.user proxy)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
```

- **Off by default** (`enabled=False`) satisfies AC1.
- **Secret is Fernet-encrypted, not hashed.** GitLab signature = a direct `X-Gitlab-Token`
  compare; GitHub signature = `HMAC-SHA256(secret, body)`. Both require the *plaintext*
  secret at verification time, so a one-way SHA-256 hash (the `ApiToken` pattern) cannot be
  used. We reuse `IntegrationCredential`'s established at-rest pattern
  (`secret_ciphertext = BinaryField`, Fernet via `settings.INTEGRATION_ENCRYPTION_KEY`,
  helpers in `integrations/encryption.py`). The plaintext is shown once on rotation and
  never returned again.
- `configured_by` is the human who enabled automation; it becomes the accountable
  `request.user` for the status write (mirrors ADR-0148 using `token.created_by`), so RBAC
  and `django-simple-history` have a real user while the activity timeline still classifies
  the edit as automation (see §5).

### 3. Inbound receiver: `GitWebhookIngestView`

`POST /api/v1/integrations/projects/{project_id}/git-webhook/`

- **Auth = signature, not session.** `authentication_classes = []`, `permission_classes =
  [AllowAny]`; the per-provider signature *is* the gate. Provider auto-detected from
  headers: GitHub sends `X-GitHub-Event` + `X-Hub-Signature-256`; GitLab sends
  `X-Gitlab-Event` + `X-Gitlab-Token`.
- **Signature verification** (`integrations/git_webhook_auth.py`):
  - GitHub: `hmac.compare_digest("sha256=" + hmac_sha256(secret, raw_body),
    request.headers["X-Hub-Signature-256"])` — constant-time.
  - GitLab: `hmac.compare_digest(secret, request.headers["X-Gitlab-Token"])` — constant-time.
  - On failure → `401`, body never parsed. On `enabled=False` or no `BoardAutomation` →
    `404` (do not leak which projects have automation; matches `IsTokenForProject`'s
    enumeration-safe 401/404 posture).
- **Throttle:** new `GitWebhookThrottle` keyed on `project_id`, 120 req/min, fail-open on
  Redis error (mirrors `AcceptanceResultThrottle`).
- **Event filter:** only `pull_request` (GitHub: `action ∈ {opened, reopened, ready_for_review}` → `pr.opened`;
  `action == closed && merged == true` → `pr.merged`) and GitLab `merge_request`
  (`object_attributes.action ∈ {open, reopen}` → `pr.opened`; `action == merge` → `pr.merged`).
  Every other event → `200 {"matched": false, "ignored": "<event>"}` (a 2xx so the provider
  does not retry; ignoring an irrelevant event is not an error).

### 4. Matching + the forward-only transition service

New `apps/integrations/git_automation_services.py::apply_git_event_to_card(...)`:

1. Parse the webhook's PR/MR URL with the existing `_parse_github_url` /
   `_parse_gitlab_url` → `(owner/repo or path, ref)`.
2. Match a `TaskLink`: `TaskLink.objects.filter(provider=<p>, task__project_id=project_id,
   is_deleted=False)` then compare each candidate via the same parser (no normalized column
   exists; parse-and-compare on `.url`, bounded by the project scope so the set is small).
   No match → `200 {"matched": false}`.
3. **Forward-only guard** (the safety rail; decides *whether* to write, never bypasses the
   serializer):
   - `pr.opened` → target `REVIEW`, **only if** current status ∈
     `{BACKLOG, NOT_STARTED, IN_PROGRESS}`. Already `REVIEW`/`COMPLETE` → no-op (never moves
     a card backward).
   - `pr.merged` → target `COMPLETE`, **only if** current status ≠ `COMPLETE`. Already
     `COMPLETE` → no-op.
4. **Apply through the canonical path** — construct a synthetic DRF request with
   `request.user = board_automation.configured_by`, then
   `TaskSerializer(instance=task, data={"status": target}, partial=True,
   context={"request": req})`, `.is_valid(raise_exception=True)`, `.save()`. This reuses all
   existing validation. **WIP note:** WIP limits are advisory only (ADR-0039 — `annotate_wip_breach`
   surfaces `ok/at/over`, nothing hard-blocks a write), so going through the serializer
   inherently "won't bypass WIP-hard-limit" (AC) because no such hard block exists; we
   neither add nor circumvent one.
5. Set `history_change_reason = "git:pr_opened" | "git:pr_merged"` on the save so the
   ADR-0096 activity timeline classifies the edit as automation, not a human action.
6. Broadcast `task_updated` (see §6) deferred via `transaction.on_commit`.

### 5. Actor attribution

There is no sentinel "system" user and no system-actor enum in the codebase; the
established convention (ADR-0096 / ADR-0152, `TaskDurationChangeEvent`,
`ApiTokenAuditEntry`) is **nullable/real-user actor + `history_change_reason` tagging**.
#329 follows ADR-0148 exactly: `request.user = configured_by` (a real, accountable admin
for RBAC and history), paired with `history_change_reason = "git:pr_*"` so the unified
activity timeline (ADR-0096 `source` derivation) shows it as an automated move, and the WS
broadcast carries `actor_id=None` (ADR-0152 — system/automation write, suppresses
self-echo correctly for all clients).

### 6. WebSocket: reuse `task_updated` (no new event type)

A card move **is** a task update. We emit the existing ADR-0152
`broadcast_task_updated(project_id, task_id=…, changed_fields=["status"], version=…,
actor_id=None)`. No new WS event type → **no `FROZEN_WS_EVENT_TYPES` change and no
`websockets.md` change** required. Provenance ("this was a Git automation move") lives in
the activity timeline via `history_change_reason`, not in a bespoke WS event.

### 7. Config endpoint (project-admin only)

`PUT /api/v1/integrations/projects/{project_id}/git-automation/` (and `GET` to read
status; `POST .../rotate-secret/` to mint/rotate the webhook secret, returned once).
- `permission_classes = [IsAuthenticated, IsProjectAdmin]` (Owner/Admin only — this is
  board configuration that controls automated writes).
- `GET` returns `{enabled, secret_set: bool, webhook_url, configured_by, updated_at}` —
  never the secret.
- The web settings toggle UI is **deferred to a follow-up issue** (this MR is backend-first;
  the endpoints are fully usable via API per API-first).

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Narrow OSS receiver in `apps/integrations`, reuse `TaskSerializer`, Fernet secret, reuse `task_updated` (chosen)** | One cold migration; no parallel transition path; no new WS event; mirrors ADR-0148 precedent exactly; OSS-boundary-safe | Adds an inbound surface OSS didn't have before #1075; signature code is security-sensitive |
| B. Put it in `apps/projects` next to `BoardColumnConfig` | Config co-located with board config | Forces a contested `projects/0089` migration; splits webhook receiver away from the URL parsers it needs; less cohesive |
| C. Outbox + Celery worker for the transition | Survives broker blips | Over-engineered: the write is synchronous and fast; ADR-0148 set the synchronous precedent; adds a drain task and orphan-window complexity for no benefit |
| D. New bespoke `git_card_moved` WS event | Explicit provenance on the wire | Churns `FROZEN_WS_EVENT_TYPES` + `websockets.md`; duplicates `task_updated`; clients already handle `task_updated` |
| E. Defer to the Enterprise Integration Hub (ADR-0049 default) | Zero OSS work | Drops the one automation Alex explicitly asked for in 0.3; breaks the agile-cohort adoption ask; ADR-0148 already established the OSS carve-out lane |
| F. Store the secret as SHA-256 hash (ApiToken pattern) | Reuses a known pattern | **Wrong** — HMAC/token verification needs the plaintext; a one-way hash cannot verify a signature |

## Consequences

- **Easier:** A Scrum Master enables automation per project; merged PRs complete cards
  without a manual drag. The receiver reuses the URL parsers, the serializer, the broadcast,
  and the CPM-recalc path that already exist — minimal new surface.
- **Harder / risks:**
  - **Security-sensitive signature code.** Must be constant-time, must 401 before parsing
    on bad signature, must not leak project existence. Covered by `security-review` +
    `rbac-check` gates and explicit pytest (signature pass/fail/missing, wrong project).
  - **URL matching is parse-and-compare**, not an indexed normalized key. Bounded by project
    scope so the candidate set is tiny; if it ever becomes hot, a future migration can add a
    normalized `pr_key` column to `TaskLink` (out of scope here).
  - **Boundary creep is the real risk.** The day someone adds OAuth, bidirectional
    writeback to Git, conflict resolution, or a second trigger/action pair, this stops being
    the ADR-0148-style narrow carve-out and becomes the Enterprise Integration Hub. A
    boundary test asserts the receiver only ever writes `Task.status` forward and never calls
    out to a provider.

## Implementation Notes
- **P3M layer:** Programs and Projects (single-project board automation).
- **Affected packages:** api (`apps/integrations`, reusing `apps/projects` serializer +
  `apps/sync` broadcast). No scheduler/mobile/helm. Web deferred to follow-up.
- **Migration required:** yes — **`integrations/0005`** only (new `BoardAutomation` table).
  **No `projects` migration** (deliberate, to avoid the contested `projects/0089` slot).
- **API changes:** yes — `POST …/git-webhook/` (signature-auth inbound),
  `GET|PUT …/git-automation/`, `POST …/git-automation/rotate-secret/` (project-admin).
- **OSS or Enterprise:** **OSS** (`trueppm-suite`), as the narrow ADR-0148-style carve-out
  of ADR-0049's webhook-ingest reservation. The general multi-provider bidirectional
  Integration Hub remains Enterprise.

### Durable Execution
1. **Broker-down behaviour:** The core write is **synchronous** (verify → match → guard →
   `TaskSerializer.save()` inside `ATOMIC_REQUESTS`) — committed to PostgreSQL regardless of
   broker state, exactly as ADR-0148. The only async side effect is downstream CPM recalc,
   which is triggered by the existing `task_status_changed` / `Task.save` path and goes
   through `scheduling/services.py::enqueue_recalculate` (the existing transactional outbox)
   — **reused, not new**. The WS broadcast is best-effort `on_commit` (swallowed on failure,
   per ADR-0091/0148).
2. **Drain task:** None new. CPM recalc reuses the existing scheduling outbox drain; no new
   category of async work is introduced.
3. **Orphan window:** N/A — synchronous handler, no new outbox row to race a commit.
4. **Service layer:** new `integrations/git_automation_services.py::apply_git_event_to_card`
   for matching + forward-only guard; CPM dispatch stays behind the existing
   `enqueue_recalculate`. The status write goes through the canonical `TaskSerializer`, not a
   parallel path.
5. **API response on best-effort dispatch:** Synchronous **`200`**
   `{"matched": bool, "moved": bool, "task": <id|null>, "from": <status|null>,
   "to": <status|null>, "reason": "<opened_review|merged_complete|noop_*|no_link|ignored>"}`.
   Not `202` (nothing is queued). A non-2xx would make the provider retry, so "received,
   nothing to do" returns `200`.
6. **Outbox cleanup:** N/A — no new outbox. The Redis dedup keys (§7 below) auto-expire on a
   1-hour TTL.
7. **Idempotency:** Providers redeliver. Dedup via Redis `SET NX EX`
   (`gitwebhook:{project_id}:{delivery_key}`, 1-hour TTL) — `delivery_key` =
   `X-GitHub-Delivery` (GitHub) or `(object_kind, object_attributes.id, action)` (GitLab,
   which has no delivery header). A repeat key → `200 {"moved": false, "reason":
   "duplicate"}`. `IdempotencyKey` (the HTTP idempotency model) is **not** reusable here — it
   is user-scoped and inbound webhooks have no `request.user`. The forward-only guard is a
   second, independent idempotency layer: re-delivering a merge for an already-`COMPLETE`
   card is a no-op even if Redis is down (fail-open).
8. **Dead-letter / failure handling:** No retry/DLQ in TruePPM — the provider owns retry.
   Bad signature → `401`. Unknown/unlinked PR → `200 {"matched": false}` (normal: PRs for
   tasks without a link are expected). Malformed payload → `400`. Permanent failure surfaces
   to the operator as a non-2xx in their Git provider's webhook delivery log; no TruePPM-side
   queue accrues.
