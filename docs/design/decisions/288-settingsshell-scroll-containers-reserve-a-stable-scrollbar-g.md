# Rule 288 — SettingsShell scroll containers reserve a stable scrollbar gutter

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Settings Shell Save Contract (Issue #536)*
>
> **Renumbered from 122 to 288.** The source file used `122.` twice — this rule and the disabled-placeholder recipe. Every `rule 122` citation in the codebase means the latter, so that one keeps the number and this one takes the next free one. 286 (#2447) and 287 (#2389) were taken by rules that landed on `main` while this split was open, so the next free number is 288.

**`SettingsShell` scroll containers reserve a stable scrollbar gutter.** Both the sidebar `<nav>` and the content panel `<div>` in `SettingsShell.tsx` carry `[scrollbar-gutter:stable]` alongside `overflow-y-auto`. The shell is the single scroll authority for every settings scope (Workspace/Program/Project) and React Router swaps only the `<Outlet>` content between sub-pages, so without a reserved gutter the scrollbar appears/disappears between a tall sub-page (Program General, Risk policy) and a short one (Projects, Integrations) and shifts the panel ~15px horizontally on platforms with classic scrollbars (#776). Never drop the `[scrollbar-gutter:stable]` utility from these two containers; use `stable` (scrollbar-side only), not `both-edges`, so the left `px-6` content rhythm is preserved. The content container carries `data-testid="settings-content-scroll"`; its gutter is asserted in `SettingsShell.test.tsx` (class present) and `e2e/settings-shell-ux.spec.ts` (computed `scrollbar-gutter === 'stable'`).
