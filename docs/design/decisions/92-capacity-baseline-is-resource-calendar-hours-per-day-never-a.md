# Rule 92 — Capacity baseline is resource.calendar.hours_per_day — never a fixed 8h/day global

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Resource Utilization View Rules (Issue #22)*

**Capacity baseline is `resource.calendar.hours_per_day` — never a fixed 8h/day global.**
The API returns actual hours computed from the resource's own calendar. The UI divides
`day.hours / resource_calendar_hours_per_day` to compute the fill percentage. Part-time
workers (e.g. 6 h/day) must show 100% at 6 h, not at 8 h. Never hard-code 8 as the
denominator. If `resource.calendar` is null, fall back to `project.calendar.hours_per_day`,
then to 8.0 as a last resort — in that priority order.
