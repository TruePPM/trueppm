# ADR-0418: Story-point (card estimate) availability on all methodologies

## Status
Accepted (2026-07-14) — implements #1961. Refines the display coupling introduced by [ADR-0037](0037-sprint-model-data-api-and-board-integration.md).

## Context

**P3M layer:** Programs and Projects (OSS). Pure single-project execution surface — no cross-program aggregation.

TruePPM's card-level estimate is `Task.story_points` (`PositiveSmallIntegerField(null=True, blank=True)`, `models.py:2036`), surfaced as an `N pts` badge on `BoardCard` and edited via the task form's "Pts" input. A PM working a **waterfall** project (#1961) found their board cards carried no estimate ("weight") at all and could not set one.

The cause is a **frontend-only** methodology gate, and it is narrower than it looks:

- The backend does **not** gate `story_points` by methodology in any way — it is a plain writable/readable field on `TaskSerializer.Meta.fields` (`serializers.py:2371`), with no `validate_story_points`, no `to_representation` hiding, and no viewset gate. `Task.story_points` is nullable and unconstrained. **A `story_points` write on a waterfall project already succeeds today.** The model comment for `agile_features` states it plainly: *"API endpoints remain active regardless — this is a UI/UX preference, not an access-control gate."*
- The gate lives entirely in `TaskFormModal`, where `story_points` is **bundled with `sprint`** on one line — `...(agile_features ? { sprint, story_points } : {})` (`index.tsx:511/531`) — and inside one agile-gated UI block (`index.tsx:810`). `sprint` is legitimately agile-only (a waterfall project has no sprints); `story_points` was swept along with it because both were introduced together in the sprint feature (ADR-0037), not because a relative estimate is inherently agile.
- `BoardCard` renders the badge only when `task.storyPoints != null` (`BoardCard.tsx:945-953`) — it is **already null-guarded**.

ADR-0037 hid points on non-agile projects to *"avoid a '0 pts' badge on every non-agile card."* Because the badge is already null-guarded, a card without a value renders **nothing** — so a waterfall team that never estimates sees exactly today's clean cards with no change. **ADR-0037's stated concern is structurally moot for the display path.**

The user (a PM) explicitly chose "make points available on all projects."

## Decision

**Option A — unbundle the estimate from the sprint selector; make `story_points` available on every methodology (frontend-only).**

1. In `TaskFormModal`, **separate `story_points` from the `sprint` bundle**: always send `story_points` in the create/update payload; keep `sprint` gated on `agile_features` (sprints remain agile-only). Split the UI so the **"Pts" input renders on all projects** while the **Sprint selector stays agile-only**.
2. `BoardCard` needs no change on the display path — its badge is already null-guarded, so a waterfall card shows `N pts` only where a value was set. (Verify there is no *additional* `agile_features` gate wrapping the badge; if one exists, remove it so the null-guard is the sole condition.)
3. No new model field, no migration, no serializer change, no settings toggle. The estimate is simply available; a team that doesn't estimate leaves it blank and sees nothing.

**Labeling:** keep "Pts" / "Story points" — it is the real field name, methodology-neutral enough on a card, and inventing a separate "weight" label would collide with the existing derived rollup coefficient also called *weight* (`views.py:3083-3124`), which is a different concept the user should not have to reconcile.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A — unbundle, always available (chosen)** | Frontend-only; no migration/backend/settings surface; matches the ungated backend and the already-null-guarded badge; ADR-0037's noise concern is structurally handled; ships in one small MR | An optional "Pts" input now appears on the waterfall task form (a waterfall PM who doesn't estimate simply ignores it) |
| **B — per-project `show_task_estimates` opt-in BooleanField** | Preserves an explicit "estimates off by default" for waterfall; discoverable in Project Settings | Full-stack for a marginal gain: migration + serializer + settings UI + the full backend pre-MR gate chain (migration-check, rbac, api-docs). The benefit it buys — hiding one optional, blank-by-default input — is already delivered by the badge null-guard. Over-engineered for the need |
| **C — do nothing / relabel only** | No behavior change | Does not satisfy #1961 — the PM still cannot set an estimate on a waterfall card |

Option B was rejected on the decision framework's "fewer moving parts" axis: it adds a stored setting and a migration to gate a control whose only "noise" was already eliminated by the null-guard.

## Consequences

- **Easier:** any team — waterfall, agile, or hybrid — can put a relative size on a card. The estimate stops being an agile-only privilege.
- **Harder:** nothing material. Sprints, velocity, and burndown remain agile-only (unchanged) — only the raw estimate is decoupled.
- **Risks:** (1) a waterfall task form gains one optional field — low, it is blank-by-default and produces no badge until used; (2) the word "points" reads as agile to some — accepted, as relabeling risks colliding with the rollup "weight" concept. If a waterfall team wants estimates hidden entirely, that is a future opt-out (Option B) we can add without rework, since this change adds no schema.
- **ADR-0037 relationship:** this refines ADR-0037's *display coupling* only. The sprint data model, API, and durable-execution decisions in ADR-0037 are untouched; `story_points` remains the field ADR-0037 introduced.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: **web only**
- Migration required: **no**
- API changes: **no** (backend already accepts/returns `story_points` unconditionally)
- OSS or Enterprise: **OSS** (core single-project PM; no cross-program/governance surface)
- Files:
  - `packages/web/src/features/board/TaskFormModal/index.tsx` — unbundle `story_points` from the `sprint` payload (511/531); split the agile-gated UI block so the Pts input renders always while the Sprint selector stays agile-gated (809-810+).
  - `packages/web/src/features/board/BoardCard.tsx` — verify the badge is null-guarded only (no extra `agile_features` gate); adjust if one exists.
  - Tests: `TaskFormModal` unit test (Pts input present on a non-agile project, persists `story_points`), `BoardCard` unit test (badge on a non-agile project when `storyPoints` set), Playwright (set pts on a waterfall project → badge appears).

### Durable Execution
1. Broker-down behaviour: **N/A** — no async side effects; this is a client-side display/persistence gate change over an existing synchronous `PATCH /tasks/{id}/`.
2. Drain task: **N/A** — no new async work.
3. Orphan window: **N/A**.
4. Service layer: **N/A** — reuses the existing task update path; no server change.
5. API response on best-effort dispatch: **N/A** — synchronous task update, unchanged.
6. Outbox cleanup: **N/A**.
7. Idempotency: **N/A** — a `story_points` write is naturally idempotent (last-write-wins on a scalar field), same as any task field edit today.
8. Dead-letter / failure handling: **N/A** — standard task-update error handling (optimistic update with rollback) is unchanged.
