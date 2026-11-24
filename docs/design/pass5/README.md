# TruePPM Redesign — Pass 5 (design record)

A static render of the Claude Design canvas "TruePPM Redesign Pass 5" as of 2026-11-24
(canvas Version 37). Open `index.html` in a browser: every frame is plain HTML and CSS, with no
script, and fonts load from Google Fonts. Click a frame's title to open it at full size.

The tracking issue is #5122. It maps every section to its issues and lists each decision and
open question.

| Section | Frames | Issue(s) |
|---|---|---|
| 0 Overview + decisions | `frames/Main.html` | #5122 |
| 1 Role-seeded view composition | `frames/S1-*` (1A seed, 1B More and settings, 1C lens change, 1D phone, notes) | #3715, #4888 |
| 2 Layout toggles + More | `frames/S2-*` (2A Plan, 2B Deliver, 2C phone, notes) | #3887 |
| 3 Baseline amend loop | `frames/S3-*` (3A draft and Commit plan, 3B amend, 3C Review, 3D after and trail, notes) | #3150, #4813, #5121 |
| 4 Phone rebaseline | `frames/S4-*` | #3150, #4813 |
| 5 Phone gap check | `frames/S5-*` | #3122, #4849, #2132, #3345, #4814, #4801 |
| Chrome rows (Q8.1) | `frames/Main.html` | #4502 |

Each light frame has a `-dark` twin rendered in the dark theme.

## Layout

- `index.html`: every frame, grouped by canvas page, as scaled previews.
- `frames/`: one static page per artboard.
- `css/p4-shared.css`: the Pass 4 shared stylesheet (Pass 1 tokens, with dark tints at 10% per ADR-1298). `css/p5.css` is the small Pass 5 supplement, with no new color tokens.
- `source/`: the canvas's own files (`canvas.json` and `*.dc.html`). They reference the canvas runtime (`./support.js`) and the stylesheets by their canvas asset paths (`/_blob/…`), so they don't open on their own. `source/render-dc.js` re-renders them: `node source/render-dc.js source <outDir>`, then copy `css/` beside the output.

## What wins

Where this record and an issue differ, the issue wins for scope and acceptance. For the amend
interaction, #3150's decisions D9–D11 win, and the frames were redrawn to them. Where the
shipped code differs, the code and its ADR win. This folder is the record of what was designed,
not a specification that tracks later changes.

Items in the notes marked "surfaced by a simulated panel" came from modeled voice-of-customer
personas, not user research.
