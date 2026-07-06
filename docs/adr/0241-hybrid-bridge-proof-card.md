# ADR-0241: Hybrid-Bridge Proof Card — Co-locating "Velocity Feeds the Schedule"

## Status
Accepted

## Context
Issue #730 (OSS, beta-blocker — the "#1 wow gap") asks us to make TruePPM's core
promise *visible in one glance*: that a team's **velocity feeds the CPM schedule**.
Today the two halves of that causal chain live on different surfaces — the velocity
band and re-pace line under the `SprintPanel` (`VelocityForecastLine`, #607), and the
CPM milestone date + float on the `AdvancingToMilestoneCard` (#551) in the SprintsView
header grid. A PM has to hold both in their head to believe the bridge is real.

#730 extends the existing `AdvancingToMilestoneCard` into **one "hybrid-bridge proof
card"** that co-locates four things for the active sprint's bound milestone:
1. Velocity-implied completion vs the CPM completion date, side by side.
2. The delta since the last sprint close ("finish moved Nov 18 → Nov 22 after Sprint 12").
3. A short "if velocity holds" forward projection.
4. A P80 chip that updates live when a sprint closes.

The bridge machinery already exists and is the source of record:
- `projects.ForecastSnapshot` (ADR-0106 §5, #860/#388) — **milestone-grain**, one row per
  reforecast-on-close + per explicit refresh/rebind. Fields: `taken_at` (auto_now_add),
  `basis` (`velocity_band` today, `monte_carlo` after #411), `cpm_finish`, `p50`, `p80`,
  `velocity_low`/`velocity_high` (the **band** — never the per-sprint series, ADR-0104),
  `confidence`, `unmodeled_dependency`. Ordered `-taken_at`; indexed `(milestone, -taken_at)`
  and `(project, -taken_at)`.
- `GET /api/v1/projects/{id}/forecast/` → `ProjectForecast { velocity, remaining_committed_points,
  sprints_to_complete_low/high, milestones: ForecastSnapshot[] }`, latest-per-milestone via
  `DISTINCT ON (milestone_id)` in `project_forecast()`. Web hook `useProjectForecast`.
- Sprint close writes a fresh snapshot synchronously (`reforecast_bound_milestone`, inside the
  close drain, `projects/tasks.py`) and, on commit, broadcasts `milestone_forecast_updated`;
  the web WS handler (`useProjectWebSocket.ts`) **already** invalidates
  `['project', id, 'forecast']` on that event.

P3M layer: **Programs and Projects** — a single team reading its own bound milestone.
OSS. No cross-program/portfolio/governance surface is introduced (see §4).

## VoC constraints (panel already run — these are binding)
- **web-rule 166 (Jordan 🔴):** percentile vocabulary (P50/P80/P95) is reserved for **real
  Monte Carlo only**. The P80 chip may keep a percentile label **only** when the snapshot's
  `basis === "monte_carlo"` (genuine MC `p80`). The velocity-implied completion and the "if
  velocity holds" projection are a velocity-band heuristic and MUST render as **Early / Likely /
  Late** with a **"(velocity estimate)"** qualifier — never a bare single date, never a
  percentile. Precedent: `VelocityForecastLine.tsx :: MilestoneForecast` (its
  `simulated = basis === 'monte_carlo'` branch) and `notify_milestone_forecast_shift` (#1094).
- **Boundary non-propagation (Morgan 🟡):** the card's derived velocity fields stay
  team/Sprints-surface only. They are **not** fed into any program/portfolio/PMO rollup
  serializer (relates ADR-0104 velocity privacy gate). See §4.
- **Delta as a band shift (Alex 🟡):** the "Nov 18 → Nov 22" delta is anchored so it does not
  read as false precision. See §2.
- **Off My Work, no notifications (Priya):** structurally scoped to the SprintsView card. No
  new notification, no My Work surface. (The #861 close digest already exists and is unchanged.)

## Decision

### 1. Data source for the "delta since last close" — reads only, no new model, no migration
`projects.ForecastSnapshot` history already persists every reforecast, so the "previous"
value is already on disk. We surface it by extending the **existing** forecast read — no
schema change.

**`project_forecast()` (service) attaches, per bound milestone, a `previous` snapshot and a
`previous_sprint_name`:**
- **`previous`** = the *second-most-recent* `ForecastSnapshot` for that milestone by
  `-taken_at`. This is exactly the prior-selection already used by
  `notify_milestone_forecast_shift` (`.exclude(pk=latest.pk).order_by("-taken_at").first()`).
  We reuse that definition so the card's delta and the #861 digest agree on what "prior" means.
- **`previous_sprint_name`** — honest sprint attribution **without a sprint FK** (there is no
  sprint linkage on `ForecastSnapshot`, and `Sprint` has no numeric sequence — only a free-text
  `name`/`short_id`). We attribute the latest snapshot to a sprint close **only when it
  provably followed one**: the project's sprint whose `closed_at` falls in the half-open window
  `(previous.taken_at, latest.taken_at]`. If **exactly one** such sprint exists →
  `previous_sprint_name = sprint.name` (e.g. `"Sprint 12"`, whatever the team calls it). If
  **zero or more than one** → `null`, and the card says **"since the last forecast"** rather
  than inventing a sprint number. A manual refresh/rebind writes a snapshot with **no** closed
  sprint in its window → `null` → no false "after Sprint N" attribution. This is the honest
  answer to "which close moved it?" that a nullable FK would give, computed on read.

**Query shape (one extra query for `previous`, one for attribution):**
- Keep the existing `DISTINCT ON (milestone_id)` for `latest`.
- Fetch all snapshots for the bound milestones ordered `(milestone_id, -taken_at)` in one
  query (covered by the `(milestone, -taken_at)` index; bounded by the nightly forecast-history
  purge) and, in Python, take index `[1]` per `milestone_id` as `previous`.
- One query for the project's `state=COMPLETED` sprints with `closed_at, name`, matched in
  Python against each milestone's `(previous.taken_at, latest.taken_at]` window.
- Attach `previous` and `previous_sprint_name` as plain attributes on each `latest` instance.

**Serializer:** `ForecastSnapshotSerializer` gains two read-only `SerializerMethodField`s:
- `previous` → a **slim nested** shape `{ cpm_finish, p50, p80, velocity_low, velocity_high,
  basis, confidence, taken_at }` or `null` (reads the attached `previous` instance).
- `previous_sprint_name` → `str | null`.

The delta itself is **computed client-side** from `latest.cpm_finish` vs `previous.cpm_finish`
(see §3) — the server ships the two anchored values, not a pre-formatted delta string.

### 2. The delta is a CPM-finish shift, anchored (Alex 🟡)
The delta line is computed on **`cpm_finish`** — the deterministic CPM spine, the one
date on the snapshot that is a *real* schedule value and not a velocity heuristic. `p50`/`p80`
are today velocity-band heuristics (`basis === "velocity_band"`), so they are **not**
eligible to show as exact dates (web-rule 166); the delta must not be built on them.

To avoid false precision (Alex), the delta renders as a **directional band shift**, not a bare
pair of promises: the two dates plus a signed working-day chip and a tone —
`Schedule finish moved Nov 18 → Nov 22 · +4d · since Sprint 12`, where "later" is at-risk tone,
"earlier" is on-track, and 0 is neutral. The chip magnitude (`+4d`) carries the meaning; the
calendar dates are context, framed as "Schedule finish" (CPM), never as a committed delivery
promise. When `previous` is absent or either `cpm_finish` is null, the delta line is omitted
(first forecast = no prior to shift from).

### 3. Card composition — extract `MilestoneBridgeForecast`, switch on `basis`
`AdvancingToMilestoneCard` is already dense (name, days-out, rollup, predecessors, variance,
scope chip). Rather than inline more, we **extract a sub-component**
`MilestoneBridgeForecast.tsx` rendered inside the card, below the rollup block. The card stays
the container; the sub-component owns the bridge proof and is unit-testable in isolation.

Layout (top → bottom):
- **Two columns, side by side** — *Velocity-implied* | *Schedule (CPM)*:
  - **Velocity-implied**: an **Early / Likely / Late** band with a `(velocity estimate)`
    qualifier — the honest render of the velocity-band `p50`/`p80` spread, reusing
    `VelocityForecastLine`'s not-simulated branch verbatim in spirit. Never a percentile,
    never a bare single date.
  - **Schedule (CPM)**: the deterministic `cpm_finish` as an exact date (legitimate — CPM
    spine), with the existing float/critical annotation reused from #551.
- **Delta line** (§2) — the CPM-finish shift chip.
- **"If velocity holds" projection** — one line reusing the `sprints_to_complete_low/high`
  re-pace already computed for `VelocityForecastLine`'s `BacklogForecast` ("~N–M more sprints
  → ~{date}"), phrased as an estimate. No new math.
- **P80 chip** — conditional: when `basis === "monte_carlo"` (real MC, post-#411) it renders
  `P80 {date}`; today (`velocity_band`) it renders the **Likely** velocity chip instead. Either
  way it re-renders live off the forecast query (§below). This is the single component that will
  "light up" as a true percentile the day #411's agile-aware MC lands — no card rewrite needed.

**Gate:** the sub-component takes an `enabled` prop = velocity **not** suppressed
(ADR-0104), computed at the SprintsView call site from `useProjectVelocity(...).data
?.velocity_suppressed` — identical to `VelocityForecastLine`'s existing gate — so an
out-of-audience reader never pulls the band.

**Responsive (Sarah 🟡):** the two columns stack to one at narrow width
(`flex-col sm:flex-row`) so the card stays legible on a phone browser. Full mobile is out
of scope for #730.

### 4. Live P80 update — no new wiring; reuse the existing invalidation path
When a sprint closes, `reforecast_bound_milestone` writes the fresh snapshot synchronously in
the close drain and, on commit, broadcasts `milestone_forecast_updated`. The web WS handler
`useProjectWebSocket.ts` **already** invalidates `['project', id, 'forecast']` on that event,
and the `closeSprint`/`updateSprint` mutations invalidate the same key. Because the card reads
`useProjectForecast` (that exact key), the P80 chip and every other value update live with **no
new WS event, no new broadcast, no new mutation invalidation**. This is a pure read extension of
an already-live query — one reason #730 needs no broadcast-check.

### 5. Boundary non-propagation (Morgan 🟡) — explicit decision
The `previous`, `previous_sprint_name`, and velocity-band fields are **Sprints-surface only**.
They are **not** added to any program- or portfolio-level rollup serializer, and none is
introduced here. Verified: `packages/api/src/trueppm_api/apps/programs/` has **zero**
references to `ForecastSnapshot`/`velocity_low`/`velocity_high`. This preserves the ADR-0104
velocity-privacy direction — the band crosses upward only through the already-gated
`milestone_forecast_recomputed` confidence signal, never as raw team velocity in a PMO view.
The `ProjectForecastView` privacy strip that nulls `velocity_low`/`velocity_high` for
below-audience readers is **extended** to also null `previous.velocity_low`/`previous.velocity_high`
(the nested `previous` is a second copy of the same band and must not become a side-channel,
mirroring the #981 reasoning for the top-level fields).

## Consequences
- Positive: the bridge is visible in one card; the "why did the date move?" question is
  answered inline with an honest, provenance-checked sprint attribution; the P80 chip is
  future-proofed to become a real percentile with zero card changes when #411 lands.
- Positive: no model, no migration, no new endpoint, no new WS event — a read-only extension
  of an existing serializer and an existing live query.
- Cost: `project_forecast()` gains two bounded queries (previous + closed-sprint attribution);
  flagged for perf-check (indexes cover both; bound milestones and per-milestone history are
  small).
- Honesty tax: when a snapshot cannot be provably tied to one closed sprint, the card says
  "since the last forecast" instead of naming a sprint — deliberately less punchy than the
  issue's "after Sprint 12" mock, but correct.

## Gate impact
- **rbac-check, security-review, perf-check** — a serializer + service read changes (new
  fields, two new queries). No new permission surface; `ProjectForecastView`'s existing
  `IsProjectMember` + ADR-0104 suppression is reused and extended to the nested `previous`.
- **regression-check** — always.
- **migration-check** — **not applicable** (no `models.py` change).
- **broadcast-check** — **not applicable** (no new write path; reuses the existing
  `milestone_forecast_updated` broadcast).
- **Tests:** pytest for the serializer `previous`/`previous_sprint_name` fields, the
  exactly-one-closed-sprint attribution edges (zero / one / many in the window; manual-refresh
  → null), and the below-audience privacy nulling of `previous` velocity band; vitest for
  `MilestoneBridgeForecast` (velocity_band vs monte_carlo basis switch, delta shift chip
  direction/tone, projection line, gated-off render); Playwright for the SprintsView flow
  (card shows velocity-vs-CPM + delta; updates after a sprint close invalidation).
