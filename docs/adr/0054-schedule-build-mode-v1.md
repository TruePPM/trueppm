# ADR-0054: Schedule Build Mode v1 — Keyboard-First Build Surface

## Status
Accepted

## Context

The Schedule list (left panel of the Schedule view) is currently a read-and-select surface. To add or modify a task, the user opens `AddTaskModal` / `TaskDetailDrawer`, fills the form, saves, and repeats. Per VoC: Sarah (PM, primary persona) spends roughly half her plan-structuring time fighting the modal round-trip. The desired interaction is "type, Tab, type, Enter" — Excel-like inline editing with keyboard reparenting — to collapse a 30-minute plan-laydown into 5 minutes.

This ADR covers the v1 of that surface, gated behind a single feature flag, bundling five issues:

| Issue | What |
|---|---|
| #349 | Feature-flag scaffolding (`schedule_build_mode_v1`) |
| #338 | Inline cell editing (F2 / double-click / letter-key entry, Enter commits, Esc rolls back, Tab → next field) |
| #339 | Tab / Shift-Tab on a focused row indents / outdents — emergent phases form when a leaf gets a child indented under it |
| #341 | Right-click row context menu (Edit / Indent / Outdent / Insert above / Insert below / Convert to milestone / Delete) |
| #342 | Bottom hint strip + `?` cheatsheet overlay + empty-state CTA |

**P3M layer**: Programs and Projects (single-project execution surface). **OSS.**

**VoC summary** (run before architect):
- Average 4.7/10 across 6 personas; Sarah (primary target) at 6/10. Average drags below 6 because 5 of 6 personas don't structure schedules — this is a Sarah-targeted feature, weight her score for ship/no-ship.
- 🟡 Mobile gap — keep the existing `AddTaskModal` flow alive everywhere flag is off (automatic on mobile because the flag is desktop-only).
- 🟡 Sprint-backlog asymmetry — Alex flags risk that Schedule getting fast inline edit while Sprint backlog doesn't reinforces "PM tool with Sprint bolted on". Mitigation: file a follow-up issue in the MR description for parallel treatment when wave/10-sprints resumes.
- No 🔴 blockers.

## Decision

Ship the bundle as a single MR, behind a runtime localStorage-backed feature flag with build-time defaults, reusing the **already-existing** server-side indent/outdent/reparent endpoints and broadcasting layer. Frontend introduces:

1. A minimal `useFeatureFlag(name)` hook (new file `packages/web/src/lib/featureFlags.ts`) — first runtime feature-flag primitive in the codebase.
2. A `useScheduleFocus()` reducer that owns the three-state focus machine (`NoSelection` → `RowFocused` → `CellEdit`) and is the single source of truth for keyboard disambiguation. Without this, Tab-on-row (indent) and Tab-in-cell-edit (next field) collide.
3. An `<EditableCell>` primitive on top of the existing `useUpdateTask` optimistic pattern (no new pattern invented).
4. `useIndentTask` / `useOutdentTask` mutation hooks pointing at the dedicated server endpoints (`POST .../indent/`, `POST .../outdent/`) — server already does the wbs_path math, the frontend doesn't predict it.
5. A right-click context menu wrapping the existing Radix `ContextMenu` primitive (already used by `BoardCard`).
6. A hint strip + cheatsheet that subscribes to the focus-state machine and renders contextual hotkeys.

### Keyboard state machine (the core of #338+#339 disambiguation)

```
                                ┌──────────────────────────────────────┐
                                │             NoSelection              │
                                │   (Tab/Shift-Tab = browser default)  │
                                └──────────────────────────────────────┘
                                    │ click row | ↓/↑ from header
                                    ▼
                                ┌──────────────────────────────────────┐
                                │             RowFocused               │
                                │   Tab → indent       (#339)          │
                                │   Shift-Tab → outdent(#339)          │
                                │   Enter / F2 → enter cell-edit       │
                                │   ↑/↓ → adjacent row                 │
                                │   letter key → enter Name cell       │
                                │   Esc → NoSelection                  │
                                │   right-click → context menu (#341)  │
                                └──────────────────────────────────────┘
                                    │ Enter | F2 | letter | dbl-click
                                    ▼
                                ┌──────────────────────────────────────┐
                                │              CellEdit                │
                                │   Tab → commit + next editable cell  │
                                │   Shift-Tab → commit + prev cell     │
                                │   Enter → commit + back to RowFocused│
                                │   Esc → rollback + back to RowFocused│
                                └──────────────────────────────────────┘
```

The reducer rejects illegal transitions (e.g. you cannot enter `CellEdit` from `NoSelection` directly — must pass through `RowFocused`). This makes `useScheduleFocus()` testable in isolation from React.

### Flag scaffolding (#349)

```ts
// packages/web/src/lib/featureFlags.ts
const FLAG_KEY = 'trueppm.featureFlags';
const ENV_DEFAULTS: Record<string, boolean> = JSON.parse(
  import.meta.env.VITE_FEATURE_FLAGS || '{}'
);

export function useFeatureFlag(name: string): boolean {
  // localStorage runtime override → env-var build-time default → false
  return useSyncExternalStore(subscribe, () => {
    const stored = JSON.parse(localStorage.getItem(FLAG_KEY) || '{}');
    return stored[name] ?? ENV_DEFAULTS[name] ?? false;
  });
}
```

- **Default in prod**: off.
- **Default in dev/test**: `VITE_FEATURE_FLAGS='{"schedule_build_mode_v1":true}'` in `packages/web/.env.development` and the Playwright config so e2e specs exercise the flag-on path.
- **Runtime toggle** (no UI in v1): `localStorage.setItem('trueppm.featureFlags', JSON.stringify({schedule_build_mode_v1:true}))` from devtools, or `?ff=schedule_build_mode_v1` URL param (one-shot, writes to localStorage).
- **Removal criteria**: 4 weeks of >90% adoption among new projects (Sarah's segment) → flip env-var default to `true` → next release removes the gate entirely. Tracked in the issue that closes #349.

This is the first runtime feature-flag primitive in the codebase. ADR-0029 (slot registry) and ADR-0041 (methodology preset) are gating mechanisms but neither is a generic flag.

### Backend: zero new endpoints

The data-model survey confirmed three dedicated endpoints already exist and are wired correctly:

| Endpoint | View class | Server bumps `server_version`? | Broadcasts on commit? | Triggers CPM? |
|---|---|---|---|---|
| `POST .../indent/` | `TaskIndentView` (`views.py:1330-1408`) | ✓ on the moved task | ✓ `tasks_restructured` | ✓ via `enqueue_recalculate` |
| `POST .../outdent/` | `TaskOutdentView` (`views.py:1411-1541`) | ✓ on the moved task | ✓ same | ✓ same |
| `POST .../reparent/` | `TaskReparentView` (`views.py:1544-1659`) | ✓ on the moved task | ✓ same | ✓ same |

The frontend uses `indent/` and `outdent/` directly — no client-side wbs_path math, no parent-prediction logic, smaller surface area.

### Optimistic update strategy

- **Inline edits (#338)**: reuse `useUpdateTask`'s established `onMutate` / `onError` / `onSettled` pattern. Server PATCH commits the field, server pushes `task_updated`, other clients re-fetch.
- **Indent/outdent (#339)**: optimistic UI prediction is **not attempted**. Reasons: predicting the new wbs_path requires accurate sibling position counts on the client (fragile), server response includes the canonical `updated[]` array within ~50ms on local DB, and ltree key math is one of those things we'd rather get from the server. Trade-off: tiny perceived latency on the indent (mitigated by an immediate row-shift CSS transition while the request is in flight); strict correctness as the win.
- **Tree restructure conflict resolution**: on 4xx (e.g. cycle violation, depth > 8), surface the server's error message in a toast, leave the focus state on the row that failed to indent. No silent rollback that loses focus.

### Realtime broadcast safety

The data-model survey confirms broadcast already fires per-commit (`transaction.on_commit(broadcast_board_event(..., 'tasks_restructured', ...))` at `views.py:1401-1403, 1534-1536, 1652-1654`). No per-keystroke broadcast risk.

**Rapid-Tab fanout concern**: a user holding Tab for 5 seconds = ~30 indent calls = 30 `tasks_restructured` events to all subscribed clients. Each event is empty-payload (clients re-fetch on receipt). Acceptable for v1 alpha (small concurrent-user counts). If problematic in beta: server-side debounce on `broadcast_board_event` for `tasks_restructured` (50ms coalescing window). Not built in v1.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **A. Build-mode in-place (chosen)** | Reuses Schedule view; one keyboard model; flag-gated rollback path | Two interaction modes on the same surface — mode visibility matters (mitigated by hint strip #342) |
| B. New "Outline editor" route | Cleaner separation of concerns | Splits the user's mental model — "where do I edit fast?" becomes a navigation question |
| C. Extend `features/grid/` Outline mode instead | Reuses existing dnd-kit indent infra | Grid Outline is drag-first; building keyboard on top means rewriting its event model anyway, and Schedule users don't naturally land in Grid |
| D. Wait for full Wave-3 #248 rendering parity first | Cleaner narrative ("first fix render, then add edit") | Sequencing #248 ahead delays alpha's biggest UX unlock by ~2 weeks |
| E. Per-project flag column on `Project` model | Cleaner audit trail, server-known | Requires migration; project-scoped flag works fine in localStorage for v1; defer to v2 if needed |

## Consequences

### Easier
- Sarah's plan-structuring round-trip drops from ~30s/task to ~3s/task at her desk.
- Future build-mode features (paste from Excel, multi-row select, fill-down) compose against the focus state machine, not against ad-hoc keyboard handlers.
- The `useFeatureFlag` primitive unblocks future flag-gated rollouts (Sprint backlog inline edit being the first beneficiary).
- The `useIndentTask` / `useOutdentTask` hooks are reusable by Grid Outline mode and any future tree surface.

### Harder
- The Schedule view now has two interaction modes (read-and-select vs build). Hint strip (#342) is the discoverability fix; without it, build-mode is invisible.
- Adding a new column to the Schedule list requires updating both the read view and the editable-cell registry.
- Test surface grows — every keyboard handler is a state-machine transition that needs coverage.

### Risks
- **🟡 Mobile gap**: this is a desktop-only feature. The flag stays off on mobile (no toggle in mobile UI). `AddTaskModal` remains the canonical add-task surface everywhere the flag is off. Documented in `docs/features/schedule-build-mode.md`. Future work: a mobile "quick-add" surface is its own design problem, not this MR's.
- **🟡 Sprint-backlog asymmetry**: Alex (Scrum Master persona) will perceive the Sprint backlog as second-class until it gets parallel treatment. Filing a follow-up issue in the MR description ("feat(web): inline-edit on Sprint backlog table — extend Schedule build-mode pattern") to be picked up when wave/10-sprints resumes. **Not blocking this MR.**
- **🔴 Pre-existing sync drift bug** (surfaced by data-model survey, not introduced here): `_renumber_siblings` (`views.py:1297+`) mutates wbs_path via QuerySet `.update()`, which bypasses `VersionedModel.save()` and **does not bump `server_version`** on renumbered siblings. Mobile sync clients filtering by `since=` will miss renumbered-sibling changes. Build-mode exercises this code path far more frequently. **Action**: file a separate bug issue (`fix(api): bump server_version on _renumber_siblings`) and link from this MR. Not in this MR's scope — fixing it requires a bulk bump strategy and likely a new test fixture, out of scope for an alpha-laydown MR.
- **Discoverability of build-mode**: invisible by default. Mitigation: hint strip (#342) + cheatsheet (`?` key). If users still don't discover it, v2 can add a one-time tour banner.
- **Conflict spam**: rapid Tab presses fire many WS events. Acceptable in alpha; revisit if beta concurrent-user load hits.

## Implementation Notes

- **P3M layer**: Programs and Projects.
- **Affected packages**: `web` only.
- **Migration required**: no.
- **API changes**: no — reuses existing `indent/` `outdent/` endpoints.
- **OSS or Enterprise**: OSS (single-project execution surface).

### Durable Execution

1. **Broker-down behaviour**: N/A — frontend feature; no async dispatch from the new code. Indent/outdent/reparent endpoints already use the outbox pattern via `enqueue_recalculate(project_id)` (`scheduling/services.py`); no new dispatch path introduced.
2. **Drain task**: N/A — no new async work introduced. The CPM drain (`scheduling.tasks.recalculate_drain`) already covers the indent-triggered recompute path.
3. **Orphan window**: N/A — no new outbox rows.
4. **Service layer**: N/A on the new code path. The reused `enqueue_recalculate(project_id)` is the canonical path.
5. **API response on best-effort dispatch**: N/A. Indent/outdent endpoints return `200` with `{updated:[{id, wbs_path}], warning: null|"has_assignments"}` synchronously, then trigger async CPM via the outbox — pre-existing behavior.
6. **Outbox cleanup**: N/A — the existing outbox purge job covers any indirect outbox rows generated by `enqueue_recalculate`.
7. **Idempotency**: Indent/outdent are not natively idempotent (calling indent twice on the same row indents it twice). The frontend prevents double-fire by disabling the keyboard handler while a mutation is in-flight (`useIndentTask.isPending` gate). For the rare 5xx-with-actual-success retry case, the worst outcome is one extra indent — recoverable via Shift-Tab. Acceptable for v1.
8. **Dead-letter / failure handling**: A failed indent/outdent surfaces as a toast with the server error. The optimistic UI does not advance, so no rollback complexity. CPM recompute failures use the existing `recalculate_drain` retry / DLQ behavior — out of scope here.

### Test coverage strategy (boundary between #338 and #339)

The single most-likely-to-break boundary is **Tab semantics**. Required test layers:

- **vitest** on `useScheduleFocus()` reducer (no React, pure state machine):
  - Tab from `RowFocused` → emits `INDENT` action
  - Tab from `CellEdit` → emits `COMMIT_AND_NEXT_FIELD`
  - Shift-Tab parallel cases
  - Esc from `CellEdit` → `ROLLBACK_AND_RETURN_TO_ROW`, never to `NoSelection`
  - Illegal transitions (CellEdit from NoSelection) throw
- **vitest** on `<EditableCell>` (commit/rollback/Tab/Enter/Esc behaviors) and `useIndentTask`/`useOutdentTask` (optimistic-path-not-attempted, server response merge, error toast)
- **Playwright** (using new shared API-mock fixture from #348):
  - Golden path: structure a 5-task project from empty state fully via keyboard (start with empty-state CTA, type a task name, Enter, type next, Tab to indent, repeat)
  - Boundary: Tab in cell-edit moves to next field; Tab on row indents; consecutive Tabs alternate predictably as edit mode is entered/exited
  - Rollback: Esc in cell-edit restores the prior value AND returns focus to the row (not to NoSelection)
  - Right-click context menu: open → click Indent → row indents → menu closes
  - Cheatsheet: `?` opens overlay; Esc closes; focus returns to whatever had it before

The Playwright spec MUST use the new `e2e/fixtures/api-mocks.ts` fixture (#348) — do not hand-roll `route.fulfill` mocks for a new spec landing after #348.

## Open design questions resolved before implementation

| Question | Resolution |
|---|---|
| Where does the flag live? | localStorage with env-var build-time defaults. localStorage chosen over project-column to avoid a migration in v1. |
| Tab disambiguation? | Three-state focus reducer; `RowFocused.Tab = indent`, `CellEdit.Tab = next field`. |
| Optimistic predict for indent? | No — server-only. Pay ~50ms for correctness. |
| Reuse `features/grid/useReparentTask`? | Add new `useIndentTask` / `useOutdentTask` hitting dedicated endpoints. `useReparentTask` is for the drag case where parent is known up-front. |
| Per-keystroke broadcast risk? | None — broadcast is per-commit, already enforced. Rapid-Tab fanout acceptable for alpha. |
| Mobile? | Out of scope. Flag is desktop-only. `AddTaskModal` stays as the universal fallback. |
| Sprint backlog parity? | Out of scope, follow-up issue. |

## No 🔴 blocking design questions remain. Ready for ux-design.
