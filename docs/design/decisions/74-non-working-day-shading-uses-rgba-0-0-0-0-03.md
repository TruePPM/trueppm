# Rule 74 — Non-working day shading uses rgba(0,0,0,0.03)

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Visual Design (Canvas)*

**Non-working day shading uses `rgba(0,0,0,0.03)`** — a very subtle dark overlay on weekend columns on the light canvas. Applied on `canvas-bg`, not recalculated during drag.
