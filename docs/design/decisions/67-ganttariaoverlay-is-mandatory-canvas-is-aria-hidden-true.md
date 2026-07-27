# Rule 67 — GanttAriaOverlay is mandatory — canvas is aria-hidden="true"

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Accessibility*

**`GanttAriaOverlay` is mandatory — canvas is `aria-hidden="true"`.**
A transparent DOM layer (`position: absolute; inset: 0; pointer-events: none`)
provides the WCAG 2.1 grid structure over the canvas. Structure:
`role="grid"` > `role="row"` > `role="gridcell"`. The overlay is virtualised
to match the canvas render window. Canvas elements have no ARIA attributes.
