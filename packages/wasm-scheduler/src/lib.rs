//! TruePPM WASM Scheduler — CPM engine compiled to WebAssembly.
//!
//! Exposes two stateless functions via wasm-bindgen:
//! - `compute_schedule(project_json)` — full CPM (forward + backward + floats)
//! - `wasm_incremental_update(project_json, changed_task_id)` — downstream-only recalc
//!
//! Both re-parse the whole project and rebuild the graph on every call. For a
//! drag preview — where the same project is recalculated every animation frame —
//! [`SchedulerSession`] pays that parse/validate/graph-build cost once and keeps
//! the parsed [`Project`] and its graph resident across frames (#1533).
//!
//! Input/output JSON format matches the Python `trueppm_scheduler` exactly.

mod backward;
mod calendar;
mod floats;
mod forward;
mod graph;
mod incremental;
pub mod models;
mod validate;

// Re-exported so the conformance suite can cross-check the incremental
// drag-preview recompute against a full schedule (#1505).
pub use incremental::incremental_update;

use chrono::NaiveDate;
use wasm_bindgen::prelude::*;

use crate::backward::backward_pass;
use crate::floats::compute_floats;
use crate::forward::forward_pass;
use crate::graph::{build_graph, ProjectGraph};
use crate::models::{Project, ScheduleResult, TaskResult};

/// Run a full CPM schedule on the project and return the result as JSON.
///
/// Input: JSON string matching `Project.to_json()` from the Python scheduler.
/// Output: JSON string with `ScheduleResult` (project dates, per-task CPM fields, critical path).
///
/// Errors are returned as a JS exception with the error message.
#[wasm_bindgen]
pub fn compute_schedule(project_json: &str) -> Result<String, JsValue> {
    let project: Project =
        serde_json::from_str(project_json).map_err(|e| JsValue::from_str(&e.to_string()))?;

    let result = schedule_impl(&project).map_err(|e| JsValue::from_str(&e))?;

    serde_json::to_string(&result).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Run an incremental CPM update for a changed task and return downstream results as JSON.
///
/// Input: JSON string matching `Project.to_json()` with the changed task's dates
/// already modified, plus the ID of the changed task.
/// Output: JSON string with `ScheduleResult` containing only downstream tasks.
#[wasm_bindgen]
pub fn wasm_incremental_update(
    project_json: &str,
    changed_task_id: &str,
) -> Result<String, JsValue> {
    let project: Project =
        serde_json::from_str(project_json).map_err(|e| JsValue::from_str(&e.to_string()))?;

    let result = incremental::incremental_update(&project, changed_task_id)
        .map_err(|e| JsValue::from_str(&e))?;

    serde_json::to_string(&result).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// A resident scheduling session for drag-preview recalculation (#1533).
///
/// The stateless [`compute_schedule`] / [`wasm_incremental_update`] entry points
/// re-parse the entire project JSON, re-validate it, and rebuild the petgraph on
/// **every** call — a cost that scales with total project size and, on a drag,
/// repeats every animation frame before any CPM math runs. A `SchedulerSession`
/// pays that cost **once**, in [`SchedulerSession::new`]: the parsed [`Project`]
/// and its built graph stay resident, so each frame only mutates the dragged
/// task's start ([`set_task_start`](SchedulerSession::set_task_start)) and reruns
/// the passes over the cached graph
/// ([`recalc_incremental`](SchedulerSession::recalc_incremental)).
///
/// Reusing the graph across the session is sound because a drag moves a bar's
/// *date*, not the network *topology* — the nodes, edges, and topological order
/// depend only on the task/dependency structure, which `set_task_start` never
/// touches. A structural edit (adding or removing a task or dependency) is the
/// one case that needs a fresh session.
///
/// The CPM math is unchanged: the session calls the same `compute_full` /
/// `compute_downstream` bodies the stateless paths use, so its output is
/// identical to calling `compute_schedule` / `wasm_incremental_update` on the
/// mutated project. The session's true-partial forward pass (recomputing only the
/// changed subgraph) is deliberately left as a follow-up so the full pass remains
/// the single conformance oracle.
#[wasm_bindgen]
pub struct SchedulerSession {
    project: Project,
    graph: ProjectGraph,
}

#[wasm_bindgen]
impl SchedulerSession {
    /// Parse, validate, and build the dependency graph once. Every subsequent
    /// `set_task_start` + `recalc*` call reuses all three.
    ///
    /// Returns `Err` (a JS exception) for malformed JSON, an empty project, a
    /// validation failure, or an unbuildable graph — the same rejections the
    /// stateless entry points make, just paid up front rather than per frame.
    #[wasm_bindgen(constructor)]
    pub fn new(project_json: &str) -> Result<SchedulerSession, JsValue> {
        let project: Project =
            serde_json::from_str(project_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        if project.tasks.is_empty() {
            return Err(JsValue::from_str("Project must have at least one task."));
        }
        validate::validate_project(&project).map_err(|e| JsValue::from_str(&e))?;
        let graph = build_graph(&project).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(SchedulerSession { project, graph })
    }

    /// Override a resident task's planned start (the drag), in place — no
    /// re-parse, no re-validate, no graph rebuild.
    ///
    /// `new_start` is an ISO `YYYY-MM-DD` date. The forward pass treats
    /// `planned_start` as a start-no-earlier-than floor, so this is the dragged
    /// bar's new position. Returns `Err` for an unknown id or an unparseable date
    /// (never panics — a WASM trap poisons the whole module until reload, #1087).
    pub fn set_task_start(&mut self, task_id: &str, new_start: &str) -> Result<(), JsValue> {
        let date = NaiveDate::parse_from_str(new_start, "%Y-%m-%d")
            .map_err(|e| JsValue::from_str(&format!("invalid start date {new_start:?}: {e}")))?;
        // `node_index[id].index()` is the task's dense position: nodes are added
        // in `project.tasks` order (#1535), so this indexes the same task.
        let &idx = self.graph.node_index.get(task_id).ok_or_else(|| {
            JsValue::from_str(&format!("task_id {task_id:?} does not exist in the project."))
        })?;
        self.project.tasks[idx.index()].planned_start = Some(date);
        Ok(())
    }

    /// Full CPM over the cached graph → `ScheduleResult` JSON. Identical to
    /// `compute_schedule` on the current (possibly drag-mutated) project.
    pub fn recalc(&self) -> Result<String, JsValue> {
        let result = compute_full(&self.project, &self.graph).map_err(|e| JsValue::from_str(&e))?;
        serde_json::to_string(&result).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Downstream-only CPM over the cached graph → `ScheduleResult` JSON.
    /// Identical to `wasm_incremental_update` on the current project.
    pub fn recalc_incremental(&self, changed_task_id: &str) -> Result<String, JsValue> {
        let result = incremental::compute_downstream(&self.project, &self.graph, changed_task_id)
            .map_err(|e| JsValue::from_str(&e))?;
        serde_json::to_string(&result).map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

/// Internal implementation of the full CPM schedule (no wasm-bindgen dependency).
/// Used by `compute_schedule`, [`SchedulerSession`], and tests.
pub fn schedule_impl(project: &Project) -> Result<ScheduleResult, String> {
    if project.tasks.is_empty() {
        return Err("Project must have at least one task.".to_string());
    }
    validate::validate_project(project)?;

    let pg = build_graph(project).map_err(|e| e.to_string())?;
    compute_full(project, &pg)
}

/// Run the three CPM passes (forward → backward → floats) over an already-built
/// graph and assemble the full [`ScheduleResult`].
///
/// This is the single implementation of the full-pass sequence: [`schedule_impl`]
/// builds the graph fresh each call, while [`SchedulerSession`] reuses one cached
/// across a drag session (#1533). Keeping one body means the stateful session API
/// can never drift from the conformance oracle.
pub(crate) fn compute_full(
    project: &Project,
    pg: &ProjectGraph,
) -> Result<ScheduleResult, String> {
    // Tasks carried in a dense `Vec<Task>` indexed by node position — the passes
    // index it by `NodeIndex::index()`, never by string id (#1535).
    let mut tasks: Vec<models::Task> = project.tasks.clone();

    forward_pass(
        &mut tasks,
        &pg.topo_order,
        pg,
        &project.dependencies,
        project.start_date,
        &project.calendar,
        project.status_date,
    )?;

    let project_finish = tasks
        .iter()
        .filter_map(|t| t.early_finish)
        .max()
        .ok_or("No tasks with early_finish after forward pass")?;

    backward_pass(
        &mut tasks,
        &pg.topo_order,
        pg,
        &project.dependencies,
        project_finish,
        &project.calendar,
    )?;

    compute_floats(
        &mut tasks,
        &pg.topo_order,
        pg,
        &project.dependencies,
        &project.calendar,
    )?;

    // Deterministic, topologically-valid critical-path order keyed by
    // (early_start, id) — identical to the Python engine (#909).
    let critical_path: Vec<String> = graph::lexicographical_topo_order(pg, &tasks)
        .into_iter()
        .filter(|&i| tasks[i.index()].is_critical)
        .map(|i| tasks[i.index()].id.clone())
        .collect();

    // The earliest early_start across ALL tasks — mirrors Python's
    // `min(t.early_start ...)`. `topo_order[0]` is normally the earliest, but
    // out-of-sequence actuals (a completed successor pinned before its
    // predecessor) can put the minimum on a later topo node (#1494).
    let project_start = tasks.iter().filter_map(|t| t.early_start).min().unwrap();

    let tasks: Vec<TaskResult> = pg
        .topo_order
        .iter()
        .map(|&i| {
            let t = &tasks[i.index()];
            TaskResult {
                id: t.id.clone(),
                early_start: t.early_start.unwrap(),
                early_finish: t.early_finish.unwrap(),
                late_start: t.late_start.unwrap(),
                late_finish: t.late_finish.unwrap(),
                total_float: t.total_float,
                free_float: t.free_float,
                is_critical: t.is_critical,
            }
        })
        .collect();

    Ok(ScheduleResult {
        project_id: project.id.clone(),
        project_start,
        project_finish,
        tasks,
        critical_path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::*;
    use chrono::NaiveDate;

    fn make_task(id: &str, duration_days: i32) -> Task {
        Task {
            id: id.to_string(),
            name: id.to_string(),
            duration: duration_days as f64 * 86400.0,
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

    fn dep(pred: &str, succ: &str) -> Dependency {
        Dependency {
            predecessor_id: pred.to_string(),
            successor_id: succ.to_string(),
            dep_type: DependencyType::FS,
            lag: 0.0,
        }
    }

    #[test]
    fn test_simple_fs_chain() {
        // A(5d) -> B(3d) -> C(2d), project starts Wed 2026-04-01
        let project = Project {
            id: "p1".to_string(),
            name: "Test".to_string(),
            start_date: NaiveDate::from_ymd_opt(2026, 4, 1).unwrap(),
            tasks: vec![make_task("A", 5), make_task("B", 3), make_task("C", 2)],
            dependencies: vec![dep("A", "B"), dep("B", "C")],
            calendar: Calendar::default(),
            status_date: None,
        };

        let result = schedule_impl(&project).unwrap();

        // A: ES=Apr 1 (Wed), EF=Apr 7 (Tue) — 5 working days
        let a = result.tasks.iter().find(|t| t.id == "A").unwrap();
        assert_eq!(a.early_start, NaiveDate::from_ymd_opt(2026, 4, 1).unwrap());
        assert_eq!(a.early_finish, NaiveDate::from_ymd_opt(2026, 4, 7).unwrap());

        // B: ES=Apr 8 (Wed), EF=Apr 10 (Fri) — 3 working days
        let b = result.tasks.iter().find(|t| t.id == "B").unwrap();
        assert_eq!(b.early_start, NaiveDate::from_ymd_opt(2026, 4, 8).unwrap());
        assert_eq!(
            b.early_finish,
            NaiveDate::from_ymd_opt(2026, 4, 10).unwrap()
        );

        // C: ES=Apr 13 (Mon), EF=Apr 14 (Tue) — 2 working days
        let c = result.tasks.iter().find(|t| t.id == "C").unwrap();
        assert_eq!(c.early_start, NaiveDate::from_ymd_opt(2026, 4, 13).unwrap());
        assert_eq!(
            c.early_finish,
            NaiveDate::from_ymd_opt(2026, 4, 14).unwrap()
        );

        // All tasks on critical path (single chain)
        assert_eq!(result.critical_path, vec!["A", "B", "C"]);
        assert!(a.is_critical);
        assert!(b.is_critical);
        assert!(c.is_critical);
    }

    #[test]
    fn test_ss_connected_critical_keeps_predecessor_first() {
        // #909: ZED --SS lag0--> ABE, both critical, share an early_start. A plain
        // value-sort by (early_start, id) would place ABE before its predecessor
        // ZED (id "ABE" < "ZED"); the lexicographic topological order must keep
        // ZED first. MID joins both and sorts last by its later early_start.
        let project = Project {
            id: "p-ss".to_string(),
            name: "ss".to_string(),
            start_date: NaiveDate::from_ymd_opt(2026, 4, 6).unwrap(),
            tasks: vec![
                make_task("ZED", 5),
                make_task("ABE", 5),
                make_task("MID", 5),
            ],
            dependencies: vec![
                Dependency {
                    predecessor_id: "ZED".to_string(),
                    successor_id: "ABE".to_string(),
                    dep_type: DependencyType::SS,
                    lag: 0.0,
                },
                dep("ZED", "MID"),
                dep("ABE", "MID"),
            ],
            calendar: Calendar::default(),
            status_date: None,
        };

        let result = schedule_impl(&project).unwrap();
        assert_eq!(result.critical_path, vec!["ZED", "ABE", "MID"]);
    }

    #[test]
    fn test_near_max_planned_start_with_large_lag_errors_not_panics() {
        // #908: a planned_start near NaiveDate's representable maximum plus a large
        // FS lag overflows the raw date arithmetic in the forward pass. It must
        // surface a clean Err (via checked_offset_days), never panic and trap the
        // WASM module. Before the fix this panicked at forward.rs.
        let mut p = make_task("P", 1);
        p.planned_start = Some(NaiveDate::MAX - chrono::Duration::days(5));
        let project = Project {
            id: "p-overflow".to_string(),
            name: "overflow".to_string(),
            start_date: NaiveDate::from_ymd_opt(2026, 4, 1).unwrap(),
            tasks: vec![p, make_task("Q", 1)],
            dependencies: vec![Dependency {
                predecessor_id: "P".to_string(),
                successor_id: "Q".to_string(),
                dep_type: DependencyType::FS,
                lag: 36525.0 * 86400.0,
            }],
            calendar: Calendar::default(),
            status_date: None,
        };

        assert!(schedule_impl(&project).is_err());
    }

    #[test]
    fn test_parallel_paths_with_float() {
        // A(5d) -> C(2d)
        // B(3d) -> C(2d)
        // A-C is the critical path; B has float.
        let project = Project {
            id: "p1".to_string(),
            name: "Test".to_string(),
            start_date: NaiveDate::from_ymd_opt(2026, 4, 1).unwrap(),
            tasks: vec![make_task("A", 5), make_task("B", 3), make_task("C", 2)],
            dependencies: vec![dep("A", "C"), dep("B", "C")],
            calendar: Calendar::default(),
            status_date: None,
        };

        let result = schedule_impl(&project).unwrap();

        let a = result.tasks.iter().find(|t| t.id == "A").unwrap();
        let b = result.tasks.iter().find(|t| t.id == "B").unwrap();
        let c = result.tasks.iter().find(|t| t.id == "C").unwrap();

        assert!(a.is_critical);
        assert!(!b.is_critical); // B has float
        assert!(c.is_critical);

        // B's total float = 2 working days (it's 2 days shorter than A)
        assert_eq!((b.total_float / 86400.0).round() as i32, 2);
    }

    #[test]
    fn test_milestone_zero_duration() {
        // A(5d) -> M(0d milestone) -> B(3d)
        let project = Project {
            id: "p1".to_string(),
            name: "Test".to_string(),
            start_date: NaiveDate::from_ymd_opt(2026, 4, 1).unwrap(),
            tasks: vec![make_task("A", 5), make_task("M", 0), make_task("B", 3)],
            dependencies: vec![dep("A", "M"), dep("M", "B")],
            calendar: Calendar::default(),
            status_date: None,
        };

        let result = schedule_impl(&project).unwrap();
        let m = result.tasks.iter().find(|t| t.id == "M").unwrap();
        // Milestone: ES == EF
        assert_eq!(m.early_start, m.early_finish);
    }

    #[test]
    fn test_planned_start_snet() {
        // A(3d) with planned_start = Apr 6 (Mon of second week)
        // Project starts Apr 1 (Wed)
        let mut task_a = make_task("A", 3);
        task_a.planned_start = Some(NaiveDate::from_ymd_opt(2026, 4, 6).unwrap());

        let project = Project {
            id: "p1".to_string(),
            name: "Test".to_string(),
            start_date: NaiveDate::from_ymd_opt(2026, 4, 1).unwrap(),
            tasks: vec![task_a],
            dependencies: vec![],
            calendar: Calendar::default(),
            status_date: None,
        };

        let result = schedule_impl(&project).unwrap();
        let a = result.tasks.iter().find(|t| t.id == "A").unwrap();
        // SNET: cannot start before Apr 6
        assert_eq!(a.early_start, NaiveDate::from_ymd_opt(2026, 4, 6).unwrap());
        assert_eq!(a.early_finish, NaiveDate::from_ymd_opt(2026, 4, 8).unwrap());
    }

    #[test]
    fn test_json_round_trip() {
        let project = Project {
            id: "p1".to_string(),
            name: "Test".to_string(),
            start_date: NaiveDate::from_ymd_opt(2026, 4, 1).unwrap(),
            tasks: vec![make_task("A", 5), make_task("B", 3)],
            dependencies: vec![dep("A", "B")],
            calendar: Calendar::default(),
            status_date: None,
        };

        let json = serde_json::to_string(&project).unwrap();
        let parsed: Project = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, "p1");
        assert_eq!(parsed.tasks.len(), 2);
        assert_eq!(parsed.dependencies.len(), 1);
    }

    #[test]
    fn test_ss_dependency() {
        // A(5d) -SS-> B(3d): B cannot start before A starts
        let project = Project {
            id: "p1".to_string(),
            name: "Test".to_string(),
            start_date: NaiveDate::from_ymd_opt(2026, 4, 1).unwrap(),
            tasks: vec![make_task("A", 5), make_task("B", 3)],
            dependencies: vec![Dependency {
                predecessor_id: "A".to_string(),
                successor_id: "B".to_string(),
                dep_type: DependencyType::SS,
                lag: 0.0,
            }],
            calendar: Calendar::default(),
            status_date: None,
        };

        let result = schedule_impl(&project).unwrap();
        let a = result.tasks.iter().find(|t| t.id == "A").unwrap();
        let b = result.tasks.iter().find(|t| t.id == "B").unwrap();
        // B starts same day as A (SS with 0 lag)
        assert_eq!(a.early_start, b.early_start);
    }

    #[test]
    fn test_ff_dependency() {
        // A(5d) -FF-> B(3d): B cannot finish before A finishes
        let project = Project {
            id: "p1".to_string(),
            name: "Test".to_string(),
            start_date: NaiveDate::from_ymd_opt(2026, 4, 1).unwrap(),
            tasks: vec![make_task("A", 5), make_task("B", 3)],
            dependencies: vec![Dependency {
                predecessor_id: "A".to_string(),
                successor_id: "B".to_string(),
                dep_type: DependencyType::FF,
                lag: 0.0,
            }],
            calendar: Calendar::default(),
            status_date: None,
        };

        let result = schedule_impl(&project).unwrap();
        let a = result.tasks.iter().find(|t| t.id == "A").unwrap();
        let b = result.tasks.iter().find(|t| t.id == "B").unwrap();
        // B's EF >= A's EF (FF constraint)
        assert!(b.early_finish >= a.early_finish);
    }

    #[test]
    fn test_sf_dependency() {
        // A(5d) -SF-> B(3d): B cannot finish before A starts
        let project = Project {
            id: "p1".to_string(),
            name: "Test".to_string(),
            start_date: NaiveDate::from_ymd_opt(2026, 4, 1).unwrap(),
            tasks: vec![make_task("A", 5), make_task("B", 3)],
            dependencies: vec![Dependency {
                predecessor_id: "A".to_string(),
                successor_id: "B".to_string(),
                dep_type: DependencyType::SF,
                lag: 0.0,
            }],
            calendar: Calendar::default(),
            status_date: None,
        };

        let result = schedule_impl(&project).unwrap();
        let a = result.tasks.iter().find(|t| t.id == "A").unwrap();
        let b = result.tasks.iter().find(|t| t.id == "B").unwrap();
        // B's EF >= A's ES (SF constraint)
        assert!(b.early_finish >= a.early_start);
    }

    #[test]
    fn session_recalc_matches_stateless_after_drag() {
        // #1533: a `SchedulerSession` builds the graph once and mutates
        // `planned_start` between recalcs. Because a drag changes a task's date,
        // not the topology, reusing the cached graph must yield output
        // byte-identical to the stateless path (which rebuilds the graph on the
        // mutated project). We assert at the pure-function level — the
        // wasm-bindgen `SchedulerSession` methods are a thin delegation over
        // exactly these `compute_full` / `compute_downstream` calls, and `JsValue`
        // cannot be exercised in a native test (which is also why `compute_schedule`
        // itself is tested through `schedule_impl`).
        let mut project = Project {
            id: "p".to_string(),
            name: "drag".to_string(),
            start_date: NaiveDate::from_ymd_opt(2026, 4, 1).unwrap(),
            tasks: vec![make_task("A", 5), make_task("B", 3), make_task("C", 2)],
            dependencies: vec![dep("A", "B"), dep("B", "C")],
            calendar: Calendar::default(),
            status_date: None,
        };

        // Graph built ONCE, as `SchedulerSession::new` would.
        let pg = crate::graph::build_graph(&project).unwrap();

        // Full recalc over the cached graph == stateless `schedule_impl`.
        let session_full = serde_json::to_string(&compute_full(&project, &pg).unwrap()).unwrap();
        let stateless_full = serde_json::to_string(&schedule_impl(&project).unwrap()).unwrap();
        assert_eq!(session_full, stateless_full);

        // Drag: push A's start out a week (what `set_task_start` writes), keeping
        // the SAME cached graph.
        project.tasks[0].planned_start = Some(NaiveDate::from_ymd_opt(2026, 4, 8).unwrap());

        // Downstream recalc over the stale-date-but-valid graph == stateless
        // incremental on the mutated project (which rebuilds the graph).
        let session_inc = serde_json::to_string(
            &crate::incremental::compute_downstream(&project, &pg, "A").unwrap(),
        )
        .unwrap();
        let stateless_inc =
            serde_json::to_string(&crate::incremental::incremental_update(&project, "A").unwrap())
                .unwrap();
        assert_eq!(session_inc, stateless_inc);

        // Full recalc after the drag still matches the stateless rebuild...
        let session_full2 = serde_json::to_string(&compute_full(&project, &pg).unwrap()).unwrap();
        let stateless_full2 = serde_json::to_string(&schedule_impl(&project).unwrap()).unwrap();
        assert_eq!(session_full2, stateless_full2);

        // ...and the drag genuinely moved the schedule, so the equivalence above
        // is not vacuously comparing two identical no-op results.
        assert_ne!(
            session_full, session_full2,
            "dragging A's planned_start should have shifted the downstream schedule"
        );
    }
}
