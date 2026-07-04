# ADR-0199: Board FilterBar — client-side facet layer

## Status
Accepted

## Context
The board (issue 1091) has only two coarse toggles (My tasks, At-risk) plus
saved-view display config. There is no structured facet layer: a user cannot
narrow to a specific assignee, "everything unassigned", a priority band, or a
due window. Full-text search (#323) and groupBy (#608) bracket this gap; this
ADR is the facet layer between them.

P3M layer: Programs and Projects (single-project board). OSS.

All board cards (`committedTasks`) are already loaded client-side, so facet
filtering is a pure client-side derivation — no new endpoint, model, or async
work. Three decisions needed review.

## Decision

**1. Filter state model + URL/localStorage precedence.**
A pure predicate module `boardFacets.ts` owns the `FacetFilters` type and all
predicate logic (`matchesFacets`, `activeFacetCount`, parse/serialize to
`URLSearchParams`). URL params are the source of truth (shareable links), seeded
**once** from per-project localStorage on first mount only when the URL carries
no facet params — a shared link is authoritative and skips seeding, exactly
mirroring the existing `?sprint=` + `useDefaultBoardSprint` one-shot-ref pattern
in the same file. Every write updates both the URL (`{replace:true}`) and
localStorage. Facet params: `fa` (assignees, comma-joined, `__unassigned__`
sentinel), `fp` (priority bands), `fd` (due windows).

**2. Predicate composition — new `isFilteredOut` prop, not folded into the dim set.**
The acceptance criteria require non-matching cards at **30% opacity + aria-hidden**;
the existing `isDimmed` treatment is opacity-40 and carries no aria-hidden. A new
`isFilteredOut` prop on `BoardCard` therefore renders opacity-30 + aria-hidden and
is kept distinct from `isDimmed` (search/dep-hover). Because `aria-hidden` on a
focusable node is itself a WCAG violation, a filtered-out card is also made
non-interactive (`tabIndex={-1}`, `pointer-events-none`) and keyboard navigation
skips it. When both search and facets are active a card is bright only if it
matches both; `isFilteredOut` wins over `isDimmed` in the class join.

**3. My-tasks / At-risk toggles stay as-is (remove semantics).**
These use remove semantics (drop non-matching cards) with dedicated empty states
and 4+ e2e specs. Rewriting them into the dim model would change established
behavior and break those specs for no functional gain. They remain alongside the
new facet bar; the facet bar is additive. Unifying the two models is deferred.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| Fold facets into `effectiveHighlightIds` (single dim tier) | one code path | can't meet 30% + aria-hidden AC; conflates search precedence |
| localStorage-only (no URL) | simpler | not shareable — AC requires shareable links |
| Rewrite My-tasks/At-risk as dim facets | one filter model | breaks remove-semantics + 4 e2e specs; out of scope |
| Server-side facet query | scales to huge boards | board is already fully client-loaded; needless round-trips, breaks offline |

## Consequences
- Easier: adding a facet later is one predicate + one param key; all logic is unit-testable in isolation from React.
- Harder: two filter models coexist (remove vs dim) until a future unification.
- Risks: priority "bands" are derived from the integer `priorityRank` (no server
  band exists) — the High/Medium/Low/Unranked cutoffs are a documented client
  convention in one exported function, easy to rebind if a server band lands.
  Label facet is **descoped** — no task-labels field/model exists on main (hard
  dependency on issue 1089). Due-window rebinds to the real deadline field when
  #690 lands.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: web
- Migration required: no
- API changes: no
- OSS or Enterprise: OSS

### Durable Execution
1. Broker-down behaviour: N/A — pure client-side derivation, no async side effects.
2. Drain task: N/A — no async work.
3. Orphan window: N/A.
4. Service layer: N/A — no server dispatch.
5. API response on best-effort dispatch: N/A — no API call.
6. Outbox cleanup: N/A.
7. Idempotency: N/A — filter state is pure derived UI state; re-applying is a no-op.
8. Dead-letter / failure handling: N/A. localStorage/URL write failures are swallowed (best-effort persistence), matching sibling board prefs.
