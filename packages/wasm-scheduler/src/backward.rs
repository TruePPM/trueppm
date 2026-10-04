//! CPM backward pass — computes late_start and late_finish for every task.
//!
//! Mirrors the Python `_backward_pass` function from `trueppm_scheduler.engine`.

use chrono::NaiveDate;
use petgraph::graph::NodeIndex;
use petgraph::visit::EdgeRef;
use petgraph::Direction;

use crate::calendar::{
    checked_offset_days, finish_from_start, next_working_day, prev_working_day,
    retreat_calendar_days, start_from_finish, PassCalendars,
};
use crate::forward::{milestone_link, start_anchored, start_reading, Instant, MilestoneInstants};
use crate::graph::ProjectGraph;
use crate::models::{Calendar, Dependency, DependencyType, Task};

/// `(start_ref, finish_ref)` a milestone successor at `instant` offers its
/// predecessors: the instant itself, and the day it closes — *unsnapped*, because
/// a link into a milestone proposes a raw instant (#4272). Every backward
/// inversion is `anchor + lag <= ref`, so these slot into the formulas written
/// for ordinary tasks (FF into a milestone is FS, [`milestone_link`]). Mirrors the
/// Python `_milestone_refs` (#4079).
pub(crate) fn milestone_refs(instant: NaiveDate) -> Result<(NaiveDate, NaiveDate), String> {
    Ok((instant, checked_offset_days(instant, -1)?))
}

/// Latest instant a milestone may sit on and still honor one successor link: the
/// inverse of `forward::edge_anchor` for a milestone predecessor. A lagged FF
/// measures from `X - 1` itself (#4273), so its inverse is the raw
/// `finish_ref + 1 - lag`; FF reaches this only from a successor with work (into
/// a milestone it is FS, [`milestone_link`]). Mirrors the Python
/// `_milestone_latest` (#4079).
pub(crate) fn milestone_latest(
    dep_type: DependencyType,
    lag_days: i64,
    start_ref: NaiveDate,
    finish_ref: NaiveDate,
    node_cal: &Calendar,
) -> Result<NaiveDate, String> {
    if start_anchored(dep_type) {
        return checked_offset_days(start_ref, -lag_days);
    }
    if dep_type == DependencyType::FF && lag_days != 0 {
        return checked_offset_days(finish_ref, 1 - lag_days);
    }
    let last = prev_working_day(checked_offset_days(finish_ref, -lag_days)?, node_cal)?;
    next_working_day(checked_offset_days(last, 1)?, node_cal)
}

/// Latest start day an ordinary task may take without moving an SF successor's finish.
///
/// The inverse of `edge_anchor`'s SF anchor for ordinary work (#4145): the forward
/// bound is measured from `prev_wd(start - 1)`, so the largest allowed anchor is
/// `prev_wd(W - lag)` and the largest start day is the first working day after it.
/// Deliberately the same expression as [`milestone_latest`]'s finish-anchored
/// branch — a start instant and a milestone instant invert identically. Mirrors the
/// Python `_sf_latest_start`.
pub(crate) fn sf_latest_start(
    succ_finish: NaiveDate,
    lag_days: i64,
    node_cal: &Calendar,
) -> Result<NaiveDate, String> {
    let last = prev_working_day(checked_offset_days(succ_finish, -lag_days)?, node_cal)?;
    next_working_day(checked_offset_days(last, 1)?, node_cal)
}

/// The instant the project ends: the latest task finish, milestones as their
/// instants. Every late date is seeded from it; without milestones it is the day
/// after `project_finish`, the old seed. Mirrors the Python `_finish_instant`.
pub(crate) fn finish_instant(
    tasks: &[Task],
    instants: &[Option<Instant>],
    project_finish: NaiveDate,
) -> Result<NaiveDate, String> {
    if instants.iter().all(Option::is_none) {
        return checked_offset_days(project_finish, 1);
    }
    let mut latest: Option<NaiveDate> = None;
    for (t, inst) in tasks.iter().zip(instants) {
        let end = match inst {
            Some(i) => i.0,
            None => checked_offset_days(t.early_finish.unwrap(), 1)?,
        };
        latest = Some(latest.map_or(end, |l| l.max(end)));
    }
    Ok(latest.expect("a project has at least one task"))
}

/// Latest instant the project-finish seed admits for a milestone (#4174).
///
/// When `end` already reads as start of day (`project_finish >= end`, e.g.
/// `A(4d) -FS+2d-> M` placing `M` at Sunday midnight, shown Monday), every
/// midnight up to the one opening the next working day shows the same finish, so
/// the bound widens to it. When `end` reads as end of day (`A -FS+1d-> M` at
/// Saturday midnight, shown Friday), the raw `end` is the bound: Sunday midnight
/// is shown Monday under #4173's display rule, so landing there moves the finish.
/// The shown day stays capped by `late_display`. Mirrors the Python
/// `_milestone_finish_bound`.
pub(crate) fn milestone_finish_bound(
    end: NaiveDate,
    project_finish: NaiveDate,
    node_cal: &Calendar,
) -> Result<NaiveDate, String> {
    if project_finish >= end {
        next_working_day(end, node_cal)
    } else {
        Ok(end)
    }
}

/// Latest instant up to `instant` that a given reading still shows by
/// `project_finish` (#4183). When the project ends at the end of a day (`W`
/// finishing Friday: finish instant Saturday midnight, `project_finish` Friday), a
/// milestone at Saturday midnight read as end of day is shown Friday, but read as
/// start of day it is shown Monday and moves the finish. A start-of-day reading is
/// therefore capped at the last working day on or before `project_finish`. With a
/// start-of-day finish (#4174) the cap never binds. Mirrors the Python
/// `_start_read_cap`.
fn start_read_cap(
    instant: NaiveDate,
    start_display: bool,
    cal: &Calendar,
    project_finish: NaiveDate,
) -> Result<NaiveDate, String> {
    if !start_reading(instant, start_display, cal)?
        || next_working_day(instant, cal)? <= project_finish
    {
        return Ok(instant);
    }
    prev_working_day(project_finish, cal)
}

/// The milestone `start_ref` one FS/SS link into it may use (#4183): capped by
/// [`start_read_cap`] when the link gives the milestone a start-of-day reading
/// (SS from work). A zero-lag link from a milestone carries that milestone's
/// reading, and late instants are computed for the end-of-day reading, so it is
/// not capped here; the start-of-day bound follows from the same cap where it is
/// read (the cap is a `min`, so it commutes with the `min` over links). The cap is
/// per link rather than on the shared late instant, because an FS predecessor of
/// the same milestone really can slip it to the finish instant. Mirrors the
/// Python `_link_start_ref`.
fn link_start_ref(
    start_ref: NaiveDate,
    (dep_type, lag_days): (DependencyType, i64),
    pred_is_milestone: bool,
    succ_cal: &Calendar,
    project_finish: NaiveDate,
) -> Result<NaiveDate, String> {
    if !start_anchored(dep_type) {
        return Ok(start_ref);
    }
    let inherits = pred_is_milestone && lag_days == 0;
    let base_display = dep_type == DependencyType::SS && !inherits;
    start_read_cap(start_ref, base_display, succ_cal, project_finish)
}

/// The day a milestone's late instant is shown on. Mirrors the Python
/// `_late_display`: zero float shows the early day; otherwise the early reading
/// is kept, except that a start-of-day reading is never shown past the project
/// finish.
fn late_display(
    late: NaiveDate,
    early_day: NaiveDate,
    early: Instant,
    cal: &Calendar,
    project_finish: NaiveDate,
) -> Result<NaiveDate, String> {
    if next_working_day(late, cal)? == next_working_day(early.0, cal)? {
        return Ok(early_day);
    }
    if early.1 && cal.is_working_day(late) && late <= project_finish {
        return Ok(late);
    }
    prev_working_day(checked_offset_days(late, -1)?, cal)
}

/// `(start_ref, finish_ref)` a live successor's late window offers its predecessor
/// along `dep`, and the type to invert the link as: FF into a milestone is FS
/// ([`milestone_link`], #4272). A milestone successor's start reference is capped
/// per link ([`link_start_ref`], #4183).
fn late_refs(
    succ_idx: usize,
    succ: &Task,
    late_instants: &[Option<NaiveDate>],
    cals: &PassCalendars,
    link: (&Dependency, bool, NaiveDate),
) -> Result<(NaiveDate, NaiveDate, DependencyType), String> {
    let (dep, pred_is_milestone, project_finish) = link;
    match late_instants[succ_idx] {
        Some(x) => {
            let succ_cal = cals.for_node(succ_idx);
            let (start_ref, finish_ref) = milestone_refs(x)?;
            let seen = milestone_link(dep.dep_type);
            Ok((
                link_start_ref(
                    start_ref,
                    (seen, dep.lag_days()),
                    pred_is_milestone,
                    succ_cal,
                    project_finish,
                )?,
                finish_ref,
                seen,
            ))
        }
        None => Ok((
            succ.late_start.unwrap(),
            succ.late_finish.unwrap(),
            dep.dep_type,
        )),
    }
}

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
///
/// Milestones (#4079): `instants` is what `forward_pass` returned. A milestone's
/// late instant is the latest one every successor link admits, a milestone
/// successor offers its instant to its predecessors (`milestone_refs`), and every
/// late date is seeded from the project's finish instant. Returns each live
/// milestone's late instant as its own float is measured to it: capped by
/// [`start_read_cap`] for the reading that places it early (#4183). Predecessors
/// read the uncapped instant, capped per link. The result is therefore named
/// `float_lates` at every call site (`lib.rs`, `typed.rs`, `incremental.rs`),
/// matching the Python engine, which caps in `schedule()` via
/// `_float_late_instant` instead of inside the pass.
///
/// A milestone held up by the project-start floor alone is shown later than its
/// link instant (#4225, `MilestoneInstants`). Its late instant — what its
/// predecessors invert against — is floored at the link instant, so they see the
/// bound the direct link would give them; its own late date and float are still
/// floored at the shown instant, never shown before its early date.
pub fn backward_pass(
    tasks: &mut [Task],
    topo_order: &[NodeIndex],
    pg: &ProjectGraph,
    deps: &[Dependency],
    project_finish: NaiveDate,
    cals: &PassCalendars,
    milestones: &MilestoneInstants,
) -> Result<Vec<Option<NaiveDate>>, String> {
    let instants = &milestones.shown;
    let end = finish_instant(tasks, instants, project_finish)?;
    let mut late_instants: Vec<Option<NaiveDate>> = vec![None; tasks.len()];
    let mut float_lates: Vec<Option<NaiveDate>> = vec![None; tasks.len()];
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

        if let Some(early) = instants[i] {
            let mut bound = milestone_finish_bound(end, project_finish, node_cal)?;
            for edge in pg.graph.edges_directed(idx, Direction::Outgoing) {
                let s = edge.target().index();
                if tasks[s].is_complete() {
                    continue;
                }
                let dep = &deps[*edge.weight()];
                let (start_ref, finish_ref, seen) = late_refs(
                    s,
                    &tasks[s],
                    &late_instants,
                    cals,
                    (dep, true, project_finish),
                )?;
                bound = bound.min(milestone_latest(
                    seen,
                    dep.lag_days(),
                    start_ref,
                    finish_ref,
                    node_cal,
                )?);
            }
            let link = milestones.links[i].unwrap_or(early);
            let late = bound.max(link.0);
            let early_day = tasks[i].early_start.unwrap();
            let day = late_display(
                late.max(early.0),
                early_day,
                early,
                node_cal,
                project_finish,
            )?;
            late_instants[i] = Some(late);
            // A milestone's own total float is *defined* against the reading that
            // places it early (#4183). The reason is not insertion invariance —
            // `A -FS-> M -FS-> B` scheduling as `A -FS-> B` holds either way,
            // since it asserts nothing about M's own float. It is that near the
            // finish this makes M's float the working-day span between its shown
            // early start and its shown late start, which `late_display` already
            // caps at `project_finish`. It is a semantic choice with effects beyond
            // the reported tie (a floored milestone, `X -SF-> M`: 5 -> 4 days, and
            // new critical milestones), and not a general invariant: a start-of-day
            // milestone whose late instant is a weekend midnight before the finish
            // is still shown late on the Friday while its float runs through it.
            // Mirrors the Python `_float_late_instant`.
            float_lates[i] =
                Some(start_read_cap(late, early.1, node_cal, project_finish)?.max(early.0));
            let t = &mut tasks[i];
            t.late_start = Some(day);
            t.late_finish = Some(day);
            continue;
        }

        // In-progress work's late span covers only its remaining duration.
        let duration_days = tasks[i].effective_duration_days();

        // Seed the late-finish floor at the project end snapped to this node's
        // last workable day: project_finish is max(early_finish) and can land on
        // a day this node cannot work (a completed task's weekend actual_finish),
        // overstating float and propagating upstream (#1820). A no-op when
        // project_finish is already a working day.
        //
        // Every bound below is likewise working-day snapped, so none of them can
        // express an early window that sits on a non-working day. That mismatch is
        // resolved once, at the end of this iteration (#3963).
        let mut lf_constraints: Vec<NaiveDate> =
            vec![prev_working_day(checked_offset_days(end, -1)?, node_cal)?];
        let (succ_lf_constraints, ls_constraints) = successor_constraints(
            idx,
            tasks,
            pg,
            deps,
            node_cal,
            cals,
            (&late_instants, project_finish),
        )?;
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

        // Floor the late window at this task's own early window (#3963). A late
        // date is never earlier than its early counterpart: a task asked to finish
        // before the day it can finish has an incoherent window no consumer can
        // draw, and `working_days_between` clamps the negative span to 0 on the way
        // into total_float, additionally reporting the task as critical.
        //
        // The two passes differ in coordinate system on exactly one class of input.
        // An early window may sit on a NON-WORKING day — a recorded `actual_start`
        // is kept verbatim (ADR-0132 §2). (A live zero-duration milestone no longer
        // reaches this code: it is an instant placed above — #4079. The milestone
        // example below is the history of this floor.) Every backward bound is `prev_working_day`
        // snapped and so cannot name that day: a milestone pinned to a Saturday
        // whose successor starts Monday gets a late finish of Friday. Friday and
        // Saturday are the same position in working-day arithmetic — the float is
        // genuinely zero either way — so raising the late window picks the coherent
        // representation of an already-correct answer. For a window on working days
        // it is a no-op. Mirrors the Python `_apply_late_dates`.
        //
        // Not purely local: this loop runs in reverse topological order and
        // `successor_constraints` reads `succ.late_start`, so raising one task's
        // late window propagates upstream. On `P -FS-> M(milestone, actual_start =
        // Sat) -FS-> S`, P's total float goes 1 -> 2 working days even though P
        // carries no actual and sits entirely on working days. The new number is
        // correct — P really can finish a day later and still let M begin on its
        // recorded Saturday — but the blast radius is wider than one task.
        let (es, ef) = {
            let t = &tasks[i];
            (t.early_start.unwrap(), t.early_finish.unwrap())
        };
        let task = &mut tasks[i];
        task.late_start = Some(ls.max(es));
        task.late_finish = Some(final_lf.max(ef));
    }
    Ok(float_lates)
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
/// be able to work (ADR-0120 D3, Python #1490). `project_finish` rides with
/// `late_instants` for the per-link milestone cap ([`link_start_ref`], #4183).
fn successor_constraints(
    idx: NodeIndex,
    tasks: &[Task],
    pg: &ProjectGraph,
    deps: &[Dependency],
    node_cal: &Calendar,
    cals: &PassCalendars,
    (late_instants, project_finish): (&[Option<NaiveDate>], NaiveDate),
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

        // A milestone successor offers its late instant (#4079).
        let (succ_ls, succ_lf, seen) = late_refs(
            edge.target().index(),
            succ,
            late_instants,
            cals,
            (dep, false, project_finish),
        )?;

        match seen {
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
                // The predecessor's SF anchor is the working day *before* its
                // start, so it may start one working day past the retreated
                // bound (#4145).
                ls_constraints.push(sf_latest_start(succ_lf, lag_days, node_cal)?);
            }
        }
    }
    Ok((lf_constraints, ls_constraints))
}
