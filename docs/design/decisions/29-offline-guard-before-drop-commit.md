# Rule 29 — Offline guard before drop commit

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Drag Preview Rules (Issue #19)*

**Offline guard before drop commit** — check `navigator.onLine` before PATCH. If offline: skip success animation, clear preview bars immediately, show toast "You're offline — change not saved."
