# Rule 81 — Initial viewport: today at 25% from left — but verify the result, and fit the project instead when framing on today would open on empty canvas (#2423)

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Performance*

**Initial viewport: today at 25% from left — but verify the result, and fit the
project instead when framing on today would open on empty canvas (#2423).**
Set `container.scrollLeft` so today lands at 25% of the viewport width from the
left edge; that provides immediate context without centering (which would hide
near-term tasks). The reasoning holds only while the project's mass straddles
today, and fails whenever it sits well behind — the normal state of any project
past its midpoint. On the seeded demo project it put the viewport at W28/July
for work starting April 15, so nine of the first fourteen rows opened with no
bar and the flagship view read as broken rather than as scrolled. So the offset
is now **checked before it is applied**: compute the share of initially-visible
*bar-carrying* rows that would land in frame, and when it falls below
`MIN_FRAMED_BAR_COVERAGE` (0.6), call `engine.fitToProject()` instead. Rows with
no bar are excluded from the ratio — no scroll offset can bring an unscheduled
task into frame, so counting it would drag the ratio down for a reason framing
cannot fix — and when *no* row has a bar the today framing stands, since fitting
has nothing better to offer. Rule 81's original case is preserved by an
**explicit gate, not by coverage**: the fallback is considered only when some
visible bar starts *behind* today, so a project entirely ahead of today always
frames on today. Coverage alone would not have preserved it — at default zoom a
viewport spans roughly ten weeks, so a project starting more than ~8 weeks out
scores zero coverage and would have been fitted, zooming out over months of
nothing before its start for a reason unrelated to the defect. Only mass behind
today opens on canvas the user cannot scroll to. (That ten-week span also means
"today at 25% from the left" already *is* the `[today − 2wk, today + 8wk]`
window intersected with the project extent.) The decision is a pure function
(`computeInitialFraming` in `scheduleUtils.ts`) so it is unit-tested without a
canvas; the framing still runs in the `scheduleScales`-gated once-per-project
effect, never on engine `ready` (that is the #2004 race — the scroll spacer has
not reached full width yet, so the browser clamps the assignment to 0).

**The one-shot flag must be set on every decision, including the no-op one.**
The effect depends on `visibleTasks` (it needs the bars), so it re-runs as data
arrives. Its readiness guards — spacer not sized, no tasks yet — return while
leaving it *armed*, because those are "too early to decide", not decisions. Once
past them, every outcome disarms it before acting, `'none'` included. Returning
early from a real decision without disarming is what let a late
`engine.fitToProject()` fire after the user had already zoomed and silently
reset their viewport — two `schedule.spec.ts` specs caught exactly this.
