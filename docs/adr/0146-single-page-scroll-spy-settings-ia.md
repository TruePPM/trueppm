# ADR-0146: Single-page scroll-spy Settings IA (supersede ADR-0061's multi-route shell)

## Status

Accepted (2026-06-19) — implements #1248 (milestone 0.3, OSS). Supersedes the
multi-route Settings information architecture established by ADR-0061 and extended
across the project / program / workspace settings shells. The save-bar dirty/discard
contract (web-rules 115–118) is preserved, not replaced.

> **Renumber-at-merge risk.** ADR-0145 is claimed by an active worktree
> (`323-379-board-find-and-fit`, "Board find & fit"). Both branches are unmerged. If
> 0145 lands first, this ADR is already at 0146 and is unaffected. If a third branch
> grabs 0146 before this merges, renumber this file to the next free number at merge
> and repoint the `#1248` references. Latest committed ADR at branch cut was 0144.

## Context

Settings is the one TruePPM IA surface that never adopted the v2 golden standard. It
predates v2 (ADR-0061, milestone 0.1) and was only re-tokenized and chrome-suppressed
(web-rules 122–125), never re-architected.

`SettingsShell.tsx` renders a left rail of `<NavLink>` plus a single `<Outlet/>`.
`router.tsx` mounts each section (`general`, `access`, `methodology`, `team`,
`workflow`, `guardrails`, `signal-privacy`, `integrations`, `notifications`,
`lifecycle`, and the program/workspace equivalents) as **its own route + its own
`lazy()` chunk**, for each of project / program / workspace — roughly ten sections
across three entities.

Every section nav therefore triggers unmount → remount → Suspense fallback → TanStack
refetch. The user-visible result is **flashing / reloads between sections**, which is
exactly the opposite of the v2 "calm surface" requirement.

**P3M layer**: Programs and Projects (single-entity configuration). Configuring one
workspace / program / project is squarely OSS — no cross-entity aggregation. Firmly
OSS, no enterprise boundary crossing.

**VoC summary** (focused panel, 8.5/10 average across the relevant cohort, no 🔴):
- Sarah (PM, 9/10): single uninterrupted configuration pass, one save bar that catches
  every edit — exactly right. Deep-links from email/notifications must still land on
  the right section.
- Priya (Team Member, 8/10): low-frequency surface, but the reload flicker read as
  broken; a calm single page is strictly better.
- Marcus / Janet / David / Jordan / Alex / Morgan: N/A — settings IA is not a
  portfolio or agile-ceremony surface.
- Key constraint surfaced (drives the decision below): one save bar spanning all
  sections **must not** silently save a section the user did not touch. Save and
  Discard must be scoped to the *dirty* sections. → resolved by per-section dirty
  tracking in the save store (Decision §3).

## Decision

Replace the route-per-section shell with **one mounted scrolling page per entity**.
Sections become anchored regions (`<section id="…">`) on that single page; the left
rail becomes a **scroll-spy** navigator. No route swap, no chunk swap, no refetch on
section change.

### 1. One mounted page, anchored sections

Each entity's settings page (`ProjectSettingsPage`, `ProgramSettingsPage`,
`WorkspaceSettingsPage`) renders **all** of its section components at once, each
wrapped in a `<SettingsSection id={…} label={…}>` region with a stable anchor id
matching its old route slug (`general`, `access`, …). The existing section components
are reused **as-is** — this ADR changes how they are mounted, not their internal forms.
The shell stays mounted across section navigation; only the scroll position and the
active-nav highlight change.

### 2. Scroll-spy navigation (`SettingsScrollSpyNav`)

The left rail keeps the existing group/item structure but its items become
scroll-spy anchors, not `<NavLink>`s:

- **Click** → `scrollIntoView({ behavior: 'smooth' })` on the target section and push
  a hash (`…/settings#methodology`) via `history.replaceState`-equivalent (router
  `navigate(hash, { replace: true })`) so the URL is deep-linkable without a route
  remount.
- **Scroll** → an `IntersectionObserver` (one observer per page, sections registered
  by id) updates the active item. The active section is the topmost section whose top
  edge is at or above a sentinel line near the top of the scroll viewport; this avoids
  the "two sections both 50% visible" ambiguity. Active state uses the existing v2
  active-rail treatment (left border + `font-semibold` + `bg-neutral-surface-sunken`).
- `prefers-reduced-motion` → smooth scroll degrades to instant (`behavior: 'auto'`).
- Keyboard: nav items remain real `<button>`s; activating one moves focus to the
  section heading (`tabIndex={-1}` + `focus()`) so keyboard and screen-reader users
  land *in* the section, not just scroll the viewport under them.

### 3. One save surface across all sections — `useSettingsSaveStore` becomes multi-section

This is the load-bearing change. Today the store documents *"Only one page may be
registered at a time… last-register-wins"*. With every section mounted at once that
contract breaks (the last section to register would clobber the others). The store is
generalized to a **keyed registry**:

- `useDirtyForm` gains a required `sectionId` and registers/unregisters under that key
  (cleanup removes only its own entry, not the whole store).
- Derived `dirty` = **any** registered section dirty.
- `triggerSave()` awaits `onSave` for **every dirty** section (sequential to keep
  error attribution simple and avoid hammering the API with N parallel PATCHes;
  settings saves are infrequent and small). A rejection stops the run and surfaces the
  failing section's message; already-saved sections stay saved.
- `triggerDiscard()` calls `onReset` for **every dirty** section.
- `saveError` is the first failing section's message; `lastSavedAt` stamps on a fully
  successful run.

This directly resolves the VoC constraint: only sections the user actually edited are
saved or discarded; a clean section is never touched.

The shell's `beforeunload`, ⌘/Ctrl-S, and `ConfirmDiscardDialog` wiring is unchanged
in behavior — it now reads the aggregated `dirty` and routes through the same
triggers. The intra-app nav guard (scope switch / context switch) is retained; it now
guards leaving the *page*, since intra-page section moves no longer navigate.

### 4. Deep links and legacy redirects

- `…/settings` (index) renders the page scrolled to top (no redirect to `general`
  needed; the page already shows General first). The old index `<Navigate>` redirects
  are replaced by the page itself.
- `…/settings/#general`, `#methodology`, etc. scroll to the anchor on load.
- **Old per-section paths are kept as redirects**: `…/settings/methodology` →
  `…/settings#methodology` (302-equivalent client redirect via a small
  `SectionRedirect` element in the router). This preserves existing bookmarks, email
  links, and — critically — the large existing e2e suite, which is updated in the same
  MR to assert on the anchored page where the redirect target text differs.

### 5. Data loading

Section components keep their own TanStack queries. Because all sections mount at once,
their queries fire on page mount rather than on section nav. For the heaviest sections
(member lists, role matrices) the component is wrapped so its query is **deferred until
the section first scrolls into view** (an `IntersectionObserver`-gated `enabled` flag),
keeping initial page cost bounded while the shell stays mounted. Light sections fetch
eagerly. No new endpoints; serializers are unchanged → no API change, so RBAC /
broadcast / perf gates are N/A for this work.

## Consequences

**Positive**
- No remount / no Suspense fallback / no refetch on section change → the flashing is
  gone (the acceptance criterion).
- Single dirty surface spanning sections, scoped to edited sections.
- Deep-linkable, bookmark-stable; old links redirect.
- Section components are untouched internally — low blast radius, the dirty contract
  and per-field RBAC gating they already implement carry over verbatim.

**Negative / trade-offs**
- All sections mount at once → more DOM on first paint. Mitigated by deferring heavy
  section *data* until scroll-into-view (§5); the markup cost of the lighter sections
  is acceptable for an admin-only surface.
- The save store is now keyed; its tests and the `useDirtyForm` signature change. Both
  are updated in the same MR.
- Scroll-spy active-section logic is genuinely new client logic → unit-tested
  (vitest) in isolation.

**Superseded**
- ADR-0061's route-per-section Settings IA. The Members management *endpoint* and
  user-search behavior ADR-0061 introduced are unaffected — only the multi-route shell
  framing is replaced.

## New web rules

A new design rule is added to `packages/web/CLAUDE.md` (see rule added in this MR):
settings sections are anchored regions on one mounted page with scroll-spy nav and a
single multi-section dirty surface — never route-per-section. Any new settings section
registers a `<SettingsSection>` + a nav item + a `useDirtyForm({ sectionId })`, and a
legacy `…/settings/<slug>` → `#<slug>` redirect.
