# Rule 462 — On shell v2 the settings save bar names what changed, and archiving is confirmed by typing

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Settings*. The index carries the rule's headline; this file carries its full text (#4800).

**Under `shell_v2`, the settings save bar renders only while a section is dirty, on `p1` surface tokens (not a brand fill), and its message names the dirty sections ("Unsaved changes in General and Members"). Cmd/Ctrl+S saves, and every in-app exit that would drop edits goes through `ConfirmDiscardDialog`, never `window.confirm`. Archiving a project asks for its code and states the consequence; the zone itself keeps the danger treatment (rule 441).**

**Why.** "You have unsaved changes" on a page of eight sections does not say which section to look at. A typed confirmation on archive is the same friction the delete card already has, applied to the action the design called out.

**How to apply.** Gate v2 styling on `useFeatureFlag('shell_v2')` inside the shared primitives (`SettingsShell`, `FieldRow`, `Toggle`) so every settings page inherits it and the flag-off path stays byte-for-byte v1. Reference: `src/features/settings/SettingsShell.tsx`.
