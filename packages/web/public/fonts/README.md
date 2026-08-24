# Vendored web fonts

These `.woff2` files are the app's three typefaces, served from this origin.
**Nothing here is fetched from a third party at runtime** — that is the point.

## Why they are vendored

TruePPM is sold on being self-hosted and air-gapped-capable, and #2392's feedback
design is built on the rule that *a self-hosted, air-gapped-capable product does
not get to phone home*. `packages/web/index.html` used to load the type from
`fonts.googleapis.com`, which meant two things nobody had signed up for (#2419):

1. **Every page load emitted a third-party request** from the end user's browser,
   carrying their IP and referrer — undisclosed anywhere in `packages/website/src/content/docs/administration/`.
   In some regulated environments that alone is a deployment blocker.
2. **Air-gapped and network-restricted installs got degraded typography.** The
   `@font-face` request failed, the browser silently substituted a fallback, the
   design system's whole type scale rendered in the wrong face, and no warning
   ever reached the operator.

An E2E assertion in `e2e/self-hosted-fonts.spec.ts` fails the build if a
third-party font request comes back.

## What is here

| Family | Role | Weights | Subsets | Upstream |
| --- | --- | --- | --- | --- |
| Space Grotesk | Display / wordmark | 400, 500, 600, 700 | latin, latin-ext, vietnamese | `spacegrotesk/v22` |
| Inter | UI / body | 400, 500, 600, 700 | latin, latin-ext, vietnamese, greek, greek-ext, cyrillic, cyrillic-ext | `inter/v20` |
| JetBrains Mono | Data / tabular | 400, 500 | latin, latin-ext, vietnamese, greek, cyrillic, cyrillic-ext | `jetbrainsmono/v24` |

16 files, ~325 KB total on disk. **Every subset Google served is vendored**, so no
script silently loses its typeface — a task named in Cyrillic renders the same as
one named in English. Because the `unicode-range` split is preserved in
`src/styles/fonts.css`, a Latin-only page still downloads only the Latin slices
(~102 KB), so self-hosting costs nothing on the wire.

Weights share a file within a subset: these are variable fonts sliced by range,
which is upstream's own arrangement.

## Licenses

All three are **SIL Open Font License 1.1**, which expressly permits
redistribution — including bundled with an application, and including inside a
proprietary product. The full texts are alongside the fonts:

- `LICENSE-Space-Grotesk.txt` — Copyright 2020 The Space Grotesk Project Authors
- `LICENSE-Inter.txt` — Copyright 2020 The Inter Project Authors
- `LICENSE-JetBrains-Mono.txt` — Copyright 2020 The JetBrains Mono Project Authors

OFL 1.1 §5 forbids selling the fonts *on their own* and reserves the Reserved
Font Names; neither constrains shipping them as part of TruePPM. Do not rename a
vendored file to a Reserved Font Name variant.

## Regenerating (new weight, new family, upstream update)

`src/styles/fonts.css` is **generated** — do not hand-edit it. It is the Google
Fonts `css2` response reproduced verbatim with the URLs repointed at `/fonts/`,
which is what makes an online install render byte-identically to before.

1. Edit the `css2` query below to the families/weights you need, then fetch it
   with a modern browser User-Agent (an old UA gets `.ttf` instead of `.woff2`):

   ```bash
   curl -sS -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
   AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" \
     "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" \
     -o /tmp/gf.css
   ```

2. For each `@font-face` block, save its `woff2` to
   `packages/web/public/fonts/<family-slug>-<subset>.woff2` (the subset name is in
   the `/* … */` comment directly above the block) and re-emit the block with
   `src: url('/fonts/<that file>')`, keeping `font-weight`, `font-style`,
   `font-display`, and `unicode-range` exactly as upstream sent them.

3. Update the table above with the new `<family>/vNN` upstream versions (they are
   in the gstatic URLs), refresh the license files if a family was added, and run
   `npx playwright test e2e/self-hosted-fonts.spec.ts`.
