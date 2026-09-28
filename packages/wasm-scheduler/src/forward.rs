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
    prev_working_day, start_from_finish, PassCalendars,
};
use crate::graph::ProjectGraph;
use crate::models::{Calendar, Dependency, DependencyType, Task};

/// A zero-duration milestone's position (#4079): `(instant, start_display)`.
///
/// `instant` is the midnight the milestone sits on — the end of one day is the
/// start of the next — and is the only thing links measure from. `start_display`
/// only chooses the day it is shown on. Mirrors the Python engine's `_Instant`;
/// see the `trueppm_scheduler.engine` module docstring for the convention.
pub type Instant = (NaiveDate, bool);

/// Whether a dependency type bounds its successor's *start* (FS/SS).
pub(crate) fn start_anchored(dep_type: DependencyType) -> bool {
    matches!(dep_type, DependencyType::FS | DependencyType::SS)
}

/// The raw date a predecessor's constraint on its successor is measured from.
///
/// Every forward constraint is `next_working_day(anchor + lag)` on the successor's
/// calendar. Ordinary work (`instant` is `None`) anchors FS on the day after its
/// inclusive finish, SS on its start, FF on its finish and SF on the last working
/// day *before* its start. A milestone is one instant: FS/SS measure from the
/// instant, FF/SF from the last working day before it. Mirrors the Python
/// `_edge_anchor` (#4079, #4145).
///
/// SF (#4145) is the finish-anchored instant rule applied to the predecessor's
/// start instant: MS Project and P6 finish an SF successor at the start of its
/// predecessor's start day, so its last working day is the day before — which is
/// also where a zero-duration milestone standing at that same midnight puts it.
pub(crate) fn edge_anchor(
    dep_type: DependencyType,
    start: NaiveDate,
    finish: NaiveDate,
    instant: Option<NaiveDate>,
    pred_cal: &Calendar,
) -> Result<NaiveDate, String> {
    match instant {
        None => match dep_type {
            DependencyType::FS => checked_offset_days(finish, 1),
            DependencyType::FF => Ok(finish),
            DependencyType::SS => Ok(start),
            DependencyType::SF => prev_working_day(checked_offset_days(start, -1)?, pred_cal),
        },
        Some(x) if start_anchored(dep_type) => Ok(x),
        Some(x) => prev_working_day(checked_offset_days(x, -1)?, pred_cal),
    }
}

/// The day an instant is shown on: the first working day at or after it for a
/// start-of-day reading, the last working day before it otherwise. Mirrors the
/// Python `_instant_day`.
pub(crate) fn instant_day(
    instant: NaiveDate,
    start_display: bool,
    cal: &Calendar,
) -> Result<NaiveDate, String> {
    if start_display {
        next_working_day(instant, cal)
    } else {
        prev_working_day(checked_offset_days(instant, -1)?, cal)
    }
}

/// Whether an instant proposed by a start-anchored link reads as a day start.
///
/// An end-of-day reading names the end of the working day before the instant,
/// which only exists when that day is a working day; an instant just after
/// non-working time (Sunday or Monday midnight, after a weekend) is shown at the
/// start of the next working day, as MS Project snaps an elapsed lag there. This
/// keeps the shown day monotone in the instant, so a longer predecessor can never
/// show a milestone a working day earlier (#4173). Mirrors the Python
/// `_start_reading`.
pub(crate) fn start_reading(
    instant: NaiveDate,
    start_display: bool,
    cal: &Calendar,
) -> Result<bool, String> {
    Ok(start_display || !cal.is_working_day(checked_offset_days(instant, -1)?))
}

/// Place a zero-duration task as an instant: `((instant, start_display), day)`.
///
/// Every floor and incoming link proposes a raw midnight and the latest wins, a
/// start-of-day reading winning a tie (floors are offered first, so a floor keeps
/// its verbatim day on a tie). Floors propose the start of their day; FS/SS links
/// propose `anchor + lag`, shown at the end of the previous working day after FS
/// from work, at the start of the day after SS from work, and — only at zero lag,
/// where the proposed instant is the very midnight the predecessor milestone
/// occupies — as that predecessor is shown (a lagged link out of a milestone
/// falls back to the FS/SS-from-work rule, #4206) — except that an instant just
/// after non-working time is always shown at the start of the next working day
/// ([`start_reading`], #4173); FF/SF links propose the end of the finish day
/// `next_wd(anchor + lag)`. Mirrors the Python `_place_milestone` (#4079).
fn place_milestone(
    idx: NodeIndex,
    tasks: &[Task],
    pg: &ProjectGraph,
    deps: &[Dependency],
    cals: &PassCalendars,
    floors: &[NaiveDate],
    instants: &[Option<Instant>],
) -> Result<(Instant, NaiveDate), String> {
    let cal = cals.for_node(idx.index());
    let mut best: Option<(NaiveDate, bool, NaiveDate)> = None;
    let mut offer = |candidate: (NaiveDate, bool, NaiveDate)| match best {
        Some(b) if (candidate.0, candidate.1) <= (b.0, b.1) => {}
        _ => best = Some(candidate),
    };
    for &floor in floors {
        offer((floor, true, floor));
    }
    for edge in pg.graph.edges_directed(idx, Direction::Incoming) {
        let dep = &deps[*edge.weight()];
        let p = edge.source().index();
        let pred = &tasks[p];
        let pred_instant = instants[p];
        let anchor = edge_anchor(
            dep.dep_type,
            pred.early_start.unwrap(),
            pred.early_finish.unwrap(),
            pred_instant.map(|i| i.0),
            cals.for_node(p),
        )?;
        let raw = checked_offset_days(anchor, dep.lag_days())?;
        if start_anchored(dep.dep_type) {
            let base_display = match pred_instant {
                // Same midnight as the predecessor milestone (#4079): its own
                // reading carries over verbatim.
                Some(i) if dep.lag_days() == 0 => i.1,
                // Ordinary work, or a milestone reached through a nonzero lag: a
                // different midnight than the predecessor's own instant, so its
                // reading is computed fresh. Inheriting it would leak a display
                // quirk of the predecessor's instant (the Sunday/Monday snap,
                // #4173) onto an instant it has nothing to do with (#4206).
                _ => dep.dep_type == DependencyType::SS,
            };
            let start_display = start_reading(raw, base_display, cal)?;
            offer((raw, start_display, instant_day(raw, start_display, cal)?));
        } else {
            let finish_day = next_working_day(raw, cal)?;
            offer((checked_offset_days(finish_day, 1)?, false, finish_day));
        }
    }
    let (x, start_display, day) = best.expect("floors always carry the project-start floor");
    Ok(((x, start_display), day))
}

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
/// never scheduled in the past. An in-progress task's `actual_start`, when
/// recorded, is an additional early-start floor (ADR-0132 §2, #2621): work
/// already underway stays where it actually started, even past the data date or
/// a predecessor's constraint. With no actuals and no status date the result is
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
/// Zero-duration tasks scheduled through the network are placed as instants
/// (#4079, `place_milestone`); the returned vector holds each one's [`Instant`] by
/// node index (`None` for ordinary work and for tasks pinned by actuals), which
/// the backward pass and float computation read to invert the same rule.
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
) -> Result<Vec<Option<Instant>>, String> {
    // Memoized per distinct calendar — see `start_floors_for`.
    let mut floors_by_cal: HashMap<*const Calendar, (NaiveDate, NaiveDate)> = HashMap::new();
    let mut instants: Vec<Option<Instant>> = vec![None; tasks.len()];

    for &idx in topo_order {
        let i = idx.index();
        // The node being computed is the successor of all its incoming edges, so a
        // single calendar — its own — governs both its duration and the snap of
        // every predecessor constraint (lag is consumed on the successor's
        // calendar). With no per-task calendars this is always the pass-level one.
        let node_cal = cals.for_node(i);
        let (start_base, start) =
            start_floors_for(&mut floors_by_cal, node_cal, project_start, status_date)?;
        // Only a network-placed milestone can sit at the end of its day (#4079);
        // reset first so an input carrying a previous run's value cannot leak.
        tasks[i].milestone_at_day_end = false;

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
        if !tasks[i].is_complete() {
            if let Some(actual_start) = tasks[i].actual_start {
                // ADR-0132 §2 / #2621: work already underway is floored at
                // where it actually started, not just at the data date or
                // predecessor constraints — actuals are truth and are never
                // smoothed back to an earlier network slot. Unsnapped, unlike
                // planned_start: a recorded actual can legitimately land on a
                // non-working day (e.g. logged over a weekend) and is not
                // renegotiated.
                es_constraints.push(actual_start);
            }
        }
        if let Some(ps) = tasks[i].planned_start {
            es_constraints.push(next_working_day(ps, node_cal)?);
        }
        if duration_days == 0 {
            let (instant, day) =
                place_milestone(idx, tasks, pg, deps, cals, &es_constraints, &instants)?;
            instants[i] = Some(instant);
            let task = &mut tasks[i];
            task.early_start = Some(day);
            task.early_finish = Some(day);
            // `start_display` false = shown at the end of `day` (follows work).
            task.milestone_at_day_end = !instant.1;
            task.scheduled_start = Some(compute_scheduled_start(task, node_cal)?);
            continue;
        }
        let (pred_es_constraints, ef_constraints) =
            edge_constraints(idx, tasks, pg, deps, cals, &instants)?;
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
    Ok(instants)
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
/// *finish*. Each bound is `next_working_day(anchor + lag)` on the successor's
/// calendar, with the anchor from `edge_anchor` — a milestone predecessor's
/// instant rather than a day it occupies (#4079). The predecessor's dates are
/// unwrapped unconditionally because topological order guarantees every
/// predecessor was scheduled on an earlier iteration of the pass.
fn edge_constraints(
    idx: NodeIndex,
    tasks: &[Task],
    pg: &ProjectGraph,
    deps: &[Dependency],
    cals: &PassCalendars,
    instants: &[Option<Instant>],
) -> Result<(Vec<NaiveDate>, Vec<NaiveDate>), String> {
    let calendar = cals.for_node(idx.index());
    let mut es_constraints: Vec<NaiveDate> = Vec::new();
    let mut ef_constraints: Vec<NaiveDate> = Vec::new();

    for edge in pg.graph.edges_directed(idx, Direction::Incoming) {
        let dep = &deps[*edge.weight()];
        let p = edge.source().index();
        let pred = &tasks[p];
        let anchor = edge_anchor(
            dep.dep_type,
            pred.early_start.unwrap(),
            pred.early_finish.unwrap(),
            instants[p].map(|i| i.0),
            cals.for_node(p),
        )?;
        let bound = advance_calendar_days(anchor, dep.lag_days(), calendar)?;
        if start_anchored(dep.dep_type) {
            es_constraints.push(bound);
        } else {
            ef_constraints.push(bound);
        }
    }
    Ok((es_constraints, ef_constraints))
}

#[cfg(test)]
mod tests {
    use chrono::NaiveDate;
    use serde_json::json;

    use crate::models::{Project, TaskResult};
    use crate::schedule_impl;

    /// Schedule a Mon-Fri project starting Mon 2026-01-05 from `(id, days)` tasks
    /// and `(pred, succ, type, lag_days)` links, returning one task's result.
    fn schedule_one(
        tasks: &[(&str, i64)],
        deps: &[(&str, &str, &str, i64)],
        id: &str,
    ) -> TaskResult {
        let project: Project = serde_json::from_value(json!({
            "id": "p",
            "name": "p",
            "start_date": "2026-01-05",
            "tasks": tasks.iter().map(|(t, d)| json!({
                "id": t, "name": t, "duration": (*d as f64) * 86400.0,
            })).collect::<Vec<_>>(),
            "dependencies": deps.iter().map(|(p, s, k, lag)| json!({
                "predecessor_id": p, "successor_id": s, "dep_type": k,
                "lag": (*lag as f64) * 86400.0,
            })).collect::<Vec<_>>(),
        }))
        .expect("test project parses");
        let result = schedule_impl(&project).expect("test project schedules");
        result
            .tasks
            .into_iter()
            .find(|t| t.id == id)
            .expect("task present")
    }

    fn d(day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 1, day).unwrap()
    }

    /// #4206 (Rust port of #4205): `M` sits on Sunday 2026-01-11 midnight, which
    /// the #4173 non-working snap reads as the start of Monday. `M2`'s FS+2d
    /// instant is Tue 2026-01-13 midnight, whose previous day is a working
    /// Monday — so nothing masks the inherited reading. Read fresh (FS), it is
    /// the end of Monday 2026-01-12; the inherited start-of-day reading showed it
    /// a working day later, on Tuesday.
    #[test]
    fn lagged_fs_out_of_a_snapped_milestone_reads_fresh() {
        let m2 = schedule_one(
            &[("T0", 5), ("M", 0), ("M2", 0)],
            &[("T0", "M", "FS", 1), ("M", "M2", "FS", 2)],
            "M2",
        );
        assert_eq!(m2.early_start, d(12));
        assert!(m2.milestone_at_day_end);
    }

    /// #4206: the SS direction. `N` follows one day of work at zero lag, so it
    /// reads as the end of Mon 2026-01-05. `N2`'s SS+1d instant is Wed 2026-01-07
    /// midnight and, read fresh (SS), is the start of Wednesday; inheriting `N`'s
    /// end-of-day reading showed it on Tuesday instead.
    #[test]
    fn lagged_ss_out_of_an_end_of_day_milestone_reads_fresh() {
        let n2 = schedule_one(
            &[("A", 1), ("N", 0), ("N2", 0)],
            &[("A", "N", "FS", 0), ("N", "N2", "SS", 1)],
            "N2",
        );
        assert_eq!(n2.early_start, d(7));
        assert!(!n2.milestone_at_day_end);
    }

    /// The zero-lag half of the rule is unchanged: `P` is the start of Tue
    /// 2026-01-06 (SS+1d from work), and `P2`, FS+0d from it, is the same
    /// midnight, so it keeps that reading rather than the fresh FS one (end of
    /// Monday).
    #[test]
    fn zero_lag_out_of_a_milestone_still_inherits_its_reading() {
        let p2 = schedule_one(
            &[("S", 3), ("P", 0), ("P2", 0)],
            &[("S", "P", "SS", 1), ("P", "P2", "FS", 0)],
            "P2",
        );
        assert_eq!(p2.early_start, d(6));
        assert!(!p2.milestone_at_day_end);
    }
}
