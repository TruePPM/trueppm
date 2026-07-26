# Rule 35 — Sidebar background is bg-chrome-surface

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *UI Harmonization Rules (Issue #44)*

**Sidebar background is `bg-chrome-surface`** — the adaptive chrome token (warm off-white in light mode, deep navy in dark mode via CSS custom properties). `bg-brand-primary` is reserved for interactive elements (buttons, focus rings, active accents) — never large-area backgrounds.
