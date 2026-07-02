//! Core data structures for the TruePPM WASM scheduler.
//!
//! These mirror the Python `trueppm_scheduler.models` module exactly.
//! Field names, JSON serialization format, and semantics must stay in sync
//! with the Python implementation — the shared fixture suite enforces this.

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

/// Relationship type between two tasks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DependencyType {
    FS,
    FF,
    SS,
    SF,
}

/// A contiguous range of dates (inclusive on both ends).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DateRange {
    pub start: NaiveDate,
    pub end: NaiveDate,
}

/// A schedulable unit of work.
///
/// Duration and float fields use working days (integers), matching the Python
/// `timedelta(days=N)` convention where `total_seconds() / 86400 = N`.
///
/// `deny_unknown_fields` (#1505): the Python `Task` model carries scheduling-
/// affecting fields this engine does not yet implement — `calendar_id` (per-task
/// calendars, ADR-0120 D3) and `delivery_mode`/`story_points`. Silently ignoring
/// them would make the WASM engine schedule a task on the wrong calendar and
/// quietly disagree with the server. Rejecting the input at parse time is honest:
/// the offline recompute refuses work it cannot faithfully reproduce rather than
/// returning wrong dates. Progress fields (`actual_start`/`actual_finish`/
/// `percent_complete`, ADR-0132) are now consumed — see the forward/backward pass.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Task {
    pub id: String,
    pub name: String,
    /// Duration in seconds (Python timedelta.total_seconds()).
    /// Divide by 86400 to get working days.
    pub duration: f64,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planned_start: Option<NaiveDate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planned_finish: Option<NaiveDate>,

    // CPM-computed dates (populated by the engine)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub early_start: Option<NaiveDate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub early_finish: Option<NaiveDate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub late_start: Option<NaiveDate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub late_finish: Option<NaiveDate>,

    /// Total float in seconds (divide by 86400 for working days).
    #[serde(default)]
    pub total_float: f64,
    /// Free float in seconds (divide by 86400 for working days).
    #[serde(default)]
    pub free_float: f64,

    #[serde(default)]
    pub is_critical: bool,
    #[serde(default)]
    pub percent_complete: f64,

    // Actuals (ADR-0132). `actual_finish` (or `percent_complete >= 100`) marks a
    // task complete: it is pinned to its recorded span at full duration and taken
    // out of network logic. `actual_start` records when work began. Both mirror
    // the Python `Task` dataclass fields of the same name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual_start: Option<NaiveDate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual_finish: Option<NaiveDate>,

    // Three-point PERT estimates (seconds)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub optimistic_duration: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub most_likely_duration: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pessimistic_duration: Option<f64>,
}

impl Task {
    /// Duration in working days.
    pub fn duration_days(&self) -> i32 {
        (self.duration / 86400.0).round() as i32
    }

    /// Whether the task counts as finished for layout purposes (ADR-0136).
    ///
    /// True when an `actual_finish` is recorded *or* `percent_complete` has
    /// reached 100. Mirrors the Python `_is_complete`: the dataclass has no
    /// `status` field, so completion is read from these two facts alone. A
    /// completed task is laid out at its *full* duration, never through
    /// [`effective_duration_days`](Self::effective_duration_days).
    pub fn is_complete(&self) -> bool {
        self.actual_finish.is_some() || self.percent_complete >= 100.0
    }

    /// Working-day duration of the *remaining* work on a task (ADR-0132).
    ///
    /// A not-started task (`percent_complete <= 0`) contributes its full
    /// estimate; an in-progress task contributes `duration - floor(duration *
    /// pct/100)`, clamped to `[0, duration]`. The elapsed portion truncates like
    /// Python's `int(...)` so the two engines agree bit-for-bit (the conformance
    /// contract). A completed task is laid out at full duration by the caller and
    /// never routed through here.
    pub fn effective_duration_days(&self) -> i32 {
        let full = self.duration_days();
        let pct = self.percent_complete;
        if pct <= 0.0 {
            return full;
        }
        // Truncate toward zero, matching Python `int(full * min(pct,100)/100)`.
        let elapsed = (f64::from(full) * pct.min(100.0) / 100.0) as i32;
        (full - elapsed).max(0)
    }
}

/// A precedence relationship between two tasks.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Dependency {
    pub predecessor_id: String,
    pub successor_id: String,
    #[serde(default = "default_dep_type")]
    pub dep_type: DependencyType,
    /// Lag in seconds (Python timedelta.total_seconds()).
    /// Divide by 86400 for calendar days.
    #[serde(default)]
    pub lag: f64,
}

fn default_dep_type() -> DependencyType {
    DependencyType::FS
}

impl Dependency {
    /// Lag as a chrono Duration in calendar days.
    pub fn lag_days(&self) -> i64 {
        (self.lag / 86400.0).round() as i64
    }
}

/// Defines working time for scheduling calculations.
///
/// `working_days` is a 7-bit mask where bit 0 = Monday, bit 6 = Sunday.
/// Default `0b0011111` = Mon–Fri.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Calendar {
    #[serde(default = "default_working_days")]
    pub working_days: u8,
    #[serde(default)]
    pub exceptions: Vec<DateRange>,
    #[serde(default = "default_hours_per_day")]
    pub hours_per_day: f64,
    #[serde(default = "default_timezone")]
    pub timezone: String,
}

fn default_working_days() -> u8 {
    0b0011111
}
fn default_hours_per_day() -> f64 {
    8.0
}
fn default_timezone() -> String {
    "UTC".to_string()
}

impl Default for Calendar {
    fn default() -> Self {
        Self {
            working_days: default_working_days(),
            exceptions: Vec::new(),
            hours_per_day: default_hours_per_day(),
            timezone: default_timezone(),
        }
    }
}

/// Top-level container for a scheduled project.
///
/// `deny_unknown_fields` (#1505): rejects a project that carries Python-only
/// fields this engine does not implement — the `calendars` per-task registry
/// (ADR-0120 D3) or `velocity_samples`/`sprint_length_days` (agile Monte Carlo).
/// See the `Task` note above: honest rejection beats a silently-wrong offline
/// schedule. `status_date` (the data date, ADR-0132) is now consumed by the
/// progress-aware forward pass.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub start_date: NaiveDate,
    #[serde(default)]
    pub tasks: Vec<Task>,
    #[serde(default)]
    pub dependencies: Vec<Dependency>,
    #[serde(default)]
    pub calendar: Calendar,
    /// The data date (ADR-0132): remaining and not-started work is floored here,
    /// so future work is never scheduled in the past. `None` → a pure planning
    /// pass identical to the pre-progress behaviour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_date: Option<NaiveDate>,
}

/// Output of a CPM schedule calculation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleResult {
    pub project_id: String,
    pub project_start: NaiveDate,
    pub project_finish: NaiveDate,
    pub tasks: Vec<TaskResult>,
    pub critical_path: Vec<String>,
}

/// Per-task CPM output (subset of Task fields for the result JSON).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskResult {
    pub id: String,
    pub early_start: NaiveDate,
    pub early_finish: NaiveDate,
    pub late_start: NaiveDate,
    pub late_finish: NaiveDate,
    pub total_float: f64,
    pub free_float: f64,
    pub is_critical: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(days: f64, pct: f64) -> Task {
        Task {
            id: "t".into(),
            name: "t".into(),
            duration: days * 86400.0,
            planned_start: None,
            planned_finish: None,
            early_start: None,
            early_finish: None,
            late_start: None,
            late_finish: None,
            total_float: 0.0,
            free_float: 0.0,
            is_critical: false,
            percent_complete: pct,
            actual_start: None,
            actual_finish: None,
            optimistic_duration: None,
            most_likely_duration: None,
            pessimistic_duration: None,
        }
    }

    #[test]
    fn is_complete_reads_actual_finish_and_percent() {
        assert!(!task(5.0, 0.0).is_complete());
        assert!(!task(5.0, 99.9).is_complete());
        assert!(task(5.0, 100.0).is_complete());
        let mut t = task(5.0, 0.0);
        t.actual_finish = Some(NaiveDate::from_ymd_opt(2026, 4, 6).unwrap());
        assert!(t.is_complete());
    }

    #[test]
    fn effective_duration_truncates_like_python_int() {
        // Not started: full duration.
        assert_eq!(task(10.0, 0.0).effective_duration_days(), 10);
        assert_eq!(task(10.0, -5.0).effective_duration_days(), 10);
        // 40% of 10d elapsed = int(4.0) → 6 remaining.
        assert_eq!(task(10.0, 40.0).effective_duration_days(), 6);
        // 45% of 10d elapsed = int(4.5) → truncates to 4 → 6 remaining.
        assert_eq!(task(10.0, 45.0).effective_duration_days(), 6);
        // Over-100 is capped, never negative.
        assert_eq!(task(10.0, 150.0).effective_duration_days(), 0);
    }
}
