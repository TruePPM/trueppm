# Rule 134 — Backlog chips differ from To Do chips by a 2px dashed left edge + a readiness label, never color alone

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Schedule Backlog-Promote Rules (Issue #318)*

**Backlog chips differ from To Do chips by a 2px dashed left edge + a readiness label, never color alone.** `UnscheduledTaskRow` takes a `variant: 'todo' | 'backlog'` prop. The backlog variant adds `border-l-2 border-dashed border-neutral-border` (the at-a-glance cue that a drop **promotes** BACKLOG → To Do, not merely schedules) plus a readiness label reusing the `BacklogBand` ReadinessChip semantics (idea / estimated / ready / baselined) — the text label is the WCAG 1.4.1 non-color signal (rule 107). Idea-readiness rows render the name `italic text-neutral-text-secondary`. To Do chips carry no dashed edge.
