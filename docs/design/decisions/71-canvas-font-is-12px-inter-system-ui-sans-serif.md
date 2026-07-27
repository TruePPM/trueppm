# Rule 71 — Canvas font is "12px Inter, system-ui, sans-serif"

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Visual Design (Canvas)*

**Canvas font is `"12px Inter, system-ui, sans-serif"`** — set once at engine
init, not per draw call. Must match Tailwind's `font-sans` stack so canvas
labels are visually identical to the task list text. `ctx.font` is a global
state — reset it after any draw call that changes it.
