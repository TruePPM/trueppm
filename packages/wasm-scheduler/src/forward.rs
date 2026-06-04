//! CPM forward pass — computes early_start and early_finish for every task.
//!
//! Mirrors the Python `_forward_pass` function from `trueppm_scheduler.engine`.

use std::collections::HashMap;

use chrono::NaiveDate;

use crate::calendar::{
    advance_calendar_days, checked_offset_days, finish_from_start, next_working_day,
    start_from_finish,
};
use crate::graph::{get_dependency, predecessors, ProjectGraph};
use crate::models::{Calendar, Dependency, DependencyType, Task};

/// Compute early_start and early_finish for every task (in-place).
///
/// Returns `Err` (instead of panicking) when a calendar walk cannot reach a
/// working day within the scan bound — see `calendar::next_working_day` (#908).
pub fn forward_pass(
    task_map: &mut HashMap<String, Task>,
    topo_order: &[String],
    pg: &ProjectGraph,
    deps: &[Dependency],
    project_start: NaiveDate,
    calendar: &Calendar,
) -> Result<(), String> {
    let start = next_working_day(project_start, calendar)?;

    for node_id in topo_order {
        let duration_days = task_map[node_id].duration_days();
        let planned_start = task_map[node_id].planned_start;

        // Collect ES constraints from predecessors.
        let mut es_constraints: Vec<NaiveDate> = vec![start];
        if let Some(ps) = planned_start {
            es_constraints.push(next_working_day(ps, calendar)?);
        }
        let mut ef_constraints: Vec<NaiveDate> = Vec::new();

        let preds = predecessors(pg, node_id);
        for pred_id in &preds {
            let dep = get_dependency(pg, deps, pred_id, node_id);
            let lag_days = dep.lag_days();

            let pred = &task_map[pred_id];
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
        } else {
            final_es = es;
        }

        let task = task_map.get_mut(node_id).unwrap();
        task.early_start = Some(final_es);
        task.early_finish = Some(ef);
    }
    Ok(())
}
