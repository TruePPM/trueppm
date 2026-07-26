# Rule 72 — Bar label text uses COLOR.text (#1A1917)

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Visual Design (Canvas)*

**Bar label text uses `COLOR.text` (`#1A1917`)** — `neutral-text-primary` on the light canvas surface. Set via `ctx.fillStyle = COLOR.text`. All color values live in the `COLOR` constant in `GanttRenderer.ts`; never use hex literals in draw functions.
