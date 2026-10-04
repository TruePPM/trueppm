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

/// Every milestone's two instants by node index, as `forward_pass` places them.
///
/// `shown` is where each milestone is shown (its `early_start`/`early_finish` day
/// and reading); `links` is the instant its successors measure from. They differ
/// only for a milestone held up by the project-start floor alone, which bounds
/// where a milestone is shown but not what it passes on (#4225). Mirrors the
/// Python `_forward_pass` return value and its `link_instants` map.
#[derive(Debug, Clone, Default)]
pub struct MilestoneInstants {
    /// Each milestone's shown position (`None` for ordinary work).
    pub shown: Vec<Option<Instant>>,
    /// Each milestone's link instant (`None` for ordinary work).
    pub links: Vec<Option<Instant>>,
}

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
/// instant, SF from the last working day before it. Mirrors the Python
/// `_edge_anchor` (#4079, #4145).
///
/// SF (#4145) is the finish-anchored instant rule applied to the predecessor's
/// start instant: MS Project and P6 finish an SF successor at the start of its
/// predecessor's start day, so its last working day is the day before — which is
/// also where a zero-duration milestone standing at that same midnight puts it.
///
/// FF out of a milestone (#4273) measures from the instant itself, the point FS
/// measures from: a lagged FF anchors on the day the instant closes, `x - 1`
/// (a non-working day when the instant opens a working day after a weekend), and
/// the lag then snaps forward like any lagged FF. With no lag there is no date to
/// snap, so the successor only has to reach the instant in working time — the
/// last working day before it. Anchoring a lagged FF there too let a weekend
/// absorb the lag. Links *into* a milestone go through [`milestone_proposal`].
pub(crate) fn edge_anchor(
    dep_type: DependencyType,
    start: NaiveDate,
    finish: NaiveDate,
    instant: Option<NaiveDate>,
    pred_cal: &Calendar,
    lag_days: i64,
) -> Result<NaiveDate, String> {
    match instant {
        None => match dep_type {
            DependencyType::FS => checked_offset_days(finish, 1),
            DependencyType::FF => Ok(finish),
            DependencyType::SS => Ok(start),
            DependencyType::SF => prev_working_day(checked_offset_days(start, -1)?, pred_cal),
        },
        Some(x) if start_anchored(dep_type) => Ok(x),
        Some(x) if dep_type == DependencyType::FF && lag_days != 0 => checked_offset_days(x, -1),
        Some(x) => prev_working_day(checked_offset_days(x, -1)?, pred_cal),
    }
}

/// The type a link has as a zero-duration successor sees it: FF is FS (#4272,
/// #4273). A milestone's start and finish are one instant, and FF and FS anchor
/// on the same point of the predecessor, so into a milestone they are one link
/// and every pass treats them as one. Mirrors the Python `_milestone_link`.
pub(crate) fn milestone_link(dep_type: DependencyType) -> DependencyType {
    if dep_type == DependencyType::FF {
        DependencyType::FS
    } else {
        dep_type
    }
}

/// The `(instant, start_display)` one incoming link proposes to a milestone.
///
/// The link's anchor *instant* plus the lag, never snapped: a milestone occupies
/// no working day, so there is nothing for a lag to land on but the instant
/// (#4272). FS/SS — and FF, which into a milestone is FS ([`milestone_link`]) —
/// propose `anchor + lag`; SF proposes the midnight closing its anchor day plus
/// the lag. Before #4272 an FF/SF link proposed the end of the first working day
/// on or after `anchor + lag`, so a lag across a weekend put the milestone a
/// working day after its FS equivalent. The reading is the FS/SS-from-work one,
/// except at zero lag out of a milestone, where the proposal is the very
/// midnight the predecessor occupies and carries its reading over (#4079); an
/// instant just after non-working time reads as start of day ([`start_reading`],
/// #4173). `cal` is the milestone's own calendar. Mirrors the Python
/// `_milestone_proposal`.
pub(crate) fn milestone_proposal(
    dep_type: DependencyType,
    lag_days: i64,
    (start, finish): (NaiveDate, NaiveDate),
    pred_instant: Option<Instant>,
    pred_cal: &Calendar,
    cal: &Calendar,
) -> Result<Instant, String> {
    let dep_type = milestone_link(dep_type);
    let anchor = edge_anchor(
        dep_type,
        start,
        finish,
        pred_instant.map(|i| i.0),
        pred_cal,
        0,
    )?;
    if dep_type == DependencyType::SF {
        // The close of the anchor day, which is the working day before the start.
        let raw = checked_offset_days(anchor, 1 + lag_days)?;
        return Ok((raw, start_reading(raw, false, cal)?));
    }
    let raw = checked_offset_days(anchor, lag_days)?;
    let base_display = match pred_instant {
        // Same midnight as the predecessor milestone (#4079): its own reading
        // carries over verbatim.
        Some(i) if lag_days == 0 => i.1,
        // Ordinary work, or a milestone reached through a nonzero lag: a
        // different midnight than the predecessor's own instant, so its reading
        // is computed fresh. Inheriting it would leak a display quirk of the
        // predecessor's instant (the Sunday/Monday snap, #4173) onto an instant
        // it has nothing to do with (#4206).
        _ => dep_type == DependencyType::SS,
    };
    Ok((raw, start_reading(raw, base_display, cal)?))
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

/// Place a zero-duration task as an instant: `(shown, day, link)`.
///
/// `shown` is the `(instant, start_display)` the milestone is shown at on `day`;
/// `link` is the instant its own successors measure from, read off `links` for
/// each predecessor milestone in turn.
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
/// ([`start_reading`], #4173); FF links propose what FS would and SF links the
/// midnight closing their anchor day plus the lag, raw instants never snapped
/// ([`milestone_proposal`], #4272). Mirrors the Python `_place_milestone` (#4079).
///
/// The project-start floor (`start_floor`) only bounds where the milestone is
/// *shown* (#4225); `floors` holds the others (data date, SNET, a recorded actual
/// start), which bind `link` too. Every successor carries the project-start floor
/// itself, so a milestone held at it by that floor alone has nothing to add
/// downstream — measuring a successor's lag from the floored instant made
/// `A -FS-> M -FS(2cd)-> B` put `B` a working day after `A -FS(2cd)-> B` whenever
/// `A` sits before the project start (an SF-only task, #4218, or a negative lag).
/// `link` is the latest proposal without the project-start floor and `shown` the
/// latest with it; with nothing but that floor proposing, they are the same.
#[allow(clippy::too_many_arguments)]
fn place_milestone(
    idx: NodeIndex,
    tasks: &[Task],
    pg: &ProjectGraph,
    deps: &[Dependency],
    cals: &PassCalendars,
    floors: &[NaiveDate],
    start_floor: Option<NaiveDate>,
    links: &[Option<Instant>],
) -> Result<(Instant, NaiveDate, Instant), String> {
    let cal = cals.for_node(idx.index());
    type Proposal = (NaiveDate, bool, NaiveDate);
    fn offer(best: &mut Option<Proposal>, candidate: Proposal) {
        match *best {
            Some(b) if (candidate.0, candidate.1) <= (b.0, b.1) => {}
            _ => *best = Some(candidate),
        }
    }
    let mut best: Option<Proposal> = None;
    for &floor in floors {
        offer(&mut best, (floor, true, floor));
    }
    for edge in pg.graph.edges_directed(idx, Direction::Incoming) {
        let dep = &deps[*edge.weight()];
        let p = edge.source().index();
        let pred = &tasks[p];
        let (raw, start_display) = milestone_proposal(
            dep.dep_type,
            dep.lag_days(),
            (pred.early_start.unwrap(), pred.early_finish.unwrap()),
            links[p],
            cals.for_node(p),
            cal,
        )?;
        offer(
            &mut best,
            (raw, start_display, instant_day(raw, start_display, cal)?),
        );
    }
    let link = best;
    if let Some(floor) = start_floor {
        offer(&mut best, (floor, true, floor));
    }
    // Every node carries a floor or an incoming link: only an SF-only node goes
    // without the project-start floor (#4218), and it has at least one SF link.
    let (x, start_display, day) = best.expect("a floor or an incoming link proposes an instant");
    let shown = (x, start_display);
    Ok((shown, day, link.map_or(shown, |l| (l.0, l.1))))
}

/// The per-calendar start floors `(un-floored, floored, data date)`.
type StartFloors = (NaiveDate, NaiveDate, Option<NaiveDate>);

/// The (un-floored, floored, data-date) start floors for one calendar, memoized.
///
/// The project-start floor and the data-date floor snap to the task's *own*
/// calendar — a task can never begin on a day it cannot work. Under one project
/// calendar every task resolves the same triple, so the result is byte-identical
/// to the pre-ADR-0120 hoist. With per-task calendars the triple is memoized by
/// calendar address (mirroring the Python pass's `id(cal)` memo, #1824) so the
/// snap runs once per calendar rather than once per task — a sparse calendar's
/// snap walk is not free. The third element is the data-date floor on its own
/// (`None` without a status date): what an SF-only task, which the project start
/// does not floor, is held at (#4218). Mirrors the Python `_calendar_floors`.
fn start_floors_for(
    memo: &mut HashMap<*const Calendar, StartFloors>,
    node_cal: &Calendar,
    project_start: NaiveDate,
    status_date: Option<NaiveDate>,
) -> Result<StartFloors, String> {
    match memo.entry(node_cal as *const Calendar) {
        Entry::Occupied(e) => Ok(*e.get()),
        Entry::Vacant(e) => {
            let base = next_working_day(project_start, node_cal)?;
            let data_floor = match status_date {
                Some(sd) => Some(next_working_day(sd, node_cal)?),
                None => None,
            };
            // A status date at or before project start is already covered by the
            // project-start floor, hence the max().
            let floored = data_floor.map_or(base, |df| base.max(df));
            Ok(*e.insert((base, floored, data_floor)))
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
/// (#4079, `place_milestone`); the returned [`MilestoneInstants`] holds each
/// one's shown and link [`Instant`] by node index (`None` for ordinary work and
/// for tasks pinned by actuals), which the backward pass and float computation
/// read to invert the same rule.
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
) -> Result<MilestoneInstants, String> {
    // Memoized per distinct calendar — see `start_floors_for`.
    let mut floors_by_cal: HashMap<*const Calendar, StartFloors> = HashMap::new();
    let mut instants: Vec<Option<Instant>> = vec![None; tasks.len()];
    let mut links: Vec<Option<Instant>> = vec![None; tasks.len()];

    for &idx in topo_order {
        let i = idx.index();
        // The node being computed is the successor of all its incoming edges, so a
        // single calendar — its own — governs both its duration and the snap of
        // every predecessor constraint (lag is consumed on the successor's
        // calendar). With no per-task calendars this is always the pass-level one.
        let node_cal = cals.for_node(i);
        let (start_base, start, data_floor) =
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

        // An SF-only task is placed by its SF links alone and is not floored at the
        // project start — only at the data date (#4218). The project start is a
        // planning convention an SF link may overrule (MS Project schedules such a
        // successor ahead of it); the data date is a fact about time, and remaining
        // work cannot be forecast into the past. A complete-without-actuals task
        // was never floored at the data date, so it keeps no floor at all. Mirrors
        // the Python `_early_start_floors`.
        let is_sf_only = sf_only(idx, pg, deps);
        let mut es_constraints: Vec<NaiveDate> = if !is_sf_only {
            vec![base_es]
        } else if tasks[i].is_complete() {
            Vec::new()
        } else {
            data_floor.into_iter().collect()
        };
        // Every floor but the project start's — the list an SF-only task gets —
        // binds a milestone's link instant; the project start only bounds where
        // it is shown (#4225, see `place_milestone`).
        let mut hard_floors: Vec<NaiveDate> = if tasks[i].is_complete() {
            Vec::new()
        } else {
            data_floor.into_iter().collect()
        };
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
                hard_floors.push(actual_start);
            }
        }
        if let Some(ps) = tasks[i].planned_start {
            let snet = next_working_day(ps, node_cal)?;
            es_constraints.push(snet);
            hard_floors.push(snet);
        }
        if duration_days == 0 {
            let start_floor = (!is_sf_only).then_some(start_base);
            let (instant, day, link) = place_milestone(
                idx,
                tasks,
                pg,
                deps,
                cals,
                &hard_floors,
                start_floor,
                &links,
            )?;
            instants[i] = Some(instant);
            links[i] = Some(link);
            let task = &mut tasks[i];
            task.early_start = Some(day);
            task.early_finish = Some(day);
            // `start_display` false = shown at the end of `day` (follows work).
            task.milestone_at_day_end = !instant.1;
            task.scheduled_start = Some(compute_scheduled_start(task, node_cal)?);
            continue;
        }
        let (pred_es_constraints, ef_constraints) =
            edge_constraints(idx, tasks, pg, deps, cals, &links)?;
        es_constraints.extend(pred_es_constraints);

        if es_constraints.is_empty() {
            // An SF-only task with no data date, SNET or actual start (#4218): its
            // SF links alone place it, and nothing floors the start they
            // back-solve. `sf_only` guarantees `ef_constraints` is non-empty here.
            let min_ef = *ef_constraints
                .iter()
                .max()
                .expect("an SF-only task has an SF constraint");
            let es = start_from_finish(min_ef, duration_days, node_cal)?;
            let ef = finish_from_start(es, duration_days, node_cal)?.max(min_ef);
            let task = &mut tasks[i];
            task.early_start = Some(es);
            task.early_finish = Some(ef);
            task.scheduled_start = Some(compute_scheduled_start(task, node_cal)?);
            continue;
        }

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
    Ok(MilestoneInstants {
        shown: instants,
        links,
    })
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

/// Whether `idx` has incoming links and every one of them is SF (#4218).
///
/// Such a task is placed by its SF links alone and is not floored at the project
/// start. Mirrors the Python `_sf_only`.
pub(crate) fn sf_only(idx: NodeIndex, pg: &ProjectGraph, deps: &[Dependency]) -> bool {
    let mut incoming = pg.graph.edges_directed(idx, Direction::Incoming).peekable();
    incoming.peek().is_some()
        && incoming.all(|edge| deps[*edge.weight()].dep_type == DependencyType::SF)
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
            dep.lag_days(),
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

    /// #4218: a task whose only link is SF is placed by it even before the project
    /// start. `A` opens the project on Mon 2026-01-05, so `B`'s SF anchor is the
    /// Friday before (2026-01-02); the project-start floor used to hold `B` on
    /// Monday and silently discard the link.
    #[test]
    fn sf_only_task_is_placed_before_the_project_start() {
        let b = schedule_one(&[("A", 3), ("B", 1)], &[("A", "B", "SF", 0)], "B");
        assert_eq!(b.early_start, NaiveDate::from_ymd_opt(2026, 1, 2).unwrap());
        assert_eq!(b.early_finish, NaiveDate::from_ymd_opt(2026, 1, 2).unwrap());
    }

    /// #4218: any non-SF link keeps the project-start floor. `C` has the same SF
    /// link as above plus an FS lead from `X` that would also land before the
    /// project start on its own; both are floored at Monday 2026-01-05.
    #[test]
    fn a_non_sf_link_keeps_the_project_start_floor() {
        let c = schedule_one(
            &[("A", 3), ("X", 3), ("C", 1)],
            &[("A", "C", "SF", 0), ("X", "C", "FS", -10)],
            "C",
        );
        assert_eq!(c.early_start, d(5));
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

    /// #4225: the project-start floor only places a milestone where it is shown.
    /// `T1 -SF(-2cd)-> T2` puts SF-only `T2` on Wed 2025-12-31, so `T2 -FS(2cd)->
    /// T3` measures from midnight 2026-01-01 and is floored at Mon 2026-01-05.
    /// Splitting that link with `M` must land `T3` on the same day — `M` is shown
    /// on Monday, but `T3`'s lag counts from `M`'s pre-floor instant. Measuring it
    /// from the floored instant put `T3` on Tuesday. This asserts the correct
    /// outcome, not just agreement with the Python engine.
    #[test]
    fn a_milestone_floored_at_project_start_passes_its_raw_instant_on() {
        let tasks = [
            ("T0", 0),
            ("T1", 0),
            ("T2", 0),
            ("T3", 0),
            ("T4", 0),
            ("T5", 2),
        ];
        let sf = ("T1", "T2", "SF", -2);
        let direct = schedule_one(&tasks, &[sf, ("T2", "T3", "FS", 2)], "T3");
        let mut with_m = tasks.to_vec();
        with_m.push(("M", 0));
        let deps = [sf, ("T2", "M", "FS", 0), ("M", "T3", "FS", 2)];
        let via_m = schedule_one(&with_m, &deps, "T3");
        let m = schedule_one(&with_m, &deps, "M");
        assert_eq!(direct.early_start, d(5));
        assert_eq!(via_m.early_start, direct.early_start);
        assert_eq!(via_m.late_start, direct.late_start);
        assert_eq!(via_m.total_float, direct.total_float);
        // M is still never shown before the project start, nor late before early.
        assert_eq!((m.early_start, m.late_start), (d(5), d(5)));
    }

    /// Every task's result, as JSON so two schedules compare field by field.
    fn schedule_all(tasks: &[(&str, i64)], deps: &[(&str, &str, &str, i64)]) -> serde_json::Value {
        let ids: Vec<&str> = tasks.iter().map(|(t, _)| *t).collect();
        serde_json::to_value(
            ids.iter()
                .map(|id| schedule_one(tasks, deps, id))
                .collect::<Vec<_>>(),
        )
        .expect("results serialize")
    }

    /// #4272: a lagged FF link into a milestone proposes a raw instant. `A` finishes
    /// Fri 2026-01-09 (Saturday midnight); +1 day is Sunday midnight, the start of
    /// Monday 01-12, so `C` starts Monday — as with FS+1d. Snapping the lagged date
    /// forward as if `M` had a finish day started `C` on Tuesday.
    #[test]
    fn lagged_ff_into_a_milestone_lands_where_fs_does() {
        let tasks = [("A", 5), ("M", 0), ("C", 1)];
        let c = schedule_one(&tasks, &[("A", "M", "FF", 1), ("M", "C", "FS", 0)], "C");
        assert_eq!(c.early_start, d(12));
        assert_eq!(c.total_float, 0.0);
        for lag in -4..8 {
            assert_eq!(
                schedule_all(&tasks, &[("A", "M", "FF", lag), ("M", "C", "FS", 0)]),
                schedule_all(&tasks, &[("A", "M", "FS", lag), ("M", "C", "FS", 0)]),
                "lag {lag}"
            );
        }
    }

    /// #4272: SF into a milestone is its anchor instant — the close of the working
    /// day before the predecessor starts — plus the lag. `S` starts Mon 01-12, so
    /// it anchors where `A(5d)` finishes, and schedules `M` as `A -FS(l)-> M` does.
    #[test]
    fn lagged_sf_into_a_milestone_is_its_anchor_instant_plus_the_lag() {
        let tasks = [("A", 5), ("S", 2), ("M", 0), ("C", 1)];
        for lag in -4..8 {
            let sf = [
                ("A", "S", "FS", 0),
                ("S", "M", "SF", lag),
                ("M", "C", "FS", 0),
            ];
            let fs = [
                ("A", "S", "FS", 0),
                ("A", "M", "FS", lag),
                ("M", "C", "FS", 0),
            ];
            for id in ["M", "C"] {
                let (a, b) = (schedule_one(&tasks, &sf, id), schedule_one(&tasks, &fs, id));
                assert_eq!(a.early_start, b.early_start, "{id} lag {lag}");
                assert_eq!(
                    a.milestone_at_day_end, b.milestone_at_day_end,
                    "{id} lag {lag}"
                );
            }
        }
    }

    /// #4273: an FF link out of a milestone anchors on its own instant. `M0` sits at
    /// the start of Mon 01-05; `M0 -FF-> M1` must put `M1` there too, so the +1d
    /// lag after it starts `T` on Tuesday. Anchoring on the close of Friday let the
    /// weekend absorb the lag and started `T` on Monday.
    #[test]
    fn ff_out_of_a_start_of_day_milestone_anchors_on_its_instant() {
        let tasks = [("M0", 0), ("M1", 0), ("T", 1)];
        let t = schedule_one(&tasks, &[("M0", "M1", "FF", 0), ("M1", "T", "FS", 1)], "T");
        assert_eq!(t.early_start, d(6));
        for lag in -4..8 {
            assert_eq!(
                schedule_all(&tasks, &[("M0", "M1", "FF", lag), ("M1", "T", "FS", 1)]),
                schedule_all(&tasks, &[("M0", "M1", "FS", lag), ("M1", "T", "FS", 1)]),
                "lag {lag}"
            );
        }
    }

    /// #4273, into work: a lagged FF counts from the day `M0`'s instant closes.
    /// Monday midnight +2 closes Tuesday, so `W` finishes Tuesday; from the close
    /// of Friday, +2 was Sunday, snapped to Monday.
    #[test]
    fn a_lagged_ff_out_of_a_milestone_into_work_counts_from_the_instant() {
        let tasks = [("M0", 0), ("W", 1)];
        for (lag, finish) in [(0, 5), (1, 5), (2, 6), (3, 7)] {
            let w = schedule_one(&tasks, &[("M0", "W", "FF", lag)], "W");
            assert_eq!(w.early_finish, d(finish), "lag {lag}");
        }
    }

    /// #4225: a data-date floor is not a display bound — an unreached milestone
    /// happens no earlier than "as of now", so a lag after it counts from there.
    #[test]
    fn a_data_date_floored_milestone_still_moves_its_successor() {
        let project: Project = serde_json::from_value(json!({
            "id": "p",
            "name": "p",
            "start_date": "2026-01-05",
            "status_date": "2026-01-12",
            "tasks": [
                {"id": "A", "name": "A", "duration": 86400.0,
                 "actual_start": "2026-01-05", "actual_finish": "2026-01-05"},
                {"id": "M", "name": "M", "duration": 0.0},
                {"id": "B", "name": "B", "duration": 86400.0},
            ],
            "dependencies": [
                {"predecessor_id": "A", "successor_id": "M", "dep_type": "FS", "lag": 0.0},
                {"predecessor_id": "M", "successor_id": "B", "dep_type": "FS", "lag": 172800.0},
            ],
        }))
        .expect("test project parses");
        let result = schedule_impl(&project).expect("test project schedules");
        let b = result.tasks.iter().find(|t| t.id == "B").unwrap();
        assert_eq!(b.early_start, d(14));
    }
}
