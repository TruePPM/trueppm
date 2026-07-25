# ADR-0620: Label filtering beyond the Board — one shared facet, per-view filter models

- **Status:** Accepted
- **Date:** 2026-07-25
- **Issues:** #2332 (umbrella), #2383 (this ADR), #2384 (Schedule), #2385 (saved views)
- **Supersedes / amends:** extends ADR-0199 (board facet bar) and ADR-0400 (task labels)

## Context

Label filtering shipped on the Board only (ADR-0400 / #1089, facet slot from
ADR-0199). The Table/Grid, Schedule/Gantt and Product Backlog had no way to answer
"show me the tasks with label X", which is the question a PM asks most often once
labels exist at all. #2331 added a server-side `?labels=` filter to
`TaskViewSet`, but nothing consumed it from those three views.

Each of the three target views already owns a *different* filter model:

| View | Filter state | URL? |
|---|---|---|
| Board | `FacetFilters` (`boardFacets.ts`), `?fa/fp/fd/fl=` | yes |
| Table/Grid | `GridFilterState` (`grid/filters.ts`), `?q/owner/status/due=` | yes |
| Product Backlog (grooming) | `GroomingFilters` (`project/backlog/filter.ts`) | **no** — deliberately local |
| Schedule/Gantt | none — **no filter chrome at all** | n/a |

So the design question was not "where does the control go" but "how much of the
filter architecture should this unify". Four decisions follow.

## Decision 1 — per-view filter models keep their own state; one shared control

Each view keeps its existing filter model. What is shared is the **control**
(`components/filters/LabelFacet.tsx`), the **predicate** (`taskMatchesLabels`) and
the **param key** (`LABEL_PARAM = 'fl'`, now defined once and imported by
`boardFacets.ts` rather than re-declared).

Rejected: a single unified `FacetFilters` across all four views. It would have
required migrating the Grid's `?owner=`/`?status=` to `?fa=`/`?fp=`, which breaks
every Grid link a user has already bookmarked or pasted into a status report — a
real cost paid for an internal tidiness nobody asked for. Adopting `?fl=`
additively costs nothing: a pre-existing `?owner=…&status=…` URL resolves exactly
as before, with no redirect and no migration notice. There is a regression test
asserting precisely that.

**Consequence:** four filter models still exist. The mitigation is that the parts
most likely to drift — the OR/AND semantics and the param name — are now single
definitions, so a fifth view cannot invent its own.

## Decision 2 — the option list is the project's full label catalog, with counts

The panel lists every label in the project (`useLabels`), each row carrying a
count computed over the rows the view has **already loaded**. A `0` is rendered
*before* the user selects anything.

Rejected: the Board's existing behavior of listing only labels present on the
loaded cards. That hides exactly the label a groomer is looking for ("which label
is nobody using?") and turns a zero-result pick into a surprise. With a visible
`0`, selecting an unused label is a deliberate act, and the resulting empty state
is explanatory rather than a dead end.

Counts come from the loaded rows, **not** from the catalog's server-side
`taskCount`, because the question the number answers is "how many rows *here*
would this keep" — a project-wide count next to a view-scoped filter would be
actively misleading.

## Decision 3 — filtering is client-side over already-loaded rows

No server round-trip, no loading state, no spinner. The Schedule already holds the
full task set for date math; the Grid and Backlog filter the fetched page.

Rejected: routing these views through the `?labels=` API filter from #2331. The
job-site persona is on a bad connection, and a filter that needs the network is a
filter that fails when they most need it. Offline degrades to a note in the chip
strip (`Offline — filtering the 214 rows already loaded`) rather than a blocked
control.

This does **not** deprecate `?labels=`: it remains the correct mechanism for
API consumers and for any future server-paginated view, and #2333 (cross-project
label view) will need it.

**Consequence:** on a view that paginates, the filter applies to the fetched page,
not the whole project. The count line states the denominator (`18 of 214 rows`) so
the scope is never implied to be larger than it is.

## Decision 4 — on the Schedule, dim + highlight; never hide

Non-matching rows stay laid out and positioned; only their contrast changes.
Matching rows get full contrast, a leading marker and an outlined bar. An opt-in
`Hide non-matching rows` checkbox lives in the panel footer, **off by default**.

Rejected: the Grid's remove-non-matching semantics (ADR-0199). On a CPM view they
would make the tool lie: a hidden predecessor still drives its successor's dates,
and the dependency arrow explaining why a remaining bar sits where it does would
vanish with it. Specifically:

- an arrow crossing match ↔ non-match keeps a **full-contrast** stroke — the
  dimmed predecessor *is* the explanation;
- a summary row whose children match but which does not itself match renders as
  **context** (full contrast, `N of M match` hint, no match marker);
- critical-path styling is never dimmed away;
- with **zero** matches, dimming does not apply at all — dimming everything reads
  as a broken render, so all rows stay at full contrast and the strip says so.

Implementation of decision 4 lands with #2384; it is recorded here because it is
the decision that most constrains the shared control's API (hence `footerExtra`).

## Deviations from the design, and why

1. **`FacetDropdown` is not reused for the panel.** The design listed it as
   reusable. It makes every option its own tab stop and has no room for a
   per-option count, a footer, or an empty-catalog explanation — and the spec
   requires a roving-tabindex/type-ahead model. Retrofitting it would have
   changed Type/Tags keyboard behavior on the program backlog, a surface #2383
   does not touch. The *visual* language is shared (same `FilterChip` trigger,
   same `FOCUS_RING`); the panel is its own component.
2. **The Product Backlog's label filter is not in the URL.** The design specified
   `?fl=` on all three views. The grooming view has *no* URL state by an earlier
   deliberate decision (documented in `useGroomingFilters`), so making labels
   alone shareable would produce a link that restores one facet and silently drops
   search, readiness and the unestimated toggle — worse than not being shareable.
   Giving that whole filter a URL is a separate change, not a side effect of
   adding one facet.
3. **The Grid has no `Owner`/`Status` facet controls to sit after.** The design's
   frames show them; in the code `ownerFilter`/`statusFilter` are only ever set by
   deep-link and cleared from the chip strip. The Label facet is therefore the
   Grid's *first* facet trigger, placed with the search field. Filed as a
   follow-up rather than invented here.

## Accessibility

- The label **name** is rendered next to its swatch in every state — option row,
  trigger, and chip. Color is never the only signal (rule 6 / WCAG 1.4.1).
- The panel is a single tab stop (roving tabindex). ↑↓ move, Home/End jump,
  Space/Enter toggle without closing, type-ahead jumps by first letter, Esc closes
  and returns focus to the trigger.
- The chip strip is a left-to-right tab sequence; the chip label is not focusable,
  its ✕ is, and Delete/Backspace on the focused ✕ also removes. Removing a chip
  re-seats focus on the next chip, or on the facet trigger when the strip empties,
  so focus never falls to `body`.
- `aria-live="polite"` with a 600ms debounce announces the outcome once the user
  stops clicking, not once per selection.
- Option rows are 44px; the chip ✕ carries a transparent 44px `before:` overlay so
  the hit area clears WCAG 2.5.8 without resizing the 24px chip.

## Alternatives considered

- **Server-side filtering via `?labels=`** — rejected by decision 3 (offline).
- **A single unified facet model** — rejected by decision 1 (breaks bookmarks).
- **Hiding rows on the Schedule** — rejected by decision 4 (makes CPM lie);
  retained as an explicit opt-in.
- **Reusing the Board's "labels present on loaded cards" option list** — rejected
  by decision 2 (hides the unused label; surprise zero-results).
