//! Calendar-aware date arithmetic for the CPM engine.
//!
//! Mirrors the Python `_next_working_day`, `_prev_working_day`,
//! `_finish_from_start`, `_start_from_finish`, and `_working_days_between`
//! functions from `trueppm_scheduler.engine`.

use chrono::{Datelike, Duration, NaiveDate};

use crate::models::{Calendar, DateRange, ExceptionIndex, Project, Task};
use crate::validate::{MAX_CALENDAR_SCAN_DAYS, MAX_PROJECT_SPAN_DAYS};

/// Map each task to the calendar its own date arithmetic should use (ADR-0120 D3).
///
/// Mirrors the Python `_resolve_task_calendars`. Returns `None` when the project
/// declares no per-task `calendars` registry — the signal for the passes to take
/// the single-calendar fast path that is byte-for-byte identical to the
/// pre-ADR-0120 behavior. Otherwise every task resolves to its
/// `Project.calendars[task.calendar_id]` entry, falling back to the pass-level
/// `project.calendar` when `calendar_id` is unset or names no known calendar (a
/// fall-back, not an error — a stray id never breaks a pass).
///
/// The returned vector is indexed by **node position**, which is the same as the
/// task's position in `project.tasks` (the graph adds nodes in task order and the
/// passes carry a dense `Vec<Task>` cloned from it, #1535).
///
/// This map governs a task's *own* arithmetic. Every pass applies the same rule:
/// the node being computed uses its own calendar for all of its arithmetic —
/// duration expansion *and* the snap of every constraint it derives. In the
/// forward pass that node is the successor of its incoming edges (so lag lands on
/// the successor's calendar); in the backward pass and the float pass it is the
/// predecessor of its outgoing edges.
pub fn resolve_task_calendars(project: &Project) -> Option<Vec<&Calendar>> {
    let calendars = project.calendars.as_ref()?;
    if calendars.is_empty() {
        return None;
    }
    Some(
        project
            .tasks
            .iter()
            .map(|t| {
                t.calendar_id
                    .as_ref()
                    .and_then(|id| calendars.get(id))
                    .unwrap_or(&project.calendar)
            })
            .collect(),
    )
}

/// The calendars a CPM pass schedules against: the pass-level one, plus the
/// optional per-node override map (ADR-0120 D3).
///
/// Bundled into one value so each pass takes a single calendar argument rather
/// than a `(calendar, task_calendars)` pair — which also keeps every pass under
/// the clippy `too_many_arguments` bound.
pub struct PassCalendars<'a> {
    default: &'a Calendar,
    per_node: Option<Vec<&'a Calendar>>,
}

impl<'a> PassCalendars<'a> {
    /// Resolve a project's calendars once, before the passes run.
    pub fn resolve(project: &'a Project) -> Self {
        Self {
            default: &project.calendar,
            per_node: resolve_task_calendars(project),
        }
    }

    /// The pass-level calendar (`Project.calendar`).
    #[inline]
    pub fn default_calendar(&self) -> &'a Calendar {
        self.default
    }

    /// The calendar governing node `i`'s own arithmetic.
    ///
    /// No registry, or a node absent from the map, resolves to the pass-level
    /// calendar — which is what keeps the single-calendar path identical.
    #[inline]
    pub fn for_node(&self, i: usize) -> &'a Calendar {
        match &self.per_node {
            Some(cals) => cals.get(i).copied().unwrap_or(self.default),
            None => self.default,
        }
    }
}

/// Ceiling on any single day-by-day working-day walk (#1858).
///
/// For a project that passed [`crate::validate::validate_project`], every date
/// the passes produce lies within the calendar reach of the project start —
/// bounded by the span cap (times 7, for a sparse weekly mask) plus one snap
/// scan — so no legitimate `[lo, hi]` walk can approach this ceiling (~3 M
/// days). A walk that does can only come from *unvalidated* dates (e.g. a
/// mutation path that skipped validation and let `NaiveDate::MAX` reach the
/// float pass); erroring here turns what used to be a multi-second freeze or an
/// overflow panic — which traps the whole WASM module — into a clean `Err`.
const MAX_WORKING_DAY_WALK_DAYS: i64 = MAX_PROJECT_SPAN_DAYS * 8 + MAX_CALENDAR_SCAN_DAYS;

/// Error for a working-day span walk whose bounds exceed
/// [`MAX_WORKING_DAY_WALK_DAYS`] — dates this far apart cannot come from a
/// validated schedule.
fn working_day_walk_error(lo: NaiveDate, hi: NaiveDate) -> String {
    format!(
        "Working-day walk from {lo} to {hi} exceeds {MAX_WORKING_DAY_WALK_DAYS} days; \
         the schedule falls outside the computable date range."
    )
}

/// Build the sorted, coalesced exception index used by [`Calendar::is_working_day`],
/// plus a prefix sum of each run's mask-working-day count (#4176).
///
/// Each `DateRange` becomes an inclusive `[start_ord, end_ord]` pair of
/// proleptic-Gregorian day ordinals; the ranges are sorted and coalesced — not
/// just on overlap/adjacency, but whenever *every* day in the gap between two
/// runs is already excluded by `mask` (e.g. a weekend) — so the result is
/// disjoint and ascending, letting the containment test binary-search instead of
/// scanning every exception per day (#1534). This also subsumes the plain
/// overlap/adjacency case: a zero-or-negative-length gap always has zero
/// mask-working days in it. A "closed until further notice" period written as
/// thousands of weekly Mon-Fri ranges is, once the intervening weekends are
/// accounted for, a single continuous closure, and merging it back into one run
/// is what makes [`Calendar::exception_run`] and [`working_days_between`]'s
/// subtraction cost one step instead of one per week (#4176). An inverted range
/// (`start > end`) matches no day in the original `start <= d <= end` test, so it
/// is dropped here — preserving byte-identical results. Mirrors the Python
/// engine's `Calendar._exception_intervals`.
fn build_exception_index(exceptions: &[DateRange], mask: u8) -> ExceptionIndex {
    let mut ranges: Vec<(i32, i32)> = exceptions
        .iter()
        .map(|e| (e.start.num_days_from_ce(), e.end.num_days_from_ce()))
        .filter(|(s, e)| s <= e)
        .collect();
    ranges.sort_unstable();
    let mut merged: Vec<(i32, i32)> = Vec::with_capacity(ranges.len());
    for (s, e) in ranges {
        if let Some(last) = merged.last_mut() {
            if mask_days_between(last.1 + 1, s, mask) == 0 {
                last.1 = last.1.max(e);
                continue;
            }
        }
        merged.push((s, e));
    }
    let mut prefix = Vec::with_capacity(merged.len() + 1);
    prefix.push(0);
    for &(s, e) in &merged {
        let running_total = *prefix.last().expect("prefix seeded with one element");
        prefix.push(running_total + mask_days_between(s, e + 1, mask));
    }
    (merged, prefix)
}

/// Error raised when a calendar walk cannot reach a working day within the
/// scan bound (the calendar's exceptions blanket the schedule), or when the
/// date arithmetic would overflow `NaiveDate`'s representable range. Mirrors
/// the Python engine's `_scan_for_working_day` guard so the WASM engine
/// returns `Err` instead of panicking on a hostile calendar (#908).
fn calendar_scan_error(anchor: NaiveDate, direction: &str) -> String {
    format!(
        "Calendar has no working day within {MAX_CALENDAR_SCAN_DAYS} days {direction} {anchor}; \
         its exceptions blanket the schedule and it cannot be computed."
    )
}

/// Offset `d` by `days` calendar days with overflow checking (#908).
///
/// The forward, backward, and free-float passes form a raw `predecessor_date ±
/// (1 + lag)` before snapping to a working day. A task whose `planned_start` sits
/// near `NaiveDate`'s representable maximum, combined with a large lag, overflows
/// that addition — which used to panic and trap the entire WASM module. Routing
/// the offset through this checked helper surfaces a clean `Err` to the WASM
/// boundary instead, matching the bounded-scan guard the calendar walks already
/// use.
pub fn checked_offset_days(d: NaiveDate, days: i64) -> Result<NaiveDate, String> {
    d.checked_add_signed(Duration::days(days)).ok_or_else(|| {
        format!(
            "Date arithmetic overflowed: {d} offset by {days} day(s) falls outside the \
             representable calendar range — check the task's start date and dependency lag."
        )
    })
}

impl Calendar {
    /// Returns true if `d` is a working day (in the weekly mask and not an exception).
    ///
    /// The exception test binary-searches a lazily-built, sorted-and-merged index
    /// (memoized on first use) rather than scanning `exceptions` linearly, so the
    /// CPM passes cost O(log X) per day-check instead of O(X) (#1534). The result
    /// is identical to the linear `d >= exc.start && d <= exc.end` test — only the
    /// lookup strategy changed.
    pub fn is_working_day(&self, d: NaiveDate) -> bool {
        // NaiveDate::weekday(): Mon=0 .. Sun=6 (via .num_days_from_monday())
        let weekday_bit = d.weekday().num_days_from_monday();
        if (self.working_days >> weekday_bit) & 1 == 0 {
            return false;
        }
        self.exception_run(d.num_days_from_ce()).is_none()
    }

    /// The merged exception interval containing day ordinal `ord`, as inclusive
    /// `(start, end)` ordinals, or `None`. The snap helpers use it to cross a
    /// whole exception run in one step instead of testing every day in it
    /// (#4161), including across a mask-off-only gap between two
    /// otherwise-separate runs (#4176).
    fn exception_run(&self, ord: i32) -> Option<(i32, i32)> {
        let (ranges, _) = self
            .exception_index
            .get_or_init(|| build_exception_index(&self.exceptions, self.working_days));
        // Rightmost merged range whose start is <= ord; `ord` is an exception iff
        // that range also covers it (ord <= its end).
        let pos = ranges.partition_point(|&(start, _)| start <= ord);
        (pos > 0 && ord <= ranges[pos - 1].1).then(|| ranges[pos - 1])
    }
}

/// O(log span) working-day span counts over a fixed date range (#1534).
///
/// [`working_days_between`] is an O(span) day loop, and `compute_floats` calls it
/// twice per successor link, so the float pass was O((V+E)·span·X). This
/// precomputes the sorted proleptic-Gregorian ordinals of every working day in
/// `[lo, hi]` once (the Rust counterpart to the Python engine's
/// `_WorkingDayCounter`); [`WorkingDayCounter::between`] then counts a span with
/// two binary searches.
///
/// `between(start, end)` reproduces [`working_days_between`] *exactly* — working
/// days in `[start, end)` — as `partition_point(end) - partition_point(start)`
/// (the array holds exactly the working days, so `o < end` excludes `end` and
/// `o < start` includes `start`). The scalar function stays the conformance
/// reference: a span that falls outside the built range falls back to it, so a
/// miscovered range can never silently miscount.
pub struct WorkingDayCounter<'a> {
    ords: Vec<i32>,
    lo_ord: i32,
    hi_ord: i32,
    cal: &'a Calendar,
}

impl<'a> WorkingDayCounter<'a> {
    /// Build a counter covering every working day in the inclusive range spanned
    /// by the tasks' resolved dates (`min early_start` .. `max late_finish`) — the
    /// range every `compute_floats` span query lands in. An empty or inverted
    /// range yields an always-fall-back counter.
    ///
    /// Returns `Err` when the range exceeds [`MAX_WORKING_DAY_WALK_DAYS`] or the
    /// day increment would overflow `NaiveDate` — bounds only unvalidated input
    /// can produce (#1858). The raw `+= Duration::days(1)` here was the last
    /// unchecked date increment left after #908: at `current == NaiveDate::MAX`
    /// it panicked and trapped the whole WASM module.
    pub fn build(tasks: &[Task], cal: &'a Calendar) -> Result<Self, String> {
        let lo = tasks.iter().filter_map(|t| t.early_start).min();
        let hi = tasks.iter().filter_map(|t| t.late_finish).max();
        let mut ords: Vec<i32> = Vec::new();
        let (lo_ord, hi_ord) = match (lo, hi) {
            (Some(lo), Some(hi)) if hi >= lo => {
                if (hi - lo).num_days() > MAX_WORKING_DAY_WALK_DAYS {
                    return Err(working_day_walk_error(lo, hi));
                }
                let mut current = lo;
                while current <= hi {
                    if cal.is_working_day(current) {
                        ords.push(current.num_days_from_ce());
                    }
                    current = current
                        .checked_add_signed(Duration::days(1))
                        .ok_or_else(|| working_day_walk_error(lo, hi))?;
                }
                (lo.num_days_from_ce(), hi.num_days_from_ce())
            }
            // Sentinel empty range: lo_ord > hi_ord forces every query to fall back.
            _ => (0, -1),
        };
        Ok(Self {
            ords,
            lo_ord,
            hi_ord,
            cal,
        })
    }

    /// Count working days in `[start, end)`; identical to [`working_days_between`].
    pub fn between(&self, start: NaiveDate, end: NaiveDate) -> Result<i32, String> {
        if end <= start {
            return Ok(0);
        }
        let s_ord = start.num_days_from_ce();
        let e_ord = end.num_days_from_ce();
        // `[start, end)` counts working days up to `end - 1`; the indexed answer is
        // valid only when the whole span lies inside the built range. Otherwise
        // defer to the scalar reference (defensive — callers stay within span).
        if s_ord < self.lo_ord || e_ord - 1 > self.hi_ord {
            return working_days_between(start, end, self.cal);
        }
        let lo = self.ords.partition_point(|&o| o < s_ord);
        let hi = self.ords.partition_point(|&o| o < e_ord);
        Ok((hi - lo) as i32)
    }
}

/// Return `d` if it is a working day, else the nearest working day in the
/// `forward` direction, within `max_scan` days of `d`.
///
/// Why it jumps instead of stepping (#4161): the CPM passes snap once per
/// dependency edge, and one long exception range (a "closed until further
/// notice" entry just short of `MAX_CALENDAR_SCAN_DAYS`) made each of those snaps
/// a ~36k-day walk, so a schedule was O(edges * range length). The exception
/// index is merged and disjoint, so a day inside a run is crossed to the run's
/// far edge in one O(log X) step; only weekday-mask gaps are still stepped. The
/// result is the date the day-by-day walk returned, and the guards are its guards
/// restated on the jump: every skipped day is non-working, so landing more than
/// `max_scan` days out means the walk's budget ran out first, and a landing past
/// `NaiveDate`'s range is the walk's overflow. Both surface as
/// `calendar_scan_error(anchor, ..)`, as they did before. Mirrors the Python
/// engine's `_snap_to_working_day`.
fn snap_working_day(
    d: NaiveDate,
    cal: &Calendar,
    forward: bool,
    max_scan: i64,
    anchor: NaiveDate,
) -> Result<NaiveDate, String> {
    if cal.is_working_day(d) {
        return Ok(d);
    }
    let direction = if forward { "after" } else { "before" };
    let origin = i64::from(d.num_days_from_ce());
    let mut ord = origin;
    loop {
        // `ord` stays inside NaiveDate's range (it is only ever a date we landed
        // on), so it fits i32.
        ord = match cal.exception_run(ord as i32) {
            Some((_, end)) if forward => i64::from(end) + 1,
            Some((start, _)) => i64::from(start) - 1,
            None if forward => ord + 1,
            None => ord - 1,
        };
        if (ord - origin).abs() > max_scan {
            return Err(calendar_scan_error(anchor, direction));
        }
        let current = checked_offset_days(d, ord - origin)
            .map_err(|_| calendar_scan_error(anchor, direction))?;
        if cal.is_working_day(current) {
            return Ok(current);
        }
    }
}

/// Return `d` if it is a working day, otherwise the next working day.
///
/// Bounded by `MAX_CALENDAR_SCAN_DAYS` and using checked date arithmetic so a
/// calendar whose exceptions blanket every day after `d` returns `Err` rather
/// than spinning until `NaiveDate` overflows and panics (#908).
pub fn next_working_day(d: NaiveDate, cal: &Calendar) -> Result<NaiveDate, String> {
    snap_working_day(d, cal, true, MAX_CALENDAR_SCAN_DAYS, d)
}

/// Return `d` if it is a working day, otherwise the previous working day.
pub fn prev_working_day(d: NaiveDate, cal: &Calendar) -> Result<NaiveDate, String> {
    snap_working_day(d, cal, false, MAX_CALENDAR_SCAN_DAYS, d)
}

/// Step one day off `current` and snap onward to the next working day in that
/// direction. The step counts against the per-gap budget, so the snap gets one
/// day less of it — the same bound the per-day loop drew.
fn step_to_working_day(
    current: NaiveDate,
    cal: &Calendar,
    forward: bool,
    anchor: NaiveDate,
) -> Result<NaiveDate, String> {
    let direction = if forward { "after" } else { "before" };
    let next = checked_offset_days(current, if forward { 1 } else { -1 })
        .map_err(|_| calendar_scan_error(anchor, direction))?;
    snap_working_day(next, cal, forward, MAX_CALENDAR_SCAN_DAYS - 1, anchor)
}

/// Return the last working day of a task given its start and working-day duration.
///
/// A duration of 1 means the task occupies only the start day.
/// A duration of 0 is treated as a milestone: returns the start day unchanged.
///
/// Why the walk begins at `next_working_day(start)` rather than at `start`
/// (#3963): `duration` counts **working** days, so the first day of the walk has
/// to be one. `start` is not guaranteed to be — a recorded `actual_start` is kept
/// verbatim as the ES floor (ADR-0132 §2: actuals are truth and are never
/// renegotiated), and the API sets one with no user intent at all ("Any →
/// IN_PROGRESS: set actual_start = today"), so a contributor moving a card on a
/// Saturday arms it. Counting that Saturday as work-day 1 spent one working day
/// of the duration on a day the calendar says nobody works: the task finished a
/// working day early, and because the backward pass lays the same duration back
/// from a working-day LF, `late_start` landed *before* `early_start`. Mirrors
/// the Python engine's `_finish_from_start`; both engines had the identical rule,
/// so `wasm:conformance` agreed and agreed wrongly.
///
/// The `MAX_CALENDAR_SCAN_DAYS` budget is **per non-working gap**, not for the
/// whole expansion: it resets on every working-day hit, mirroring the Python
/// engine's `_finish_from_start`, which calls `_scan_for_working_day` (a fresh
/// counter) once per working-day step. Bounding the entire walk instead would
/// reject validator-legal long durations (e.g. `MAX_DURATION_DAYS` on a Mon-Fri
/// calendar needs ~51k calendar steps) that Python schedules (#1855). The guard
/// still catches its target — a calendar whose exceptions blanket the window —
/// because such a calendar produces one gap longer than the budget. The opening
/// `next_working_day` snap carries the same guard in its own helper, so a
/// blanketed calendar is still rejected rather than walked past the ceiling.
pub fn finish_from_start(
    start: NaiveDate,
    duration_days: i32,
    cal: &Calendar,
) -> Result<NaiveDate, String> {
    if duration_days <= 0 {
        return Ok(start);
    }
    let mut remaining = duration_days - 1;
    let mut current = next_working_day(start, cal)?;
    while remaining > 0 {
        current = step_to_working_day(current, cal, true, start)?;
        remaining -= 1;
    }
    Ok(current)
}

/// Return the first working day of a task given its finish and working-day duration.
///
/// Inverse of `finish_from_start`, with the same per-gap (not whole-walk) scan
/// budget — see that function's doc comment (#1855) — and snapped the same way
/// for the same reason (#3963): the walk begins at `prev_working_day(finish)`
/// because the duration it lays out counts working days only. `finish` can be a
/// non-working day — a completed task's `actual_finish` is recorded verbatim
/// (ADR-0136, "actuals are truth") and drives this back-off in `pinned_placement`
/// — and counting it as the last work day gave the task one working day fewer
/// than its duration, the mirror image of the forward defect. Keeping the two
/// helpers snapped symmetrically is what makes them inverses on every input
/// rather than only on working-day ones.
pub fn start_from_finish(
    finish: NaiveDate,
    duration_days: i32,
    cal: &Calendar,
) -> Result<NaiveDate, String> {
    if duration_days <= 0 {
        return Ok(finish);
    }
    let mut remaining = duration_days - 1;
    let mut current = prev_working_day(finish, cal)?;
    while remaining > 0 {
        current = step_to_working_day(current, cal, false, finish)?;
        remaining -= 1;
    }
    Ok(current)
}

/// Count working days in `[start, end)` — start inclusive, end exclusive.
///
/// Returns `Ok(0)` when `end <= start`, and `Err` when the span exceeds
/// [`MAX_WORKING_DAY_WALK_DAYS`] or the day increment would overflow — bounds
/// only unvalidated input can produce (#1858). Checked like the other calendar
/// walks so no future call path can re-expose the O(span) freeze or the
/// overflow panic through this loop.
pub fn working_days_between(
    start: NaiveDate,
    end: NaiveDate,
    cal: &Calendar,
) -> Result<i32, String> {
    if end <= start {
        return Ok(0);
    }
    if (end - start).num_days() > MAX_WORKING_DAY_WALK_DAYS {
        return Err(working_day_walk_error(start, end));
    }
    // Counted arithmetically rather than day by day (#4161): mask days in the
    // span, minus mask days inside each exception run that overlaps it. This is
    // the fallback for every span `WorkingDayCounter` does not cover, and a
    // free-float slack measured across a century-long exception lands outside
    // that range once per edge — so a day loop here was the same
    // O(edges * range length) cost the snaps had. The subtraction is now
    // `exception_mask_days`, O(log E) via a prefix sum over the mask-off-gap-
    // coalesced runs (#4176) rather than O(overlapping runs) — a span crossing a
    // "closed until further notice" period written as thousands of weekly ranges
    // used to walk one run per week; it now walks the handful of runs that are
    // genuinely disjoint once weekend-only gaps are folded in. Mirrors the Python
    // engine's `_working_days_between`.
    let lo = start.num_days_from_ce();
    let hi = end.num_days_from_ce();
    let mask = cal.working_days;
    let mut count = mask_days_between(lo, hi, mask);
    if !cal.exceptions.is_empty() {
        count -= exception_mask_days(cal, lo, hi);
    }
    Ok(count)
}

/// Mask-working days inside any exception run overlapping ordinal span
/// `[lo, hi)` — the subtraction [`working_days_between`] needs.
///
/// O(log E) via the prefix sum [`build_exception_index`] computes over the
/// coalesced runs (#4176): summing every overlapping run one at a time is
/// O(overlapping runs), which — before that same function's mask-off-gap
/// coalescing — was one run per original `exceptions` entry a span crossed. Only
/// the first and last overlapping runs need their own arithmetic (they may be
/// clipped to `lo`/`hi`); every run strictly between them is summed in one
/// prefix-sum subtraction. Mirrors the Python engine's
/// `Calendar._exception_mask_days`.
fn exception_mask_days(cal: &Calendar, lo: i32, hi: i32) -> i32 {
    let (ranges, prefix) = cal
        .exception_index
        .get_or_init(|| build_exception_index(&cal.exceptions, cal.working_days));
    let mask = cal.working_days;
    // Rightmost run starting <= lo (may or may not overlap [lo, hi)); runs are
    // sorted and disjoint, so every later run's start is > lo.
    let a = ranges.partition_point(|&(s, _)| s <= lo).saturating_sub(1);
    // One past the last run with a start < hi.
    let b_plus1 = ranges.partition_point(|&(s, _)| s < hi);
    if b_plus1 == 0 || b_plus1 <= a {
        return 0;
    }
    let b = b_plus1 - 1;
    if a == b {
        let s = ranges[a].0.max(lo);
        let e = (ranges[a].1 + 1).min(hi);
        return if s < e { mask_days_between(s, e, mask) } else { 0 };
    }
    let s0 = ranges[a].0.max(lo);
    let e0 = ranges[a].1 + 1;
    let first = if s0 < e0 { mask_days_between(s0, e0, mask) } else { 0 };
    let middle = prefix[b] - prefix[a + 1];
    let s_last = ranges[b].0;
    let e_last = (ranges[b].1 + 1).min(hi);
    let last = if s_last < e_last {
        mask_days_between(s_last, e_last, mask)
    } else {
        0
    };
    first + middle + last
}

/// Day ordinals in `[lo, hi)` whose weekday is set in the `working_days` mask.
///
/// `num_days_from_ce() == 1` is Monday 0001-01-01, so an ordinal's weekday bit
/// is `(o - 1) mod 7` — the Monday=0 numbering `is_working_day` reads.
fn mask_days_between(lo: i32, hi: i32, mask: u8) -> i32 {
    let n = hi - lo;
    if n <= 0 {
        return 0;
    }
    let full_weeks = n / 7;
    let mut count = full_weeks * (mask & 0b111_1111).count_ones() as i32;
    let first = lo + full_weeks * 7;
    for o in first..first + n % 7 {
        count += i32::from((mask >> (o - 1).rem_euclid(7)) & 1);
    }
    count
}

/// Advance `d` by `lag` calendar days and snap to the next working day.
pub fn advance_calendar_days(
    d: NaiveDate,
    lag_days: i64,
    cal: &Calendar,
) -> Result<NaiveDate, String> {
    let shifted = d
        .checked_add_signed(Duration::days(lag_days))
        .ok_or_else(|| calendar_scan_error(d, "after"))?;
    next_working_day(shifted, cal)
}

/// Retreat `d` by `lag` calendar days and snap to the previous working day.
pub fn retreat_calendar_days(
    d: NaiveDate,
    lag_days: i64,
    cal: &Calendar,
) -> Result<NaiveDate, String> {
    let shifted = d
        .checked_sub_signed(Duration::days(lag_days))
        .ok_or_else(|| calendar_scan_error(d, "before"))?;
    prev_working_day(shifted, cal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::DateRange;
    use crate::validate::MAX_DURATION_DAYS;

    fn weekday_cal() -> Calendar {
        Calendar::default()
    }

    #[test]
    fn test_is_working_day() {
        let cal = weekday_cal();
        // 2026-03-30 is Monday
        let mon = NaiveDate::from_ymd_opt(2026, 3, 30).unwrap();
        assert!(cal.is_working_day(mon));
        // 2026-03-28 is Saturday
        let sat = NaiveDate::from_ymd_opt(2026, 3, 28).unwrap();
        assert!(!cal.is_working_day(sat));
    }

    #[test]
    fn test_exception_overrides_working_day() {
        let cal = Calendar {
            exceptions: vec![DateRange {
                start: NaiveDate::from_ymd_opt(2026, 3, 30).unwrap(),
                end: NaiveDate::from_ymd_opt(2026, 3, 30).unwrap(),
            }],
            ..Calendar::default()
        };
        let mon = NaiveDate::from_ymd_opt(2026, 3, 30).unwrap();
        assert!(!cal.is_working_day(mon));
    }

    #[test]
    fn test_next_working_day_skips_weekend() {
        let cal = weekday_cal();
        let sat = NaiveDate::from_ymd_opt(2026, 3, 28).unwrap();
        let mon = NaiveDate::from_ymd_opt(2026, 3, 30).unwrap();
        assert_eq!(next_working_day(sat, &cal).unwrap(), mon);
    }

    #[test]
    fn test_finish_from_start() {
        let cal = weekday_cal();
        // 5-day task starting Monday 2026-03-30 → finishes Friday 2026-04-03
        let start = NaiveDate::from_ymd_opt(2026, 3, 30).unwrap();
        let expected = NaiveDate::from_ymd_opt(2026, 4, 3).unwrap();
        assert_eq!(finish_from_start(start, 5, &cal).unwrap(), expected);
    }

    #[test]
    fn test_start_from_finish() {
        let cal = weekday_cal();
        let finish = NaiveDate::from_ymd_opt(2026, 4, 3).unwrap();
        let expected = NaiveDate::from_ymd_opt(2026, 3, 30).unwrap();
        assert_eq!(start_from_finish(finish, 5, &cal).unwrap(), expected);
    }

    #[test]
    fn test_working_days_between() {
        let cal = weekday_cal();
        let mon = NaiveDate::from_ymd_opt(2026, 3, 30).unwrap();
        let next_mon = NaiveDate::from_ymd_opt(2026, 4, 6).unwrap();
        // Mon to next Mon exclusive = 5 working days
        assert_eq!(working_days_between(mon, next_mon, &cal).unwrap(), 5);
    }

    #[test]
    fn test_milestone_duration_zero() {
        let cal = weekday_cal();
        let start = NaiveDate::from_ymd_opt(2026, 3, 30).unwrap();
        assert_eq!(finish_from_start(start, 0, &cal).unwrap(), start);
    }

    #[test]
    fn test_finish_from_start_does_not_spend_a_non_working_start_day() {
        // #3963: a recorded actual_start is kept verbatim as the ES floor and can
        // land on a Saturday, so the duration walk — which counts WORKING days —
        // must begin on the following Monday. Counting the Saturday as work-day 1
        // gave the task one working day fewer than its duration.
        let cal = weekday_cal();
        let sat = NaiveDate::from_ymd_opt(2026, 2, 7).unwrap();
        let sun = NaiveDate::from_ymd_opt(2026, 2, 8).unwrap();
        let mon = NaiveDate::from_ymd_opt(2026, 2, 9).unwrap();
        let fri = NaiveDate::from_ymd_opt(2026, 2, 6).unwrap();
        // Mon 9 + Tue 10 + Wed 11.
        let wed = NaiveDate::from_ymd_opt(2026, 2, 11).unwrap();
        assert_eq!(finish_from_start(sat, 3, &cal).unwrap(), wed);
        assert_eq!(finish_from_start(sun, 3, &cal).unwrap(), wed);
        assert_eq!(finish_from_start(mon, 3, &cal).unwrap(), wed);
        // The Friday leg is what proves the weekend legs are not off by one the
        // other way: a genuine working-day start earlier than Monday finishes
        // earlier than Monday's.
        assert!(finish_from_start(fri, 3, &cal).unwrap() < wed);
        // A milestone lays out no working days, so it keeps its verbatim date.
        assert_eq!(finish_from_start(sat, 0, &cal).unwrap(), sat);
    }

    #[test]
    fn test_start_from_finish_does_not_spend_a_non_working_finish_day() {
        // #3963, the mirror: a completed task's actual_finish is verbatim too
        // (ADR-0136), so the back-off begins on the preceding working day.
        let cal = weekday_cal();
        let sun = NaiveDate::from_ymd_opt(2026, 2, 8).unwrap();
        // Back off from Fri 6: Fri, Thu, Wed.
        let wed = NaiveDate::from_ymd_opt(2026, 2, 4).unwrap();
        assert_eq!(start_from_finish(sun, 3, &cal).unwrap(), wed);
        assert_eq!(start_from_finish(sun, 0, &cal).unwrap(), sun);
    }

    #[test]
    fn test_finish_from_start_max_duration_boundary() {
        // #1855: the scan budget is per non-working gap, not for the whole
        // expansion. MAX_DURATION_DAYS working days on a Mon-Fri calendar walk
        // ~51k calendar steps — far past MAX_CALENDAR_SCAN_DAYS — but every gap
        // is a 2-day weekend, so the walk must succeed. The Python engine
        // schedules this exact input to 2166-04-01 (verified against
        // _finish_from_start); a whole-walk bound rejected it.
        let cal = weekday_cal();
        let start = NaiveDate::from_ymd_opt(2026, 4, 1).unwrap();
        let expected = NaiveDate::from_ymd_opt(2166, 4, 1).unwrap();
        assert_eq!(
            finish_from_start(start, MAX_DURATION_DAYS as i32, &cal).unwrap(),
            expected
        );
    }

    #[test]
    fn test_start_from_finish_max_duration_boundary() {
        // Inverse of the boundary walk above: the backward pass must round-trip
        // the same MAX_DURATION_DAYS expansion (#1855).
        let cal = weekday_cal();
        let finish = NaiveDate::from_ymd_opt(2166, 4, 1).unwrap();
        let expected = NaiveDate::from_ymd_opt(2026, 4, 1).unwrap();
        assert_eq!(
            start_from_finish(finish, MAX_DURATION_DAYS as i32, &cal).unwrap(),
            expected
        );
    }

    #[test]
    fn test_duration_walk_still_rejects_blanket_gap() {
        // The per-gap reset must not weaken the guard's real target: a single
        // non-working gap longer than MAX_CALENDAR_SCAN_DAYS (exceptions
        // blanketing the window after a valid start) still errors instead of
        // walking to the date ceiling (#908, preserved by #1855).
        let gap_start = NaiveDate::from_ymd_opt(2026, 4, 2).unwrap();
        let cal = Calendar {
            exceptions: vec![DateRange {
                start: gap_start,
                end: gap_start + Duration::days(MAX_CALENDAR_SCAN_DAYS + 10),
            }],
            ..Calendar::default()
        };
        let start = NaiveDate::from_ymd_opt(2026, 4, 1).unwrap();
        assert!(finish_from_start(start, 2, &cal).is_err());
        // Backward direction: same blanket before a valid finish day.
        let finish = gap_start + Duration::days(MAX_CALENDAR_SCAN_DAYS + 11);
        let cal_back = Calendar {
            working_days: 127, // every weekday working, so only the blanket blocks
            exceptions: vec![DateRange {
                start: gap_start,
                end: gap_start + Duration::days(MAX_CALENDAR_SCAN_DAYS + 10),
            }],
            ..Calendar::default()
        };
        assert!(start_from_finish(finish, 2, &cal_back).is_err());
    }

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    /// Reference implementation of the pre-#1534 linear exception test, to assert
    /// the merged-index `is_working_day` is byte-identical over a scan of days.
    fn is_working_day_linear(cal: &Calendar, day: NaiveDate) -> bool {
        let weekday_bit = day.weekday().num_days_from_monday();
        if (cal.working_days >> weekday_bit) & 1 == 0 {
            return false;
        }
        !cal.exceptions.iter().any(|e| day >= e.start && day <= e.end)
    }

    #[test]
    fn test_is_working_day_index_matches_linear_scan_with_overlaps() {
        // Overlapping, adjacent, unsorted, and inverted exception ranges — the
        // merged index must agree with the linear scan on every day across a
        // two-month window (#1534).
        let cal = Calendar {
            exceptions: vec![
                DateRange { start: d(2026, 4, 10), end: d(2026, 4, 20) }, // base
                DateRange { start: d(2026, 4, 15), end: d(2026, 4, 25) }, // overlaps
                DateRange { start: d(2026, 4, 26), end: d(2026, 4, 26) }, // day-adjacent
                DateRange { start: d(2026, 4, 1), end: d(2026, 4, 3) },   // earlier, unsorted
                DateRange { start: d(2026, 5, 5), end: d(2026, 5, 4) },   // inverted → no-op
            ],
            ..Calendar::default()
        };
        let mut day = d(2026, 3, 20);
        let end = d(2026, 5, 20);
        while day <= end {
            assert_eq!(
                cal.is_working_day(day),
                is_working_day_linear(&cal, day),
                "mismatch on {day}"
            );
            day += Duration::days(1);
        }
    }

    fn task_spanning(id: &str, es: NaiveDate, lf: NaiveDate) -> Task {
        Task {
            id: id.to_string(),
            name: id.to_string(),
            duration: 86400.0,
            planned_start: None,
            planned_finish: None,
            early_start: Some(es),
            early_finish: Some(es),
            late_start: Some(lf),
            late_finish: Some(lf),
            scheduled_start: Some(es),
            milestone_at_day_end: false,
            total_float: 0.0,
            free_float: 0.0,
            is_critical: false,
            percent_complete: 0.0,
            actual_start: None,
            actual_finish: None,
            optimistic_duration: None,
            most_likely_duration: None,
            pessimistic_duration: None,
            calendar_id: None,
            delivery_mode: None,
            story_points: None,
        }
    }

    #[test]
    fn test_working_day_counter_matches_scalar_in_range() {
        let cal = Calendar {
            exceptions: vec![DateRange { start: d(2026, 4, 10), end: d(2026, 4, 17) }],
            ..Calendar::default()
        };
        // Range spanned by the tasks: [2026-04-01, 2026-05-01].
        let tasks = vec![
            task_spanning("A", d(2026, 4, 1), d(2026, 5, 1)),
            task_spanning("B", d(2026, 4, 6), d(2026, 4, 20)),
        ];
        let counter = WorkingDayCounter::build(&tasks, &cal).unwrap();
        // Every in-range [start, end) pair must equal the scalar reference.
        let lo = d(2026, 4, 1);
        let hi = d(2026, 5, 1);
        let mut a = lo;
        while a <= hi {
            let mut b = a;
            while b <= hi {
                assert_eq!(
                    counter.between(a, b).unwrap(),
                    working_days_between(a, b, &cal).unwrap(),
                    "counter/scalar mismatch for [{a}, {b})"
                );
                b += Duration::days(1);
            }
            a += Duration::days(1);
        }
    }

    #[test]
    fn test_working_day_counter_falls_back_out_of_range() {
        let cal = weekday_cal();
        let tasks = vec![task_spanning("A", d(2026, 4, 6), d(2026, 4, 10))];
        let counter = WorkingDayCounter::build(&tasks, &cal).unwrap();
        // A span starting before lo and one ending after hi both defer to the
        // scalar reference and must still be exact.
        let before = (d(2026, 3, 1), d(2026, 4, 8));
        let after = (d(2026, 4, 8), d(2026, 6, 1));
        assert_eq!(
            counter.between(before.0, before.1).unwrap(),
            working_days_between(before.0, before.1, &cal).unwrap()
        );
        assert_eq!(
            counter.between(after.0, after.1).unwrap(),
            working_days_between(after.0, after.1, &cal).unwrap()
        );
    }

    #[test]
    fn test_working_day_counter_build_errors_on_absurd_bounds() {
        // #1858 second layer: if any future mutation path again lets a
        // NaiveDate::MAX late_finish reach the float pass, the counter build
        // must return Err — before this fix the `current += 1 day` increment
        // at current == MAX panicked and trapped the WASM module (and a
        // merely-large bound walked tens of millions of days first).
        let cal = weekday_cal();
        let tasks = vec![task_spanning("A", d(2026, 4, 1), NaiveDate::MAX)];
        assert!(WorkingDayCounter::build(&tasks, &cal).is_err());
    }

    #[test]
    fn test_working_days_between_errors_on_absurd_bounds() {
        // #1858 second layer: same guard for the scalar reference walk — an
        // end bound only unvalidated input can produce yields Err, not an
        // O(tens-of-millions-of-days) main-thread freeze.
        let cal = weekday_cal();
        assert!(working_days_between(d(2026, 4, 1), NaiveDate::MAX, &cal).is_err());
    }
    // --- #4161: snaps jump exception runs; results match the day-by-day walk ---

    /// The pre-#4161 snap: one day per step, same budget and overflow guards.
    fn snap_by_day(d: NaiveDate, cal: &Calendar, step: i64, budget: i64) -> Option<NaiveDate> {
        let mut current = d;
        let mut scanned = 0i64;
        while !cal.is_working_day(current) {
            if scanned >= budget {
                return None;
            }
            current = current.checked_add_signed(Duration::days(step))?;
            scanned += 1;
        }
        Some(current)
    }

    fn between_by_day(start: NaiveDate, end: NaiveDate, cal: &Calendar) -> i32 {
        let mut count = 0;
        let mut current = start;
        while current < end {
            count += i32::from(cal.is_working_day(current));
            current += Duration::days(1);
        }
        count
    }

    #[test]
    fn test_snaps_and_span_match_day_walk_on_random_calendars() {
        // Tiny deterministic LCG — no rand dependency in this crate.
        let mut seed: u64 = 4161;
        let mut next = |n: i64| -> i64 {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) % n as u64) as i64
        };
        let base = d(2026, 3, 1);
        for _ in 0..300 {
            let mut exceptions = Vec::new();
            for _ in 0..next(9) {
                let s = base + Duration::days(next(121) - 60);
                exceptions.push(DateRange { start: s, end: s + Duration::days(next(21)) });
            }
            let cal = Calendar {
                working_days: (next(127) + 1) as u8,
                exceptions,
                ..Calendar::default()
            };
            for _ in 0..20 {
                let day = base + Duration::days(next(161) - 80);
                assert_eq!(
                    next_working_day(day, &cal).ok(),
                    snap_by_day(day, &cal, 1, MAX_CALENDAR_SCAN_DAYS)
                );
                assert_eq!(
                    prev_working_day(day, &cal).ok(),
                    snap_by_day(day, &cal, -1, MAX_CALENDAR_SCAN_DAYS)
                );
                let end = day + Duration::days(next(126) - 5);
                assert_eq!(
                    working_days_between(day, end, &cal).unwrap(),
                    between_by_day(day, end, &cal)
                );
            }
        }
    }

    #[test]
    fn test_snaps_and_span_match_day_walk_on_dense_calendars() {
        // Many short, closely spaced exception ranges — some gaps purely
        // mask-off and coalesced into one run (#4176), some not — must still
        // match the day-by-day walk exactly, for the snap and the working-day
        // span. Unlike the random-calendar test above (a handful of widely
        // scattered ranges), this stresses `build_exception_index`'s mask-off-gap
        // coalescing, which only the random test's 0/1-day gaps exercise weakly.
        let mut seed: u64 = 4176;
        let mut next = |n: i64| -> i64 {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) % n as u64) as i64
        };
        let base = d(2026, 3, 1);
        for _ in 0..150 {
            let mut exceptions = Vec::new();
            let mut cursor = base + Duration::days(next(101) - 400);
            for _ in 0..(20 + next(41)) {
                cursor += Duration::days(next(7));
                let length = next(7);
                exceptions.push(DateRange { start: cursor, end: cursor + Duration::days(length) });
                cursor += Duration::days(length);
            }
            let cal = Calendar {
                working_days: (next(127) + 1) as u8,
                exceptions,
                ..Calendar::default()
            };
            for _ in 0..10 {
                let day = base + Duration::days(next(901) - 450);
                assert_eq!(
                    next_working_day(day, &cal).ok(),
                    snap_by_day(day, &cal, 1, MAX_CALENDAR_SCAN_DAYS)
                );
                assert_eq!(
                    prev_working_day(day, &cal).ok(),
                    snap_by_day(day, &cal, -1, MAX_CALENDAR_SCAN_DAYS)
                );
                let end = day + Duration::days(next(601) - 100);
                assert_eq!(
                    working_days_between(day, end, &cal).unwrap(),
                    between_by_day(day, end, &cal)
                );
            }
        }
    }

    #[test]
    fn test_snap_budget_boundary_matches_day_walk() {
        // A gap of exactly the budget is crossed; one day more is rejected.
        let start = d(2026, 1, 1);
        for extra in [-1i64, 0, 1] {
            let gap = MAX_CALENDAR_SCAN_DAYS + extra;
            let cal = Calendar {
                working_days: 127,
                exceptions: vec![DateRange { start, end: start + Duration::days(gap - 1) }],
                ..Calendar::default()
            };
            assert_eq!(
                next_working_day(start, &cal).ok(),
                snap_by_day(start, &cal, 1, MAX_CALENDAR_SCAN_DAYS)
            );
            let end = start + Duration::days(gap - 1);
            assert_eq!(
                prev_working_day(end, &cal).ok(),
                snap_by_day(end, &cal, -1, MAX_CALENDAR_SCAN_DAYS)
            );
        }
    }

    #[test]
    fn test_snap_into_date_range_edge_errors() {
        let near_max = Calendar {
            exceptions: vec![DateRange {
                start: NaiveDate::MAX - Duration::days(30),
                end: NaiveDate::MAX,
            }],
            ..Calendar::default()
        };
        assert!(next_working_day(NaiveDate::MAX - Duration::days(10), &near_max).is_err());
        let near_min = Calendar {
            exceptions: vec![DateRange {
                start: NaiveDate::MIN,
                end: NaiveDate::MIN + Duration::days(30),
            }],
            ..Calendar::default()
        };
        assert!(prev_working_day(NaiveDate::MIN + Duration::days(10), &near_min).is_err());
        // The tie: the budget and the date range run out on the same day.
        for back in [MAX_CALENDAR_SCAN_DAYS - 1, MAX_CALENDAR_SCAN_DAYS, MAX_CALENDAR_SCAN_DAYS + 1] {
            let hi = NaiveDate::MAX - Duration::days(back);
            let tie_hi = Calendar {
                exceptions: vec![DateRange { start: hi, end: NaiveDate::MAX }],
                ..Calendar::default()
            };
            assert_eq!(
                next_working_day(hi, &tie_hi).ok(),
                snap_by_day(hi, &tie_hi, 1, MAX_CALENDAR_SCAN_DAYS)
            );
            let lo = NaiveDate::MIN + Duration::days(back);
            let tie_lo = Calendar {
                exceptions: vec![DateRange { start: NaiveDate::MIN, end: lo }],
                ..Calendar::default()
            };
            assert_eq!(
                prev_working_day(lo, &tie_lo).ok(),
                snap_by_day(lo, &tie_lo, -1, MAX_CALENDAR_SCAN_DAYS)
            );
        }
    }
}
