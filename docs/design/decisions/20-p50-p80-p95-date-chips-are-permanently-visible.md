# Rule 20 — P50 / P80 / P95 date chips are permanently visible

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Monte Carlo Row Rules*

**P50 / P80 / P95 date chips are permanently visible** in the `MonteCarloTimeline` row — outlined style (`bg-transparent border border-{semantic}/40 text-{semantic}`), not fill. Hover or keyboard-focus opens the detailed histogram tooltip; chip text is the WCAG 1.4.1 fallback so colour is never the sole signal.
