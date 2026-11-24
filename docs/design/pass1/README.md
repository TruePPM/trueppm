# TruePPM Redesign — Pass 1 (design source)

Decoded from the Claude Design project "TruePPM Redesign Pass 1"
(https://claude.ai/design/p/e01d4825-057d-4096-827b-67d2d6c3c3fd) on 2026-10-31.
Self-contained: open `index.html` in a browser. Fonts and the Lucide icon set load
from their CDNs; everything else is in this folder.

What it specifies, and where each part landed (status as of 2026-11-24):

| File | Contents | Status |
|---|---|---|
| `p1/p1-system.js` | Token sheet (`P1.TK`), shell notes | Shipped as `--p1-*` in `globals.css` + the `p1` Tailwind namespace (#4742, ADR-1298). Dark tints run at 10% rather than the design's 16% — see the ADR. |
| `p1/p1-kit.js` | Rail, top bar, status slot, context header, `scurve`, `heat`, sample people/projects | Rail / top / slot / ctx shipped in `features/shell2/` (#4742). `scurve` shipped as the PM home's forecast hero (`homes/ProgramForecastHero.tsx`, #4769). `heat` is the 13-week heat grid in #4802 (open) and the Resource Manager home's team load in #4770 (open). |
| `p1/p1-homes.js` | Contributor, PM, Resource Manager, Executive homes; shell annotation frame | #4755 (closed). Contributor home #4768 and PM home #4769 shipped in `features/shell2/homes/`. Resource Manager home #4770 and Executive home #4771 are open. |
| `p1/p1-phones.js` | Phone Contributor home, quick-log sheet, Executive sponsor view, project header | The homes' phone layouts ride with #4768–#4771. Quick-log sheet: #4762 (open; `features/shell2/QuickLogSheet.tsx` exists). |
| `p1/p1.css` | Layout and component styles for the frames | Reference only; the app's styles are Tailwind on the `p1` tokens. |

Departures from this design that are deliberate are recorded in ADR-1298 "Consequences"
(44px targets, tint alpha, focus-ring token, 44px tabs, `focus:` on the phone lens
switcher). Where this folder and the shipped code disagree, the code and the ADR win;
this folder is the record of what was proposed.

`index.html` keeps the `data-omelette-injected` style and script tags that the Claude Design export adds. They are viewer tooling, not part of the design.
