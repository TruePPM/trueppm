# Rule 15 — Task list row height

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Gantt-Specific Rules*

**Task list row height**: **28px on a fine pointer, 44px on a coarse pointer.**
The value is owned by `resolveRowHeight()` in
`packages/web/src/features/schedule/scheduleConstants.ts` and reached through the
`ROW_HEIGHT` live binding (non-React consumers: the canvas renderer, the hit
index, the engine's virtualization) or `useRowHeight()` / `useRowMetrics()`
(React consumers, which need the re-render as well as the number). Do not declare
the number anywhere else — see web rule 315 for why a second declaration is a
mis-hit rather than a duplicate.

The bar inset follows from it rather than being declared beside it:
`BAR_TOP_OFFSET = (ROW_HEIGHT - BAR_HEIGHT) / 2`, which is the historical 5 at
28px and 13 at 44px, so a bar stays centered in its row at both heights. Bar
heights themselves are unchanged — see rule 14.

> **Superseded 2026-08-22 (#2997).** This record previously read "28px fixed —
> required for scroll sync with SVAR's internal row height", and both halves had
> gone stale. The schedule has not rendered through SVAR since the custom canvas
> renderer landed (`features/schedule/engine/`), so the stated *reason* named a
> dependency that is no longer in the tree; and "fixed" is now wrong outright,
> because the row grows to the 44px touch floor on a coarse pointer (web rule 5,
> WCAG 2.5.5). The constraint that is real, and that the SVAR claim was standing
> in for, is that **the DOM outline and the canvas must agree on the pitch to the
> pixel** — they lay out row *n* independently, and when they disagree the only
> symptom is that taps land on the wrong task.
