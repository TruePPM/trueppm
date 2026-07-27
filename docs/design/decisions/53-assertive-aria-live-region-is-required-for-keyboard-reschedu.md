# Rule 53 — Assertive aria-live region is required for keyboard reschedule

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Keyboard Reschedule Rules (Issue #34)*

**Assertive aria-live region is required for keyboard reschedule** — a second
`aria-live="assertive"` region (`ariaAssertiveRef` in `GanttView`) must announce each
nudge immediately: `"{N} working day{s} later/earlier"` or `"Back to original start date"`.
Confirm announces `"Reschedule confirmed."`, cancel announces `"Reschedule cancelled."`,
mode-entry announces the task name and key legend. The existing polite region
(`ariaLiveRef`) continues to handle milestone slip messages. Never merge assertive and
polite into one region — the polite queue delay makes nudge feedback unintelligible.
