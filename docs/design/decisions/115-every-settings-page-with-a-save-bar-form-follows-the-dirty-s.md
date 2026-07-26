# Rule 115 — Every settings page with a save-bar form follows the dirty/save/discard contract

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Settings Shell Save Contract (Issue #536)*

**Every settings page with a save-bar form follows the dirty/save/discard contract.** Two paths:
 - **API is wired**: the page MUST call `useDirtyForm({ values, initialValues, onSave, onReset, apiReady: true })` from `src/features/settings/hooks/useDirtyForm.ts`. The hook publishes the page's dirty state to `useSettingsSaveStore`, which `SettingsShell` reads to render the save bar, the `ConfirmDiscardDialog`, the `beforeunload` listener, and the `Ctrl/Cmd+S` save shortcut. Pages keep their own `useState` per field — `useDirtyForm` does not own field state, only observes a `values` / `initialValues` pair via `JSON.stringify` compare.
 - **API not yet wired (stub page)**: the page MUST wrap its content in `<StubFieldset disabled>` from `src/features/settings/components/StubFieldset.tsx`. The `<fieldset disabled>` disables every form control and the `.settings-stub :disabled` CSS rule in `globals.css` applies the visual treatment. When the page's API ships (typically one of #517–#530), flip from `<StubFieldset>` to `useDirtyForm({ apiReady: true })`.

 Pages with row-level mutations and no save-bar (e.g. `WorkspaceMembersPage`, `WorkspaceGroupsPage`, `ProjectIntegrationsPage`, `ProjectAccessPage`, `ProgramAccessPage`, `ProgramProjectsPage`) and danger-zone pages with typed-confirm flows (`WorkspaceDangerPage`, `ProjectArchivePage`, `ProgramArchivePage`) are exempt — they don't have a save-bar UI surface.
