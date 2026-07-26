# Rule 89 — Risk detail opens as a drawer (desktop) / bottom sheet (mobile) — not a modal

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Risk Register Rules*

**Risk detail opens as a drawer (desktop) / bottom sheet (mobile) — not a modal** —
a drawer keeps the risk list visible while a user references WBS numbers to fill in
linked tasks. A full-screen modal blocks this context. On mobile (< 768px), use a
bottom sheet (85vh, drag handle, `role="dialog" aria-modal="true"`). On desktop
(≥ 768px), use a right-side slide-in drawer (480px wide).
