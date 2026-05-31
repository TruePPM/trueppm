# ADR-0102: Design System v2.0 — Navy/Sage Rebrand and Brand Token Architecture

## Status
Proposed

> **Source of truth.** The uploaded brand package — `packages/web/brand/`
> (`brand-guidelines.html`, `tokens.css`, `tokens.json`,
> `tailwind.config.snippet.js`, the 12 `assets/*.svg` builds, `README.md`) — is the
> **gold standard**. Where this ADR and the brand package ever disagree, the brand
> package wins and this ADR is corrected to match. This ADR is the *implementation
> contract* for landing that gold standard in the existing `packages/web` codebase
> without WCAG or build regressions; it does not re-decide the visual identity.

## Context

TruePPM is adopting its finalized **Brand v1.0** identity (asset package now at
`packages/web/brand/`, authoritative — see *Source of truth* above). The locked palette is:

- **True Navy `#1B2A4A`** — primary ink / identity (logo, wordmark, headings, body ink)
- **Truth Sage `#4FA884`** — accent / action / critical-path
- **Reversed Ink `#E9EDF3`** — the pale that navy reverses to on dark surfaces

Brand mantra: *"navy ink reverses to pale on dark; sage holds in both modes."*

The shipping web product (`packages/web`) is built on a **different** color system: a
single brand color **`brand-primary #1C6B3A` (forest green)** that today serves *both*
identity (logo, headings) **and** interactive/action duty (buttons, focus rings, active
sidebar accents, selection rings, links, tints). Brand v1.0 deliberately **splits** these
two jobs across navy and sage. This ADR defines how that split lands.

**P3M layer:** Programs and Projects (OSS, Apache 2.0). The brand token foundation is OSS;
`trueppm-enterprise` inherits it one-way. The marketing site (`trueppm-web`) and the
enterprise login mark are separate follow-up MRs and are out of scope here.

### Forces

1. **Token-shape mismatch.** The brand package ships `--tp-*` flat hex custom properties.
   The repo uses **RGB-channel triples** — `rgb(var(--neutral-surface) / <alpha-value>)` —
   so a single `.dark` class on `<html>` swaps every value *and* Tailwind alpha modifiers
   (`bg-x/10`) work. This channel-triple system is load-bearing: `/N` alpha forms appear in
   **174 occurrences across 254 files**. Dropping it is not viable.

2. **`brand-primary` is a static hex** (`tailwind.config.ts` lines 19–27), *not* wired
   through a CSS var. Consequence: it is the **same green in light and dark** today, and a
   runtime/`.dark` swap of the brand color is currently impossible. **984** base
   `brand-primary` class occurrences + **174** `/N` alpha forms depend on this token.

3. **The WCAG contrast crux** (per the brand guidelines' own *tested pairings* — gold
   standard). Green `#1C6B3A` was forgiving — one token could be fill *and* foreground *and*
   ring. **Sage is shade-sensitive**, and the brand prescribes which shade carries which job:
   > *"Sage 500 on white passes AA for large/medium text and UI; for body copy on white use
   > Sage 600 (#3E8C6D) or Navy. On dark, use Sage 400 (#66B998) for text."*
   - Sage-500 `#4FA884` on white ≈ **2.9:1** → OK for **large/medium text and UI components**
     (the brand's stated bound); **not** for body copy.
   - Sage-500 fill under **navy text** ≈ **6.8:1** (brand-tested) → the primary-button recipe.
   - **Sage-600 `#3E8C6D` on white ≈ 4.6:1** (brand-tested, = the on-track health value) →
     the prescribed **foreground / body / link / ring** shade on light.
   - Sage-400 `#66B998` → the prescribed **text/affordance** shade on **dark**.
   - Navy on white **12.6:1**, navy/reversed **12.1:1** (brand-tested). On dark, navy
     `#1B2A4A` ≈ ~1.1:1 → never an affordance on dark.

   So a single token cannot serve every role. The resolution is the brand's own shade split —
   **`-500` for fills (with navy text), `-600` for on-light foreground/rings, `-400` for
   dark** — not a retreat from sage.

4. **Blast radius.** Beyond the token file: `globals.css` (one rgba literal, avatar slot 0),
   the canvas `GanttRenderer.ts` (`COLOR`/`COLOR_DARK`: `todayLine`, `selectionRing`,
   `milestone`), **14 source files** with hardcoded brand hex (phase/resource/program color
   palettes + fixtures), **~25 vitest specs + 5 Playwright specs** asserting the green hex or
   `brand-primary` class names, and **141 design rules in `packages/web/CLAUDE.md`**, most of
   which cite the green and WCAG figures computed against it.

5. **No prior ADR** establishes the green palette — only the design-handoff doc
   `docs/design/handoff/2026-05-batch/00-design-system-context.md` and ADR-0002 (token-gap
   foundation, Proposed). This ADR is the first to formally own the brand-token system and
   supersedes the color portions of ADR-0002.

## Decision

### D1 — Keep the channel-triple architecture; make brand tokens mode-aware

Retain `rgb(var(--token) / <alpha-value>)`. **Convert `brand.primary` (and its
`-dark`/`-light`/`accent*` siblings) from static hex into channel-triple CSS vars** defined
in `globals.css` under `:root` and `.dark`, exactly like `neutral.*`/`semantic.*`. This (a)
preserves all 174 `/N` usages, (b) finally makes the brand color mode-aware, (c) lets the
`.dark` class do the light↔dark swap with zero JS. Import the brand package's **navy** and
**sage** scales (`brand/tailwind.config.snippet.js` / `tokens.json`) as static scale tokens
(`navy.50…900`, `sage.50…900`) for explicit identity/accent use.

### D2 — Role mapping (the navy/sage split)

The single green token fragments by **role**, not by find-replace:

| Current usage (green) | Role | New token | Light | Dark | WCAG |
|---|---|---|---|---|---|
| Logo mark | identity | official duotone SVG | navy nodes + sage arrow | `mark-reversed` (pale nodes + sage) | n/a |
| Wordmark | identity | "True" navy + "PPM" sage, Space Grotesk Bold | navy / sage | reversed / sage | 12.6:1 / ✓ |
| Display/H1 accent text | identity | `brand-ink` (navy) | navy-700 `#1B2A4A` | reversed `#E9EDF3` | 12.6:1 / 12.1:1 ✓ |
| `text-brand-primary` (active tab/label/icon) | foreground action | **`brand-primary`** | **sage-600 `#3E8C6D`** | **sage-400 `#66B998`** | 4.6:1 / ~5:1 ✓ |
| `border-/ring-brand-primary` (active accent, focus) | affordance | **`brand-primary`** | sage-600 | sage-400 | ≥3:1 ✓ (1.4.11) |
| `bg-brand-primary/5…/40` (tints, selection, drag-over) | tint | **`brand-primary`** @ alpha | sage-600 α | sage-400 α | n/a (decorative) |
| `bg-brand-primary` (primary **button fill**, active bg) | action fill | **`bg-sage-500 text-navy-900`** recipe | sage-500 `#4FA884` | sage-400 | 6.8:1 (brand-tested) ✓ |
| Links | action text | `brand-link` | sage-600 `#3E8C6D` | sage-400 | 4.6:1 ✓ |
| `brand-accent` (amber `#E8A020`) | secondary accent / milestone | unchanged (amber retained) | `#E8A020` | `#E9B35A` | per existing |

**Key rule:** `brand-primary` (the 984-usage token) maps to the brand's prescribed
**foreground/ring shade — sage-600 `#3E8C6D` (light) / sage-400 `#66B998` (dark)** — the safe
default that keeps **every existing usage AA without an audit** (sage-600 on white is the
brand-tested 4.6:1). The **vivid sage-500 fill + navy text** is the brand's *btn-primary
recipe* (`brand-guidelines.html` / README), applied to true primary-fill surfaces (buttons,
active sidebar row bg, selected chips) in Stage 3 — this is where the brand reads as "sage".
Navy is reserved for identity/ink via the separate `brand-ink`/`navy.*` tokens, and for the
**duotone mark's nodes**.

> Visual note: sage-600 `#3E8C6D` sits close in *darkness* to the old `#1C6B3A`, so the bulk
> swap is low-risk for contrast (deep-green → deep-sage). The brand's *character* comes from
> the vivid sage-500 fills, the duotone mark, and navy identity introduced deliberately — not
> from recoloring 984 generic accents to a neon.

### D3 — Focus-ring / interactive contrast solution

Focus rings and active borders use **sage, mode-tuned**: **sage-600 `#3E8C6D` on light
(4.6:1, brand-tested)**, **sage-400 `#66B998` on dark** — both clear 1.4.11 with headroom.
This *replaces* the legacy rule-4 split (light `brand-primary` green / dark
`semantic-on-track` `#4ADE80`). The dark override remains mandatory but its target becomes
**sage-400**, not on-track green. Because `brand-primary` itself is now sage-600/sage-400,
`ring-brand-primary` is correct in both modes and most of rule 4's per-surface special-casing
collapses.

### D4 — Canvas palette re-derivation (`GanttRenderer.ts`)

| Constant | Old | New (light `COLOR`) | New (dark `COLOR_DARK`) |
|---|---|---|---|
| `todayLine` | `#1C6B3A` / `#4ADE80` | sage-600 `#3E8C6D` (the "now" on the path = sage) | sage-400 `#66B998` |
| `selectionRing` | `#1C6B3A` / `#4ADE80` | **navy-700 `#1B2A4A`** (ink ring, 12.6:1, distinct from sage fills) | **reversed `#E9EDF3`** |
| `barComplete` | `#166534` / `#4ADE80` | on-track `#3E8C6D` (= sage-600, brand on-track) | sage-400 `#66B998` |
| `milestone` | `#E8A020` | unchanged (amber accent retained) | unchanged |

**Distinguishability constraint:** in the brand, sage carries *both* action and positive
state, so on a complete (sage) bar a sage selection ring would vanish. The selection ring is
therefore **navy ink** on the light canvas (12.6:1, unmistakable over any sage fill) and
**reversed pale** on the dark canvas. `todayLine` stays sage (the path's "now"); `barComplete`
adopts the brand on-track sage-600. ux-design owns final tuning of this triad.

### D5 — Semantic health adopts the brand's semantic palette

The brand package defines the authoritative semantic set: **on-track `#3E8C6D`, at-risk
`#DE9326`, critical `#CF4438`, info `#2F6FD1`** (each with a light-tint bg). The repo's
current values (`#166534`, `#92400E`, `#B91C1C`, `#2563EB`) approximate these; they re-point
to the brand values, keeping the repo's dark-mode lift technique (lighter variants for AA on
dark). **Note — on-track *is* sage-600** by design: the brand states sage carries "the path,
the action, **and a positive state**." This is a deliberate unification, not a collision; the
"complete vs selected vs on-track" differentiation is carried by **component role** (sage
*fill* = complete/on-track; navy *ring* = selected; sage vertical *line* = today), per the D4
distinguishability constraint — never by hue alone (WCAG 1.4.1, web-rules 6/7).

Cleanups: `--avatar-color-0 #1C6B3A` and `cellColor.ts` / `--chrome-row-active`'s raw
`rgba(28,107,58)` (which encoded *brand* green) re-point to **sage**.

### D6 — Fonts and mark

Add **Space Grotesk** (display, 400–700) to `index.html`'s Google Fonts link and a `display`
key to `tailwind.config.ts` `fontFamily`. Inter (body) and JetBrains Mono (data) are
unchanged. The in-app mark (`Icons.tsx` `LogoMark`, currently a three-bar Gantt silhouette
in `currentColor`) **is replaced by the official duotone dependency-arrow mark** (`brand/
assets/mark.svg` — navy nodes + sage path), per the gold standard. This is a shape change: a
new two-color inline-SVG component (it cannot use a single `currentColor`). Mode handling
follows the asset matrix — `mark.svg` (duotone) on light chrome, **`mark-reversed.svg`** (pale
nodes + sage) on dark surfaces, **`mark-mono-navy.svg`** where only one color is available;
below 28px switch to **`favicon.svg`** (heavier build). The wordmark renders **"True" in navy
+ "PPM" in sage**, Space Grotesk Bold (700) at `-0.02em`, no space before "PPM" (brand
wordmark spec) — reversing "True" to pale on dark, sage holding.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A — channel-triple, role-split (chosen)** | Preserves `/N` + `.dark`; AA-safe bulk default; vivid sage where it counts; stageable | Requires distinguishing fill vs foreground usages in Stage 3 |
| B — `brand.primary → navy`, add sage accent | All identity text instantly high-contrast | Dark-mode navy **button fills** lose separation from the dark surface; inverts the product to navy-dominant, not the intended sage-action feel |
| C — `brand.primary → sage-500` (flat swap) | One-line change; maximally "sage" | Sage-500 as body-copy/foreground ≈2.9:1 — fails 1.4.3 across hundreds of `text-brand-primary` usages |
| D — adopt `--tp-*` flat-hex token shape wholesale | Matches the brand package verbatim | Throws away the channel-triple `.dark` swap + 174 `/N` alpha usages; massive churn |

## Consequences

**Easier:** brand color finally mode-aware; one place (`globals.css`) drives light/dark for
brand too; the navy/sage identity is correctly separated from action affordances; future
theming (e.g. high-contrast mode) is a var swap.

**Harder:** Stage 3 must triage the 984 usages into *fill* (→ vivid sage-500 + navy text) vs
*foreground/ring* (→ stays `brand-primary` = sage-600/400). The 141 CLAUDE.md rules must be
rewritten with recomputed WCAG figures. ~30 test assertions/fixtures change.

**Risks:** (1) Shade discipline — sage-600 on white is 4.6:1 (safe) but any
sage-500-as-body-copy slip is a ~2.9:1 failure; ux-review + an automated contrast check gate
this. (2) Dark-mode navy must never become an affordance fill. (3) Test fixtures hardcoding
`#1C6B3A` will silently keep "green" in fixture data — grep must catch all of them.

## Implementation Notes

- **P3M layer:** Programs and Projects
- **Affected packages:** web (this ADR); web/marketing + enterprise (separate MRs)
- **Migration required:** no (frontend tokens only; no DB)
- **API changes:** none
- **OSS or Enterprise:** OSS (`trueppm-suite`); enterprise inherits one-way

### Staged migration plan (build stays green at every stage)

- **Stage 0 — placement (done).** Brand package + `TRADEMARK.md` at `packages/web/brand/`;
  favicon/app-icon copied to `public/`.
- **Stage 1 — non-color-breaking.** Add Space Grotesk + `display` font key; wire
  `favicon.svg`/`apple-touch-icon`; adopt the duotone mark SVG in `Icons.tsx`/`Logo.tsx`
  (pending Q1). Green palette untouched → zero visual-regression risk. `tsc` + unit green.
- **Stage 2 — token foundation.** Add `navy.*`/`sage.*` scales to `tailwind.config.ts`;
  convert `brand.primary*`/`brand.accent*` to channel-triple CSS vars in `globals.css`
  (`:root` + `.dark`); point `brand-primary` at sage-600/sage-400. Update `GanttRenderer.ts`
  `COLOR`/`COLOR_DARK` (D4) and the 14 hardcoded-hex source files (D2/D5). **This is the
  visual flip.** Run `make typecheck`; spot-check both modes.
- **Stage 3 — fill recipes + identity.** Apply `bg-sage-500 text-navy-900` to true primary
  fills (buttons, active sidebar row, selected chips); point logo/wordmark/H1 at
  `brand-ink` (navy); links → `brand-link` (sage-600/400).
- **Stage 4 — rules + tests.** Rewrite the 141 `packages/web/CLAUDE.md` rules with recomputed
  WCAG figures; update ~25 vitest + 5 Playwright fixtures/assertions; run the WCAG
  re-validation table (below); `ux-review` + `accessibility` gates.

Each stage is its own commit; `make pre-push` must pass at each.

### WCAG pairings to re-validate (Stage 4 checklist)

1. sage-600 `#3E8C6D` text on `neutral-surface` white — ≥4.5:1 (brand-tested 4.6:1)
2. sage-600 ring/border on white — ≥3:1 (1.4.11)
3. sage-400 `#66B998` text/ring on dark surface `#12141E` — ≥4.5:1 text / ≥3:1 UI
4. navy text on sage-500 fill (`btn-primary`) — ≥4.5:1 (brand-tested 6.8:1)
5. navy text on sage-400 fill (dark button) — ≥4.5:1
6. sage-600 `#3E8C6D` link on white — ≥4.5:1 (4.6:1)
7. navy-700 `#1B2A4A` ink on white — ≥4.5:1 (brand-tested 12.6:1)
8. reversed-ink `#E9EDF3` on dark surface — ≥4.5:1 (navy/reversed 12.1:1)
9. canvas sage-600 `todayLine` on light canvas `#FFFFFF` — ≥3:1; navy `selectionRing` on white — 12.6:1
10. sage tint fills (`/5`,`/10`) — decorative, confirm not sole signal (1.4.1)
11. EnterpriseBadge `bg-brand-primary/10 text-brand-primary` (now sage) — re-check (rule 121)
12. sidebar active `border-l-2 border-brand-primary` + `bg-brand-primary/10` (now sage) — 1.4.11

### Durable Execution
Pure frontend visual/token change — no async side effects, no broker, no Celery, no DB.
1. Broker-down behaviour: **N/A** — no dispatch.
2. Drain task: **N/A** — no async work.
3. Orphan window: **N/A**.
4. Service layer: **N/A** — no backend path.
5. API response: **N/A** — no endpoint.
6. Outbox cleanup: **N/A**.
7. Idempotency: **N/A** — token edits are static build-time values.
8. Dead-letter / failure handling: **N/A**.

## Resolved decisions

The brand package is the gold standard (see *Source of truth*), so these follow it rather
than re-deciding:

- **Q1 — The mark (RESOLVED: adopt official).** The app adopts the brand package's official
  **duotone dependency-arrow** mark (navy nodes + sage path), with `mark-reversed` on dark and
  `mark-mono-navy` for one-color chrome. The three-bar silhouette is retired.
- **Q2 — Primary button.** Brand `btn-primary` recipe: **sage-500 fill + navy text**
  (brand-tested 6.8:1).
- **Q3 — Bulk token default.** `brand-primary` → **sage-600 `#3E8C6D` (light) / sage-400
  `#66B998` (dark)** — the brand's prescribed foreground/ring shade — so all 984 existing
  usages stay AA (4.6:1) without a per-usage audit; vivid sage-500 fills are applied to
  identified fill surfaces in Stage 3.
- **Q4 — Semantic health adopts brand values** (on-track `#3E8C6D` = sage-600, at-risk
  `#DE9326`, critical `#CF4438`, info `#2F6FD1`). On-track being sage is intentional; role —
  not hue — distinguishes complete/selected/today (D4/D5).

No open 🔴 blocking questions. Proceeding to ux-design (Stage 1–4 implementation gate).

## Erratum — WCAG re-validation correction (Stage 4)

The Stage-4 accessibility re-validation (the step this ADR mandated) found the brand
guideline's "sage-600 on white = 4.6:1" figure to be **wrong**: sage-600 `#3E8C6D` is
**4.06:1** on white (3.78:1 even on the brand's own off-white `#F6F7F9`), failing WCAG 1.4.3
for normal-weight text. Per CLAUDE.md, WCAG AA is mandatory and overrides the guideline's
erroneous figure.

**Correction:** the light-mode **foreground** shade (the value `--brand-primary` and
`--semantic-on-track` resolve to in light mode) is **sage-700 `#316F57` (5.93:1)**, not
sage-600. sage-600 survives only as a *fill/dot* weight (e.g. the on-track `-bg` tint) and as
the canvas today-line / complete-bar fill (UI elements, 3:1 threshold, where 4.06:1 passes).
This supersedes the sage-600 figure wherever D2/D3/Q3/Q4 say "foreground = sage-600". The
sage-500-fill + navy-text button recipe and all dark-mode (sage-400) values are unchanged and
verified PASS. Codified in web-rule 143.
