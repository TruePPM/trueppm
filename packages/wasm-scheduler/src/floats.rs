//! Float computation — total float, free float, and critical flag.
//!
//! Mirrors the Python `_compute_floats` function from `trueppm_scheduler.engine`.

use chrono::NaiveDate;
use petgraph::graph::NodeIndex;
use petgraph::visit::EdgeRef;
use petgraph::Direction;

use crate::backward::{milestone_latest, milestone_refs, sf_latest_start};
use crate::calendar::{
    checked_offset_days, next_working_day, prev_working_day, retreat_calendar_days,
    working_days_between, PassCalendars, WorkingDayCounter,
};
use crate::forward::{milestone_link, start_anchored, start_reading, Instant, MilestoneInstants};
use crate::graph::ProjectGraph;
use crate::models::{Calendar, Dependency, DependencyType, DrivingEdge, Task};

/// The latest instant each milestone may reach without moving anything, for free
/// float (#4180). Mirrors the Python `_milestone_free_instants`.
///
/// A milestone's early position is its shown day plus its reading, not the raw
/// instant. A start-of-day reading is shown on `next_wd(instant)`, and every
/// midnight up to that one lies in the same stretch of non-working time, so the
/// milestone admits any of them (`A(4d) -FS+2d-> M`: Sunday and Monday midnight
/// are both the start of Monday). An end-of-day reading stays at the raw instant,
/// because the next midnight is shown on the next working day (#4173).
///
/// The raw instant is still what the milestone's own links measure from, and a
/// calendar-day lag carries it downstream, so the stretch is also capped by every
/// live successor link, inverted with `milestone_latest` against that successor's
/// early references — its own free instant when it is a milestone, which is why
/// this walks the topological order backwards.
///
/// A milestone held up by the project-start floor alone (#4225) is shown at the
/// floor but measured from at its earlier link instant; its stretch runs from that
/// link instant, so its predecessors see the slack the direct link gives them.
///
/// A successor that is itself a milestone is reached through the same reading-tie
/// bound `compute_floats` applies to ordinary work ([`free_start_ref`], #4183) —
/// not just `milestone_latest` against its raw free instant (#4329). Without it,
/// this bound can overstate how far *this* milestone's own instant may travel:
/// pushing it up to that successor's raw free instant can flip the successor's
/// reading from the end-of-day instant another, unrelated, predecessor already
/// occupies to a start-of-day one at the very same raw instant — and a
/// start-of-day proposal always outranks an end-of-day one at a tie
/// (`place_milestone`), so the successor's *shown day* moves even though its raw
/// free instant, taken alone, did not. Mirrors the Python `_milestone_free_instants`.
fn milestone_free_instants(
    tasks: &[Task],
    topo_order: &[NodeIndex],
    pg: &ProjectGraph,
    deps: &[Dependency],
    cals: &PassCalendars,
    milestones: &MilestoneInstants,
) -> Result<Vec<Option<NaiveDate>>, String> {
    let mut free: Vec<Option<NaiveDate>> = vec![None; tasks.len()];
    for &idx in topo_order.iter().rev() {
        let i = idx.index();
        let Some(early) = milestones.shown[i] else {
            continue;
        };
        let (instant, start_display) = early;
        let own_link_instant = milestones.links[i].unwrap_or(early);
        let link = own_link_instant.0;
        if !start_display {
            free[i] = Some(instant);
            continue;
        }
        let cal = cals.for_node(i);
        let mut bound = next_working_day(instant, cal)?;
        for edge in pg.graph.edges_directed(idx, Direction::Outgoing) {
            let s = edge.target().index();
            let succ = &tasks[s];
            if succ.is_complete() {
                continue;
            }
            let dep = &deps[*edge.weight()];
            // FF into a milestone is FS (#4272).
            let (start_ref, finish_ref, seen) = match free[s] {
                Some(x) => {
                    let seen = milestone_link(dep.dep_type);
                    let (_, b) = milestone_refs(x)?;
                    let succ_shown = milestones.shown[s]
                        .ok_or_else(|| "free instant implies a shown instant".to_string())?;
                    let start_ref = free_start_ref(
                        (x, succ_shown.1),
                        (seen, dep.lag_days()),
                        Some(own_link_instant),
                        cals.for_node(s),
                    )?;
                    (start_ref, b, seen)
                }
                None => (
                    succ.early_start.unwrap(),
                    succ.early_finish.unwrap(),
                    dep.dep_type,
                ),
            };
            bound = bound.min(milestone_latest(
                seen,
                dep.lag_days(),
                start_ref,
                finish_ref,
                cal,
            )?);
        }
        free[i] = Some(link.max(bound));
    }
    Ok(free)
}

/// Working-day span counter that keeps the O(log n) fast path where it is valid.
///
/// A span goes through the prebuilt [`WorkingDayCounter`] only when the node's
/// calendar **is** the project calendar the counter was built over; a per-task
/// calendar falls back to the O(span) scalar reference. Both return identical
/// counts — this mirrors the Python `_wdb` helper's `cal is calendar` test
/// exactly, so the single-calendar path keeps using the counter for every span
/// (#1534).
struct SpanCounter<'a> {
    counter: WorkingDayCounter<'a>,
    calendar: &'a Calendar,
}

impl SpanCounter<'_> {
    fn between(&self, start: NaiveDate, end: NaiveDate, cal: &Calendar) -> Result<i32, String> {
        if std::ptr::eq(cal, self.calendar) {
            self.counter.between(start, end)
        } else {
            working_days_between(start, end, cal)
        }
    }
}

/// The (anchor, latest) pair a single dependency imposes for free float.
///
/// `latest` is the last date the predecessor could finish (FS/FF) or start
/// (SS/SF) while leaving the successor's *early* date untouched; `anchor` is the
/// predecessor's matching early date. The slack between them is this
/// relationship's free float.
///
/// Computed by **inverting** the forward constraint — the same retreat the
/// backward pass applies for late dates — rather than measuring the gap from the
/// forward-imposed date, which diverged whenever a calendar-day lag re-lands
/// across non-working days as the task slips (#1828).
fn free_float_anchor(
    (dep_type, lag_days): (DependencyType, i64),
    es: NaiveDate,
    ef: NaiveDate,
    succ_es: NaiveDate,
    succ_ef: NaiveDate,
    node_cal: &Calendar,
) -> Result<(NaiveDate, NaiveDate), String> {
    Ok(match dep_type {
        DependencyType::FS => (
            ef,
            prev_working_day(checked_offset_days(succ_es, -1 - lag_days)?, node_cal)?,
        ),
        DependencyType::SS => (es, retreat_calendar_days(succ_es, lag_days, node_cal)?),
        DependencyType::FF => (ef, retreat_calendar_days(succ_ef, lag_days, node_cal)?),
        // SF bounds the successor's finish from the working day *before* this
        // task's start, so the latest start is one working day past the retreat
        // (#4145).
        DependencyType::SF => (es, sf_latest_start(succ_ef, lag_days, node_cal)?),
    })
}

/// The start reference an FS/SS link's free float may run to in a milestone
/// successor (#4183). An end-of-day milestone at instant `I` flips to the
/// start-of-day reading, and its shown day moves, when a start-of-day proposal
/// ties it at `I` (the tie rule in `place_milestone`). So when this link would read
/// `I` as start of day, read exactly as `place_milestone` reads it, the latest
/// proposal that leaves the milestone alone is one day before `I`. Mirrors the
/// Python `_free_start_ref`.
fn free_start_ref(
    succ_early: Instant,
    (dep_type, lag_days): (DependencyType, i64),
    own: Option<Instant>,
    succ_cal: &Calendar,
) -> Result<NaiveDate, String> {
    let (instant, start_display) = succ_early;
    if start_display || !start_anchored(dep_type) {
        return Ok(instant);
    }
    let base_display = match own {
        Some(o) if lag_days == 0 => o.1,
        _ => dep_type == DependencyType::SS,
    };
    if !start_reading(instant, base_display, succ_cal)? {
        return Ok(instant);
    }
    checked_offset_days(instant, -1)
}

/// Compute total_float, free_float, and is_critical for every task (in-place).
///
/// Dense-index (#1535): tasks are carried in a `Vec<Task>` indexed by node
/// position and each node's successors are read from its outgoing edges directly
/// (`edge.target()` is the successor, `deps[*edge.weight()]` its dependency).
///
/// Working-day span counts (`ES..LS` per task, `imposed..succ_date` per edge) go
/// through a [`WorkingDayCounter`] built once over the schedule's date range,
/// turning each count from an O(span) day loop into two binary searches (#1534).
///
/// Returns the [`DrivingEdge`]s discovered as a side output of the free-float
/// slack loop — links whose relationship free float is zero (#2095), sorted by
/// `(predecessor_id, successor_id, dep_type_str)` to match the Python engine.
///
/// Milestones (#4079): a milestone's spans run between *instants* — its early
/// instant from `forward_pass` and, in `float_lates`, the late instant its own
/// float runs to — `backward_pass` returns these already capped for the
/// milestone's own reading (#4183), unlike the raw late instants its predecessors
/// read inside the pass — and a milestone successor offers its free instant
/// (`milestone_free_instants`, #4180), further bounded by [`free_start_ref`] on a
/// reading tie (#4183). Mirrors the
/// Python `_compute_floats` / `_link_slack`, including a milestone's signed slack.
pub fn compute_floats(
    tasks: &mut [Task],
    topo_order: &[NodeIndex],
    pg: &ProjectGraph,
    deps: &[Dependency],
    cals: &PassCalendars,
    milestones: &MilestoneInstants,
    float_lates: &[Option<NaiveDate>],
) -> Result<Vec<DrivingEdge>, String> {
    // A milestone's own floats run from its shown instant; a zero-lag link carries
    // its link instant's reading into a milestone successor (#4225).
    let instants = &milestones.shown;
    let calendar = cals.default_calendar();
    let spans = SpanCounter {
        counter: WorkingDayCounter::build(tasks, calendar)?,
        calendar,
    };
    let mut driving_edges: Vec<DrivingEdge> = Vec::new();
    // Free float compares a milestone successor by its shown position, not its raw
    // instant (#4180).
    let free_instants = milestone_free_instants(tasks, topo_order, pg, deps, cals, milestones)?;
    for &idx in topo_order {
        let i = idx.index();
        let es = tasks[i].early_start.unwrap();
        let ef = tasks[i].early_finish.unwrap();
        let ls = tasks[i].late_start.unwrap();
        let pred_id = tasks[i].id.clone();
        // Every span below is measured on *this* task's own calendar: the slip is
        // counted in the days this task can actually work, and each constraint is
        // snapped on the same calendar, mirroring the backward pass (ADR-0120 D3).
        let node_cal = cals.for_node(i);

        // Total float: working days between ES and LS — between the early and late
        // instants for a milestone (#4079).
        let tf_days = match (instants[i], float_lates[i]) {
            (Some(early), Some(late)) => spans.between(early.0, late, node_cal)?,
            _ => spans.between(es, ls, node_cal)?,
        };
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
            let s = edge.target().index();
            // The arithmetic inverts the type a milestone successor sees — FF into
            // a milestone is FS (#4272) — while a driving edge keeps the link's own.
            let link = match free_instants[s] {
                Some(_) => (milestone_link(dep.dep_type), dep.lag_days()),
                None => (dep.dep_type, dep.lag_days()),
            };
            // The free-float instant a lagged milestone successor is measured at
            // (#4180) is the baseline both the slack and the driving-edge check use.
            let raw_refs = match free_instants[s] {
                Some(x) => milestone_refs(x)?,
                None => (succ.early_start.unwrap(), succ.early_finish.unwrap()),
            };
            // A tie that flips the milestone's reading moves it (#4183), layered on
            // top of that free instant. The two adjustments never both act on the
            // same instant: #4180 only advances one that reads as start of day, and
            // #4183's tie bound only adjusts one that reads as end of day.
            let refs = match instants[s] {
                Some((_, start_display)) => (
                    free_start_ref(
                        (free_instants[s].unwrap(), start_display),
                        link,
                        milestones.links[i],
                        cals.for_node(s),
                    )?,
                    raw_refs.1,
                ),
                None => raw_refs,
            };
            let slack_to = |(succ_start, succ_finish): (NaiveDate, NaiveDate)| {
                Ok::<i32, String>(match instants[i] {
                    Some(own) => {
                        let latest =
                            milestone_latest(link.0, link.1, succ_start, succ_finish, node_cal)?;
                        if latest < own.0 {
                            -spans.between(latest, own.0, node_cal)?
                        } else {
                            spans.between(own.0, latest, node_cal)?
                        }
                    }
                    None => {
                        let (anchor, latest) =
                            free_float_anchor(link, es, ef, succ_start, succ_finish, node_cal)?;
                        spans.between(anchor, latest, node_cal)?
                    }
                })
            };
            let slack = slack_to(refs)?;
            ff_days = ff_days.min(slack.max(0));
            // Whether a link *drives* is read off the free instant, not #4183's
            // further tie adjustment: a link bounded only by a reading tie does not
            // set the milestone's instant, another link does, so it is not the
            // driving predecessor even at zero free float. Mirrors the Python
            // `_free_float_days`.
            let drive_slack = if refs == raw_refs {
                slack
            } else {
                slack_to(raw_refs)?
            };
            // Zero relationship free float ⇒ this link drives the successor's early
            // date (#2095). The forward pass guarantees slack >= 0, so the exact
            // zero test matches the Python engine bit-for-bit.
            if drive_slack == 0 {
                driving_edges.push(DrivingEdge {
                    predecessor_id: pred_id.clone(),
                    successor_id: succ.id.clone(),
                    dep_type: dep.dep_type,
                });
            }
        }
        ff_days = ff_days.max(0);

        let task = &mut tasks[i];
        task.total_float = tf_days as f64 * 86400.0;
        task.free_float = ff_days as f64 * 86400.0;
        task.is_critical = is_critical;
    }
    // Sort by the same (pred, succ, dep_type STRING) key the Python engine uses so
    // the two engines' driving_edges lists are byte-identical for conformance.
    driving_edges.sort_by(|a, b| {
        (&a.predecessor_id, &a.successor_id, a.dep_type.as_str()).cmp(&(
            &b.predecessor_id,
            &b.successor_id,
            b.dep_type.as_str(),
        ))
    });
    Ok(driving_edges)
}
