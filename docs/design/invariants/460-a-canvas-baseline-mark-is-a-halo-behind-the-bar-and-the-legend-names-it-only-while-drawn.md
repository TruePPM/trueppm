# Rule 460 — A canvas baseline mark is a halo behind the live bar, and the legend names it only while it is drawn

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md). The index carries the headline; this file carries the full text (#3821).

**The active baseline's ghost bar is a hollow outline (`ghostFill` / `ghostBorder`, the tokens that already carry the #2207 contrast fix and the forced-colors `Canvas`/`GrayText` mapping) painted BEHIND the live bar and bleeding `BASELINE_GHOST_BLEED` px above and below it.** It is not a second bar underneath: at the 28px fine-pointer row there are ~4px below the bar and the actual-date overlay already owns them. The mark is carried by outline vs fill, never by color alone (WCAG 1.4.1), and a baseline that equals the live bar is correctly nearly invisible.

**The control and the legend row exist only while there is something to draw.** "Baseline bars" is a Display-menu `menuitemcheckbox` in the Chart section, offered only when the project has an active baseline (an inert checkbox is a control that lies), and the legend's "Baseline (planned)" row renders only while the canvas is drawing it — a legend names marks that are on screen. Baseline x positions come from the memoized date→x map (#1539); no date is parsed per frame.
