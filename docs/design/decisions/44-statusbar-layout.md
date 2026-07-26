# Rule 44 — StatusBar layout

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *UI Harmonization Rules (Issue #44)*

**StatusBar layout** (issue #201 — overrides the old Gantt-legend footer design): 24px height, `bg-neutral-surface-sunken border-t border-neutral-border`, `hidden md:flex`. Three regions left-to-right: (1) live dot (`bg-semantic-on-track`) + `Live · {N} online` count from `useProjectPresence`; (2) `build {sha}` in `.tppm-mono` from the `__BUILD_SHA__` compile-time constant; (3) spacer + status note `{project.name} · {activeView}` in `.tppm-mono`. Hidden on Login (not inside AppShell) and on viewports < 768px.
