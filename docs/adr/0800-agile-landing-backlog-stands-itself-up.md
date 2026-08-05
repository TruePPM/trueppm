# ADR-0800: Agile landing — the backlog stands itself up, without a new shared Designer

## Status

Accepted — 2026-08-05, for #2734 (0.4); child of epic #2740, sibling of #2728/#2729/#2731/#2733.

## Context

#2734's problem statement: an agile project lands on the same empty "add your first
task" card as a waterfall one after creation, and the Start sheet's creation vocabulary
(Program, Schedule, Planning model) leaks into that first impression. The issue's Scope
section, written against the Project Designer v5 handoff, asserts "same Designer, same
task tree, same row entry" with only the column set and right-hand overlay differing.

Reading the codebase as it stands on `main` (post-#2728 Start sheet, post-#2733 blank
canvas, post-#2735 classification cascade API) surfaces three load-bearing facts the
issue's framing does not anticipate:

1. **There is no single shared "Designer" component.** Waterfall's row-entry/task-tree
   lives in `packages/web/src/features/schedule/` (`ScheduleView.tsx` +
   `TaskListPanel.tsx`/`TaskListRow.tsx`, the Gantt canvas + build-mode outline). Agile's
   equivalent is `packages/web/src/features/project/backlog/ProductBacklogPage.tsx`
   (ADR-0105/0110, #494/921/922/1044/1291) — a fully-built, independently-shipped
   grooming surface with epics, stories, points, a Definition-of-Ready gate, a
   grooming-health strip, and an already-mounted `SprintPlanningRail`
   (`ProductBacklogPage.tsx:1256-1263`). These are two different React trees; unifying
   them into one shared component is a rewrite far outside this issue's size, and
   `methodologyTabs.ts`'s tab matrix (Schedule hidden for AGILE, Backlog/Sprints hidden
   for WATERFALL) already treats them as structurally distinct destinations, not two
   skins of one view.
2. **The column set and the sprint rail this issue asks for already exist.**
   `ProductBacklogPage`'s grid header (`gridCols()`, line ~106) is
   `# · ID · Story · Acceptance · Readiness · [Score] · Pts · {iterationSingular} ·
   Owner` — Pts and the iteration column (Sprint by default, ADR-0111-configurable) are
   already there, and Readiness (Definition-of-Ready state) is the closest existing
   analog to "State." `SprintPlanningRail` is the "sprint rail" the issue names,
   already wired as the page's right-hand overlay whenever a sprint is being planned.
3. **The `⌘⇧M` hybrid-declaration entry point does not exist anywhere in the frontend
   yet.** Its API half (#2735, "Epic C — the hybrid declaration. The API half") merged
   in `b416c8113`. Its frontend halves — #2736 ("the classification popover") and #2737
   ("make delivery mode visible... gutter, chip") — are both still **open**, tagged
   `status::wip`. No toolbar, menu, or keyboard binding for this exists on *any*
   surface today, waterfall included. "Keep it reachable, don't rebuild it" presupposes
   an artifact that #2736 has not shipped.

Separately: `NewProjectModal.tsx`'s `handleSubmit` fires `useApplyTemplate().mutate(...)`
without awaiting it (ADR-0789 §4 — "fire-and-navigate," the sheet must never block on
seeding) and then always calls `onCreated(data.id, intent)`. `CreateDispatcher.tsx`'s
`project` intent branch always navigates to `/projects/{id}/overview` (or
`/schedule?import=csv` for the CSV-import intent) — methodology is not consulted at all.
So today, an agile project with a template just applied lands on Overview, and if it were
instead routed straight to `/product-backlog`, it would land on that page's genuine
`allEmpty` branch ("No stories yet") for however long the WS-streamed seeding job takes
to deliver its first rows — the empty-card problem restated one route over. No code
anywhere distinguishes "this backlog is empty because nothing has been added yet" from
"this backlog is empty because the seed job hasn't delivered its first row yet," for
either the schedule surface (#2731's concern) or the backlog surface (this ADR's).

## Decision

1. **No new shared "Designer" component.** `ProductBacklogPage` is accepted as the
   already-correct landing surface for AGILE. "Same Designer, same task tree, same row
   entry, same delivery-mode field" is satisfied at the level the codebase actually
   shares things — the `Task` model, `useIterationLabel()`, `isTaskScheduled()`, the
   methodology-routing system (`methodologyTabs.ts` / `lensOrder.ts`) — not a literal
   shared React tree with `ScheduleView`. Building one is out of scope for this issue.
2. **No new column set or rail.** `ProductBacklogPage`'s existing grid columns and its
   existing `SprintPlanningRail` satisfy "Sprint / Points / State" and "sprint rail
   instead of the timeline" as shipped. This is a documented interpretation, not a
   silent scope cut — flagged explicitly in the MR for review.
3. **Post-creation routing becomes methodology-aware.** `CreatedProjectIntent`
   (`NewProjectModal.tsx`) grows two optional fields — `methodology` and
   `templateApplied` — set only on the `way === 'template'` path.
   `CreateDispatcher.tsx`'s `project` branch adds one case: AGILE + `templateApplied` →
   navigate to `/projects/{id}/product-backlog?seeding=1` instead of `/overview`. The
   non-agile branch (WATERFALL/HYBRID + `templateApplied`) is left as a clearly
   commented, empty hook for #2731 to fill in — this file is a near-certain overlap
   point between the two issues and is called out as such in the MR.
4. **A seeding-aware empty state, not a poll.** `ProductBacklogPage` reads the
   `?seeding=` param. While it is present and the backlog is genuinely empty
   (`allEmpty`), it renders a lightweight "setting up" indicator instead of the "No
   stories yet" `EmptyState`. No new polling hook is introduced: the WS handler already
   invalidates `['product-backlog', projectId]` on every task broadcast
   (`useProjectWebSocket.ts:472`), so the first seeded row's arrival flips `allEmpty` to
   `false` and the seeding branch stops rendering on its own. A client-side 10s timeout
   is the only new state — if nothing has arrived by then (dispatch failure, already
   toast-surfaced by `NewProjectModal`), the branch falls back to the ordinary empty
   state so a failed apply never strands the user on a permanent "setting up" message.
5. **"Not in a sprint" reuses the codebase's existing scheduled/unscheduled predicate.**
   `isTaskScheduled()`/`taskScheduleState()` (`@/lib/task.ts`) already define "scheduled"
   as `plannedStart != null || sprintId != null` — the exact dual concept the Unscheduled
   gutter (`UnscheduledGutter.tsx`, waterfall) reads. A new `NotInSprintStrip` applies the
   same predicate to backlog stories, giving the issue's "the unscheduled strip
   re-labels" a real, literal shared primitive instead of a coincidentally similar copy.
   Its copy is driven by `useIterationLabel()`, never the literal word "sprint" —
   required by the `no-restricted-syntax` iteration-label eslint gate, which already
   covers `src/features/project/backlog/**/*.tsx`, and consistent with ADR-0203's
   renaming of the SPRINT nav group to DELIVER for the same configurability reason. The
   strip counts unestimated stories (`storyPoints == null`) among the not-yet-assigned
   set, mirroring `HealthStrip`'s existing "Unestimated" stat but scoped to this subset.
6. **`⌘⇧M` is disclosed as not-yet-reachable, not built.** #2736 (the popover this
   shortcut would open) is unmerged. Building the shortcut here would mean building
   #2736's UI to have something for it to open — explicitly out of scope per the issue's
   own "do not build the classification cascade UI" instruction. The MR documents this
   gap and leaves a `TODO(#2736)` pointer at the point in `ProductBacklogPage`'s header
   toolbar where the entry point belongs, so #2736's implementer has a marked landing
   spot on the agile surface rather than having to rediscover it.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **A. Reuse existing ProductBacklogPage/SprintPlanningRail as-is; add routing + seeding-empty-state + new strip (chosen)** | Small, reviewable diff; no regression risk to a mature, tested surface (ADR-0105/0110); ships the actual user-facing gap (landing + first-impression vocabulary) | Departs from the issue's literal "same Designer" wording — documented explicitly rather than silently |
| B. Build a new unified row/column component shared between `ScheduleView` and `ProductBacklogPage` | Would satisfy the issue's wording literally | A multi-week rewrite of two mature, independently-evolved surfaces for one landing-experience issue; high regression risk to both waterfall and agile authoring; no evidence in the design handoff that this level of unification was actually intended (case 05 covers backlog stand-up + cadence generator, not a shared grid rewrite) |
| C. Await `applyTemplate.mutateAsync()` before navigating, so the destination is never empty | Removes the seeding-window problem structurally | Breaks ADR-0789 §4's fire-and-navigate contract; reintroduces the blocking-spinner UX #2729 deliberately removed |
| D. Poll `useTemplateApplication(applicationId)` on the backlog page instead of a boolean + timeout | Gives a precise success/failed/undone signal instead of an inferred one | Extra request + polling lifecycle for a signal the WS invalidation already delivers implicitly (first row arrives → `allEmpty` flips) for the common case; kept as a documented future option if failure-visibility needs to be finer-grained than the existing create-time toast |
| E. Build the `⌘⇧M` shortcut and a placeholder popover now | "Technically" satisfies the issue line | Directly violates the issue's own out-of-scope instruction; ships dead UI that #2736 would then have to replace |

## Consequences

- `CreateDispatcher.tsx` becomes a shared junction for both this issue and #2731 —
  flagged in the MR description as an expected, near-certain conflict/overlap point for
  the concurrently-running sibling worktree.
- `ProductBacklogPage.tsx` gains one query param, one timeout-guarded boolean, and one
  new mounted child (`NotInSprintStrip`) — additive, no change to its existing
  epic/story/drag/rail logic.
- No API or migration changes: every field the new UI reads (`sprintId`, `storyPoints`,
  `GroomingHealth.unestimated`) is already returned by
  `GET /projects/{id}/product-backlog/`.
- The `⌘⇧M` gap is a documented, tracked dependency on #2736 rather than a silently
  missed acceptance line — #2736's implementer has a marked TODO to close it.
- Risk: the "same Designer" interpretation gap (decision #1/#2) is the one place this
  ADR most likely to be second-guessed in review; it is called out explicitly rather than
  left for a reviewer to discover independently.

## Implementation Notes

- P3M layer: Programs and Projects (single-project creation flow); Agile/Hybrid delivery
- Affected packages: web only (`packages/web/src/features/shell/`,
  `packages/web/src/features/project/backlog/`)
- Migration required: no
- API changes: none — all consumed fields already exist on the product-backlog response
- OSS or Enterprise: OSS (backlog/product-backlog is an OSS surface; no enterprise
  boundary touched)

### Durable Execution

1. Broker-down behaviour: N/A — no new dispatch; reuses the existing template-apply
   outbox path (#2729/ADR-0789), unchanged here.
2. Drain task: N/A — no new async work introduced.
3. Orphan window: N/A — no `transaction.on_commit()` involved in this change.
4. Service layer: N/A — frontend-only change.
5. API response on best-effort dispatch: N/A — no new endpoint.
6. Outbox cleanup: N/A — no new outbox row.
7. Idempotency: N/A — no new write path.
8. Dead-letter / failure handling: N/A — a failed template-apply dispatch is already
   surfaced via `NewProjectModal`'s existing `toast.error(...)`; the new seeding
   indicator's 10s timeout is a display-only fallback, not a retry or failure handler.
