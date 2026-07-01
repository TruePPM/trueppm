# ADR-0062: Burn Charts — Web Implementation (Recharts, Reports Tab, PDF Export)

## Status
Accepted (2026-05-10) — Implements the web UI portion of ADR-0022. The API
was implemented in #239; this ADR covers the frontend component, Reports tab,
Sprint burndown migration, combined chart approach, and PDF export.

> Partially supersedes [ADR-0022](0022-burn-charts.md) §2 (response shape).

## Context

ADR-0022 made the core architecture decisions for burn charts (Recharts, html-to-image,
`BurnSnapshot` table). The actual API implementation in #239 diverged from the ADR in
two places: (1) the snapshot table was deferred (endpoint replays `HistoricalTask`
directly), and (2) the endpoint URL is `/projects/{pk}/burn/` not `/projects/{pk}/burn-chart/`.
Both divergences are acceptable for 0.1 — this ADR records the as-built state and
extends it with the web implementation decisions.

**P3M layer**: Programs and Projects (single-project scope). OSS.

**As-built API surface** (supersedes ADR-0022 §2 response shape):

```
GET /api/v1/projects/{pk}/burn/
  ?chart_type=burndown|burnup  (combined raises ValueError — fixed here)
  ?metric=tasks|points
  ?since=YYYY-MM-DD  (defaults to project start_date)
  ?until=YYYY-MM-DD  (defaults to today)

Response: {
  series: [{date, actual, ideal, scope}],
  baseline_series?: [{date, actual, ideal, scope}],
  scope_changes: [{date, delta}]
}

GET /api/v1/sprints/{pk}/burndown/
  → sprint metadata + SprintBurnSnapshot[] series
  → fields: remaining_points, remaining_task_count, completed_points,
            completed_task_count, scope_change_points, scope_change_task_count

GET /api/v1/projects/{pk}/velocity/
  → last-8 closed sprint stats, rolling avg, std_dev, forecast range
```

**VoC concerns to resolve** (from 2026-05-10 panel, average 4.7/10):
- Alex (7/10): Sprint-scoped endpoint already exists; scope-change markers are a win
- Sarah (6/10): PDF export needed alongside PNG; offline chart cache for mobile
- Priya (3/10): Mobile project-card widget must be opt-in (default hidden)
- Janet/Marcus/David scored low because they need portfolio aggregation — intentionally
  out of scope for OSS; scores are structurally expected, not a design failure

**Metric availability confirmed**:
- `tasks`: implemented in `burn_series()` ✅
- `points`: `Task.story_points` (nullable `PositiveSmallIntegerField`) exists ✅ — fall back
  to task count when story_points is null across the project (i.e. the project doesn't use SP)
- `hours`: `TimeEntry` model does not exist — **drop from v1**

**Hand-rolled SVG components in the wild**:
- `packages/web/src/features/sprints/SprintBurndownChart.tsx` — burndown only, comment
  notes "ADR-0022 deferral of Recharts". Migrate to Recharts as part of this issue.
- `packages/web/src/features/sprints/VelocityPanel.tsx` — hand-rolled SVG bar chart.
  Leave untouched for #53 (velocity is already functional; Recharts migration is follow-up).

## Decision

### 1. Install Recharts, html-to-image, jspdf

Per ADR-0022 §3. Add to `packages/web/package.json`:
- `recharts` — MIT, ~45KB gzip, covers `LineChart`, `AreaChart`, `ComposedChart`
- `html-to-image` — MIT, ~15KB gzip, client-side PNG capture from SVG
- `jspdf` — MIT, wraps PNG blob into a single-page PDF for client presentations

VoC concern addressed: Sarah's Friday client deck needs PDF, not just PNG. One export
button with two format options (PNG / PDF) avoids a separate client workflow.

### 2. Backend fix: support `combined` chart_type in `burn_series()`

`burn_series()` currently raises `ValueError` for `chart_type=combined`. Fix:

When `chart_type=combined`, call the existing burndown and burnup logic and merge the
two series arrays into one response with distinct keys:

```python
# services.py — burn_series() combined branch
return {
    "burndown": burn_series(project, since, until, metric, chart_type="burndown"),
    "burnup":   burn_series(project, since, until, metric, chart_type="burnup"),
    "scope_changes": scope_changes,
}
```

`ProjectBurnView` must handle the combined response shape and pass it to the serializer.
This is a small backend change with no migration.

### 3. Unified `<BurnChart>` component (Recharts)

`packages/web/src/features/reports/BurnChart.tsx`

Props:
```typescript
interface BurnChartProps {
  projectId: string
  sprintId?: string          // if set, uses sprint endpoint + sprint date range
  defaultVariant?: 'burndown' | 'burnup' | 'combined'
  metric?: 'tasks' | 'points'
  compact?: boolean          // sparkline mode for mobile project card
}
```

Renders:
- **Burndown**: `<AreaChart>` — remaining work area + ideal burn `<ReferenceLine>` (dashed)
- **Burnup**: `<AreaChart>` — completed area + total scope `<ReferenceLine>`
- **Combined**: `<ComposedChart>` — both series on shared axes, distinct colours
- Segmented control: switches variant (burndown / burn up / combined) without remount
- Metric selector: tasks | points (shown only when project has ≥1 story_points value)
- Date range pickers: from/to; defaults to full project or sprint date range
- Scope change markers: `<ReferenceDot>` on dates where scope δ ≠ 0
- Export toolbar: PNG button (html-to-image) + PDF button (jspdf)
- Responsive via `<ResponsiveContainer width="100%" height={320}>`

TanStack Query hook `useBurnChart(projectId, opts)` at
`packages/web/src/features/reports/hooks/useBurnChart.ts` — calls
`GET /projects/{pk}/burn/?chart_type=...&metric=...&since=...&until=...`.
Cache key: `['burn-chart', projectId, variant, metric, since, until]`. Stale time: 5 min.

For sprint-scoped view, `useSprintBurndown(sprintId)` already exists in
`packages/web/src/hooks/useSprints.ts:253` — `BurnChart` receives the transformed
series directly when `sprintId` is provided (no duplicate hook).

### 4. Replace `SprintBurndownChart.tsx` with shared `BurnChart`

`SprintBurndownChart.tsx` (hand-rolled SVG) is replaced by `<BurnChart sprintId={sprint.id} defaultVariant="burndown" />`. The hand-rolled file is deleted. Sprint burnup variant is supported because `SprintBurnSnapshot` carries `completed_points/completed_task_count` — the `useSprintBurndown` hook already returns this data; `BurnChart` just needs to render the burnup series when that variant is selected.

Combined for sprint: call `useSprintBurndown` (single request) and derive both series
from the snapshot fields — no additional API request needed.

### 5. Reports tab — new route and ViewTabs entry

New route: `/projects/:projectId/reports`

```
packages/web/src/features/reports/
  ReportsView.tsx       — page shell, hosts <BurnChart>
  BurnChart.tsx         — Recharts component (§3)
  hooks/
    useBurnChart.ts
```

`router.tsx`: add `reports` route alongside existing `schedule`, `board`, `sprints`, etc.

`ViewTabs.tsx`: add "Reports" tab entry. Consistent with ADR-0022 §4 ("Reports tab per
rule 108"). Tab is visible to Viewer role and above (same permission as the endpoint).

### 6. Mobile — opt-in sparkline on project card

The simplified single-line sparkline on the mobile project overview card is implemented
as an **opt-in widget** (default hidden). Preference persisted in AsyncStorage under key
`trueppm.mobile.projectCard.burnSparkline`. A small toggle in the project card header
area controls visibility.

When visible: renders 60px-tall sparkline using `react-native-svg` (already a transitive
dep) showing the last 14 days of remaining-task burndown. Data is the last-fetched API
response cached in WatermelonDB; a stale indicator appears if data is > 24h old.

Priya VoC concern resolved: default-hidden prevents chart noise on her primary "My Tasks"
surface.

### 7. Story points metric — null fallback

When the user selects "story points" metric and > 50% of project tasks have
`story_points = null`, the chart renders with a `🟡` info banner: "Most tasks don't have
story point estimates — switch to task count for a complete picture." The metric selector
remains enabled so the user can still see partial data.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| Keep hand-rolled SVG for sprint burndown | Zero new dependency | Two parallel chart implementations; burnup + combined require rewriting the SVG from scratch |
| Combined via two separate API requests | No backend change | Double network round-trip; race condition on loading states |
| **Combined via merged series in backend** (chosen) | Single request, clean response | Small backend change required to `burn_series()` |
| Server-side PDF (WeasyPrint/matplotlib) | Pixel-perfect output | Heavy server dependency, slower, can't do interactive-then-export workflow |
| **jspdf wrapping html-to-image** (chosen) | Zero server overhead, MIT, same pipeline as PNG | PDF is raster not vector; acceptable for client decks |

## Consequences

- **Easier**: Unified component means Sprint burndown and project burndown stay in sync
  visually; PDF export unblocks Sarah's Friday client workflow; `html-to-image` is also
  available for future EVM charts (Enterprise reuse)
- **Harder**: Recharts adds ~45KB gzip + jspdf adds ~30KB gzip (~75KB total). Acceptable
  for the Reports tab where users explicitly navigate to see data
- **Risks**: `Task.story_points` is nullable — projects that pre-date ADR-0037 will have
  null values everywhere; the fallback banner (§7) handles this gracefully
- **VelocityPanel migration deferred**: remains hand-rolled SVG for now; follow-up issue
  should migrate it to Recharts `<BarChart>` for visual consistency

## Implementation Notes

- P3M layer: **Programs and Projects**
- Affected packages: `api` (burn_series combined fix), `web` (Recharts component + Reports tab)
- Migration required: **no** — no new models
- API changes: **yes** — `combined` chart_type support in `burn_series()` + `ProjectBurnView`
- OSS or Enterprise: **OSS**

### Durable Execution

1. **Broker-down behaviour**: N/A — burn chart endpoints are pure read. No async dispatch.
2. **Drain task**: N/A — no new async work. Existing `update_sprint_burndown_snapshots`
   Beat task (ADR-0037) is unaffected.
3. **Orphan window**: N/A — no outbox writes.
4. **Service layer**: N/A — read path only. `burn_series()` is a synchronous service
   function already in `services.py`; the `combined` fix extends it in-place.
5. **API response on best-effort dispatch**: N/A — synchronous read endpoints return 200.
6. **Outbox cleanup**: N/A.
7. **Idempotency**: N/A — read-only; no side effects.
8. **Dead-letter / failure handling**: N/A — API errors return 4xx/5xx directly; no
   background job introduced.
