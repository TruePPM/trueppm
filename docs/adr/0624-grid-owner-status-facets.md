# ADR-0624 — Grid facets: Owner and Status become multi-select, sharing one control with Label

- **Status:** Accepted
- **Date:** 2026-07-25
- **Issue:** #2387 (found while implementing #2383)
- **Supersedes/extends:** ADR-0620 (label filter beyond the board)
- **Design of record:** Claude Design → `Grid Facets.html`, frames 1–9

## Context

`GridView` held `ownerFilter` and `statusFilter` state, mirrored both into the
URL, fed them to `matchesFilters`, and rendered a removable chip for each — but
had **no control to set either**. Grepping `setOwnerFilter` / `setStatusFilter`
returned only: seeding from the URL, the clear-all reset, and the chip strip's ✕.
The only ways to filter the Grid by owner or status were arriving via a link that
already carried the param, or hand-editing the URL; once cleared, neither could
be re-applied.

This is the live-wiring failure mode in its subtler form. The machinery was real
and correct, the *removal* affordance was real, and only the affordance that
*creates* the filter was missing — so a component-level review saw a working
filter and a screenshot looked complete.

It surfaced while implementing #2383, whose design placed the new Label facet
"in toolbar row 1 after Status". There was no Status.

## Decision

### 1. Owner and Status become multi-select, matching Label and the Board

Both were single values with an equality test. The two questions the Grid is
actually used for — "who is this blocked on, Reyes or Osei" and "everything not
done" — cannot be expressed by a single equality test at all.

All three facets are now OR *within* the facet and AND *across* facets, the same
semantic ADR-0620 established for labels.

### 2. The param format is a comma-separated list, and that is what preserves old links

`?owner=res-reyes,res-osei&status=IN_PROGRESS,ON_HOLD&fl=lab-review` — the same
shape `?fl=` shipped with. **A one-value param is just a one-item list**, so
every `?owner=Alice&status=IN_PROGRESS` bookmark parses and resolves unchanged.
No redirect, no version bump, no "your link is out of date" state to design.

One parser and one serializer for all three facets live in
`components/filters/facetParams.ts`; `labelFilter.ts` delegates to them.

**Owner matching accepts a resource id *or* a name.** The facet emits ids — a
renamed resource must not break a shared link, the trap ADR-0620 avoided for
labels — but `?owner=` shipped as a *name* match and those links exist. Accepting
both is what makes decision 2's compatibility claim true in practice rather than
only in arity.

### 3. Owner options are the whole project roster, in two groups

`On these rows` (assignees present, most matches first) then `All members`
(everyone else, alphabetical). Counts on every row, `0` shown before you pick —
the same contract as Label decision 2: you must be able to see "Ferreira has
nothing here" without selecting them to find out.

A 43-person roster needs help a 4-label list does not: the search field mounts
above 8 options, typing filters both groups at once, rows are 44px with an
initials avatar, and the list is capped at 6.5 rows and scrolled. The avatar is
decoration — **the full name is always rendered beside it**, so initials never
carry meaning alone and two people sharing initials are never ambiguous.

The catalog is the project's **resource pool** (who can own work), not
`ProjectMembership` (who has app access) — the Grid's Owner column shows
assignees, so the pool is the set the column can actually contain.

### 4. Status keeps every enum value, in fixed pipeline order

Backlog → Not started → In progress → Review → On hold → Done. Never re-sorted by
count. It is a closed enum, so a missing option reads as a bug rather than as
"none of those exist", and the sequence itself is the user's mental model of how
work moves. A zero-count status stays visible and selectable: picking it lands on
the zero-result state, which is a legitimate way to confirm nothing is on hold.

### 5. One panel at a time; three separate tab stops

Opening Status closes Owner — no stacking, no desktop scrim. The closing panel
commits nothing because there is nothing to commit: selections are already live
behind the open panel, and there is no Apply button.

`Tab` moves Search → Owner → Status → Label → Overdue → chip strip. `←`/`→`
deliberately do **not** move between triggers: they would fight the text cursor
in the toolbar's search input, which shares the tab order.

### 6. The zero-result state names the culprit

With two or more facets active, an empty intersection is where AND-across is most
likely to surprise — each facet has rows on its own, so "no results" reads as a
bug. The empty state states each facet's standalone count and offers to drop
**the facet whose removal recovers the most rows**, computed over the loaded set.
That is the single click most likely to be what the user wanted.

## Consequences

- `GridFilterState.ownerFilter: string` → `ownerIds: string[]`, and
  `statusFilter: TaskStatus | ''` → `statuses: TaskStatus[]`. The compiler finds
  every call site; ~30 test fixtures were migrated mechanically.
- `LabelFacet`'s trigger, panel, keyboard model and option row moved into
  `MultiSelectFacet`. `LabelFacet` / `OwnerFacet` / `StatusFacet` are now thin
  wrappers supplying options and copy. Three copies of a roving tabindex would
  have drifted within one release.
- `ChipStrip` renders one chip per *value* in toolbar order (search · Owner ·
  Status · Label · Overdue) and gained a `Clear all`. Focus re-seating is now
  per-facet: removing the last Status chip lands on the Status trigger, not on a
  single shared fallback two controls away.

## Deviations from the design

1. **The option list is scrolled and capped, not virtualised.** Virtualising a
   roving-tabindex list unmounts the focused option the moment it scrolls out of
   the window, dropping focus to `body` mid-keyboard-walk. At the roster sizes
   this control sees (tens of members, not thousands) the DOM cost is nil and the
   focus contract is worth more.
2. **Status values are TruePPM's enum, not the design's.** The frames show
   `Not started → In progress → In review → Blocked → Done → Cancelled`;
   TruePPM's `TaskStatus` is `BACKLOG / NOT_STARTED / IN_PROGRESS / REVIEW /
   ON_HOLD / COMPLETE`. The *rules* the design states — fixed pipeline order,
   counts, zero-counts kept — are implemented exactly; the values are ours.
3. **Mobile reuses `BottomSheet`, not `MobileFilterSheet`.** The existing sheet
   is a commit-on-Confirm working copy, which contradicts decision 5's "no Apply
   button, results already live". Below `md` each trigger opens the *same panel
   body* inside a `BottomSheet`, so a phone user and a desktop user choose from
   an identical list. Changing `MobileFilterSheet`'s model would have altered
   Type/Tags on the program backlog, a surface this issue does not touch — the
   same argument ADR-0620 made about `FacetDropdown`.
4. **A muted footer hint was added to all three panels** (`Any of the selected
   owners`, `Fixed pipeline order · zero counts kept`, `Any of the selected
   labels`). The design shows it on every frame including Label's, which is
   captioned "unchanged from ship"; the hint is what makes the zero-result
   state's "filters combine with AND across facets" line land, so it belongs on
   all three rather than none.

## Accessibility

- Every option row is ≥44px (`min-h-11`); triggers and chip ✕ buttons carry the
  standard 2px `--brand-primary` focus ring via `focus:` (not `focus-visible:`,
  rule 214).
- Color is never the sole carrier: the status dot sits beside the status name,
  the label swatch beside the label name, the avatar beside the full name
  (rule 6 / WCAG 1.4.1).
- One roving tab stop per panel; group headings are `role="group"` labels, and
  the arrow keys walk the flattened list across group boundaries — the grouping
  is visual, the keyboard walk is flat.
- `aria-live="polite"`, debounced 600ms: `2 of 214 rows — 2 owners, 1 status,
  1 label`. The tail names the *shape* of the filter rather than every value;
  the values are already in the chip strip.

## Alternatives rejected

- **Keep Owner/Status single-select and just add a control.** Cheaper, but it
  ships a toolbar where two facets behave differently from the third for no
  reason a user could infer, and it cannot answer either of the two questions the
  Grid is used for.
- **Derive Owner options from the assignees present on loaded rows.** Shorter
  list, but it makes "nobody is assigned to this" indistinguishable from "that
  person has no rows here", which is the exact ambiguity decision 3 exists to
  remove.
- **Reuse `FacetDropdown`.** Rejected for the same reasons as ADR-0620: no room
  for counts, groups, footers or empty-catalog copy, and its per-option tab stops
  would have to change under a surface this issue does not touch.
