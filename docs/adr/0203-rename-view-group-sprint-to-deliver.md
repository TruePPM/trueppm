# ADR-0203: Rename the view group "Sprint" → "Deliver"

## Status
Accepted (amends ADR-0195 §group-label; part of the Shell Redesign v2, #1640/#1641)

## Context

ADR-0128 introduced the v2 grouped view bar (PLAN / TRACK / PEOPLE); ADR-0195 added a
methodology-adaptive fourth group, `SPRINT`, co-locating the daily cadence circuit
(Backlog → Sprints → Board) as one cognitive object on AGILE/HYBRID projects. That
group id and its rendered label were both `SPRINT` / "Sprint".

The Shell Redesign v2 handoff (`design_handoff_shell_redesign/`) moves the project view
tabs out of the top bar and into the left rail, and in doing so re-examined the group
labels. Two problems with "Sprint" as a **group header**:

1. **It collides with the view inside it.** The group named "Sprint" contains a view
   named "Sprints/Iterations". A group label and a child label that read as the same
   word are ambiguous in the rail's vertical list.
2. **It hard-codes agile jargon into a terminology-neutral shell.** The iteration term
   is configurable per workspace/program/project (Sprint / Iteration / Cycle / PI —
   ADR-0111/0116), and the *view* already adopts that term via `useIterationLabel`. A
   fixed group header of "Sprint" contradicts a workspace that has renamed its cadence
   to "Cycles", and it imposes Scrum vocabulary on a Hybrid or Kanban workspace.

The Voice-of-Customer panel run for #1640 reinforced this: Alex (Scrum Master), Jordan
(Product Owner), and Morgan (Agile Coach) all flagged that a generic delivery grouping
must keep a distinct cadence identity **without** the group header being the configurable
iteration term.

A companion question — *"should `schedule` also appear under this group?"* — was
answered separately: **no, by default.** Fusing the PM's plan (Gantt) with the team's
execution recreates the "waterfall-with-a-board-bolted-on" pattern the personas reject
(ADR-0036 hybrid philosophy). Schedule stays in PLAN; a per-user *opt-in* to also
surface it under Deliver is tracked in #1645 (extends ADR-0139), not this ADR.

## Decision

Rename the group `SPRINT` → **`DELIVER`** in `packages/web/src/features/shell/methodologyTabs.ts`:

- `ViewGroupId` union member `'SPRINT'` → `'DELIVER'`; the rendered `label` and derived
  `aria-label` become **"Deliver"** / "Deliver views".
- **The group label is always the fixed word "Deliver", never the configurable iteration
  term.** This is a shell invariant (§12 invariant #5 of the handoff): the iteration term
  lives on the *view* (`useIterationLabel`), the group header does not.
- No view moves. `product-backlog`, `sprints`, `board` already compose this group;
  `schedule` stays in `PLAN`; `board` still falls to `TRACK` on WATERFALL (which has no
  Deliver group). Group render order is unchanged: **PLAN · DELIVER · TRACK · PEOPLE**.
- The composition path is unchanged: the rail and the tab bar both source
  `groupedVisibleViewsForUser(methodology, hiddenViews)`, so the methodology filter
  (ADR-0041), per-user hidden set (ADR-0139), per-project surface toggles (ADR-0193), and
  the role-context lens (ADR-0162) all still compose. "Deliver" is presentation only.

"Deliver" is verb-consistent with "Plan" and "Track", giving the rail a Plan → Deliver →
Track arc (shape it → run the cadence → watch it) that reads as a delivery flow rather
than three unrelated buckets.

## Consequences

- **Purely presentational, frontend-only.** No route segments change (rule 108); route
  links stay `/projects/:id/:view`. No backend change: the server `HIDEABLE_VIEW_KEYS`
  (`profiles/constants.py`) is keyed by *view*, not group, so the hideable vocabulary is
  untouched.
- **Test/e2e churn.** Every assertion on the group id `'SPRINT'` or the accessible name
  `"Sprint views"` updates to `'DELIVER'` / `"Deliver views"`
  (`methodologyTabs.test.ts`, `lensOrder.test.ts`, `ViewTabs.test.tsx`, `TopBar.test.tsx`,
  e2e `view-switching.spec.ts`). A new invariant test asserts the Deliver label is the
  fixed word and no group label is ever an iteration term.
- **Sets up the rest of the redesign.** This is step 1 of the handoff's implementation
  order — pure and testable, landed on its own before the rail (#1642), top bar (#1643),
  status chip (#1644), and the Schedule-in-Deliver opt-in (#1645).
