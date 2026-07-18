//! Core data structures for the TruePPM WASM scheduler.
//!
//! These mirror the Python `trueppm_scheduler.models` module exactly.
//! Field names, JSON serialization format, and semantics must stay in sync
//! with the Python implementation — the shared fixture suite enforces this.

use std::cell::OnceCell;

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

impl DependencyType {
    /// The serialized tag (`"FS"`/`"FF"`/`"SS"`/`"SF"`) — matches serde output and
    /// the Python `DependencyType.value`. Used to sort driving edges by the same
    /// key the Python engine uses (a *string* sort, not the enum discriminant),
    /// keeping the two engines' `driving_edges` order identical for conformance.
    pub fn as_str(&self) -> &'static str {
        match self {
            DependencyType::FS => "FS",
            DependencyType::FF => "FF",
            DependencyType::SS => "SS",
            DependencyType::SF => "SF",
        }
    }
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
/// `deny_unknown_fields` (#1505): rejects a genuinely-unknown key. The Python-only
/// fields the `Task` model carries — `calendar_id` (per-task calendars, ADR-0120 D3)
/// and `delivery_mode`/`story_points` (agile Monte Carlo) — are now *declared* below
/// so the canonical `Project.to_json()` output (which always emits them, as `null`
/// when unset) parses instead of being refused (#1816). A *set* `calendar_id` is
/// still rejected — in `validate.rs`, since this engine shares one calendar and
/// cannot reproduce a per-task one — while `delivery_mode`/`story_points` are
/// accepted and ignored (they never affect a deterministic CPM result). Progress
/// fields (`actual_start`/`actual_finish`/`percent_complete`, ADR-0132) are consumed
/// by the forward/backward pass.
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

    // Python-only fields, declared so the canonical `Project.to_json()` output — which
    // always emits these keys (as `null` when unset) — parses instead of being rejected
    // by `deny_unknown_fields` (#1816). `calendar_id` (per-task calendars, ADR-0120 D3)
    // *is* honored by the Python deterministic schedule, so a non-null value is rejected
    // in `validate.rs` (this engine cannot reproduce it). `delivery_mode`/`story_points`
    // drive Monte Carlo only — which this engine does not run — so they never affect a
    // deterministic CPM result and are accepted and ignored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub story_points: Option<f64>,
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
    /// Memoized, sorted-and-merged exception day-ordinal ranges, built lazily on
    /// the first `is_working_day` call so the exception test is O(log X) instead
    /// of an O(X) linear scan per day across the CPM passes (#1534). Not part of
    /// the wire format — `#[serde(skip)]` keeps it out of the shared JSON that the
    /// conformance fixtures compare, and it defaults to empty (rebuilt on demand)
    /// after any deserialize or clone.
    #[serde(skip)]
    pub(crate) exception_index: OnceCell<Vec<(i32, i32)>>,
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
            exception_index: OnceCell::new(),
        }
    }
}

/// Top-level container for a scheduled project.
///
/// `deny_unknown_fields` (#1505): rejects a genuinely-unknown key. The Python-only
/// `calendars` per-task registry (ADR-0120 D3) and `velocity_samples`/
/// `sprint_length_days` (agile Monte Carlo) are now *declared* below so the canonical
/// `Project.to_json()` output (which always emits them, as `null` when unset) parses
/// (#1816). A *non-empty* `calendars` registry is still rejected in `validate.rs`
/// (this engine shares one calendar); the agile fields are accepted and ignored. See
/// the `Task` note above. `status_date` (the data date, ADR-0132) is consumed by the
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

    // Python-only fields, declared so the canonical `Project.to_json()` output parses
    // instead of being rejected by `deny_unknown_fields` (#1816). `calendars` (the
    // per-task calendar registry, ADR-0120 D3) *does* affect the deterministic
    // schedule, so a non-empty registry is rejected in `validate.rs` (this engine
    // cannot honor it). `velocity_samples`/`sprint_length_days` feed agile Monte Carlo
    // only, which this engine does not run, so they are accepted and ignored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendars: Option<std::collections::HashMap<String, Calendar>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub velocity_samples: Option<Vec<Option<f64>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sprint_length_days: Option<f64>,
}

/// Output of a CPM schedule calculation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleResult {
    pub project_id: String,
    pub project_start: NaiveDate,
    pub project_finish: NaiveDate,
    pub tasks: Vec<TaskResult>,
    pub critical_path: Vec<String>,
    /// Dependencies whose relationship free float is zero (#2095). Sorted by
    /// `(predecessor_id, successor_id, dep_type_str)` to match the Python engine's
    /// deterministic order.
    #[serde(default)]
    pub driving_edges: Vec<DrivingEdge>,
}

/// A dependency whose relationship free float is zero — the predecessor that
/// drives the successor's early date (#2095). Purely presentational metadata; the
/// forward/backward passes and float values are unaffected.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrivingEdge {
    pub predecessor_id: String,
    pub successor_id: String,
    pub dep_type: DependencyType,
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
            calendar_id: None,
            delivery_mode: None,
            story_points: None,
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
