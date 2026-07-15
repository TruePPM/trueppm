# ADR-0428: Workspace-scoped Assets — the personal/RBAC-identical OSS seam

## Status
Accepted

Amends **ADR-0215** (Unified Assets surface, project + program), which scoped *all*
workspace/cross-program asset rollups as "Enterprise and out of scope." ADR-0215 stays
in force for the governance overlay; this ADR carves the personal/RBAC-identical read
out of that blanket deferral. See the amendment note appended to ADR-0215.

## Context

ADR-0215 shipped a read-only unified Assets surface aggregating `TaskAttachment` (files/URLs
on tasks) and `TaskLink` (git/cloud reference links) into one `AssetItem` feed, at two tiers:
`GET /projects/{id}/assets/` and `GET /programs/{id}/assets/`. It explicitly deferred any
workspace/cross-program rollup to Enterprise.

A `/voice-of-customer` panel (avg 4.6/10) plus `/enterprise-check` re-examined that deferral
and found the phrase "workspace rollup" conflates **two features with opposite
classifications**:

1. **A personal, RBAC-identical workspace read** — "show me the files and reference links on
   tasks I can already see, across all my projects, in one place, defaulted to *my own*
   tasks." Nadia (integration/API dev, 7/10) wants exactly this as a read-only, filtered,
   bounded agent-index endpoint; Priya/Sarah/Jordan want a "My Assets" view scoped to
   themselves by default. This returns **nothing the caller cannot already read** per-project.
2. **A governance overlay** — a cross-program *asset register* with health/comparison
   analytics, an actor/"who attached or accessed what" dimension, an audit trail, and
   data-residency/retention tagging. Marcus (PMO, 3/10 🔴) warned a flat cross-everything list
   must **not** masquerade as his portfolio dashboard; Morgan (Agile Coach, 5/10 🔴) flagged
   that an aggregate cross-team asset feed with a "who" dimension edges toward a surveillance
   surface.

**P3M layer:** the OSS slice is **Operations / Programs-and-Projects** — personal productivity
and API-first reach over work the caller already owns. The governance overlay is **Portfolio**
— cross-program coordination and compliance evidence.

The reconciliation basis for treating a *workspace*-scoped read as OSS is **ADR-0087**: in a
self-hosted single-tenant install "the workspace **is** the installation." A workspace-scoped
read narrowed to the caller's own readable projects is therefore not a portfolio rollup — it is
the same per-project reads the caller can already perform, merged into one feed. What makes
0215's deferral correct for *governance* is not the word "workspace"; it is the aggregation,
comparison, and accountability layer. So the seam runs through "workspace rollup," not around it.

## Decision

Add a third, **workspace-scoped** tier to the Assets surface, in OSS, strictly limited to a
personal/RBAC-identical read. Keep the governance overlay in Enterprise, unchanged.

**OSS — `GET /api/v1/assets/`** (this ADR, #1979):
- Any authenticated user; results narrowed to the caller's **readable** projects via the same
  `ProjectMembership` pattern the program view uses (ADR-0215), extended from a single program
  to the whole instance:
  `ProjectMembership.objects.filter(user=request.user, is_deleted=False, project__is_deleted=False)`.
  A user with no readable projects gets an empty page, never a 403 — and the feed can never
  surface an asset from a project the caller cannot open, so it grants **no new reach**.
- Filters: `mine` (bool — assets on tasks assigned to the caller), `program` (UUID — narrow to
  one program's readable projects), plus the existing `kind`/`label`/`provider`/`q`. Reuses the
  ADR-0215 keyset-merge cursor and its `page_size` bound (default 50, max 100) verbatim.
- `mine` resolves against `Task.assignee` only — the audited `MeWorkView` semantics — with **no
  `?user=` escape hatch**, so it can never widen to another user's assets.
- Read-only GET, echoing stored rows. Per ADR-0112 it carries **no `_provenance`** (nothing is
  computed/derived) and writes **no `AgentAction`** (reads are not audited actions). Reachable
  by `mcp:read` tokens via `McpReadableViewMixin`, which also applies the per-token read
  throttle (#1808); human callers keep the default `user` throttle.

**OSS hard non-goals** (the guardrails that keep the portfolio upsell intact — anything below
is the Enterprise asset register, not this endpoint):
- ❌ No health/RAG scoring, cross-program comparison, or assets-per-program analytics.
- ❌ No actor / "who attached or accessed what" dimension (Morgan's surveillance boundary).
- ❌ No audit trail, data-residency, or retention tagging.
- ❌ No `?user=` or any parameter that lets one user read another user's `mine` scope.

**Enterprise — unchanged.** The governance asset register (cross-program inventory with the
analytics/actor/audit/residency layers above) stays in `trueppm-enterprise`, registered against
the existing Assets extension points. This ADR does not add or move any Enterprise code; it only
narrows what 0215 deferred so the personal read is not blocked with it.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Personal/RBAC-identical `GET /api/v1/assets/` in OSS; governance stays Enterprise (chosen)** | Serves Nadia's agent-index + the "My Assets" view; zero new reach; protects the upsell via explicit non-goals | Requires amending 0215; the seam must be actively policed in review |
| Keep 0215's blanket deferral — build nothing in OSS | No boundary churn | Strands a real, low-risk, high-API-value read; forces per-project clicking; the agent can't enumerate assets a human can (fails API-first) |
| Build the full workspace feed in OSS including cross-program comparison | One surface | Cannibalizes the portfolio upsell; trips Marcus 🔴 and Morgan 🔴; violates the adoption-vs-governance line |
| `GET /api/v1/me/assets/` (personal-only, no general workspace read) | Signals "personal" in the path | `mine=false` (Nadia's general agent-index) is incoherent under `/me/`; needs a second endpoint for the same data |

## Consequences

- **Easier:** a contributor finds "the doc/PR link on my own work" in one place; an agent
  enumerates every asset a human can read from one bounded, filtered endpoint (API-first).
- **Harder:** the OSS/Enterprise seam for Assets is now a line *within* one feature, not between
  two features — reviewers must keep the non-goals out of the OSS endpoint. The `rbac-check` and
  `enterprise-check` gates cover this on any future Assets change.
- **Risks:**
  - *Scope creep into governance.* A future PR adds a `group_by=program` count or a "who added"
    column to the OSS endpoint and silently becomes the portfolio surface. Mitigation: the
    non-goals list above is normative; a test asserts the OSS response shape carries no actor
    dimension beyond the existing `added_by` (already present per-project in 0215) and no
    aggregate counts.
  - *RBAC leak via the instance-wide narrowing.* Dropping 0215's `project__program=` clause
    widens the membership query to the whole instance — a bug there leaks across the install.
    Mitigation: reuse the exact audited filter; a test asserts a member of project A (not B)
    sees only A's assets through `GET /assets/`; `rbac-check` gate.
  - *`mine` widening.* Mitigation: `mine` binds to `request.user` only, no `?user=`; a test
    asserts a PM/admin caller gets only their own assigned-task assets.

## Implementation Notes
- P3M layer: Programs and Projects / Operations (OSS). Governance overlay: Portfolio (Enterprise).
- Affected packages: api (this ADR / #1979); web (the "My Assets" consumer, #1980).
- Migration required: **no** — pure read-only aggregation over existing models (as ADR-0215).
- API changes: **yes** — new `GET /api/v1/assets/` with `mine`/`program` filters; OpenAPI schema
  regenerated. No write surface.
- OSS or Enterprise: **OSS** (personal/RBAC-identical read); the governance register stays Enterprise.

### Durable Execution
1. Broker-down behaviour: **N/A** — read-only GET, no async side effects, no dispatch.
2. Drain task: **N/A** — no async work introduced.
3. Orphan window: **N/A** — no outbox rows.
4. Service layer: reuses `apps/projects/asset_feed.py::build_asset_feed` (extended with an
   `assignee_id` kwarg for `mine`); no new dispatch path.
5. API response on best-effort dispatch: **N/A** — synchronous read; returns
   `{results, next_cursor}` (ADR-0215 envelope).
6. Outbox cleanup: **N/A**.
7. Idempotency: **N/A** — a read is naturally idempotent; the keyset cursor is stable across
   concurrent writes (ADR-0215).
8. Dead-letter / failure handling: **N/A** — no task; a malformed `cursor`/`mine`/`program`
   returns 400, an empty readable set returns an empty page.
