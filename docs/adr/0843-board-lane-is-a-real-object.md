# ADR-0843: A board lane is a real object — the case 16 rendering rule

## Status
Accepted

## Context

The board renders the same user-created object two ways and invents a third that is not
an object at all. Issue #2947, from `design_handoff_trueppm_v4/` case 16.

Three facts in the tree produce it:

1. **Container-ness is derived, not declared.** `task_is_phase()`
   (`apps/projects/models.py:2245`) is a live probe for structural children. A row's
   identity is therefore a consequence of what happens around it — a card now, a lane
   once someone drops work under it, a card again when that work is deleted.
2. **The board must decide now.** `buildPhases()` had to answer "lane or card?" per row
   on every render, from a fact that flips underneath it. It answered inconsistently:
   every summary at any depth became a top-level lane, while a childless row a user
   created *as* a phase stayed a card.
3. **The leftovers got a lane with no object behind it.** `{ id: 'root', name:
   'Project Tasks', summaryTask: undefined }` — nameable by nobody, reorderable by
   nobody, linkable to nothing. ADR-0115 §2 records it as "the only phase with no
   backing summary task", and ADR-0182 inherits the same construct.

Workshop mode added a fourth: it promoted childless roots to lanes, so an object's
identity depended on which mode the viewer had toggled.

## Decision

**A board lane is a real object. One rule, every view.**

- **A container is never a card**, at any depth, in any grouping. It is a lane, a
  summary row, or a timeline band.
- **Every task appears exactly once**, in the lane of its **top-level** container
  ancestor. Containers nested below that lane travel on the card as a **crumb**, so a
  four-level WBS makes five lanes rather than forty.
- **Root-level work belongs to the project node**, which is a real object — so its lane
  carries the project's own name and is absent when it holds nothing. The synthetic
  `Project Tasks` lane is deleted.
- **Workshop-mode promotion of childless roots is deleted.** Identity must not depend on
  a viewer's mode toggle.

The rule lives in `packages/web/src/features/board/laneAssignment.ts` — deliberately
separate from `BoardView.tsx`, because it is the part with invariants worth testing
without a DOM.

## Consequences

**This supersedes ADR-0115 §2 and the "Project Tasks" construct in ADR-0182.** ADR-0115's
*substantive* decision — that phase progress defers to the summary task's server-owned
ADR-0108 rollup — is unchanged and still correct. What changes is only its description of
which lanes exist and which lack a backing entity: the root lane still has no summary
task, so it keeps ADR-0115's committed-leaf-mean fallback, but it is now the project node
rather than a synthetic bucket.

**Grouping depth is fixed at 1, and that is evidence-backed rather than assumed.** Case
16's `decide:` block gates the collapsing rule on a WBS depth distribution. Measured
2026-08-18: depth 1 = 37.0% of tasks, depth 2 = 58.7%, depth 3 = **4.3%**; deepest
structural level per project is 3 for **2 of 21** projects; **94.9% of leaf rows carry no
crumb at all**. Depth > 2 is rare, so no grouping-depth selector is built. The honest
caveat: that is a development database of seeded and demo data, not a population of
production instances. Re-run before generalizing the rule further.

**What this does not fix.** Container-ness is still *derived*. This ADR makes the board
render one object one way; it does not give the object an identity it can keep. A
childless row a user created as a phase is still indistinguishable from a task, and so
still renders as a card — which is why "an empty container is legal and visible" is
explicitly **not** delivered here. A lane that ends up with no cards is one the caller
filtered to nothing, and is hidden, which is also what preserves the board's "No tasks
yet" empty state.

Declaring the role — `structure_role`, with `own_status` / `own_estimate` shadow values
and a `409` when a declaration is contradicted — is the follow-on, tracked on epic #2946
for 0.5. This ADR is the rendering half, which the design's own build order puts first
precisely because it needs no new field and no migration.

## Alternatives considered

**Keep the synthetic lane, rename it.** Rejected: the name was never the defect. A lane
that cannot be renamed, reordered, linked or scheduled teaches the user that lanes are
not objects, which is the lesson that makes the duplicate card unreadable.

**Give every container its own lane at every depth.** This is today's behavior for
summaries, and it is what the depth query was run to test. Rejected on the measurement
above: it multiplies lanes without carrying information for the 94.9% of cards that are
at most one level deep.

**Ship `structure_role` in the same change.** Rejected for 0.4: it is a model field, a
migration and a `409` contract on a beta due in thirteen days. The rendering rule stands
on its own and removes the visible defect; the field removes its cause.
