# Rule 464 — Over-allocation renders through the shared Overalloc primitives, with ▲ and color

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Signal encoding*. The index carries the rule's headline; this file carries its full text (#1235, #4761).

**Scope.** This rule governs the surfaces that have been migrated: `CardAssignees`, `ResourceOverallocationDrawer`, `LoadHeatMap` and `RmHome`/`PeoplePage`. Unmigrated surfaces still render their own treatment, and this list is not exhaustive: the project Resources allocation table (`ResourceCell`, `HeatmapCell`), `page2/Avatar`, `ResourceAssignmentSection`, `ProgramResourcesPage` (a browser-side `detectOverallocatedAssignments` "Over-allocated" chip), `ResourcesKpiRow`, `ResourcesHeatmap` and `AllocationSpan`. Migrating them is tracked in #1235.

**A migrated surface that says a person is over capacity renders `OverallocBadge` (a corner `marker` on an avatar, or a `chip` with a value) or `OverallocBanner` (a count line) from `src/components/Overalloc.tsx`. Each pairs the ▲ glyph with the critical color, never color alone (rule 120). A load heat-map cell bins the server's `load_pct` with `loadBand` (`src/features/people/loadBand.ts`), whose two over bands carry the ▲ in the cell; it never derives a load or an over-allocated verdict from hours.**

**Why.** Over-allocation was a color-only red dot on the board card, a tinted pill elsewhere, and a third treatment planned for the resources page (#1235). A dot that differs only by color fails WCAG 1.4.1 and reads three ways on three screens. The Pass 1 heat map legend (`<40 · 40–59 · 60–79 · 80–100 · ▲ 101–115 · ▲ >115`) already writes the glyph into the language, so the glyph is the shared part.

**How to apply.**

- (a) The verdict is the server's: `overallocated`, `over_allocated_count`, or a peak factor the caller already has. The primitives only draw it.
- (b) `OverallocBadge variant="marker"` is `aria-hidden`; the avatar it sits on owns the accessible name ("Pat Chen, overallocated").
- (c) `OverallocBanner` renders nothing at zero.
- (d) Heat-map cells use the chart-layer palette tokens (`heatFill` / `heatInk`, #4767), never a color defined in the component.

Reference: `src/components/Overalloc.tsx`, `src/features/people/LoadHeatMap.tsx`, `src/features/board/card/CardAssignees.tsx`.
