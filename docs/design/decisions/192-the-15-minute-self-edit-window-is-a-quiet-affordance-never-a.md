# Rule 192 — The 15-minute self-edit window is a quiet affordance, never a ticking countdown — show Edit only while editable, and let the server be the authority

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Task notes (Issue 740, ADR-0143)*

**The 15-minute self-edit window is a quiet affordance, never a ticking countdown — show Edit only while editable, and let the server be the authority.** An author may edit their own note's body within 15 min of `created_at`; the Edit button renders only when `own note && Date.now() - created_at < EDIT_WINDOW_MS` (`NotesSection`). There is NO live countdown timer (rule against anxiety-inducing chrome) — the affordance simply appears while open and is absent once closed. The client check is convenience only: the server (`NOTE_EDIT_WINDOW_SECONDS`) is authoritative, so a save that races past the window returns 403 and the inline editor surfaces "Couldn't save — the 15-minute edit window may have closed." A set `edited_at` renders a non-anxious `· edited` marker (mirrors the comment pattern). Do not block the save button on the client clock — let the optimistic edit attempt and show the server's verdict.
