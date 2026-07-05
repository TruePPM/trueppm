# TruePPM v2 UI — the Golden Standard

> ⚠️ **GOLDEN STANDARD.** This is the canonical TruePPM v2 interface. Every new
> screen, component, bug fix, and feature from this point forward **must conform to
> the patterns, tokens, and conventions defined here.** When an existing screen
> conflicts, the existing screen is wrong and should be migrated. Decision record:
> **ADR-0126**. Token implementation: `packages/web/src/styles/globals.css` +
> `packages/web/tailwind.config.ts`. Enforcement: `scripts/check-design-system-v2.sh`
> (runs in `make lint` / CI). Staged adoption: epic **#1163**.

This document mirrors the Claude Design handoff `design_handoff_trueppm_v2` into the
repo so it is reviewable and versioned alongside the code. The handoff bundle is the
upstream source of truth; this file is the in-repo contract.

## The system (apply everywhere)

- **Brand v2 — True Navy + Truth Sage.** Navy `#1B2A4A` is text/ink and the
  dark-surface anchor; Truth Sage is the single accent. **Sage has two roles** (see
  ADR-0126 §3): `--sage` `#3E8C6D` for **fills/accent** (with navy or white text);
  **sage-700 `#316F57`** (`--brand-primary`) for normal-weight **text/border/ring**
  (the AA-safe shade — sage-600 is 4.06:1 on white and must not carry body text).
- **Warm-neutral paper, not cool grey** — the antidote to "sterile." Canvas
  `#F2EEE5` (`bg-app-canvas`), paper `#FAF8F3`, sunken `#EAE5D9`, cards `#FFFFFF`,
  warm borders `#E6E1D6`.
- **Type:** Space Grotesk (`font-display`, headings/wordmark/big numbers), Inter
  (`font-sans`, UI/body), JetBrains Mono (`font-mono` / `.tppm-mono`, data/IDs/dates,
  tabular-nums).
- **One component kit.** Locked radii (`rounded-card` 12px / `rounded-control` 8px /
  `rounded-chip` 6px / `rounded-full`), **borders over shadows** — shadow
  (`shadow-card` / `shadow-pop`) is reserved for popovers, drawers, modals, the
  command palette, and toasts only.
- **Status vocabulary (do not mix):** a **dot** = health (sage on-track / amber
  at-risk / red critical); a **pill/chip** = state. Default to calm neutrals;
  reserve amber and red strictly for genuine risk/breach. **Color is signal, never
  decoration.**
- **Motion:** 120 / 200 / 320ms (`--dur-1/2/3`), `ease-brand`
  (`cubic-bezier(.2,.7,.2,1)`). Tasteful only. Honor `prefers-reduced-motion`.

## Information architecture (the new shell)

A **248px left rail** + a **two-row top region** (context row + view row), replacing
the old single busy top bar. See `design_handoff_trueppm_v2/01-shell-and-ia.md`.

- **Left rail** (top→bottom): brand lockup mark + `True`(ink)`PPM`(sage) wordmark +
  collapse `«` (⌘/Ctrl+B) · ⌘K trigger · **Personal** (My Work, Inbox) ·
  **Shortcuts** (pinned projects, ★ to pin) · **Organization** (Portfolio rollup, EE
  badge when gated) · **Programs** (expandable tree → projects) · user footer + gear.
- **Context bar (56px):** breadcrumb with the program identity square ·
  consolidated **health cluster** (replaces 3 separate badges) · notifications ·
  theme control (Light/Dark/Auto) · presence · **+ New**.
- **View bar (46px):** views **grouped** `PLAN · TRACK · PEOPLE` (not 9 flat tabs),
  **method-filtered**; hidden on My Work / Inbox / Portfolio / Settings / Program.

### Altitude
- **My Work** = the IC/PM home and default landing (cross-program, due-date-first).
- **Program overview** = projects in a program, as cards, with a rollup header + Risk
  rollup panel.
- **Portfolio rollup** = cross-program aggregation — **Enterprise, post-1.0** (gate
  the aggregation, not the word; single-program rollup stays OSS).

## Method-adaptive surfaces
Methodology (Agile / Waterfall / Hybrid) is set per project and cascades workspace →
program → project. It **reshapes the UI, never the data model.** Agile → Roadmap,
Backlog, Board, Sprints (default Board). Waterfall → Schedule, WBS (default Schedule).
Hybrid → all PLAN views, gantt-outer / board-inner. Configured in Settings → "How
this program works" with a visible inherit/override cascade. See `02-views.md`.

## Theming — Light / Dark / Auto
Three-way control; **Auto** follows `prefers-color-scheme` live (no reload). Dark is a
**full app theme** via a single `.dark` token swap on `<html>` — **never** a dark
sidebar on a light app. Implementation already in place: `themeStore`,
`useThemeInit`, `public/theme-init.js`. Golden token values in
`03-theming-and-tokens.md` and `globals.css`.

## What changed (legacy → standard) — do not regress

| # | Legacy (wrong) | New standard (required) |
|---|---|---|
| 1 | 9 flat view tabs | Grouped **PLAN / TRACK / PEOPLE**, method-filtered |
| 2 | No global home | **My Work** default landing, cross-program |
| 3 | Search icon | Persistent **⌘K command palette** |
| 4 | 16-element top bar, 3 health badges | Context row + view row; one **health cluster** |
| 5 | 6 KPI cards | **3 focus cards** ranked by risk |
| 6 | Drifting radii/shadows/icons | One token set; borders-over-shadows; one status vocabulary |
| 7 | Dark sidebar on light app | **Full Light/Dark/Auto** theme |
| 8 | Decorative color | **Color = signal only** |
| 9 | Systems-speak (SPI/EVM/WBS) | Plain-language lead, metric as subtitle |
| 10 | No empty/first-run states | **Warm empty states** + tasteful motion |
| 11 | Colliding gantt deps | Critical-path accent, orthogonal routing, **hover-to-trace** |
| 12 | Thin Risks view | Filters (All/High/**Unmitigated**/Mine), exposure matrix, rollup |
| 13 | Cramped task drawer | Drawer **+ expand-to-full-page** |
| 14 | Always-present sidebar | **Collapsible** (⌘/Ctrl+B) |
| 15 | "Portfolio" surfaced free | Gated **Portfolio rollup** (cross-program = Enterprise) |
| 16 | Tiled app-icon logo | Canonical **duotone lockup mark** |

## Entitlements
Edition detection drives gating (`TRUEPPM_EDITION` / `useEdition()`): Community gets
projects, scheduling/CPM, Monte Carlo, sprints, **programs + single-program rollup**;
Team adds SSO/integrations/hosting; Enterprise adds **cross-program portfolio
rollup**, leveling, EVM, audit, SCIM. Gated surfaces show an **EE badge + a designed
upsell** — never a dead control. See `04-entitlements.md`.

## For implementers — start here
1. Read this file + ADR-0126.
2. Tokens: `globals.css` (`:root` / `.dark`) and `tailwind.config.ts`. Never hardcode
   hex in components — the lint gate fails it. (The gate counts hex only in a color
   context — a quoted value, a `bg-[#…]` arbitrary class, or a `:` CSS value — so a
   `#1236` issue reference in a comment is fine and will not trip it.)
3. Sage: fill vs. text split (§ "The system"). Use `bg-app-canvas` for page canvas,
   `bg-neutral-surface` for cards.
4. The upstream handoff (`design_handoff_trueppm_v2/`) carries the full per-area
   specs and the working prototype for pixel reference.
