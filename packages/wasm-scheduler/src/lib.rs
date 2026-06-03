//! TruePPM WASM Scheduler — CPM engine compiled to WebAssembly.
//!
//! Exposes two functions via wasm-bindgen:
//! - `compute_schedule(project_json)` — full CPM (forward + backward + floats)
//! - `incremental_update(project_json, changed_task_id)` — downstream-only recalc
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

use std::collections::HashMap;

use wasm_bindgen::prelude::*;

use crate::backward::backward_pass;
use crate::floats::compute_floats;
use crate::forward::forward_pass;
use crate::graph::build_graph;
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

/// Internal implementation of the full CPM schedule (no wasm-bindgen dependency).
/// Used by both `compute_schedule` and tests.
pub fn schedule_impl(project: &Project) -> Result<ScheduleResult, String> {
    if project.tasks.is_empty() {
        return Err("Project must have at least one task.".to_string());
    }
    validate::validate_project(project)?;

    let pg = build_graph(project).map_err(|e| e.to_string())?;

    let mut task_map: HashMap<String, models::Task> = project
        .tasks
        .iter()
        .map(|t| (t.id.clone(), t.clone()))
        .collect();

    forward_pass(
        &mut task_map,
        &pg.topo_order,
        &pg,
        &project.dependencies,
        project.start_date,
        &project.calendar,
    )?;

    let project_finish = task_map
        .values()
        .filter_map(|t| t.early_finish)
        .max()
        .ok_or("No tasks with early_finish after forward pass")?;

    backward_pass(
        &mut task_map,
        &pg.topo_order,
        &pg,
        &project.dependencies,
        project_finish,
        &project.calendar,
    )?;

    compute_floats(
        &mut task_map,
        &pg.topo_order,
        &pg,
        &project.dependencies,
        &project.calendar,
    )?;

    // Order by (early_start, id): deterministic and identical to the Python
    // engine, independent of the petgraph topological tie-break (#909).
    let mut critical_path: Vec<String> = pg
        .topo_order
        .iter()
        .filter(|id| task_map[*id].is_critical)
        .cloned()
        .collect();
    critical_path.sort_by(|a, b| {
        task_map[a]
            .early_start
            .unwrap()
            .cmp(&task_map[b].early_start.unwrap())
            .then_with(|| a.cmp(b))
    });

    let project_start = task_map[&pg.topo_order[0]].early_start.unwrap();

    let tasks: Vec<TaskResult> = pg
        .topo_order
        .iter()
        .map(|id| {
            let t = &task_map[id];
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
        };

        let result = schedule_impl(&project).unwrap();
        let a = result.tasks.iter().find(|t| t.id == "A").unwrap();
        let b = result.tasks.iter().find(|t| t.id == "B").unwrap();
        // B's EF >= A's ES (SF constraint)
        assert!(b.early_finish >= a.early_start);
    }
}
