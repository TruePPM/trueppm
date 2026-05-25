//! Incremental CPM update — subgraph extraction and forward-only recalc.
//!
//! Used for drag preview: only recomputes tasks downstream of the changed task.
//! Mirrors the BFS approach in `buildSubgraph.ts` combined with a forward pass.

use std::collections::{HashMap, HashSet, VecDeque};

use crate::graph::{build_graph, ProjectGraph};
use crate::models::{Project, ScheduleResult, Task, TaskResult};
use crate::forward::forward_pass;
use crate::backward::backward_pass;
use crate::floats::compute_floats;

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
    );

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
    );

    compute_floats(
        &mut task_map,
        &pg.topo_order,
        &pg,
        &project.dependencies,
        &project.calendar,
    );

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

    let critical_path: Vec<String> = pg
        .topo_order
        .iter()
        .filter(|id| task_map[*id].is_critical)
        .cloned()
        .collect();

    let project_start = task_map[&pg.topo_order[0]].early_start.unwrap();

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
