# Rule 68 — ARIA grid uses roving tabindex

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Accessibility*

**ARIA grid uses roving tabindex.** The focused `gridcell` has `tabIndex={0}`;
all others have `tabIndex={-1}`. When the focused row scrolls out of the
virtualised window, `engine.scrollToDate()` is called before `.focus()`.
Keyboard navigation (ArrowUp/Down, Enter, Space) is handled in the overlay
component, not in the canvas event listeners.
