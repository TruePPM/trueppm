# ADR-1198: The demo preview overlay carries board status, not only dates

## Status

Accepted (2026-09-21)

> **Implementation status (2026-09-21, #3967):** shipped with this ADR. Verified against
> `packages/web/src/stores/demoOverlayStore.ts` (the `status` field on `DemoOverlayEntry`
> and its application in `applyDemoOverlay`), `packages/web/src/hooks/useBoardTasks.ts`
> (the refusal branch on `useUpdateTaskStatus`), and
> `packages/web/src/lib/demoReadOnly.ts` (the board-scoped refusal string). No API,
> serializer, model, or permission change — the refusal this rides on is ADR-1197 D2's,
> unchanged.

## Context

**P3M layer: Programs and Projects (OSS).** Single project, its board, its active
sprint. No cross-program aggregate, no org policy — the classification test ("would a PM
or program manager need this to run their program?") is not even close here: this is a
*demo affordance*, it ships in the OSS web bundle, and it reads no data a project member
cannot already read.

ADR-1197 D4 made the Schedule drag the read-only demo's centerpiece: the visitor drags a
bar, the CPM cascade recomputes in the browser, the commit `PATCH` is refused by D2, and
the dropped position **stays on screen** rather than snapping back. `demoOverlayStore`
(#3926) is the layer that makes the last part true — a map above the query cache that
survives the mutation's own rollback, the fallback refetch, and SPA navigation.

D4 scoped that win honestly and, in the same breath, named what it does not cover:

> The preview covers the schedule cascade and nothing else. Do not let marketing
> generalize it to "try the product" — the panel's second-, third- and fourth-ranked
> personas each need a server write the mode refuses, and a visitor who arrives
> expecting to groom a backlog and cannot will read D3's refusal as the product being
> broken, which is the exact failure D3 exists to prevent.

That is ADR-1197's own pre-ship persona panel, blocker #1 — *"Read-only forecloses the
interaction each persona needs to believe the engine works"* — and the ADR's recorded
response was **"D4 answers Sarah only."** #3967 exists because nothing re-checked that
gap against the shipped code, and it is still true post-ship. Verified against
`main@e7d384d33`: `grep -rln "useDemoOverlayStore\|isDemoReadOnlyRefusal"
packages/web/src` returns exactly four consumers, all on the Schedule/task-date path plus
the generic interceptor. There is no board, backlog, or sprint consumer.

Two concrete defects follow from that, both verified by reading the tree:

1. **A board card snaps back.** `useUpdateTaskStatus`
   (`packages/web/src/hooks/useBoardTasks.ts`) applies an optimistic patch in `onMutate`
   and restores the pre-move snapshot in `onError`. In the demo the `PATCH` is always
   refused, so the card the visitor dragged into Done slides back to where it was — the
   exact snap-back D4 calls "reads as a bug and destroys exactly the impression the
   feature exists to create", on the one surface a Delivery Lead touches every day.
2. **The demo tells the visitor to try again, in red.** That same `onError` fires
   `toast.error("Couldn't move the card — try again.")`. The response interceptor
   (`packages/web/src/api/client.ts:138-142`) *separately* fires
   `toast.info(DEMO_REFUSAL_TOAST)`. So a refused board move in the demo raises **two**
   toasts, and the louder one is a red instruction to retry an action that can never
   succeed. This is D3's failure mode — a visitor concluding the product is broken —
   produced by the demo's own code.

The forces in tension:

- **ADR-0599.** Client-side compute in this product is preview or offline stand-in,
  never source of truth; the server always has the last word. Whatever the board shows
  after a refusal must be visibly a preview, must never be persisted, and must be
  unreachable outside demo read-only mode.
- **D4's named asymmetry**, stated in `useTaskMutations.ts::captureDemoOverlay`: *"only
  dates and duration persist this way. A refused rename, **status** or percent edit rolls
  back and gets the global toast."* That rule is deliberate and it is what this ADR
  revises, so the revision needs a record rather than a quiet edit to a docstring.
- **Scope.** #3967's own fence is "one interaction, not a suite." The failure mode here
  is generalizing `demoOverlayStore` into an overlay framework, which would buy an
  unbounded surface of half-true previews for a demo.

## Decision

**`DemoOverlayEntry` gains exactly one field — `status` — and the board card status move
becomes the demo's second interactive surface. Nothing else changes.**

Concretely:

1. **The overlay carries `status`.** `applyDemoOverlay` lays it over a fetched task the
   same way it already lays over `start` / `finish` / `duration`: a value field on a row
   that is otherwise untouched.
2. **`useUpdateTaskStatus` captures the refusal.** Its `onError` routes a
   `demo_read_only` 403 — gated on **both** `isDemoReadOnlyRefusal(err)` and
   `isDemoReadOnlySync()`, exactly as the two existing capture sites are — into the
   overlay, and returns before the cache rollback's red toast. The rollback itself is
   untouched: the overlay is an explicit layer *above* the cache, and the cache stays
   truthful about what the server actually holds.
3. **The board gets its own refusal sentence.** The request sets
   `demoRefusalHandled: true` so the generic interceptor toast stands down, and the board
   raises one scoped `info` notice naming what just happened on *this* surface. Copy is
   settled by `ux-design`; the requirement is that it says the card stayed and the counts
   here recalculated, and never says "try again".
4. **Status only — not `parentId`, not `sprintId`, not `boardLane`.**
   `optimisticStatusPatch` carries all four. The overlay takes the first and refuses the
   rest, for the reason `applyDemoOverlay`'s docstring already gives about the Schedule:
   it applies to **value fields only and never to identity, parentage or array order**.
   `parentId` and `sprintId` move a card between *collections*, and an overlay that can
   do that would have to answer what a sprint the server says the card is not in should
   count, points and all. That is a second source of truth wearing a preview's clothes.

### What recomputes, stated as honestly as D4 stated its own limit

Everything the board derives **from the task list** reacts, because `BoardView` reads
`useScheduleTasks()` and that is where the overlay is already applied:

- the card's column membership — it stays in the column the visitor dropped it in;
- per-cell and per-column counts, and with them the shared three-band `wipState()` — a
  third card dragged into a column with a WIP limit of 2 flips the cell to `over` and
  stays there;
- the toolbar's active/backlog counts.

**The burndown chart and the velocity series do not react, deliberately.**
`useSprintBurndown` reads a server-computed nightly *snapshot series*
(`/sprints/{id}/burndown/`), and `sprint.wip_count` / `sprint.committed_points` on the
sprint panel header are likewise server fields. Deriving a replacement series in the
browser is precisely the second source of truth ADR-0599 forbids, and it is the same
call D4 already made one layer down: *"replaying a partial cascade afterwards would be a
worse lie than one stable bar."* A burndown line that disagrees with the sprint panel
beside it would be a worse lie than a board whose columns are right.

This is a real limit on what the demo shows a Product Owner, and the docs and the login
copy must not overstate it (see Consequences).

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Overlay `status`; board counts and WIP bands are the recompute (chosen)** | One field, one new capture site, zero new architecture. Reuses the store, the both-facts gate, and the one application point that already exist. The gesture is the Delivery Lead's daily one. Honest about the burndown. | The burndown and velocity still do not move, so the Product Owner's "watch the forecast react" is only partly answered. |
| B. Overlay `sprintId` too — drag a story from the backlog rail into the active sprint | Answers the Product Owner's grooming gesture head-on; the issue names it first. | Moves a card between collections, which `applyDemoOverlay` explicitly refuses. Forces an answer to "what do committed points read when the server says the card is not in the sprint" — i.e. a client-side sprint membership, which is a second source of truth. Two overlaid query keys, not one. |
| C. Derive a client-side burndown series from the overlaid task list | Fully answers "watch burndown react"; most persuasive demo. | Invents a snapshot series the server never produced, from a task list that carries no history. Contradicts ADR-0599 and D4's own cascade reasoning. Unbounded: every forecast chip beside it would then disagree or need the same treatment. |
| D. Disable board drag in the demo (the `DEMO_DISABLED_NOTE` path) | Honest, trivial, zero preview risk. | Leaves #3967 unfixed: the personas still get no interactive surface, which is the whole finding. Also a regression against D4's spirit — the demo exists to be touched. |
| E. Generalize the store into a typed per-surface overlay framework | Every future surface is cheap. | Exactly what #3967's scope fence forbids, and it buys an unbounded surface of half-true previews to serve a demo. |

## Consequences

**Easier.** A Delivery Lead evaluating the demo can walk the board, mark work done, and
watch the columns and WIP bands recalculate under them — without a red toast telling them
to retry something that cannot succeed. Two of the three demo defects above are closed by
the same change; the third (the double toast) is closed by the `demoRefusalHandled` flag
that already exists for the Schedule popover.

**Harder.** `DemoOverlayEntry` now has a second *kind* of field in it, and the next person
who wants to add a third has a precedent to point at. The mitigation is this ADR's
Decision §4, which states the test — **value field, never identity, parentage or array
order** — rather than leaving it to be re-derived from the shape of what happens to be in
the map.

**Risk, and the thing to watch.** The demo now shows a board state the server does not
hold, on a surface with more derived numbers on it than the Schedule has. Every one of
those numbers that is *server*-computed (`wip_count`, `committed_points`, the burndown)
keeps showing the server's answer while the columns beside it show the visitor's. That
disagreement is bounded and defensible — it is the same shape as the Schedule's, where
the dragged bar moves and the CPM-computed float chips do not — but it is a real seam,
and it is the reason the copy fence below is not optional.

**Copy is now wrong until it is updated, and that is a sequencing finding, not an aside.**
ADR-1197 D4 instructs the docs to headline the demo as *the schedule recomputes, nothing
is saved*, and #3970 is concurrently rewriting the login marketing copy to name the
Schedule as **the one** interactive surface. After this ADR that sentence is false: there
are two. The copy must name both, and must say the board's counts recalculate while the
burndown does not — the honest scoping D4 demanded, applied to a second surface.

**Bounded blast radius on a real install.** Both gates are `isDemoReadOnlySync()` **and**
`isDemoReadOnlyRefusal(err)`, never the code alone. On any deployment that is not the
demo, `isDemoReadOnlySync()` is `false` — including when `['edition']` has not resolved —
so a mislabeled 403 cannot fabricate a board state the server does not hold. That is the
same reasoning `captureDemoOverlay` already carries, and it is why the check is repeated
rather than loosened into a helper that takes one fact.

## Implementation Notes

- **P3M layer**: Programs and Projects
- **Affected packages**: `web` only
- **Migration required**: no
- **API changes**: no — the 403 this rides on is ADR-1197 D2's, unchanged. No serializer,
  view, permission, or model is touched.
- **OSS or Enterprise**: OSS (`trueppm-suite`). A demo affordance in the community web
  bundle; no cross-program aggregate, no org policy, no governance surface.

### Durable Execution

1. **Broker-down behaviour**: N/A. No async dispatch. The change is a client-side store
   write inside a mutation's `onError` and a string; nothing is queued, nothing is
   committed server-side. The write path this rides on is a 403 that never reaches a
   model.
2. **Drain task**: N/A — no async work, so nothing to drain.
3. **Orphan window**: N/A — no outbox rows.
4. **Service layer**: N/A on the API side. The client-side equivalent is
   `demoOverlayStore`, and this change goes through it rather than adding a parallel
   store — which is the point of the ADR.
5. **API response on best-effort dispatch**: N/A — no endpoint added or changed.
6. **Outbox cleanup**: N/A. The analogous concern is the in-memory overlay, which is
   capped at `DEMO_OVERLAY_CAP` (200, FIFO) and cleared by a page reload — the mode's own
   reset. Nothing touches `sessionStorage` or IndexedDB.
7. **Idempotency**: The store `set` is last-write-wins per task id and re-enters a
   repeated write at the end of the insertion order, so a visitor dragging the same card
   three times converges to the third drop. Replaying the same refusal is a no-op.
8. **Dead-letter / failure handling**: N/A. A refusal *is* the expected outcome here; a
   non-demo failure falls through to the existing rollback-and-toast path untouched.

### On Acceptance

- [x] Open issues naming this ADR re-read against the settled decision:
      `python3 scripts/adr-accepted-issue-sweep.py --adr 1198` — **0 issues**. The ADR is
      written with #3967 rather than before it, so there is no pre-ADR scope to correct.
- [x] Any issue carrying pre-ADR scope rewritten — **0**, per above.

## Related

- ADR-1197 — the demo mode itself; D3 (the refusal is a product surface) and D4 (the
  preview outlives the refusal) are what this extends, and D4's named asymmetry is what
  it revises.
- ADR-0599 — the API-first boundary. The board preview joins the Gantt drag preview as
  the same sanctioned kind of client compute: preview, never persisted, server has the
  last word.
- ADR-0220 — the board's offline card-status queue. Deliberately untouched: offline
  queues a move to replay later, the demo refuses one permanently, and conflating them
  would have the demo building an IndexedDB outbox of writes that can never flush.
- ADR-0067 — the Schedule's pull-to-commit popover, the anchored affordance the board
  has no equivalent of, which is why the board's refusal is a scoped toast instead.
