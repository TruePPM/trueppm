# Rule 8a — `--chrome-*` tokens are for fixed UI furniture

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Color and tokens*. The index carries the rule's headline; this file carries its full text (#3744, ADR-0653 amendment). Binding everywhere, not only on the surface that produced it.

**`--chrome-*` tokens are for fixed UI furniture** (sidebar, Schedule task-list panel, TopBar) that follows the active theme. `--neutral-*` tokens are for page content surfaces. Use `bg-chrome-surface` on shell chrome, `bg-neutral-surface` on content areas. Both adapt with the `.dark` class on `<html>`. In dark mode `--chrome-surface` equals the legacy `gantt-surface` deep navy (#0F1117). Chrome tokens: `surface`, `surface-raised`, `border`, `text-primary`, `text-secondary`, `row-hover`, `row-active`, `grid`.
