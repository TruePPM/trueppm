//! CPM backward pass — computes late_start and late_finish for every task.
//!
//! Mirrors the Python `_backward_pass` function from `trueppm_scheduler.engine`.

use chrono::NaiveDate;
use petgraph::graph::NodeIndex;
use petgraph::visit::EdgeRef;
use petgraph::Direction;

use crate::calendar::{
    checked_offset_days, finish_from_start, prev_working_day, retreat_calendar_days,
    start_from_finish, PassCalendars,
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
    cals: &PassCalendars,
) -> Result<(), String> {
    for &idx in topo_order.iter().rev() {
        let i = idx.index();
        // This node is the predecessor of its outgoing edges; its own calendar lays
        // out its duration, floors its late finish at the project finish, and snaps
        // every successor-derived constraint. Snapping those on the *successor's*
        // calendar instead was the Python engine's #1490: it could place a
        // predecessor's own late date before its early date, under-report float,
        // and pull spurious tasks onto the critical path.
        let node_cal = cals.for_node(i);
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
        let mut lf_constraints: Vec<NaiveDate> = vec![prev_working_day(project_finish, node_cal)?];
        let (succ_lf_constraints, ls_constraints) =
            successor_constraints(idx, tasks, pg, deps, node_cal)?;
        lf_constraints.extend(succ_lf_constraints);

        // LF = earliest of all LF constraints.
        let lf = *lf_constraints.iter().min().unwrap();
        let mut ls = start_from_finish(lf, duration_days, node_cal)?;

        // Apply LS constraints (from SS/SF dependencies).
        let mut final_lf = lf;
        if !ls_constraints.is_empty() {
            let max_ls = *ls_constraints.iter().min().unwrap();
            if max_ls < ls {
                ls = max_ls;
                let fwd_finish = finish_from_start(ls, duration_days, node_cal)?;
                final_lf = fwd_finish.min(*lf_constraints.iter().min().unwrap());
            }
        }

        let task = &mut tasks[i];
        task.late_start = Some(ls);
        task.late_finish = Some(final_lf);
    }
    Ok(())
}

/// Split a node's outgoing edges into late-finish and late-start constraints.
///
/// The mirror of `forward::edge_constraints`: FS/FF bound when this task may
/// *finish*; SS/SF bound when it may *start*. The successor's late dates are
/// unwrapped unconditionally because the reversed topological order guarantees
/// every successor was scheduled on an earlier iteration.
///
/// `node_cal` is the calendar of the node *being computed* — the predecessor —
/// not the successor's. Every retreat here produces a date that predecessor must
/// be able to work (ADR-0120 D3, Python #1490).
fn successor_constraints(
    idx: NodeIndex,
    tasks: &[Task],
    pg: &ProjectGraph,
    deps: &[Dependency],
    node_cal: &Calendar,
) -> Result<(Vec<NaiveDate>, Vec<NaiveDate>), String> {
    let mut lf_constraints: Vec<NaiveDate> = Vec::new();
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
                    node_cal,
                )?);
            }
            DependencyType::SS => {
                ls_constraints.push(retreat_calendar_days(succ_ls, lag_days, node_cal)?);
            }
            DependencyType::FF => {
                lf_constraints.push(retreat_calendar_days(succ_lf, lag_days, node_cal)?);
            }
            DependencyType::SF => {
                ls_constraints.push(retreat_calendar_days(succ_lf, lag_days, node_cal)?);
            }
        }
    }
    Ok((lf_constraints, ls_constraints))
}
