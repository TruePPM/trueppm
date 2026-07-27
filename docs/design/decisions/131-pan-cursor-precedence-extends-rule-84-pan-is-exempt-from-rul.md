# Rule 131 — Pan cursor precedence extends rule 84; pan is exempt from rule 70

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Schedule View Interaction Rules (Issues #351 / #491)*

**Pan cursor precedence extends rule 84; pan is exempt from rule 70.** In `_updateCursor`: `_panning` → `grabbing` (whole canvas) > `_panArmed` (Space held) → `grab` (whole canvas, overrides hit-zone cursors) > existing drag/hit-zone logic. Space-arming is scoped to canvas hover/focus (`_canvasHovered`) — never a global Space capture (which would break Space on buttons, checkboxes, and page scroll) and never inside an editable target. Pan is direct 1:1 manipulation with **no momentum/inertia**, so it is exempt from `prefers-reduced-motion` (there is no animation to suppress; do not add inertia without gating it on rule 70). A pan release suppresses the synthetic `contextmenu` once so middle/right-drag never opens the context menu.
