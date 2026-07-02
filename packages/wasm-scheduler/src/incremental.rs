//! Incremental CPM update — subgraph extraction and forward-only recalc.
//!
//! Used for drag preview: only recomputes tasks downstream of the changed task.
//! Mirrors the BFS approach in `buildSubgraph.ts` combined with a forward pass.

use std::collections::{HashMap, HashSet, VecDeque};

use crate::backward::backward_pass;
use crate::floats::compute_floats;
use crate::forward::forward_pass;
use crate::graph::{build_graph, ProjectGraph};
use crate::models::{Project, ScheduleResult, Task, TaskResult};

/// Run an incremental update: override the changed task's start, then recompute
/// the full CPM for the project (forward + backward + floats) and return only
/// tasks that are downstream of the changed task.
///
/// This is simpler and more correct than a partial forward pass — the full CPM
/// is fast enough (<10ms for 5k tasks) and avoids subtle bugs from partial recalc.
pub fn incremental_update(
    project: &Project,
    changed_task_id: &str,
) -> Result<ScheduleResult, String> {
    if project.tasks.is_empty() {
        return Err("Project must have at least one task.".to_string());
    }
    crate::validate::validate_project(project)?;

    let pg = build_graph(project).map_err(|e| e.to_string())?;

    // A stale changed_task_id (e.g. the task was deleted while a drag-preview was
    // in flight) would index-panic in bfs_downstream's `pg.node_index[&id]`,
    // trapping the WASM module (#1087). Reject it as a clean Err first.
    if !pg.node_index.contains_key(changed_task_id) {
        return Err(format!(
            "changed_task_id {changed_task_id:?} does not exist in the project."
        ));
    }

    // BFS to find downstream tasks (inclusive of the changed task)
    let downstream = bfs_downstream(&pg, changed_task_id);

    // Run full CPM
    let mut task_map: HashMap<String, Task> = project
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
        project.status_date,
    )?;

    let project_finish = task_map
        .values()
        .filter_map(|t| t.early_finish)
        .max()
        .unwrap();

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

    // Collect results for downstream tasks only
    let tasks: Vec<TaskResult> = pg
        .topo_order
        .iter()
        .filter(|id| downstream.contains(id.as_str()))
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

    // Deterministic, topologically-valid critical-path order keyed by
    // (early_start, id) — identical to the Python engine (#909).
    let critical_path: Vec<String> = crate::graph::lexicographical_topo_order(&pg, &task_map)
        .into_iter()
        .filter(|id| task_map[id].is_critical)
        .collect();

    // Earliest early_start across ALL tasks — mirrors Python and the full
    // schedule path; out-of-sequence actuals can move the minimum off
    // `topo_order[0]` (#1494).
    let project_start = task_map
        .values()
        .filter_map(|t| t.early_start)
        .min()
        .unwrap();

    Ok(ScheduleResult {
        project_id: project.id.clone(),
        project_start,
        project_finish,
        tasks,
        critical_path,
    })
}

/// BFS forward from `start_id` to find all downstream task IDs (inclusive).
fn bfs_downstream(pg: &ProjectGraph, start_id: &str) -> HashSet<String> {
    let mut visited = HashSet::new();
    let mut queue = VecDeque::new();
    queue.push_back(start_id.to_string());

    while let Some(id) = queue.pop_front() {
        if !visited.insert(id.clone()) {
            continue;
        }
        let idx = pg.node_index[&id];
        for neighbor in pg
            .graph
            .neighbors_directed(idx, petgraph::Direction::Outgoing)
        {
            let neighbor_id = pg.graph[neighbor].clone();
            if !visited.contains(&neighbor_id) {
                queue.push_back(neighbor_id);
            }
        }
    }

    visited
}

#[cfg(test)]
mod tests {
    use chrono::NaiveDate;

    use super::incremental_update;
    use crate::models::{Calendar, Dependency, DependencyType, Project, Task};

    fn task(id: &str, days: i64) -> Task {
        Task {
            id: id.to_string(),
            name: id.to_string(),
            duration: (days * 86_400) as f64,
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

    fn project() -> Project {
        Project {
            id: "p".to_string(),
            name: "p".to_string(),
            start_date: NaiveDate::from_ymd_opt(2026, 4, 1).unwrap(),
            tasks: vec![task("A", 5), task("B", 3)],
            dependencies: vec![Dependency {
                predecessor_id: "A".to_string(),
                successor_id: "B".to_string(),
                dep_type: DependencyType::FS,
                lag: 0.0,
            }],
            calendar: Calendar::default(),
            status_date: None,
        }
    }

    #[test]
    fn unknown_changed_task_id_errors_not_panics() {
        // #1087: a stale changed_task_id (deleted mid-drag) previously index-panicked
        // in bfs_downstream, trapping the module. It must return a clean Err.
        assert!(incremental_update(&project(), "GHOST").is_err());
    }

    #[test]
    fn known_changed_task_id_succeeds() {
        assert!(incremental_update(&project(), "A").is_ok());
    }
}
