# ADR-0631: The Schedule filters by dimming, never by hiding

- **Status:** Accepted
- **Date:** 2026-07-27
- **Issues:** #2384 (this ADR), #2332 (umbrella), #2443 / #2444 (the consumers, 0.5)
- **Extends:** ADR-0620 (label filtering beyond the Board) — locked decision 4

## Context

ADR-0620 unified the label *control* across the Board, Table/Grid and Product
Backlog: one `LabelFacet`, one predicate, one `?fl=` param. On those three
surfaces filtering means what it always means — non-matching rows leave the list.

The Schedule cannot copy that. A Gantt row is not just a list entry: it is a node
in a dependency network, and its bar's position is an *output* of the tasks around
it. Remove a non-matching predecessor from the layout and the matching bar that
depends on it still sits where that predecessor put it, with nothing on screen to
explain why. The arrow that carried the explanation is gone too, because one of
its endpoints is. A critical-path view that hides rows does not show you less —
it shows you something false.

That makes the Schedule the one target surface where the filter interaction had to
be designed rather than inherited.

## Decision 1 — dim and highlight, never hide

Non-matching rows stay laid out and positioned. Only their contrast changes. No
task leaves the task list, no bar moves, no date, float, or geometry is
recomputed when a filter is applied or cleared.

Three row states, computed by `classifyScheduleRows` in
`features/schedule/scheduleLabelFilter.ts`:

| State | Meaning | Task name + row | Bar | Marker |
|---|---|---|---|---|
| `match` | carries a selected label | full contrast | outlined | 3px leading accent |
| `context` | summary whose descendants match, itself does not | full contrast | full contrast | **none**, plus mono `N of M match` |
| `dim` | everything else | reduced contrast, text still ≥4.5:1 | dimmed, still positioned | none |

The `context` state is not a nicety. Without it a phase dims while its own
children stay lit, which reads as a rendering bug rather than as a filter result.

The tally behind `N of M match` is computed over the **full** task list, never
over the visible rows, so collapsing a context summary keeps its hint — the
behavior falls out of the data source rather than out of a collapse handler.

### The opt-in escape hatch

A `Hide non-matching rows` checkbox lives in the filter panel's footer, **off by
default** (`applyHideNonMatching`). Turning it on is the user asserting they want
a shorter list and accept losing the surrounding explanation. `context` rows
survive it: dropping a phase whose children match would orphan them in the
outline. Even with it on, the remaining bars do not move — hiding is a
presentation filter over the row list, never an input to the schedule.

## Decision 2 — arrow contrast follows the endpoints, not the row

An arrow dims only when **both** endpoints are dimmed (`isArrowDimmed`). An arrow
crossing `match ↔ non-match` keeps a full-contrast stroke.

This is the rule that makes decision 1 worth anything. The dimmed predecessor is
precisely the explanation the PM needs for why the matching bar sits where it
does; fading the arrow that connects them would discard the information the
dimming was designed to preserve.

**Critical-path styling is never dimmed away.** Critical-path emphasis and filter
highlight are independent signals and must stay distinguishable when both are on.

## Decision 3 — zero matches suppresses dimming entirely

When the filter is on but nothing matches, dimming does not apply at all. Every
row renders at full contrast and the chip strip says
`Nothing to highlight — all rows shown at full contrast`.

Dimming *every* row reads as broken rather than as an empty result — the user
sees a greyed-out screen and reaches for reload, not for the filter they just set.

This is enforced structurally, not by convention: on a zero-match selection
`stateById` is left **empty** and the host pushes `null` to the engine. A consumer
that forgets the special case still cannot dim anything, because there is nothing
in the map to dim. "Dim everything" is unreachable by construction.

## Decision 4 — the engine classifies nothing

`GanttEngine.setFilterHighlight(highlight | null)` takes pure id sets
(`{ dimmed, matched }`). React owns the classification; the engine paints what it
is told. This follows the shipped hover-chain precedent (ADR / #475) rather than
inventing a second mechanism for the same shape of problem — and it is what keeps
the classification *once per filter change* rather than per frame, which is the
60fps constraint.

Two compositional details:

- **Dim alpha multiplies the hover-chain alpha rather than overwriting it**
  (`ctx.globalAlpha *= FILTER_DIM_ALPHA`). With both signals active the row is
  dimmed by both, which is the honest composition; overwriting would let a hover
  silently un-dim a filtered-out row.
- **`FILTER_DIM_ALPHA` is 0.35, against the hover chain's 0.25.** Hover dimming is
  momentary and follows the cursor. A filter sits applied for minutes while the PM
  reads the plan, and the dimmed rows are the dependency context that has to stay
  readable. This is a de-emphasis, not a fade-out.

The match marker paints at the **viewport's** left edge, not the bar's. A matching
bar can be scrolled far off-screen horizontally, and a match indicator that
scrolls away is useless for scanning which rows matched. It is also the
non-color-dependent cue that keeps the state off contrast alone (WCAG 1.4.1) —
dimming by itself would encode the result in contrast only.

## Status of the consumer

The classification module and the engine paint channel land with this ADR. The
**consumer does not.**

The 2026-07-26 UX-flows VoC audit found that the three task views already carry
three independent filter vocabularies, none of which survives a view switch, and
recommended against adding a fourth standalone toolbar on the Schedule. The
remaining scope of #2384 — the toolbar surface, the `LabelFacet` mount, the chip
strip, the `?fl=` param and the mobile sheet — is therefore folded into **#2443**
(one shared filter vocabulary across Schedule/Grid/Board) and **#2444** (Schedule
text/owner/status filtering), both milestone 0.5.

The audit explicitly endorsed the position recorded here and recommended
generalizing it: whatever filter vocabulary the Schedule ends up with in 0.5,
**it dims rather than hides**, for the reasons in decision 1. That is why this ADR
lands now rather than waiting for its consumer — the decision is what #2443 and
#2444 need to build against, and it is the part that was expensive to reason out.

## Consequences

- `scheduleLabelFilter.ts` and `setFilterHighlight` ship **unconsumed** until 0.5.
  This is deliberate. They are covered by 23 unit tests and a stub implementation,
  so the contract is exercised even though no component mounts it yet.
- There is no geometry-invariance test yet, because there is no UI path to apply a
  filter through. The invariant is currently structural — nothing in the classifier
  or the paint channel touches layout — and #2443/#2444 must add the assertion
  when the consumer lands. Recorded as an acceptance criterion on both.
- Anything that later adds row *hiding* to the Schedule has to come back and
  amend this ADR. That is the intended friction.
