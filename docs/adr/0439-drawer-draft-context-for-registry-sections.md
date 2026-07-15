# ADR-0439: Batched-edit draft for registry sections via TaskDraftContext

## Status
Accepted

Extends ADR-0050 (task-detail section registry) and the web-rule 217 editable-
surface contract. Complements ADR-0437 (#1978 non-modal drawer) — that ADR owns
the drawer container; this one owns how a registry-driven section opts its scalar
fields into the drawer's batched Save.

## Context

#1977 put the task drawer's `name` and `notes` behind an explicit Save/Cancel
bar (a drawer-level `useDirtyDraft`, the `DialogFooter` + `UnsavedChangesDialog`
contract, web-rule 217). Those two columns are rendered **curated inline** by the
drawer, so the drawer owns their draft directly.

The three-point estimate fields (Optimistic / Most Likely / Pessimistic) were
deliberately left **immediate** in #1977 (each committing on blur as its own
PATCH) because they do not live in the drawer's inline layout — they render
through the **registry section** `EstimatesSection → EstimatesTab`, which receives
only the self-contained `DrawerSectionProps` contract (`{ taskId, projectId,
userRole, canEdit }`) and self-mutates. That contract is also what **Enterprise**
registers its sections against, so widening it is a breaking change.

#1985 folds O/M/P into the same batched Save (a three-point estimate is one atomic
logical edit; three independent PATCHes are chatter, and each is a separate CPM/MC
recompute). The problem is purely structural: **how does the drawer's draft reach a
registry section without changing `DrawerSectionProps`?**

A `/voice-of-customer` panel + `/ux-design` + `/architect` gate settled the
interaction (per-field markers, live PERT-from-draft, staged-vs-immediate grouping,
velocity-Accept handling) — but the load-bearing architectural decision is the
delivery mechanism.

## Decision

**Deliver the draft to sections through a dedicated React context,
`TaskDraftContext`, that a section opts into — NOT through a `DrawerSectionProps`
field.**

```ts
interface TaskEstimateDraft { optimistic: string; mostLikely: string; pessimistic: string }
interface TaskDraftBinding {
  taskId: string;                                    // consumer guards on this
  values: TaskEstimateDraft;
  changed: Record<keyof TaskEstimateDraft, boolean>; // per-field "•" markers
  setField: (k, v) => void;                          // stage into the draft
  commitField: (k, v) => void;                        // re-baseline one field
}
```

- The drawer wraps its section subtree in `TaskDraftProvider value={binding}`,
  where `binding` is derived from the drawer's `useDirtyDraft` (the estimate slice
  of `ScalarDraft`). `EstimatesTab` calls `useTaskDraft()` and binds **only when
  `binding.taskId === its task.id`** (during a #1978 dirty swap the drawer's
  rendered task leads the host selection, so the id guard prevents binding to the
  wrong task). When bound, O/M/P are controlled by the draft, PERT recomputes from
  the draft live, and blur does not PATCH. When absent (the full-page
  `TaskDetailPage`, which has no Save bar) `useTaskDraft()` returns `null` and the
  section keeps its immediate blur-PATCH behavior.
- `DrawerSectionProps` and `DrawerSectionRegistration` are **unchanged**. A section
  that never calls `useTaskDraft()` — every existing OSS section and every
  Enterprise-registered section — is byte-for-byte unaffected. This is the
  strongest backward-compatibility guarantee: the frozen contract cannot regress
  because it does not change at all.
- The estimate keys are diffed into the **same** PATCH as name/notes by a shared
  `buildScalarPatch(draft, baseline)` used by `handleSave`, the #1978 "Save & open"
  swap verb, and Cmd/Ctrl+S — so no path can silently drop an estimate edit.
- `useDirtyDraft` gains an additive `commitField(key, value)` (re-baseline one
  field, leaving others dirty) so an immediate side-write to a single column — a
  velocity-calibration Accept, which PATCHes `most_likely` directly — can be
  reflected in the staged input without dropping the rest of the draft or marking
  it spuriously dirty. Velocity Accept/Dismiss is disabled while the estimate draft
  is dirty (avoids a draft-vs-suggestion-vs-server three-way conflict).

## Consequences

- New OSS seam: a registry section can batch its scalar fields behind the drawer
  Save by consuming `TaskDraftContext`, or stay immediate by ignoring it —
  documented as web-rule 217. Enterprise sections may later adopt the same pattern
  for their own scalar fields without any contract change.
- The staged O/M/P block (inputs + live PERT preview + ordering hint) sits above the
  existing divider; sprint **Remaining (pts)** stays immediate below it (sprint-
  scoped, active-gated) — the divider now carries the staged/immediate boundary.
- Save is gated when the complete estimate triple is out of order (`optimistic ≤
  most_likely ≤ pessimistic`), which the server enforces (#1982) — a `DialogFooter`
  `saveDisabled` + `validationMessage`, so the drawer never Saves-then-400s.
- The unsaved "•" marker, previously hand-inlined in the drawer name field and
  `TaskDescriptionField` and about to be inlined ×3 more, is extracted to a shared
  `UnsavedDot` primitive.
- Durable Execution checklist: **N/A** — pure frontend; the batched PATCH reuses the
  existing `PATCH /tasks/{id}/` recompute path, no new broker/async work.

## Alternatives considered

- **Add an optional draft-binding field to `DrawerSectionProps`** (the pattern
  `userRole`/`canEdit` used). Also backward-compatible, and lighter to thread. But
  it widens the very contract Enterprise registers against; a context keeps that
  contract *frozen* and carries a richer binding (setField/commitField/changed/
  taskId guard) without growing the prop surface. The issue's own proposal named a
  context, and the stronger no-change guarantee won.
- **Curate the estimate fields inline in the drawer** (like Overview/Description),
  bypassing the registry. Rejected: it splits the estimate UI from its PERT preview
  and velocity/approve flows, and duplicates section logic the registry already
  owns; the estimate block must stay co-located.
- **Auto-save O/M/P on blur but re-baseline into the draft.** Rejected: violates the
  #1977 no-auto-flush contract and re-introduces the per-field PATCH chatter #1985
  exists to remove.
