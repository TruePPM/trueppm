# Rule 61 — Row virtualisation is mandatory — always

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Canvas Rendering*

**Row virtualisation is mandatory — always.** The renderer only paints rows
whose `top` falls within `[scrollTop - overscan, scrollTop + viewportHeight + overscan]`
where `overscan = 5 rows`. This must hold from the first commit — never paint
all rows and optimise later. Phase 1 (≤500 tasks) and Phase 2 (2,000 tasks)
use the same virtualisation path.
