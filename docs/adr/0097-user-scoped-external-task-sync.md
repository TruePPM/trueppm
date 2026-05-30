# ADR-0097: User-Scoped Read-Only External Task Sync (Personal Pull)

## Status
Proposed — threat model complete (see §Threat Model → Resolution, 2026-05-30); awaiting acceptance decision.

## Related issues

- **#484** — "My Work" view (contributor task list, zero PM vocabulary). The surface this feature attaches to.
- **#627** — one-time Jira → TruePPM importer. Distinct from this (batch create-into-project vs. live personal read-only pull).
- **#624** — Epic: multi-format importers.
- **First agile-cohort cut epic** — Priya retention layer; this ADR unblocks the OSS Jira-sync line on that cut.

## Related ADRs

- **ADR-0049** — External Integration Extension Points (`ProviderRegistry`, `IntegrationCredential`, `TaskLink`). This ADR reuses its credential store and registry *pattern*, and **narrowly refines** its classification of `jira` (see Decision §1).
- **ADR-0068** — Inbound Task-Sync Protocol (machine `ApiToken` push → `InboundTaskLink` + canonical `Task`). This ADR is the *personal-pull* counterpart and deliberately does **not** reuse that pipeline (see Decision §2).
- **ADR-0076** — Integration Management Surface Boundary (workspace Hub = Enterprise; OSS gets project/program + `User → Settings → Connected Accounts`). This ADR fills the personal "Connected Accounts" surface ADR-0076 anticipated.
- **ADR-0017/0018/0019/0080** — Celery hardening, idempotent tasks, outbox, durable workflows. The pull task follows the canonical outbox shape.

## Context

**P3M layer:** Operations (a contributor / team member). This is the lowest layer and the adoption leading indicator.

**Why this is being built.** Priya (the team-member persona) already lives in Jira and will not double-enter status into TruePPM. Her non-use is not a minor gap — when contributors don't keep their work current, the data layer rots and every roll-up above them (the PM's schedule, PMO dashboards) becomes unreliable. Contributor adoption is the leading indicator of whether the tool sticks in a team, so removing the double-entry objection is a priority for the agile-cohort adoption path.

**The boundary question.** CLAUDE.md classifies the Integration Hub (Jira/GitLab/ServiceNow connectors) as Enterprise, and ADR-0049 §3 reserved `jira` as an Enterprise provider key in `TASK_LINK_PROVIDERS`. The `enterprise-check` verdict (2026-05-30) resolved the tension as a basic-vs-governance split:

- **OSS basic** — user connects their *own* Jira (personal token), one-way Jira→TruePPM, read-only, surfaced in My Work, no writeback.
- **Enterprise governance (unchanged)** — org-admin-configured connectors, bidirectional sync workers, OAuth app registration, conflict resolution, webhook ingest with HMAC/replay, reconciliation, per-tenant rate budgets, audit trail.

**What already exists (from the codebase scan).** The architecture is largely in place:

- `IntegrationCredential` (`apps/integrations/models.py`) — per-user, per-provider, Fernet-encrypted `secret_ciphertext`, `base_url`, never serialized to clients. Exactly the personal-credential store needed.
- `ProviderRegistry` (`apps/integrations/registry.py`) — the OSS-defined extension point; OSS registers in its `AppConfig.ready()`, Enterprise registers in *its own* `AppConfig.ready()` against the same registry, no `trueppm_enterprise` import in OSS (boundary verified clean: zero functional imports).
- `MeWorkView` / `GET /api/v1/me/work/` (`apps/projects/views.py`) — already self-scoped to `assignee=request.user`; the My Work surface. Today it exposes **no** external-link data.
- Outbox + Beat drain + `@idempotent_task` — the canonical durable-dispatch pattern (`scheduling/services.py::enqueue_recalculate`, `SprintCloseRequest`).
- `InboundTaskLink` (`apps/projects/models.py`) — project-scoped, written by a machine `ApiToken` on behalf of a *project's* integration. Creates canonical `Task` rows that join CPM.

The forces: (1) preserve the Apache-2.0 boundary without giving away the Enterprise Hub; (2) do not force the project-mapping decision (which Jira project → which TruePPM project) into OSS — that mapping *is* the org-governance surface; (3) keep it genuinely read-only so there is no writeback / conflict-resolution machinery (the reserved-Enterprise part); (4) degrade gracefully offline.

## Decision

### 1. A new OSS extension point: `EXTERNAL_TASK_SOURCES`

Define a new `ProviderRegistry` instance, `EXTERNAL_TASK_SOURCES`, distinct from `TASK_LINK_PROVIDERS`. The two solve different problems and must not collide:

- `TASK_LINK_PROVIDERS` (ADR-0049) — "paste a URL on a task, fetch its status" (git-aware tasks). `jira` stays reserved Enterprise *here*.
- `EXTERNAL_TASK_SOURCES` (this ADR) — "pull the issues assigned to *me* from my personal account into My Work." OSS owns `jira` **here**, narrowly, for read-only personal pull.

The ABC (the entire stable cross-repo surface):

```python
class ExternalTaskSource(ABC):
    key: ClassVar[str]            # "jira"
    label: ClassVar[str]          # "Jira"
    requires_credential: ClassVar[bool] = True

    @abstractmethod
    def fetch_assigned_items(self, *, credential, config) -> list[ExternalWorkItemDTO]:
        """Read-only. Return the items currently assigned to the credential's owner."""

    def verify_credential(self, *, credential, config) -> VerifyResult:
        return VerifyResult(ok=True, reason="unverified")  # additive default
```

OSS registers `jira` (and may add `github`) in `IntegrationsConfig.ready()`. Enterprise registers additional *sources* (`servicenow`, `azure_devops`) in its own `AppConfig.ready()`. Adding a source key is additive (non-breaking); renaming/removing a key or changing the ABC signature is a major-version bump. **The Enterprise bidirectional Integration Hub is an orthogonal subsystem — it does not register against this interface and is unaffected.** This is what makes the shape forward-stable for question 6.

This is an intentional, narrowly-scoped refinement of ADR-0049/0076: read-only *personal pull* of `jira` is OSS; the durable two-way org connector remains Enterprise. CLAUDE.md's "Integration hub = Enterprise" line gains a one-clause carve-out for personal read-only sources.

### 2. Data model: a per-user read-only cache — NOT `Task`, NOT `InboundTaskLink`

Pulled issues are surfaced as **read-only external work items in My Work, not as canonical TruePPM Tasks.** Rationale:

- `InboundTaskLink`/`Task` (ADR-0068) is *project-scoped* and creates canonical tasks that join CPM. Choosing which TruePPM project a personal Jira issue maps into is an org/admin decision — that is precisely the governance surface that belongs to the Enterprise Hub. Personal pull must not make that decision.
- Read-only display creates no Task → no writeback, no CPM participation, no conflict resolution. The boundary stays crisp.

New model `ExternalWorkItem` (`apps/integrations/models.py`):

| Field | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `user` | FK → AUTH_USER_MODEL (int PK), CASCADE | per-user scope; `related_name="external_work_items"` |
| `source` | CharField(32) | validated against `EXTERNAL_TASK_SOURCES.keys()` |
| `external_id` | CharField(255) | e.g. `PROJ-123` |
| `external_url` | URLField(2000) | |
| `title` | CharField(512) | |
| `external_status` | CharField(64) | raw status from source |
| `display_bucket` | CharField(12) | mapped via `DEFAULT_STATUS_MAP` to a TruePPM-ish bucket for grouping |
| `last_synced_at` | DateTimeField | staleness display |
| `is_stale` | BooleanField | set true when an item disappears from a successful pull (soft-remove) |

- **Plain `models.Model`, NOT `VersionedModel`** — it is a per-user cache, not project data, and must **not** enter the project WatermelonDB sync delta. (When mobile My Work lands at 1.0 and wants offline external items, a per-user delta can be added then; deliberately out of scope now.)
- **Invariant (test-enforced, not prose):** `ExternalWorkItem` never crosses the WebSocket broadcast or the project sync delta, and the pull can **never** mint a `Task`. This is the line that keeps the feature OSS-and-read-only; a regression test must assert it, because the day someone makes the model a `VersionedModel` "to get mobile offline," the boundary silently breaks. (Threat model: Information disclosure + EoP.)
- Unique constraint `(user, source, external_id)`.
- User PKs are **integers** (Django default `auth.User`, `BigAutoField`) — confirmed; FK is a bigint, not UUID.

Per-user connection config (which Jira site + filter): extend `IntegrationCredential` with `config = JSONField(default=dict)` holding `{"jql": "...", "project_keys": [...]}`. `base_url` already exists on the model. One row per `(user, provider)` is preserved.

### 3. Credentials & RBAC

- Reuse `IntegrationCredential` — Fernet `secret_ciphertext`, key from `settings.INTEGRATION_ENCRYPTION_KEY` (Helm-supplied K8s secret). Plaintext **never** serialized.
- **Strictly personal visibility.** The connection and its `ExternalWorkItem` rows are visible only to the owning user. No project member, Scheduler, Admin, or Owner can see another user's connection, token existence detail, or pulled items. The credential serializer exposes only `{provider, base_url, exists: true, last_synced_at, status}` to the owner. My Work is already `assignee=request.user`-scoped, so external items inherit that scoping for free.
- New endpoints, all `IsAuthenticated` and self-scoped:
  - `GET/PUT/DELETE /api/v1/me/connections/{source}/` — manage the personal connection.
  - `POST /api/v1/me/connections/{source}/sync/` — trigger a pull (returns `202 {"queued": true}`).
  - `GET /api/v1/me/work/` — augmented to include the user's `ExternalWorkItem` rows in a clearly-labeled external section (see §4 of Consequences).

### 4. Pull mechanism: on-demand + opt-in low-frequency poll, via the outbox

- **Primary:** user-triggered refresh (`POST .../sync/`) and an on-open refresh-if-stale when My Work loads.
- **Opt-in poll:** a low-frequency periodic pull (default off; opt-in per connection), drained on a 300 s Beat cadence — read-only pull is not latency-critical.
- Both go through a new `ExternalSyncRequest` outbox row + `transaction.on_commit()` dispatch + a `@idempotent_task(on_contention="skip")` worker + Beat drain. This is the canonical shape, **not** a continuous bidirectional reconciliation worker — that distinction (user-triggered/opt-in read-only pull vs. always-on two-way sync) is the line that keeps this OSS.
- **Rate-limiting:** a per-(user, source) cooldown (min 60 s between manual refreshes) enforced in the service layer, plus exponential backoff that respects Jira REST 429/`Retry-After`. No org-wide rate budget (that is the Enterprise per-tenant concern).
- **SSRF (v1 — Jira Cloud only):** `base_url` is user-supplied and drives server-side HTTP, so v1 **restricts `base_url` to a Jira Cloud host allow-list (`*.atlassian.net`), `https` only.** This removes essentially all SSRF surface for the launch audience (SaaS-team engineers on Jira Cloud). Self-hosted Jira Data Center is a **later, admin-gated, opt-in** addition that must carry the full guard (DNS-rebind resolve-and-pin, private/link-local/metadata range block, no internal redirects) and reuse ADR-0049's `TaskLink` SSRF guard rather than a second hand-rolled one. The threat model (§Threat Model → Resolution) makes the Cloud-only allow-list a hard launch requirement.
- **Bounded growth:** cap stored `ExternalWorkItem` rows at **500 per (user, source)** and the fetch at **5 pages**; surface a truncation note ("showing first 500 — narrow your JQL") rather than silently dropping. Caps are easy to raise later, impossible to retrofit.

### 5. Failure / offline behavior

- **Jira unreachable / 5xx:** keep last-good cached `ExternalWorkItem` rows; My Work shows them with a "Couldn't refresh — showing data from {last_synced_at}" staleness note. Retry with backoff; on exhaustion mark the `ExternalSyncRequest` FAILED and stop until next trigger.
- **Token expired/revoked (401/403):** set connection `status = "auth_failed"`, stop polling, surface a "Reconnect Jira" banner in My Work and Connected Accounts. No silent retry loop on auth failure.
- **Ticket deleted in Jira:** on the next *successful* full pull, items no longer returned are soft-removed (`is_stale = true`, hidden from My Work) rather than hard-deleted, so a transient partial response never wipes the list.
- **Offline (mobile, 1.0):** because items are cached in Postgres, My Work renders the last sync read-only; the design is offline-friendly by construction even though the mobile surface is deferred.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Per-user read-only cache + new `EXTERNAL_TASK_SOURCES` registry (chosen)** | Crisp boundary; no project-mapping decision; truly read-only; reuses credential store + outbox; Enterprise Hub untouched | One new model + one new registry + endpoints |
| B. Reuse `InboundTaskLink`/`Task` pull-into-project | Reuses `upsert_inbound_task`; items join CPM | Forces project-mapping (an org-governance decision) into OSS; creates canonical tasks from a personal token; blurs the Enterprise boundary; per-user vs project-scope mismatch |
| C. Register `jira` directly in `TASK_LINK_PROVIDERS` | No new registry | Collides with ADR-0049's Enterprise `jira` reservation; conflates "link status on a task" with "pull my assigned issues"; duplicate-key registration error if Enterprise also registers `jira` |
| D. Read-on-demand only, no persistence | Simplest; no model | No offline/staleness story; re-hits Jira every My Work load (rate-limit risk); no graceful degradation when Jira is down |
| E. Defer to Enterprise Hub entirely (status quo) | Zero OSS work | Leaves the contributor double-entry objection unresolved; breaks the adoption flywheel that the agile-cohort path depends on |

## Consequences

**Easier:**
- Priya sees her Jira work alongside her TruePPM tasks in one read-only place without double-entry → removes the contributor double-entry objection.
- The Enterprise Hub gets a clean, stable OSS extension point (`EXTERNAL_TASK_SOURCES`) to register richer sources against later, plus its bidirectional subsystem stays wholly separate.
- Reuses existing credential encryption, registry, outbox, and My Work surface — small net-new surface.

**Harder / risks:**
- A new credential trust boundary (personal external token + user-supplied `base_url`) → SSRF and at-rest handling must be right. **Threat model required before implementation** (see flag below).
- My Work must visually distinguish read-only external items from native TruePPM tasks so users don't expect to edit/schedule them. UX-design pass needed for that section.
- Status mapping (Jira workflow states → `display_bucket`) is inherently lossy; `DEFAULT_STATUS_MAP` reuse keeps it consistent with ADR-0068 but per-source overrides may be requested later.
- Scope discipline: this must not creep into writeback or auto-Task-creation, or it becomes the Enterprise bidirectional sync. The "read-only, personal, no Task" invariant is the boundary contract.

## Implementation Notes

- **P3M layer:** Operations (contributor).
- **Affected packages:** `api` (new `EXTERNAL_TASK_SOURCES` registry + `ExternalTaskSource` ABC + OSS `jira` source, new `ExternalWorkItem` model, `IntegrationCredential.config`, `ExternalSyncRequest` outbox, `integrations/services.py::enqueue_external_sync`, My Work serializer augmentation, `/me/connections/` endpoints), `web` (Connected Accounts settings entry + My Work external section). `mobile` deferred to 1.0.
- **Migration required:** yes — `ExternalWorkItem`, `ExternalSyncRequest`, `IntegrationCredential.config`. No destructive ops; all additive.
- **API changes:** yes — three new `/me/connections/` routes + My Work payload gains an external-items section.
- **OSS or Enterprise:** **OSS** (`trueppm-suite`). Enterprise registers additional sources + retains the bidirectional Hub.

### Durable Execution
1. **Broker-down behaviour:** transactional outbox. Write `ExternalSyncRequest` row inside `transaction.atomic()`; best-effort `external_sync.delay()` in `transaction.on_commit()`; broker errors swallowed, row stays PENDING for the drain.
2. **Drain task:** new Beat entry `drain-external-sync` every 300 s, `@idempotent_task(on_contention="skip")`. New (not reusing an existing drain) because the work is external read-only HTTP fetch with its own backoff/auth-failure semantics, unlike CPM/webhook/sprint drains.
3. **Orphan window:** drain filters PENDING rows older than 2 min to avoid racing in-flight `on_commit` callbacks (shorter than webhooks' 5 min — pull is idempotent and low-stakes).
4. **Service layer:** new `integrations/services.py::enqueue_external_sync(user_id, source, *, reason)`. Never call the task `.delay()` directly from the view.
5. **API response on best-effort dispatch:** `POST /me/connections/{source}/sync/` returns `202 {"queued": true}` — not a task id.
6. **Outbox cleanup:** nightly purge of COMPLETED/FAILED `ExternalSyncRequest` older than 7 days (existing retention convention); add `_do_purge` + Beat entry `purge-external-sync-requests`.
7. **Idempotency:** unique partial constraint on `(user, source) WHERE status = PENDING` → a second enqueue adopts the existing PENDING row (mirrors `enqueue_recalculate`). The worker `select_for_update`s the request row and upserts `ExternalWorkItem` by `(user, source, external_id)`, so a duplicate execution converges to the same cache state.
8. **Dead-letter / failure handling:** `max_retries` with exponential backoff for transient errors; on exhaustion the `ExternalSyncRequest` → FAILED and the user sees a staleness/reconnect prompt. **No DLQ** — read-only pull is user-recoverable and the last-good cache remains; silent discard after retry-exhaustion is acceptable and documented here precisely because no data is lost (the cache is unaffected and the user can re-trigger). Auth failures (401/403) short-circuit retries and flip the connection to `auth_failed`.

## Threat Model

This feature crosses a trust boundary (a personal external credential + user-controlled `base_url` driving server-side HTTP). A full STRIDE model was produced 2026-05-30; boundaries crossed are B1 (internet↔API), B2 (API↔DB), B3 (API↔Celery), B5 (OSS↔Enterprise extension), B6 (TruePPM↔Jira). **B4 (WS broadcast / sync delta) is a negative requirement** — `ExternalWorkItem` must never cross it (see §2 invariant).

Top risks: **(1) SSRF via user-supplied `base_url`** (High×High) — a worker fetching an arbitrary host could reach cloud metadata (`169.254.169.254`) or internal services; **(2) personal credential disclosure** (Med×High) — a leaked PAT compromises the user's *external* Jira; **(3) DoS / unbounded `ExternalWorkItem` growth** (Med×Med).

### Resolution (threat-model gate cleared, 2026-05-30)

The following are now **hard requirements on the implementation**, not open questions:

1. **SSRF — Jira Cloud allow-list for v1.** `base_url` restricted to `*.atlassian.net`, `https` only. Self-hosted Data Center is deferred to a later, admin-gated, opt-in release carrying the full DNS-rebind/private-range guard (reusing ADR-0049's `TaskLink` guard). *This single decision collapses Top Risk #1.* (SOC 2: **CC6.6**)
2. **Credential handling.** Fernet at rest; **never** serialized (endpoint returns only `{provider, base_url, exists, status, last_synced_at}`); **never** logged (scrub PAT + `Authorization` from worker logs and exception capture); owner-only delete hard-removes ciphertext; `401/403 → auth_failed`, stop using the token. (CC6.1 / CC6.2)
3. **Per-user isolation.** Every query filters `user_id=request.user.id`; no admin/Owner read path; `ExternalWorkItem` excluded from WS broadcast and sync delta (the §2 test-enforced invariant). (CC6.1)
4. **Untrusted input.** Treat extension-source DTOs and fetched `title`/`external_url` as untrusted: enforce field-length caps at the registry boundary; `external_url` scheme `https?:` only (block `javascript:`/`data:`); React escaping (no `dangerouslySetInnerHTML`); `rel="noopener noreferrer"`. (CC6.8)
5. **Bounded growth.** Per-user cooldown (≥60 s) + backoff honoring `Retry-After`; cap 500 items / 5 pages per (user, source) with a truncation note; nightly purge of stale items + completed outbox rows. (A1.1)
6. **Audit scope.** Connection-lifecycle events only (created / re-authed / auth_failed / deleted) with actor+timestamp. **No** per-item or per-sync-run logging (volume + confidentiality). (CC7.2)

**Verdict:** safe to build **provided requirement #1 (Cloud-only allow-list) ships in v1**, alongside #2–#6. SSRF is the one finding that, unaddressed, makes this a critical vulnerability rather than an adoption win.
