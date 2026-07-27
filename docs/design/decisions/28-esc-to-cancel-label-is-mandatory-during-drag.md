# Rule 28 — "Esc to cancel" label is mandatory during drag

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Drag Preview Rules (Issue #19)*

**"Esc to cancel" label is mandatory during drag** — render a small `aria-hidden="true"` label adjacent to the dragged bar. Remove on pointerup or Escape.
