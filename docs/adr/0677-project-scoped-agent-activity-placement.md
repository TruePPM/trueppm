# ADR-0677: The project-scoped agent-oversight read lives inside the project Activity tab

## Status

Accepted (2026-07-27). Implements the placement half of #2481 (part 1 of #2415).

Builds on [ADR-0362](0362-plan-grounded-governance-one-surface.md) (governance and
oversight are one surface), [ADR-0112](0112-ai-layer-oss-extension-points.md) (the
hash-chained `AgentAction` substrate), [ADR-0421](0421-refusal-telemetry-side-car-projection.md)
(the durable refusal side-car), [ADR-0201](0201-unified-project-changelog.md) (the project
Activity tab this decision extends), [ADR-0128](0128-v2-grouped-view-bar-health-cluster.md)
(the grouped view bar), and [ADR-0139](0139-customize-views-per-user-nav-visibility.md)
(per-user nav visibility). Consumes the design note
`docs/design/agent-oversight-panel-oss.md`, which designed the **program**-scoped surface.

## Context

**P3M layer:** Programs and Projects. **Repo:** OSS.

A VoC panel (2026-07-26, Morgan — Agile Coach) raised the objection recorded on #2415:

> "An observer that only reports upward to admins, even a well-behaved one, is
> instrumentation of the team, not with the team."

Grounding that objection in `main` shows it is **not true at the API layer**.
`AgentActionViewSet` (`apps/agents/views.py`) is documented as *"the team-readable
agent-action log"*: `permission_classes = [IsAuthenticated]`, a `get_queryset` scoped by
`ProjectMembership` (plus the caller's own agent actions), and existing `?project=`,
`?program=`, `?verdict=`, `?constraint=`, `?since=` filters. Nothing about the record or
its endpoint is admin-shaped.

What *is* admin-shaped is the **placement**. The only UI projecting that log is
`/programs/:programId/agents` (`ProgramAgentsPage`, #2020) — a program tab, reached from
program nav. `docs/design/agent-oversight-panel-oss.md` §1 chose that scope deliberately
("the OSS oversight surface is a new program-scoped tab"), and for the program-manager
question it answers, it is right. But a team running one project inside that program
reaches its own agent log only by navigating *up* to the program and reading a union that
includes projects it does not work on. The team's own read is a level away from the team.

So the decision is not *whether* to expose a project-scoped read — the endpoint already
serves it — but **where that read lives in the project shell**, which is a navigation
decision governed by ADR-0128/0139 and therefore not one an implementer should make
mid-MR.

Two constraints shape it:

1. **The view bar is dense and its rows are hideable.** ADR-0128's TRACK group already
   carries five views (`today`, `risk`, `reports`, `activity`, `assets`) on a cadence
   methodology. Every non-standalone view is in `HIDEABLE_VIEW_KEYS` (ADR-0139), so a new
   top-level `agents` row is a row the user can switch off.
2. **Oversight must not be optional to reach.** The whole point of the surface is that
   the team can see what was read on its data. A destination the user can hide from
   themselves is a weak guarantee to offer in answer to a consent objection.

## Decision

**The project-scoped agent-oversight read is a second sub-view of the existing project
Activity tab, not a new top-level project view.**

- Route: `/projects/:projectId/activity?view=agents` (the tab's existing segment; no new
  route segment, so ADR-0030's route-shape rule is untouched).
- The tab gains a two-option segmented control: **Changes** (the ADR-0201 changelog,
  the default and the no-param state) and **Agents**.
- The Agents sub-view renders `AgentActivityTable`, `RefusalLog`, and `AgentActionDrawer`
  **unchanged**, fed by a new `useProjectAgentActions` hook that is `useProgramAgentActions`
  with `?program=` swapped for `?project=`.
- Within the sub-view, scope is narrowed by the host tab's own idiom — a `FilterChip`
  ("Refusals only", `?refused=1`) and a Range select — rather than a second tier of
  segmented control.

**No API change.** No new endpoint, no new model, no migration, no new audit engine. The
surface is a projection of the existing chain, per the ADR-0362 §3 rule that every
oversight view must name the query it projects: `GET /api/v1/agent-actions/?project=<id>`,
plus `&verdict=refused` for the refusals filter.

### Why Activity is the right host

The project Activity tab is already the project's "what happened here" surface. The two
sub-views answer adjacent questions with genuinely different substrates, and the
segmented control is what keeps them from being conflated:

| Sub-view | Question | Substrate |
|---|---|---|
| Changes | "What changed in this project?" | per-object historical tables (ADR-0201) |
| Agents | "Who read or acted on it, and what was refused?" | the hash-chained `AgentAction` log (ADR-0112/0421) |

They are deliberately **not merged into one stream**. A changelog entry is a mutation of
a project object; an agent action is an access record that includes reads that changed
nothing and refusals where nothing was permitted to happen. Interleaving them would
imply an agent read is a change to the plan, which is exactly the confusion the refusal
vocabulary exists to prevent.

This also preserves ADR-0362's reasoning for the program tab — *"a read surface for the
whole team, parallel to Overview/Schedule, not an admin configuration page"* — while
declining the part of it that does not transfer. A sub-view of a daily-driver tab is
still a first-class team read; it is not Settings.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **A. New `agents` view in the TRACK group** (`/projects/:projectId/agents`) | Exact mirror of the program tab; maximal discoverability; whole page reusable as-is | Sixth row in an already-dense TRACK group; lands in `HIDEABLE_VIEW_KEYS`, so a team can hide its own oversight surface — a weak answer to a consent objection; a top-level nav row promises a larger surface than one table |
| **B. Sub-view of the project Activity tab** (chosen) | No new nav row; always reachable (Activity is not hideable *away from* its own content); semantically the "what happened here" home; reuses the host tab's chip idiom | One extra click vs. a dedicated row; the tab now owns two substrates and needs a `view` param |
| **C. Panel on Board / Sprints** | Literally the surface the VoC quote names | Board and Sprints are work surfaces with no room for a log; would have to be duplicated on both; a persistent oversight panel on the daily work surface is noise, and the objection is about *reachability by the team*, not physical co-location |
| **D. Project Settings sub-page** | Cheap; settings shell already built | Re-commits the exact error being corrected — oversight as an admin configuration page. Explicitly rejected by ADR-0362 and by the design note §1 |

Option A is the closest runner-up and remains a clean migration path: if the surface
grows a third sub-view (e.g. project-scoped forecast impact when agent actuals accrue in
0.6+), promoting it to a top-level view is a route addition plus a nav entry, and the
components do not change.

## Consequences

**Easier**

- A team reads its own agent log from its own project, without navigating up to a program
  and filtering a union back down.
- The refusal vocabulary (`identity` / `policy`, ADR-0112 RC1; `constraint` +
  `projected_impact`, ADR-0421) reaches the team surface with no new plumbing — when the
  0.6 gated-write surface lands, commitment refusals appear here for free.
- #2482's consent switch, when it ships, has an obvious home: the surface that shows what
  was read is the surface that should offer the lever to stop it.

**Harder**

- The Activity tab now owns two substrates and a `view` param. Its filter chips belong to
  the Changes sub-view only, so `filtersToSearchParams` must preserve `view` rather than
  rebuild the whole param set.
- Discoverability is one level lower than a top-level row. Mitigated by the segmented
  control being visible on tab entry rather than hidden behind a menu.

**Risks**

- *A reader mistakes the Agents sub-view for a write surface.* Mitigated the way the
  program page already mitigates it: read-only, no mutation affordance, and the existing
  read-only strip when every action in view is a `GET`.
- *The two sub-views drift into one stream.* Prevented by keeping them on separate
  queries and separate components; there is no shared row type to merge.

## Implementation Notes

- P3M layer: Programs and Projects
- Affected packages: `web` only
- Migration required: no
- API changes: **no** — `GET /api/v1/agent-actions/?project=<id>&verdict=&since=` already exists
- OSS or Enterprise: **OSS**. A team's read of agent activity on its own project is OSS;
  cross-program fleet aggregation stays Enterprise (ADR-0362 §6, design note §8)

### Durable Execution

1. **Broker-down behaviour:** N/A — this is a pure read surface. It issues `GET`s against
   an existing endpoint and dispatches no async work.
2. **Drain task:** N/A — no async work is created.
3. **Orphan window:** N/A — no outbox rows are written.
4. **Service layer:** N/A — no dispatch path. The read goes through the existing
   `AgentActionViewSet`, unmodified.
5. **API response on best-effort dispatch:** N/A — no dispatch. Reads return the standard
   DRF paginated envelope.
6. **Outbox cleanup:** N/A — no outbox rows. (Chain retention itself is governed by
   ADR-0361, unchanged by this decision.)
7. **Idempotency:** N/A for task execution. On the client, the read is idempotent by
   construction: `useInfiniteQuery` keyed on `['project-agent-actions', projectId, since,
   verdict]`, so a re-render or refetch re-issues the same request and replaces the same
   cache slot rather than accumulating.
8. **Dead-letter / failure handling:** N/A for tasks. A failed *fetch* renders
   `QueryErrorState` (web-rule 246) with a retry bound to the query's `refetch`, never an
   empty state — a dead request must not be mistaken for "no agent has ever acted here",
   which on an oversight surface is the one misreading that matters.
