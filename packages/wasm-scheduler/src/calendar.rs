//! Calendar-aware date arithmetic for the CPM engine.
//!
//! Mirrors the Python `_next_working_day`, `_prev_working_day`,
//! `_finish_from_start`, `_start_from_finish`, and `_working_days_between`
//! functions from `trueppm_scheduler.engine`.

use chrono::{Datelike, Duration, NaiveDate};

use crate::models::Calendar;

impl Calendar {
    /// Returns true if `d` is a working day (in the weekly mask and not an exception).
    pub fn is_working_day(&self, d: NaiveDate) -> bool {
        // NaiveDate::weekday(): Mon=0 .. Sun=6 (via .num_days_from_monday())
        let weekday_bit = d.weekday().num_days_from_monday();
        if (self.working_days >> weekday_bit) & 1 == 0 {
            return false;
        }
        !self
            .exceptions
            .iter()
            .any(|exc| d >= exc.start && d <= exc.end)
    }
}

/// Return `d` if it is a working day, otherwise the next working day.
pub fn next_working_day(d: NaiveDate, cal: &Calendar) -> NaiveDate {
    let mut d = d;
    while !cal.is_working_day(d) {
        d += Duration::days(1);
    }
    d
}

/// Return `d` if it is a working day, otherwise the previous working day.
pub fn prev_working_day(d: NaiveDate, cal: &Calendar) -> NaiveDate {
    let mut d = d;
    while !cal.is_working_day(d) {
        d -= Duration::days(1);
    }
    d
}

/// Return the last working day of a task given its start and working-day duration.
///
/// A duration of 1 means the task occupies only the start day.
/// A duration of 0 is treated as a milestone: returns the start day.
pub fn finish_from_start(start: NaiveDate, duration_days: i32, cal: &Calendar) -> NaiveDate {
    if duration_days <= 0 {
        return start;
    }
    let mut remaining = duration_days - 1;
    let mut current = start;
    while remaining > 0 {
        current += Duration::days(1);
        if cal.is_working_day(current) {
            remaining -= 1;
        }
    }
    current
}

/// Return the first working day of a task given its finish and working-day duration.
///
/// Inverse of `finish_from_start`.
pub fn start_from_finish(finish: NaiveDate, duration_days: i32, cal: &Calendar) -> NaiveDate {
    if duration_days <= 0 {
        return finish;
    }
    let mut remaining = duration_days - 1;
    let mut current = finish;
    while remaining > 0 {
        current -= Duration::days(1);
        if cal.is_working_day(current) {
            remaining -= 1;
        }
    }
    current
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
pub fn advance_calendar_days(d: NaiveDate, lag_days: i64, cal: &Calendar) -> NaiveDate {
    next_working_day(d + Duration::days(lag_days), cal)
}

/// Retreat `d` by `lag` calendar days and snap to the previous working day.
pub fn retreat_calendar_days(d: NaiveDate, lag_days: i64, cal: &Calendar) -> NaiveDate {
    prev_working_day(d - Duration::days(lag_days), cal)
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
        assert_eq!(next_working_day(sat, &cal), mon);
    }

    #[test]
    fn test_finish_from_start() {
        let cal = weekday_cal();
        // 5-day task starting Monday 2026-03-30 → finishes Friday 2026-04-03
        let start = NaiveDate::from_ymd_opt(2026, 3, 30).unwrap();
        let expected = NaiveDate::from_ymd_opt(2026, 4, 3).unwrap();
        assert_eq!(finish_from_start(start, 5, &cal), expected);
    }

    #[test]
    fn test_start_from_finish() {
        let cal = weekday_cal();
        let finish = NaiveDate::from_ymd_opt(2026, 4, 3).unwrap();
        let expected = NaiveDate::from_ymd_opt(2026, 3, 30).unwrap();
        assert_eq!(start_from_finish(finish, 5, &cal), expected);
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
        assert_eq!(finish_from_start(start, 0, &cal), start);
    }
}
