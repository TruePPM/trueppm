//! Float computation — total float, free float, and critical flag.
//!
//! Mirrors the Python `_compute_floats` function from `trueppm_scheduler.engine`.

use petgraph::graph::NodeIndex;
use petgraph::visit::EdgeRef;
use petgraph::Direction;

use crate::calendar::{
    checked_offset_days, prev_working_day, retreat_calendar_days, WorkingDayCounter,
};
use crate::graph::ProjectGraph;
use crate::models::{Calendar, Dependency, DependencyType, Task};

/// Compute total_float, free_float, and is_critical for every task (in-place).
///
/// Dense-index (#1535): tasks are carried in a `Vec<Task>` indexed by node
/// position and each node's successors are read from its outgoing edges directly
/// (`edge.target()` is the successor, `deps[*edge.weight()]` its dependency).
///
/// Working-day span counts (`ES..LS` per task, `imposed..succ_date` per edge) go
/// through a [`WorkingDayCounter`] built once over the schedule's date range,
/// turning each count from an O(span) day loop into two binary searches (#1534).
pub fn compute_floats(
    tasks: &mut [Task],
    topo_order: &[NodeIndex],
    pg: &ProjectGraph,
    deps: &[Dependency],
    calendar: &Calendar,
) -> Result<(), String> {
    let counter = WorkingDayCounter::build(tasks, calendar)?;
    for &idx in topo_order {
        let i = idx.index();
        let es = tasks[i].early_start.unwrap();
        let ef = tasks[i].early_finish.unwrap();
        let ls = tasks[i].late_start.unwrap();

        // Total float: working days between ES and LS.
        let tf_days = counter.between(es, ls)?;
        // A completed task is never on the critical path. The backward pass pins a
        // done task to late == early (ADR-0132/0136), mechanically yielding zero
        // total float — but a finished task has no remaining work and no slack to
        // manage, so it cannot drive the project finish and must not be reported as
        // critical. Completion overrides the zero-float rule; total_float stays 0
        // because the task genuinely has no slack. Mirrors the Python guard (#1863).
        let is_critical = tf_days == 0 && !tasks[i].is_complete();

        // Free float (standard critical-path definition, #825): the largest slip
        // this task can absorb before it pushes the early date of any live
        // successor. Like total float, compute it by **inverting** the forward
        // constraint — the same retreat the backward pass applies for late dates —
        // anchored on each successor's *early* date (not late, which is what makes
        // it free rather than total float). `latest` is the last date this task
        // could finish (FS/FF) or start (SS/SF) leaving the successor untouched;
        // the slack is the working-day slip from this task's own early date to it.
        // Measuring the gap from the *forward*-imposed date instead (the old proxy)
        // diverged whenever a calendar-day lag re-lands across non-working days as
        // the task slips (#1828). Capped at total float; the value when there are
        // no live successors.
        let mut ff_days = tf_days;
        for edge in pg.graph.edges_directed(idx, Direction::Outgoing) {
            let succ = &tasks[edge.target().index()];
            // Mirror the backward pass: a completed successor is out of network
            // logic (ADR-0136) and imposes no live constraint, so it cannot bound
            // this task's slip. Including it reports false-zero free float (#1819).
            if succ.is_complete() {
                continue;
            }
            let dep = &deps[*edge.weight()];
            let lag_days = dep.lag_days();
            let succ_es = succ.early_start.unwrap();
            let succ_ef = succ.early_finish.unwrap();
            let (anchor, latest) = match dep.dep_type {
                DependencyType::FS => (
                    ef,
                    prev_working_day(checked_offset_days(succ_es, -1 - lag_days)?, calendar)?,
                ),
                DependencyType::SS => (es, retreat_calendar_days(succ_es, lag_days, calendar)?),
                DependencyType::FF => (ef, retreat_calendar_days(succ_ef, lag_days, calendar)?),
                DependencyType::SF => (es, retreat_calendar_days(succ_ef, lag_days, calendar)?),
            };
            let slack = counter.between(anchor, latest)?;
            ff_days = ff_days.min(slack.max(0));
        }
        ff_days = ff_days.max(0);

        let task = &mut tasks[i];
        task.total_float = tf_days as f64 * 86400.0;
        task.free_float = ff_days as f64 * 86400.0;
        task.is_critical = is_critical;
    }
    Ok(())
}
