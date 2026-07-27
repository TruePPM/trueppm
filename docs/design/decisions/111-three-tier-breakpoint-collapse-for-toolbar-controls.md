# Rule 111 — Three-tier breakpoint collapse for toolbar controls:

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Toolbar Responsive Rules (Issue #568)*

**Three-tier breakpoint collapse for toolbar controls:**
 - `lg:` (≥ 1024px): all controls visible with full text labels. This is the reference layout — screenshots and design specs target this width.
 - `md:` (768–1023px): secondary controls render icon-only — wrap the label text in `<span className="hidden lg:inline">` so it disappears but the icon and `aria-label` remain. Primary controls keep their short text labels.
 - `< md:` (< 768px): secondary controls disappear from the toolbar entirely and move into the `ToolbarOverflowMenu` (rule 112). Primary controls remain visible with short labels. Never render a standalone secondary control below 768px.
 Use `hidden lg:inline` on label text spans, `hidden md:flex` / `md:hidden` on visibility toggles — the same pattern already enforced on `TopBar` (rule 109).
