//! Calendar-aware date arithmetic for the CPM engine.
//!
//! Mirrors the Python `_next_working_day`, `_prev_working_day`,
//! `_finish_from_start`, `_start_from_finish`, and `_working_days_between`
//! functions from `trueppm_scheduler.engine`.

use chrono::{Datelike, Duration, NaiveDate};

use crate::models::{Calendar, DateRange, Task};
use crate::validate::MAX_CALENDAR_SCAN_DAYS;

/// Build the sorted, merged exception index used by [`Calendar::is_working_day`].
///
/// Each `DateRange` becomes an inclusive `[start_ord, end_ord]` pair of
/// proleptic-Gregorian day ordinals; the ranges are sorted and coalesced so the
/// result is disjoint and ascending, letting the containment test binary-search
/// instead of scanning every exception per day (#1534). An inverted range
/// (`start > end`) matches no day in the original `start <= d <= end` test, so it
/// is dropped here — preserving byte-identical results.
fn build_exception_index(exceptions: &[DateRange]) -> Vec<(i32, i32)> {
    let mut ranges: Vec<(i32, i32)> = exceptions
        .iter()
        .map(|e| (e.start.num_days_from_ce(), e.end.num_days_from_ce()))
        .filter(|(s, e)| s <= e)
        .collect();
    ranges.sort_unstable();
    let mut merged: Vec<(i32, i32)> = Vec::with_capacity(ranges.len());
    for (s, e) in ranges {
        // Coalesce overlapping OR day-adjacent ranges: for integer day ordinals
        // `[1,5]` and `[6,10]` cover every day in `[1,10]` with no gap, so
        // `s <= last.end + 1` is a safe merge that never swallows an uncovered day.
        if let Some(last) = merged.last_mut() {
            if s <= last.1 + 1 {
                last.1 = last.1.max(e);
                continue;
            }
        }
        merged.push((s, e));
    }
    merged
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
        let index = self
            .exception_index
            .get_or_init(|| build_exception_index(&self.exceptions));
        let ord = d.num_days_from_ce();
        // Rightmost merged range whose start is <= ord; `ord` is an exception iff
        // that range also covers it (ord <= its end).
        let pos = index.partition_point(|&(start, _)| start <= ord);
        let covered = pos > 0 && ord <= index[pos - 1].1;
        !covered
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
    pub fn build(tasks: &[Task], cal: &'a Calendar) -> Self {
        let lo = tasks.iter().filter_map(|t| t.early_start).min();
        let hi = tasks.iter().filter_map(|t| t.late_finish).max();
        let mut ords: Vec<i32> = Vec::new();
        let (lo_ord, hi_ord) = match (lo, hi) {
            (Some(lo), Some(hi)) if hi >= lo => {
                let mut current = lo;
                while current <= hi {
                    if cal.is_working_day(current) {
                        ords.push(current.num_days_from_ce());
                    }
                    current += Duration::days(1);
                }
                (lo.num_days_from_ce(), hi.num_days_from_ce())
            }
            // Sentinel empty range: lo_ord > hi_ord forces every query to fall back.
            _ => (0, -1),
        };
        Self {
            ords,
            lo_ord,
            hi_ord,
            cal,
        }
    }

    /// Count working days in `[start, end)`; identical to [`working_days_between`].
    pub fn between(&self, start: NaiveDate, end: NaiveDate) -> i32 {
        if end <= start {
            return 0;
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
        (hi - lo) as i32
    }
}

/// Return `d` if it is a working day, otherwise the next working day.
///
/// Bounded by `MAX_CALENDAR_SCAN_DAYS` and using checked date arithmetic so a
/// calendar whose exceptions blanket every day after `d` returns `Err` rather
/// than spinning until `NaiveDate` overflows and panics (#908).
pub fn next_working_day(d: NaiveDate, cal: &Calendar) -> Result<NaiveDate, String> {
    let mut current = d;
    let mut scanned = 0i64;
    while !cal.is_working_day(current) {
        if scanned >= MAX_CALENDAR_SCAN_DAYS {
            return Err(calendar_scan_error(d, "after"));
        }
        current = current
            .checked_add_signed(Duration::days(1))
            .ok_or_else(|| calendar_scan_error(d, "after"))?;
        scanned += 1;
    }
    Ok(current)
}

/// Return `d` if it is a working day, otherwise the previous working day.
pub fn prev_working_day(d: NaiveDate, cal: &Calendar) -> Result<NaiveDate, String> {
    let mut current = d;
    let mut scanned = 0i64;
    while !cal.is_working_day(current) {
        if scanned >= MAX_CALENDAR_SCAN_DAYS {
            return Err(calendar_scan_error(d, "before"));
        }
        current = current
            .checked_sub_signed(Duration::days(1))
            .ok_or_else(|| calendar_scan_error(d, "before"))?;
        scanned += 1;
    }
    Ok(current)
}

/// Return the last working day of a task given its start and working-day duration.
///
/// A duration of 1 means the task occupies only the start day.
/// A duration of 0 is treated as a milestone: returns the start day.
pub fn finish_from_start(
    start: NaiveDate,
    duration_days: i32,
    cal: &Calendar,
) -> Result<NaiveDate, String> {
    if duration_days <= 0 {
        return Ok(start);
    }
    let mut remaining = duration_days - 1;
    let mut current = start;
    let mut scanned = 0i64;
    while remaining > 0 {
        if scanned >= MAX_CALENDAR_SCAN_DAYS {
            return Err(calendar_scan_error(start, "after"));
        }
        current = current
            .checked_add_signed(Duration::days(1))
            .ok_or_else(|| calendar_scan_error(start, "after"))?;
        scanned += 1;
        if cal.is_working_day(current) {
            remaining -= 1;
        }
    }
    Ok(current)
}

/// Return the first working day of a task given its finish and working-day duration.
///
/// Inverse of `finish_from_start`.
pub fn start_from_finish(
    finish: NaiveDate,
    duration_days: i32,
    cal: &Calendar,
) -> Result<NaiveDate, String> {
    if duration_days <= 0 {
        return Ok(finish);
    }
    let mut remaining = duration_days - 1;
    let mut current = finish;
    let mut scanned = 0i64;
    while remaining > 0 {
        if scanned >= MAX_CALENDAR_SCAN_DAYS {
            return Err(calendar_scan_error(finish, "before"));
        }
        current = current
            .checked_sub_signed(Duration::days(1))
            .ok_or_else(|| calendar_scan_error(finish, "before"))?;
        scanned += 1;
        if cal.is_working_day(current) {
            remaining -= 1;
        }
    }
    Ok(current)
}

/// Count working days in `[start, end)` — start inclusive, end exclusive.
///
/// Returns 0 when `end <= start`.
pub fn working_days_between(start: NaiveDate, end: NaiveDate, cal: &Calendar) -> i32 {
    if end <= start {
        return 0;
    }
    let mut count = 0;
    let mut current = start;
    while current < end {
        if cal.is_working_day(current) {
            count += 1;
        }
        current += Duration::days(1);
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
        assert_eq!(working_days_between(mon, next_mon, &cal), 5);
    }

    #[test]
    fn test_milestone_duration_zero() {
        let cal = weekday_cal();
        let start = NaiveDate::from_ymd_opt(2026, 3, 30).unwrap();
        assert_eq!(finish_from_start(start, 0, &cal).unwrap(), start);
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
            total_float: 0.0,
            free_float: 0.0,
            is_critical: false,
            percent_complete: 0.0,
            actual_start: None,
            actual_finish: None,
            optimistic_duration: None,
            most_likely_duration: None,
            pessimistic_duration: None,
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
        let counter = WorkingDayCounter::build(&tasks, &cal);
        // Every in-range [start, end) pair must equal the scalar reference.
        let lo = d(2026, 4, 1);
        let hi = d(2026, 5, 1);
        let mut a = lo;
        while a <= hi {
            let mut b = a;
            while b <= hi {
                assert_eq!(
                    counter.between(a, b),
                    working_days_between(a, b, &cal),
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
        let counter = WorkingDayCounter::build(&tasks, &cal);
        // A span starting before lo and one ending after hi both defer to the
        // scalar reference and must still be exact.
        let before = (d(2026, 3, 1), d(2026, 4, 8));
        let after = (d(2026, 4, 8), d(2026, 6, 1));
        assert_eq!(
            counter.between(before.0, before.1),
            working_days_between(before.0, before.1, &cal)
        );
        assert_eq!(
            counter.between(after.0, after.1),
            working_days_between(after.0, after.1, &cal)
        );
    }
}
