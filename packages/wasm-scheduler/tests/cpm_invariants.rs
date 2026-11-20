//! Property-based CPM invariants for the Rust engine (#4270).
//!
//! Port of the three core invariants in `packages/scheduler/tests/test_cpm_invariants.py`
//! (#3667), run against randomly generated projects:
//!
//! 1. every `critical_path` task has `total_float == 0`, and `critical_path` and
//!    `is_critical` name exactly the same tasks, each once;
//! 2. no task reports negative `total_float`;
//! 3. `project_finish` is reached, in working time, by the latest critical task and by
//!    every critical task with no successor (a task with no successor has its late
//!    finish anchored on `project_finish`, so zero float means it finishes there).
//!
//! The generator mirrors Python's `_plausible_projects`: one to six tasks, forward-only
//! edges (no cycles), at most one link per ordered pair, all four link types, lags from
//! -5 to 15 calendar days, SNET floors, actuals, percent complete (including the
//! `100*k/n` day boundaries), a status date, a Mon-Fri week with up to four holidays and
//! the optional SS+FS "join" milestone (#4173). An input the engine rejects is skipped,
//! as on the Python side. Three-point PERT estimates and per-task calendars are not
//! drawn: neither reaches the deterministic CPM pass these invariants cover.
//!
//! Invariant 3 narrows to projects with no completed task, for the reason the Python
//! `_clear_completion` documents: a completed task is excluded from the critical path
//! even at zero float, which can legitimately leave the path ending short of the
//! finish. "Reaches" is working time, not calendar date (#4280, #4281), so the check
//! walks the calendar day by day instead of reusing the engine's span arithmetic.
//!
//! CI: `wasm:test` runs `cargo test --all-targets`, which picks this binary up with no
//! job change. It runs at proptest's default of 256 cases per property, bounded so the
//! suite stays fast; `PROPTEST_CASES=<n>` raises or lowers it for a local deep run.
//! There is no separate deep tier.
//!
//! Failure persistence is off (`failure_persistence: None`): proptest would otherwise
//! write `proptest-regressions/` next to the sources on a failure. A failure instead
//! prints its minimal shrunk input and seed, which is reproduced as a pinned
//! deterministic test below (as the Python suite pins its counterexamples), not
//! replayed from a corpus file.

use proptest::prelude::*;
use serde_json::{json, Value};
use trueppm_wasm_scheduler::date::{Duration, NaiveDate};
use trueppm_wasm_scheduler::models::{Calendar, Project, ScheduleResult};
use trueppm_wasm_scheduler::schedule_impl;

const SECS_PER_DAY: f64 = 86400.0;

fn config() -> ProptestConfig {
    ProptestConfig {
        failure_persistence: None,
        ..ProptestConfig::default()
    }
}

fn anchor() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 3, 2).unwrap() // Monday
}

fn iso(offset_days: i64) -> String {
    let d = anchor()
        .checked_add_signed(Duration::days(offset_days))
        .unwrap();
    format!("{:04}-{:02}-{:02}", d.year(), d.month(), d.day())
}

// Day offsets from the anchor: 2025-09-01 .. 2027-03-01, as in the Python generator.
const MIN_OFF: i64 = -182;
const MAX_OFF: i64 = 364;

fn opt_date() -> impl Strategy<Value = Option<i64>> {
    prop::option::of(MIN_OFF..=MAX_OFF)
}

/// One task as JSON, with actuals drawn as a coherent pair (a finish only alongside a
/// start, at or after it): the engine refuses the incoherent combinations.
fn task_strategy(tid: String) -> impl Strategy<Value = Value> {
    (
        0i64..=40,
        opt_date(),
        opt_date(),
        0i64..=(MAX_OFF + 90),
        any::<bool>(),
        // Percent complete: an arbitrary float, exactly 100, or the `100*k/n` day
        // boundary values an arbitrary float almost never hits (#5015, #5034).
        (0u8..3, 0.0f64..=100.0, 0.0f64..=1.0),
    )
        .prop_map(
            move |(dur, planned, a_start, fin_extra, has_fin, (mode, pct, frac))| {
                let pct = match mode {
                    0 => pct,
                    1 => 100.0,
                    _ if dur > 0 => 100.0 * (frac * dur as f64).floor() / dur as f64,
                    _ => pct,
                };
                let mut t = json!({
                    "id": tid,
                    "name": "t",
                    "duration": dur as f64 * SECS_PER_DAY,
                    "percent_complete": pct,
                });
                if let Some(p) = planned {
                    t["planned_start"] = json!(iso(p));
                }
                if let Some(s) = a_start {
                    t["actual_start"] = json!(iso(s));
                    if has_fin {
                        t["actual_finish"] =
                            json!(iso((s + fin_extra % (MAX_OFF + 90 - s + 1)).max(s)));
                    }
                }
                t
            },
        )
}

fn project_strategy() -> impl Strategy<Value = Value> {
    (1usize..=6).prop_flat_map(|n| {
        let ids: Vec<String> = (0..n).map(|i| format!("t{i}")).collect();
        let tasks: Vec<_> = ids.iter().cloned().map(task_strategy).collect();
        // One optional link per forward pair (i < j): unique pairs by construction.
        let pair_count = n * (n - 1) / 2;
        let links = prop::collection::vec(
            prop::option::weighted(0.4, (0u8..4, -5i64..=15)),
            pair_count,
        );
        let join = prop::option::of((0..n, 0..n, 0i64..=9, 0i64..=9));
        let holidays = prop::collection::btree_set(MIN_OFF..=MAX_OFF, 0..=4);
        (tasks, links, join, holidays, opt_date()).prop_map(
            move |(tasks, links, join, holidays, status)| {
                let mut tasks = tasks;
                let mut deps = Vec::new();
                let mut chosen = 0;
                let mut slot = 0;
                for i in 0..n {
                    for j in (i + 1)..n {
                        if let Some((ty, lag)) = links[slot] {
                            if chosen < 6 {
                                chosen += 1;
                                deps.push(dep(&ids[i], &ids[j], ty, lag));
                            }
                        }
                        slot += 1;
                    }
                }
                // An SS-lag and an FS-lag link into one milestone (#4173); needs two
                // distinct sources.
                if let Some((a, b, ss_lag, fs_lag)) = join {
                    if n >= 2 && a != b {
                        tasks.push(json!({"id": "join", "name": "t", "duration": 0.0}));
                        deps.push(dep(&ids[a], "join", 2, ss_lag)); // SS
                        deps.push(dep(&ids[b], "join", 0, fs_lag)); // FS
                    }
                }
                let mut p = json!({
                    "id": "p",
                    "name": "p",
                    "start_date": iso(0),
                    "tasks": tasks,
                    "dependencies": deps,
                    "calendar": {
                        "working_days": 0b0011111,
                        "exceptions": holidays
                            .iter()
                            .map(|d| json!({"start": iso(*d), "end": iso(*d)}))
                            .collect::<Vec<_>>(),
                    },
                });
                if let Some(s) = status {
                    p["status_date"] = json!(iso(s));
                }
                p
            },
        )
    })
}

fn dep(pred: &str, succ: &str, ty: u8, lag_days: i64) -> Value {
    let ty = ["FS", "FF", "SS", "SF"][usize::from(ty)];
    json!({
        "predecessor_id": pred,
        "successor_id": succ,
        "dep_type": ty,
        "lag": lag_days as f64 * SECS_PER_DAY,
    })
}

/// Strip every completion signal, as Python's `_clear_completion` does.
fn clear_completion(mut p: Value) -> Value {
    for t in p["tasks"].as_array_mut().unwrap() {
        t.as_object_mut().unwrap().remove("actual_finish");
        let pct = t["percent_complete"].as_f64().unwrap_or(0.0).min(99.0);
        t["percent_complete"] = json!(pct);
    }
    p
}

/// Parse and schedule; `None` when the engine rejects the input (nothing to check).
fn run(p: &Value) -> Option<(Project, ScheduleResult)> {
    let project: Project = serde_json::from_value(p.clone()).ok()?;
    let result = schedule_impl(&project).ok()?;
    Some((project, result))
}

fn check_critical_path_float(result: &ScheduleResult) -> Result<(), String> {
    let on_path: std::collections::BTreeSet<&str> =
        result.critical_path.iter().map(String::as_str).collect();
    let flagged: std::collections::BTreeSet<&str> = result
        .tasks
        .iter()
        .filter(|t| t.is_critical)
        .map(|t| t.id.as_str())
        .collect();
    if on_path != flagged {
        return Err(format!(
            "critical_path {on_path:?} disagrees with is_critical-flagged {flagged:?}"
        ));
    }
    if result.critical_path.len() != on_path.len() {
        return Err("critical_path contains a duplicate task id".into());
    }
    for id in &result.critical_path {
        let t = result.tasks.iter().find(|t| &t.id == id).unwrap();
        if t.total_float != 0.0 {
            return Err(format!(
                "{id}: on critical_path but total_float is {} s",
                t.total_float
            ));
        }
    }
    Ok(())
}

fn check_no_negative_float(result: &ScheduleResult) -> Result<(), String> {
    match result.tasks.iter().find(|t| t.total_float < 0.0) {
        Some(t) => Err(format!(
            "{}: total_float {} s is negative",
            t.id, t.total_float
        )),
        None => Ok(()),
    }
}

/// First working day in `[start, end)`, walked day by day (not via the engine's span
/// arithmetic, so the property does not check the engine against itself).
fn first_working_day_in(start: NaiveDate, end: NaiveDate, cal: &Calendar) -> Option<NaiveDate> {
    let mut d = start;
    while d < end {
        if cal.is_working_day(d) {
            return Some(d);
        }
        d = d.checked_add_signed(Duration::days(1)).unwrap();
    }
    None
}

/// Exclusive bound a finish is checked against: when every task shown on
/// `project_finish` is a zero-duration milestone at the start of that day, the project
/// ends at the end of the working day before it.
fn working_time_finish_bound(
    project: &Project,
    result: &ScheduleResult,
    cal: &Calendar,
) -> NaiveDate {
    let all_start_of_day_milestones = result
        .tasks
        .iter()
        .filter(|t| t.early_finish == result.project_finish)
        .all(|t| {
            let input = project.tasks.iter().find(|i| i.id == t.id).unwrap();
            input.duration == 0.0 && !t.milestone_at_day_end
        });
    if !all_start_of_day_milestones {
        return result.project_finish;
    }
    let mut day = result
        .project_finish
        .checked_sub_signed(Duration::days(1))
        .unwrap();
    while !cal.is_working_day(day) {
        day = day.checked_sub_signed(Duration::days(1)).unwrap();
    }
    day
}

fn check_latest_critical_reaches_finish(
    project: &Project,
    result: &ScheduleResult,
) -> Result<(), String> {
    if result.critical_path.is_empty() {
        return Err("no completed task, yet critical_path is empty".into());
    }
    let critical: Vec<_> = result
        .critical_path
        .iter()
        .map(|id| result.tasks.iter().find(|t| &t.id == id).unwrap())
        .collect();
    // First maximal entry, matching Python's `max`.
    let mut latest = critical[0];
    for t in &critical[1..] {
        if t.early_finish > latest.early_finish {
            latest = t;
        }
    }
    let has_successor: std::collections::HashSet<&str> = project
        .dependencies
        .iter()
        .map(|d| d.predecessor_id.as_str())
        .collect();
    let cal = &project.calendar;
    let bound = working_time_finish_bound(project, result, cal);
    let sinks = critical
        .iter()
        .filter(|t| !has_successor.contains(t.id.as_str()));
    for (t, role) in
        std::iter::once((latest, "latest critical")).chain(sinks.map(|t| (*t, "critical sink")))
    {
        if let Some(gap) = first_working_day_in(t.early_finish, bound, cal) {
            return Err(format!(
                "{}: {role} task has early_finish {:?}, a working day ({gap:?}) short of project_finish {:?}",
                t.id, t.early_finish, result.project_finish
            ));
        }
    }
    Ok(())
}

proptest! {
    #![proptest_config(config())]

    #[test]
    fn critical_path_tasks_have_zero_total_float(p in project_strategy()) {
        if let Some((_, result)) = run(&p) {
            check_critical_path_float(&result).map_err(TestCaseError::fail)?;
        }
    }

    #[test]
    fn no_negative_total_float(p in project_strategy()) {
        if let Some((_, result)) = run(&p) {
            check_no_negative_float(&result).map_err(TestCaseError::fail)?;
        }
    }

    #[test]
    fn project_finish_is_reached_by_the_latest_critical_task(p in project_strategy()) {
        if let Some((project, result)) = run(&clear_completion(p)) {
            check_latest_critical_reaches_finish(&project, &result).map_err(TestCaseError::fail)?;
        }
    }
}

/// Negative control: the checks must be able to fail. A planted negative float and a
/// planted critical_path/is_critical disagreement are both caught.
#[test]
fn the_checks_flag_planted_violations() {
    let p = json!({
        "id": "p", "name": "p", "start_date": iso(0),
        "tasks": [
            {"id": "a", "name": "a", "duration": 2.0 * SECS_PER_DAY},
            {"id": "b", "name": "b", "duration": 5.0 * SECS_PER_DAY},
        ],
    });
    let (project, mut result) = run(&p).expect("schedules");
    assert_eq!(result.critical_path, ["b"]);
    assert!(check_critical_path_float(&result).is_ok());
    assert!(check_no_negative_float(&result).is_ok());
    assert!(check_latest_critical_reaches_finish(&project, &result).is_ok());

    // `a` finishes working days before `project_finish`; claiming it critical is a
    // critical sink short of the finish, and its float is not zero.
    result.critical_path.push("a".into());
    assert!(check_latest_critical_reaches_finish(&project, &result).is_err());
    assert!(check_critical_path_float(&result).is_err());
    result.critical_path.pop();

    let a = result.tasks.iter().position(|t| t.id == "a").unwrap();
    result.tasks[a].total_float = -SECS_PER_DAY;
    assert!(check_no_negative_float(&result).is_err());
    result.tasks[a].total_float = 0.0;
    result.tasks[a].is_critical = true; // flagged but not on critical_path
    assert!(check_critical_path_float(&result).is_err());
}

/// Pinned counterexample from the Python suite (#4280): a Saturday `actual_start`
/// milestone and a 17-day task are both critical sinks; the milestone ends
/// `critical_path` two calendar days, but zero working days, before `project_finish`.
#[test]
fn milestone_pinned_to_a_non_working_day_ends_the_critical_path_in_working_time() {
    let p = json!({
        "id": "p", "name": "p", "start_date": "2026-03-02",
        "tasks": [
            {"id": "t0", "name": "t", "duration": 17.0 * SECS_PER_DAY, "actual_start": "2027-01-01"},
            {"id": "t1", "name": "t", "duration": 0.0, "actual_start": "2027-01-23"},
        ],
        "calendar": {"working_days": 0b0011111},
    });
    let (project, result) = run(&p).expect("schedules");
    assert_eq!(result.critical_path, ["t0", "t1"]);
    check_critical_path_float(&result).unwrap();
    check_no_negative_float(&result).unwrap();
    check_latest_critical_reaches_finish(&project, &result).unwrap();
}
