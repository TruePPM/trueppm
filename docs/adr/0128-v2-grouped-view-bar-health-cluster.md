# ADR-0128: v2 Grouped PLAN/TRACK/PEOPLE View Bar + Methodology-Adaptive Health Cluster (shell slice 3)

## Status
Accepted (2026-06-14)

> **Superseded in part by [ADR-0134](0134-v2-unified-shell-bar.md) (2026-06-15).** The
> **two-row premise** (this "view row" being a distinct row hosted by an interim `TopBar`) is
> superseded: the grouped `ViewTabs`/`ProgramTabs` and the single health cluster now live in
> one unified shell bar, with the tab strip inside a horizontal scroll region (`ShellNavScroller`).
> Everything else in this ADR — the PLAN/TRACK/PEOPLE grouping, the methodology-adaptive
> health-cluster semantics, the ADR-0104 velocity privacy gate, route suppression, and the
> `Health ▾` collapse below `lg` — is unchanged.

## Context

Epic #1163 (the v2 golden-standard redesign, ADR-0126) replaces the project
shell's chrome in three slices. Slice 1 (the 248px left rail, #1165) and slice 2
(the context bar, #1177/ADR-0127) have shipped. **This ADR is slice 3 — the
*view row* + a single *health cluster*** — the last piece of the split top region.

Two legacy→standard changes from the epic land here:

- **Change #1** — the 9—11 flat `ViewTabs` (Overview · Board · Backlog · Sprints ·
  Schedule · Grid · Calendar · Team · Risks · Reports · Settings) become **grouped,
  method-filtered** view groups: **PLAN / TRACK / PEOPLE**, with small mono uppercase
  group labels and a right-aligned `{METHOD} WORKSPACE` label.
- **Change #4** — the three free-floating health badges (the P80 pill, the at-risk
  `BadgePopover`, the critical `BadgePopover`, and their `<lg` `HealthDropdown`
  collapse) become **one bordered, segmented health cluster** whose three segments
  **adapt to the project methodology**:

  | Methodology | Seg 1 | Seg 2 | Seg 3 |
  |---|---|---|---|
  | Agile | Sprint | Points | Velocity |
  | Waterfall | Forecast | At-risk | Critical |
  | Hybrid | Sprint | Forecast | Critical |

**P3M layer:** Programs and Projects (single project chrome) → **OSS**. This is the
team's own working surface; cross-program aggregation (the Portfolio rollup the VoC
panel's Janet/Marcus/David asked for) stays **Enterprise / post-1.0** — the bar is
explicitly *hidden* on the Portfolio route, so this change does not leak a
cross-project surface into OSS.

**VoC panel:** on-target cohort (Sarah/Jordan/Alex/Morgan/Priya) avg 6.4, no in-scope
🔴. The off-target Janet/Marcus/David 🔴 ("no portfolio rollup") are Enterprise scope.
The strongest in-scope tension is **velocity-in-always-on-chrome → gaming/surveillance
pressure** (Alex 7🟡 + Morgan 6🟡; the `velocity transparency` tension in
`personas.md`). The decisions below resolve it by *consuming the existing ADR-0104
privacy gate* rather than inventing a new affordance.

### Forces
- Must compose **beneath** the ADR-0041 methodology visibility matrix (hidden tabs stay
  absent from the DOM, within their group).
- Must preserve the ADR-0091 `ViewTabs`/`ProgramTabs` mutual-exclusion contract and not
  touch `ProgramTabs`.
- Must clear the ADR-0126 design-system CI gate (`scripts/check-design-system-v2.sh`):
  semantic tokens only, no raw hex, no dark-chrome-on-light in `features/shell/**`.
- The velocity/points signals are **team-private by default** (ADR-0104): the cluster
  must *suppress* them for an unauthorized audience, never 403, never leak a count.
- No API change — every value already exists client-side.

## Decision

### A. Group → view assignment

The route segments are **unchanged** (rule 108 / ADR-0030 — grouping is visual only,
the URL stays `/projects/:id/<view>`). `Overview` and `Settings` stay **standalone**
(orientation landing / admin) and sit outside the three groups; the remaining views map
to groups, then the existing `isTabVisibleForMethodology` filter is applied *within*
each group:

| Group | Views (canonical) | After AGILE filter | After WATERFALL filter |
|---|---|---|---|
| *(standalone, leading)* | Overview | Overview | Overview |
| **PLAN** | Backlog · Sprints · Schedule · Grid · Calendar | Backlog · Sprints · Grid | Schedule · Grid · Calendar |
| **TRACK** | Board · Risks · Reports | Board · Risks · Reports | Board · Risks · Reports |
| **PEOPLE** | Team | Team | Team |
| *(standalone, trailing)* | Settings | Settings | Settings |

- A group whose views are **all** filtered out (by methodology or role) renders
  **nothing** (no empty group label). The rule is general so future presets stay safe.
- **PEOPLE is a one-item group today (Team).** Intentional — it is the named category the
  golden standard reserves for people/workload surfaces; keeping the label with one item
  now is cheaper than re-teaching the IA when a second people-surface lands. The Team role
  gate (`role >= ROLE_SCHEDULER`) is unchanged; gated out → PEOPLE renders nothing.
- The ordered grouping lives in `methodologyTabs.ts` (`VIEW_GROUPS`) next to the existing
  matrix; `groupedVisibleViews(methodology)` applies the methodology filter purely and is
  unit-tested. Tab icons/labels + the role gate stay in `ViewTabs.tsx`.
- Active-tab detection (path-segment split), `aria-current="page"`, the rule-38 underline
  active style, the `useIterationLabel().plural` Sprints label (ADR-0111/0116), and the
  rule-4 focus ring are all carried over unchanged.

### B. Health cluster

One bordered container (`border border-neutral-border rounded`, borders-not-shadows per
rule 1) with three fixed segment slots and hairline dividers. A pure
`healthClusterModel(...)` selector returns a discriminated union of 2—3 segments so the
renderer never branches on raw nulls. Segments:

- **Forecast** (Waterfall, Hybrid) — `monteCarlop80` from `useShellStats`. Button → opens
  the existing `MCResultPanel` (preserves the P80-pill behavior). Outlined at-risk style
  (rule 39/21). Null → muted "—" with a "Run the scheduler" `title` (rule 119), never hidden.
- **At-risk** / **Critical** (Waterfall, Hybrid) — `atRiskCount`/`criticalCount`. Each is a
  segment button opening a `role="menu"` task popover. Color pairs per rule 145 (AA-dark
  text). Zero renders a calm neutral "0", the slot is fixed (cluster never reflows).
- **Sprint** (Agile, Hybrid) — `useActiveSprint`: `name` + `Day {n}/{m}` from
  `start_date`/`finish_date` (inclusive window; today clamped to `[1, m]`). Noun from
  `useIterationLabel().singular`. No active sprint → "No active {iteration}" muted →
  `/sprints`. Button → `/projects/:id/sprints`.
- **Points** (Agile) — **throughput-neutral** (resolves VoC Q3 / #1161): points when
  `committed_points != null` (`{completed_points ?? 0}/{committed_points} pts`); else task
  counts (`…/… items`) when `committed_task_count != null`; else the segment is **omitted**
  (a no-points/no-count team shows Sprint · Velocity only — the one <3-segment case).
- **Velocity** (Agile) — `useProjectVelocity`, **privacy-gated by ADR-0104**: if
  `velocity_suppressed` → content-free privacy wall (rule 168): lock glyph + "Kept to the
  team", **no number**, `aria-label` names the gate. The client never holds the number;
  the team owns the policy — this is the team-verifiable firewall the VoC panel asked for,
  with no new affordance invented. Else → `{rolling_avg_points} pts/{iteration}`, range in
  `title`/`aria-label`, `· {n} excluded` when `excluded_count > 0` (ADR-0113); null avg →
  muted "—". Button → `/projects/:id/sprints`.

Responsive: at `< lg` the cluster collapses to a single `Health ▾` button (rule 109)
expanding the same segments in a `role="menu"`. Color is never the sole cue (rules 7/120/145).

### C. Route suppression

Project-scoped chrome, reusing the two existing mechanisms (no new router wiring):

1. `useProjectId()` is null on **My Work, Inbox, Portfolio (`/programs`), Program
   (`/programs/:id/*`), workspace Settings (`/settings`)** — the bar already returns
   `null` there (and `ProgramTabs` owns program routes per ADR-0091). Unchanged.
2. **Project settings** (`/projects/:projectId/settings/*`) — a
   `useMatch('/projects/:projectId/settings/*')` guard returns `null`, mirroring the
   rule-123 settings-chrome-suppression pattern. Settings stays a reachable *destination*
   (the standalone trailing tab) but the working bar is suppressed *while on* a settings route.

### D. Out of scope (kept tight)

- **Presence avatars** — ADR-0127 suggested folding them into the #1167 TopBar refactor,
  but they have a dedicated issue (**#1180**, surveillance/per-project caveats). They stay
  in `TopBar` untouched and are owned by #1180. Deliberate divergence; keeps slice 3 focused.
- **Velocity → dedicated forecast panel** (Jordan 7🟡) — v1 makes Velocity/Sprint segments
  *navigate to the Sprints view* (the velocity chart's home) rather than building a new
  TopBar panel. A dedicated velocity/forecast popover is a follow-up, not a slice-3 blocker.
- **Retiring `TopBar.tsx`** — ADR-0127 keeps `TopBar` as the interim view-row host; this
  ADR modernizes its *contents* but does not delete the shell.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **A. Group in `methodologyTabs.ts`, cluster = pure selector over existing hooks (chosen)** | One source of truth; zero API change; reuses ADR-0104/0113 gates and `MCResultPanel`; routes untouched | Touches the central shell component; many specs move |
| B. New `GroupedViewBar`, keep `ViewTabs` as fallback | Lower blast radius | Two nav components drift; rule-108 single-source violated; dead code |
| C. Add a `velocity_audience` toggle to the cluster | Visible firewall control | Duplicates ADR-0104's policy surface; scope creep; team already controls it in settings |
| D. New backend composite `@action` for the cluster (ADR-0125 §3) | One round-trip | Unnecessary — the three hooks already exist and cache independently; drags in the backend gate chain for zero user-visible benefit |

## Consequences

- **Easier:** one calm, method-native view row; the velocity firewall is the same server
  flag used app-wide; the cluster never reflows (fixed 3-slot model).
- **Harder:** the central shell component changes — `ViewTabs`, `TopBar`, and ~6 spec files
  (vitest: `ViewTabs.test.tsx`, `TopBar.test.tsx`, `methodologyTabs.test.ts`; e2e:
  `wave1-topbar.spec.ts`, `view-switching.spec.ts`, plus `status-summary` stubs) move in
  the same MR.
- **Risks:**
  - *Spec drift* (the #1 CI failure class) — tab/badge assertions move. The `<nav>` landmark
    name stays **"View"** (shared with `BottomNav`, and the grouping is carried by the inner
    `role="group"` PLAN/TRACK/PEOPLE wrappers), so nav-name specs are untouched; what moves is
    the badge→cluster assertions (`wave1-topbar`) and the tab-order assertion (`view-switching`).
    Mitigation: grep `packages/web/e2e/` + `*.test.tsx` for old labels and update in the same
    commit; run affected specs locally.
  - *Privacy regression* — a forgotten `velocity_suppressed` branch leaks a team-private
    number. Mitigation: the selector returns `{kind: 'velocityGated'}` as a first-class case;
    a vitest asserts the wall renders with no number when suppressed.
  - *Empty-group flate* — guard: a fully-filtered group renders nothing (tested).

## Implementation Notes
- **P3M layer:** Programs and Projects (single-project chrome).
- **Affected packages:** web only.
- **Migration required:** no.
- **API changes:** no — composes `useShellStats`, `useActiveSprint`, `useProjectVelocity`;
  relies on `velocity_suppressed` (ADR-0104) + `excluded_count` (ADR-0113) already in the payload.
- **OSS or Enterprise:** OSS. Portfolio rollup of this cluster is the Enterprise extension,
  post-1.0 — out of scope (hidden on Portfolio).

### Durable Execution
1. Broker-down behaviour: **N/A** — pure frontend chrome, no async dispatch, no write path.
2. Drain task: **N/A** — no Celery work.
3. Orphan window: **N/A**.
4. Service layer: **N/A** — read-only composition of existing cached queries.
5. API response on best-effort dispatch: **N/A** — no new endpoint.
6. Outbox cleanup: **N/A**.
7. Idempotency: **N/A** — read-only render; the segment selectors are pure functions.
8. Dead-letter / failure handling: **N/A** — a failed/loading query renders the segment's
   muted loading/"—" state; no failure queue.
