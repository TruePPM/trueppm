# Rule 160 — The sprint-timeline selected-card ring is navy, never sage (rule 83/146 corollary)

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Program visual identity & wayfinding (Issue #963)*

**The sprint-timeline selected-card ring is navy, never sage (rule 83/146 corollary).** `SprintTimelineStrip`'s selected card uses `ring-2 ring-navy-700 ring-offset-1 dark:ring-reversed` — NOT `ring-brand-primary` (which resolves to sage). The active card carries a sage on-track tint (`bg-semantic-on-track-bg`) + a sage progress fill, so a sage selection ring would put two sage meanings on one surface (action/positive + selected), a WCAG 1.4.1 hue-only collision. Selection = navy ring; active-but-unselected = the faint sage `ring-brand-primary/30` tint; the two never share hue. Same rule that keeps the canvas selection ring navy (rule 83), extended to the sprint-card selector (#567 ux-review).
