# Rule 173 — Inline contextual prompts are page content, not modals

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Inline contextual prompts (Issue #1181, ADR-0129)*

**Inline contextual prompts are page content, not modals.** A first-login/onboarding prompt that mounts inline (e.g. `LandingPrimaryUsePrompt`) uses `<section aria-label="…">`, never `role="dialog"`/`aria-modal`, no focus trap, no auto-focus. Animate-out is `motion-safe:transition-opacity` paired with an explicit `opacity-0` state applied before the unmount timeout (`motion-safe:opacity-0` driven by a `saved` flag in state). Skip/dismiss sets a localStorage flag only; it does not `navigate()`.
