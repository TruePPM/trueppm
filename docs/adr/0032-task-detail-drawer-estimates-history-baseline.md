# ADR-0032: Task Detail Drawer — Estimates, History, and Baseline Comparison

## Status
Accepted (2026-05-31) — implemented in #141. The task-detail-drawer click-target /
card-popover portion was superseded by ADR-0051; the history and section-extension
portions were largely superseded by ADR-0050 (section extension points) and ADR-0096
(unified task activity timeline). The estimates/governance and baseline-comparison
decisions in this ADR remain in force.

## Context
Issue #141 extends the existing `TaskDetailDrawer` component with three capabilities:

1. **Three-point estimate inputs** (Optimistic / Most Likely / Pessimistic durations) with governance modes feeding the PERT-Beta Monte Carlo engine
2. **Change history / audit trail** showing field-level diffs for the task
3. **Actual vs. baseline comparison** — current schedule dates against the active baseline snapshot

P3M layer: **Programs and Projects** (single-project scope). OSS boundary.

The drawer already handles resource assignments and dependency management (DepRow / AddDepRow for FS/SS/FF/SF links with lag). The dependency section is complete; the three sections above are absent.

### Findings from codebase research

**Three-point estimates:**
- `Task.optimistic_duration`, `Task.most_likely_duration`, `Task.pessimistic_duration` — nullable `IntegerField` (working days) on the model since `0001_initial`; present in `TaskSerializer` and `TaskSyncSerializer`; tracked in `HistoricalTask`; read by both the Python Monte Carlo engine and the Rust WASM engine
- Estimate fields are writable via `PATCH /api/v1/tasks/{id}/`; no endpoint change is needed for the `open` mode
- **New model fields required**: `Project.estimation_mode` and `Task.estimate_status` (see Decision)

**Change history:**
- The `history` app provides `GET /api/v1/projects/{project_pk}/tasks/{task_pk}/history/`
- `HistoryRecordSerializer` returns `history_date`, `history_type`, `history_change_reason`, optionally `history_user` (hidden below Admin role server-side), and a `diff` list of `{field, old, new}` objects
  - **Superseded for the task-drawer feed by ADR-0394 (#1881):** the per-task activity endpoint (`TaskHistoryView`, moved to the projects app in #781) shows `history_user` to **all** project members, aligning with the board activity feed (ADR-0160) rather than the Admin+ gate above. The Admin+ hiding rule (ADR-0201) still governs the separate project-level history surfaces in the `history` app.
- CPM output fields are excluded from history records (no scheduler noise)
- No new endpoint needed

**Baseline comparison:**
- `Baseline` and `BaselineTask` models exist; `BaselineTask` stores an immutable snapshot: `start`, `finish`, `duration`, `actual_start`, `actual_finish`
- Field semantics: `Task.actual_start` / `Task.actual_finish` are **live records** (updated as
  work progresses); `BaselineTask.actual_start` / `BaselineTask.actual_finish` are **frozen
  snapshots** of those live values at the moment the baseline was taken. The delta between them
  is schedule slip, not data inconsistency.
- `BaselineTask.task_id` is a plain `UUIDField` (not FK) so snapshots survive task soft-delete
- `useBaselineDetail(baselineId)` fetches the full baseline including all task rows; no per-task baseline sub-endpoint exists
- Active baseline is identified via partial unique index (`is_active=True` per project)
- Client-side filter from the full baseline payload avoids a new endpoint

**RBAC:**
- `DependencyViewSet` restricts writes to `IsProjectScheduler` (Resource Manager+)
- The task PATCH endpoint uses the same `IsProjectScheduler` gate for schedule-relevant field writes
- History reads are open to all project members; `history_user` visibility is governed server-side (for the task-drawer feed the actor is visible to all members — ADR-0394/#1881)

### VoC governance signals (panel avg 7.2/10 on estimate modes)
- **Sarah (PM)**: wants `suggest_approve` as opt-in per project, approval as a one-tap inline banner
- **Priya (Team Member)**: will engage if scoped to her assigned tasks; doesn't want work blocked on approval
- **Marcus (PMO)**: strongly wants program/portfolio-level policy defaults; audit trail of suggest → approve is SOC 2 evidence
- **Janet (COO)**: wants `suggest_approve` or `pm_only` as the default for compliance-sensitive programs

## Decision

Extend `TaskDetailDrawer.tsx` with a **four-tab layout**: Dependencies (existing), Estimates, History, and Baseline.

Introduce a three-mode estimation governance system on `Project`, with `open` as the default.

### Estimation governance modes

`Project.estimation_mode` — `CharField`, choices below, default `open`:

| Mode | Who can write estimates | `estimate_status` on save | MC input |
|------|------------------------|--------------------------|----------|
| `open` | Any project member with write access (Contributor+) | Not tracked | Used if all three fields set |
| `suggest_approve` | Contributor: writes set status to `pending` | `pending` until Scheduler+ approves | Only `accepted` estimates used |
| `pm_only` | Scheduler+ only; write is blocked for lower roles | Always `accepted` | Used if all three fields set |

`Task.estimate_status` — `CharField`, choices `accepted` / `pending`, nullable (null = not applicable in `open` or `pm_only` modes). Tracked in `HistoricalTask` automatically via django-simple-history.

**Monte Carlo input rule (API layer):** When preparing task data for the scheduler, treat estimate fields as `None` when `estimate_status = 'pending'` or when any of the three fields is null. The scheduler's existing all-or-none logic handles the fallback to deterministic duration. This means partial inputs and pending-approval estimates never corrupt MC results.

**Program/portfolio-level policy defaults** (Marcus/Janet's ask) are deferred to the Enterprise
repo. The OSS project-level `estimation_mode` field is the authoritative control for a single
project. Org-wide governance (e.g., "all projects default to `suggest_approve`") is an
Enterprise-only concern — it requires aggregating across projects, which crosses the OSS/Enterprise
boundary.

---

### New model fields (migration required)

**`Project`:**
```python
ESTIMATION_MODE_CHOICES = [
    ("open", "Open"),
    ("suggest_approve", "Suggest & Approve"),
    ("pm_only", "PM Only"),
]
estimation_mode = models.CharField(
    max_length=16,
    choices=ESTIMATION_MODE_CHOICES,
    default="open",
)
```

**`Task`:**
```python
ESTIMATE_STATUS_CHOICES = [
    ("accepted", "Accepted"),
    ("pending", "Pending Approval"),
]
estimate_status = models.CharField(
    max_length=12,
    choices=ESTIMATE_STATUS_CHOICES,
    null=True,
    blank=True,
    db_index=True,
)
```

Both fields have safe defaults — no data migration required, only schema migration.

---

### New API endpoint

`POST /api/v1/tasks/{id}/approve-estimates/`
- Permission: `IsProjectScheduler`+
- Effect: sets `estimate_status = 'accepted'`; broadcasts `task_updated` WebSocket event via `broadcast_board_event()`
- Returns: updated task object (200)
- Idempotent: calling on an already-accepted task is a no-op (200, no broadcast)
- Only meaningful when project `estimation_mode = 'suggest_approve'`; returns 400 for other modes

---

### Tab: Dependencies (existing)
Move the current `DrawerBody` content (ResourceAssignmentSection, DepRow, AddDepRow) into a named tab. No behaviour change.

---

### Tab: Estimates

**Partial save and validation (Q3 decision):**
- Allow saving with 1 or 2 of the 3 fields set — do not block save on partial input; the scheduler's all-or-none gate handles MC exclusion
- PERT derived values (expected value `(O + 4M + P) / 6`, std dev `(P - O) / 6`) are only shown when all three fields are populated and estimates are `accepted` (or project is in `open` mode)
- When 1 or 2 fields are set, the Estimates tab badge shows an "incomplete" indicator; derived values are hidden

**Per-mode UX:**

*`open` mode:*
- Three number inputs editable by Contributor+; Viewer sees read-only values
- 600 ms debounce → `PATCH /api/v1/tasks/{id}/`
- No status tracking; PERT values shown immediately when all three are set

*`suggest_approve` mode — Contributor (Priya):*
- Inputs editable for assigned tasks; debounced PATCH sets `estimate_status = 'pending'`
- Approval banner shown at top of tab: "Estimates pending PM review" — read-only until approved or overridden
- On approval: banner clears, PERT values appear, `estimate_status = 'accepted'` reflected via WebSocket

*`suggest_approve` mode — Scheduler+ (Sarah):*
- Inputs always editable; saves directly to `accepted`
- When a pending suggestion exists: inline diff shown ("Suggested: 3/5/8 → Your current: —") with one-tap Accept or Override buttons
- Accept calls `POST .../approve-estimates/`; Override overwrites fields and sets `accepted`

*`pm_only` mode:*
- Contributor and Viewer see read-only inputs (or hidden inputs with a "PM-managed" label)
- Scheduler+ writes directly; no approval step

---

### Tab: History
- New `useTaskHistory(projectId, taskId, page)` React Query hook wrapping `GET /api/v1/projects/{projectId}/tasks/{taskId}/history/`
- Paginated list: `history_date` (relative + absolute on hover), change type badge (`+` / `~` / `-`), optional `history_user`, and field diff rows (`field`, `old → new`)
- `estimate_status` changes appear in the diff as `pending → accepted` — surfacing the governance trail Marcus needs
- "Load more" pagination (append, not replace) to keep scroll position
- Read-only; no write surface

---

### Tab: Baseline

**Empty state (Q2 decision):**
- When task is not in the active baseline snapshot: show a context-rich message per row — "Added 2026-04-12, after baseline taken 2026-03-01" — not a generic "Not in baseline" collapse
- This distinguishes "added after baseline" (scope change signal) from "no baseline set on this project" (normal empty state)
- When no active baseline exists for the project: show a single panel-level message "No baseline set for this project"
- A `strict_baseline` project setting (flagging post-baseline additions as scope-change warnings) is deferred to a follow-up issue; the information to build it is already present in `task.created_at` vs. `baseline.created_at`

**Comparison table:**
- Uses `useBaselines(projectId)` to find the active baseline, then `useBaselineDetail(baselineId)` — client-side filter by `task_id`
- Fields: Planned Start / Planned Finish / Duration / Actual Start / Actual Finish — Current, Baseline, Delta columns
- Delta for dates: working-day difference using the project calendar; delta for duration: integer diff
- Read-only; no write surface

---

### Mobile (bottom-sheet)
Tab bar renders as a horizontally scrollable strip at the top of the sheet on viewports < 768 px. Same four tabs, same behaviour. Approval banner stacks above the estimate inputs on mobile.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Three estimation modes on Project (chosen)** | Flexible default; governance scales with team maturity; audit trail via existing history mechanism | Two new model fields + migration; approve endpoint adds surface area |
| Role-only gate (PM-only, no modes) | Simpler | Removes team estimation entirely; Priya can't contribute duration knowledge |
| Suggestions as a separate model | Richer workflow (multiple suggestions, compare) | Significant over-engineering for alpha; the Task row is the single source of truth |
| Four-tab drawer layout | Fits existing drawer width; navigable without scrolling | Adds tab chrome; History and Baseline must lazy-fetch on first activation |
| Single scrollable panel | No tab chrome | Drawer becomes unwieldy with many dependencies; estimates buried |
| Per-task baseline API endpoint | Smaller payload per request | New viewset/serializer/URL/test not justified for a single dict lookup |

## Consequences

**Easier:**
- PMs can enter or approve estimates inline in the same surface they manage dependencies
- Monte Carlo results are governance-protected: pending estimates never corrupt MC runs
- History tab surfaces the suggestion → approval trail — Marcus's SOC 2 audit requirement
- Baseline tab post-baseline detection gives teams an early scope-creep signal
- `open` default means zero friction for small teams and solo PMs; governance layers in as teams grow

**Harder:**
- Two new model fields + migration on both `Project` and `Task`
- Estimates tab now has three distinct UX states per mode × per role — test matrix is wider
- Approve endpoint needs its own permission test, idempotency test, and broadcast test
- The drawer lazy-loads three data sources (estimates live on the task, history and baseline on first tab activation); loading states and error boundaries must be independent

**Risks:**
- `suggest_approve` UX must not block Priya's work — approval is informational until the PM acts; the scheduler's MC gate (not the UI) is the governance enforcement point
- History pagination: tasks with many estimate changes (iterative planning) can produce long diffs; "Load more" prevents unbounded initial load
- Program/portfolio-level estimation policy defaults (Marcus's ask) deferred to Enterprise — Marcus may view the project-level setting as insufficient for org-wide governance until that ships

## Implementation Notes

- P3M layer: Programs and Projects
- Affected packages: `api` (model, serializer, view), `web` (hooks, components)
- Migration required: **yes** — add `Project.estimation_mode` (CharField, default `open`) and `Task.estimate_status` (CharField, nullable); both are safe/additive
- API changes: **yes** — `POST /api/v1/tasks/{id}/approve-estimates/`; `estimation_mode` exposed on `ProjectSerializer`; `estimate_status` exposed on `TaskSerializer`
- OSS or Enterprise: **OSS** (`trueppm/trueppm-suite`)
- Program/portfolio-level estimation policy defaults: **deferred to Enterprise repo**

### New React Query hooks required (web)
| Hook | Endpoint | Notes |
|------|----------|-------|
| `useTaskHistory(projectId, taskId, page)` | `GET /api/v1/projects/{id}/tasks/{id}/history/` | Paginated; append on "Load more" |
| `useApproveEstimates(taskId)` | `POST /api/v1/tasks/{id}/approve-estimates/` | Idempotent; invalidates `['tasks']` on success |

`useBaselines` and `useBaselineDetail` already exist in `src/hooks/useBaselines.ts`.
`useUpdateTask` already exists and is used for the debounced estimate save.

### Durable Execution
1. **Broker-down behaviour:** N/A for estimate saves and approval — both are synchronous mutations that return immediately. The existing task PATCH already dispatches CPM recalculation through the established outbox; no new async dispatch is introduced. Approved estimates do not automatically trigger MC re-run (MC remains user-initiated).
2. **Drain task:** N/A — no new category of async work. Existing CPM drain covers any schedule recalculation triggered by estimate field changes on task PATCH.
3. **Orphan window:** N/A — no new outbox rows.
4. **Service layer:** N/A for estimates — PATCH routes through existing `TaskViewSet.partial_update`. The approve endpoint sets `estimate_status` directly in the view action and broadcasts via `broadcast_board_event()`; no scheduling side-effect requires a service layer call.
5. **API response on best-effort dispatch:** N/A — task PATCH and approve both return 200 synchronously.
6. **Outbox cleanup:** N/A — no new outbox rows.
7. **Idempotency:** Approve endpoint is idempotent — calling on an already-`accepted` task is a no-op (200, no DB write, no broadcast). Estimate PATCH is last-write-wins on nullable integer fields.
8. **Dead-letter / failure handling:** N/A — no new async tasks. PATCH and approve failures return 4xx/5xx; React Query `onError` rolls back optimistic state. The `pending` status persists on the task row until explicitly approved or overridden — no silent discard path.

---

Superseded-by: ADR-0051 (card-info popover / click-target portion, 2026-05-05); the
history and section-extension portions are superseded by ADR-0050 and ADR-0096. The
estimates/governance and baseline-comparison decisions remain in force.
