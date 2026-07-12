//! Incremental CPM update — subgraph extraction and forward-only recalc.
//!
//! Used for drag preview: only recomputes tasks downstream of the changed task.
//! Mirrors the BFS approach in `buildSubgraph.ts` combined with a forward pass.

use std::collections::VecDeque;

use petgraph::graph::NodeIndex;

use crate::backward::backward_pass;
use crate::floats::compute_floats;
use crate::forward::forward_pass;
use crate::graph::{build_graph, ProjectGraph};
use crate::models::{Project, ScheduleResult, TaskResult};

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
    compute_downstream(project, &pg, changed_task_id)
}

/// Run the full CPM over an already-built graph and return only the tasks
/// downstream of `changed_task_id` (inclusive).
///
/// This is the single implementation of the downstream recalc: `incremental_update`
/// builds the graph fresh each call, while `SchedulerSession` reuses one cached
/// across a drag session (#1533). Because a drag changes a task's *date*, not the
/// graph topology, the cached graph stays valid — reusing it here yields output
/// identical to rebuilding it, which the session unit tests assert.
pub(crate) fn compute_downstream(
    project: &Project,
    pg: &ProjectGraph,
    changed_task_id: &str,
) -> Result<ScheduleResult, String> {
    // BFS to find downstream tasks (inclusive of the changed task) — a dense
    // `Vec<bool>` visited mask indexed by node position (#1535). A stale
    // changed_task_id is rejected as a clean Err by `downstream_mask` (#1087).
    let downstream = downstream_mask(pg, changed_task_id, project.tasks.len())?;

    // Run full CPM on a dense `Vec<Task>` indexed by node position (#1535).
    let mut tasks: Vec<crate::models::Task> = project.tasks.clone();

    forward_pass(
        &mut tasks,
        &pg.topo_order,
        pg,
        &project.dependencies,
        project.start_date,
        &project.calendar,
        project.status_date,
    )?;

    let project_finish = tasks.iter().filter_map(|t| t.early_finish).max().unwrap();

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

    // Collect results for downstream tasks only
    let task_results: Vec<TaskResult> = pg
        .topo_order
        .iter()
        .filter(|&&i| downstream[i.index()])
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

    // Deterministic, topologically-valid critical-path order keyed by
    // (early_start, id) — identical to the Python engine (#909).
    let critical_path: Vec<String> = crate::graph::lexicographical_topo_order(pg, &tasks)
        .into_iter()
        .filter(|&i| tasks[i.index()].is_critical)
        .map(|i| tasks[i.index()].id.clone())
        .collect();

    // Earliest early_start across ALL tasks — mirrors Python and the full
    // schedule path; out-of-sequence actuals can move the minimum off
    // `topo_order[0]` (#1494).
    let project_start = tasks.iter().filter_map(|t| t.early_start).min().unwrap();

    Ok(ScheduleResult {
        project_id: project.id.clone(),
        project_start,
        project_finish,
        tasks: task_results,
        critical_path,
    })
}

/// Resolve `changed_task_id` to its node and return the dense downstream mask
/// (inclusive of the changed task), indexed by node position.
///
/// Shared by the JSON `compute_downstream` path and the typed-array drag path
/// (#1856) so the "which tasks are downstream" logic lives in one place. A stale
/// `changed_task_id` (deleted mid-drag) is rejected as a clean `Err` here rather
/// than index-panicking and trapping the WASM module (#1087).
pub(crate) fn downstream_mask(
    pg: &ProjectGraph,
    changed_task_id: &str,
    node_count: usize,
) -> Result<Vec<bool>, String> {
    let Some(&changed_idx) = pg.node_index.get(changed_task_id) else {
        return Err(format!(
            "changed_task_id {changed_task_id:?} does not exist in the project."
        ));
    };
    Ok(bfs_downstream(pg, changed_idx, node_count))
}

/// BFS forward from `start` to mark all downstream nodes (inclusive) in a dense
/// `Vec<bool>` indexed by node position (#1535). `node_count` is `pg`'s node
/// count, so the mask covers every task even those the BFS never reaches.
fn bfs_downstream(pg: &ProjectGraph, start: NodeIndex, node_count: usize) -> Vec<bool> {
    let mut visited = vec![false; node_count];
    let mut queue = VecDeque::new();
    queue.push_back(start);
    visited[start.index()] = true;

    while let Some(idx) = queue.pop_front() {
        for neighbor in pg
            .graph
            .neighbors_directed(idx, petgraph::Direction::Outgoing)
        {
            if !visited[neighbor.index()] {
                visited[neighbor.index()] = true;
                queue.push_back(neighbor);
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
            calendar_id: None,
            delivery_mode: None,
            story_points: None,
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
            calendars: None,
            velocity_samples: None,
            sprint_length_days: None,
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
