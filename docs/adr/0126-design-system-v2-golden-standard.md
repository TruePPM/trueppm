# ADR-0126: Design System v2 — the Canonical UI Standard

## Status
Accepted

> Supersedes [ADR-0103](0103-design-system-v2-navy-sage-rebrand.md) (Brand v1.0 navy/sage token architecture).

> **Source of truth.** The Claude Design handoff bundle `design_handoff_trueppm_v2`
> (its `README.md`, `proto.css` `:root`, and the per-area specs `01-shell-and-ia.md`
> … `05-interactions.md`) is the **golden standard** for the TruePPM web UI. Where
> this ADR and the handoff ever disagree, the handoff wins and this ADR is corrected
> to match — except where the handoff would regress WCAG AA, in which case the
> accessibility-preserving reconciliation below is authoritative (and is itself a
> documented deviation, not a silent one). A repo mirror of the handoff README +
> token spec lives at `docs/design/v2-golden-standard.md`.

## Context

ADR-0103 landed Brand v1.0 (True Navy + Truth Sage) as a token architecture in
`packages/web`. The v2 design handoff goes further: it is a **ground-up UX/UI
redesign** declared the canonical interface, fixing a UI that read as "sterile,
busy, Frankenstein." It establishes one coherent system — **True Navy + Truth Sage
on warm paper**, a left-rail + two-row top shell, grouped method-adaptive views, a
⌘K command palette, full Light/Dark/Auto theming, one status vocabulary, and
edition-aware gating.

The handoff is large (≈15–20 screens/surfaces). It is adopted in stages tracked by
epic **#1163**. **This ADR + the foundation MR (#1164) are the first stage**: they
land the design-system *foundation* — golden tokens, theming, the canonical doc, and
a CI enforcement gate — so every subsequent surface MR inherits the standard
automatically rather than by reviewer memory.

## Decision

### 1. Warm-paper token family (the defining visual change)
The app sits on **warm paper**, not cool grey or white. In `globals.css`:

- New `--app-canvas` token = `#F2EEE5` (paper-2) drives the `body` background; **cards
  stay white** (`--neutral-surface` = `#FFFFFF`) and pop against the paper.
- The existing semantic neutrals are **re-pointed** (not renamed) to the golden warm
  tones: `--neutral-surface-raised` → `#FAF8F3`, `--neutral-surface-sunken` → `#EAE5D9`
  (was cool `#EBEBEB`), `--neutral-border` → `#E6E1D6` (was `#D4D2CE`). Navy ink holds
  ≥ 12:1 on every warm tone, so no contrast rule regresses.
- **Dark mode already matched the golden navy family** (`#0E1626 / #15223C / #1B2A4A`)
  from ADR-0103 — only the new `--app-canvas` alias (`#0E1626`) was added.

Keeping the token *names* is deliberate: hundreds of components and the 72 rules in
`packages/web/CLAUDE.md` consume `--neutral-*` / `--semantic-*` / `--brand-primary`.
Re-pointing the values warms the whole app with near-zero blast radius.

### 2. Canonical v2 aliases for new components
The exact handoff values are also exposed verbatim as named aliases (`--paper`,
`--ink`, `--sage`, `--line`, `--amber`, `--crit`, `--info`, `--violet`, plus radii
`--r-card/control/chip`, `--shadow-card/pop`, `--ease`, `--dur-1/2/3`, and the
`--f-display/body/mono` roles), light + dark. New v2 components recreate the
prototype pixel-faithfully against these; Tailwind exposes `bg-app-canvas`,
`rounded-card|control|chip`, `shadow-card|pop`, and `ease-brand`.

### 3. Accessibility reconciliation — sage accent (documented deviation)
The handoff names `--sage` `#3E8C6D` (sage-600) the single accent. The repo found
sage-600 is **4.06:1 on white — fails AA for normal-weight text** (ADR-0103,
globals.css). Reconciliation:

- `--sage` = `#3E8C6D` is the brand **FILL / accent identity** (CTAs, active fills,
  the dependency-arrow mark) — used with navy or white text, where it passes.
- For normal-weight **text / borders / rings**, components keep `--brand-primary` =
  **sage-700 `#316F57`** (5.93:1, AA). This is the one place v2 intentionally
  deviates from the handoff hex, to preserve WCAG AA. It is enforced, not optional.

### 4. Theming — Light / Dark / Auto (already wired; verified)
The token swap is a single `.dark` class on `<html>` (full-app repaint, never a dark
sidebar on a light app). `themeStore` (light/dark/auto), `useThemeInit` (Auto follows
`prefers-color-scheme` live via a `matchMedia change` listener, no reload), and the
pre-paint `public/theme-init.js` already implement the golden contract. The new v2
tokens live in the same `:root` / `.dark` scopes, so they swap automatically.

### 5. Enforcement gate (makes the rest enforceable)
A CI/lint check (`scripts/check-design-system-v2.sh`, wired into `make lint` / the
`lint` CI job) blocks the four legacy patterns ADR-0103 + the handoff forbid. Each
check below maps 1:1 to a function in the script — the gate enforces exactly what
this list claims, no more (the script header carries the same contract):

1. **Arbitrary Tailwind color value classes** (`bg-[#…]`, `text-[#…]`, …) — ratchet
   against a committed baseline; new offenders fail.
2. **Raw hex literals in component source** (rule 8) — ratchet; the tree carries
   pre-existing debt, so the count may not exceed the baseline and trends to zero.
   New code adds zero (a net-new literal pushes the count over baseline and fails).
   Only hex in a **color context** counts — quoted (`'#f59e0b'`), a Tailwind
   arbitrary value (`bg-[#7C3AED]`), or a CSS value after a colon (`stroke: #fff`).
   A bare `#1236`-style **issue reference** in a comment is not a color and is not
   counted; write issue refs freely (this fixed the false-positive class that used
   to fail unrelated MRs the moment they cited an issue number in a comment).
3. **Off-token box-shadow** — named `shadow-{sm,md,lg,…}` utilities *and* arbitrary
   `shadow-[…]` values (the `shadow-card` / `shadow-pop` pop-surface tokens are the
   sanctioned form and are exempt). Ratchet — v2 is borders-over-shadows (rule 1).
4. **Dark-chrome-on-light** — a raw dark navy surface on the shell chrome that is not
   `dark:`-gated (the "dark sidebar on a light app" antipattern, §4). **Zero
   tolerance**: any occurrence fails; chrome must use the adaptive `bg-chrome-surface`
   token.

This is the mechanism by which "all future work inherits the style." The ratchet
baselines live in the script and can only be raised by an explicit, reviewed edit.

### 6. The 16 legacy → standard changes
Tracked in `docs/design/v2-golden-standard.md` and epic #1163; each non-foundation
row is its own surface MR. Cross-program **portfolio aggregation stays Enterprise /
post-1.0** — gate the aggregation, not the word "portfolio"; single-program rollup
stays OSS.

## Consequences

- The whole app reads as warm paper immediately on this MR, with no component churn.
- New surfaces have an unambiguous, machine-checked token contract.
- ADR-0103 remains the brand-identity record; **ADR-0126 is the live UI-standard
  reference** and supersedes it where they overlap.
- The sage text/fill split must be respected by every new component; the gate and
  `packages/web/CLAUDE.md` carry the rule.

## Related
- ADR-0103 (brand v1 navy/sage token architecture) — superseded as the live reference.
- Epic #1163 (staged v2 adoption); foundation issue #1164.
- `docs/design/v2-golden-standard.md` (repo mirror of the handoff golden standard).
