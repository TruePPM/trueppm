# Rule 112 — ToolbarOverflowMenu is the shared overflow container for all views

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Toolbar Responsive Rules (Issue #568)*

**`ToolbarOverflowMenu` is the shared overflow container for all views** — do not implement a per-view overflow popover. Import from `src/components/toolbar/ToolbarOverflowMenu.tsx`. The trigger is `<button aria-label="More options" aria-haspopup="menu">` rendering `⋯`. The popover is `role="menu"` with one `role="menuitem"` per secondary action or `role="menuitemcheckbox" aria-checked={…}` per secondary toggle. The overflow button is rendered only below `md:` (`md:hidden`); it must not appear at `lg:`. Keyboard: `ArrowDown`/`ArrowUp` navigate items; `Enter`/`Space` activate; `Escape` closes and returns focus to the trigger.
