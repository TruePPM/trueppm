# ADR-0277: Risk-on-border bars, overdue markers, and an expanded legend for the schedule PDF export

## Status
Accepted

## Context
The Schedule → **Export PDF** report (ADR-0188; pagination ADR-0276) colored each task
bar's **fill** by its risk band (critical red / at-risk amber / on-track green) and then
painted a **green progress fill** over the left `%complete` of that bar. Product review of
a real export surfaced four problems:

1. **The critical path disappeared on completed work.** Because the green progress fill is
   sized to `%complete` and drawn *over* the risk fill, a 100%-complete critical task
   rendered as a solid green bar — the red critical base was entirely masked. On a schedule
   that is mostly done (e.g. 14 of 19 tasks complete) nearly every bar reads green and the
   critical path is invisible, directly contradicting the KPI strip's "18 critical tasks".
2. **No overdue signal.** A task past its finish and not complete looked identical to any
   other bar.
3. **Milestone met vs pending was color-only** (filled amber vs a different amber), a
   WCAG 1.4.1 failure and the original driver of issue #1686.
4. **The legend explained only four states** and omitted dependency lines, overdue,
   progress, and the data-date line, so several marks on the sheet were unexplained.

The export is a fixed light-theme document rasterized by `html-to-image` (no
interactivity, no hover), so every meaning must be self-evident on paper and survive
grayscale printing and deutan/protan color-blindness. Red is already reserved for the
critical path (ADR-0063 rule 75 keeps dependency arrows charcoal for the same reason), so
it cannot also be the sole carrier of "overdue".

## Decision
Adopt one firewall for the whole surface: **hue encodes the worst risk band; texture/shape
encodes the redundant, grayscale-safe signal.** Concretely:

- **Risk lives on the bar border, progress lives in the fill.** The risk band drives the
  bar's **border** (critical = 2px `semantic-critical`; at-risk = 2px `semantic-at-risk`;
  on-track = 1px `neutral-text-secondary` hairline), and the interior keeps the green
  (`semantic-on-track`) progress fill. A completed critical task is therefore a green bar
  in a red frame — the critical signal can never be masked by completion. Critical is
  backed non-color by the existing row-label red dot and the Critical-Path-Chain list
  (WCAG 1.4.1); the 2px border clears WCAG 1.4.11 (≥3:1) against the white sheet.
- **"Behind schedule" is a diagonal hatch overlay** (`repeating-linear-gradient` of 1px
  neutral-ink lines) composed over any border color, so a critical-and-slipping bar reads
  as a red frame with a hatch. The hatch is the grayscale/deutan carrier of "slipping"
  (`isBehind` is kept as its own row flag because a critical bar's band is `critical`,
  which would otherwise hide that it is also behind).
- **Overdue is a shape, not a fourth hue.** A task past its finish and not complete gets a
  red past-due flag at its finish edge plus a dashed red overrun tail to the data date. A
  pending milestone past its date becomes a hollow **red-outlined** diamond with a `!`.
- **Milestone met vs pending is a shape cue** (filled vs hollow diamond), resolving the
  #1686 color-only gap. Both diamonds are **outlined in navy**, not amber: the static
  `brand-accent` (#E8A020) is only ~2.2:1 on white (below WCAG 1.4.11), so it is the fill
  only, never the sole boundary of the mark.
- **Faint round-dotted row leaders** connect each activity label to its bar. They are made
  unmistakably distinct from dashed *soft* dependency arrows on three axes: dot pattern
  (round `0.5/4` vs square `3/2`), weight/color (faint `neutral-border` 0.75px vs darker
  `neutral-text-secondary` 1px), and zone (the label→bar gutter vs bar→bar connectors).
- **The legend is regrouped into Bars / Links / Markers** (12 entries), each swatch
  rendering its actual treatment so the legend itself is grayscale-legible; a small sage
  pill labels the data-date line.
- **Pagination gains a reserved footer band** (`RESERVED_FOOTER_PT`) that hosts a hairline
  "content ends here" rule, a centered "continued on next page" caption on every non-final
  page, and the existing "Page n of N" counter — which used to collide with content that
  ran to the page edge. The vertical planner also keeps the Critical-Path-Chain card whole
  when it fits a page and avoids stranding fewer than three Gantt rows on a continuation
  page (a widow/orphan guard, not a rescale — the fixed print scale is deliberate).

The alternative considered was a **solid-fill** model (solid-red critical bars, drop green,
progress as a neutral density wash — the MS-Project convention). It was rejected by the
product owner in favor of the border model, which preserves the green progress signal and
puts *less* red ink on the page (only a thin frame, not a whole fill), so the red critical
chain still reads first without red/green overload.

## Consequences
- SVG strokes/fills for the leaders, overrun tails, and flags are set via inline `style`
  CSS-vars, never Tailwind `stroke-`/`fill-` classes (ADR-0276 / web-rule 232), and the
  hatch is a `background-image` gradient — all rasterize reliably under `html-to-image` and
  stay clear of the design-system-v2 hex gate.
- The `schedulePrintTheme` role→token contract keeps `barFillClass` (now used only by the
  live-canvas parity mapping and tests); the bar surface uses the new `barBorderClass`,
  `hatchBackgroundStyle`, and `milestoneDiamondClasses`.
- The multi-page report is one to a few pages taller in edge cases because of the reserved
  band and orphan control; this is intentional and unit-tested in `scheduleVerticalPlan`.
- Recorded as web-rule 234; supersedes the milestone met/pending color-only treatment noted
  in #1683's follow-up (#1686).
