# ADR-0148: Inbound CI Acceptance-Result Ingestion (extends ADR-0068)

## Status
Accepted — implemented on main; status corrected 2026-06-30 after ADR audit (verified: AcceptanceResultIngestView)

> Extends **ADR-0068** (Inbound Task-Sync Protocol — Project API Tokens) with a
> second narrow inbound write surface. Reuses the existing `ApiToken` /
> `ProjectApiTokenAuthentication` machinery verbatim.
>
> **ADR-number race note.** See ADR-0147 — renumber-at-merge if 0148 collides.

## Context

The `AcceptanceCriterion` model (`apps/projects/models.py:1622`, Given/When/Then,
`met` / `met_by` / `met_at` trail) is strong, and the DOR gate
(`serializers.py:1900`) already blocks a story from READY until **all** criteria are
`met`. But criteria flip **only by hand** (`AcceptanceCriterionViewSet.perform_update`,
`views.py:3075`). The 2026-06-10 audit (§3.2/§3.3.4) calls one inbound endpoint —
"CI reports a passing acceptance test → the criterion flips" — the cheapest
"developers love it" feature available, closing the XP acceptance-test-driven loop.

**Boundary (the load-bearing decision).** *Inbound* integration is boundary-sensitive.
enterprise-check rule 9 and the Enterprise feature list put **general webhook ingest**
— multi-provider registry, HMAC signature verification, replay protection, conflict
resolution, reconciliation loops, per-tenant rate budgets, an inbound mutation audit
trail — firmly in **Enterprise** (`trueppm-enterprise`). ADR-0097's carve-out keeps a
**user-scoped, narrow, one-way** integration in OSS.

This feature stays OSS **only** by staying narrow:

> **OSS (this ADR):** one authenticated endpoint, reusing the existing project/program
> `ApiToken` the team already mints, that flips `AcceptanceCriterion.met` for criteria
> the token's scope owns. No provider registry, no HMAC/OAuth, no conflict resolution,
> no reconciliation loop, no new ingest framework.
>
> **Enterprise (unchanged):** the durable two-way Integration Hub — provider
> connectors, signature verification, replay protection, inbound audit trail. This
> ADR builds none of it and adds no extension point that implies it.

**P3M layer**: Programs and Projects / Operations — single-project, team-scoped.
**OSS.**

## Decision

**1. Endpoint.** A new inbound action on the acceptance-criterion surface, co-located
with the ADR-0068 inbound pattern:

```
POST /api/v1/projects/{project_id}/acceptance-results/
Authorization: Bearer tppm_<64-hex>      # ProjectApiTokenAuthentication
Content-Type: application/json

{ "source": "ci",                         # optional free-text label, stored in attribution
  "results": [
    { "criterion": "<uuid>", "passed": true  },
    { "criterion": "<uuid>", "passed": false }
  ] }
```

- **Auth / RBAC:** `ProjectApiTokenAuthentication` only (no session/JWT — this is a
  machine endpoint). The token must be scoped to the target project: a **project**
  token must match `{project_id}`; a **program** token's program must contain
  `{project_id}`. Every referenced criterion's `task.project_id` must equal
  `{project_id}` — a criterion outside the token's project is rejected
  (`400`, no per-id existence leak). This closes the cross-project IDOR.
- **Attribution:** `met_by` is set to the token's `created_by`
  (`ProjectApiTokenAuthentication` returns `(created_by, token)`), `met_at` to now —
  reusing the exact stamping logic in `perform_update`. The `source` label and token
  prefix are recorded for the audit trail (token `last_used_at` is bumped as ADR-0068
  already does).

**2. Criterion matching — by UUID, no migration.** CI identifies each criterion by its
TruePPM `AcceptanceCriterion` UUID, supplied in the payload. `AcceptanceCriterion` has
no external-ref field today; adding one would require a migration **and** a web UI to
set the key to be useful (out of scope for this backend wave, and a migration would
race the 8 in-flight worktrees on the numbering gate). UUID matching keeps the whole
0.3 wave **migration-free**. A human-friendly `external_ref` key is a documented
follow-up (filed separately) once a UI exists to set it.

**3. Behaviour — flip + stamp, satisfy the DOR gate, do NOT auto-promote.**
- `passed: true` and not already met → `met=True`, stamp `met_by`/`met_at`, bump
  `server_version`, broadcast (reuse `perform_update`'s `_broadcast`).
- `passed: false` and currently met → `met=False`, clear `met_by`/`met_at` (mirrors
  `perform_update`'s un-met branch — a regressed CI run reopens the criterion).
- Already in the target state → no-op (idempotent; no re-stamp, no spurious broadcast).
- The endpoint **does not** transition `task.status` to READY. The existing DOR gate
  is a *validation* gate; once all criteria are met it stops blocking, and a human (or
  another deliberate automation) promotes. An external CI signal silently promoting a
  task contradicts the "deliberate decision" sprint-sovereignty theme and is a
  surprising side effect. "Auto-advances DOR" is satisfied in the sense that the DOR
  blocker (`acceptance_criteria_unmet`) clears automatically. The response echoes the
  task's DOR readiness so CI can report it.

**4. Response.**
```json
{ "updated": <int>, "unchanged": <int>,
  "tasks": [ { "task": "<uuid>", "dor_ready": <bool>,
              "criteria_total": <int>, "criteria_met": <int> } ] }
```

**5. Abuse surface.** `results` is capped at **200** entries per request (`400` above
the cap). The endpoint is wrapped in the existing HTTP idempotency-key support
(ADR-0170 http-idempotency) for safe retries, and is naturally idempotent regardless.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. UUID match, reuse ApiToken, no auto-promote (chosen)** | No migration; reuses ADR-0068 auth; stays OSS-narrow; safe | CI must carry TruePPM UUIDs in its config |
| B. Add `external_ref` field, match by key | CI-friendly stable keys | Migration + needs web UI to set keys → scope creep + numbering race |
| C. Auto-transition task→READY on last criterion | "Fully automatic" | Silent promotion from an external signal; violates deliberate-decision theme |
| D. New generic CI-ingest framework (provider registry, HMAC) | Extensible | Crosses into the Enterprise Integration Hub — boundary violation |
| E. Session-auth + a UI button only | No new auth | Doesn't close the *automated* CI loop — the whole point |

## Consequences
- **Easier:** acceptance criteria flip automatically from CI; the XP acceptance loop
  closes; the DOR gate becomes self-clearing. Reuses minted tokens — zero new auth.
- **Harder:** CI configs must reference criterion UUIDs until the `external_ref`
  follow-up lands. The OSS/Enterprise inbound line is now explicitly drawn — a future
  contributor adding provider connectors here must stop and file Enterprise.
- **Risks:** a leaked project/program token can flip criteria (same blast radius as the
  ADR-0068 inbound task-sync write already has — tokens are revocable, prefix-audited,
  and broadcast on use). Cross-project flip is blocked by the scope check + per-result
  project assertion. Batch cap bounds DoS.

## Implementation Notes
- P3M layer: Programs and Projects / Operations
- Affected packages: api (`apps/projects/views.py`, `apps/projects/serializers.py`,
  `apps/projects/urls.py`), docs/api
- Migration required: **no**
- API changes: yes — one new inbound endpoint (`POST .../acceptance-results/`)
- OSS or Enterprise: **OSS** (`trueppm-suite`)

### Durable Execution
1. **Broker-down behaviour:** N/A — the flip is a synchronous DB write inside the
   request transaction; the only async side effect is the existing board broadcast,
   which already uses `transaction.on_commit` (best-effort, board state is
   self-healing on next read).
2. **Drain task:** N/A — no new async work category.
3. **Orphan window:** N/A.
4. **Service layer:** the flip logic is factored into a small helper reused by both
   `AcceptanceCriterionViewSet.perform_update` (manual) and the new ingest view, so the
   stamp/broadcast rule lives in one place.
5. **API response on best-effort dispatch:** synchronous — returns the
   updated/unchanged + per-task DOR summary (above). Not a 202.
6. **Outbox cleanup:** N/A.
7. **Idempotency:** flipping is inherently idempotent (target-state no-op, no re-stamp).
   HTTP idempotency-key (ADR-0170) covers duplicate POST retries. Token `last_used_at`
   update is a harmless repeat.
8. **Dead-letter / failure handling:** N/A — synchronous; a failed request returns
   4xx/5xx and CI retries. No queue, no DLQ.
