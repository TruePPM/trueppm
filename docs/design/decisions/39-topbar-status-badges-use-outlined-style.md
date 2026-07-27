# Rule 39 — TopBar status badges use outlined style

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *UI Harmonization Rules (Issue #44)*

**TopBar status badges use outlined style** — `bg-transparent border border-{semantic-color}/40 rounded px-2 py-0.5 text-xs`. Badge labels include the full semantic word: `{n} at risk`, `{n} critical`, `P80: {date}`. Labels must also specify scope (tasks vs. projects) — ambiguous counts are a PMO compliance risk. `aria-label="{n} at risk tasks"` or `"{n} critical tasks"`. At-risk and critical badges are `<button aria-haspopup="menu">` elements — NOT `listbox` (listbox implies selection, not navigation). They open a `role="menu"` popover with `role="menuitem"` task entries.
