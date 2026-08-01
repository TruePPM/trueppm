//! CPM forward pass — computes early_start and early_finish for every task.
//!
//! Mirrors the Python `_forward_pass` function from `trueppm_scheduler.engine`.

use std::collections::hash_map::Entry;
use std::collections::HashMap;

use chrono::NaiveDate;
use petgraph::graph::NodeIndex;
use petgraph::visit::EdgeRef;
use petgraph::Direction;

use crate::calendar::{
    advance_calendar_days, checked_offset_days, finish_from_start, next_working_day,
    start_from_finish, PassCalendars,
};
use crate::graph::ProjectGraph;
use crate::models::{Calendar, Dependency, DependencyType, Task};

/// The (un-floored, floored) start pair for one calendar, memoized.
///
/// The project-start floor and the data-date floor snap to the task's *own*
/// calendar — a task can never begin on a day it cannot work. Under one project
/// calendar every task resolves the same pair, so the result is byte-identical
/// to the pre-ADR-0120 hoist. With per-task calendars the pair is memoized by
/// calendar address (mirroring the Python pass's `id(cal)` memo, #1824) so the
/// snap runs once per calendar rather than once per task — a sparse calendar's
/// snap walk is not free.
fn start_floors_for(
    memo: &mut HashMap<*const Calendar, (NaiveDate, NaiveDate)>,
    node_cal: &Calendar,
    project_start: NaiveDate,
    status_date: Option<NaiveDate>,
) -> Result<(NaiveDate, NaiveDate), String> {
    match memo.entry(node_cal as *const Calendar) {
        Entry::Occupied(e) => Ok(*e.get()),
        Entry::Vacant(e) => {
            let base = next_working_day(project_start, node_cal)?;
            let floored = match status_date {
                // A status date at or before project start is already covered
                // by the project-start floor, hence the max().
                Some(sd) => base.max(next_working_day(sd, node_cal)?),
                None => base,
            };
            Ok(*e.insert((base, floored)))
        }
    }
}

/// Pull ES/EF forward to satisfy the FF/SF constraints, if any bind.
///
/// An EF constraint that lands later than the duration-derived finish forces the
/// task to start later too, so the finish is re-derived from the back-solved
/// start — and then re-floored at `min_ef`, because snapping the start onto a
/// working day can push the finish back past the constraint that caused it.
fn apply_ef_constraints(
    es: NaiveDate,
    ef: NaiveDate,
    es_constraints: &[NaiveDate],
    ef_constraints: &[NaiveDate],
    duration_days: i32,
    node_cal: &Calendar,
) -> Result<(NaiveDate, NaiveDate), String> {
    if ef_constraints.is_empty() {
        return Ok((es, ef));
    }
    let min_ef = *ef_constraints.iter().max().unwrap();
    if min_ef <= ef {
        return Ok((es, ef));
    }
    let back_start = start_from_finish(min_ef, duration_days, node_cal)?;
    let max_es = *es_constraints.iter().max().unwrap();
    let final_es = back_start.max(max_es);
    let final_ef = finish_from_start(final_es, duration_days, node_cal)?.max(min_ef);
    Ok((final_es, final_ef))
}

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
/// Per-task calendars (ADR-0120 D3): the task being computed (the successor of
/// every incoming edge) uses its own calendar for *all* of its arithmetic —
/// duration expansion **and** the working-day snap of every predecessor
/// constraint, since lag lands on the successor's calendar and the successor *is*
/// the node here. A project with no `calendars` registry resolves every node to
/// the pass-level calendar, making the single-calendar path identical.
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
    cals: &PassCalendars,
    status_date: Option<NaiveDate>,
) -> Result<(), String> {
    // Memoized per distinct calendar — see `start_floors_for`.
    let mut floors_by_cal: HashMap<*const Calendar, (NaiveDate, NaiveDate)> = HashMap::new();

    for &idx in topo_order {
        let i = idx.index();
        // The node being computed is the successor of all its incoming edges, so a
        // single calendar — its own — governs both its duration and the snap of
        // every predecessor constraint (lag is consumed on the successor's
        // calendar). With no per-task calendars this is always the pass-level one.
        let node_cal = cals.for_node(i);
        let (start_base, start) =
            start_floors_for(&mut floors_by_cal, node_cal, project_start, status_date)?;

        if let Some((es, ef)) = pinned_placement(&tasks[i], node_cal)? {
            let t = &mut tasks[i];
            t.early_start = Some(es);
            t.early_finish = Some(ef);
            t.scheduled_start = Some(compute_scheduled_start(t, node_cal)?);
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
            es_constraints.push(next_working_day(ps, node_cal)?);
        }
        let (pred_es_constraints, ef_constraints) =
            edge_constraints(idx, tasks, pg, deps, node_cal)?;
        es_constraints.extend(pred_es_constraints);

        // ES = latest of all ES constraints.
        let es = *es_constraints.iter().max().unwrap();
        let ef = finish_from_start(es, duration_days, node_cal)?;

        // Apply EF constraints (from FF/SF dependencies).
        let (final_es, ef) = apply_ef_constraints(
            es,
            ef,
            &es_constraints,
            &ef_constraints,
            duration_days,
            node_cal,
        )?;

        let task = &mut tasks[i];
        task.early_start = Some(final_es);
        task.early_finish = Some(ef);
        task.scheduled_start = Some(compute_scheduled_start(task, node_cal)?);
    }
    Ok(())
}

/// The task's span start (ADR-0752), as distinct from `early_start`.
///
/// Mirrors the Python `_compute_scheduled_start`: `early_start`/`early_finish`
/// mean the *remaining-work window* for an in-progress task (ADR-0132) — correct
/// for network scheduling, but not the task's span. `scheduled_start` is the
/// span start:
///
/// - Not started (`percent_complete <= 0`) or complete (`is_complete()`):
///   `early_start` — the windows coincide.
/// - In progress, `actual_start` recorded: `actual_start` — the span may then
///   exceed `duration` (a task running long); that divergence is the point.
/// - In progress, no `actual_start`: the full duration backed off from
///   `early_finish` (unaffected by this call — remaining work still ends when
///   the task ends), calendar-aware via `start_from_finish`.
///
/// Must be called after `task.early_start`/`task.early_finish` are set for this
/// task (i.e. from within `forward_pass`, after the early window is resolved).
fn compute_scheduled_start(task: &Task, calendar: &Calendar) -> Result<NaiveDate, String> {
    let early_start = task
        .early_start
        .expect("early_start set before scheduled_start");
    let early_finish = task
        .early_finish
        .expect("early_finish set before scheduled_start");
    if task.is_complete() {
        return Ok(early_start);
    }
    if task.percent_complete <= 0.0 {
        return Ok(early_start);
    }
    if let Some(a) = task.actual_start {
        return Ok(a);
    }
    let full_days = task.duration_days();
    start_from_finish(early_finish, full_days, calendar)
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
