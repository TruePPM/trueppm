# TruePPM — Brand Asset Package

Brand & identity system **v1.0**. Everything needed to build TruePPM surfaces
on-brand. Open `brand-guidelines.html` in a browser for the full visual reference.

> **Locked palette** — True Navy `#1B2A4A` · Truth Sage `#4FA884` · Reversed Ink `#E9EDF3`
> Navy ink reverses to pale on dark; sage holds in both modes.

---

## Contents

```
brand/
├─ brand-guidelines.html        # full visual reference (start here)
├─ tokens.css                   # CSS custom properties (light + dark)
├─ tokens.json                  # design tokens, machine-readable
├─ tailwind.config.snippet.js   # Tailwind theme.extend
├─ README.md
└─ assets/
   ├─ mark.svg                  # primary duotone mark
   ├─ mark-ring.svg             # ringed (resolved-terminal) mark
   ├─ mark-reversed.svg         # pale nodes + sage arrow, for dark
   ├─ mark-mono-navy.svg        # single-color navy
   ├─ mark-mono-black.svg       # single-color black (procurement, fax)
   ├─ mark-mono-white.svg       # single-color white (knockout)
   ├─ logo-lockup.svg           # horizontal: mark + wordmark
   ├─ logo-lockup-reversed.svg  # horizontal, for dark
   ├─ logo-stacked.svg          # mark over wordmark
   ├─ wordmark.svg              # TruePPM wordmark only
   ├─ favicon.svg               # heavier build for 16–32px
   └─ app-icon.svg              # 1024² navy squircle, reversed mark
```

## The mark

A **dependency arrow**: a small start node, a larger resolved terminal, joined
by the sage critical-path. Navy nodes, sage arrow. It encodes the product —
scheduling, dependency, the path that decides the date.

- **Clear space** = the diameter of the large terminal node, on all sides.
- **Minimum size** — duotone mark 24px; use `favicon.svg` at 16–24px.
- **Wordmark** — Space Grotesk **Bold (700)**, `-0.02em` tracking. `True` in
  navy (Reversed Ink on dark); `PPM` always Truth Sage, set solid.

**Don't** recolor, stretch, rotate, or place on low-contrast backgrounds.

## Using the tokens

**CSS** — import once; dark mode via `data-theme="dark"` (or `.dark`):
```html
<link rel="stylesheet" href="brand/tokens.css">
```
```css
.btn-primary { background: var(--tp-sage-500); color: var(--tp-navy-900); }
.card        { background: var(--tp-surface); border: 1px solid var(--tp-border); }
h1           { font-family: var(--tp-font-display); color: var(--tp-text-primary); }
```
```html
<html data-theme="dark"> … </html>   <!-- navy reverses to pale, sage holds -->
```

**Tailwind** — merge the snippet into `tailwind.config.js`:
```js
const tp = require('./brand/tailwind.config.snippet.js');
module.exports = { /* … */ theme: tp.theme };
// → bg-brand-navy, text-sage-500, font-display, rounded-lg, shadow-md …
```

**JSON** — `tokens.json` is the source of truth for any build pipeline
(Style Dictionary, Figma sync, codegen).

## Fonts

Load these three (Google Fonts, `@fontsource`, or self-host):

| Role            | Family           | Weights         |
|-----------------|------------------|-----------------|
| Display / mark  | Space Grotesk    | 400 500 600 700 |
| UI / body       | Inter            | 400 500 600 700 |
| Data / mono     | JetBrains Mono   | 400 500 600     |

```html
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
```

## Favicon & app icon

```html
<link rel="icon" type="image/svg+xml" href="brand/assets/favicon.svg">
<link rel="apple-touch-icon" href="brand/assets/app-icon.svg">
```

## Notes

- Logo SVGs embed an `@import` for Space Grotesk so the wordmark renders in a
  browser. For **print or offline**, outline the text in a vector tool first.
- Semantic colors map to PPM health: on-track `#3E8C6D`, at-risk `#DE9326`,
  critical `#CF4438`, info `#2F6FD1`. Each has a light-tint background in tokens.
- Borders before shadows. Reserve `--tp-shadow-*` for true overlays.
