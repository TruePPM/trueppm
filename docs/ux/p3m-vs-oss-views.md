# TruePPM — UI/UX Proposal

**v0.2 · 2026-04-14**

Revised after reviewing the live Gantt build. The proposal now uses the shipping chrome conventions — **tabbed view-switcher** (Gantt / WBS / Board / Table / Calendar / Resources / Risks), **Monte Carlo P80 chip** + **footer distribution strip**, inline **resource pills** on tasks, red-text critical path, and a live-collab status bar. The OSS single-program view is the _project page_. The Enterprise P3M view is the _portfolio page_ — same shell, new tabs and widgets registered via extension hooks.

- `OSS · Apache 2.0 · packages/web`
- `Enterprise · proprietary overlay · trueppm-enterprise`
- `Shared tokens · light + dark`

---

## ① OSS Single-Program — Overview

**Route:** `/projects/:id` · default landing for a project · new first tab

The PM opens TruePPM, picks a project, and lands here. Overview answers _"is this project OK, what needs my attention, what's next, and when will it actually finish?"_ in a single screen. Every widget is a link into the detail view (Gantt / Board / Resources / Risks). Overview is an **OSS-native tab** — no enterprise code required.

### Shell chrome

**Top bar tabs (view switcher):** Overview (active) · Gantt · WBS · Board · Table · Calendar · Resources · Risks

**Top bar right-side chips:** P80: Nov 2 · ⚠ 2 · 🔔 1 · user avatar (KW)

**Left rail (project switcher):**

| Project | Status |
|---|---|
| adf | 5 tasks · on track |
| **Website Redesign** _(active)_ | 42 tasks · P80 Nov 2 |
| test | 12 tasks · ahead |
| whee | 3 tasks · draft |

<!-- color swatch: amber dot = at-risk project, emerald dot = on-track project, slate dot = draft/inactive -->

### Project title bar

**Website Redesign 2026** — `At risk` chip  
Started Apr 12 · 42 tasks · 3 on critical path · Owner: Kelly W.  
Actions: Export · Update status

### KPI strip (5 cards)

| KPI | Value | Detail |
|---|---|---|
| Schedule health | **At risk** | SPI 0.94 · CPI 1.02 |
| Forecast finish (P80) | **Nov 2** | plan Oct 18 · +15d |
| Tasks late | **4** | of 27 in-flight |
| Next milestone | **Beta launch** | May 27 · in 43d |
| Team utilization | **78%** | 1 over-allocated |

### Row 1: Burn-up chart + Needs your attention

**Progress — burn-up chart** (2/3 width)

SVG burn-up chart showing:
- Flat scope line (dashed, slate)
- Planned line (dashed, indigo) from bottom-left to top-right
- Actual completed line (emerald, solid) ending at "Today" marker
- Forecast cone extending from Today toward the scope line (amber, translucent fill)
- Labels: Scope · Plan · Today · Forecast

**Needs your attention** (1/3 width)

- **[red]** **API rewrite** slipped 2d — now on critical path. Owner: Sara · Due Apr 22
- **[amber]** **Sara H.** over-allocated 118% next week. Resources tab →
- **[indigo]** 3 tasks unassigned approaching start. Design sprint, Content, QA prep
- **[slate]** Baseline drift: +4d vs plan v2. Last baseline: Apr 1

### Row 2: Milestones + Critical path + Risks

**Upcoming milestones**

| Milestone | Date | Progress bar |
|---|---|---|
| ◆ Design sign-off | Apr 28 | 70% (emerald) |
| ◆ Beta launch | May 27 | 30% (amber) |
| ◆ GA release | Oct 18 · P80 Nov 2 | 8% (rose) |

**Critical path (3 tasks)**

| Task | Duration |
|---|---|
| API rewrite `CP` | 16d |
| Data migration | 12d |
| Integration testing | 9d |

Total slack: -2d · Any slip here slips GA.

**Top risks**

| Severity | Risk | Owner |
|---|---|---|
| **H** (high) | Third-party auth API unstable | Mike · open 9d |
| **M** (medium) | Content team capacity | Sara · mitigating |
| **L** (low) | CDN migration window | Kelly · accepted |

### Row 3: My tasks + Activity + Monte Carlo forecast

**My tasks this week**

| Task | Due |
|---|---|
| Review API design doc `PM` | Today |
| Approve beta launch plan | Wed |
| 1:1 with Sara (blockers) | Thu |
| Weekly status update | Fri |

**Recent activity**

- **Mike** completed "Wireframe homepage" · 12m ago
- **Sara** pushed baseline v3 · 1h ago
- Offline sync resolved 2 conflicts · 2h ago
- **Kelly** added risk "Third-party auth" · 3h ago
- Monte Carlo recalculated · 5h ago

**Forecast (Monte Carlo)**

<!-- color swatch: histogram bars — P50 emerald #10B981, P80 amber #F59E0B, P95 rose #EF4444 -->

8 in 10 simulations finish by **November 2, 2026**.

| Percentile | Date |
|---|---|
| P50 | Oct 18 |
| P80 | Nov 2 |
| P95 | Nov 29 |

### Status bar (persists across all tabs)

Left: 42 tasks · 3 on critical path · Last saved: 2 min ago · Recalculated: 5 min ago · 3 users online (green dot)

Right legend: Healthy · At risk · Critical

### Design notes

- **5-second scan:** status chip, P80, tasks late, next milestone, utilization — all above the fold.
- **Burn-up chart** shows planned / actual / forecast cone — a single chart that tells the whole story.
- **Every widget links out:** burn-up → Gantt; risks → Risks tab; my tasks → Table filtered by assignee.
- **Mobile:** KPIs horizontal scroll · Attention/My tasks stack first · chart collapses to sparklines.

---

## ② OSS Single-Program — Gantt (light)

**Route:** `/gantt?project=…` · matches current live build

### Shell chrome

**Top bar tabs:** Overview · **Gantt** (active) · WBS · Board · Table · Calendar · Resources · Risks

**Top bar right:** P80: Nov 2 (clickable, pins distribution to footer strip) · ⚠ 2 · 🔔 1 · user avatar (KW)

**Left rail:** same project switcher as Overview

### Gantt subheader toolbar

- `+ Task` button
- Zoom controls: Today · Day · **Week** (active) · Month · Quarter

### Task table (columns: Task | Dur · Start | %)

| Task | Dur · Start | % |
|---|---|---|
| Kickoff `PM` (indigo pill) | 1d · Apr 12 | 100% |
| Design sprint `AC` | 8d · Apr 14 | 62% |
| Content migration `BS` (violet pill) | 12d · Apr 20 | 38% |
| **API rewrite** `CP` (red text, red pill) | 16d · Apr 22 | 24% |
| QA pass `QA` (emerald pill) | 9d · May 18 | 0% |
| Beta launch ◆ (amber, milestone) | 0d · May 27 | 0% |
| Marketing push `MK` (amber pill) | 14d · May 28 | 0% |

### Timeline (week grid, W15–W27)

<!-- color swatch: emerald bar = complete, indigo = in-progress, violet = in-progress (different team), rose = critical path, amber = milestone/pending -->

Today marker at ~W17 (14% from left). Task bars positioned by start/duration; API rewrite bar in rose (critical path). Beta launch rendered as a narrow amber diamond marker.

### Monte Carlo footer strip

<!-- color swatch: histogram distribution — emerald P50 region, amber P80 region, rose P95 region -->

Chips: **P50 Oct 18** · **P80 Nov 2** · **P95 Nov 29**

### Status bar

Left: 42 tasks · 3 on critical path · Last saved: 2 min ago · Recalculated: 5 min ago · 3 users online

Right legend: Complete (emerald) · In progress (indigo) · Critical path (rose) · Milestone (amber)

### Design notes

- **View switcher** hoisted to top bar — matches live build. Left rail is project switching only.
- **MC P80 chip** in header is clickable; pins the distribution to the footer strip.
- **Resource pills** inline on task names — compact, color-coded by role.
- **Status bar** persists across all tabs for trust signals.

---

## ③ Same view — dark mode (matches live build)

**Design tokens:** `--surface-0` #0B1220 · `--surface-1` #111827 · `--accent` #10B981

Identical layout to section ②. Dark-mode differences:

- Shell background: #0B1220
- Card/KPI surface: #111827
- Border color: #1F2937
- Active tab indicator: #34D399 (lighter emerald)
- Resource pills remain color-coded; text on dark cards uses `#E2E8F0`
- P80 chip: amber-900/60 background · amber-200 text
- Warning chip: rose-900/60 background · rose-300 text
- Today line: #10B981 at 60% opacity
- MC footer background: #0F172A
- MC chips: emerald-900/60, amber-900/60, rose-900/60 with lighter text

All interactive elements and status bar behaviors are identical to light mode.

---

## ④ Gantt — Dependency focus mode and relations panel

**Interaction:** Click a task → chain highlights · side panel opens

Clicking a task (here, **API rewrite**) dims everything outside its predecessor/successor chain to ~20% opacity. Inline **pred / succ chips** appear on the task row. Arrows get **lag pills** mid-arc showing `FS +2d` etc. A side panel lists each dependency with type, lag, and slack impact. A **CP-only toggle** on the toolbar hides non-critical arrows.

### Toolbar

- `+ Task`
- [x] Show critical path only
- [x] Focus chain
- Zoom: **Week** (active) · Month

### Task table in focus mode

| Task | Dur · Start | % | Focus state |
|---|---|---|---|
| Kickoff `PM` | 1d · Apr 12 | 100% | Dimmed (out of chain) |
| Design sprint `AC` — chips: `← 1` `→ 1 CP` | 8d · Apr 14 | 62% | Full opacity |
| Content migration `BS` | 12d · Apr 20 | 38% | Dimmed |
| **API rewrite** `CP` — chips: `← 2 preds` `→ 3 succs` `slack -2d` | 16d · Apr 22 | 24% | **Selected** (rose border-left, rose bg tint) |
| QA pass `QA` — chips: `← 2 CP` `→ 1` | 9d · May 18 | 0% | Full opacity |
| Beta launch ◆ | 0d · May 27 | 0% | Full opacity |
| Marketing push `MK` | 14d · May 28 | 0% | Dimmed |

### Timeline with dependency arrows and lag pills

Dependency arrows rendered as red lines with arrowheads:

- Design sprint → API rewrite: vertical drop + horizontal run · lag pill `FS +0d` at midpoint
- API rewrite → QA pass: `FS +2d` lag pill
- QA pass → Beta launch: `FS +0d` lag pill

Non-chain bars dimmed to ~20% opacity. API rewrite bar has a `box-shadow: 0 0 0 2px #EF4444` ring.

### Dependency side panel (300px, right edge)

**API rewrite — Dependencies**  
On critical path · slack -2d · 2 preds · 3 succs

**Predecessors**

| Task | Type | Detail |
|---|---|---|
| Design sprint | FS | Lag +0d · 62% complete |
| Auth API spec | FS | Lag +1d · 100% complete |

**Successors**

| Task | Type | Detail |
|---|---|---|
| QA pass | FS +2d · CP | Any slip here pushes GA |
| Integration testing | SS | Lag -3d |
| Docs update | FS | Lag +5d |

Action: `+ Add dependency`

### Status bar

Focus: API rewrite · chain of 5 tasks · Slack -2d  
Legend: Critical path (rose) · Dimmed — out of chain (slate)

### Design notes

- **Focus mode** cuts visual noise — only the selected chain stays at full opacity.
- **Lag pills** expose scheduling errors (wrong FS/SS/FF, bad lag signs) that normally hide on hover.
- **Relations panel** lets you edit type/lag in-place. Drag-from-bar-edge still works for quick links.
- **CP-only toggle** is a checkbox in the toolbar; state persists per-project per-user.

---

## ⑤ Board — progress-aware Kanban with phase swimlanes

**Route:** `/board?project=…` · replaces a plain Kanban

The Board's rows are **phases** (Discovery / Design / Build / Test / Launch) by default — same structure as the Gantt's summary tasks. Columns are discrete states. Each card carries a **progress ring** sourced from the Gantt's % complete (single source of truth), an **entry stamp** ("Entered Review at 72% · 3d ago") to expose stalls, a **priority rank** that drives sort, and a **WIP-limit badge** per column × lane. Cards never auto-move — at 100% the card shows a quiet "Move to Done?" nudge. Lanes are collapsible with summary totals.

### Top bar tabs

Overview · Gantt · WBS · **Board** (active) · Table · Calendar · Resources · Risks

### Board toolbar

- Lane: Phase (WBS rollup) / Owner / Team / Custom
- Sort: Priority rank / Start date / % complete / Manual
- [x] Show WIP limits
- [ ] Highlight stalled (>3d no progress)

### Column headers

| Column | Count | WIP status |
|---|---|---|
| To Do | 12 | WIP ∞ |
| In Progress | 8 | WIP 6 ⚠ (over limit) |
| Review | 3 | WIP 4 |
| Done | 19 | — |

### Lane: Discovery (collapsed)

4 tasks · 100% avg · done — all 4 in Done column, other columns empty (rolled up)

### Lane: Design (6 tasks · 58% avg · 1 at risk)

| Column | Card | Ring | Resource | Entry stamp |
|---|---|---|---|---|
| To Do | Icon set v2 `#11` | 0% (slate) | `AC` | Prio low · no start yet |
| In Progress | Homepage wireframes `#3` | 62% (emerald) | `AC` | Entered at 20% · 4d ago |
| In Progress | Checkout flow `#5` | 35% (amber) | `BS` | Entered at 30% · 5d ago — **stalled** |
| Review | Design tokens v2 `#2` | 88% (emerald) | `AC` | Entered Review at 75% · 2d ago |
| Done | Brand refresh `#1` | 100% ✓ | — | Closed at 100% · 6d ago |

### Lane: Build (14 tasks · 31% avg · 2 CP · WIP over)

| Column | Card | Ring | Resource | Entry stamp |
|---|---|---|---|---|
| To Do | Payment gateway `#9` | 0% | `CP` | Blocked by "API rewrite" |
| To Do | Search index `#12` | 0% | `BE` | Prio low |
| In Progress | **API rewrite** `#1` | 24% (rose, red border) | `CP` `BE` | Entered at 10% · 11d ago · **slack -2d** |
| In Progress | Content migration `#4` | 48% (emerald) | `BS` | Entered at 20% · 8d ago |
| In Progress | Admin panel `#6` | 71% (emerald) | `FE` | Nudge: Move to Review? |
| In Progress | _(WIP warning banner)_ | — | — | WIP limit: 6 — 4 over capacity |
| Review | Auth middleware `#7` | 92% (emerald) | `BE` | Entered at 85% · 1d ago |
| Done | DB schema v4 `#2` | 100% ✓ | — | Closed at 100% · 2d ago |

### Lane: Test (9 tasks · 12% avg)

| Column | Card | Ring | Resource | Entry stamp |
|---|---|---|---|---|
| To Do | E2E test suite `#8` | 0% | `QA` | Depends on Build phase |
| In Progress | Perf baseline `#10` | 28% (emerald) | `QA` | Entered at 10% · 3d ago |

Review and Done columns empty.

### Lane: Launch (5 tasks · 0% avg, collapsed)

◆ Beta May 27 · 5 pending in To Do · other columns empty

### Status bar

Left: 42 tasks · 3 on critical path · 1 column over WIP (Build / In Progress) · 3 users online

Right legend: Healthy (emerald) · Stalled (amber) · CP / blocked (rose)

### Design notes

- **Single source of truth:** the progress ring = Gantt's % complete. No dual-truth drift.
- **Entry stamp** surfaces stalled work the moment a card sits too long at the same %.
- **No auto-move:** at 100% the card shows a nudge — the PM clicks to move. Trust preserved.
- **Phase lanes** = WBS rollups by default. Switch to Owner/Team/Custom via the lane picker.

---

## ⑥ Enterprise P3M — Portfolio Overview

**Route:** `/portfolios/:id` · enterprise license detected

Same shell. Adds a **portfolio switcher** to the top bar and an enterprise-only tab group (Overview / Demand / Prioritization / Deps / Heat map / Scenarios / Audit) that sits _before_ the project-level tabs. Zoom defaults to **Quarter**. Monte Carlo chip rolls up across the portfolio (aggregated P80 across all projects).

### Top bar

`TruePPM` wordmark · `ENT` chip · Portfolio dropdown (Digital Transformation 2026) · Enterprise tabs

**Enterprise tab group:** **Overview** (active) · Demand · Prioritization · Deps · Heat map · Scenarios · Audit

**Top bar right:** Portfolio P80: Dec 14 · ⚠ 7 · 🔔 5 · user avatar (KW)

### Left rail (portfolio + program switcher)

**Portfolios:**

| Portfolio | Status |
|---|---|
| **Digital Transformation** _(active)_ | 24 projects · at risk |
| Regulatory 2026 | 8 projects · healthy |
| Platform migration | 11 projects · red |

**Programs:**
- ▸ Commerce replatform
- ▸ Data platform
- ▸ Mobile apps

### Portfolio KPI strip

| KPI | Value | Detail |
|---|---|---|
| Portfolio health | **At risk** | score 62 / 100 |
| Projects red | **3** | of 24 |
| Demand vs capacity | **+18%** | Q2 over-committed |
| Portfolio spend YTD | **$4.2M** | of $11.8M plan |
| Decisions needed | **5** | awaiting PMO |

### Portfolio roll-up Gantt — Quarter view

Zoom: Month · **Quarter** (active) · Year

**Project list with P80 forecast:**

| Project | P80 |
|---|---|
| Commerce replatform | Dec 14 (amber) |
| Data platform | Nov 4 (emerald) |
| Mobile v3 | Jan 22 (rose) |
| Design system v2 | Aug 19 (emerald) |
| Auth migration | Oct 2 (amber) |

Quarter-level timeline: Q2 2026 · Q3 2026 · Q4 2026 · Q1 2027. Bars color-coded by health status. Mobile v3 in rose (at risk).

### Decisions needed this week

- **[red]** Defer Mobile v3 launch? — Blocks 2 downstream · due Fri
- **[amber]** Reallocate 4 engineers Data → Commerce — Scenario A vs B ready
- **[indigo]** Approve Q3 intake batch (11 requests)
- **[indigo]** Sign off baseline v4 — Commerce

### Resource heat map — next 8 weeks

<!-- color swatch: emerald-200 = under-utilized, emerald-300/400 = healthy, amber-400 = approaching capacity, rose-500 = over capacity -->

| Team | W1 | W2 | W3 | W4 | W5 | W6 | W7 | W8 |
|---|---|---|---|---|---|---|---|---|
| Backend | green | green | amber | **red** | **red** | amber | green | green |
| Frontend | green | green | green | amber | amber | green | green | green |
| Design | amber | **red** | **red** | amber | green | green | green | green |
| Data | green | green | green | green | amber | **red** | **red** | amber |
| QA | green | green | green | green | green | amber | amber | green |

### Portfolio Monte Carlo footer strip (aggregated across 24 projects)

<!-- color swatch: same distribution strip as single-project view -->

| Percentile | Date |
|---|---|
| P50 | Nov 28 |
| P80 | Dec 14 |
| P95 | Jan 9 |

### Status bar

Left: 24 projects · 312 people · Last rolled up: 3 min ago · 11 users online

Right legend: Healthy · At risk · Critical

---

## ⑦ Enterprise Board — Stage-gate pipeline

**Route:** same shell as OSS Board · cards = projects · columns = funnel stages

The unit changes from task to **project**. Columns are funnel stages (Idea → Evaluating → Approved → In Flight → Launching → Live → Sunset). The progress ring = **health score** (0–100) not % complete. **Entry stamps** track health drift since the card entered the column — e.g. "Entered In Flight 6w ago at 74 · now 62" — exposing rot early. Lanes group by program by default. Moving a card right fires a **stage-gate approval workflow** (pending-approval chip while open).

### Top bar

`TruePPM ENT` · Portfolio dropdown · **Board** (active) tab within enterprise tab group

**Enterprise tabs:** Overview · Demand · **Board** (active) · Roadmap · Deps · Heat map · Scenarios · Audit

### Board toolbar

- Lane: Program / Strategic theme / Funding source / Owner
- Ring: Health score / % complete / Budget burn
- [x] Stage-gate approvals
- Info: 24 projects · $11.8M · 312 people

### Column headers (7 stages)

| Stage | Count | WIP status |
|---|---|---|
| Idea | 5 | — |
| Evaluating | 3 | — |
| Approved | 2 | — |
| In Flight | 8 | WIP 6 ⚠ |
| Launching | 2 | — |
| Live | 3 | — |
| Sunset | 1 | — |

### Lane: Commerce (6 projects · $4.2M · 1 red)

| Stage | Project | Health ring | Entry stamp |
|---|---|---|---|
| Idea | Loyalty v2 | — (slate) | Proposed by Marketing |
| Evaluating | Tax engine refactor | — (slate) | RFC open · reviewing |
| In Flight | **Replatform** `AT RISK` | 62 (rose, red border) | Entered 6w ago at 74 · **-12** |
| In Flight | Payment gateway | 82 (emerald) | Entered 3w ago at 80 · +2 |
| Launching | Checkout UX | 78 (amber) | Pending approval |
| Live | Search v3 | 95 (emerald) | Live 2w · stable |

### Lane: Data (5 projects · $2.1M)

| Stage | Project | Health ring | Entry stamp |
|---|---|---|---|
| Idea | ML platform | — (slate) | — |
| Approved | Data lake migration | 70 (amber) | Approved last week |
| In Flight | Analytics refresh | 85 (emerald) | Entered 2w ago at 83 · +2 |
| Live | Warehouse v2 | 92 (emerald) | — |

### Lane: Mobile (4 projects · $1.8M · 1 red)

| Stage | Project | Health ring | Entry stamp |
|---|---|---|---|
| Idea | Push notif v2 | — (slate) | — |
| In Flight | **Mobile v3** | 48 (rose, red border) | Entered 9w ago at 80 · **-32** · defer? |
| Sunset | AR browse | ✕ (slate) | Sunset Q4 2025 · low ROI |

### Status bar

Left: 24 projects · 2 pending stage-gate approval · Commerce/In Flight: 3 over WIP

Right legend: Healthy (80+, emerald) · Watch (60–79, amber) · At risk (<60, rose)

### Design notes

- **Health ring** replaces % complete — what PMOs actually care about.
- **Entry stamp delta** ("74 → 62") shows health drift since the card entered the column.
- **Stage-gate approval** fires on drag-right — card shows pending-approval chip while open.
- **Sunset column** is first-class — forces honest accounting for killed/deferred work.

---

## ⑧ Enterprise — Scenario modeling (what-if)

**Route:** Scenarios tab · enterprise only  
**Tagline:** The demo moment · saves named scenarios · promote one to plan

Split-screen. Current plan on the left, scenario draft on the right. Drag people between projects, defer a project, compress a timeline — the right side recomputes live and shows deltas in the top banner. Save named scenarios ("Defer Mobile", "Hire 4 BE"), compare side-by-side, **promote one** to become the plan (writes to audit trail).

### Top bar

`TruePPM ENT` · enterprise tabs with **Scenarios** active · scenario dropdown (Defer Mobile) · Duplicate · **Promote to plan**

### Delta banner (5 KPI cards)

| KPI | Current plan | Scenario | Delta |
|---|---|---|---|
| Portfolio P80 | Dec 14 | **Nov 28** | -16 days |
| Demand vs capacity Q3 | +18% | **+4%** | -14pp |
| Spend FY26 | $11.8M | **$10.4M** | -$1.4M |
| Projects at risk | 3 | **1** | -2 |
| Strategic coverage | 78% | **71%** | -7pp (Mobile theme drops) |

### Split view

**LEFT — Current plan**

Projects (timeline bars):

| Project | P80 | Capacity bar |
|---|---|---|
| Commerce replatform | Dec 14 (amber) | 68% |
| Data platform | Nov 4 (emerald) | 55% |
| Mobile v3 | Jan 22 (rose) | 82% |
| Auth migration | Oct 2 (amber) | 40% |
| Design system v2 | Aug 19 (emerald) | 30% |

Team loading Q3:

| Team | Load | Status |
|---|---|---|
| Backend | 128% | Over capacity (rose) |
| Frontend | 96% | Approaching (amber) |
| Design | 112% | Over capacity (rose) |
| Data | 74% | Healthy (emerald) |

**RIGHT — Scenario: Defer Mobile v3 + reallocate 4 BE to Commerce**  
_(amber header background, "Saved 2m ago" chip)_

Projects (with scenario edits):

| Project | P80 | Change |
|---|---|---|
| Commerce replatform `+4 BE` | Nov 28 (-16d) | Bar shortened + shadow showing original |
| Data platform | Nov 4 | Unchanged |
| ~~Mobile v3~~ | _(strikethrough)_ | Deferred Q1 27 — bar faded |
| Auth migration | Oct 2 | Unchanged |
| Design system v2 | Aug 19 | Unchanged |

Team loading Q3 (after edits):

| Team | Load | Status |
|---|---|---|
| Backend | 78% | Healthy (emerald) |
| Frontend | 82% | Healthy (emerald) |
| Design | 94% | Approaching (amber) |
| Data | 74% | Healthy (emerald) |

**Scenario side-effects panel (amber background):**

- Mobile theme strategic coverage drops 7pp (stakeholder: VP Mobile)
- 4 BE moves create 2 cross-team dependencies
- Push notif v2 (Mobile / Idea) orphaned — reassign owner?

### Saved scenarios bar

Current plan · **Defer Mobile** (active, amber) · Hire 4 BE · Compress Commerce · `+ New scenario`

### Design notes

- **Delta banner** is the point — convert uncertainty into an actionable number.
- **Shadow bars** on the scenario side show where the original plan sat.
- **Side-effects panel** surfaces second-order impacts (orphaned work, stakeholder risk).
- **Promote** writes the delta to the audit log with the named scenario and approver.

---

## ⑨ Enterprise — Roadmap

**Route:** Roadmap tab · enterprise only  
**Layout:** Quarters on X · projects on Y · milestones as diamonds

The exec narrative view. Each project is a bar colored by health, with a **terminal P80 marker**, **milestone diamonds** on the bar, and a **faint shadow bar** showing baseline. Inter-project dependency arrows use the same focus-mode pattern as the OSS Gantt. Swim zones group by program by default; zoom levels are Quarter / Half / Year.

### Top bar

`TruePPM ENT` · enterprise tabs with **Roadmap** active · Portfolio P80: Dec 14

### Roadmap toolbar

- Group: Program / Strategic theme / Owner
- [x] Show baselines
- [x] Show milestones
- [ ] Dependency arrows
- Zoom: Quarter · **Half** (active) · Year

### Time header

Project · Q2 2026 · Q3 2026 · Q4 2026 · Q1 2027 · Q2 2027 · Q3 2027

### Swim zone: Commerce ($4.2M · 6 projects)

| Project | Health | P80 marker | Milestones | Baseline |
|---|---|---|---|---|
| Replatform `AT RISK` | rose bar | P80 Dec 14 | 2 diamonds | Shadow bar (slate, faded) |
| Checkout UX | emerald bar | P80 Sep 3 | 1 diamond | None |
| Loyalty v2 `Idea` | dashed slate outline | — | None | None |

### Swim zone: Data ($2.1M · 5 projects)

| Project | Health | P80 marker | Milestones | Baseline |
|---|---|---|---|---|
| Data lake migration | emerald bar | P80 Nov 4 | 2 diamonds | Shadow bar (slate, faded) |
| ML platform | amber bar | P80 Q2 27 | None | None |

### Swim zone: Mobile ($1.8M · 4 projects)

| Project | Health | P80 marker |
|---|---|---|
| Mobile v3 `AT RISK` | rose bar | P80 Jan 22 (shadow bar behind) |

### Swim zone: Platform ($1.4M · 3 projects)

| Project | Health | P80 marker |
|---|---|---|
| Auth migration | amber bar | P80 Oct 2 |
| Design system v2 | emerald bar | P80 Aug 19 |

### Status bar

Left: 24 projects across 6 quarters · Portfolio P80 Dec 14 · Last rolled up 3 min ago

Right legend: Healthy (emerald) · At risk (amber) · Critical (rose) · ◆ Milestone · Baseline (slate line)

### Design notes

- **P80 terminal markers** on each bar tie forecast uncertainty directly to the roadmap.
- **Baseline shadows** beneath active bars show drift vs approved plan.
- **Idea projects** render as dashed-outline bars — still visible, clearly provisional.
- **Export to .pptx** produces a single-slide version for steering-committee decks.

---

## ⑩ Building from these mocks — how Claude Code should consume this

These HTML mockups are for **humans reviewing design intent**. Claude Code can read the file as text but cannot see the rendered layout. For implementation, the HTML alone is a weak spec — line numbers won't map to components, and visual hierarchy is invisible to a code agent.

**Recommended workflow:**

1. Keep this HTML as the **visual reference** for humans and for Claude Code to re-read when in doubt.
2. Generate a **companion markdown spec** per view (e.g. `docs/ux/specs/board.md`) with: component tree, props, states, data contracts, empty/loading/error behavior, accessibility notes, and links back to this HTML.
3. Generate **OpenAPI types** first (`packages/api → packages/web/src/api/types.ts`) so Claude Code has typed contracts when scaffolding components.
4. Write **one ADR per architectural decision** — extension hooks for enterprise, dark-mode tokens, progress-aware Kanban vs plain Kanban. Claude Code consumes ADRs readily.
5. Prompt Claude Code with "implement §5 Board view per `specs/board.md` and match visual reference in `p3m-vs-oss-views.html`" — the spec drives, the HTML disambiguates.

---

## ⑪ What changed from v0.1

| Area | v0.1 proposal | v0.2 (now) | Source |
|---|---|---|---|
| Primary nav | Left rail with views | Top tabbed view-switcher; rail is project/portfolio switcher only | Live build |
| Monte Carlo | Separate KPI card | P80 chip in header + footer distribution strip, click to expand | Live build |
| Critical path | Asterisk marker | Red task text (matches live) | Live build |
| Assignees | Separate column | Inline color-coded resource pills (AC / BS / CP / QA …) | Live build |
| Trust signals | Scattered | Persistent status bar: tasks, CP count, last saved, recalc, users online | Live build |
| Zoom levels | Weeks only | Today / Day / Week / Month / Quarter — Quarter default in portfolio | Live build |
| Theme | Light only | Light + dark, both documented with tokens | Live build |
| Quick-add | None | + Task inline row at top of table | Live build |
| Warnings / notifs | Not shown | ⚠ and 🔔 counters in top bar, both views | Live build |
| Portfolio MC | n/a | Aggregated MC roll-up across projects (enterprise-only) | Extrapolated |

---

## ⑫ Open questions

- Do enterprise tabs (Overview/Demand/…) _replace_ project tabs at the portfolio level, or stack above them in a two-row nav?
- Projects in the current rail show "Unknown" status — is that a missing computed field or intentional? Proposal assumes it should always resolve to a real status.
- Should the Monte Carlo footer strip be collapsible (pinned vs. on-demand)? Proposal makes it pinned but remember-last-state.
- Density toggle (compact / comfortable) for mobile-first goal — should it live in user prefs or per-view?
- Anchor the MC popover to the footer chip instead of floating over task bars — confirm?
- Resource pill color mapping: role-based (AC/BS/CP) or person-based? Current live build looks role-based; proposal follows that.

---

_Draft proposal v0.2 · TruePPM Design · 2026-04-14 · Apache 2.0 core + proprietary enterprise overlay_
