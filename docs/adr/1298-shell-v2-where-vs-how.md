# ADR-1298: Shell v2 — "where I am" and "how I look at it" are two different surfaces

## Status
Proposed (2026-10-31). Ships behind the `shell_v2` client flag; supersedes the
rail bands of [ADR-0942](0942-project-rail-verb-bands-and-a-workspace-scope-band.md) and the
view-switching parts of the v2 golden standard
([ADR-0126](0126-design-system-v2-golden-standard.md), `docs/design/v2-golden-standard.md`)
**only while the flag is on**. The v1 shell is unchanged and remains the default
until a later ADR flips the default.

## Context

The Pass 1 redesign audit (October 2026) measured the shipped shell against
TruePPM's own eight personas and against 2026 norms. Its findings on the shell
specifically:

- **One rail does four jobs.** `features/shell/Sidebar.tsx` is 2,097 lines, ~47%
  comment, citing 13 ADRs and 28 issues. It is the personal nav, a 12–14-row view
  switcher, the program/project browser, and the create/onboarding surface. The
  visible row set is six stacked filters (methodology ∩ surface visibility ∩
  `hidden_views` ∩ role ∩ ViewsMenu ∩ mobile pins), so no two users see the same
  nav and "click Board" is not a reliable instruction.
- **Methodology moves views between groups.** Board is under DELIVER on an Agile
  project and TRACK on a Waterfall one; an Agile project has **no Schedule entry
  at all** — the CPM engine the README calls "the product" is unreachable from
  the nav of an Agile project.
- **The way to other projects is hidden.** Programs and projects live in a
  popover anchored to the bottom of the rail that opens upward; at the 64px rail
  it is removed, and the rail auto-collapses below 1024px, so a 1024px laptop
  off-project has no visible route to any project except ⌘K.
- **No mobile nav off a project.** `BottomNav` returns `null` without a
  `projectId`. My Work — the home of six of the eight personas — has no bottom
  bar on a phone.
- **Chrome repeats itself and stacks.** Location is shown up to four times
  (breadcrumb, demo bar, page eyebrow, status bar); identity three times; health
  three times, and the three can disagree. Four in-flow banners
  (session read-only, demo, offline, rate-limit) can stack above the content,
  roughly 250px of chrome on a 667px phone in the worst case. The top bar holds
  ten controls and needed a scroll container and graded flex-shrink weights to
  keep the avatar on a 375px screen.
- **Role awareness stops at the first redirect.** After `landing.path`, every
  persona gets the same rail ordered by project lifecycle.

The same audit found the shipped UI follows `v2-golden-standard.md` (sage, navy
ink, Space Grotesk + JetBrains Mono, paper canvas) while the `brand` skill still
specifies Blue 600 and Inter, so an agent loading `brand` generates the wrong
system. Both documents also target WCAG 2.1; the floor is now 2.2.

## Decision

### 1. Separate the two questions the chrome answers

The **global rail** answers *where am I*: exactly five destinations — Home ·
Inbox · Work · People · Agents — then the person's pins (max 7), then the one
identity control in the app. No health dots, no view list, no gear.

The **context header** answers *how am I looking at it*: title, the server's
health band shown **once** per context, the P80 stamp with its definition and
"as of", and a tab row of at most five — Overview · Plan · Deliver · Risks ·
People — plus More. Plan holds the layout toggles Schedule / Grid / Calendar;
Deliver holds Board / Sprints / Backlog. A tab's default is the first toggle
that exists, in a fixed order — so methodology sets the default only by
deciding which toggles exist (a Waterfall project has no Sprints, so Deliver
lands on Board); it never moves a view between tabs. **Every project has Plan,
and Plan always offers Schedule** — a person's own `hidden_views` choice is
still honored (it is passed separately and always wins); the methodology
filter that removed `schedule` from Agile projects is not.

Programs use the same tabs (Overview · Plan = schedule · Deliver = intake backlog
· People), without Risks; Projects, Labels, Agents, Members, Assets and Settings
fold under More.

### 2. One location, one identity, one status

- The top bar is 48px with at most four controls: breadcrumb, status slot, ⌘K,
  Create. The breadcrumb is the only location in the app (program / project /
  leaf, a single "/" separator); the leaf is plain text because the tab row owns
  view switching.
- The avatar menu in the rail footer is the only identity.
- A single **status slot** replaces the status-only banners (offline,
  rate-limit) and the sync badge. The two bars that carry an **action** stay
  mounted — the signed-out read-only bar, whose "Sign in again" is the only way
  back once the modal is dismissed, and the demo-mode bar, which holds the demo
  project switcher and reset line — and the slot states their condition too.
  Priority is fixed: offline › session expired › demo read-only ›
  rate-limit off › failed writes › live updates paused › syncing › a quiet
  "Synced". Lower-priority active conditions fold behind "+N", reachable by
  hover, focus and touch, never stacked. Offline outranks an expired session
  because an offline client cannot re-authenticate and the pending-write count is
  the fact the person can act on; demo outranks rate-limit because demo changes
  what every control does and rate-limit is an operator notice that changes
  nothing for the person typing. (`features/shell2/statusSlotModel.ts`.)

### 3. Breakpoints belong to the shell; everything else queries its container

- `≥ 1280px`: the 248px rail (unless the person collapsed it).
- `768–1279px`: the 64px icon rail, where hovering **Work**, or pressing
  ArrowRight / ArrowDown on it, opens a **flyout** with search, pins, and every
  program with its projects — there is always a visible route to a project, by
  pointer and by keyboard (the panel is portaled, so arrows enter it, Escape
  closes it and returns focus to Work without re-opening). The width collapsed
  the rail here, not the person, so no Expand control is offered at these
  widths; ⌘B and the control return at 1280.
- `< 768px`: no rail. A **global bottom bar** — Home · Inbox · [Log] · Work ·
  Search — on every route, the account menu rides in the top bar, and the
  context header's tab row (with its layout toggles) becomes a horizontally
  scrolling lens switcher.
- Exactly one copy of the primary navigation renders per breakpoint, chosen by
  `useBreakpoint()` (rule 211), never two copies gated by `hidden md:flex`.
- Content sits on a sheet inset 8px from the canvas (radius 10) with
  `container: main / inline-size`; cards and panels inside it query that
  container, not the viewport.

### 4. A semantic token family, in OKLCH, that components consume by role

`--p1-*` in `globals.css`, exposed as the `p1` Tailwind namespace: `surface-0..3`,
`text-1..3`, `hairline` / `hairline-strong` (derived from `text-1` at 10% / 20%),
`brand` / `brand-hover` / `brand-tint` / `on-brand`, `critical`, `risk` /
`risk-text`, `ok`, `info` (each with a `-tint`), `load-1..4` (derived from
`text-1`), `over-1` / `over-2` / `on-over`, `focus`. Light and dark via the
existing `.dark` swap.

Two deliberate splits the audit asked for: **brand is never a status color**
(success has its own `ok`), and **red means critical path or blocked, nothing
else**. `src/styles/p1Tokens.test.ts` converts the OKLCH values to sRGB and pins
WCAG 1.4.3 for every text-on-surface pairing, on-brand on brand, on-over on both
over-allocation fills, and every status chip as rendered (tint composited over
the sheet) in both themes. The dark tints run at 10% rather than the design's
16% because at 16% the composited critical chip measured 3.48:1.

### 5. Behind a flag, same route tree

`features/shell2/ShellGate.tsx` mounts `AppShell2` when the `shell_v2` client
flag is on (`?ff=shell_v2`, `setFeatureFlag('shell_v2', true)`, or
`VITE_FEATURE_FLAGS`) and the v1 `AppShell` otherwise. Both shells share every
route, overlay host (command palette, create dispatcher, task drawer, shortcuts
modal, toasts, session-expired modal, pending-writes guard) and hotkey. Flipping
the flag changes chrome only.

### What this ADR does not decide

- The role-resolved **homes** (Contributor, PM, Resource Manager, Executive) and
  the Monte Carlo view — Pass 1 designs them; they land in later MRs on this
  flag.
- A **workspace-level Agents** surface. Until it exists, the rail's Agents item
  appears only when a program is in context and links to that program's agents
  page; it is omitted, not stubbed, elsewhere.
- A full-page **Work** list. The rail's Work item lands on `/programs` for now.
  *Superseded 2026-10-31 by #4756: the Work item now lands on the full-page
  `/work` list, which shares its data model with the flyout.*
- Retiring the v1 shell, `v2-golden-standard.md`, or rewriting the `brand`
  skill. Those happen when the default flips; until then the `brand` skill is
  known-stale for anything under `features/shell2/`.

## Consequences

- **Rules 4 and 357 (focus rings).** Shell v2 rings are `ring-p1-focus`
  (≥3:1 against `surface-1`, pinned by test) with a `surface-0` offset, not
  `ring-brand-primary`. Rule 4 names the token for v1 surfaces; v2 surfaces
  name theirs here.
- **Rule 148 (three type families).** Shell v2 chrome sets `font-display`
  (Space Grotesk) for everything readable and JetBrains Mono for IDs, dates and
  tabular numerics only, as the Pass 1 type spec says. Pages inside the sheet
  keep their own families until they are redesigned.
- **Rule 5 (44px targets).** Rail rows are 44px, not the design's 32px; tab
  links are 44px outright because their row scrolls and an overflow container
  clips a `before:` hit area (rule 330); the ⌘K trigger, the P80 definition
  button and the "+N" status button get sized `before:` boxes in the top bar,
  which does not clip.
- **Rule 214.** The context tab row is the phone's lens switcher, so its tabs and
  layout toggles use `focus:` rings, not `focus-visible:`.
- **Headings.** The context header's title is not an `<h1>`: every page keeps its
  own h1 naming the view.
- **Rule 246.** A failed health or forecast read renders an inline
  `QueryErrorState` with retry in the header; the Work flyout renders a skeleton
  while loading and a retryable error on failure — never an empty list.
- **Rule 231 (Enterprise affordances).** The rail carries no portfolio slot.
  When Enterprise registers one it goes where cross-program reach applies —
  the People destination — not in the rail.
- The `check-design-system-v2.sh` chrome check (dark navy on light shell) still
  passes: shell v2 chrome is `bg-p1-surface-0`, a theme-swapped token.
- Pages rendered inside the sheet still assume `bg-app-canvas`; under shell v2
  they sit on `surface-1`, so white cards pop less until each page is redesigned.
  Accepted for the flagged period.
- ADR-0942's bands and the sidebar's six visibility filters remain the v1
  contract and keep their tests; nothing in v1 changed.

## Amendment (2026-10-31, #4764): navigation budget

The item caps in section 1 (rail 5 destinations + pins max 7; context tabs at most 5 plus
More; the phone bar of 5) are now an enforceable design invariant, web rule 436
([`docs/design/invariants/436-a-navigation-surface-holds-a-fixed-number-of-items-at-rest.md`](../design/invariants/436-a-navigation-surface-holds-a-fixed-number-of-items-at-rest.md)).
Raising any of those numbers is an amendment to this ADR (or its successor), not a
review-time judgement call.
