# Rule 90 — Mobile "Add Risk" entry point is a FAB

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Risk Register Rules*

**Mobile "Add Risk" entry point is a FAB** — `fixed bottom-16 right-4 w-14 h-14 rounded-full
bg-brand-primary`. Positioned above the BottomNav rail. Uses `border border-brand-primary-dark`
for elevation affordance (no drop shadow, per rule 1). The FAB opens the bottom sheet.
Tap count to save a minimal risk must be ≤ 4 taps + typing.
