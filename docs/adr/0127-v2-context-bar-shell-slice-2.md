# ADR-0127: v2 Context Bar (shell slice 2)

## Status
Accepted (2026-06-14) — founder ratified Decision D = hide-to-context-bar (0px),
Decision E = defer presence, Decision B = drop "+ New".

> **Superseded in part by [ADR-0134](0134-v2-unified-shell-bar.md) (2026-06-15).** The
> **two-row coexistence (Decision A)** is superseded: the `ContextBar` is merged into a
> single unified shell bar (`TopBar`) and deleted. The *content* contracts here — the
> always-visible rail re-open ≡ (Decision D), presence as ephemeral (Decision E), and the
> context-aware create being out of this slice (Decision B, since delivered by ADR-0131) —
> remain in force; only the host row changed. The breadcrumb is now **adaptive** (shown only
> when the rail is hidden / on mobile) rather than always-on, and the theme toggle collapses
> to `UserMenu` only.

## Context
The v2 UI redesign (epic #1163, golden standard in ADR-0126) replaces the legacy
16-element top bar with a calm **two-row top region**: a *context row* (wayfinding +
identity + chrome controls) above a *view row* (the grouped PLAN/TRACK/PEOPLE tabs +
single health cluster). Slice 1 — the 248px left rail — shipped in #1165 (MR !605).
Slice 3 — the view row + health cluster — is #1167.

This ADR covers **slice 2, the context row (#1177)**. It must ship independently of
#1167 and must not regress the view tabs, health pills, presence, notifications, or
user menu that today's `TopBar.tsx` still renders.

**P3M layer:** Programs and Projects (shell chrome / wayfinding). **OSS.** No
cross-program aggregation; Portfolio/Enterprise untouched. `grep -r trueppm_enterprise
packages/web` remains zero.

### Current state (code map)
- `TopBar.tsx` is **not** a thin shim: after #1165 it still renders `ViewTabs` (9),
  `ProgramTabs` (6), 3 health pills (`useShellStats`), `TaskRunIndicator`,
  `PresenceAvatarStack`, `NotificationBell`, `UserMenu`.
- `AppShell.tsx` stacks `<TopBar>` full-width above a flex body row `[desktop Sidebar |
  <main>]`.
- `shellStore.ts`: `sidebarCollapsed` + `sidebarUserControlled` (session-only, **not**
  persisted); `selectSidebarWidth → 60 | 248`. Auto-collapse `< lg` lives in
  `Sidebar.tsx`.
- Theme: `themeStore` (light|dark|auto, persisted `trueppm.theme`); `.dark` class
  applied by `useThemeInit`; the only toggle UI is `ThemePill` **inside** `UserMenu`.
- `ProgramIdentitySquare(program{color,code,name}, size)` (rule 158: square = identity).
- `PresenceAvatarStack(users[])` fed by `useProjectPresence(projectId)` — **per-project
  only**; renders nothing outside a project route.
- **No breadcrumb component exists** — three inline copies (`SprintsView`,
  `RiskRegisterView`, settings) share one token pattern: `text-xs font-semibold
  tracking-widest uppercase text-neutral-text-secondary`, separator
  `text-neutral-text-disabled`.
- Design-system-v2 gate (`scripts/check-design-system-v2.sh`): zero new arbitrary color
  classes / raw hex / off-token shadows; **zero-tolerance** on dark-chrome-on-light in
  `features/shell/**`. New chrome uses `bg-chrome-surface`, tokens only, borders not
  shadows (rule 1), and the sage-shade discipline (rule 143).

## Decision
Introduce a new **`ContextBar`** component, inserted in `AppShell` as a full-width
`shrink-0` sibling directly below `OfflineBanner` and above the body row. **`TopBar`
stays untouched** and remains the interim *view row* until #1167 modernizes it. This
isolates #1177 from #1167 with zero churn to view tabs / health / notifications.

`ContextBar` (compact, single ~40px row, `bg-chrome-surface`, bottom border) contains,
left→right:
1. **Rail toggle** (≡) — the re-open affordance for the rail's new hidden state (see
   Decision D).
2. **Breadcrumb** — a new shared `Breadcrumb` component canonicalizing the existing
   inline token pattern. Segments:
   - `/projects/:id` → `Workspace › [Program, if `project.program_detail`] › Project`
   - `/programs/:id` → `Workspace › Program`
   - non-scoped routes (My Work, Inbox, Settings, Portfolio) → `Workspace` root only (or
     a single contextual label); the bar is allowed to render a minimal/empty trail.
   - "Workspace" links `/`; Program links `/programs/:id/overview`; Project is the
     current page (non-link, `aria-current="page"`). Loading → skeleton segment; missing
     program → the program segment is simply omitted (projects can be standalone).
3. **Program identity square** (`ProgramIdentitySquare size="sm"`) shown when a program
   is in context — reinforces which program you're in (rule 158).
4. Right cluster: **`ThemeToggle`** (see Decision C).

### Decisions on the open questions
- **A. Coexistence:** new `ContextBar` above the existing `TopBar`; `TopBar` left as-is.
  #1167 later folds `ViewTabs`/health into the view row without touching `ContextBar`.
- **B. "+ New": DROP from this slice.** VoC: a generic create from program-level chrome
  risks silently bypassing the Sprint backlog (Alex/Morgan hard-NO territory), reads as
  "PM-y UI" (Priya), and is ambiguous (Jordan wants context-aware). Re-scope #1177 to
  exclude it; file a follow-up for a **context-aware, role-aware** create affordance
  (creates a story in the backlog view, a task in schedule, etc.; hidden for Viewer/Member).
- **C. Theme toggle:** extract a standalone `ThemeToggle` (lift `ThemePill` + icons +
  `THEME_OPTIONS` into `components/ThemeToggle.tsx`, reading `useThemeStore` internally).
  `UserMenu` renders the *same* shared component (no logic duplication; one or both
  placements is a ux-design call). Validated by VoC ("theme in the shell is the right
  place").
- **D. Rail "hide-to-context-bar" collapse — RATIFIED: 0px hide.** Collapse becomes
  **expanded (248) / hidden (0)**, with a **persistent, always-visible re-open ≡ toggle
  in the `ContextBar`** (non-negotiable so nav is never "lost"; ⌘K remains the power-nav
  jump). This **supersedes** the 60px icon rail — including the collapsed-rail Resources
  icon added in #1176. Since **MR !607 (#1176) is still open**, it should be **closed as
  superseded** rather than merged. UX rationale: ⌘K already covers fast jump-to, so the
  icon rail is redundant; 0px maximizes canvas (Sarah/Alex VoC) and gives a clean
  two-state model. `selectSidebarWidth` gains a `0` case; auto-collapse `< lg` now hides
  rather than shrinks; `sidebarUserControlled` still guards it. A *deliberate*
  (user-controlled) collapse is persisted to `localStorage` (`trueppm.rail.collapsed`)
  so it survives a reload; viewport-driven auto-collapse is recomputed per mount and
  never persisted.
- **E. Presence avatars — RATIFIED: defer from this slice.** Per-project only (empty on
  most context-bar routes), lukewarm VoC, Morgan surveillance flag, and relocating from
  `TopBar` adds churn. Pull into the context row when #1167 refactors `TopBar`. (If later
  added, must stay ephemeral — online-only, never aggregated.) `ContextBar` right cluster
  is therefore just `ThemeToggle` for this slice.
- **F. Boundary:** OSS shell chrome. No API, no model, no migration.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| New `ContextBar` above untouched `TopBar` (chosen) | Zero churn to tabs/health; #1167 stays clean; ships independently | A transient extra row until #1167 trims `TopBar` |
| Restructure `TopBar` into a two-row container now | One component owns the top region | Forces touching ViewTabs/health/notifications = #1167's scope; high regression risk |
| Breadcrumb inline in each view (status quo) | No new component | Three drifting copies; no persistent wayfinding; fails the "always know where I am" VoC win |
| Collapse = 60px icon rail kept (Decision D alt) | Preserves #1176 quick icon-nav | Not the golden-standard "hide-to-context-bar"; leaves the interim state permanent |

## Consequences
- **Easier:** persistent wayfinding (the validated VoC win); a reusable `Breadcrumb` +
  `ThemeToggle` other surfaces can adopt; #1167 becomes a clean `TopBar` refactor.
- **Harder / risks:** the top region temporarily has two rows until #1167 trims `TopBar`
  (acceptable, visually calm). The rail-collapse rewiring (Decision D) supersedes #1176
  and interacts with the auto-collapse `< lg` logic + `sidebarUserControlled` — must be
  covered by tests. `selectSidebarWidth` gains a `0` case (or a `sidebarHidden` flag).
- **Mobile:** unchanged. The mobile drawer (`isDrawer`) path is untouched; `ContextBar`
  follows the existing responsive rules (compact on small screens).

## Implementation Notes
- P3M layer: Programs and Projects (shell chrome).
- Affected packages: **web** only.
- Migration required: **no**.
- API changes: **no** (consumes existing `useProject`/`useProgram`/presence).
- OSS or Enterprise: **OSS** (`trueppm-suite`).

### Durable Execution
Pure client-side UI/navigation chrome — no async work, no Celery, no broker, no DB writes.
1. Broker-down behaviour: **N/A** — no dispatch.
2. Drain task: **N/A** — no async work.
3. Orphan window: **N/A**.
4. Service layer: **N/A** — no server mutation.
5. API response on best-effort dispatch: **N/A** — read-only consumption of existing hooks.
6. Outbox cleanup: **N/A**.
7. Idempotency: **N/A** — state is client-only (theme pref + sidebar mode in store/localStorage).
8. Dead-letter / failure handling: **N/A**. Data-fetch failures (program/project name)
   degrade gracefully — the breadcrumb omits the unresolved segment.
