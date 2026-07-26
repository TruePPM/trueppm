# Rule 114 — ScheduleToolbarToggle and any new toggle button accept a hideLabel prop

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Toolbar Responsive Rules (Issue #568)*

**`ScheduleToolbarToggle` and any new toggle button accept a `hideLabel` prop.** When `hideLabel={true}`, the text label is omitted from the render; the button still carries `aria-label` and `title` matching the full label text. Used by the `md:` tier (rule 111) to switch secondary toggles to icon-only mode. Do not add a new size variant to the design system for this — the existing `h-7 px-3 text-xs font-medium` sizing is retained in both modes.
