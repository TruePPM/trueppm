# ADR-0042: Wave 6 — Resources Heatmap and KPI Row

## Status
Accepted

## Context

Wave 6 adds two components to the existing Resources / Team tab (`/projects/:id/resources`):

1. **KPI row** (#219): Four summary cards — Avg utilization, Over-allocated count,
   Under-utilized count, Headcount — giving a one-glance utilization snapshot.
2. **Team heatmap** (#217): Week × person utilization grid with severity-banded colored
   cells, configurable week window (4/8/12/16 weeks), group-by (Role / Project / None),
   click-to-drawer task drill-down, and week navigation.

VoC panel scored this 6.2/10 overall. Primary beneficiaries are David (Resource Manager,
10/10 — needs drawer drill-down and ≥12-week window for headcount forecasting) and Sarah
(PM, 9/10 — needs responsive mobile collapse). Cross-project heat map is explicitly
Enterprise (ENT #1); OSS scope is single-project only.

### Existing infrastructure reused
- `compute_utilization(project, window_start, window_end)` in `utilization.py` — the
  existing daily-bucket engine. Both new endpoints aggregate from it.
- `ProjectViewSet` with `@action` pattern for `utilization` and `resource_allocation` —
  new endpoints follow the same pattern.
- `TaskResource`, `Resource`, `ProjectResource`, `Calendar` models — no new models needed.
- `/api/v1/projects/{id}/members/` endpoint already exposes `ProjectMembership` with
  role ordinals — used to implement `useCurrentUserRole()` in the frontend.

### Gap: tab RBAC
`ViewTabs.tsx` and `BottomNav.tsx` have no per-tab role gating today. The Team tab is
visible to all roles including MEMBER. The API is correctly gated at SCHEDULER (role ≥ 2)
via `IsProjectScheduler`, but a visible tab returning a 403 is confusing to Team Members.
`ResourceView.tsx` has a role stub (`STUB_ROLE = 2`) waiting for a real hook. This ADR
delivers that hook.

## Decision

### 1. Two new read-only `@action` endpoints on `ProjectViewSet`

**Heatmap endpoint**
```
GET /api/v1/projects/{id}/resources/heatmap/
    ?weeks=8          # 4 | 8 | 12 | 16; default 8
    &start=YYYY-MM-DD # defaults to current ISO-week Monday
    &group_by=role    # role | project | none; affects row sort order only
```

Response shape:
```json
{
  "weeks": ["2025-W18", "2025-W19", ...],
  "resources": [
    {
      "id": "<uuid>",
      "name": "Anna Khoury",
      "initials": "AK",
      "job_role": "Engineer",
      "color": "#4f46e5",
      "util": [80, 90, 100, 110, 120, 95, 100, 90]
    }
  ]
}
```

`util` values are integer percent (0–200+). `color` is deterministic from the resource
UUID (hashed to one of 12 brand palette hues). Row order: sorted by `group_by` then name.

**Summary endpoint**
```
GET /api/v1/projects/{id}/resources/summary/
```

Response shape:
```json
{
  "avg_utilization_pct": 94,
  "over_allocated_count": 3,
  "over_allocated_weeks": "W21–W23",
  "under_utilized_count": 2,
  "under_utilized_names": ["P. Banerjee", "A. Schoen"],
  "headcount": 8,
  "contractor_count": 2
}
```

Both endpoints require `IsProjectScheduler` (role ≥ 2), matching the existing
`utilization` and `resource_allocation` gates.

### 2. `aggregate_utilization_weekly()` helper in `utilization.py`

New function that calls `compute_utilization()` and buckets daily hours into ISO weeks,
computing `util_pct = (weekly_hours / (capacity_hours_per_week)) * 100` per resource per
week. Reuses the existing calendar-aware daily load engine; no new scheduling logic.

`contractor_count` is derived from `ProjectResource.role_title` containing "contractor"
(case-insensitive) or `Resource.job_role` containing "contractor". This is a convention,
not a model field — acceptable for v1; a proper `is_contractor` flag is deferred.

### 3. `useCurrentUserRole()` hook

New TanStack Query hook at `hooks/useCurrentUserRole.ts`:
```ts
useCurrentUserRole(projectId: string): { role: number | null; isLoading: boolean }
```

Calls `GET /api/v1/projects/{projectId}/members/?self=true` (new `?self` filter on
`ProjectMembershipViewSet` — returns only the requesting user's own row). Cached per
project via standard TanStack Query key `["project-member-self", projectId]`.

This resolves the `STUB_ROLE = 2` in `ResourceView.tsx` and enables tab-level gating.

### 4. Tab RBAC in `ViewTabs.tsx` and `BottomNav.tsx`

The Team tab is hidden (not just disabled) for users with role < SCHEDULER (role < 2).
Implementation: both components receive the role from `useCurrentUserRole()` and
conditionally omit the Team entry from the rendered tab/nav list.

Consistent with ADR-0041 methodology gating pattern (tab omission, not disabling).
Direct URL access (`/projects/:id/resources`) still works — the view itself shows
`<PermissionDeniedNotice />` for role < SCHEDULER, matching existing `ResourceView`
behavior.

### 5. New React components

| Component | Location | Responsibility |
|---|---|---|
| `ResourcesKpiRow` | `features/resource/ResourcesKpiRow.tsx` | Four KPI cards, skeleton loaders, color thresholds |
| `ResourcesHeatmap` | `features/resource/ResourcesHeatmap.tsx` | Week×person grid, header row, cell color, week nav, group-by toggle |
| `HeatmapCell` | `features/resource/HeatmapCell.tsx` | Individual cell with `cellColor()` logic, click handler |
| `HeatmapCellDrawer` | `features/resource/HeatmapCellDrawer.tsx` | Slide-in drawer listing tasks competing for resource × week |
| `WeeksWindowControl` | `features/resource/WeeksWindowControl.tsx` | 4/8/12/16-week toggle pill group |

`ResourcesKpiRow` and `ResourcesHeatmap` are rendered inside the existing `ResourceView`
above the existing timeline/utilization toggle (or as a new "Heatmap" mode alongside
"Timeline" and "Utilization").

### 6. Mobile responsive collapse

Below 768px (`< md`), `ResourcesHeatmap` collapses to a vertical list: one row per
resource showing name + avatar + a 8-cell mini sparkline (colored squares, no text).
Full grid is scrollable horizontally on tablet (≥ 640px < 1024px).

### 7. Enterprise upsell slot

`ResourcesHeatmap` header contains a `Level loads` button. In OSS it is rendered with an
upsell tooltip: _"Available in Team tier"_ (using the existing `UpsellTooltip` pattern
from ADR-0029). A slot registry ID `resources_heatmap.level_loads` is registered so
Enterprise can replace the button with the real leveling preview action.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| Extend existing `/utilization/` with `?granularity=week` | One endpoint, less surface | Breaks existing consumers; daily and weekly have different response shapes |
| Client-side weekly bucketing from existing `/utilization/` | No new backend endpoint | Transfers large daily payload for 12–16 week windows; n+1 calendar logic re-implemented in JS |
| New `HeatmapViewSet` separate from `ProjectViewSet` | Clean separation | Inconsistent with existing `utilization`/`resource-allocation` action pattern |
| Expose role in JWT claims | No extra API call for role | JWT claims go stale; role change requires token refresh cycle |

## Consequences

- **Easier**: David can do 90-day headcount forecasting from the 16-week window. Drawer
  drill-down makes conflicts actionable without an email chain. Sarah gets mobile-usable
  view via responsive collapse.
- **Harder**: `ProjectMembershipViewSet` needs a `?self` filter — minor addition but
  touches the access app. `ViewTabs` and `BottomNav` now need the role hook, adding a
  suspense boundary or skeleton state to the shell.
- **Risks**: `compute_utilization()` is called twice per page load (once for heatmap,
  once for summary) unless both endpoints share a cached compute result. Mitigation: the
  heatmap endpoint computes both heatmap rows and summary stats in a single pass and
  returns them together, or the summary endpoint is cheap enough (aggregates over the
  8-week default window only). Measure in `perf-check` before merging.

## Implementation Notes

- **P3M layer**: Programs and Projects (single-project scope)
- **Affected packages**: `api`, `web`
- **Migration required**: No — no new models; `?self` filter on existing view is code-only
- **API changes**: Two new `@action` endpoints on `ProjectViewSet`; one new query param
  (`?self`) on `ProjectMembershipViewSet`
- **OSS or Enterprise**: OSS (`trueppm-suite`)

### Durable Execution

1. **Broker-down behaviour**: N/A — both endpoints are synchronous reads with no async
   side effects.
2. **Drain task**: N/A — no new async work category.
3. **Orphan window**: N/A — no outbox rows written.
4. **Service layer**: `compute_utilization()` in `utilization.py` is the existing service
   function reused; new `aggregate_utilization_weekly()` wrapper added to the same module.
5. **API response on best-effort dispatch**: N/A — synchronous 200 responses.
6. **Outbox cleanup**: N/A.
7. **Idempotency**: N/A — read-only endpoints; safe to call any number of times.
8. **Dead-letter / failure handling**: N/A — no background tasks. 409 is returned (same
   as existing `utilization` endpoint) when CPM has not been run and `early_start` /
   `early_finish` are null for all tasks.
