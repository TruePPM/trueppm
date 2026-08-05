# ADR-0801: The Classification Popover and Making Delivery Mode Visible

## Status

Accepted — 2026-08-05, implemented by #2736 and #2737 in the same MR (verified: the
`⌘⇧M` binding and row-menu entry in `ScheduleView.tsx` / `TaskListRow.tsx`, the popover
and its preview mirror in `features/schedule/classification/`, and the outline gutter and
chip in `features/schedule/RowModeIndicators.tsx`, covered by
`classificationPreview.test.ts`, `ClassificationPopover.test.tsx`,
`deliveryModePresentation.test.ts` and `e2e/schedule-classification.spec.ts`).

For 0.4, child of epic #2741 (Project Designer — declaring the hybrid split). The client
half of ADR-0790, which shipped the cascade endpoint and explicitly named the two risks
this record closes: that the cascade is invisible without #2737, and that
`parent_governance_inherited = False` is a new fact in old data that nothing yet renders.

## Context

ADR-0790 made declaring a hybrid split one API call. It did not make it an act a planner
can perform, or a result they can see. Three questions were left open by it, and each has
a wrong answer that is more obvious than the right one.

**1. Where does the preview come from?** The popover's stated purpose is to name what will
happen before it happens — "3 tasks change · 2 milestones unchanged · 0 governance
overrides kept". The cascade endpoint has no dry-run mode. Every number in that footer
therefore has to be computed somewhere, and neither available place is free of cost.

**2. What does the outline draw?** The Gantt has drawn a delivery-mode bar gutter and fill
texture since #2727, under an explicit convention: waterfall is the baseline and draws
nothing. The outline had no mark at all. Whatever it draws either matches that convention
or contradicts it, and a contradiction is worse than either choice alone, because the two
surfaces sit side by side on the same screen.

**3. What is a phase's mode?** A summary row carries its own `delivery_mode` column like
any other task. It also has descendants that may disagree with it and with each other. The
design handoff's own example makes the tension concrete: cascade scrum onto phase 4 while
4.1 keeps a gated override, and the phase's stored field now says `scrum` while the branch
underneath it is genuinely mixed.

## Decision

### 1. The preview mirrors the server; the server's report is what the receipt states

`classificationPreview.ts` reimplements `task_classification._classify_row` in TypeScript,
row for row, including both asymmetries that are easy to get backwards: the root takes
`parent_governance_inherited = false` while cascaded descendants take `true`, and
`skip_milestones` governs the governance axis only. It is called on every popover state
change and produces the footer.

**This is not the client-side classification that ADR-0790 Option C rejected.** That option
put override preservation and the milestone gate in the *write* path, where every client
would re-implement them and an MCP caller would get neither. Here the write is unchanged —
one call, server-resolved subtree, server-enforced invariants. What is duplicated is a
*prediction*, and the boundary is kept honest by never letting the prediction become a
claim about what happened: the toast after a cascade is built from the server's `report`,
not from the popover's state. If the mirror drifts, the visible symptom is a receipt that
disagrees with the preview a moment earlier — loud, local, and in front of the person who
just acted — rather than a silently wrong write.

The precedent is `lib/taskClassificationDefaults.ts`, which mirrors the server's
create-time defaults for the same reason (no endpoint to read them back from) and carries
the same keep-in-sync obligation.

### 2. The outline follows the canvas: waterfall draws nothing

A row whose delivery mode is not the waterfall baseline gets a 3px left gutter and a text
chip (`SCRUM`, `KANBAN`, `MIXED`). Waterfall gets neither, and neither does a milestone —
its diamond glyph already says what it is.

The design handoff shows a `GATED` chip on gated rows. We depart from it deliberately.
Drawing the baseline would put an identical chip on all 400 rows of a fully gated plan
while its bars, three inches to the right, show nothing — and the shape of a hybrid is
legible precisely because the branches that depart from the default are the ones that draw.
Silence for the baseline is the rule `drawDeliveryModeMark` and `ScheduleLegend` already
follow; this extends it rather than opening a second convention.

Three marks carry one fact — gutter, chip, and (on the timeline) bar texture — so the
distinction survives a color-vision deficiency and a monochrome print (WCAG 1.4.1). A
`mixed` gutter is built from the hues actually present, so `scrum + kanban` and
`gated + scrum` are visibly different branches rather than one generic "mixed" wash.

### 3. A phase reads from its descendants, and gates do not count

`computeRowModes` resolves every row in one O(n) post-order pass. A parent's mode is the
union of what its descendants contribute; it reads its own field only when nothing beneath
it contributes anything.

**Milestones contribute nothing.** `is_milestone ⟺ delivery_mode = 'milestone' ⟺
duration = 0` is one coupled fact, not a delivery mode competing with the others, and the
cascade endpoint refuses to write the axis on them for exactly that reason. If a gate
counted toward the mix, nearly every phase in every plan would read `MIXED` — the signal
would be strictly noise on the plans it exists to serve. The implementation keeps
*contributed* and *displayed* modes in separate maps, because collapsing them is precisely
how a gate leaks into its parent's rollup.

### 4. `⌘⇧M` targets the focused row, not the multi-row selection

The cascade endpoint takes one subtree root and resolves descendants itself. An arbitrary
multi-row selection has no single root to name, so the shortcut acts on `focus.state.rowId`
and the popover's own **Cascade to descendants** checkbox is the scope control. This is the
distinction the endpoint's own serializer anticipates: "the popover previews *this task*
against *this task and its N descendants*".

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **A. Mirror `_classify_row` client-side for the preview (chosen)** | No new endpoint; the footer updates as the user changes a chip, with no round trip per keystroke | A second implementation of per-row logic that must be kept in step with the server's |
| B. Add `dry_run: true` to the cascade endpoint | One implementation, authoritative by construction | A network round trip per chip click, on a surface whose entire value is that the numbers move as you choose; and a dry-run flag on a write endpoint is a second code path through the same view that no test of the real path exercises |
| C. No preview; apply and show a receipt | Nothing to keep in sync | Deletes the feature. "The preview is the feature" is the issue's own framing, and a cascade you can only evaluate after it lands is the thing planners refuse to try |
| **D. Waterfall draws nothing in the outline (chosen)** | Matches the canvas; a gated plan stays calm; departures stand out | Departs from the design handoff's `GATED` chip; a pure-scrum plan shows chips on every row with nothing to contrast against |
| E. Draw a chip on every row, including gated | Matches the handoff exactly; the mode is never ambiguous | 400 identical chips on a gated plan, contradicting the bars beside them |
| F. Draw marks only when the plan is already hybrid | Calm on uniform plans in both directions | The outline's vocabulary changes shape as data changes — a chip that appears on rows you did not touch, because someone else classified a different branch |
| **G. Parent reads from descendants (chosen)** | `MIXED` is true of what the planner is looking at; matches the handoff's own worked example | A phase's stored `delivery_mode` is not visible on its own row (it is in the drawer and in the popover) |
| H. Parent reads its own `delivery_mode` | Trivially simple; the row shows its own column | Phase 4 reads `SCRUM` while a gated branch sits inside it — the row asserts something false about the subtree it heads |
| I. `⌘⇧M` cascades over every selected row | Matches "on a selection" literally | N calls to an endpoint that runs the graph guard and enqueues a recalculation each time; no single root to preview against |

## Consequences

**Easier.** A hybrid split is declared in one act and visible immediately, which closes
ADR-0790's "invisible without #2737" risk and makes the epic's "ships whole or not at all"
condition true. `parent_governance_inherited` gains a reader as well as a writer: the
preview's "N overrides kept" is the first surface in the product that renders the inherit
bit, so the asymmetry between the two axes stops being a fact only the API knows.

**Harder.** `classificationPreview.ts` and `task_classification._classify_row` are now a
matched pair with no gate binding them. Nothing fails if one changes and the other does
not; the coupling is held by a docstring on each side and by the receipt-vs-preview
divergence being visible at the moment it happens. A drift gate is the obvious follow-up
and is not in this MR.

**Risks.**

- *The mirror can drift silently in the direction that under-reports.* The client resolves
  the subtree through `parentId` while the server walks `wbs_path`. A row whose parent is
  outside the loaded task list never joins the client's walk, so the preview under-counts
  rather than over-counts — the safe direction, and corrected by the server's report — but
  it is a real divergence with no test that can observe it from the client alone.
- *Departing from the handoff's `GATED` chip is a judgment call.* If a planner reads the
  absence of a chip as "unclassified" rather than "gated", the legend and this record are
  the only things that say otherwise. The counter-evidence would be users asking what a
  blank gutter means; nothing about the current design would surface that question.
- *A phase's own `delivery_mode` has no glance surface.* It is reachable in the drawer and
  in the popover, but a planner comparing a phase row's chip to its stored field will find
  they can disagree, by design.

## Implementation Notes

- **P3M layer**: Projects
- **Affected packages**: `web` only. No `api`, `scheduler`, `mobile` or `helm` change —
  the endpoint, its serializers and its semantics all shipped with ADR-0790 / #2735.
- **Migration required**: **no.** `parent_governance_inherited` is exposed read-only by
  the existing task serializer; this MR adds it to the client's task projection and
  nothing else.
- **API changes**: **no new routes and no schema change.** The client becomes the first
  reader of two fields the serializer already returned.
- **OSS or Enterprise**: **OSS.** Single-project plan authoring — a PM declaring the split
  inside their own program needs this to run it. Nothing aggregates across programs and
  nothing adds org-level policy.

### Durable Execution

1. **Broker-down behaviour**: N/A on the client. The cascade's own recalculation and
   broadcast dispatch are ADR-0790's, unchanged.
2. **Drain task**: None.
3. **Orphan window**: N/A.
4. **Service layer**: N/A on the client. `useClassifySubtree` is a thin mutation over the
   existing route; it applies **no optimistic cache patch**, because the server decides
   which rows the cascade actually touches and a client guess would show rows changing
   that the server is about to leave alone.
5. **API response on best-effort dispatch**: Unchanged — synchronous 200 with the report,
   which the client renders verbatim as the receipt.
6. **Outbox cleanup**: N/A.
