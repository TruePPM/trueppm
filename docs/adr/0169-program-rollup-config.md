# ADR-0169: Program Rollup KPIs Configuration

## Status
Accepted

## Context

The Program Settings → Rollup KPIs page (`packages/web/src/features/settings/program/ProgramRollupPage.tsx`) currently holds hardcoded KPI toggle state and aggregation-policy radio state in React `useState`. Issue #527 wires this surface to a real API so that program managers can persist which health signals roll up to their program overview and how project-level health combines into the program health dot.

The VoC panel (all eight personas, full chain) returned a 4.9/10 average with two 🔴 hard NOs from Alex (Scrum Master) and Morgan (Agile Coach), both triggered by `team_velocity` exposed as a program-manager-controlled toggle — the velocity-becomes-pressure-gauge anti-pattern (`Velocity transparency` tension, `.claude/personas.md`). Scope was revised before architect handoff: `team_velocity`, `scope_change_count`, and `resource_utilization` are dropped from the toggle list (the first two for team-boundary reasons, the third because aggregating per-person utilization with `worst`/`average`/`weighted_by_budget` is mathematically incoherent per David's review). Methodology-aware defaults and an audit trail were added in response to other 🟡 concerns.

**P3M layer**: Programs and Projects. A Program owns multiple Projects (ADR-0070, OSS). The rollup config sits on the Program entity and controls how its projects' signals combine at the program boundary. No cross-program aggregation — that would be Portfolio (Enterprise).

## Decision

### Data model — two fields on `Program` (not a side table)

Add to `projects.Program` (`packages/api/src/trueppm_api/apps/projects/models.py:218`):

```python
rollup_enabled_kpis = models.JSONField(default=list, blank=True)  # list[str]
rollup_aggregation_policy = models.CharField(
    max_length=24,
    choices=AggregationPolicy.choices,
    default=AggregationPolicy.WORST,
)
```

Plus an `AggregationPolicy` `TextChoices` enum in the same file: `WORST`, `AVERAGE`, `WEIGHTED_BY_BUDGET`, `TASK_WEIGHTED`. KPI identifiers (also a `TextChoices` enum, `RollupKpi`, validated by the serializer): `schedule_variance`, `cost_variance`, `budget_utilization`, `schedule_health`, `critical_tasks`, `at_risk_tasks`, `baseline_variance`, `risk_score`, `milestone_health`, `p80_completion` (10 KPIs, final list after VoC scope cut).

**Why fields on `Program` rather than a separate `ProgramRollupConfig` model**:
1. `Program` extends `VersionedModel`; `program.save()` auto-bumps `server_version` (the sync protocol fans out unchanged).
2. `Program` already carries `HistoricalRecords()` from django-simple-history — every save creates a `HistoricalProgram` row with field diffs. **This satisfies the audit-trail requirement from the VoC panel (Marcus, Janet, Priya) without a new model.** No `ProgramRollupConfigAudit` is needed.
3. The `history` app's `history_record_created` signal is the existing enterprise extension point for immutable audit stamping (ADR-0011 pattern).
4. A 1:1 side table would either need its own `HistoricalRecords()` and `VersionedModel` mixin (boilerplate) or require explicit `program.save()` calls to keep `server_version` honest (footgun).

### URL routing — `@action` on `ProgramViewSet`

Single endpoint at `/api/v1/programs/:id/rollup-config/`, methods GET + PATCH, matching the issue spec exactly:

```python
@action(detail=True, methods=["get", "patch"], url_path="rollup-config",
        permission_classes=[IsAuthenticated])
def rollup_config(self, request, pk=None): ...
```

Matches the existing `projects` and `integrations_summary` sub-resource pattern on `ProgramViewSet` (`projects/program_views.py:35`). Not a separate viewset — the config is conceptually a sub-resource of `Program`, and `ProgramViewSet` is already routed by `DefaultRouter`.

### Permissions — reuse the existing matrix

- GET: `IsProgramMember` (Viewer+ can read what KPIs will appear on the program overview)
- PATCH: `IsProgramAdmin` (Role.ADMIN/300+, matching the existing pattern for program metadata mutations in `program_views.py:get_permissions`)

Both permission classes already exist in `access/permissions.py`. No new classes.

### Default seeding — data migration + `post_save` signal

Methodology-aware defaults (from the VoC revised scope):

| Methodology | Default enabled KPIs | Default policy |
|---|---|---|
| `WATERFALL` | `schedule_health, baseline_variance, critical_tasks, milestone_health, budget_utilization, cost_variance` | `WORST` |
| `AGILE` | `milestone_health, p80_completion, at_risk_tasks, risk_score` | `WORST` |
| `HYBRID` | union of waterfall + agile | `WORST` |

Seeding strategy:
1. **Migration 0041** (`projects` app): adds the two fields with empty defaults, then a data migration computes `defaults_for(program.methodology)` for every existing program and writes it.
2. **`post_save` signal** on `Program` (in `projects/signals.py`): on `created=True`, if `rollup_enabled_kpis == []`, seed from `program.methodology` via the same `defaults_for()` helper.
3. The helper lives in `projects/services.py::rollup_config_defaults(methodology: Methodology) -> tuple[list[str], AggregationPolicy]` and is the single source of truth.

A subsequent change to `Program.methodology` does **not** auto-recompute defaults — once seeded, the config is user-owned. Resetting to defaults is out of scope for #527 (could be a follow-up "Reset to defaults" button on the page).

### Audit — none new; reuse `HistoricalRecords()`

As stated above. The migration adding the two fields will also automatically extend the `HistoricalProgram` shadow table via simple-history's hooks. No code to write.

### `milestone_health` source — out of scope for #527

The research scan confirmed: at the **program** level there is no existing `milestone_health` computation. The existing `compute_milestone_rollup_payload()` (ADR-0074) operates at task scope inside a single project. The rollup config endpoint persists *whether milestone_health is enabled for display* on the program overview — the actual computation belongs to the consumer (the program-overview rollup view), which is a separate feature. Jordan's question — CPM-derived or velocity-derived — is deferred to that consumer issue. **Recommendation: file a follow-up issue "Program-overview rollup computation" before this MR merges so the dependency is tracked.**

### Frontend wiring

- `useProgramRollupConfig(programId)` — TanStack Query, key `['program-rollup-config', programId]`. Pattern mirrors `useProgramMembers` (`packages/web/src/features/programs/hooks/useProgramMembers.ts`) but **with optimistic updates** for the toggles (per UX scope: toggles optimistic, policy radio explicit save).
- `useUpdateProgramRollupConfig` — `useMutation` with `onMutate` (optimistic update, snapshot rollback) for toggle flips; explicit save path for policy radio uses `useMutation` without optimistic update and shows a toast.
- Remove `StubPageBanner` + `StubFieldset` wrappers from `ProgramRollupPage.tsx`.
- Trim the in-page KPI list from the current 8 hardcoded items to the final 10 KPIs (drop `velocity`/`resource-util`, add `schedule_variance`, `cost_variance`, `budget_utilization`, `milestone_health`).

### What is **not** in scope for #527 (filed as follow-ups)

- Program-overview rollup *computation* — the view that reads this config and produces the actual rolled-up KPI values. (Different issue.)
- Reset-to-defaults button.
- Portfolio-level default override (Enterprise extension point — slot registration per ADR-0029, deferred until the OSS endpoint stabilizes).
- Per-KPI aggregation semantics (Jordan's 🟡 — less acute now that `resource_utilization` is dropped; the single global radio is acceptable).
- Audit-log UI viewer (data captured via simple-history; UI for browsing it is a separate issue if/when needed).

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| A: Two fields on `Program` (chosen) | Auto-versioned via `VersionedModel`, auto-audited via existing `HistoricalRecords()`, single save() bumps `server_version`, no new model | Mixes concerns slightly — adds settings fields to the core entity |
| B: Separate `ProgramRollupConfig` 1:1 model | Stronger isolation; could carry its own indexes | Needs its own `HistoricalRecords()` + `VersionedModel` boilerplate or risks `server_version` drift; doubles the audit surface for no functional benefit |
| C: Separate model + custom `ProgramRollupConfigAudit` table | Most explicit audit shape | Duplicates infrastructure that already exists; new table + new viewset + new tests for zero gain over simple-history |
| D: Stash as a free-form JSON `settings` blob on `Program` | One-time migration, infinitely extensible | No schema validation in DB, no choices enforcement, no migrations for future settings — debt magnet |

| Default-seeding option | Pros | Cons |
|--------|------|------|
| Migration + post_save signal (chosen) | Existing programs and future programs both correctly seeded; explicit code path | Two places to keep in sync (mitigated by single `defaults_for()` helper) |
| Lazy on first GET | Simpler — one place | First-GET write is a side effect of a read; race conditions on concurrent first-reads; muddles HTTP semantics |
| Migration only | Simplest | New programs created post-migration would have empty defaults |

## Consequences

**Easier**:
- Audit story is free (simple-history); no new audit table or viewer code.
- `server_version` sync is automatic for any mobile/offline client consuming `Program`.
- Methodology-aware defaults match what 6/8 personas asked for; no per-program manual setup on day 1.
- Settings sub-resource pattern matches #525, #061 — frontend developers see a familiar shape.

**Harder**:
- Adds two columns to a hot model (`Program`) — but Program is small and not a denormalized hot path, so this is fine.
- `Program.history` will record `rollup_enabled_kpis` changes alongside other Program-level edits; the audit viewer (future) must show the diff field-by-field rather than treating the rollup-config edit as a single event. (Acceptable: simple-history's `diff_against` already does field-level diffs.)

**Risks**:
- The "program-overview rollup computation" follow-up issue is a prerequisite for the toggles to *do* anything visible to end users. The settings page will save preferences that have no consumer until that issue ships. **Mitigation**: file the follow-up issue before this MR merges so the dependency is visible; document the gap in the issue and the changelog fragment.
- 🟡 Marcus wanted portfolio-level default overrides (Enterprise). This is deferred. If Enterprise needs to override OSS defaults later, the `defaults_for()` helper will need to become a slot/registry per ADR-0029. **Risk is low** because changing the helper's contract is an internal refactor, not an API change.

## Implementation Notes

- **P3M layer**: Programs and Projects
- **Affected packages**: `api` (projects app: model + migration + signal + viewset + serializer), `web` (settings page + hook + test + e2e spec)
- **Migration required**: yes — `projects/migrations/0041_program_rollup_config.py` adds two fields + data migration seeding existing programs
- **API changes**: yes — new `@action` `rollup_config` (GET/PATCH) on `ProgramViewSet`; OpenAPI schema must be regenerated (`scripts/export-openapi.sh`) after merging `origin/main`
- **OSS or Enterprise**: OSS. Program is OSS (ADR-0070); intra-program rollup is OSS by the adoption lens.

### Durable Execution
1. Broker-down behaviour: **N/A — synchronous CRUD on Program fields. No Celery dispatch, no outbox row, no async side effects.**
2. Drain task: **N/A — no async work.**
3. Orphan window: **N/A.**
4. Service layer: New `projects/services.py::rollup_config_defaults(methodology)` — pure function returning `(list[str], AggregationPolicy)`; called from the data migration and the `post_save` signal. No dispatch service.
5. API response on best-effort dispatch: **N/A — synchronous 200 responses.**
6. Outbox cleanup: **N/A.**
7. Idempotency: PATCH is idempotent by nature — writing the same `{enabled_kpis, aggregation_policy}` payload produces the same row state. The `HistoricalProgram` shadow table will record a row even for no-op writes (simple-history default); if this becomes noise, configure simple-history `cleanup_duplicate_history` on a nightly job. Not blocking for #527.
8. Dead-letter / failure handling: **N/A — synchronous endpoint. Validation errors return 400; permission errors return 403; missing program returns 404.**
