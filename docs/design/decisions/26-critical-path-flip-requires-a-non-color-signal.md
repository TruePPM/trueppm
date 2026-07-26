# Rule 26 — Critical-path flip requires a non-color signal

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Drag Preview Rules (Issue #19)*

**Critical-path flip requires a non-color signal** — a "CP" badge (min 400ms) must accompany the `semantic-critical` border change. Color alone fails WCAG 1.4.1.
