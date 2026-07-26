# Rule 82 — "Today" button in toolbar

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Performance*

**"Today" button in toolbar** — a `type="button"` element with the same style
as ZoomControl buttons (rule 42): `border border-neutral-border rounded h-7 px-3
text-xs font-medium`. Calls `engine.scrollToDate(todayIso, 'smooth')` (or
`'instant'` when `prefers-reduced-motion` is active, rule 70). Placed to the
left of the ZoomControl in the toolbar.
