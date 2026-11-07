//! Core data structures for the TruePPM WASM scheduler.
//!
//! These mirror the Python `trueppm_scheduler.models` module exactly.
//! Field names, JSON serialization format, and semantics must stay in sync
//! with the Python implementation — the shared fixture suite enforces this.

use std::cell::OnceCell;

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

/// Parse-time checks for fields this engine ignores but the shared document
/// contract constrains, so both engines accept the same set (#4708).
pub mod enum_serde {
    use serde::{de::Error, Deserialize, Deserializer};

    /// `deserialize_with` for `delivery_mode`: `null`/absent stay `None`; any other
    /// value must be one of the Python `DeliveryMode` values.
    pub fn delivery_mode<'de, D: Deserializer<'de>>(de: D) -> Result<Option<String>, D::Error> {
        match Option::<String>::deserialize(de)? {
            None => Ok(None),
            Some(s) if s == "waterfall" || s == "scrum" => Ok(Some(s)),
            Some(s) => Err(D::Error::custom(format!(
                "Invalid delivery_mode {s:?}; must be one of: waterfall, scrum."
            ))),
        }
    }

    /// `deserialize_with` for an optional integer field (`sprint_length_days`).
    ///
    /// Python pins this to an `int` (`10.0`, `true` and `"10"` are refused), so the
    /// check reads the raw JSON token: only an integer token passes, not a float
    /// that happens to be whole.
    pub fn integral_opt<'de, D: Deserializer<'de>>(de: D) -> Result<Option<f64>, D::Error> {
        match Option::<serde_json::Number>::deserialize(de)? {
            None => Ok(None),
            Some(n) if n.is_i64() || n.is_u64() => Ok(n.as_f64()),
            Some(n) => Err(D::Error::custom(format!(
                "sprint_length_days must be an integer (got {n})"
            ))),
        }
    }
}

/// Strict `YYYY-MM-DD` date deserialization (#4707).
///
/// chrono's `NaiveDate` serde `FromStr` is lenient: it accepts `2026-3-2`, padded
/// whitespace, `+2026-03-02` and negative years, none of which Python's strict
/// pre-check (`Project.from_dict`) accepts, and it has no lower bound where Python's
/// `date.min` is 0001-01-01. A document the server refuses with a 400 must not be
/// schedulable offline, so every date field goes through this shape: exactly ten
/// ASCII characters, `\d{4}-\d{2}-\d{2}`, and a year of at least 1.
pub mod date_serde {
    use chrono::{Datelike, NaiveDate};
    use serde::{de::Error, Deserialize, Deserializer};

    /// Parse a canonical `YYYY-MM-DD` string, or describe why it is refused.
    pub fn parse_strict(s: &str) -> Result<NaiveDate, String> {
        let b = s.as_bytes();
        let shaped = b.len() == 10
            && b.iter().enumerate().all(|(i, c)| match i {
                4 | 7 => *c == b'-',
                _ => c.is_ascii_digit(),
            });
        if !shaped {
            return Err(format!("date {s:?} is not in canonical YYYY-MM-DD form"));
        }
        let d = NaiveDate::parse_from_str(s, "%Y-%m-%d")
            .map_err(|e| format!("invalid date {s:?}: {e}"))?;
        if d.year() < 1 {
            return Err(format!(
                "date {s:?} is before 0001-01-01, the earliest representable date"
            ));
        }
        Ok(d)
    }

    /// `deserialize_with` for a required date field.
    pub fn req<'de, D: Deserializer<'de>>(de: D) -> Result<NaiveDate, D::Error> {
        let s = String::deserialize(de)?;
        parse_strict(&s).map_err(D::Error::custom)
    }

    /// `deserialize_with` for an optional date field (`null` and absent stay `None`).
    pub fn opt<'de, D: Deserializer<'de>>(de: D) -> Result<Option<NaiveDate>, D::Error> {
        match Option::<String>::deserialize(de)? {
            None => Ok(None),
            Some(s) => parse_strict(&s).map(Some).map_err(D::Error::custom),
        }
    }
}

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
    #[serde(deserialize_with = "date_serde::req")]
    pub start: NaiveDate,
    #[serde(deserialize_with = "date_serde::req")]
    pub end: NaiveDate,
}

/// A schedulable unit of work.
///
/// Duration and float fields use working days (integers), matching the Python
/// `timedelta(days=N)` convention where `total_seconds() / 86400 = N`.
///
/// `deny_unknown_fields` (#1505): rejects a genuinely-unknown key. The remaining
/// fields the Python `Task` model carries — `calendar_id` (per-task calendars,
/// ADR-0120 D3) and `delivery_mode`/`story_points` (agile Monte Carlo) — are
/// *declared* below so the canonical `Project.to_json()` output (which always emits
/// them, as `null` when unset) parses instead of being refused (#1816). A set
/// `calendar_id` is **honored**, not rejected: since #1504 this engine resolves
/// per-task calendars through `calendar::PassCalendars`, matching the Python
/// deterministic schedule. `delivery_mode`/`story_points` remain accepted and
/// ignored (they never affect a deterministic CPM result). Progress fields
/// (`actual_start`/`actual_finish`/`percent_complete`, ADR-0132) are consumed by the
/// forward/backward pass.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Task {
    pub id: String,
    pub name: String,
    /// Duration in seconds (Python timedelta.total_seconds()).
    /// Divide by 86400 to get working days.
    pub duration: f64,

    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "date_serde::opt"
    )]
    pub planned_start: Option<NaiveDate>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "date_serde::opt"
    )]
    pub planned_finish: Option<NaiveDate>,

    // CPM-computed dates (populated by the engine)
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "date_serde::opt"
    )]
    pub early_start: Option<NaiveDate>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "date_serde::opt"
    )]
    pub early_finish: Option<NaiveDate>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "date_serde::opt"
    )]
    pub late_start: Option<NaiveDate>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "date_serde::opt"
    )]
    pub late_finish: Option<NaiveDate>,

    /// Span start (ADR-0752), populated by the engine. `early_start` means the
    /// *remaining-work window* start for an in-progress task (ADR-0132);
    /// `scheduled_start` means the task's whole span instead. See
    /// `forward::compute_scheduled_start` for the per-state derivation table.
    /// No `scheduled_finish` field exists — it is always identical to
    /// `early_finish`, so callers read that under its existing name.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "date_serde::opt"
    )]
    pub scheduled_start: Option<NaiveDate>,

    /// Where a zero-duration milestone sits within the day it is shown on (#4079),
    /// populated by the engine: `true` = the END of `early_start`'s day (it
    /// follows work), `false` = the start of it (held by a floor or an SS link
    /// from work), and always `false` for anything that is not a network-placed
    /// milestone. Mirrors the Python `Task.milestone_at_day_end`; declared so the
    /// canonical `Project.to_json()` output, which always emits it, parses under
    /// `deny_unknown_fields`. An input value is ignored and overwritten.
    #[serde(default, skip_serializing_if = "is_false")]
    pub milestone_at_day_end: bool,
    /// Input only, read on a completed milestone with recorded actuals (#4525):
    /// the day the caller's previous run showed it on at the end of the day (that
    /// run's `early_finish` with `milestone_at_day_end` true), or `None`. While a
    /// predecessor is still open and it names the recorded day, the closed
    /// milestone keeps that end-of-day edge. Mirrors the Python
    /// `Task.live_day_end_on`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "date_serde::opt"
    )]
    pub live_day_end_on: Option<NaiveDate>,

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
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "date_serde::opt"
    )]
    pub actual_start: Option<NaiveDate>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "date_serde::opt"
    )]
    pub actual_finish: Option<NaiveDate>,

    // Three-point PERT estimates (seconds)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub optimistic_duration: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub most_likely_duration: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pessimistic_duration: Option<f64>,

    // Declared so the canonical `Project.to_json()` output — which always emits these
    // keys (as `null` when unset) — parses instead of being rejected by
    // `deny_unknown_fields` (#1816). `calendar_id` (per-task calendars, ADR-0120 D3)
    // names an entry in the project's `calendars` registry and is honored by both
    // engines since #1504; an id naming no entry in a non-empty registry is refused
    // (#4516, see `validate::check_calendar_id_known`), and with no registry it is ignored.
    // `delivery_mode`/`story_points` drive Monte Carlo only — which this engine does not
    // run — so they never affect a deterministic CPM result and are accepted and ignored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "enum_serde::delivery_mode"
    )]
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

    /// Whether this is live work whose start is a recorded fact (#4523).
    ///
    /// Mirrors the Python `_start_is_recorded`: a task with work, not complete,
    /// carrying an `actual_start`. Its `early_start` is the start of its remaining
    /// work (ADR-0132), floored at the data date, so it moves with every status
    /// update; the start itself happened on `actual_start` and does not.
    pub fn start_is_recorded(&self) -> bool {
        self.actual_start.is_some() && self.duration_days() > 0 && !self.is_complete()
    }

    /// Working days of the span before the remaining-work window (#4523).
    ///
    /// Mirrors the Python `_elapsed_link_days`: non-zero only for live work with
    /// progress and no recorded `actual_start`, whose span start
    /// (`scheduled_start`, ADR-0752) is backed off from `early_finish` — exactly
    /// this many working days before `early_start`.
    pub fn elapsed_link_days(&self) -> i32 {
        if self.actual_start.is_some() || self.duration_days() <= 0 || self.is_complete() {
            return 0;
        }
        self.duration_days() - self.effective_duration_days()
    }

    /// The start an SS or SF link out of this task measures from (ADR-0132 §2a).
    ///
    /// Mirrors the Python `_link_start`: the task's link start (when it started,
    /// or is forecast to have started), never its remaining-work window — the recorded `actual_start` of a started task, the
    /// derived `scheduled_start` of live work with progress and no recorded start,
    /// otherwise `early_start`. Must be called after the forward pass set this
    /// task's `early_start` and `scheduled_start`.
    pub fn link_start(&self) -> NaiveDate {
        if self.start_is_recorded() {
            return self
                .actual_start
                .expect("start_is_recorded implies actual_start");
        }
        if self.elapsed_link_days() > 0 {
            return self
                .scheduled_start
                .expect("scheduled_start set before a successor reads it");
        }
        self.early_start
            .expect("early_start set before a successor reads it")
    }

    /// Whether `dep_type` out of this task measures from a recorded start (#4523).
    ///
    /// Mirrors the Python `_start_fixed_link`: such a link cannot be moved by this
    /// task's remaining work, so it imposes no late-date bound on it and gives it
    /// no free-float limit; it can still be a successor's driving edge. A link from
    /// a *derived* span start is not one: that start slips with the remaining work
    /// and keeps its bound (`backward::window_start_bound`).
    pub fn start_fixed_link(&self, dep_type: DependencyType) -> bool {
        matches!(dep_type, DependencyType::SS | DependencyType::SF) && self.start_is_recorded()
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
    /// Memoized, sorted-and-coalesced exception day-ordinal ranges, plus a prefix
    /// sum of each run's mask-working-day count (`(ranges, prefix)`), built lazily
    /// on the first `is_working_day` call so the exception test is O(log X)
    /// instead of an O(X) linear scan per day across the CPM passes (#1534), and
    /// so a span crossing many gap-separated runs costs O(log X) rather than
    /// O(runs) (#4176). Not part of the wire format — `#[serde(skip)]` keeps it
    /// out of the shared JSON that the conformance fixtures compare, and it
    /// defaults to empty (rebuilt on demand) after any deserialize or clone.
    ///
    /// Built once against `working_days` at that time: nothing in this crate
    /// mutates `working_days` on a live `Calendar` after construction (it is set
    /// only by the struct literal or `Deserialize`), so — unlike the Python
    /// engine's `Calendar`, which is mutable and keys its equivalent cache on the
    /// mask too (#4176) — no mask-change invalidation is needed here.
    #[serde(skip)]
    pub(crate) exception_index: OnceCell<ExceptionIndex>,
}

/// Coalesced exception runs as `(start, end)` inclusive-ordinal pairs, sorted and
/// disjoint, plus a prefix sum of each run's own mask-working-day count — the
/// second element's `[i]` is the total mask-working days across runs `0..i`. See
/// [`Calendar::exception_index`].
pub(crate) type ExceptionIndex = (Vec<(i32, i32)>, Vec<i32>);

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
/// `deny_unknown_fields` (#1505): rejects a genuinely-unknown key. The `calendars`
/// per-task registry (ADR-0120 D3) and `velocity_samples`/`sprint_length_days` (agile
/// Monte Carlo) are *declared* below so the canonical `Project.to_json()` output
/// (which always emits them, as `null` when unset) parses (#1816). A non-empty
/// `calendars` registry is **honored**, not rejected: since #1504 each entry is
/// validated like the pass-level calendar and resolved per task. The agile fields are
/// accepted and ignored. See the `Task` note above. `status_date` (the data date,
/// ADR-0132) is consumed by the progress-aware forward pass.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(deserialize_with = "date_serde::req")]
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
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "date_serde::opt"
    )]
    pub status_date: Option<NaiveDate>,

    // Declared so the canonical `Project.to_json()` output parses instead of being
    // rejected by `deny_unknown_fields` (#1816). `calendars` (the per-task calendar
    // registry, ADR-0120 D3) *does* affect the deterministic schedule, and this engine
    // honors it since #1504 — `validate::validate_task_calendars` applies the same
    // checks to every entry that the pass-level calendar gets.
    // `velocity_samples`/`sprint_length_days` feed agile Monte Carlo only, which this
    // engine does not run, so they are accepted and ignored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendars: Option<std::collections::HashMap<String, Calendar>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub velocity_samples: Option<Vec<Option<f64>>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "enum_serde::integral_opt"
    )]
    pub sprint_length_days: Option<f64>,
}

/// Output of a CPM schedule calculation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleResult {
    pub project_id: String,
    #[serde(deserialize_with = "date_serde::req")]
    pub project_start: NaiveDate,
    #[serde(deserialize_with = "date_serde::req")]
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
    #[serde(deserialize_with = "date_serde::req")]
    pub early_start: NaiveDate,
    #[serde(deserialize_with = "date_serde::req")]
    pub early_finish: NaiveDate,
    #[serde(deserialize_with = "date_serde::req")]
    pub late_start: NaiveDate,
    #[serde(deserialize_with = "date_serde::req")]
    pub late_finish: NaiveDate,
    pub total_float: f64,
    pub free_float: f64,
    pub is_critical: bool,
    /// The task's span start (ADR-0752) — see `Task::scheduled_start`.
    #[serde(deserialize_with = "date_serde::req")]
    pub scheduled_start: NaiveDate,
    /// A milestone shown at the end of its day (#4079) — see
    /// `Task::milestone_at_day_end`. Omitted when false, matching the shared
    /// conformance snapshots.
    #[serde(default, skip_serializing_if = "is_false")]
    pub milestone_at_day_end: bool,
}

/// `skip_serializing_if` predicate for a defaulted `bool`.
fn is_false(b: &bool) -> bool {
    !*b
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
            scheduled_start: None,
            milestone_at_day_end: false,
            live_day_end_on: None,
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

#[cfg(test)]
mod date_serde_tests {
    use super::date_serde::parse_strict;

    #[test]
    fn accepts_canonical_and_bounds() {
        assert!(parse_strict("2026-03-02").is_ok());
        assert!(parse_strict("0001-01-01").is_ok());
        assert!(parse_strict("9999-12-31").is_ok());
    }

    #[test]
    fn refuses_non_canonical_forms_and_years_below_one() {
        for bad in [
            "2026-3-2",
            " 2026-03-02",
            "2026-03-02 ",
            "+2026-03-02",
            "-0001-01-01",
            "0000-12-28",
            "20260302",
            "2026-02-30",
            "２０２６-03-02",
            "",
        ] {
            assert!(parse_strict(bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn project_json_rejects_lenient_optional_date() {
        let doc = r#"{"id":"p","name":"p","start_date":"2026-03-02","status_date":"2026-3-2",
            "tasks":[],"dependencies":[],"calendar":{"working_days":31,"exceptions":[]}}"#;
        assert!(serde_json::from_str::<super::Project>(doc).is_err());
    }

    /// Every date field must refuse a non-canonical value, so an `Option` field
    /// losing its `deserialize_with` (which falls back to chrono's lenient parse)
    /// is caught here rather than in production.
    #[test]
    fn every_date_field_refuses_a_non_canonical_value() {
        use serde_json::{json, Value};
        let task_fields = [
            "planned_start",
            "planned_finish",
            "early_start",
            "early_finish",
            "late_start",
            "late_finish",
            "scheduled_start",
            "live_day_end_on",
            "actual_start",
            "actual_finish",
        ];
        let template = || {
            json!({
                "id": "p", "name": "p", "start_date": "2026-03-02", "status_date": "2026-03-02",
                "tasks": [{"id": "a", "name": "a", "duration": 86400.0}],
                "dependencies": [],
                "calendar": {"working_days": 31,
                    "exceptions": [{"start": "2026-03-02", "end": "2026-03-03"}]}
            })
        };
        let canonical: Value = template();
        assert!(serde_json::from_value::<super::Project>(canonical).is_ok());

        let mut docs: Vec<(String, Value)> = Vec::new();
        for f in ["start_date", "status_date"] {
            let mut d = template();
            d[f] = json!("2026-3-2");
            docs.push((f.to_string(), d));
        }
        for f in ["start", "end"] {
            let mut d = template();
            d["calendar"]["exceptions"][0][f] = json!("2026-3-2");
            docs.push((format!("exception.{f}"), d));
        }
        for f in task_fields {
            let mut d = template();
            d["tasks"][0][f] = json!("2026-3-2");
            docs.push((format!("task.{f}"), d));
        }
        for (name, doc) in docs {
            assert!(
                serde_json::from_value::<super::Project>(doc).is_err(),
                "{name} accepted a non-canonical date"
            );
        }
        // The same field set with canonical values still parses.
        for f in task_fields {
            let mut d = template();
            d["tasks"][0][f] = json!("2026-03-02");
            assert!(serde_json::from_value::<super::Project>(d).is_ok(), "task.{f}");
        }
    }
}
