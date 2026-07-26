# Rule 40 — Schedule view adapts to color scheme

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *UI Harmonization Rules (Issue #44)*

**Schedule view adapts to color scheme** — in light mode the task-list panel and canvas use `bg-neutral-surface` (#FFFFFF); in dark mode they use the dark navy surface (#15223C, ADR-0103). The canvas renderer switches palettes via `setRendererColorMode(isDark)` called from `GanttEngineImpl` before each paint pass. `CanvasGanttTimeline` derives `isDark` from `useThemeStore` and passes it to `useGanttEngine`. `COLOR` (light) and `COLOR_DARK` (dark) palettes in `GanttRenderer.ts` are the canonical color sources; no hex literals in component files.
