# ADR-0087: Workspace Entity, Membership, Groups, and Settings API

## Status
Accepted

## Context
TruePPM's settings shell (ADR-0061 pattern) ships three workspace-level pages —
**General**, **Members**, and **Groups & teams** — currently backed by frontend
stub hooks returning fixture data. Issues #517/#518/#519 wire them to a real API.

There is **no `Workspace` or `Group` model in the OSS codebase today.** This ADR
introduces the org-level *workspace* concept for the first time. TruePPM is
self-hosted single-tenant (ADR-0061: "all accounts are org-internal"), so the
workspace **is** the installation — a singleton config row, not a multi-tenant
parent. Multi-tenancy remains Enterprise.

Prior to this ADR, `IsOrgAdmin` (ADR-0034) approximated an org admin as "ADMIN+
on any project" because no first-class workspace-membership entity existed. This
ADR supersedes that approximation for workspace-scoped endpoints.

**P3M layer:** Programs and Projects / Operations support surface — workspace
config, membership, and team grouping that a single PM/team needs to run their
practice. This is the adoption unit (basic team management), **not** cross-program
or portfolio governance — so it is OSS. Cross-program/portfolio rollups, SSO/LDAP
sync, and audit trails remain Enterprise (ADR-0030, ADR-0076).

## Decision

### 1. New `trueppm_api.apps.workspace` app
One-app-per-domain. Registered in `LOCAL_APPS`.

### 2. `Workspace` singleton (config row)
Plain `models.Model` (no sync — config is not a mobile-offline entity) with a
`singleton_key` `PositiveSmallInteger` unique-constrained to `1` (ADR-0081
pattern). Lazily materialized via `get_or_create` on first GET (ADR-0079
`PhaseGateConfig` precedent) — **no data migration**. Fields: `name`,
`subdomain` (read-only to the API; defaults to `""` for self-hosted),
`timezone`, `fiscal_year_start`, `work_week` (`ArrayField` of 7 booleans,
Mon–Sun), `default_project_view`, `allow_guests`, `public_sharing`.

`GET /api/v1/workspace/` — any authenticated user. `PATCH` — workspace ADMIN+.

### 3. `WorkspaceMembership` + new `WorkspaceRole` enum
`WorkspaceRole` is a **new** `IntegerChoices`, deliberately separate from the
project `Role` (#518), using ADR-0072 100-unit bands so Enterprise can register
intermediate roles: `MEMBER=100`, `ADMIN=300`, `OWNER=400`. Write access gates
on `role >= WorkspaceRole.ADMIN`; OWNER carries the last-owner guard.

`WorkspaceMembership(VersionedModel)` mirrors `ProjectMembership` exactly
(standalone through-model for sync + direct permission queries): `workspace` FK,
`user` FK, `role`, `joined_at`, `role_changed_at`, plus a `status`
(`active | guest | deactivated`) `CharField` carrying account lifecycle — distinct
from permission tier. `unique_together = [("workspace", "user")]`.

Read-only display fields (`sso`, `two_fa`) are reported as `false` in OSS
(neither implemented in OSS; both are Enterprise). `last_active` derives from
`auth.User.last_login`. `project_count` is annotated from `ProjectMembership`.

`GET/PATCH/DELETE /api/v1/workspace/members/{id}/`, `GET /members/`. ADMIN+ for
list and writes; a non-admin member sees only their own row (`?self` semantics
folded into list). Last-OWNER guard on demote/deactivate/delete.

### 4. `WorkspaceInvite` — email + token acceptance
`WorkspaceInvite(models.Model)`: `email`, `role` (`WorkspaceRole`), `token_hash`
(SHA-256 of a `secrets.token_urlsafe(32)` raw token — raw token is emailed, never
stored), `invited_by` FK, `created_at`, `expires_at` (created_at + 7 days),
`status` (`pending | accepted | revoked | expired`), and outbox columns
(`email_pending`, `email_sent_at`, `email_attempts`, `email_failed_at`) mirroring
`Notification`.

- `POST /api/v1/workspace/invites/` (ADMIN+) — create pending row, set
  `email_pending=True`. Returns `201` with the row (raw token never returned).
- `GET /api/v1/workspace/invites/` (ADMIN+) — list pending invites.
- `DELETE /api/v1/workspace/invites/{id}/` (ADMIN+) — revoke (status→revoked).
- `POST /api/v1/workspace/invites/accept/` (**AllowAny**) — body `{token,
  username, password}`. Hashes token, looks up a non-expired pending invite,
  provisions a `User` (or links an existing one matching the invite email),
  creates the `WorkspaceMembership` at the invited role, marks invite accepted.
  Generic error on bad/expired token (no enumeration).

### 5. `Group` (workspace team) + project access **cascade**
`Group(VersionedModel)`: `name`, `description`, `lead` FK (nullable),
`members` via standalone `GroupMembership(VersionedModel)` through-model (sync +
metadata), `projects` via `GroupProject` through-model carrying the **granted
`Role`** the group confers on each project.

**Cascade (chosen scope):** adding a group to a project, adding a member to a
group, removing either, or changing the conferred role **synchronously
reconciles `ProjectMembership` rows** for all affected (group-member × project)
pairs inside the request transaction, then broadcasts `member_added` /
`member_removed` board events per affected project via
`transaction.on_commit()`. Cascade-created memberships are marked
(`source_group`) so a user's directly-granted membership is never clobbered or
revoked by group reconciliation (direct grant wins; group grant is additive and
only removes rows it created). Full reconciliation logic lives in
`workspace/services.py::reconcile_group_access()`.

`GET/POST/PATCH/DELETE /api/v1/workspace/groups/`,
`POST/DELETE /api/v1/workspace/groups/{id}/members/{user_id}/`. ADMIN+ writes;
any workspace member reads.

### 6. Permissions
`workspace/permissions.py`: `_workspace_membership_role(request)` with
per-request caching (mirrors `_membership_role`), `IsWorkspaceMember`,
`IsWorkspaceAdmin`. Viewsets inherit `IdempotencyMixin` first in MRO.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| Reuse project `Role` for workspace membership | Less code | Contradicts #518; mixes scheduling-tier semantics into org membership |
| Defer group→project cascade (model-only) | Smaller MR | Rejected by product: cascade is the point of groups |
| Pending-invite row only (no email/accept) | Smaller MR | Rejected: invites must actually invite |
| Data-migration-seeded singleton | Explicit row | Extra migration; lazy get_or_create is the established precedent |

## Consequences
- **Easier:** first-class workspace admin replaces the `IsOrgAdmin` heuristic;
  groups give bulk project-access management.
- **Harder:** cascade reconciliation adds a write-amplification path on group
  edits — bounded by group size × project count, run in one transaction with
  `select_for_update` on affected rows. Invite acceptance is a new **public**
  auth surface requiring careful token handling (hashed token, expiry, no
  enumeration, throttling).
- **Risks:** cascade interaction with the project last-owner guard (group grants
  never confer OWNER — capped at the conferred role which is ADMIN-or-below by
  validation); invite token security (mitigated by SHA-256 storage + expiry).

## Implementation Notes
- P3M layer: Programs and Projects / Operations support.
- Affected packages: api (new app), web (3 pages + hooks + invite-accept route).
- Migration required: yes (new tables; no data migration — singleton is lazy).
- API changes: yes — see §2–§5.
- OSS or Enterprise: **OSS** (basic team management; explicitly OSS-labeled
  issues). SSO/2FA columns are display-only placeholders for the Enterprise
  identity features.

### Durable Execution
1. **Broker-down behaviour:** Invite emails use the transactional-outbox pattern —
   `POST /invites/` writes the row with `email_pending=True` in the request
   transaction; a Beat drain dispatches. Broker/SMTP outage logs, never
   propagates to the API caller. Cascade `ProjectMembership` writes are
   synchronous DB writes (not async); their board-event broadcasts are deferred
   with `transaction.on_commit()` (best-effort, broadcast layer already tolerates
   pub/sub-down).
2. **Drain task:** new `workspace.drain_invite_emails` Beat task, every 30 s,
   `@idempotent_task(on_contention="skip")` — semantics mirror
   `drain_notification_emails` (a distinct work category, so a distinct drain).
3. **Orphan window:** 5 minutes (`created_at < now-5m`), matching the
   notification/webhook drains — avoids racing the still-open create transaction.
4. **Service layer:** `workspace/services.py::create_workspace_with_owner()`,
   `reconcile_group_access()`, `accept_invite()`. No CPM dispatch involved.
5. **API response on best-effort dispatch:** `POST /invites/` returns `201` with
   the invite row immediately; email delivery is asynchronous and not reflected
   in the response (no `task_id`).
6. **Outbox cleanup:** accepted/revoked/expired invites older than 30 days are
   purged by a nightly `purge_stale_invites` Beat task (retention matches the
   existing housekeeping convention).
7. **Idempotency:** invite email drain keys on the invite PK + `email_pending`
   flag flipped under the row update (`.filter(pk=...).update(email_pending=False,
   email_sent_at=...)`); a duplicate drain tick finds the flag already cleared.
   `accept_invite()` is guarded by a `select_for_update` on the invite row +
   status check (`pending` → `accepted`), so a double-submit creates exactly one
   membership. Write viewsets carry `IdempotencyMixin` for `Idempotency-Key`.
8. **Dead-letter / failure handling:** invite email retries up to
   `EMAIL_MAX_RETRIES=3` with attempt/`email_failed_at` tracking; at exhaustion
   `email_pending` is cleared and the invite stays `pending` (admin can re-send
   by revoking + re-creating). Mirrors the notification email failure path.

---

## Addendum (2026-06-21, #542): Workspace-member availability baseline

VoC audit on MR !302 (David, Resource Manager) flagged that allocation is
all-or-nothing: a member is implicitly 100% available, with no way to model
parental leave (40%), a part-time contract (60%), or a known side commitment.
The project-level partial-allocation model (#489) therefore has no upper bound —
no denominator — to compare summed per-project percentages against.

**Decision.** Four additive fields on `WorkspaceMembership` (the existing
through-model — keeps availability where the workspace role/status already live,
no new entity):

| Field | Type | Notes |
|-------|------|-------|
| `availability_percent` | `PositiveSmallIntegerField(default=100)` | validated `0..100`; `default=100` backfills every existing row to fully-available so the AddField migration is non-interactive and historical behaviour is preserved |
| `availability_effective_from` | `DateField(null=True)` | start of a temporary baseline (e.g. a quarter) |
| `availability_effective_to` | `DateField(null=True)` | end; both NULL ⇒ applies indefinitely |
| `availability_notes` | `TextField(blank=True)` | freeform context |

`availability_effective_from <= availability_effective_to` is enforced
authoritatively in the PATCH handler **after** the partial merge, so a request
that sets only one bound is still validated against the stored other bound.

**RBAC.** Edit is gated to Owner/Admin by the existing `IsWorkspaceAdmin` class
on `WorkspaceMemberDetailView`. A member views their own baseline through the
self-scoped member list (a non-admin GET already returns only their own row).
Availability is deliberately **not** subject to the peer/higher-role guard that
governs role/status changes: it is benign capacity metadata — it neither
escalates a role nor gates login — so a resource manager (Admin) declares
availability for everyone, peers included.

**Scope.** This slice ships only the model, serializer, permission, and tests.
The Members-table column, the per-member availability editor, and the #489
overallocation warning that consumes this baseline are deferred to a web
follow-up. No new ADR — this extends the workspace-membership data model
introduced above.

### Durable Execution
N/A — a synchronous field write on an existing CRUD endpoint. No async side
effects, no Celery dispatch, no broker interaction, no outbox. `WorkspaceMembership`
is a `VersionedModel`; the write bumps `server_version` like any other edit.

## Amendment (2026-09-27, #4191): no orphan window on the email drains; nudge on commit

**Supersedes §Durable Execution item 3** above for `drain_invite_emails`, and the
same item in ADR-0075 §Durable Execution / ADR-0085 / ADR-0149 for
`drain_notification_emails`. History above is left as written.

### What the window cost
With `created_at < now - 5m` on both email drains and nothing else sending a new
row, every first invite and every notification email arrived **at least 5
minutes** after the action (measured 2026-09-27 against Mailpit: invite 5m15s,
@mention 5m26s). A resend left in the same second, because its row was already
old. `administration/email.md` described a 30 s drain and never mentioned the
floor, so an admin who invited someone and checked the inbox concluded mail was
broken.

### Why the window protected nothing
The 5-minute value was copied from the webhook drain (ADR-0019) and the
export/import drains (ADR-0174, ADR-0219, ADR-0726). There it is load-bearing:
those paths dispatch a **per-row task** from `on_commit`, and the drain
*re-dispatches* rows whose task a broker outage lost. The window keeps the drain
from re-dispatching a row whose original task is still queued or running — it
excludes rows an in-flight owner may still hold.

The email drains have no such owner. Tracing the send path:

- **The drain is the only sender.** Neither `create_invite`, the resend service,
  nor any notification fan-out sends mail; they only write
  `email_pending=True`. There is no per-row send task that can be orphaned.
- **Claiming is by lock, not by row.** Rows are not claimed with a status
  transition or `select_for_update(skip_locked=True)`. Exactly-once across
  overlapping runs comes from `@idempotent_task`'s singleton Valkey lock
  (`drain_invite_emails` / `drain_notification_emails`, `SET NX`, extended by a
  daemon thread while the run is alive, released compare-and-delete), with
  `on_contention="skip"`. Two drains never hold the candidate set at once, and a
  sent row is terminal (`email_pending=False`, `email_sent_at` set) before the
  lock is released.
- **"Racing the still-open create transaction" is not a race.** Under READ
  COMMITTED the drain cannot see an uncommitted row at all, and once the row is
  visible it is complete. Row age adds nothing to that.

So the in-flight-owner window sized from the claim mechanism is **zero**: the
only thing that can own a row is a live drain, and the lock already excludes it.
The residual double-send case — a Valkey failover or eviction dropping the lock
mid-run, or `acks_late` redelivery after a worker dies between the SMTP accept
and the row update — exists identically for a row that is 5 minutes old, so the
window never covered it either.

### Decision
1. **Remove the age predicate** from both email drains
   (`EMAIL_ORPHAN_WINDOW_MINUTES` is deleted from `workspace.tasks` and
   `notifications.tasks`). Every committed pending row is eligible on the next run.
2. **Nudge the drain from `transaction.on_commit`** when a row is queued:
   `workspace.services.create_invite` registers `drain_invite_emails_soon`, and
   every notification fan-out that writes at least one `email_pending=True` row
   goes through `notifications.services._bulk_create_notifications`, which
   registers `drain_notification_emails_soon`. On commit, not inline, so a
   rolled-back write enqueues nothing and the drain never runs before the rows are
   visible. The nudge is `drain.delay()` of the **same singleton-locked drain**,
   not a per-row send task, so it adds no second sender: if a drain is already
   running, the nudged run skips and the row goes on the next 30 s tick.
3. **Beat stays the durability guarantee.** The nudge swallows broker errors; a
   dropped nudge costs at most one Beat interval.
4. **Retries keep their spacing** (`EMAIL_RETRY_SPACING = 25 s` on both drains).
   Neither drain had a retry backoff; retries were spaced only by the 30 s Beat
   cadence. Once nudges run the drain on every email-queuing commit, a 20-second
   relay restart during a burst of comments would burn all three attempts in
   seconds and fail the mail permanently (an invite goes to `FAILED`). A row
   whose `email_failed_at` is set is therefore eligible again only 25 s after
   that failure — just under the 30 s tick, so a Beat-only retry lands on the
   next tick instead of racing it (a floor equal to the tick would skip a tick
   about half the time). First sends (`email_failed_at IS NULL`) are unaffected, and a
   resend clears `email_failed_at`, so it too goes at once. Exhaustion still takes
   about 90 s, as `administration/email.md` states.

First-send latency is now seconds on a healthy install, bounded by ~30 s when a
nudge collides with a running drain or is dropped, plus the operator's
per-minute throttle under a burst.

### Consequences
- A nudged run reserves a per-tick share of the per-minute throttle like a Beat
  run does, so a burst of nudges can spend the minute's allowance early in the
  minute instead of spreading it over two ticks. The shared per-minute budget
  (`delivery_limits.reserve_send_budget`) still bounds the total, which is the
  control operators actually set.
- Each email-queuing fan-out **call** enqueues one small Celery message (Django
  does not dedupe `on_commit` callbacks, so a request that fans out K events
  enqueues K). Runs that find the lock held return immediately; runs that do not
  overlap each drain only rows still pending, so they cannot resend.
- The export, import, webhook, config-notice and workflow-outbox drains keep
  their windows: they re-dispatch per-row tasks and the window is what stops
  them racing the original dispatch.
- Pinned by `test_drain_sends_new_invite_immediately`,
  `test_create_invite_nudges_drain_on_commit`,
  `test_rolled_back_invite_create_does_not_nudge`,
  `test_sends_just_created_notification_without_age_floor`,
  `test_email_queuing_fan_out_nudges_drain_on_commit`,
  `test_mention_email_nudges_drain_on_commit` and the two retry-spacing tests
  (`test_failed_invite_retry_waits_one_tick`,
  `test_failed_notification_retry_waits_one_tick`).
