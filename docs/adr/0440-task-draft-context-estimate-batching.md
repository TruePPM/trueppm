# ADR-0440: TaskDraftContext — batch the three-point estimate behind the drawer Save bar

## Status
Accepted

## Context

Issue #1985 is a direct follow-up to #1977. ADR-less #1977 (commit `9f005167`,
web-rule 217) moved the task-detail drawer's **name** and **description** behind an
explicit Save/Cancel bar built on the shared `@/components/dialog` primitives
(`useDirtyDraft` + `useUnsavedChangesGuard` + `DialogFooter` +
`UnsavedChangesDialog`): the two scalar columns stage in a `useDirtyDraft<ScalarDraft>`
draft and persist as **one** changed-keys-only `PATCH /tasks/{id}/` on Save; Cancel
reverts; Esc/close/expand while dirty raise the unsaved-changes guard.

The three-point estimate fields (Optimistic / Most Likely / Pessimistic) were
**deliberately left immediate** in #1977. They live in `EstimatesTab`, rendered via
the registry section `EstimatesSection`, and today each field commits on blur through
its own 300 ms-debounced single-field `PATCH` (`optimistic_duration` /
`most_likely_duration` / `pessimistic_duration`). Three independent PATCHes for what
is one atomic logical edit (a three-point estimate is meaningless until all three are
set — the scheduler enforces an all-or-none rule) is chatter, and it reads
inconsistently next to the name/description Save bar. The #1977 ux-design gate
recommended folding O/M/P into the same batched Save; this ADR designs that.

**P3M layer:** Programs and Projects (single task edit). **Repo:** OSS.

### The design tension

`EstimatesSection` receives only the self-contained `DrawerSectionProps` contract
(`{ taskId, projectId, userRole?, canEdit? }`, ADR-0050 / ADR-0133) and self-mutates
— exactly like every other registry section (dependencies, sprint, blocker,
comments…). That contract is the **OSS extension boundary Enterprise registers its
own sections against** (ADR-0029/0050); changing its shape is a breaking change for
enterprise overlay code. So the drawer's draft cannot simply be threaded in as a new
required prop on `DrawerSectionProps`.

The same `EstimatesSection`/`EstimatesTab` is **also** rendered on the full-page
`TaskDetailPage` (via the shared `SectionList`), which has **no** Save bar — there,
estimates must keep committing immediately. Any solution must degrade to today's
behavior when no drawer draft is present.

Research confirmed the **backend needs zero change**: `Task.optimistic_duration` /
`most_likely_duration` / `pessimistic_duration` are already nullable `IntegerField`s,
already writable through `TaskSerializer`, and `TaskViewSet.partial_update` already
applies any subset of them in one atomic transaction / one `server_version` bump
(exercised by `test_estimation_governance.py`). This is purely a web change:
collapse three sequential PATCHes into one deferred PATCH.

## Decision

Introduce a **nullable React context, `TaskDraftContext`**, that the drawer provides
around its section tree and that `EstimatesTab` opportunistically consumes. The
`DrawerSectionProps` registry contract is **unchanged** — sections opt in to the draft
by reading the context, so Enterprise sections that never read it are wholly
unaffected.

### 1. Context shape (backward-compatible with the registry contract)

```ts
// features/schedule/TaskDraftContext.tsx
export interface EstimateDraftValue {
  optimistic_duration: number | null;
  most_likely_duration: number | null;
  pessimistic_duration: number | null;
}

export interface TaskDraftContextValue {
  /** The task this draft is bound to — guards against a stale section reading
      a draft seeded for a different task during a canvas swap. */
  taskId: string;
  /** Current staged estimate values. */
  estimates: EstimateDraftValue;
  /** Stage an estimate edit into the drawer draft (no PATCH until Save). */
  setEstimate: (key: keyof EstimateDraftValue, value: number | null) => void;
  /** Which estimate fields differ from the last-saved baseline (drives the • markers). */
  changed: Record<keyof EstimateDraftValue, boolean>;
  /** Re-baseline the estimate slice to a server-applied value without clobbering
      the name/description staging — used by the velocity-Accept path. */
  commitEstimatesFromServer: (estimates: EstimateDraftValue) => void;
}

const TaskDraftContext = createContext<TaskDraftContextValue | null>(null);
export function useTaskDraft(): TaskDraftContextValue | null {
  return useContext(TaskDraftContext);
}
```

The default value is `null`. `useTaskDraft()` returning `null` **is** the
"no draft present" signal.

### 2. Two independent drafts, one PATCH

The drawer keeps its existing `useDirtyDraft<ScalarDraft>` for name/notes and adds a
**second** `useDirtyDraft<EstimateDraftValue>` for the three estimate fields.
Combined dirtiness is `nameNotesDirty || estimatesDirty`; the shared `DialogFooter`
raises whenever either is dirty. On **Save**, `handleSave` merges the changed keys of
*both* drafts into a **single** `PATCH /tasks/{id}/` (still one atomic request, one
`server_version` bump — satisfies the batching goal). On **Cancel**, both reset.

A second `useDirtyDraft` (rather than widening `ScalarDraft`) is chosen deliberately:
it gives the estimate slice an **independent `commit`**, which is exactly what the
velocity-Accept path needs to re-baseline O/M/P after a server-side write **without**
disturbing an in-progress name/description edit. `useDirtyDraft`'s `commit(next?)` is
already the whole-draft re-snapshot primitive; applying it to the estimate-only draft
re-baselines only those three fields.

### 3. Present-vs-absent fallback

`EstimatesTab` calls `useTaskDraft()`:

- **Context present (drawer):** the O/M/P inputs become controlled by
  `estimates[key]` / `setEstimate(key, …)`; typing stages into the draft with **no**
  PATCH; the PERT E/σ preview reads the **draft** values (fixing today's latent bug
  where PERT reflects the last-*saved* `task.*` value, not what the user just typed);
  each changed field shows the per-field unsaved "•" marker; persistence happens only
  when the drawer's Save fires.
- **Context absent (`TaskDetailPage`, and any future non-drawer host):** unchanged —
  the existing 300 ms-debounced single-field blur PATCH.

The drawer binds the context `taskId`; `EstimatesTab` ignores a context whose
`taskId` does not match its own task (defensive against a canvas swap mid-render).

### 4. Velocity-suggestion Accept / Dismiss interaction (ADR-0065)

Accept (`POST /velocity-suggestions/{id}/accept/`) writes `most_likely_duration`
server-side **and** records the acceptance + enqueues a CPM recompute; it is
**server-authoritative and must stay immediate** (staging it into the draft would
lose the audit stamp and the CPM enqueue). Two rules keep it coherent with an open
draft:

- **Accept/Dismiss are disabled while any estimate field is staged-dirty** (tooltip:
  "Save or cancel your estimate changes first"). Manual estimate editing and accepting
  a suggestion are two mutually-exclusive ways to set the same value; letting them
  race reproduces the clobber ambiguity the #1977 guard exists to prevent. When the
  estimate draft is clean, the buttons behave exactly as today — satisfying "velocity
  accept/approve unaffected".
- On a **successful Accept** while the drawer is open, `EstimatesTab` calls
  `commitEstimatesFromServer({ …, most_likely_duration: accepted })` so the estimate
  draft's baseline moves to the accepted value. Without this, the clean draft's stale
  `most_likely` baseline would be re-PATCHed over the accepted value on the next Save.

Sprint **Remaining (pts)** stays immediate (sprint-scoped, active-gated — not a
scalar task column; #366) and is untouched.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. TaskDraftContext + 2nd `useDirtyDraft`** (chosen) | Registry contract unchanged; independent estimate re-baseline for Accept; clean full-page fallback; one atomic PATCH | Two draft instances to keep in sync on reseed/save/cancel |
| B. Widen `ScalarDraft` to 5 fields, still context-delivered | One draft, one `dirty` | Whole-draft `commit` can't re-baseline just estimates after Accept without clobbering name/notes staging → Accept-then-Save clobber bug |
| C. Add the draft to `DrawerSectionProps` as new props | No context indirection | **Breaks the Enterprise extension contract** (ADR-0050) — every registered section signature changes; non-starter |
| D. Lift estimate state into a Zustand store | Global access | Over-engineered for one drawer; store outlives the drawer and needs manual teardown; context is the idiomatic drawer-scoped choice |
| E. Keep immediate, just debounce all three together | Trivial | Doesn't meet the ask (no Save/Cancel semantics, no Cancel-reverts, inconsistent with name/notes bar) |

## Consequences

- **Easier:** O/M/P now read consistently with name/description — one Save, one
  Cancel, one PATCH, per-field • markers, live PERT preview. Registry/Enterprise
  contract untouched.
- **Harder:** two drafts in the drawer; the taskId-reseed effect, Save, and Cancel
  must operate on both. The velocity-Accept re-baseline is a subtle edge that needs an
  explicit test.
- **Risks:** (1) a section reading a stale draft during a canvas swap — mitigated by
  the `taskId` guard; (2) the PERT preview now updating live could surprise a user
  mid-type — acceptable and expected (it is a *preview*); (3) Accept disabled during a
  dirty estimate draft is a minor, well-signposted constraint. All covered by tests.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: **web only** (`packages/web`)
- Migration required: **no**
- API changes: **no** — `TaskSerializer` already exposes all three fields writable;
  `TaskViewSet.partial_update` already applies them atomically in one request
- OSS or Enterprise: **OSS** (`trueppm-suite`)

### Durable Execution
1. Broker-down behaviour: **N/A** — this is a client-side batching change. The single
   PATCH it emits routes through the existing `TaskViewSet.partial_update`, whose CPM
   recompute already goes through `scheduling/services.py::enqueue_recalculate()` with
   the established outbox/drain durability. No new dispatch path is introduced.
2. Drain task: **Reuses existing** — the schedule-recompute drain behind
   `enqueue_recalculate()`; batching three field-writes into one PATCH means the same
   (or fewer) recompute enqueues than today.
3. Orphan window: **N/A** — no new outbox rows.
4. Service layer: **Reuses existing** `scheduling/services.py::enqueue_recalculate()`;
   no new service function.
5. API response on best-effort dispatch: **N/A** — the PATCH response is the existing
   synchronous `TaskSerializer` body; unchanged.
6. Outbox cleanup: **N/A** — no new outbox category.
7. Idempotency: the PATCH is naturally idempotent (last-write-wins on the task row,
   guarded by `server_version`); replaying the same batched PATCH yields the same
   state. Collapsing three PATCHes into one *reduces* the concurrent-write surface.
8. Dead-letter / failure handling: **N/A** for new async (none added). A failed PATCH
   surfaces through `DialogFooter`'s existing error state ("Couldn't save — try
   again"), leaving the draft dirty so the user can retry — same as name/description.
