# Rule 51 — Keyboard instruction strip is mandatory during keyboard reschedule

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Keyboard Reschedule Rules (Issue #34)*

**Keyboard instruction strip is mandatory during keyboard reschedule** — render
`"← → Shift+arrow · d date · Enter confirm · Esc cancel"` in the `PreviewOverlay`
instruction strip when `isKeyboardMode` is `true`. The mouse-drag strip `"Esc to cancel"`
must remain unchanged (rule 28). Both are `aria-hidden="true"` — the assertive aria-live
region (rule 53) carries the accessible equivalent.
