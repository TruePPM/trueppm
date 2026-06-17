# ADR-0144: Consolidated schedule forecast bar, persisted per-run distribution, per-workspace forecast-history config

## Status
Accepted

## Context
The Schedule view's Monte Carlo forecast surface (ADR-0140) grew three independent
problems, all reported together (#1231, #1232):

1. **Two redundant, disagreeing surfaces.** The forecast appears twice on the
   Schedule view — a top `MonteCarloRow` ("σ Monte Carlo" with the Rerun + Details
   buttons) and a bottom `ScheduleInsightsBar` ("Forecast & sensitivity", collapsible
   histogram + tornado). The two compute their P50/P80/P95 dates from the same server
   payload but render **different calendar days** (e.g. Aug 19/21/25 vs Aug 18/20/24).
   Root cause is a pure frontend timezone bug: `MonteCarloTimeline` formats with
   `timeZone: 'UTC'`, while `ScheduleInsightsBar.fmtDate`, `MonteCarloDetailPanel`'s
   `fmtLong`/`fmtRelDate`, and `HealthCluster`'s `formatForecastDate` omit it and so
   render in the browser's local zone — one day earlier west of UTC. The server's ISO
   dates are the source of truth; the percentiles are also rendered three times within
   the bottom bar alone (header summary + `ForecastStat` chips).

2. **"P80 —" in the shell health header.** `forecastSegment` in
   `shell/healthClusterModel.ts` reads `p80: stats?.monteCarlop80 ?? null` from the
   project status summary, which hardcodes `monte_carlo_p80 = None`
   (`projects/views.py`). The live MC result carries a real `p80`, but the segment
   never falls back to it, so the header renders an em-dash.

3. **Missing histogram + no durable run history.** The full distribution
   (histogram buckets, confidence S-curve, duration-sensitivity tornado) lives **only**
   in the 24h Valkey cache (`mc_latest:<pk>`). `MonteCarloRun` (ADR-0109) persists each
   run's percentiles, CPM finish, n_simulations, taken_at, and triggered_by — but **not**
   the distribution. Once the cache TTL expires, the `/latest/` from-history fallback and
   every historical run return empty buckets, so `MonteCarloHistogram` shows misleading
   prose ("Every simulation finished on {date}…") instead of a chart, and a past run's
   shape can never be re-viewed.

The history machinery itself already exists: `GET /projects/{pk}/monte-carlo/history/`
returns runs capped at `MC_HISTORY_CAP = 100`, with delta-vs-prior computed on read and
per-run attribution (`triggered_by_name`) gated to Admin/Owner via `can_see_attribution`.
`ForecastHistorySection` + `useMonteCarloHistory` exist but are only mounted in the detail
panel, not on the Schedule bar.

A Voice-of-Customer panel (8 personas, 2026-06-17) on **who should see run history**
returned avg 4.6. The OSS cohort (Sarah/Jordan/Alex) want **all members to view** the
list; the team-autonomy cohort (Morgan/Priya) want it **configurable, attribution
name-gated, and never piped to PMO** — Morgan's hard line is the Enterprise boundary, and
Priya's hard line is that reruns must **never** push-notify. Janet/David scored low only
because run-level history is the wrong layer for portfolio governance — not a build
blocker.

P3M layer: Programs and Projects (OSS) — the scheduling engine forecast surface and its
per-workspace configuration. Cross-program/portfolio rollup of forecast history remains
Enterprise (ADR-0109 line, unchanged).

## Decision

Three coordinated changes, shipped as one MR because they share files and migrations.

### A. Consolidate to one `ScheduleForecastBar` (frontend)

Replace `MonteCarloRow` (top) and `ScheduleInsightsBar` (bottom) with a single docked
`ScheduleForecastBar` at the bottom of the Schedule view. It owns the MC hooks, the
percentile chips (rendered **once**), the maximize/minimize toggle, the consolidated
**Rerun** and **Details** actions, the run-history disclosure, and — when expanded — the
histogram + sensitivity tornado. The no-result "Run a simulation" prompt and the stale /
recomputing machinery (`isStale`/`isRecomputing`/`mutationVersion`) move here too.

- **Single shared UTC formatter.** New `lib/formatUtcDate.ts` exports `fmtUtcShort`
  ("Aug 19") and `fmtUtcLong` ("August 19, 2026"), both pinned to `timeZone: 'UTC'`.
  Every forecast date — bar, detail panel, health cluster, timeline — routes through it.
  This is the single fix for the date-disagreement bug; no component formats MC dates
  inline anymore.
- **`forecastSegment` fallback.** `p80: stats?.monteCarlop80 ?? mc?.p80 ?? null` so the
  header uses the live MC `p80` when the status summary omits it.
- **Percentiles rendered once.** The `ForecastStat` triplet is dropped; the chips are the
  single source on the bar.
- **Histogram empty-state fix.** `MonteCarloHistogram` distinguishes
  `buckets.length === 0` (expired / not persisted → "Run a fresh simulation to see the
  distribution") from `buckets.length === 1` (genuine zero-spread → the existing
  "finished on {date}" prose).
- **Maximize/minimize** persists in `localStorage['schedule.insightsExpanded']` (key
  retained). Motion uses the existing `animate-empty-state-in` only (rule 177).
- **Run history** surfaced on the bar via the existing `ForecastHistorySection`
  (disclosure), list visible to **all project members**; the `triggered_by_name`
  attribution column stays gated server-side. **No push notification on rerun** (Priya).

New web rule **186** records the consolidated-bar invariants (single bar, single toggle
bound to that localStorage key, three distinct affordances, no `ForecastStat` triplet,
all MC dates through `formatUtcDate`).

### B. Persist per-run distribution (#1231, backend)

Add `MonteCarloRun.distribution = JSONField(null=True, blank=True)` — additive, nullable,
**no backfill** (legacy runs keep empty buckets and render the empty-state prose). It
stores the same `{histogram_buckets, confidence_curve, sensitivity}` payload the cache
holds, written at run-record time.

- **Size guard.** The persisted JSON is capped at `MC_DISTRIBUTION_MAX_BYTES = 32_768`;
  if the serialized payload exceeds it the buckets are down-sampled before persist (the
  cache copy is unaffected). This bounds row size against a pathological high-bucket run.
- **Exposure.** `MonteCarloRunSerializer` gains a `distribution = SerializerMethodField()`
  that returns the column **only** when `context['expand_distribution']` is set — keeping
  the history *list* lightweight. `MonteCarloHistoryView` accepts `?expand=distribution`
  to opt a single detail fetch into the heavier payload.
- **`/latest/` from-history fallback** returns the persisted `distribution` (when present)
  instead of empty buckets, so the histogram survives cache expiry.

`MonteCarloRun` stays a plain `Model` (not `VersionedModel`) — it is server-owned audit
history, never client-synced.

### C. Per-workspace forecast-history config (#1232, backend)

Make history a per-workspace option, inheritable Workspace → Program → Project per the
ADR-0135 sharing precedent (and ADR-0116 iteration-label resolver shape):

- **Workspace** (root) gains non-null columns: `mc_history_enabled` (bool, default True),
  `mc_history_retention_cap` (int, default `MC_HISTORY_CAP = 100`, clamped to
  `MC_HISTORY_HARD_CAP = 500`), and `mc_history_attribution_audience`
  (`MCAttributionAudience` TextChoices: `ADMIN_OWNER` default | `SCHEDULER_PLUS` | `NONE`),
  plus an `mc_history_override_policy` (allow / lock — **lock is Enterprise-enforced**;
  OSS stores but does not enforce downstream locking).
- **Program / Project** gain nullable mirror columns (`null` = inherit).
- **Resolver.** New `scheduling/forecast_history_settings.py` mirrors
  `sharing_settings.py`: `resolve_effective_mc_history(obj, key)` /
  `resolve_inherited_mc_history(obj, key)` walk Project → Program → Workspace → Django
  setting default, and `register_forecast_history_enforcement_provider` /
  `forecast_history_enforcement_active` expose the **stable extension seam** enterprise
  registers its lock enforcement against (OSS ships an inert default provider).
- **Wiring.** `MonteCarloHistoryView` returns 200 with an empty list + `enabled: false`
  when `resolve_effective_mc_history(project, "mc_history_enabled")` is False;
  `can_see_attribution` is driven by the resolved `mc_history_attribution_audience`
  (ADMIN_OWNER → Admin/Owner; SCHEDULER_PLUS → Scheduler+; NONE → nobody) rather than the
  hardcoded Admin/Owner check; the purge task reads the per-project effective retention
  cap instead of the global constant.

Settings UI exposes the three fields on the Workspace/Program/Project settings sub-pages
via the existing `InheritableToggleField` / inheritable-field pattern (null = inherit
badge; lock affordance shows an Enterprise badge in OSS).

## Consequences

- **Positive.** One forecast surface, one set of dates (UTC, correct), one toggle. The
  histogram survives cache expiry and past runs are re-viewable. History visibility,
  retention, and attribution become a workspace decision the team owns — matching the VoC
  OSS cohort — without crossing into portfolio governance. The enforcement seam keeps the
  Enterprise lock additive.
- **Negative / trade-offs.** Row size grows by up to 32 KB per persisted run (bounded by
  the cap + down-sampling); the 500-run hard cap bounds total per-project storage. Legacy
  runs persist no distribution and keep the empty-state prose — acceptable, no backfill.
  The attribution enum is three-valued (vs the prior binary gate); default `ADMIN_OWNER`
  preserves today's behavior exactly, so the change is reversible and needs no operator
  action.
- **Boundary.** Per-workspace config is OSS (precedent ADR-0135, ADR-0116, attachment
  policy). Downstream lock *enforcement* and any cross-program/portfolio rollup of
  forecast history are Enterprise — registered against the OSS provider seam, never
  imported by OSS.

## Alternatives considered
- **Three back-to-back MRs.** Rejected: the parts share `scheduling/models.py`,
  `serializers.py`, `views.py`, and the migration chain, and the FE bar depends on the
  persisted-distribution contract — separate branches would collide on every shared file.
- **Always-on history, no config.** Rejected: violates Morgan/Priya team autonomy and the
  VoC "configurable + name-gated" signal.
- **Store distribution in a side table.** Rejected as premature; a nullable JSON column on
  the existing per-run row is simpler, and the size guard bounds the downside.
- **Repurpose `ProjectForecastSnapshot` (#388).** Rejected: that is a different model
  (CPM-vs-MC trend, no distributions); diverging it would conflate two concerns.
