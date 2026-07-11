//! Input validation, mirroring `trueppm_scheduler.engine._validate_project` (#749).
//!
//! The CPM engine walks the calendar one day at a time, and `chrono`'s default
//! `NaiveDate + Duration` arithmetic *panics* on overflow — so a calendar with
//! no working day, or an absurd duration/lag, would spin the day-by-day walk
//! and then trap the entire WASM module in the browser. Rejecting that input up
//! front turns it into a clean error string (surfaced to JS as an exception),
//! keeping parity with the Python engine's behaviour and bounds.

use chrono::{Duration, NaiveDate};

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
/// Ceiling on the raw dependency-edge count as submitted, before any per-edge
/// pass touches the list. The most fundamental of the edge caps: even the O(E)
/// validation/graph-build pre-passes and the list's own memory become pathological
/// for a multi-million-edge payload. Checked from `.len()`, so the guard is O(1).
/// Mirrors `trueppm_scheduler.engine.MAX_DEPENDENCIES` (#1203).
pub const MAX_DEPENDENCIES: usize = 100_000;
/// Ceiling on calendar exception ranges. Mirrors
/// `trueppm_scheduler.engine.MAX_CALENDAR_EXCEPTIONS` (#1826): a real calendar has
/// at most a few hundred holidays/closures; a multi-million-entry list is
/// pathological and made the index build O(E log E) on hostile input.
pub const MAX_CALENDAR_EXCEPTIONS: usize = 100_000;

/// The Python `datetime.date.max` (9999-12-31). The Python engine bounds a
/// far-future `start_date` against *this* ceiling, not `chrono::NaiveDate::MAX`
/// (~year 262143), so the Rust engine must use the same ceiling to reject the
/// identical inputs (#1826) — otherwise a year-9950 start is rejected by Python
/// but scheduled by Rust.
fn py_date_max() -> NaiveDate {
    NaiveDate::from_ymd_opt(9999, 12, 31).expect("9999-12-31 is a valid date")
}

/// Whether a Python-`timedelta` seconds value is a whole number of days.
///
/// The engines consume durations/lags differently on a sub-day value — Python
/// floors `timedelta.days`, Rust rounds `seconds / 86400` — so a fractional value
/// schedules differently across engines and is rejected up front by both (#1818).
/// A whole-day value is an exact multiple of 86,400 (exactly representable in f64
/// for every value within the duration/lag caps).
fn is_whole_days(seconds: f64) -> bool {
    seconds % 86_400.0 == 0.0
}

/// Reject degenerate input before any calendar walk runs.
///
/// Returns `Err(message)` for: an empty working-day mask, a negative or
/// out-of-range task duration / PERT estimate, an out-of-range dependency lag,
/// an out-of-range `planned_start`/`actual_start`/`actual_finish`/`status_date`,
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
        return Err(
            "Calendar has no working weekday set (working_days bitmask is empty); \
                    at least one of Mon-Sun must be a working day."
                .to_string(),
        );
    }
    // working_days must be a 7-bit mask (#1826). Python's Calendar.from_dict requires
    // 0 <= working_days < 128; a value with bit 7 set (128-255) was rejected by Python
    // but accepted by the Rust `u8` parse (it schedules on the low 7 bits, silently
    // ignoring bit 7), so both engines must reject it identically.
    if (cal.working_days & 0b1000_0000) != 0 {
        return Err(format!(
            "Calendar working_days must be a 7-bit mask in [0, 127] (got {}); bit 7 has \
             no weekday meaning.",
            cal.working_days
        ));
    }
    // Bound the exception-range count (#1826): Python caps this; an unbounded list
    // is pathological and its O(E log E) index build a DoS vector.
    if cal.exceptions.len() > MAX_CALENDAR_EXCEPTIONS {
        return Err(format!(
            "Calendar has {} exception ranges, exceeding the maximum of {}; a real \
             calendar has at most a few hundred holidays or closures.",
            cal.exceptions.len(),
            MAX_CALENDAR_EXCEPTIONS
        ));
    }
    // Inverted exception range (#1826): Python's DateRange.__post_init__ rejects
    // end < start, while the Rust index build silently filtered such ranges as
    // no-ops — a document Python refuses that Rust accepts. Reject it to match.
    for exc in &cal.exceptions {
        if exc.end < exc.start {
            return Err(format!(
                "Calendar exception range end ({}) is before start ({}); a DateRange must \
                 have start <= end.",
                exc.end, exc.start
            ));
        }
    }

    for t in &project.tasks {
        check_whole_days(t.duration, &format!("Task {:?} duration", t.id))?;
        check_duration(
            i64::from(t.duration_days()),
            &format!("Task {:?} duration", t.id),
        )?;
        for (label, secs) in [
            ("optimistic_duration", t.optimistic_duration),
            ("most_likely_duration", t.most_likely_duration),
            ("pessimistic_duration", t.pessimistic_duration),
        ] {
            if let Some(seconds) = secs {
                check_whole_days(seconds, &format!("Task {:?} {}", t.id, label))?;
                let days = (seconds / 86_400.0).round() as i64;
                check_duration(days, &format!("Task {:?} {}", t.id, label))?;
            }
        }

        // A complete three-point estimate must be ordered. An inconsistent one
        // (most_likely outside [optimistic, pessimistic], or optimistic above
        // pessimistic) was previously sampled by the degenerate _sample_pert
        // fallback as the constant most_likely, possibly beyond the user's own
        // pessimistic bound (#1069). Partial estimates are not validated: Monte
        // Carlo only samples when all three are present. Day-granularity match to
        // Python's `.days` comparison (#1085).
        if let (Some(o), Some(m), Some(pe)) = (
            t.optimistic_duration,
            t.most_likely_duration,
            t.pessimistic_duration,
        ) {
            let od = (o / 86_400.0).round() as i64;
            let md = (m / 86_400.0).round() as i64;
            let pd = (pe / 86_400.0).round() as i64;
            if !(od <= md && md <= pd) {
                return Err(format!(
                    "Task {:?} three-point estimates must satisfy optimistic <= most_likely \
                     <= pessimistic (got {od} <= {md} <= {pd} days).",
                    t.id
                ));
            }
        }

        // planned_start (SNET) extends the schedule directly, so it is bounded by
        // the same span cap as durations and lags — otherwise a pin in year 9999
        // is accepted by the bounded calendar walk and drives the day-by-day walk
        // into a multi-million-entry scan (#1086, mirrors Python #1068).
        if let Some(snet) = t.planned_start {
            if (snet - project.start_date).num_days() > MAX_PROJECT_SPAN_DAYS {
                return Err(format!(
                    "Task {:?} planned_start is more than {MAX_PROJECT_SPAN_DAYS} days after the \
                     project start; the schedule cannot be computed within a representable date range.",
                    t.id
                ));
            }
        }
    }

    // status_date (the data date, ADR-0132) shifts the "as of" point used by the
    // progress-aware forward pass, so an unbounded value drives the same
    // day-by-day walk into a multi-million-entry scan as an unbounded
    // planned_start. Unlike the actuals check below, this is not abs()'d — a
    // status_date *before* the project start is not a runaway-span risk, only
    // one after it is. Mirrors Python _validate_project's `status_offset` check.
    let mut status_offset: i64 = 0;
    if let Some(status_date) = project.status_date {
        status_offset = (status_date - project.start_date).num_days();
        if status_offset > MAX_PROJECT_SPAN_DAYS {
            return Err(format!(
                "status_date is more than {MAX_PROJECT_SPAN_DAYS} days after the project \
                 start; the schedule cannot be computed within a representable date range."
            ));
        }
    }

    // Bound the raw edge count (#1203) before the loop below — and every later
    // O(E) pass — iterates it. A `.len()` check, so it rejects a multi-million-edge
    // payload before any per-edge work or the list's memory footprint is the cost.
    if project.dependencies.len() > MAX_DEPENDENCIES {
        return Err(format!(
            "Project has {} dependencies, exceeding the maximum of {}; the graph \
             cannot be scheduled within resource limits.",
            project.dependencies.len(),
            MAX_DEPENDENCIES
        ));
    }

    let mut seen_edges: std::collections::HashSet<(&str, &str)> = std::collections::HashSet::new();
    for dep in &project.dependencies {
        // Duplicate (predecessor, successor) edges diverge between engines (#1817):
        // the Python `nx.DiGraph` overwrites, keeping only the last dependency on a
        // pair, while this engine's `petgraph` keeps parallel edges and applies all
        // of them. Both engines reject a duplicated pair so neither silent behaviour
        // can occur (a self-loop A->A is caught later as a cycle, not here).
        if !seen_edges.insert((dep.predecessor_id.as_str(), dep.successor_id.as_str())) {
            return Err(format!(
                "Duplicate dependency {:?} -> {:?}; each task pair may carry at most one \
                 dependency.",
                dep.predecessor_id, dep.successor_id
            ));
        }
        // Sub-day lag schedules differently across engines and can drive a late date
        // before an early date (#1818); reject a non-whole-day lag like a duration.
        check_whole_days(
            dep.lag,
            &format!(
                "Dependency {:?} -> {:?} lag",
                dep.predecessor_id, dep.successor_id
            ),
        )?;
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
    let mut max_snet_days: i64 = 0;
    // Furthest recorded actual (actual_start or actual_finish) from the project
    // start, in either direction — abs()'d because a far-*past* actual anchors
    // the calendar walk just as badly as a far-future one (#951 precedent, mirrors
    // Python's max_actual_days).
    let mut max_actual_days: i64 = 0;
    for t in &project.tasks {
        // Worst case across the deterministic duration AND every PERT estimate:
        // Monte Carlo falls back to most_likely when the range is degenerate, so
        // most_likely must count too. A complete triple is now validated as
        // ordered (#1069/#1085) so most_likely cannot exceed pessimistic there;
        // only a *partial* estimate can set most_likely above the deterministic
        // duration, which is exactly the case this max() still guards.
        let mut task_max = i64::from(t.duration_days());
        for seconds in [
            t.optimistic_duration,
            t.most_likely_duration,
            t.pessimistic_duration,
        ]
        .into_iter()
        .flatten()
        {
            task_max = task_max.max((seconds / 86_400.0).round() as i64);
        }
        total_span += task_max.max(0);
        if let Some(snet) = t.planned_start {
            max_snet_days = max_snet_days.max((snet - project.start_date).num_days());
        }
        for actual in [t.actual_start, t.actual_finish].into_iter().flatten() {
            max_actual_days = max_actual_days.max((actual - project.start_date).num_days().abs());
        }
    }
    // Recorded actuals (ADR-0132/0136) anchor a completed task's full-duration
    // span and feed the same calendar walk as a planned_start pin, so an actual
    // far from the project start must be bounded the same way — otherwise a
    // year-9999 actual_finish (or an equally distant actual_start) is accepted
    // here and drives the day-by-day walk past the representable date range.
    // Mirrors Python's max_actual_days check.
    if max_actual_days > MAX_PROJECT_SPAN_DAYS {
        return Err(format!(
            "A task actual_start/actual_finish is more than {MAX_PROJECT_SPAN_DAYS} days \
             from the project start; the schedule cannot be computed within a representable \
             date range."
        ));
    }
    for dep in &project.dependencies {
        total_span += dep.lag_days().abs();
    }
    // A planned_start pin, the data-date floor, and a recorded actual each shift
    // work along the timeline, so the furthest of the three adds to the span
    // bound exactly once (they don't accumulate the way durations on a chain
    // do). Mirrors the Python _validate_project (#1086 / #1068, and #1564 for
    // the status_date / actuals terms).
    total_span += max_snet_days.max(status_offset.max(0)).max(max_actual_days);
    if total_span > MAX_PROJECT_SPAN_DAYS {
        return Err(format!(
            "Total project span ({total_span} days across all task durations and lags) \
             exceeds the maximum of {MAX_PROJECT_SPAN_DAYS} days."
        ));
    }

    // Far-future start (#1826): the engine walks in *calendar* days (a weekday-only
    // calendar inflates a working-day span up to 7x) and a single snap advances up
    // to MAX_CALENDAR_SCAN_DAYS. Python rejects a start close enough to date.max
    // (9999-12-31) that the walk would step past it; this engine's `chrono` ceiling
    // is far higher (~262143), so without matching the Python ceiling a year-9950
    // start is rejected by Python but scheduled here. Use the *same* conservative
    // estimate (span x 7 + one scan) against the Python date ceiling.
    let max_calendar_reach = total_span.saturating_mul(7) + MAX_CALENDAR_SCAN_DAYS;
    if (py_date_max() - project.start_date).num_days() < max_calendar_reach {
        return Err(format!(
            "Project start date {} is too close to the maximum representable date for a \
             span of {total_span} working days; the schedule would overflow the date range. \
             Use an earlier start date.",
            project.start_date
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

/// Reject a duration/lag (in seconds) that is not a whole number of days (#1818).
fn check_whole_days(seconds: f64, label: &str) -> Result<(), String> {
    if !is_whole_days(seconds) {
        return Err(format!(
            "{label} must be a whole number of days (got {} days); sub-day durations and \
             lags are not supported and would schedule differently across engines.",
            seconds / 86_400.0
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
            actual_start: None,
            actual_finish: None,
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
            status_date: None,
        }
    }

    #[test]
    fn accepts_a_sane_project() {
        let p = project(vec![task("A", 5)], vec![], Calendar::default());
        assert!(validate_project(&p).is_ok());
    }

    #[test]
    fn rejects_empty_working_day_mask() {
        let cal = Calendar {
            working_days: 0,
            ..Calendar::default()
        };
        let p = project(vec![task("A", 1)], vec![], cal);
        assert!(validate_project(&p).is_err());
    }

    #[test]
    fn rejects_mask_with_only_non_weekday_bits() {
        let cal = Calendar {
            working_days: 0b1000_0000,
            ..Calendar::default()
        };
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
        let p = project(
            vec![task("A", 3), task("A", 2)],
            vec![],
            Calendar::default(),
        );
        assert!(validate_project(&p).is_err());
    }

    #[test]
    fn rejects_duration_over_max() {
        let p = project(
            vec![task("A", MAX_DURATION_DAYS + 1)],
            vec![],
            Calendar::default(),
        );
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
    fn rejects_dependency_count_over_max() {
        // #1203: the raw edge count is capped before the per-edge loop. Every edge
        // references the same two tasks — the length check fires first, so these
        // duplicate A->B edges are never examined, keeping the fixture cheap.
        // Mirrors the Python TestDependencyCount cases at the shared constant.
        let deps: Vec<Dependency> = (0..=MAX_DEPENDENCIES)
            .map(|_| Dependency {
                predecessor_id: "A".to_string(),
                successor_id: "B".to_string(),
                dep_type: DependencyType::FS,
                lag: day(0),
            })
            .collect();
        let p = project(vec![task("A", 1), task("B", 1)], deps, Calendar::default());
        assert!(validate_project(&p).is_err());
    }

    #[test]
    fn rejects_cumulative_span_over_max() {
        // Each task is within the per-task cap, but together they exceed the
        // cumulative project span (11 * 36525 = 401,775 > 366,000).
        let tasks: Vec<Task> = (0..11)
            .map(|i| task(&format!("t{i}"), MAX_DURATION_DAYS))
            .collect();
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

    #[test]
    fn accepts_ordered_three_point_estimate() {
        // #1085: a complete, correctly-ordered triple must pass.
        let mut t = task("A", 3);
        t.optimistic_duration = Some(day(2));
        t.most_likely_duration = Some(day(3));
        t.pessimistic_duration = Some(day(5));
        let p = project(vec![t], vec![], Calendar::default());
        assert!(validate_project(&p).is_ok());
    }

    #[test]
    fn rejects_inconsistent_three_point_estimate() {
        // #1085: most_likely (10) above pessimistic (5) in a complete triple was
        // accepted by Rust but rejected by Python — the engines must agree.
        let mut t = task("A", 3);
        t.optimistic_duration = Some(day(2));
        t.most_likely_duration = Some(day(10));
        t.pessimistic_duration = Some(day(5));
        let p = project(vec![t], vec![], Calendar::default());
        assert!(validate_project(&p).is_err());
    }

    #[test]
    fn ignores_partial_three_point_estimate_ordering() {
        // Only complete triples are ordered-checked; a partial estimate (no
        // optimistic) is not, matching Python.
        let mut t = task("A", 3);
        t.most_likely_duration = Some(day(10));
        t.pessimistic_duration = Some(day(5));
        let p = project(vec![t], vec![], Calendar::default());
        assert!(validate_project(&p).is_ok());
    }

    #[test]
    fn rejects_planned_start_over_span() {
        // #1086: a planned_start pin further than MAX_PROJECT_SPAN_DAYS after the
        // project start was scheduled by Rust but rejected by Python.
        let mut t = task("A", 1);
        t.planned_start = Some(
            NaiveDate::from_ymd_opt(2026, 4, 1).unwrap()
                + chrono::Duration::days(MAX_PROJECT_SPAN_DAYS + 1),
        );
        let p = project(vec![t], vec![], Calendar::default());
        assert!(validate_project(&p).is_err());
    }

    #[test]
    fn rejects_span_via_planned_start_offset() {
        // The furthest planned_start pin adds to the cumulative span bound once.
        // Here the single task duration is small but the pin's offset pushes the
        // total over the cap. (Just under the per-task eager cap so this exercises
        // the accumulator path, not the eager check.)
        let mut t = task("A", MAX_DURATION_DAYS);
        t.planned_start = Some(
            NaiveDate::from_ymd_opt(2026, 4, 1).unwrap()
                + chrono::Duration::days(MAX_PROJECT_SPAN_DAYS),
        );
        let p = project(vec![t], vec![], Calendar::default());
        assert!(validate_project(&p).is_err());
    }

    #[test]
    fn rejects_actual_finish_over_span() {
        // #1564: a far-future actual_finish was accepted by Rust but rejected by
        // Python — the WASM engine never inspected actual_start/actual_finish at
        // all, so a completed task pinned in year 5000 slipped through and drove
        // the day-by-day walk into a soft-hang.
        let mut t = task("A", 1);
        t.actual_finish = Some(
            NaiveDate::from_ymd_opt(2026, 4, 1).unwrap()
                + chrono::Duration::days(MAX_PROJECT_SPAN_DAYS + 1),
        );
        let p = project(vec![t], vec![], Calendar::default());
        assert!(validate_project(&p).is_err());
    }

    #[test]
    fn rejects_actual_start_over_span_in_the_past() {
        // max_actual_days is abs()'d: a far-*past* actual_start anchors the
        // calendar walk just as badly as a far-future one, mirroring Python.
        let mut t = task("A", 1);
        t.actual_start = Some(
            NaiveDate::from_ymd_opt(2026, 4, 1).unwrap()
                - chrono::Duration::days(MAX_PROJECT_SPAN_DAYS + 1),
        );
        let p = project(vec![t], vec![], Calendar::default());
        assert!(validate_project(&p).is_err());
    }

    #[test]
    fn accepts_actual_within_span() {
        let mut t = task("A", 5);
        t.actual_start = Some(NaiveDate::from_ymd_opt(2026, 4, 1).unwrap());
        t.actual_finish = Some(NaiveDate::from_ymd_opt(2026, 4, 6).unwrap());
        let p = project(vec![t], vec![], Calendar::default());
        assert!(validate_project(&p).is_ok());
    }

    #[test]
    fn rejects_status_date_over_span() {
        // #1564: status_date (the data date, ADR-0132) was never bounded by the
        // WASM engine, unlike Python's status_offset check.
        let mut p = project(vec![task("A", 1)], vec![], Calendar::default());
        p.status_date = Some(
            NaiveDate::from_ymd_opt(2026, 4, 1).unwrap()
                + chrono::Duration::days(MAX_PROJECT_SPAN_DAYS + 1),
        );
        assert!(validate_project(&p).is_err());
    }

    #[test]
    fn accepts_status_date_before_project_start() {
        // status_offset is not abs()'d in Python — a status_date before the
        // project start is not a runaway-span risk, so it must not be rejected.
        let mut p = project(vec![task("A", 1)], vec![], Calendar::default());
        p.status_date = Some(NaiveDate::from_ymd_opt(1900, 1, 1).unwrap());
        assert!(validate_project(&p).is_ok());
    }

    #[test]
    fn rejects_span_via_status_date_offset() {
        // The status_date offset folds into the cumulative total_span guard the
        // same way max_snet_days and max_actual_days do: a small per-task
        // duration can still exceed the cap once the status_date offset is added.
        let mut p = project(
            vec![task("A", MAX_DURATION_DAYS)],
            vec![],
            Calendar::default(),
        );
        p.status_date = Some(
            NaiveDate::from_ymd_opt(2026, 4, 1).unwrap()
                + chrono::Duration::days(MAX_PROJECT_SPAN_DAYS),
        );
        assert!(validate_project(&p).is_err());
    }

    fn dep(pred: &str, succ: &str, dt: DependencyType, lag_secs: f64) -> Dependency {
        Dependency {
            predecessor_id: pred.to_string(),
            successor_id: succ.to_string(),
            dep_type: dt,
            lag: lag_secs,
        }
    }

    #[test]
    fn rejects_duplicate_edge() {
        // #1817: the same (pred,succ) pair twice — Python's DiGraph keeps only the
        // last, this engine's petgraph keeps both; reject so neither diverges.
        let deps = vec![
            dep("A", "B", DependencyType::FS, 0.0),
            dep("A", "B", DependencyType::SS, day(1)),
        ];
        let p = project(vec![task("A", 5), task("B", 3)], deps, Calendar::default());
        assert!(validate_project(&p).is_err());
    }

    #[test]
    fn accepts_same_pair_reversed_is_not_a_duplicate() {
        // A->B and B->A are distinct edges (and would form a cycle caught later),
        // not a duplicate — the duplicate guard keys on the ordered pair.
        let deps = vec![dep("A", "B", DependencyType::FS, 0.0)];
        let p = project(vec![task("A", 5), task("B", 3)], deps, Calendar::default());
        assert!(validate_project(&p).is_ok());
    }

    #[test]
    fn rejects_fractional_duration() {
        // #1818: 1.5-day duration schedules differently across engines (Python floor,
        // Rust round); reject a non-whole-day value.
        let p = project(vec![task("A", 0)], vec![], Calendar::default());
        let mut p = p;
        p.tasks[0].duration = 129_600.0; // 1.5 days
        assert!(validate_project(&p).is_err());
    }

    #[test]
    fn rejects_fractional_lag() {
        // #1818: a 12-hour lag; sub-day lags can drive a late date before an early one.
        let deps = vec![dep("A", "B", DependencyType::SS, 43_200.0)];
        let p = project(vec![task("A", 2), task("B", 2)], deps, Calendar::default());
        assert!(validate_project(&p).is_err());
    }

    #[test]
    fn rejects_fractional_pert_estimate() {
        let mut t = task("A", 3);
        t.most_likely_duration = Some(129_600.0); // 1.5 days
        let p = project(vec![t], vec![], Calendar::default());
        assert!(validate_project(&p).is_err());
    }

    #[test]
    fn rejects_working_days_with_bit7_set() {
        // #1826: working_days=200 has weekday bits (so it passes the empty-mask check)
        // AND bit 7 set. Python rejects (must be in [0,127]); this engine used to
        // accept and schedule on the low 7 bits.
        let cal = Calendar {
            working_days: 200,
            ..Calendar::default()
        };
        let p = project(vec![task("A", 1)], vec![], cal);
        assert!(validate_project(&p).is_err());
    }

    #[test]
    fn rejects_inverted_exception_range() {
        // #1826: end < start. Python's DateRange rejects it; this engine silently
        // filtered it as a no-op.
        let cal = Calendar {
            exceptions: vec![DateRange {
                start: NaiveDate::from_ymd_opt(2026, 4, 10).unwrap(),
                end: NaiveDate::from_ymd_opt(2026, 4, 5).unwrap(),
            }],
            ..Calendar::default()
        };
        let p = project(vec![task("A", 1)], vec![], cal);
        assert!(validate_project(&p).is_err());
    }

    #[test]
    fn rejects_too_many_calendar_exceptions() {
        // #1826: a multi-million-entry exceptions list is pathological; Python caps it.
        let one = DateRange {
            start: NaiveDate::from_ymd_opt(2027, 1, 1).unwrap(),
            end: NaiveDate::from_ymd_opt(2027, 1, 1).unwrap(),
        };
        let cal = Calendar {
            exceptions: vec![one; MAX_CALENDAR_EXCEPTIONS + 1],
            ..Calendar::default()
        };
        let p = project(vec![task("A", 1)], vec![], cal);
        assert!(validate_project(&p).is_err());
    }

    #[test]
    fn rejects_far_future_start() {
        // #1826: a start within ~100 years of the Python date.max (9999-12-31). Python
        // rejects it; this engine's chrono ceiling (~year 262143) accepted it.
        let mut p = project(vec![task("A", 5)], vec![], Calendar::default());
        p.start_date = NaiveDate::from_ymd_opt(9990, 1, 1).unwrap();
        assert!(validate_project(&p).is_err());
    }

    #[test]
    fn accepts_normal_start_far_from_date_max() {
        // The far-future guard must not reject an ordinary 21st-century start.
        let p = project(vec![task("A", 5)], vec![], Calendar::default());
        assert!(validate_project(&p).is_ok());
    }
}
