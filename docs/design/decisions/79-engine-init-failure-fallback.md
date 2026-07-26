# Rule 79 — Engine init failure fallback

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Performance*

**Engine init failure fallback** — `GanttFallbackTable` renders a plain `<table>`
when `canvas.getContext('2d')` returns null (e.g. headless test environments or
very old browsers). Shown instead of the canvas timeline; not a degraded mode —
all task data is accessible. Check support once at startup, not per frame.
