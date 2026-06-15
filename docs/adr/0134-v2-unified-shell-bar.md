# ADR-0134: v2 Unified Shell Bar — collapse the two-row top region into one

## Status
Accepted (2026-06-15) — founder ratified the one-bar consolidation (Option A) with the
VoC-hardened scroll acceptance criteria.

**Supersedes:** ADR-0127 Decision A (the two-row "context row above view row" coexistence)
and the two-row premise carried into ADR-0128. **Amends** (does not replace) the *content*
contracts of ADR-0127 (breadcrumb, rail toggle, theme) and ADR-0128 (grouped view bar,
health cluster) — those remain in force; only their *host row* changes. **Closes issue
#1195** ("context bar 56px + distinct 46px view row") as superseded — #1195 doubled down on
two rows at 56+46px; this ADR removes the second row entirely.

## Context

**P3M layer:** Programs and Projects (single-program / single-project shell chrome). **OSS.**
No cross-program aggregation; Portfolio/Enterprise untouched. `grep -r trueppm_enterprise
packages/web` stays zero. No API, model, or migration.

The v2 redesign (epic #1163, golden standard ADR-0126) replaced the legacy 16-element top
bar with a **two-row top region**: a context row (`ContextBar`, `h-10`/40px — rail toggle ≡,
breadcrumb, context-aware `+ New`, theme toggle) and a view row (`TopBar`, `h-12`/48px —
grouped `ViewTabs`/`ProgramTabs`, methodology-adaptive `HealthCluster`, `TaskRunIndicator`,
`PresenceAvatarStack`, `NotificationBell`, `UserMenu`). The split shipped across slices 2
(#1177/ADR-0127) and 3 (#1167/ADR-0128).

ADR-0127 chose the two-row split **explicitly as an interim measure** ("a transient extra row
until #1167 trims `TopBar`"; "#1167 later folds ViewTabs/health into the view row"). #1167
shipped the *content* modernization but left the structural fold-in undone, and ADR-0128 §D
deferred "retiring `TopBar.tsx`". So the interim two-row state became the de-facto shipped
shell — and it has measurable problems, verified against the running app
(`/programs/:id/members`) and the source:

1. **Two near-empty full-width bars (~88px of chrome).** Each bar has a left cluster, a right
   cluster, and a dead empty middle — together they carry one bar's worth of content. Page
   content starts ~88px down.
2. **Redundant wayfinding.** The context-row breadcrumb (`Workspace › Program › Project`)
   duplicates the left rail, which already highlights the active program/project. On a
   program route the breadcrumb leaf *is* the sidebar's highlighted row.
3. **Split right chrome.** Notifications + user menu sit on the view row; `+ New` + theme sit
   on the context row — one logical action cluster fragmented across two rows.
4. **Theme toggle in three places** — `ContextBar` (standalone), `UserMenu` (shared
   component, ADR-0127 §C), and historically the rail. Three homes for one preference.
5. **Inverted order.** `AppShell` renders `TopBar` *above* `ContextBar`, the reverse of the
   golden standard's "context above view" — an artifact of the interim "insert below
   OfflineBanner" wiring. With one bar this question dissolves.

### The adaptive-wayfinding insight (the unlock)
The breadcrumb and the rail do the same job. When the rail is **open**, the sidebar shows
where you are — the breadcrumb is pure duplication. When the rail is **hidden** (the 0px
collapse, ADR-0127 Decision D), the breadcrumb becomes the *only* wayfinding — but you have
also just reclaimed ~248px of horizontal width. So shell identity should be **adaptive to
rail state**: render a compact identity (program square + `Program › Project`) in the bar
**only when `sidebarCollapsed`**, and **remove it from the DOM** otherwise. Identity costs
width exactly when width is free, and disappears exactly when it is redundant. That single
rule frees the room a single row needs.

### VoC panel (run 2026-06-15, all 8 personas)
Scored on four options — **A** (one bar + scrollable tabs, chosen), **B** (one bar +
icon-only/compact tabs), **C** (two de-duplicated rows), **D** (one bar that clips below 2xl):

| | A | B | C | D |
|---|---|---|---|---|
| Average | **7.0** | 5.9 | 6.5 | 3.8 |

- The three **daily-driver** personas — Sarah (PM), Alex (Scrum Master), Priya (Contributor) —
  all scored **A at 8/10**; they live in these surfaces and value reclaimed canvas + a single
  calm bar.
- The fork is **A vs C**, splitting on the `personas.md` "tool surface area" tension (Priya
  minimal ↔ Marcus deep). **C triggers Priya's 🔴** — ~88–102px of chrome on her tab-less,
  cluster-less My Work route reads as PM overhead; Priya is the veto persona whose
  non-adoption rots the data layer, and a single 🔴 outweighs C's high average. **A carries no
  🔴** — its only knocks are Marcus/Jordan 🟡 "tabs could scroll off-screen," which the
  acceptance criteria above engineer away (and which vanish at `2xl`, where Jordan works).
- **B rejected** (three 🔴 — loses the PLAN/TRACK/PEOPLE IA + WCAG 1.1.1 on icon-only). **D
  rejected** (floor — clips below 2xl, confirms a tab-overflow strategy is mandatory).
- **Watch-item (Morgan 🟡, not a blocker):** a velocity segment in always-on chrome signals
  "velocity is a dashboard metric" regardless of the ADR-0104 gate; a future question for
  ADR-0128 (already shipped), not re-opened here.

### The hard geometric constraint (surfaced by breakpoint analysis — must be designed for)
The grouped `ViewTabs` strip (Overview + PLAN/TRACK/PEOPLE groups + Settings, with group
labels and dividers) measures **~950–975px** for both Waterfall and Agile after the
ADR-0041 methodology filter. The methodology-adaptive `HealthCluster` is **~280px**
(Waterfall) to **~340px** (Agile) expanded, **~58px** collapsed (`Health ▾`). The right
chrome (bell + avatar, plus presence/run when present) is **~80–160px**.

A single full-width row at common widths therefore **cannot** hold project-route nav + an
expanded health cluster + right chrome without horizontal overflow:

| Viewport | Tabs (~960px) + health + chrome | Verdict |
|---|---|---|
| `lg` 1024px, health expanded | needs ~1340px+ | overflows ~315px |
| `lg` 1024px, health → `Health ▾` | needs ~1180px+ | overflows ~155px |
| `xl` 1280px, health expanded | needs ~1340px+ | overflows ~60px |
| `2xl` 1440px, health expanded | needs ~1340px+ | fits |

(This overflow is **already latent** in the shipped `TopBar` at `lg`/`xl` — the grouped tabs
clip silently because the `<nav>` has no overflow handling. The two-row split never solved
it; it only moved the breadcrumb out of the way.) **Conclusion: a single row is only viable
if the view-tab strip is given an explicit overflow strategy.** This is not optional — it is
a load-bearing part of the decision.

## Decision

Collapse the top region into **one chrome bar** (`h-14` / 56px, `bg-chrome-surface`,
`border-b border-chrome-border`). `ContextBar.tsx` is **absorbed into `TopBar.tsx`** and
deleted; its three surviving elements (≡ toggle, adaptive identity, `CreateMenu`) move into
the single bar. The bar is `flex flex-nowrap` (rule 113) and never wraps.

**Element order, left → right:**

1. **≡ rail toggle** — always visible at `md+`; the only re-open affordance for the 0px-hidden
   rail (ADR-0127 Decision D, unchanged); ⌘K remains the power-nav jump.
2. **Adaptive identity** — `▢` program identity square + compact `Program › Project`
   breadcrumb (clickable up). **Rendered only when `sidebarCollapsed`; DOM-removed otherwise**
   (not `aria-hidden`). `<nav aria-label="Breadcrumb">` when present.
3. **View navigation** — `ViewTabs` (grouped PLAN/TRACK/PEOPLE, project routes) **or**
   `ProgramTabs` (program routes), mutually exclusive per ADR-0091. This `<nav>` keeps
   `aria-label="View"` (rule 172; shared with `BottomNav` — do not rename). **It is wrapped in
   an `overflow-x-auto` scroll region with `min-w-0`**, so the strip scrolls independently when
   it exceeds available width while the right cluster stays pinned. The grouping (ADR-0128) and
   methodology filter (ADR-0041) are unchanged. The scroll region is governed by these
   **VoC-derived acceptance criteria** (see VoC panel below — they convert the Marcus/Jordan
   "tab could scroll off-screen" concern from a blocker to acceptable):
   - **Tab text labels never disappear.** The responsive ladder drops the *group labels*
     (PLAN/TRACK/PEOPLE) first, then scrolls — it **never** degrades to icon-only at common
     widths (Option B was rejected: Jordan/Alex/Marcus 🔴 + WCAG 1.1.1).
   - **The active tab is always auto-scrolled into view** on navigation/route change.
   - **Visible overflow affordance** — left/right edge fade masks (token-derived gradient,
     chrome-surface → transparent, not raw hex) **plus a chevron**; never a silent clip.
   - **Keyboard arrow-key navigation with roving `tabindex`** (the rule-167 pattern) + the
     rule-4 `focus-visible` ring, so off-screen tabs are reachable without a pointer.
   - **Overflow engages only when the strip exceeds the available width** — if it fits (program
     routes, project routes at `2xl`), the strip is static with no scroll affordance.
   - The **`HealthCluster` stays pinned and visible** at all widths down to its `Health ▾`
     collapse (Alex's non-negotiable — Sprint/Velocity never hide behind a tab scroll).
4. **Flex spacer** (`ml-auto`).
5. **Right cluster** (one unified `flex items-center gap-3`):
   - `MethodWorkspaceLabel` — `hidden xl:inline`, project routes only.
   - `HealthCluster` — **project routes only**; one bordered methodology-adaptive cluster
     (ADR-0128 semantics unchanged: Forecast neutral not amber; velocity/points gated by
     ADR-0104; `excluded_count` per ADR-0113); collapses to `Health ▾` below `lg`.
   - `CreateMenu` (`+ New ▾`) — route + RBAC self-gating (ADR-0131), unchanged.
   - `TaskRunIndicator` — only when runs active.
   - `PresenceAvatarStack` — project route, `hidden lg:flex`.
   - `NotificationBell` — always.
   - `UserMenu` — account + shortcuts + sign-out, and **the single home for the theme
     toggle**.

**Theme toggle → `UserMenu` only.** Delete the standalone `ContextBar` `ThemeToggle`. (No
rail-footer theme toggle exists in current code — the third "home" was historical; the
sidebar footer carries only the user chip + a Settings link, which `UserMenu` now also
covers.) ADR-0127 §C already mandates `UserMenu` render the shared `ThemeToggle`, so this is
a removal, not a new build.

**Program route:** no `HealthCluster`, no `MethodWorkspaceLabel`; `CreateMenu` resolves to
"New project". The bar reads intentionally lighter — calm whitespace between `ProgramTabs`
and the right cluster, **never an empty health slot**.

**Mobile (`< md`):** unchanged. Hamburger opens the rail drawer; `BottomNav` carries view
nav (rule 3 — never both); health surfaces via `StatusBar` / `Health ▾`.

**Responsive drop order (xl → md):** `MethodWorkspaceLabel` → `HealthCluster` to `Health ▾`
(< lg) → `PresenceAvatarStack` + `TaskRunIndicator` (< lg) → adaptive identity truncates to
leaf-only → (< md) tabs to `BottomNav`, ≡ to hamburger. The view-tab `overflow-x-auto` covers
any residual horizontal pressure at every width.

**Order question dissolved:** with one row there is no "context above view"; the inverted
`AppShell` stacking is moot.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **One bar + adaptive identity + scrollable view-tab strip (chosen)** | Removes ~32px + a full border + all four redundancies; one unified right cluster; tab overflow handled honestly at every width; order question dissolves | Touches the central shell component; deletes `ContextBar`; many specs move; scrollable tabs are a (mild) new interaction |
| Keep two rows at 56+46px (issue #1195) | Lowest churn; no overflow risk on the tab row | Keeps both near-empty bars and *all four* redundancies; the breadcrumb still duplicates the rail; does not address the real-estate complaint at all — it makes the chrome *taller* (102px) |
| One bar, breadcrumb always-on (no adaptive rule) | Simpler logic | Re-introduces the rail/breadcrumb duplication when the rail is open; steals ~140px from the tab strip exactly when the rail is *not* freeing width — worsens the overflow |
| One bar **without** a tab-overflow strategy | Simplest render | Ships a silently-clipped nav at `lg`/`xl` (proven by the breakpoint math) — a correctness regression, rejected |
| Two rows only on project routes at `< 2xl`, one row elsewhere | Avoids tab scroll | Two structural layouts to maintain + test; the bar "jumps" between one and two rows on resize — jarring, high spec cost |

## Consequences

- **Easier:** ~32px more canvas (Sarah/Alex VoC) and one fewer full-width border line; a
  single right-hand action cluster (no split); one theme home; wayfinding that is never
  redundant; the long-standing latent tab-clip bug is fixed by the new `overflow-x-auto`; the
  golden-standard "context above view" ordering question disappears.
- **Harder:** the central shell component changes — `ContextBar` is deleted and its elements
  re-home into `TopBar`; the adaptive-identity branch adds a `sidebarCollapsed`-conditional
  render; the view-tab scroll region + edge fades are new chrome to style and test.
- **Risks:**
  - *Tab overflow correctness (the #1 risk).* The `overflow-x-auto` + `min-w-0` wrapper must
    actually let the strip shrink and scroll without pushing the right cluster off-screen, at
    `lg` and `xl`, both methodologies, rail open and hidden. **Mitigation:** an explicit
    Playwright width matrix (lg/xl/2xl × Agile/Waterfall × rail open/hidden) asserting the
    right cluster is fully visible and the active tab is reachable; a visual-regression check
    on the edge fades.
  - *Spec drift (the #1 CI failure class).* `ContextBar.test.tsx` and `e2e/context-bar.spec.ts`
    are deleted/rewritten; `TopBar.test.tsx`, `wave1-topbar.spec.ts`, `view-switching.spec.ts`
    move; `e2e/wave10-sprints-header.spec.ts` and `iteration-terminology.spec.ts` (which scope
    their in-content breadcrumb *away from* the global `ContextBar` breadcrumb) must be
    updated — the global breadcrumb now only exists when the rail is collapsed, so those
    collision-avoidance scopes change meaning. `schedule-toolbar-responsive.spec.ts` height
    assertion is unaffected (it targets the schedule toolbar, not the shell bar). #1195's
    56+46px assertions are dropped with the issue.
  - *Identity-on-collapse a11y.* When the rail is hidden the breadcrumb is the only "where am
    I"; it must be a real focusable `<nav aria-label="Breadcrumb">` with the program leaf
    clickable, and announce on appearance via normal DOM insertion (not a live region).
  - *Design-system gate.* New bar chrome must pass `scripts/check-design-system-v2.sh`:
    `bg-chrome-surface`, borders-not-shadows (rule 1), sage-700 foreground (rule 143), zero
    dark-chrome-on-light in `features/shell/**`. The edge-fade mask must use a token-derived
    gradient (chrome-surface → transparent), not a raw hex.
- **Doc/rule updates:** `packages/web/CLAUDE.md` rule 172 (view row) is amended to describe
  one bar; a new sub-rule documents the adaptive identity + the view-tab `overflow-x-auto`
  contract. ADR-0127/0128 get a "Superseded in part by ADR-0134" banner pointing here.

## Implementation Notes
- **P3M layer:** Programs and Projects (shell chrome).
- **Affected packages:** **web** only.
- **Migration required:** **no**.
- **API changes:** **no** — composes existing `useProject`/`useProgram`/`useShellStats`/
  `useActiveSprint`/`useProjectVelocity`/`useProjectPresence`/`useShellStore`.
- **OSS or Enterprise:** **OSS** (`trueppm-suite`).
- **ADR-number collision:** 0134 verified free at authoring time (`ls docs/adr/ | grep ^0134`
  → empty; 0132/0133 occupied). The repo has a known duplicate-number pattern (#918); re-run
  the grep before committing in case a concurrent branch claimed 0134.

### Durable Execution
Pure client-side UI/navigation chrome — no async work, no Celery, no broker, no DB writes.
1. Broker-down behaviour: **N/A** — no dispatch.
2. Drain task: **N/A** — no async work.
3. Orphan window: **N/A**.
4. Service layer: **N/A** — no server mutation.
5. API response on best-effort dispatch: **N/A** — read-only consumption of existing hooks.
6. Outbox cleanup: **N/A**.
7. Idempotency: **N/A** — state is client-only (theme pref + sidebar mode in store/localStorage).
8. Dead-letter / failure handling: **N/A** — a failed/loading identity or health query renders
   the existing skeleton / muted "—" state; no failure queue.
