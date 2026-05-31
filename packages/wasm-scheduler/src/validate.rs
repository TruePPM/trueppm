//! Input validation, mirroring `trueppm_scheduler.engine._validate_project` (#749).
//!
//! The CPM engine walks the calendar one day at a time, and `chrono`'s default
//! `NaiveDate + Duration` arithmetic *panics* on overflow — so a calendar with
//! no working day, or an absurd duration/lag, would spin the day-by-day walk
//! and then trap the entire WASM module in the browser. Rejecting that input up
//! front turns it into a clean error string (surfaced to JS as an exception),
//! keeping parity with the Python engine's behaviour and bounds.

use chrono::Duration;

use crate::models::Project;

/// Per-task working-day duration ceiling (~100 years).
/// Mirrors `trueppm_scheduler.engine.MAX_DURATION_DAYS`.
pub const MAX_DURATION_DAYS: i64 = 36_525;
/// Per-dependency lead/lag ceiling (~100 years), in either direction.
pub const MAX_LAG_DAYS: i64 = 36_525;
/// Largest run of consecutive non-working days to scan from the project start
/// before declaring the calendar degenerate.
pub const MAX_CALENDAR_SCAN_DAYS: i64 = 366 * 100;
/// Upper bound on the cumulative project span (sum of worst-case task durations
/// plus the magnitude of every lag). Bounds the day-by-day walk regardless of
/// task count. Mirrors `trueppm_scheduler.engine.MAX_PROJECT_SPAN_DAYS`.
pub const MAX_PROJECT_SPAN_DAYS: i64 = 366 * 1000;

/// Reject degenerate input before any calendar walk runs.
///
/// Returns `Err(message)` for: an empty working-day mask, a negative or
/// out-of-range task duration / PERT estimate, an out-of-range dependency lag,
/// or a calendar with no working day reachable from the project start.
pub fn validate_project(project: &Project) -> Result<(), String> {
    let cal = &project.calendar;

    // Unique task IDs: every per-task result is keyed on Task.id, so a duplicate
    // id silently shadows one task. Reject it as the structural error it is,
    // matching the Python engine's _validate_project (#749).
    let mut seen_ids: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for t in &project.tasks {
        if !seen_ids.insert(t.id.as_str()) {
            return Err(format!(
                "Duplicate task id {:?}; every task must have a unique id.",
                t.id
            ));
        }
    }

    // is_working_day only consults bits 0-6 (Mon-Sun); a mask with none of them
    // set (0, or only bits >= 7) has no working day at all.
    if (cal.working_days & 0b0111_1111) == 0 {
        return Err("Calendar has no working weekday set (working_days bitmask is empty); \
                    at least one of Mon-Sun must be a working day."
            .to_string());
    }

    for t in &project.tasks {
        check_duration(i64::from(t.duration_days()), &format!("Task {:?} duration", t.id))?;
        for (label, secs) in [
            ("optimistic_duration", t.optimistic_duration),
            ("most_likely_duration", t.most_likely_duration),
            ("pessimistic_duration", t.pessimistic_duration),
        ] {
            if let Some(seconds) = secs {
                let days = (seconds / 86_400.0).round() as i64;
                check_duration(days, &format!("Task {:?} {}", t.id, label))?;
            }
        }
    }

    for dep in &project.dependencies {
        let lag = dep.lag_days();
        if lag.abs() > MAX_LAG_DAYS {
            return Err(format!(
                "Dependency {:?} -> {:?} lag exceeds the maximum of +/-{} days (got {}).",
                dep.predecessor_id, dep.successor_id, MAX_LAG_DAYS, lag
            ));
        }
    }

    // Cumulative span: an upper bound on the longest path (and the Monte Carlo
    // completion offset, which samples up to the pessimistic duration). Bounding
    // the sum keeps the day-by-day walk from spinning or overflowing the date
    // range no matter how many tasks are chained.
    let mut total_span: i64 = 0;
    for t in &project.tasks {
        // Worst case across the deterministic duration AND every PERT estimate:
        // Monte Carlo falls back to most_likely when the range is degenerate, so
        // most_likely (which may exceed pessimistic) must count too.
        let mut task_max = i64::from(t.duration_days());
        for seconds in [t.optimistic_duration, t.most_likely_duration, t.pessimistic_duration]
            .into_iter()
            .flatten()
        {
            task_max = task_max.max((seconds / 86_400.0).round() as i64);
        }
        total_span += task_max.max(0);
    }
    for dep in &project.dependencies {
        total_span += dep.lag_days().abs();
    }
    if total_span > MAX_PROJECT_SPAN_DAYS {
        return Err(format!(
            "Total project span ({total_span} days across all task durations and lags) \
             exceeds the maximum of {MAX_PROJECT_SPAN_DAYS} days."
        ));
    }

    // Reachability: a working day must exist within MAX_CALENDAR_SCAN_DAYS of
    // the project start (catches a valid mask whose exceptions blanket the
    // schedule). Uses checked arithmetic so this scan cannot itself panic, even
    // for an absurd start_date — it returns an error instead.
    let mut d = project.start_date;
    let mut scanned: i64 = 0;
    while !cal.is_working_day(d) {
        if scanned >= MAX_CALENDAR_SCAN_DAYS {
            return Err(format!(
                "Calendar has no working day within {MAX_CALENDAR_SCAN_DAYS} days of the \
                 project start; check the working_days bitmask and exceptions."
            ));
        }
        d = d
            .checked_add_signed(Duration::days(1))
            .ok_or("Calendar scan overflowed the representable date range.")?;
        scanned += 1;
    }

    Ok(())
}

fn check_duration(days: i64, label: &str) -> Result<(), String> {
    if days < 0 {
        return Err(format!("{label} must not be negative (got {days} days)."));
    }
    if days > MAX_DURATION_DAYS {
        return Err(format!(
            "{label} exceeds the maximum of {MAX_DURATION_DAYS} days (got {days})."
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use chrono::NaiveDate;

    use super::*;
    use crate::models::{Calendar, DateRange, Dependency, DependencyType, Project, Task};

    fn day(secs_days: i64) -> f64 {
        (secs_days * 86_400) as f64
    }

    fn task(id: &str, days: i64) -> Task {
        Task {
            id: id.to_string(),
            name: id.to_string(),
            duration: day(days),
            planned_start: None,
            planned_finish: None,
            early_start: None,
            early_finish: None,
            late_start: None,
            late_finish: None,
            total_float: 0.0,
            free_float: 0.0,
            is_critical: false,
            percent_complete: 0.0,
            optimistic_duration: None,
            most_likely_duration: None,
            pessimistic_duration: None,
        }
    }

    fn project(tasks: Vec<Task>, deps: Vec<Dependency>, cal: Calendar) -> Project {
        Project {
            id: "p".to_string(),
            name: "p".to_string(),
            start_date: NaiveDate::from_ymd_opt(2026, 4, 1).unwrap(),
            tasks,
            dependencies: deps,
            calendar: cal,
        }
    }

    #[test]
    fn accepts_a_sane_project() {
        let p = project(vec![task("A", 5)], vec![], Calendar::default());
        assert!(validate_project(&p).is_ok());
    }

    #[test]
    fn rejects_empty_working_day_mask() {
        let cal = Calendar { working_days: 0, ..Calendar::default() };
        let p = project(vec![task("A", 1)], vec![], cal);
        assert!(validate_project(&p).is_err());
    }

    #[test]
    fn rejects_mask_with_only_non_weekday_bits() {
        let cal = Calendar { working_days: 0b1000_0000, ..Calendar::default() };
        let p = project(vec![task("A", 1)], vec![], cal);
        assert!(validate_project(&p).is_err());
    }

    #[test]
    fn rejects_exceptions_blanketing_the_schedule() {
        let cal = Calendar {
            exceptions: vec![DateRange {
                start: NaiveDate::from_ymd_opt(1900, 1, 1).unwrap(),
                end: NaiveDate::from_ymd_opt(2400, 1, 1).unwrap(),
            }],
            ..Calendar::default()
        };
        let p = project(vec![task("A", 1)], vec![], cal);
        assert!(validate_project(&p).is_err());
    }

    #[test]
    fn rejects_duplicate_task_id() {
        let p = project(vec![task("A", 3), task("A", 2)], vec![], Calendar::default());
        assert!(validate_project(&p).is_err());
    }

    #[test]
    fn rejects_duration_over_max() {
        let p = project(vec![task("A", MAX_DURATION_DAYS + 1)], vec![], Calendar::default());
        assert!(validate_project(&p).is_err());
    }

    #[test]
    fn rejects_negative_duration() {
        let p = project(vec![task("A", -1)], vec![], Calendar::default());
        assert!(validate_project(&p).is_err());
    }

    #[test]
    fn rejects_lag_over_max() {
        let deps = vec![Dependency {
            predecessor_id: "A".to_string(),
            successor_id: "B".to_string(),
            dep_type: DependencyType::FS,
            lag: day(MAX_LAG_DAYS + 1),
        }];
        let p = project(vec![task("A", 1), task("B", 1)], deps, Calendar::default());
        assert!(validate_project(&p).is_err());
    }

    #[test]
    fn rejects_cumulative_span_over_max() {
        // Each task is within the per-task cap, but together they exceed the
        // cumulative project span (11 * 36525 = 401,775 > 366,000).
        let tasks: Vec<Task> = (0..11).map(|i| task(&format!("t{i}"), MAX_DURATION_DAYS)).collect();
        let p = project(tasks, vec![], Calendar::default());
        assert!(validate_project(&p).is_err());
    }

    #[test]
    fn rejects_span_via_most_likely_estimate() {
        // PERT bypass: zero deterministic duration but a huge most_likely, which
        // Monte Carlo samples as a constant. The span must count it.
        let tasks: Vec<Task> = (0..11)
            .map(|i| {
                let mut t = task(&format!("t{i}"), 0);
                t.most_likely_duration = Some(day(MAX_DURATION_DAYS));
                t
            })
            .collect();
        let p = project(tasks, vec![], Calendar::default());
        assert!(validate_project(&p).is_err());
    }
}
