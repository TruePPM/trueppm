//! Incremental CPM update — the drag-preview recalc and its emitted delta.
//!
//! Used for drag preview. The full CPM runs every time; what is incremental is
//! the *set of tasks returned*: every task downstream of the changed one, plus
//! every task whose CPM output moved relative to what the input carried for it
//! (see [`emit_mask`]).

use std::collections::VecDeque;

use petgraph::graph::NodeIndex;

use crate::backward::backward_pass;
use crate::floats::compute_floats;
use crate::forward::forward_pass;
use crate::graph::{build_graph, ProjectGraph};
use crate::models::{Project, ScheduleResult, Task, TaskResult};

/// Run an incremental update: recompute the full CPM for the project (forward +
/// backward + floats) and return the tasks [`emit_mask`] selects — those
/// downstream of the changed task, plus any other task whose CPM output differs
/// from the values the input carried for it.
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

/// Run the full CPM over an already-built graph and return the tasks
/// [`emit_mask`] selects: those downstream of `changed_task_id` (inclusive),
/// plus every task whose CPM output moved relative to the input.
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

    // Per-task calendars (ADR-0120 D3); uniform = single-calendar fast path.
    let cals = crate::calendar::PassCalendars::resolve(project);

    let instants = forward_pass(
        &mut tasks,
        &pg.topo_order,
        pg,
        &project.dependencies,
        project.start_date,
        &cals,
        project.status_date,
    )?;

    let project_finish = tasks.iter().filter_map(|t| t.early_finish).max().unwrap();

    let float_lates = backward_pass(
        &mut tasks,
        &pg.topo_order,
        pg,
        &project.dependencies,
        project_finish,
        &cals,
        &instants,
    )?;

    // compute_floats runs over the full topo order, so the driving edges it
    // returns cover the whole graph — include them so an offline drag keeps the
    // schedule view's driving/non-driving link hierarchy correct (#2095).
    let driving_edges = compute_floats(
        &mut tasks,
        &pg.topo_order,
        pg,
        &project.dependencies,
        &cals,
        &instants,
        &float_lates,
    )?;

    let emit = emit_mask(downstream, &project.tasks, &tasks);
    let task_results: Vec<TaskResult> = pg
        .topo_order
        .iter()
        .filter(|&&i| emit[i.index()])
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
                scheduled_start: t.scheduled_start.unwrap(),
                milestone_at_day_end: t.milestone_at_day_end,
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
        driving_edges,
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

/// Which tasks an incremental recalc returns (#4101): every task downstream of
/// the changed one, plus every task whose CPM output differs from the value the
/// input carried for it.
///
/// The downstream cone alone is the *forward* pass's reach. The backward pass
/// reaches further: when a drag moves the project finish, every task's late
/// dates are measured back from the new finish, so `late_start`, `late_finish`,
/// `total_float` and `is_critical` change on upstream and parallel tasks that no
/// path from the changed task touches. Returning only the cone left those rows
/// showing the float of the previous frame until the server reconciled.
///
/// The comparison baseline is the input task (`before`, indexed by node
/// position like `after`). A caller that passes its previous run's output back
/// gets a true delta; one whose input carries no computed values gets every
/// task, because each output differs from an absent one. Both are complete: no
/// task whose values moved is ever left out.
pub(crate) fn emit_mask(downstream: Vec<bool>, before: &[Task], after: &[Task]) -> Vec<bool> {
    let mut emit = downstream;
    for (i, (b, a)) in before.iter().zip(after.iter()).enumerate() {
        if !emit[i] && cpm_output_changed(b, a) {
            emit[i] = true;
        }
    }
    emit
}

/// Whether any field the engine writes differs between `before` and `after`.
/// Floats are compared exactly: both sides come from the same integer
/// working-day count times 86 400, so equal values are bit-identical.
fn cpm_output_changed(before: &Task, after: &Task) -> bool {
    before.early_start != after.early_start
        || before.early_finish != after.early_finish
        || before.late_start != after.late_start
        || before.late_finish != after.late_finish
        || before.scheduled_start != after.scheduled_start
        || before.milestone_at_day_end != after.milestone_at_day_end
        || before.total_float.to_bits() != after.total_float.to_bits()
        || before.free_float.to_bits() != after.free_float.to_bits()
        || before.is_critical != after.is_critical
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
            scheduled_start: None,
            milestone_at_day_end: false,
            live_day_end_on: None,
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

    /// #4101: lengthening the downstream end of a chain moves the finish, so a
    /// parallel task that no path from the changed task reaches gains float. The
    /// preview must return that task with the full run's float, not drop it.
    #[test]
    fn parallel_branch_float_follows_a_finish_the_drag_moved() {
        // A(5) -> B(3) is the critical chain; P(2) runs in parallel off nothing.
        let mut base = project();
        base.tasks.push(task("P", 2));
        let before = crate::schedule_impl(&base).unwrap();

        // Prime the input with the previous run's output, as the preview does.
        let mut dragged = base.clone();
        for t in dragged.tasks.iter_mut() {
            let b = before.tasks.iter().find(|r| r.id == t.id).unwrap();
            t.early_start = Some(b.early_start);
            t.early_finish = Some(b.early_finish);
            t.late_start = Some(b.late_start);
            t.late_finish = Some(b.late_finish);
            t.scheduled_start = Some(b.scheduled_start);
            t.total_float = b.total_float;
            t.free_float = b.free_float;
            t.is_critical = b.is_critical;
            if t.id == "B" {
                t.duration += 4.0 * 86_400.0;
            }
        }

        let full = crate::schedule_impl(&dragged).unwrap();
        let incr = incremental_update(&dragged, "B").unwrap();
        let full_p = full.tasks.iter().find(|t| t.id == "P").unwrap();
        let before_p = before.tasks.iter().find(|t| t.id == "P").unwrap();
        assert!(
            full_p.total_float > before_p.total_float,
            "fixture must move P's float, or the test proves nothing"
        );
        let incr_p = incr
            .tasks
            .iter()
            .find(|t| t.id == "P")
            .expect("P's float moved, so the incremental result must carry it");
        assert_eq!(incr_p.total_float, full_p.total_float);
        assert_eq!(incr_p.late_finish, full_p.late_finish);
        // A is upstream of B and stays critical with zero float: nothing moved,
        // so the delta leaves it out.
        assert!(incr.tasks.iter().all(|t| t.id != "A"));
    }

    /// Without prior output in the input, every task's output "moved", so every
    /// task is returned (#4101).
    #[test]
    fn unprimed_input_returns_every_task() {
        let mut p = project();
        p.tasks.push(task("P", 2));
        let incr = incremental_update(&p, "B").unwrap();
        assert_eq!(incr.tasks.len(), 3);
    }
}
