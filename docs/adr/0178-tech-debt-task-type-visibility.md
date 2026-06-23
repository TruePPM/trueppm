# ADR-0178: Tech-Debt Task Type & Visibility

## Status
Proposed

## Context
TruePPM's `TaskType` taxonomy (ADR-derived, shipped via #363) is `EPIC / STORY / TASK / BUG / SPIKE`.
There is no first-class way to mark a unit of work as **technical debt**, so engineering teams
cannot track, filter, or chart debt distinctly from feature work. The 2026-06-10 product audit
(§3.2 refactoring, §3.3.6) flagged this: a trivial gap with disproportionate goodwill from
engineering teams, who consistently ask "how much of our capacity is going to debt vs. features?"

**P3M layer:** Programs and Projects (single project / task taxonomy) → **OSS**. A PM/team needs
debt visibility to run their own program; this is not cross-program governance.

Forces at play:
- The type-vs-flag question: should debt be a new `TaskType` value or a boolean flag on `Task`?
- Velocity/aggregate treatment: does debt count toward velocity and committed-delivery aggregates,
  or is it excluded like `EPIC`?
- The task-list endpoint does **not** currently expose a `?type=` filter (only `BacklogItem` does),
  so "filterable via API and board" requires adding that filter.

## Decision
1. **Add `TECH_DEBT = "tech_debt", "Tech Debt"` as a new `TaskType` value.** Debt behaves exactly
   like a `STORY`/`TASK` in flow — it is schedulable, estimable, and sits in the same board columns —
   but reports separately. This matches the existing taxonomy precedent (#363): a type *drives card
   treatment and report grouping; it does not partition data*. A boolean flag was rejected because it
   would be orthogonal to type (a task is fundamentally "debt" or "a bug" — not "a debt-flagged bug"),
   and a flag does not slot into the established `?type=` / `TypeBadge` / type-option UI pattern.

2. **`TECH_DEBT` counts toward velocity and committed-delivery aggregates** — it is **not** added to
   the `CommittedTaskManager` `EPIC` exclusion. `EPIC` is excluded because it is a *non-schedulable
   grouping node* whose dates/points roll up from children; admitting it to CPM/Monte Carlo would
   corrupt float and the P50/P80/P95 bands. Tech debt is the opposite: it is real, schedulable work
   that consumes sprint capacity. Excluding it from velocity would *understate* a team's actual
   throughput and hide the cost of debt work — the exact opposite of the visibility this feature
   exists to provide. Distinct reporting is achieved by **filtering on `type`**, not by exclusion.

3. **Add a `?type=` filter to the task-list endpoint** (`TaskViewSet.get_queryset()`), following the
   existing `?status=` / `?sprint=` filter pattern. This makes every type — not just `TECH_DEBT` —
   filterable via API and is the backing query for the board/backlog type filter.

4. **No new drf-spectacular enum-name override needed.** `TaskTypeEnum` is already pinned to
   `trueppm_api.apps.projects.models.TaskType` in `settings/base.py`, so adding a choice cannot
   trigger a hash-rename collision.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **A. New `TECH_DEBT` TaskType value (chosen)** | Slots into shipped `?type=` / TypeBadge / type-option pattern; no new field; debt is a kind-of-work, semantically a type | Migration to add a choice (no-op AlterField); web union + options + label need updating |
| B. Boolean `is_tech_debt` flag on Task | No enum change | Orthogonal to type (a "debt bug" is ambiguous); doesn't reuse the type-filter/badge UI; a second axis to chart |
| C. Exclude TECH_DEBT from velocity (like EPIC) | "Pure" feature velocity | Hides consumed capacity; understates throughput; contradicts the visibility goal; debt *is* schedulable work |

## Consequences
- **Easier:** Teams can create, filter (`?type=tech_debt`), and visually distinguish debt on the
  board/backlog; debt capacity is honestly reflected in velocity; "% capacity to debt" is derivable
  (debt points ÷ total committed points) without a new aggregate.
- **Harder:** Nothing materially. One more value in every exhaustive `TaskType` switch (the web
  `LABEL`/`TYPE_OPTIONS` maps are the only exhaustive ones; both are updated here).
- **Risks:** Low. The migration is an additive `AlterField` on a `choices` field (safe, no data
  change, no NOT NULL). Existing rows are unaffected (default stays `TASK`).

## Implementation Notes
- P3M layer: Programs and Projects (Operations-adjacent) — **OSS**
- Affected packages: api (model + viewset filter + serializer is already generic), web (type union,
  task form option, TypeBadge label, board/backlog type filter, card treatment)
- Migration required: yes — additive `AlterField` on `Task.type` choices (no data migration)
- API changes: yes — `TECH_DEBT` choice + new `?type=` query param on the task-list endpoint;
  OpenAPI schema regenerated
- OSS or Enterprise: **OSS** (`trueppm-suite`)

### Durable Execution
1. Broker-down behaviour: **N/A** — no new async side effects. Setting a task's type goes through
   the existing task-update path, which already broadcasts via the established `on_commit` pattern;
   no new task category is introduced.
2. Drain task: **N/A** — no new async work.
3. Orphan window: **N/A** — no outbox rows added.
4. Service layer: **N/A** — read/CRUD only; the `?type=` filter is a queryset filter, no dispatch.
5. API response on best-effort dispatch: **N/A** — synchronous CRUD/list responses only.
6. Outbox cleanup: **N/A** — no outbox rows.
7. Idempotency: **N/A** — no Celery task; the filter is a pure read; the migration is a no-op
   `AlterField` that is inherently idempotent (re-running converges to the same schema).
8. Dead-letter / failure handling: **N/A** — no async task to fail.
