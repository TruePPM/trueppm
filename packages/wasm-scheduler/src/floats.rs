//! Float computation — total float, free float, and critical flag.
//!
//! Mirrors the Python `_compute_floats` function from `trueppm_scheduler.engine`.

use std::collections::HashMap;

use chrono::Duration;

use crate::calendar::{advance_calendar_days, next_working_day, working_days_between};
use crate::graph::{get_dependency, successors, ProjectGraph};
use crate::models::{Calendar, Dependency, DependencyType, Task};

/// Compute total_float, free_float, and is_critical for every task (in-place).
pub fn compute_floats(
    task_map: &mut HashMap<String, Task>,
    topo_order: &[String],
    pg: &ProjectGraph,
    deps: &[Dependency],
    calendar: &Calendar,
) -> Result<(), String> {
    for node_id in topo_order {
        let es = task_map[node_id].early_start.unwrap();
        let ef = task_map[node_id].early_finish.unwrap();
        let ls = task_map[node_id].late_start.unwrap();

        // Total float: working days between ES and LS.
        let tf_days = working_days_between(es, ls, calendar);
        let is_critical = tf_days == 0;

        // Free float: smallest slack to any successor across every dependency
        // type (PMI definition, #825). `imposed` is the early date this task
        // forces on the successor through the link (mirroring the forward pass);
        // `succ_date` is the successor's matching early date. Capped at total
        // float, which is also the value when there are no successors.
        let mut ff_days = tf_days;
        let succs = successors(pg, node_id);
        for succ_id in &succs {
            let dep = get_dependency(pg, deps, node_id, succ_id);
            let lag_days = dep.lag_days();
            let succ_es = task_map[succ_id].early_start.unwrap();
            let succ_ef = task_map[succ_id].early_finish.unwrap();
            let (imposed, succ_date) = match dep.dep_type {
                DependencyType::FS => (
                    next_working_day(ef + Duration::days(1 + lag_days), calendar)?,
                    succ_es,
                ),
                DependencyType::SS => (advance_calendar_days(es, lag_days, calendar)?, succ_es),
                DependencyType::FF => (advance_calendar_days(ef, lag_days, calendar)?, succ_ef),
                DependencyType::SF => (advance_calendar_days(es, lag_days, calendar)?, succ_ef),
            };
            let slack = working_days_between(imposed, succ_date, calendar);
            ff_days = ff_days.min(slack.max(0));
        }
        ff_days = ff_days.max(0);

        let task = task_map.get_mut(node_id).unwrap();
        task.total_float = tf_days as f64 * 86400.0;
        task.free_float = ff_days as f64 * 86400.0;
        task.is_critical = is_critical;
    }
    Ok(())
}
