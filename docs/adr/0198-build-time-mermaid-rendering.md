# ADR-0198: Build-Time Mermaid Diagram Rendering for the Docs Site

## Status
Accepted

## Context

Architecture and feature docs on the Starlight site (`packages/website`) carried
system diagrams as hand-drawn ASCII art inside fenced code blocks (e.g. the
component diagram in `architecture/overview.md`, the request-flow diagram in
`features/mcp-server.md`). ASCII diagrams are hard to maintain, do not reflow on
narrow screens, are invisible to assistive technology, and drift from the code
they describe because editing them is tedious. We want authorable, version-
controllable diagrams written as text (```mermaid fences) that render to real,
accessible, responsive graphics.

Mermaid's layout engine (dagre) requires a DOM to measure text and lay out nodes,
so there is no pure-Node, browser-free path to a faithful SVG. The rendering has
to happen either in a real browser at build time or in the visitor's browser at
runtime.

## Decision

Render Mermaid **at build time to static inline SVG** using
[`rehype-mermaid`](https://github.com/remcohaszing/rehype-mermaid) (MIT) wired
into Starlight's markdown `rehypePlugins`, with `strategy: "inline-svg"`.
`rehype-mermaid` drives a headless Chromium through Playwright (Apache-2.0) on the
build machine only; the shipped HTML contains the finished `<svg>` and **zero
client-side JavaScript** and makes **no runtime network fetch**.

Supporting decisions:

- **Single theme-agnostic palette, not a light/dark pair.** Starlight toggles
  color modes with a `data-theme` attribute (a manual toggle), while
  `rehype-mermaid`'s dark-mode support emits a `<picture>` element that keys off
  the OS `prefers-color-scheme`. Those two signals desync (OS light + manual dark
  → wrong diagram). We therefore render a *single* `base`-theme diagram with a
  design-system palette engineered to read on both the light (`#ffffff`) and dark
  (`#17181c`) page bodies: filled indigo nodes (`#3b5bdb`) with white labels, and
  neutral gray-3 edges (`#8b90a0`, the same hex in both modes). This is the same
  both-modes-legible constraint as the 2026-07 dark-contrast sweep (issue #1638).
- **Two defensive CSS overrides** in `custom.css` (no client JS): pin Mermaid's
  near-black baked arrowhead fill (`#0b0b0b`, invisible on the dark body) to the
  neutral edge color, and center + shrink the SVG on narrow screens.
- **CI runs on the prebuilt Playwright image.** The shared `.website` base is
  `node:22-alpine` (musl libc), on which Playwright's glibc Chromium cannot
  launch. `website:build` and `pages` override to
  `mcr.microsoft.com/playwright:v1.58.2-noble` (pinned by digest), which ships a
  Chromium matching the `playwright` devDependency, so no per-build browser
  download is needed and builds stay deterministic.

## Alternatives Rejected

1. **Client-side Mermaid via CDN / `<script>`.** Avoids Chromium in CI but ships
   runtime JavaScript, delays first paint, harms SEO/indexability (diagrams are
   not in the static HTML), and breaks a strict/offline docs build. Rejected — a
   documentation site should serve static, indexable graphics.
2. **`@mermaid-js/mermaid-cli`.** Also bundles Puppeteer + Chromium, so it carries
   the same browser cost with less integration into the rehype pipeline. No
   savings; rejected in favor of the idiomatic rehype plugin.
3. **`rehype-mermaid` dark/`<picture>` variant.** Keys off OS scheme and desyncs
   from Starlight's manual `data-theme` toggle (see above). Rejected in favor of
   the single both-modes-legible palette.
4. **Keep ASCII diagrams.** The status quo — unmaintainable, non-responsive,
   inaccessible. Rejected.

## Consequences

- Diagrams are authored as text, diffable and reviewable, and render to
  accessible, responsive, JS-free SVG.
- The docs CI image gains a headless Chromium (~200–400 MB) on the two website
  jobs; mitigated by using the prebuilt, digest-pinned Playwright image.
- `rehype-mermaid` and `playwright` are added as `packages/website`
  devDependencies only — they are never part of the product bundle, keeping the
  Apache-2.0 boundary and shipped artifact unaffected.
- The both-modes palette is a fixed constraint: new diagrams inherit it
  automatically; authors should not hand-set per-diagram colors that assume a
  single background.
