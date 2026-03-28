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
pub struct DateRange {
    pub start: NaiveDate,
    pub end: NaiveDate,
}

/// A schedulable unit of work.
///
/// Duration and float fields use working days (integers), matching the Python
/// `timedelta(days=N)` convention where `total_seconds() / 86400 = N`.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
}

/// A precedence relationship between two tasks.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
#[derive(Debug, Clone, Serialize, Deserialize)]
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
