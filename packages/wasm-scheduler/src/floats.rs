//! Float computation — total float, free float, and critical flag.
//!
//! Mirrors the Python `_compute_floats` function from `trueppm_scheduler.engine`.

use std::collections::HashMap;

use crate::calendar::working_days_between;
use crate::graph::{get_dependency, successors, ProjectGraph};
use crate::models::{Calendar, Dependency, DependencyType, Task};

/// Compute total_float, free_float, and is_critical for every task (in-place).
pub fn compute_floats(
    task_map: &mut HashMap<String, Task>,
    topo_order: &[String],
    pg: &ProjectGraph,
    deps: &[Dependency],
    calendar: &Calendar,
) {
    for node_id in topo_order {
        let es = task_map[node_id].early_start.unwrap();
        let ef = task_map[node_id].early_finish.unwrap();
        let ls = task_map[node_id].late_start.unwrap();

        // Total float: working days between ES and LS.
        let tf_days = working_days_between(es, ls, calendar);
        let is_critical = tf_days == 0;

        // Free float: how much this task can slip before delaying any FS successor.
        let mut ff_days = tf_days;
        let succs = successors(pg, node_id);
        for succ_id in &succs {
            let dep = get_dependency(pg, deps, node_id, succ_id);
            if dep.dep_type == DependencyType::FS {
                let succ_es = task_map[succ_id].early_start.unwrap();
                let gap = working_days_between(ef, succ_es, calendar);
                ff_days = ff_days.min((gap - 1).max(0));
            }
        }
        ff_days = ff_days.max(0);

        let task = task_map.get_mut(node_id).unwrap();
        task.total_float = tf_days as f64 * 86400.0;
        task.free_float = ff_days as f64 * 86400.0;
        task.is_critical = is_critical;
    }
}
