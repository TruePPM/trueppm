# Rule 69 — buildTaskAriaLabel(task) format is canonical:

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Accessibility*

**`buildTaskAriaLabel(task)` format is canonical:**
`"{name}, {durationDays} days, starts {start}, finishes {finish}, {CP status}"`
e.g. `"Design sprint, 10 days, starts Apr 7, finishes Apr 18, on the critical path"`.
Used as `aria-label` on the focused gridcell. The canvas bar is `aria-hidden`.
