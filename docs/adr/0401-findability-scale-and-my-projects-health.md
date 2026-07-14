# ADR-0401: Findability at scale + a "my projects" health summary

## Status
Proposed

## Context
Two findings from the 2026-07-14 persona-informed UX review surface the same class
of gap: a surface that passes a component-level review on a demo workspace but fails
the task the moment a real account reaches the scale the product is sold for
(personas: 40+ projects, 8–12 teams).

**Finding A — #1940, global findability truncates at the first DRF page.**
`useProjects` / `usePrograms` fetch `GET /projects/` and `GET /programs/` with no
query params and read `res.data.results` only. The backend default `PAGE_SIZE` is 50
and neither viewset overrides it, so both hooks silently truncate at the 50th entity.
Every surface built on them — the sidebar Browse tree, the command-palette Tier-1
"jump" targets, the orphan-project list — inherits the cap; the 51st project is
unreachable from navigation. Separately, the command palette's task search is
current-project-only and hard-capped at 8 results (`TASK_RESULT_CAP`) with no overflow
cue, and there is no people/resource tier at all — even though `/resources/?search=`
and `useResourceSearch` already exist end-to-end.

**Finding B — #1941, no cross-project health summary off a project route.**
`HealthCluster` self-suppresses off a `/projects/:id` route, so from My Work a PM
overseeing many projects has no aggregate health signal above the fold — only
per-row dots to scan in the sidebar. Information hierarchy is strong *inside* a
project but flat *across* the user's projects; a PM can't triage "which of mine is
on fire?" without opening each.

**P3M layer.** Both sit at **Programs and Projects / Operations** for the *individual
contributor's own reachable set* — not Portfolio. Finding B is the adoption-lens
"basic multi-project viewing" of already-OSS facts, scoped to the current user's
member projects. `enterprise-check` (2026-07-14) confirmed both **OSS**. There is
direct precedent: `/me/work/` already aggregates cross-program *individual* signals
(ADR-0221, Accepted OSS), and ADR-0088 records the boundary — "one program
aggregating its own projects is the OSS adoption unit; cross-program/portfolio
rollup stays Enterprise." A per-user "my projects" health summary is the same class
as ADR-0221's cross-program signals: an individual's own view, not org governance.

## Decision

### A1 — Remove the silent 50-cap **server-side**; expose count for the overflow cue
The raised page ceiling is applied on the **server**, not by a client query param.
Both `ProjectViewSet` and `ProjectViewSet`-parallel `ProgramViewSet` get a shared
`DirectoryPagination` (`page_size=200`, `page_size_query_param="page_size"`,
`max_page_size=500`). This deliberately avoids having `useProjects`/`usePrograms`
send `?page_size=200`: adding a query param would change the request URL to
`/projects/?page_size=200`, which no longer matches the trailing-slash
`**/api/v1/projects/` route glob that dozens of Playwright specs use — silently
dropping the mock and 404-ing the list. With the ceiling on the server the hooks
keep fetching a bare `/projects/` and every existing mock still matches. 200 covers
the stated scale (40+ projects) in a single request; `page_size` stays
client-tunable and the response `count` drives an honest **"showing N of M — search
in ⌘K"** overflow cue in the sidebar when `count > loaded`. The hook returns
`{ items, count }` (the default hook keeps returning the mapped array; `count` is an
added optional field so existing mocks stay valid). `ProjectViewSet` already
declares `search_fields=["name"]`; **`ProgramViewSet` gains
`search_fields=["name","code"]`** plus the standard `SearchFilter`/`OrderingFilter`
backends for parity (API-first: the list is searchable even though this MR wires no
search box onto it).

### A2 — Command-palette people tier + task overflow cue
Add a `person` command group backed by the existing `useResourceSearch`, query-gated
exactly like the task tier (built only when the palette has a query). A person result
deep-links to the org resource catalog pre-filtered: `/resources?q=<name>`
(`ResourcesPage` is updated to seed its search box from the `?q=` URL param). When the
task tier hits `TASK_RESULT_CAP`, render a non-actionable **"Showing first 8 — refine
your search"** hint so the truncation is visible. Task search stays current-project
scoped — no workspace-wide task-search endpoint exists (only per-project
`/tasks/search/` and per-program `/programs/{id}/task-search/`); building one is out
of scope for this MR and noted on #1940.

### B — `GET /projects/health-summary/`, a "my projects" summary on My Work
A new read-only `@action(detail=False)` on `ProjectViewSet` returns, for the current
user's membership-scoped readable projects only, a slim list:
`[{ id, name, health_band, at_risk_count, critical_count }]`. It runs as **one
annotated query** over `self.get_queryset()` (which already restricts to the user's
non-deleted member projects via `ProjectScopedViewSet`), reusing the exact
`status_summary` semantics — incomplete tasks with `total_float <= 5` working days
→ `at_risk_count`; incomplete `is_critical=True` → `critical_count` — with
`distinct=True` on both conditional counts (mandatory for the annotate-over-reverse-FK
shape, per `ProgramViewSet.projects`). `health_band` is derived in Python: the manual
`Project.health` override wins when it is not `AUTO`; otherwise counts-first
(`critical_count > 0 → critical`, else `at_risk_count > 0 → at_risk`, else
`on_track`). A compact `MyProjectsHealthSummary` card on the My Work page renders the
band counts using the existing semantic health tokens and drills to the worst project
(highest band, then highest critical/at-risk count) via its overview route.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **A1: `page_size=200` + count cue** (chosen) | One request; covers stated scale; honest overflow cue; minimal ripple | Latent cap at 200 (beyond stated scale) |
| A1-alt: paginated fetch-all loop | No ceiling | N sequential requests; more code; unbounded payload on a nav hook |
| A1-alt: mandatory server-search box in sidebar/palette | Truly unbounded | Large interaction redesign; loses the "browse my few projects" default; deferred |
| **B: dedicated `@action` endpoint** (chosen) | Membership scoping for free; one query; doesn't bloat `/me/work/`; cacheable | New endpoint to document/test |
| B-alt: annotate counts on the `/projects/` list serializer | No new endpoint | Every list consumer pays the aggregation; wrong default; band still not a column |
| B-alt: fold into `/me/work/` signals payload | Reuses the My Work fetch | `/me/work/` is an infinite query; a per-project grid doesn't belong per page |
| B-alt: N per-project `status-summary` calls from the client | No backend change | N+1 network fan-out; slow at scale — the exact failure the finding is about |

## Consequences
- **Easier:** navigation and the palette scale to the target account size; a PM gets
  an at-a-glance "which of mine is on fire?" triage on My Work without opening each
  project; the people search that already exists on the backend becomes reachable.
- **Harder:** one new endpoint to keep documented and tested; the list hooks now
  carry an optional param and a count accessor (kept back-compatible via `select`).
- **Risks:** the 200 ceiling is a *known* latent cap documented here, acceptable
  against the stated scale; the health-band derivation is a presentation heuristic,
  not a governance score — it must not grow into cross-program rollup (that is
  Enterprise, ADR-0030/0088). The endpoint is guarded by the existing membership
  scope; a Viewer sees only their own member projects.

## Implementation Notes
- **P3M layer:** Programs and Projects / Operations (individual's own reachable set) — OSS.
- **Affected packages:** api (ProgramViewSet search_fields; ProjectViewSet
  `health-summary` action), web (list hooks, command palette, ResourcesPage, My Work card).
- **Migration required:** no — reuses existing model fields (`Task.total_float`,
  `Task.is_critical`, `Project.health`); no schema change.
- **API changes:** yes — new `GET /projects/health-summary/`; `ProgramViewSet` gains
  `?search=`. OpenAPI schema regenerated.
- **OSS or Enterprise:** OSS (`trueppm-suite`). Boundary guard: the health summary is
  scoped to the current user's membership set and must never aggregate all-projects
  org-wide or group-by-program as a governance rollup.

### Durable Execution
1. Broker-down behaviour: **N/A** — both changes are pure synchronous reads; no async
   side effects, no dispatch.
2. Drain task: **N/A** — no async work introduced.
3. Orphan window: **N/A** — no `transaction.on_commit` / outbox rows.
4. Service layer: **N/A** — read-only viewset actions; no service dispatch. The
   `total_float`/`is_critical` fields consumed are populated by the existing
   scheduling Celery task and only read here.
5. API response on best-effort dispatch: **N/A** — synchronous `200` with the summary
   payload; no `{"queued": true}` path.
6. Outbox cleanup: **N/A** — no outbox rows.
7. Idempotency: reads are naturally idempotent; no state mutation.
8. Dead-letter / failure handling: **N/A** — no task to fail; a query error surfaces
   as a standard DRF error response and the web card renders `QueryErrorState`.
