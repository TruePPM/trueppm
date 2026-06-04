//! CPM backward pass — computes late_start and late_finish for every task.
//!
//! Mirrors the Python `_backward_pass` function from `trueppm_scheduler.engine`.

use std::collections::HashMap;

use chrono::NaiveDate;

use crate::calendar::{
    checked_offset_days, finish_from_start, prev_working_day, retreat_calendar_days,
    start_from_finish,
};
use crate::graph::{get_dependency, successors, ProjectGraph};
use crate::models::{Calendar, Dependency, DependencyType, Task};

/// Compute late_start and late_finish for every task (in-place).
pub fn backward_pass(
    task_map: &mut HashMap<String, Task>,
    topo_order: &[String],
    pg: &ProjectGraph,
    deps: &[Dependency],
    project_finish: NaiveDate,
    calendar: &Calendar,
) -> Result<(), String> {
    for node_id in topo_order.iter().rev() {
        let duration_days = task_map[node_id].duration_days();

        let mut lf_constraints: Vec<NaiveDate> = vec![project_finish];
        let mut ls_constraints: Vec<NaiveDate> = Vec::new();

        let succs = successors(pg, node_id);
        for succ_id in &succs {
            let dep = get_dependency(pg, deps, node_id, succ_id);
            let lag_days = dep.lag_days();

            let succ = &task_map[succ_id];
            let succ_ls = succ.late_start.unwrap();
            let succ_lf = succ.late_finish.unwrap();

            match dep.dep_type {
                DependencyType::FS => {
                    // Predecessor must finish the day before successor's late start minus lag.
                    lf_constraints.push(prev_working_day(
                        checked_offset_days(succ_ls, -(1 + lag_days))?,
                        calendar,
                    )?);
                }
                DependencyType::SS => {
                    ls_constraints.push(retreat_calendar_days(succ_ls, lag_days, calendar)?);
                }
                DependencyType::FF => {
                    lf_constraints.push(retreat_calendar_days(succ_lf, lag_days, calendar)?);
                }
                DependencyType::SF => {
                    ls_constraints.push(retreat_calendar_days(succ_lf, lag_days, calendar)?);
                }
            }
        }

        // LF = earliest of all LF constraints.
        let lf = *lf_constraints.iter().min().unwrap();
        let mut ls = start_from_finish(lf, duration_days, calendar)?;

        // Apply LS constraints (from SS/SF dependencies).
        let mut final_lf = lf;
        if !ls_constraints.is_empty() {
            let max_ls = *ls_constraints.iter().min().unwrap();
            if max_ls < ls {
                ls = max_ls;
                let fwd_finish = finish_from_start(ls, duration_days, calendar)?;
                final_lf = fwd_finish.min(*lf_constraints.iter().min().unwrap());
            }
        } else {
            final_lf = lf;
        }

        let task = task_map.get_mut(node_id).unwrap();
        task.late_start = Some(ls);
        task.late_finish = Some(final_lf);
    }
    Ok(())
}
