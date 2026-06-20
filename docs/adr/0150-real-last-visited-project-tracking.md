# ADR-0150: Real Last-Visited Project Tracking

## Status
Accepted

## Context
ADR-0129 (role-based app landing) resolves the post-login front door server-side.
For a PM-tier user with `default_landing = AUTO` (or an explicit `PROJECT_OVERVIEW`
preference) the resolver lands them on "their most recent project's Overview" via
`most_recent_project(user)` in `apps/profiles/services.py`.

That function is a **proxy**, not real telemetry. It returns:

```python
ProjectMembership.objects
    .filter(user=user, is_deleted=False, project__is_deleted=False, project__is_archived=False)
    .order_by("-server_version", "project__name")
    .first()
```

i.e. "the project whose *membership row* has the highest `server_version`" — a
stand-in for "most recently touched" — then alphabetically-first. ADR-0129
explicitly flags this as inadequate:

> "`most_recent_project` is a proxy (membership `server_version`), not true
> last-visited telemetry; a PM with many projects may land on a not-truly-most-recent
> one until they set a preference. Acceptable for a default; flagged as a follow-up
> (real last-visited tracking)."

A membership's `server_version` advances when the *membership* changes (role edit,
group grant), not when the user opens the project — so a PM who hasn't been
re-roled recently lands on a stale project. Issue #1182 is that flagged follow-up:
record a real per-user last-visited-project timestamp and feed it to the resolver.

**P3M layer:** Programs and Projects (and Operations) — a per-user navigation
default. Purely OSS; every PM/contributor lands on their work. No cross-program
aggregation, no portfolio concern, no enterprise boundary.

## Decision

**D1 — Storage: a dedicated `ProjectVisit` model in the `profiles` app.**
One row per `(user, project)`, upserted on each visit, holding `visited_at`.

```python
class ProjectVisit(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(AUTH_USER_MODEL, on_delete=CASCADE, related_name="project_visits")
    project = models.ForeignKey("projects.Project", on_delete=CASCADE, related_name="visits")
    visited_at = models.DateTimeField()

    class Meta:
        constraints = [UniqueConstraint(fields=["user", "project"], name="uq_project_visit_user_project")]
        indexes = [Index(fields=["user", "-visited_at"], name="projectvisit_user_recent_idx")]
```

Plain `models.Model` (no `server_version`) — this is private per-user navigation
telemetry, never synced to mobile, never broadcast. This mirrors `UserProfile`
(same app, deliberately not a `VersionedModel`) and `NotificationPreference`. A
one-row-per-pair upsert (not an append log) keeps the table bounded by membership
count and makes the resolver query a single indexed lookup. The `(user, -visited_at)`
index serves both the resolver ("my most recent project") and a forward-compatible
"recently viewed projects" switcher (order by `-visited_at`, limit N) without a
schema change. The switcher UI itself is **out of scope** for #1182.

**D2 — Recording: a dedicated `POST /projects/{id}/visit/` action, fired
fire-and-forget from the web `ProjectShell` mount.** Not piggybacked on
`ProjectViewSet.retrieve` — a GET must not write, and `retrieve` fires on every
poll/refetch (far too chatty). `ProjectShell` is the single mount point for every
`/projects/:projectId/*` sub-route, so a `useRecordProjectVisit(projectId)` effect
fires once per project navigation. The endpoint does a cheap
`update_or_create(user, project, defaults={"visited_at": now})`.

**D3 — Write coalescing (perf).** Two layers:
- *Client:* the effect fires only when `projectId` changes (once per navigation),
  not on every render.
- *Server:* a per-`(user, project)` Redis-bucket throttle
  (`rate:project_visit:{user}:{project}`, 60 s TTL, fail-open) caps the upsert to
  at most once per minute per user×project. A throttled request returns `200`
  (idempotent no-op from the caller's view), not `429` — a dropped visit-ping is
  inconsequential and must never surface an error to the user.

**D4 — RBAC.** `IsProjectMember` (any role ≥ Viewer): a Viewer landing on a project
they belong to is legitimate last-visited data. The action upserts only for
`request.user` against the URL's project — a user can neither read nor write another
user's visit rows (no IDOR surface; there is no read endpoint exposing visits). The
`IsProjectNotArchived` gate is **omitted** for this action so visiting an archived
project still records (mirrors lifecycle actions); the resolver separately filters
archived/deleted projects out of the landing result.

**D5 — Resolver swap.** Rewrite `most_recent_project(user)` to query `ProjectVisit`
ordered by `-visited_at`, filtered to still-accessible (member, non-archived,
non-deleted) projects, and **fall back to the existing membership-`server_version`
proxy** when the user has no visit rows yet (fresh users, pre-backfill). Both
`resolve_landing` call sites (preference branch + AUTO role policy) pick this up
unchanged. The lookup adds exactly one indexed query per `/auth/me/`.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **D1: dedicated `ProjectVisit` model** (chosen) | Indexed `-visited_at` ordering; forward-compatible recently-viewed list; bounded by membership count; clean per-pair upsert | New model + migration |
| JSON column on `UserProfile` (`{project_id: ts}`) | No new table | Can't index/order in SQL — must deserialize whole blob in Python every `/auth/me/`; unbounded growth for users in many projects; race on concurrent writes to one row |
| Piggyback recording on `ProjectViewSet.retrieve` | No new endpoint | GET writes (semantically wrong + breaks caching); fires on every poll/refetch; can't easily scope to "real navigation" |
| Append-only visit log (one row per visit) | Full history | Unbounded growth; needs purge job; resolver needs DISTINCT ON / GROUP BY; we only need "most recent", not history |
| Celery async write | Decouples from request | Massive over-engineering for a single indexed upsert; adds broker dependency + durability gap for inconsequential data |

## Consequences
- **Easier:** PMs land on the project they actually last opened, not the one whose
  membership row changed most recently. The `(user, -visited_at)` index makes a
  future "recently viewed" switcher a read-only addition.
- **Harder:** One new table + one write path to maintain. A negligible extra write
  per project navigation (coalesced to ≤1/min/pair).
- **Risks:**
  - *Stale-until-first-visit:* existing users have no visit rows until they next
    open a project, so they keep the proxy behaviour for one navigation — graceful,
    handled by the D5 fallback. No backfill migration needed.
  - *Resolver query cost:* mitigated by the `(user, -visited_at)` index; one query,
    `.first()`, on the `/auth/me/` hot path.
  - *Write amplification:* mitigated by client + server coalescing (D3).

## Implementation Notes
- P3M layer: Programs and Projects / Operations (per-user navigation default)
- Affected packages: api (model, migration, endpoint, resolver), web (hook + ProjectShell ping)
- Migration required: yes — `profiles/0003_projectvisit`, depends on `0002_userprofile_hidden_views`; additive `CreateModel`, no backfill
- API changes: yes — `POST /api/v1/projects/{id}/visit/` → `200 {"recorded": true}`; no read endpoint added
- OSS or Enterprise: **OSS** (`trueppm-suite`)

### Durable Execution
1. Broker-down behaviour: **N/A** — the visit write is a synchronous single-row
   `update_or_create` in the request thread. No Celery task, no broker, no async
   side effect. A broker outage cannot affect it.
2. Drain task: **N/A** — no async work, so no drain.
3. Orphan window: **N/A** — no `transaction.on_commit` dispatch; the upsert commits
   with the request transaction.
4. Service layer: `apps.profiles.services.record_project_visit(user, project)` (new)
   performs the upsert; `most_recent_project(user)` (existing, rewritten) reads it.
5. API response on best-effort dispatch: synchronous `200 {"recorded": true}`. A
   throttle-coalesced request also returns `200` (no-op), never `429` — a dropped
   ping is inconsequential.
6. Outbox cleanup: **N/A** — no outbox. The table itself is self-bounding
   (one row per user×project, upserted in place), so no purge job is needed.
7. Idempotency: the write is `update_or_create` keyed on the
   `(user, project)` unique constraint — running it twice only advances
   `visited_at`. Naturally idempotent; concurrent writes are serialized by the
   unique constraint (last-writer-wins on `visited_at`, which is the desired
   semantic).
8. Dead-letter / failure handling: **N/A** — no task. If the upsert itself raises
   (DB error), the endpoint returns a normal 5xx and the client's fire-and-forget
   ping silently discards it; the next navigation retries. Acceptable because the
   data is a best-effort default, never a source of truth.
