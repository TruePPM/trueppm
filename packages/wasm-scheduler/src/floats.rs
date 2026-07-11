//! Float computation — total float, free float, and critical flag.
//!
//! Mirrors the Python `_compute_floats` function from `trueppm_scheduler.engine`.

use petgraph::graph::NodeIndex;
use petgraph::visit::EdgeRef;
use petgraph::Direction;

use crate::calendar::{
    advance_calendar_days, checked_offset_days, next_working_day, WorkingDayCounter,
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
    let counter = WorkingDayCounter::build(tasks, calendar);
    for &idx in topo_order {
        let i = idx.index();
        let es = tasks[i].early_start.unwrap();
        let ef = tasks[i].early_finish.unwrap();
        let ls = tasks[i].late_start.unwrap();

        // Total float: working days between ES and LS.
        let tf_days = counter.between(es, ls);
        let is_critical = tf_days == 0;

        // Free float: smallest slack to any successor across every dependency
        // type (standard critical-path definition, #825). `imposed` is the early date this task
        // forces on the successor through the link (mirroring the forward pass);
        // `succ_date` is the successor's matching early date. Capped at total
        // float, which is also the value when there are no successors.
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
            let (imposed, succ_date) = match dep.dep_type {
                DependencyType::FS => (
                    next_working_day(checked_offset_days(ef, 1 + lag_days)?, calendar)?,
                    succ_es,
                ),
                DependencyType::SS => (advance_calendar_days(es, lag_days, calendar)?, succ_es),
                DependencyType::FF => (advance_calendar_days(ef, lag_days, calendar)?, succ_ef),
                DependencyType::SF => (advance_calendar_days(es, lag_days, calendar)?, succ_ef),
            };
            let slack = counter.between(imposed, succ_date);
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
