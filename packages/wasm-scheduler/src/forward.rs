//! CPM forward pass — computes early_start and early_finish for every task.
//!
//! Mirrors the Python `_forward_pass` function from `trueppm_scheduler.engine`.

use chrono::NaiveDate;
use petgraph::graph::NodeIndex;
use petgraph::visit::EdgeRef;
use petgraph::Direction;

use crate::calendar::{
    advance_calendar_days, checked_offset_days, finish_from_start, next_working_day,
    start_from_finish,
};
use crate::graph::ProjectGraph;
use crate::models::{Calendar, Dependency, DependencyType, Task};

/// Compute early_start and early_finish for every task (in-place).
///
/// Progress-aware (ADR-0132), mirroring the Python `_forward_pass`: a completed
/// task (`actual_finish` set, or `percent_complete >= 100`) is pinned to its
/// recorded span at full duration and taken out of network logic; an in-progress
/// task contributes only its remaining duration; and when `status_date` (the data
/// date) is given, remaining/not-started work is floored at it so future work is
/// never scheduled in the past. With no actuals and no status date the result is
/// byte-identical to a pure planning pass.
///
/// Returns `Err` (instead of panicking) when a calendar walk cannot reach a
/// working day within the scan bound — see `calendar::next_working_day` (#908).
///
/// Tasks are carried in a `Vec<Task>` indexed by node position (#1535); each
/// node's predecessors are read by iterating its incoming edges directly
/// (`edge.source()` is the predecessor, `deps[*edge.weight()]` its dependency),
/// eliminating the per-node `Vec<String>` allocation and the id-keyed
/// `get_dependency` edge scan.
pub fn forward_pass(
    tasks: &mut [Task],
    topo_order: &[NodeIndex],
    pg: &ProjectGraph,
    deps: &[Dependency],
    project_start: NaiveDate,
    calendar: &Calendar,
    status_date: Option<NaiveDate>,
) -> Result<(), String> {
    // The project-start floor; and the data-date floor for not-yet-finished work.
    // Both are node-independent under a single project calendar (the WASM engine
    // has no per-task calendars), so they are hoisted out of the loop.
    let start_base = next_working_day(project_start, calendar)?;
    let start = match status_date {
        // A status date at or before project start is already covered by the
        // project-start floor, hence the max().
        Some(sd) => start_base.max(next_working_day(sd, calendar)?),
        None => start_base,
    };

    for &idx in topo_order {
        let i = idx.index();
        if let Some((es, ef)) = pinned_placement(&tasks[i], calendar)? {
            let t = &mut tasks[i];
            t.early_start = Some(es);
            t.early_finish = Some(ef);
            continue;
        }

        // In-progress work contributes only what is left, laid forward from the
        // data date; not-started work uses its full estimate; a complete-without-
        // actuals task uses full duration anchored at the un-floored start.
        let (duration_days, base_es) = if tasks[i].is_complete() {
            (tasks[i].duration_days(), start_base)
        } else {
            (tasks[i].effective_duration_days(), start)
        };

        let mut es_constraints: Vec<NaiveDate> = vec![base_es];
        if let Some(ps) = tasks[i].planned_start {
            es_constraints.push(next_working_day(ps, calendar)?);
        }
        let (pred_es_constraints, ef_constraints) =
            edge_constraints(idx, tasks, pg, deps, calendar)?;
        es_constraints.extend(pred_es_constraints);

        // ES = latest of all ES constraints.
        let es = *es_constraints.iter().max().unwrap();
        let mut ef = finish_from_start(es, duration_days, calendar)?;

        // Apply EF constraints (from FF/SF dependencies).
        let mut final_es = es;
        if !ef_constraints.is_empty() {
            let min_ef = *ef_constraints.iter().max().unwrap();
            if min_ef > ef {
                ef = min_ef;
                let back_start = start_from_finish(ef, duration_days, calendar)?;
                let max_es = *es_constraints.iter().max().unwrap();
                final_es = back_start.max(max_es);
                ef = finish_from_start(final_es, duration_days, calendar)?.max(min_ef);
            }
        }

        let task = &mut tasks[i];
        task.early_start = Some(final_es);
        task.early_finish = Some(ef);
    }
    Ok(())
}

/// Placement for a task whose recorded actuals pin it out of network logic.
///
/// A completed task (`actual_finish` set, or `percent_complete >= 100`) is laid
/// out at its FULL duration so the bar keeps its shape (ADR-0136). Actuals are
/// truth, so a pinned task may even sit before a predecessor — out-of-sequence
/// reality is surfaced rather than smoothed away.
///
/// Returns `None` — meaning "schedule this one through the network" — when the
/// task is not complete, and for the complete-via-`percent_complete`-only case
/// with no actuals at all: that task takes a full-duration planning position
/// anchored at the un-floored project start.
fn pinned_placement(
    task: &Task,
    calendar: &Calendar,
) -> Result<Option<(NaiveDate, NaiveDate)>, String> {
    if !task.is_complete() {
        return Ok(None);
    }
    let full_days = task.duration_days();
    if let Some(af) = task.actual_finish {
        // Finish known; start is the recorded actual, else a full duration back
        // from the finish.
        let es = match task.actual_start {
            Some(a) => a,
            None => start_from_finish(af, full_days, calendar)?,
        };
        return Ok(Some((es, af)));
    }
    if let Some(a) = task.actual_start {
        // Start known (e.g. done, awaiting sign-off): lay full duration forward
        // from it.
        return Ok(Some((a, finish_from_start(a, full_days, calendar)?)));
    }
    Ok(None)
}

/// Split a node's incoming edges into early-start and early-finish constraints.
///
/// FS/SS constrain when the successor may *start*; FF/SF constrain when it may
/// *finish*. The predecessor's dates are unwrapped unconditionally because
/// topological order guarantees every predecessor was scheduled on an earlier
/// iteration of the pass.
fn edge_constraints(
    idx: NodeIndex,
    tasks: &[Task],
    pg: &ProjectGraph,
    deps: &[Dependency],
    calendar: &Calendar,
) -> Result<(Vec<NaiveDate>, Vec<NaiveDate>), String> {
    let mut es_constraints: Vec<NaiveDate> = Vec::new();
    let mut ef_constraints: Vec<NaiveDate> = Vec::new();

    for edge in pg.graph.edges_directed(idx, Direction::Incoming) {
        let dep = &deps[*edge.weight()];
        let lag_days = dep.lag_days();

        let pred = &tasks[edge.source().index()];
        let pred_es = pred.early_start.unwrap();
        let pred_ef = pred.early_finish.unwrap();

        match dep.dep_type {
            DependencyType::FS => {
                // Successor cannot start until the day after predecessor finishes + lag.
                es_constraints.push(next_working_day(
                    checked_offset_days(pred_ef, 1 + lag_days)?,
                    calendar,
                )?);
            }
            DependencyType::SS => {
                es_constraints.push(advance_calendar_days(pred_es, lag_days, calendar)?);
            }
            DependencyType::FF => {
                ef_constraints.push(advance_calendar_days(pred_ef, lag_days, calendar)?);
            }
            DependencyType::SF => {
                ef_constraints.push(advance_calendar_days(pred_es, lag_days, calendar)?);
            }
        }
    }
    Ok((es_constraints, ef_constraints))
}
