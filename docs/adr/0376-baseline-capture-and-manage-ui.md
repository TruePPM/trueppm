# ADR-0376: In-app baseline capture & management UI

## Status
Proposed

## Context
The baseline subsystem is **fully built on the backend and half-wired on the
frontend**. `Baseline` / `BaselineTask` models, `BaselineViewSet` +
`BaselineActivateView`, serializers, routes, permissions, the `baseline_created` /
`baseline_activated` / `baseline_deleted` board broadcasts, the `baseline.captured`
webhook, and `test_baselines.py` all exist and ship today. On the web, all five React
Query hooks (`useBaselines`, `useBaselineDetail`, `useCreateBaseline`,
`useActivateBaseline`, `useDeleteBaseline`) already exist in
`packages/web/src/hooks/useBaselines.ts` — but they have **zero consumers**. The only
baseline UI is the read-only per-task comparison in the task drawer
(`BaselineTab` / `BaselineSection`), whose empty state literally says "Take a baseline
snapshot on this project…" while offering no way to do so.

The result (GitLab #1864): a user cannot find any way to baseline a project. A shipped,
tested capability is unreachable from the UI. The published docs
(`features/baselines.md`) confirm the gap ("there is no in-app 'Capture baseline'
button yet").

**This is a wire-up, not a feature build** — no new endpoint, model, serializer,
permission, migration, or async path. The only decisions are *where* the capture action
lives and *what shape* the management surface takes, both bounded by the existing
Schedule-toolbar clustering rules (web-rule 42/243) and the design system.

**VoC** (panel avg 4.1/10) confirms this is a single-persona OSS feature — Sarah (PM) /
Scheduler layer — with no genuine feature-triggered hard-NO. The low average is a
persona-fit artifact (6 of 8 panelists are not its audience), not a value signal. The
panel surfaced one real guardrail: **no governance leak** — baseline variance/SPI must
stay a PM/Scheduler schedule-surface concern; this change adds no cross-project /
portfolio / exec rollup and no contributor push/email.

## Decision

Wire the existing hooks into three thin presentational surfaces on the **desktop
Schedule view**, honoring the ≤6-affordance clustered toolbar:

1. **Capture entry point — Actions "···" overflow (`ToolbarOverflowMenu`).** Add a
   `Capture baseline` item (PM/Admin only) that opens a short **educational confirm**
   (`CaptureBaselineConfirmDialog`) explaining what baselining does — freezes the plan
   as an immutable snapshot, becomes the active comparison baseline, and (when one is
   already active) supersedes it while **keeping the previous baseline in history**
   (capturing never overwrites — a re-baseline is non-destructive). Confirming captures
   via `useCreateBaseline` (server auto-names `Baseline N`) with a `toast.success` end
   state; the confirm's visible "Capturing…" button state is the in-flight signal
   (web-rule 209 — the menu closes on select, so the feedback can't live on the item).
   The item adds **zero** new top-level toolbar affordances, so web-rule 243's cap holds.
   A second item, `Baselines…` (all project members — the list is member-readable),
   opens the manager (below). The same confirm gates the manager's and the task-drawer's
   capture buttons, so every capture path is consistent.

2. **Baseline manager — a focus-trapped modal dialog** (`role="dialog"
   aria-modal="true"`, `useFocusTrap`, web-rule 245/206). It lists baselines (name,
   captured date, captured-by, `task_count`, and an **Active** badge on the active one),
   with per-row actions: **Set active** (`useActivateBaseline`, PM/Admin, hidden on the
   already-active row) and **Delete** (`useDeleteBaseline`, Owner only, behind a nested
   self-trapping confirm dialog — web-rule 206). A header `Capture baseline` button
   (PM/Admin) gives the manager its own capture affordance. Empty state uses the shared
   `EmptyState` (web-rule 177) with a PM-gated `Capture baseline` CTA. Activate/delete
   are immediate row actions (web-rule 217 instant-toggle carve-out — no save bar);
   activate confirms with a toast, delete confirms destructively first.

3. **Reconcile the existing `BaselineTab` empty state.** Replace its dead "Take a
   baseline snapshot" copy with a real PM-gated `Capture baseline` action that calls
   `useCreateBaseline` directly (the drawer already holds `projectId`); non-PM viewers
   get a one-line guidance read instead of a dead button (web-rule 122/241). This keeps
   the per-task comparison and the project-level manager coherent without coupling the
   drawer to the toolbar's modal state.

Client role gates are **render-gates only** — the server is authoritative (create →
`IsProjectAdmin`, destroy → `IsProjectOwner`) and returns 403 regardless (web-rule
151/196 pattern). A non-PM member still sees the manager and the list (read), but the
capture/activate/delete controls are gated.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **A. Actions-overflow capture + modal manager** (chosen) | No new top-level affordance (rule 243 holds); ≤2-click capture; modal is the standard overflow-launched surface; low coupling | Two capture entry points to keep in step (mitigated: both call one hook) |
| B. Dedicated "Baseline ▾" toolbar popover (rule 42 slot) | Most discoverable; matches the reserved slot | Adds a **7th** top-level affordance — violates the rule-243 ≤6 cap that clustered the toolbar in the first place |
| C. Project Settings sub-page | Roomy; matches other management surfaces | Baselines are a live scheduling act done *while looking at the schedule*, not a settings chore; buries a frequent PM action two navigations deep |
| D. Capture only from the `BaselineTab` empty-state CTA | Smallest change | Undiscoverable (requires opening a task drawer first) and gives no list/activate/delete management at all |

## Consequences
- **Easier:** a shipped-but-unreachable backend capability becomes usable; the
  read-only task-drawer comparison finally has a way to get its first baseline; the docs
  caution can flip from "API-only" to shipped.
- **Harder:** two capture entry points (Actions menu + drawer empty state) must stay
  behaviorally identical — mitigated by both calling the single `useCreateBaseline` hook
  with shared toast copy.
- **Risks:** (1) **Governance-leak creep** — variance/SPI must not migrate onto any
  cross-project/portfolio/exec surface in this or a follow-up without a team-visible
  opt-in (VoC/Morgan). Structurally satisfied here: everything is single-project and the
  existing `baseline_*` broadcasts are board-sync events, **not** notifications — confirm
  no contributor push/email is added. (2) **Rename gap** — there is no rename endpoint,
  so auto-named baselines can't be renamed in-app; acceptable for MVP (a `PATCH`
  name field is a cheap future add if users ask). (3) **No ghost bars** — the
  planned-vs-baseline Gantt overlay stays out (0.5); the manager + task-drawer text
  comparison are the only variance surfaces this cycle.

## Implementation Notes
- **P3M layer:** Programs and Projects / Operations (baselines are an Operations-layer
  artifact, single-project). **OSS.**
- **Affected packages:** `web` only.
- **Migration required:** no.
- **API changes:** no — consumes existing `/projects/{id}/baselines/` endpoints.
- **OSS or Enterprise:** OSS (`trueppm-suite`). No cross-program/portfolio surface.
- **Out of scope (0.5):** baseline ghost bars on the canvas Gantt; baseline-vs-current
  `story_points` / task-count scope-drift delta on the manager (VoC/Jordan nicety —
  needs the compare data plumbed into the list; note as a follow-up, not a blocker).

### Durable Execution
1. **Broker-down behaviour:** N/A — pure frontend. No new async dispatch is introduced.
   The only writes are HTTP calls to existing endpoints whose server-side durability
   (atomic snapshot in a `transaction.atomic()`, `baseline.captured` webhook via the
   established outbox, board broadcast on commit) is unchanged and already covered.
2. **Drain task:** N/A — reuses the existing baseline/webhook/broadcast paths unchanged;
   no new category of async work.
3. **Orphan window:** N/A — no new outbox rows authored by this change.
4. **Service layer:** N/A (frontend). Server-side snapshot/broadcast logic in the
   existing `BaselineViewSet` / `BaselineActivateView` is untouched.
5. **API response on best-effort dispatch:** N/A — the client consumes the existing
   synchronous `201`/`200`/`204` responses; no best-effort/queued contract is added.
6. **Outbox cleanup:** N/A — no new outbox rows.
7. **Idempotency:** Capture is a deliberate user action producing a new immutable
   baseline each time (not idempotent by design — repeat capture = a new snapshot, which
   is the intended semantics). The UI guards against accidental double-fire by disabling
   the capture control while `useCreateBaseline` is `isPending`. Activate is idempotent
   server-side (re-activating the active baseline is a no-op under the partial-unique
   constraint). Delete is idempotent from the user's view (a second delete of a
   soft-deleted baseline 404s and the row is already gone from the invalidated list).
8. **Dead-letter / failure handling:** N/A for new async work. Client-side, a failed
   mutation surfaces an inline error / error toast and the optimistic list state is
   reconciled by the `onSuccess`/`onError` query invalidation already in the hooks; the
   offline guard (web-rule 29) disables mutating controls when `!navigator.onLine`.
