# Rule 52 — Origin ghost bar is required during keyboard reschedule

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Keyboard Reschedule Rules (Issue #34)*

**Origin ghost bar is required during keyboard reschedule** — show a dashed 2px
`ghost-border` outline bar at the task's pre-nudge start/finish position so the user
has a spatial reference point. Uses `OriginBar` in `PreviewOverlay`; only visible when
`isKeyboardMode` is `true` (SVAR renders its own drag shadow for pointer drags).
Fill is `transparent`; no CP badge; no label. Bar height follows rule 14 (18px).
