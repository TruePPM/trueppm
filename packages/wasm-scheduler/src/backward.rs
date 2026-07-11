//! CPM backward pass — computes late_start and late_finish for every task.
//!
//! Mirrors the Python `_backward_pass` function from `trueppm_scheduler.engine`.

use chrono::NaiveDate;
use petgraph::graph::NodeIndex;
use petgraph::visit::EdgeRef;
use petgraph::Direction;

use crate::calendar::{
    checked_offset_days, finish_from_start, prev_working_day, retreat_calendar_days,
    start_from_finish,
};
use crate::graph::ProjectGraph;
use crate::models::{Calendar, Dependency, DependencyType, Task};

/// Compute late_start and late_finish for every task (in-place).
///
/// Progress-aware (ADR-0132/0136), mirroring the Python `_backward_pass`: a
/// completed task carries zero float (late == early — it is done, it has no
/// slack), reusing the full-duration span the forward pass resolved; an
/// in-progress task's late dates span only its remaining duration, matching the
/// forward pass so total/free float stay internally consistent.
///
/// Dense-index (#1535): tasks are carried in a `Vec<Task>` indexed by node
/// position and each node's successors are read from its outgoing edges directly
/// (`edge.target()` is the successor, `deps[*edge.weight()]` its dependency).
pub fn backward_pass(
    tasks: &mut [Task],
    topo_order: &[NodeIndex],
    pg: &ProjectGraph,
    deps: &[Dependency],
    project_finish: NaiveDate,
    calendar: &Calendar,
) -> Result<(), String> {
    for &idx in topo_order.iter().rev() {
        let i = idx.index();
        // Completed: late == early, so the task carries zero float and never
        // distorts the critical path. The forward pass already resolved its
        // full-duration span (ADR-0136).
        if tasks[i].is_complete() {
            let (es, ef) = {
                let t = &tasks[i];
                (t.early_start.unwrap(), t.early_finish.unwrap())
            };
            let t = &mut tasks[i];
            t.late_start = Some(es);
            t.late_finish = Some(ef);
            continue;
        }

        // In-progress work's late span covers only its remaining duration.
        let duration_days = tasks[i].effective_duration_days();

        // Seed the late-finish floor at the project end snapped to this node's
        // last workable day: project_finish is max(early_finish) and can land on
        // a day this node cannot work (a completed task's weekend actual_finish),
        // overstating float and propagating upstream (#1820). A no-op when
        // project_finish is already a working day.
        let mut lf_constraints: Vec<NaiveDate> = vec![prev_working_day(project_finish, calendar)?];
        let mut ls_constraints: Vec<NaiveDate> = Vec::new();

        for edge in pg.graph.edges_directed(idx, Direction::Outgoing) {
            let succ = &tasks[edge.target().index()];
            // A completed successor is out of network logic (ADR-0136); it
            // imposes no backward constraint on a live predecessor. Including it
            // would clamp this task's late dates to the done successor's actuals,
            // reporting false-zero float and polluting the critical path (#1819).
            if succ.is_complete() {
                continue;
            }
            let dep = &deps[*edge.weight()];
            let lag_days = dep.lag_days();

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

        let task = &mut tasks[i];
        task.late_start = Some(ls);
        task.late_finish = Some(final_lf);
    }
    Ok(())
}
