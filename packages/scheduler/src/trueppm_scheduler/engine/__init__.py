"""CPM scheduling engine and Monte Carlo simulation for trueppm-scheduler.

Zero-duration milestones (#4079)
--------------------------------
The engine counts in whole working days with an inclusive ``early_finish``, which
has no way to say "an instant at the end of day D". A zero-duration task used to be
given a start *day* and then treated as a one-day task on both sides of every link,
so each milestone on a path delayed everything behind it by one working day. The
engine now follows the MS Project / Primavera P6 convention:

* A milestone is an **instant**: a midnight, where the end of one day is the start
  of the next. ``early_start == early_finish`` is the day it is *shown* on.
* A milestone driven by work sits at the **end of its driving predecessor's
  finish day**: ``A(5d, Mon..Fri) -FS-> M`` puts ``M`` on Friday, not Monday.
* A milestone held by a floor (project start, SNET, data date, recorded actual
  start) sits at the **start** of that day, and an FS successor starts that day.
* A milestone whose instant falls just after **non-working** time (the midnight
  opening Sunday or Monday after a weekend) — because of a lag, or because its
  predecessor's recorded finish is itself on a non-working day — is shown at the
  **start of the next working day**, the way MS Project snaps an elapsed lag onto
  working time, never at the end of the working day before it (#4173). Otherwise a
  later midnight could be shown on an earlier day than an earlier midnight, and a
  longer predecessor would show the milestone, and ``project_finish``, a day
  *earlier*. The shown day is monotone in the instant; it is not a function of
  working-time position alone (Saturday midnight is still the end of Friday).
* Links **into** a milestone propose a raw instant too: the link's anchor instant
  plus the lag, never snapped to a working day. A milestone's start and finish are
  one instant, so FF into it is the same link as FS (:func:`_milestone_link`) and
  ``A -FF+1d-> M`` lands ``M`` exactly where ``A -FS+1d-> M`` does (#4272).
* Links **out of** a milestone measure from the instant (FS/SS, and an FF or SF
  with a positive lag, #4273, #4333) or the last working day before it (an FF or
  SF with no lag or a lead, so a finish is monotone in its lag). The instant
  is never rounded to a working day, so calendar-day lags compose through it:
  ``A -FS(l1)-> M -FS(l2)-> B`` schedules exactly as ``A -FS(l1+l2)-> B`` unless
  ``l2`` is negative or a hard floor holds ``M``. The project-start floor does not
  break it: it only sets the day ``M`` is shown on, and links out of ``M`` measure
  from the instant below it (#4225). A negative ``l2`` can reach ``M``'s own
  project-finish bound, as it would for any node inserted into the link. The data
  date, an SNET and a recorded actual start do hold ``M`` and every lag measured
  from it, so ``B`` can land later than the direct link puts it — except one that
  falls on, or snaps to, the day the latest link already shows ``M`` at the start
  of: that is the same point in working time, and the lags keep counting from the
  link's own midnight (:func:`_equivalent_link`, #4690).
* The backward pass and free float invert the same rule (:func:`_milestone_latest`,
  :func:`_milestone_refs`), and every late date is seeded from the instant the
  project ends (:func:`_finish_instant`), so a milestone on the critical path
  carries zero float. When that instant already reads as start of day, a
  milestone may sit as late as the midnight opening the next working day
  (:func:`_milestone_finish_bound`, #4174): landing on Monday rather than Sunday
  midnight does not move the shown finish.

Start-to-Finish from ordinary work (#4145)
------------------------------------------
An SF link anchors on the last working day *before* its predecessor's start day,
not on the start day itself: MS Project and P6 finish the successor at the start of
that day, so with lag 0 the successor's last working day is the day before. That is
the same rule the milestone branch above applies to an instant, so an SF link from a
1-day task starting on day D and one from a zero-duration milestone standing at D's
opening midnight now schedule identically — before #4145 the two disagreed by one
working day, and the work branch scheduled one day later than the source plan an MS
Project import came from.

A *positive* SF lag counts from the start instant itself — from ``start - 1``, the
day it closes — not from that pre-snapped working day (#4333). Otherwise a
predecessor starting on Monday anchored on Friday, ``Friday + 2d`` landed on Sunday,
and the snap to Monday absorbed the lag: ``-SF+2d->`` finished the successor on
Monday, where MS Project finishes it on Tuesday.

An SF-linked task may start before the project start (#4218, #4220)
--------------------------------------------------------------------
A task's project-start floor is ``min(project start, SF placement)``, where the SF
placement is where its SF links alone put it. SF is the one link type that can
legitimately require a successor to run *before* its predecessor, and the ordinary
shape (a predecessor on the project's first working day, an SF successor finishing
the day before) is exactly what MS Project schedules — it moves the successor, and
the project's earliest date with it, ahead of the nominal start. Flooring that task
used to discard its SF bound silently: the bound can only pull a finish *later*, so
the task floated to the project start as if it were unlinked.

A task with no SF link has no SF placement and takes the project start. A task
with one is held at or after its SF placement by the SF link itself, so
``min(project start, SF placement)`` never binds it, and the engine leaves the
project-start floor out for every task with an SF link (:func:`_sf_linked`). What
places it is the latest of its links and its hard floors, so a binding FS/SS/FF
lead may put it before the project start too.

#4218 first lifted the floor only for a task whose links were *all* SF. That was
non-monotone (#4220): adding a non-binding FS/SS/FF link moved the task later, to
the project start, and so could a *shorter* SF lag or an upstream change that made
an SF bound earlier, because a non-SF link then became the binding one. With the
floor fixed by the task's link types, every placement is the latest of bounds that
are each monotone in their inputs: a shorter lag never finishes work later, and
adding a link never moves any task later unless that link binds. Adding an SF link
can move its successor *earlier*, because it lifts that task's project-start floor.

The **data date** still floors every task once it is after the project start. The
project start is a planning convention the network may overrule; the data date is a
fact about time — remaining work cannot be forecast to happen before "as of now" —
and an SF anchor in the past says the successor is already late, not that it
finished. An SNET or a recorded actual start still binds. Whether MS Project floors
a task with mixed SF and FS/SS/FF links, or a lead, the same way is **unverified**
(#4319). :func:`monte_carlo` widens its working-day index backwards to hold the same
placements (:func:`_mc_pre_start_pad_days`).

**A data date at or before the project start floors nothing, and neither does such
an SNET outside an SF-linked task (#4635).** Each is raised to the project-start
floor (:func:`_floor_above_start`), and where that floor does not bind — a
milestone's link instant (#4225), a completed milestone's link, and for the data
date an SF-linked task too — a floor raised to it is no floor at all. Leaving them
verbatim made a sub-start bound pull work *earlier* than no bound: a free milestone
measured its outgoing lags from the earlier day, and because the API passes today as
the data date when none is set, every future-start project lost up to (start -
today) days of every lag out of its kickoff milestones. Clamping the data date on an
SF-linked task is a decision, not a consequence: a sub-start data date could hold an
SF-linked task that its link places even earlier, and it no longer does, because
otherwise the data date the API passes by default would move work on every
future-start project. An SNET on an SF-linked task is kept verbatim: there it can
only hold the task later than its SF placement, never pull anything earlier, and the
UI's "snap to project start", "move project start" and "start at the earliest"
commits write exactly such an SNET (the API pulls the project start back to it,
#867); dropping it made each of those commits a no-op that ratcheted the project
start earlier. A recorded actual start is kept verbatim: a fact may precede the plan.

Completed tasks are pinned out of network logic (ADR-0136) and keep their recorded
dates. A pinned task with work is ordinary work to its successors; a pinned
zero-duration task stays a milestone, an instant. With no actuals it sits at the
start of its pinned day (#4343). With actuals it sits on its ``actual_finish`` (else
``actual_start``) day, at the edge of that day it had live (#4433): the end when
completed work finishing that day placed it, or — while a predecessor is still
open — when the caller's previous run showed it at the end of that day
(``Task.live_day_end_on``, #4525); the start otherwise: nothing precedes it, a
floor (data date, SNET) held it, or open work behind it was never recorded as
placing it. Only those fixed facts decide it, so no
change to open work moves a closed milestone. A caller that hands its output back
keeps the edge; whether the successors stay put depends on the link instant below.

At the start of its day, a closed milestone links from the midnight it linked from
live, not from the recorded day's (#4690). A live milestone's link instant can be a
midnight before the start of the day it is shown on — Sunday 00:00 shown on
Monday (#4173), or a point below the project start (#4225) — and with calendar-day
lag (#2534) a successor counts from it. The instant is re-read from the completed
predecessors (:func:`_closed_milestone_link`). While any predecessor is still
open the milestone links from the start of its recorded day, as before, so closing
it ahead of open work can still move a lagged successor (#4740). Recording an
``actual_start`` or a ``planned_start`` on the day a live milestone is shown, or a
data date falling on or snapping to it, moves nothing: a floor that only ties the
latest link in working time leaves the link instant where the link put it
(:func:`_equivalent_link`).
``monte_carlo``
carries each run's milestone instant as a date (:func:`_mc_milestone_bounds`), and
the Rust/WASM engine mirrors the rule (``packages/wasm-scheduler/src/forward.rs``).
"""

# ``engine`` was a single module until #4550 split it into this package. Every name
# that ``trueppm_scheduler.engine`` exposed then is re-exported here, private helpers
# included, so ``from trueppm_scheduler.engine import X`` keeps working through the
# 0.5 line and pickles that name ``trueppm_scheduler.engine.<Class>`` still load.
# ``tests/test_engine_package_surface.py`` holds the list and fails if one goes missing.
#
# A re-export makes a NAME resolve; it does not redirect the submodule that calls it.
# ``mock.patch("trueppm_scheduler.engine.X")`` therefore patches nothing the engine
# reads: patch ``X`` on every submodule that calls it (or, for a ``MAX_*`` cap, on the
# module that reads it). Each submodule's imports list what it reads.

from __future__ import annotations

# The standard-library and third-party names ``engine.py`` imported at module scope
# were importable from it too; they stay importable for the same reason.
import copy as copy
import math as math
import weakref as weakref
from bisect import bisect_left as bisect_left
from collections.abc import (
    Callable as Callable,
)
from collections.abc import (
    Iterable as Iterable,
)
from collections.abc import (
    Iterator as Iterator,
)
from collections.abc import (
    Mapping as Mapping,
)
from collections.abc import (
    Sequence as Sequence,
)
from dataclasses import (
    dataclass as dataclass,
)
from dataclasses import (
    field as field,
)
from dataclasses import (
    replace as replace,
)
from datetime import (
    date as date,
)
from datetime import (
    datetime as datetime,
)
from datetime import (
    timedelta as timedelta,
)
from typing import (
    Any as Any,
)
from typing import (
    NoReturn as NoReturn,
)
from typing import (
    overload as overload,
)

import networkx as nx  # noqa: F401
import numpy as np  # noqa: F401

from trueppm_scheduler.engine.backward import (
    _append_successor_constraint as _append_successor_constraint,
)
from trueppm_scheduler.engine.backward import (
    _apply_late_dates as _apply_late_dates,
)
from trueppm_scheduler.engine.backward import (
    _apply_milestone_late_date as _apply_milestone_late_date,
)
from trueppm_scheduler.engine.backward import (
    _backward_pass as _backward_pass,
)
from trueppm_scheduler.engine.backward import (
    _collect_backward_constraints as _collect_backward_constraints,
)
from trueppm_scheduler.engine.backward import (
    _compute_floats as _compute_floats,
)
from trueppm_scheduler.engine.backward import (
    _free_float_days as _free_float_days,
)
from trueppm_scheduler.engine.backward import (
    _late_refs as _late_refs,
)
from trueppm_scheduler.engine.backward import (
    _link_binds as _link_binds,
)
from trueppm_scheduler.engine.backward import (
    _link_slack as _link_slack,
)
from trueppm_scheduler.engine.backward import (
    _wd_span as _wd_span,
)
from trueppm_scheduler.engine.calendar_math import (
    _MAX_ORDINAL as _MAX_ORDINAL,
)
from trueppm_scheduler.engine.calendar_math import (
    _MIN_ORDINAL as _MIN_ORDINAL,
)
from trueppm_scheduler.engine.calendar_math import (
    _advance_calendar_days as _advance_calendar_days,
)
from trueppm_scheduler.engine.calendar_math import (
    _effective_duration_days as _effective_duration_days,
)
from trueppm_scheduler.engine.calendar_math import (
    _finish_from_start as _finish_from_start,
)
from trueppm_scheduler.engine.calendar_math import (
    _is_complete as _is_complete,
)
from trueppm_scheduler.engine.calendar_math import (
    _next_working_day as _next_working_day,
)
from trueppm_scheduler.engine.calendar_math import (
    _nth_working_day as _nth_working_day,
)
from trueppm_scheduler.engine.calendar_math import (
    _prev_working_day as _prev_working_day,
)
from trueppm_scheduler.engine.calendar_math import (
    _retreat_calendar_days as _retreat_calendar_days,
)
from trueppm_scheduler.engine.calendar_math import (
    _safe_fromordinal as _safe_fromordinal,
)
from trueppm_scheduler.engine.calendar_math import (
    _safe_offset as _safe_offset,
)
from trueppm_scheduler.engine.calendar_math import (
    _scan_for_working_day as _scan_for_working_day,
)
from trueppm_scheduler.engine.calendar_math import (
    _snap_to_working_day as _snap_to_working_day,
)
from trueppm_scheduler.engine.calendar_math import (
    _start_from_finish as _start_from_finish,
)
from trueppm_scheduler.engine.calendar_math import (
    _working_days_between as _working_days_between,
)
from trueppm_scheduler.engine.calendar_math import (
    _working_days_in_ordinals as _working_days_in_ordinals,
)
from trueppm_scheduler.engine.calendar_math import (
    _WorkingDayCounter as _WorkingDayCounter,
)
from trueppm_scheduler.engine.cpm import (
    _require_project as _require_project,
)
from trueppm_scheduler.engine.cpm import (
    schedule as schedule,
)
from trueppm_scheduler.engine.errors import (
    _CYCLE_MSG_ID_CHARS as _CYCLE_MSG_ID_CHARS,
)
from trueppm_scheduler.engine.errors import (
    _CYCLE_MSG_MAX_IDS as _CYCLE_MSG_MAX_IDS,
)
from trueppm_scheduler.engine.errors import (
    CyclicDependencyError as CyclicDependencyError,
)
from trueppm_scheduler.engine.errors import (
    InvalidScheduleInput as InvalidScheduleInput,
)
from trueppm_scheduler.engine.errors import (
    SchedulerError as SchedulerError,
)
from trueppm_scheduler.engine.errors import (
    SimulationCapExceeded as SimulationCapExceeded,
)
from trueppm_scheduler.engine.forward import (
    _calendar_floors as _calendar_floors,
)
from trueppm_scheduler.engine.forward import (
    _compute_scheduled_start as _compute_scheduled_start,
)
from trueppm_scheduler.engine.forward import (
    _early_start_floors as _early_start_floors,
)
from trueppm_scheduler.engine.forward import (
    _floor_above_start as _floor_above_start,
)
from trueppm_scheduler.engine.forward import (
    _forward_edge_constraints as _forward_edge_constraints,
)
from trueppm_scheduler.engine.forward import (
    _forward_pass as _forward_pass,
)
from trueppm_scheduler.engine.forward import (
    _live_milestone_edge as _live_milestone_edge,
)
from trueppm_scheduler.engine.forward import (
    _pinned_milestone_instant as _pinned_milestone_instant,
)
from trueppm_scheduler.engine.forward import (
    _pinned_placement as _pinned_placement,
)
from trueppm_scheduler.engine.forward import (
    _sf_linked as _sf_linked,
)
from trueppm_scheduler.engine.graph import (
    CycleCheck as CycleCheck,
)
from trueppm_scheduler.engine.graph import (
    _build_graph as _build_graph,
)
from trueppm_scheduler.engine.graph import (
    _canonical_cycle as _canonical_cycle,
)
from trueppm_scheduler.engine.graph import (
    _expand_edges_for_cycle_check as _expand_edges_for_cycle_check,
)
from trueppm_scheduler.engine.graph import (
    _node_key as _node_key,
)
from trueppm_scheduler.engine.graph import (
    _raise_cycle_error as _raise_cycle_error,
)
from trueppm_scheduler.engine.graph import (
    _resolve_task_calendars as _resolve_task_calendars,
)
from trueppm_scheduler.engine.graph import (
    _validate_children_map_shape as _validate_children_map_shape,
)
from trueppm_scheduler.engine.graph import (
    _validate_edge_list as _validate_edge_list,
)
from trueppm_scheduler.engine.graph import (
    find_cycle as find_cycle,
)
from trueppm_scheduler.engine.limits import (
    _MAX_VELOCITY_SPRINT_TOTAL as _MAX_VELOCITY_SPRINT_TOTAL,
)
from trueppm_scheduler.engine.limits import (
    MAX_CALENDAR_EXCEPTIONS as MAX_CALENDAR_EXCEPTIONS,
)
from trueppm_scheduler.engine.limits import (
    MAX_CALENDAR_SCAN_DAYS as MAX_CALENDAR_SCAN_DAYS,
)
from trueppm_scheduler.engine.limits import (
    MAX_DEPENDENCIES as MAX_DEPENDENCIES,
)
from trueppm_scheduler.engine.limits import (
    MAX_DURATION_DAYS as MAX_DURATION_DAYS,
)
from trueppm_scheduler.engine.limits import (
    MAX_EXPANDED_EDGES as MAX_EXPANDED_EDGES,
)
from trueppm_scheduler.engine.limits import (
    MAX_INDEX_CELLS as MAX_INDEX_CELLS,
)
from trueppm_scheduler.engine.limits import (
    MAX_LAG_DAYS as MAX_LAG_DAYS,
)
from trueppm_scheduler.engine.limits import (
    MAX_LAG_DELTA_CELLS as MAX_LAG_DELTA_CELLS,
)
from trueppm_scheduler.engine.limits import (
    MAX_PROJECT_SPAN_DAYS as MAX_PROJECT_SPAN_DAYS,
)
from trueppm_scheduler.engine.limits import (
    MAX_VELOCITY_SPRINTS as MAX_VELOCITY_SPRINTS,
)
from trueppm_scheduler.engine.limits import (
    MC_SENSITIVITY_CAP as MC_SENSITIVITY_CAP,
)
from trueppm_scheduler.engine.limits import (
    MC_SENSITIVITY_SUBSAMPLE as MC_SENSITIVITY_SUBSAMPLE,
)
from trueppm_scheduler.engine.milestones import (
    _FROM_PREDECESSOR_FINISH as _FROM_PREDECESSOR_FINISH,
)
from trueppm_scheduler.engine.milestones import (
    _ONE_DAY as _ONE_DAY,
)
from trueppm_scheduler.engine.milestones import (
    _START_ANCHORED as _START_ANCHORED,
)
from trueppm_scheduler.engine.milestones import (
    _closed_milestone_link as _closed_milestone_link,
)
from trueppm_scheduler.engine.milestones import (
    _edge_anchor as _edge_anchor,
)
from trueppm_scheduler.engine.milestones import (
    _elapsed_link_days as _elapsed_link_days,
)
from trueppm_scheduler.engine.milestones import (
    _equivalent_link as _equivalent_link,
)
from trueppm_scheduler.engine.milestones import (
    _finish_instant as _finish_instant,
)
from trueppm_scheduler.engine.milestones import (
    _float_late_instant as _float_late_instant,
)
from trueppm_scheduler.engine.milestones import (
    _free_start_ref as _free_start_ref,
)
from trueppm_scheduler.engine.milestones import (
    _Instant as _Instant,
)
from trueppm_scheduler.engine.milestones import (
    _instant_day as _instant_day,
)
from trueppm_scheduler.engine.milestones import (
    _late_display as _late_display,
)
from trueppm_scheduler.engine.milestones import (
    _link_finish_ref as _link_finish_ref,
)
from trueppm_scheduler.engine.milestones import (
    _link_start as _link_start,
)
from trueppm_scheduler.engine.milestones import (
    _link_start_ref as _link_start_ref,
)
from trueppm_scheduler.engine.milestones import (
    _milestone_finish_bound as _milestone_finish_bound,
)
from trueppm_scheduler.engine.milestones import (
    _milestone_free_instants as _milestone_free_instants,
)
from trueppm_scheduler.engine.milestones import (
    _milestone_latest as _milestone_latest,
)
from trueppm_scheduler.engine.milestones import (
    _milestone_link as _milestone_link,
)
from trueppm_scheduler.engine.milestones import (
    _milestone_proposal as _milestone_proposal,
)
from trueppm_scheduler.engine.milestones import (
    _milestone_refs as _milestone_refs,
)
from trueppm_scheduler.engine.milestones import (
    _place_milestone as _place_milestone,
)
from trueppm_scheduler.engine.milestones import (
    _sf_latest_start as _sf_latest_start,
)
from trueppm_scheduler.engine.milestones import (
    _start_fixed_link as _start_fixed_link,
)
from trueppm_scheduler.engine.milestones import (
    _start_is_recorded as _start_is_recorded,
)
from trueppm_scheduler.engine.milestones import (
    _start_read_cap as _start_read_cap,
)
from trueppm_scheduler.engine.milestones import (
    _start_reading as _start_reading,
)
from trueppm_scheduler.engine.milestones import (
    _window_start_bound as _window_start_bound,
)
from trueppm_scheduler.engine.montecarlo.forward import (
    _completed_dates as _completed_dates,
)
from trueppm_scheduler.engine.montecarlo.forward import (
    _completed_edge_constraints as _completed_edge_constraints,
)
from trueppm_scheduler.engine.montecarlo.forward import (
    _completed_offsets as _completed_offsets,
)
from trueppm_scheduler.engine.montecarlo.forward import (
    _FixedEdge as _FixedEdge,
)
from trueppm_scheduler.engine.montecarlo.forward import (
    _index_offset as _index_offset,
)
from trueppm_scheduler.engine.montecarlo.forward import (
    _InstantRuns as _InstantRuns,
)
from trueppm_scheduler.engine.montecarlo.forward import (
    _mc_edge_constraints as _mc_edge_constraints,
)
from trueppm_scheduler.engine.montecarlo.forward import (
    _mc_effective_duration as _mc_effective_duration,
)
from trueppm_scheduler.engine.montecarlo.forward import (
    _mc_es_floors as _mc_es_floors,
)
from trueppm_scheduler.engine.montecarlo.forward import (
    _mc_forward_pass as _mc_forward_pass,
)
from trueppm_scheduler.engine.montecarlo.forward import (
    _mc_instant_edge_bound as _mc_instant_edge_bound,
)
from trueppm_scheduler.engine.montecarlo.forward import (
    _mc_instant_proposal as _mc_instant_proposal,
)
from trueppm_scheduler.engine.montecarlo.forward import (
    _mc_milestone_bounds as _mc_milestone_bounds,
)
from trueppm_scheduler.engine.montecarlo.forward import (
    _mc_milestone_floors as _mc_milestone_floors,
)
from trueppm_scheduler.engine.montecarlo.forward import (
    _mc_progress_state as _mc_progress_state,
)
from trueppm_scheduler.engine.montecarlo.forward import (
    _mc_span_link as _mc_span_link,
)
from trueppm_scheduler.engine.montecarlo.forward import (
    _mc_verbatim_actuals as _mc_verbatim_actuals,
)
from trueppm_scheduler.engine.montecarlo.forward import (
    _mc_work_proposal as _mc_work_proposal,
)
from trueppm_scheduler.engine.montecarlo.forward import (
    _mc_zero_base_column as _mc_zero_base_column,
)
from trueppm_scheduler.engine.montecarlo.forward import (
    _McIndex as _McIndex,
)
from trueppm_scheduler.engine.montecarlo.forward import (
    _MilestoneReading as _MilestoneReading,
)
from trueppm_scheduler.engine.montecarlo.forward import (
    _snapped_offset as _snapped_offset,
)
from trueppm_scheduler.engine.montecarlo.forward import (
    _VerbatimActual as _VerbatimActual,
)
from trueppm_scheduler.engine.montecarlo.index import (
    _LAG_DELTA_OVERRUN as _LAG_DELTA_OVERRUN,
)
from trueppm_scheduler.engine.montecarlo.index import (
    _MC_DAY_EPS as _MC_DAY_EPS,
)
from trueppm_scheduler.engine.montecarlo.index import (
    _MC_PRE_START_PAD_BUFFER_DAYS as _MC_PRE_START_PAD_BUFFER_DAYS,
)
from trueppm_scheduler.engine.montecarlo.index import (
    _ZERO_BASE_ROUND_AWAY as _ZERO_BASE_ROUND_AWAY,
)
from trueppm_scheduler.engine.montecarlo.index import (
    _build_lag_delta as _build_lag_delta,
)
from trueppm_scheduler.engine.montecarlo.index import (
    _build_lag_delta_table as _build_lag_delta_table,
)
from trueppm_scheduler.engine.montecarlo.index import (
    _count_working_days as _count_working_days,
)
from trueppm_scheduler.engine.montecarlo.index import (
    _finish_day_key as _finish_day_key,
)
from trueppm_scheduler.engine.montecarlo.index import (
    _lag_term as _lag_term,
)
from trueppm_scheduler.engine.montecarlo.index import (
    _lagged_constraint as _lagged_constraint,
)
from trueppm_scheduler.engine.montecarlo.index import (
    _link_lower_bound as _link_lower_bound,
)
from trueppm_scheduler.engine.montecarlo.index import (
    _mc_horizon as _mc_horizon,
)
from trueppm_scheduler.engine.montecarlo.index import (
    _mc_index_size as _mc_index_size,
)
from trueppm_scheduler.engine.montecarlo.index import (
    _mc_pre_start_pad_days as _mc_pre_start_pad_days,
)
from trueppm_scheduler.engine.montecarlo.index import (
    _milestone_hard_floors as _milestone_hard_floors,
)
from trueppm_scheduler.engine.montecarlo.index import (
    _MilestoneFloors as _MilestoneFloors,
)
from trueppm_scheduler.engine.montecarlo.index import (
    _raise_mc_index_overrun as _raise_mc_index_overrun,
)
from trueppm_scheduler.engine.montecarlo.index import (
    _snapped_offsets as _snapped_offsets,
)
from trueppm_scheduler.engine.montecarlo.index import (
    _start_day_index as _start_day_index,
)
from trueppm_scheduler.engine.montecarlo.run import (
    _MC_REFERENCE_BLOCK_CELLS as _MC_REFERENCE_BLOCK_CELLS,
)
from trueppm_scheduler.engine.montecarlo.run import (
    _build_reference_index as _build_reference_index,
)
from trueppm_scheduler.engine.montecarlo.run import (
    _mc_percentiles as _mc_percentiles,
)
from trueppm_scheduler.engine.montecarlo.run import (
    _offset_to_date as _offset_to_date,
)
from trueppm_scheduler.engine.montecarlo.run import (
    _to_reference_columns_inplace as _to_reference_columns_inplace,
)
from trueppm_scheduler.engine.montecarlo.run import (
    _to_reference_offset as _to_reference_offset,
)
from trueppm_scheduler.engine.montecarlo.run import (
    monte_carlo as monte_carlo,
)
from trueppm_scheduler.engine.montecarlo.sampling import (
    _MAX_RUNS_ABSOLUTE as _MAX_RUNS_ABSOLUTE,
)
from trueppm_scheduler.engine.montecarlo.sampling import (
    _VELOCITY_CHUNK_CELLS as _VELOCITY_CHUNK_CELLS,
)
from trueppm_scheduler.engine.montecarlo.sampling import (
    _VELOCITY_REACH_RTOL as _VELOCITY_REACH_RTOL,
)
from trueppm_scheduler.engine.montecarlo.sampling import (
    _average_ranks as _average_ranks,
)
from trueppm_scheduler.engine.montecarlo.sampling import (
    _build_working_day_index as _build_working_day_index,
)
from trueppm_scheduler.engine.montecarlo.sampling import (
    _duration_sensitivity as _duration_sensitivity,
)
from trueppm_scheduler.engine.montecarlo.sampling import (
    _floor_sampled_at_duration as _floor_sampled_at_duration,
)
from trueppm_scheduler.engine.montecarlo.sampling import (
    _OffsetLookup as _OffsetLookup,
)
from trueppm_scheduler.engine.montecarlo.sampling import (
    _sample_duration_matrix as _sample_duration_matrix,
)
from trueppm_scheduler.engine.montecarlo.sampling import (
    _sample_pert as _sample_pert,
)
from trueppm_scheduler.engine.montecarlo.sampling import (
    _sample_velocity_durations as _sample_velocity_durations,
)
from trueppm_scheduler.engine.montecarlo.sampling import (
    _shift_duration as _shift_duration,
)
from trueppm_scheduler.engine.montecarlo.sampling import (
    _shift_remaining_work as _shift_remaining_work,
)
from trueppm_scheduler.engine.montecarlo.sampling import (
    _validate_monte_carlo_args as _validate_monte_carlo_args,
)
from trueppm_scheduler.engine.montecarlo.sampling import (
    _WorkingDayIndex as _WorkingDayIndex,
)
from trueppm_scheduler.engine.montecarlo.sampling import (
    perturb_task_duration as perturb_task_duration,
)
from trueppm_scheduler.engine.replay import (
    _milestone_instants as _milestone_instants,
)
from trueppm_scheduler.engine.replay import (
    _milestone_replay as _milestone_replay,
)
from trueppm_scheduler.engine.replay import (
    _MilestoneReplay as _MilestoneReplay,
)
from trueppm_scheduler.engine.replay import (
    _project_free_instants as _project_free_instants,
)
from trueppm_scheduler.engine.results import (
    _MILESTONE_REPLAY_ATTR as _MILESTONE_REPLAY_ATTR,
)
from trueppm_scheduler.engine.results import (
    DrivingEdge as DrivingEdge,
)
from trueppm_scheduler.engine.results import (
    MonteCarloResult as MonteCarloResult,
)
from trueppm_scheduler.engine.results import (
    Percentile as Percentile,
)
from trueppm_scheduler.engine.results import (
    ScheduleResult as ScheduleResult,
)
from trueppm_scheduler.engine.results import (
    TaskSensitivity as TaskSensitivity,
)
from trueppm_scheduler.engine.results import (
    _Date as _Date,
)
from trueppm_scheduler.engine.summary import (
    SummaryExpansion as SummaryExpansion,
)
from trueppm_scheduler.engine.summary import (
    _check_children_map as _check_children_map,
)
from trueppm_scheduler.engine.summary import (
    _check_expansion_bound as _check_expansion_bound,
)
from trueppm_scheduler.engine.summary import (
    _collect_leaves as _collect_leaves,
)
from trueppm_scheduler.engine.summary import (
    _cross_product_edges as _cross_product_edges,
)
from trueppm_scheduler.engine.summary import (
    _reject_overlapping_links as _reject_overlapping_links,
)
from trueppm_scheduler.engine.summary import (
    _reject_summary_start_links as _reject_summary_start_links,
)
from trueppm_scheduler.engine.summary import (
    _resolve_endpoint_leaves as _resolve_endpoint_leaves,
)
from trueppm_scheduler.engine.summary import (
    expand_summary_dependencies as expand_summary_dependencies,
)
from trueppm_scheduler.engine.validate import (
    _check_duration as _check_duration,
)
from trueppm_scheduler.engine.validate import (
    _check_whole_days as _check_whole_days,
)
from trueppm_scheduler.engine.validate import (
    _describe_link as _describe_link,
)
from trueppm_scheduler.engine.validate import (
    _is_finite_number as _is_finite_number,
)
from trueppm_scheduler.engine.validate import (
    _is_valid_duration as _is_valid_duration,
)
from trueppm_scheduler.engine.validate import (
    _longest_chain_days as _longest_chain_days,
)
from trueppm_scheduler.engine.validate import (
    _require_plain_date as _require_plain_date,
)
from trueppm_scheduler.engine.validate import (
    _task_span_totals as _task_span_totals,
)
from trueppm_scheduler.engine.validate import (
    _task_worst_case_days as _task_worst_case_days,
)
from trueppm_scheduler.engine.validate import (
    _unknown_calendar_id_message as _unknown_calendar_id_message,
)
from trueppm_scheduler.engine.validate import (
    _validate_agile_inputs as _validate_agile_inputs,
)
from trueppm_scheduler.engine.validate import (
    _validate_dependencies as _validate_dependencies,
)
from trueppm_scheduler.engine.validate import (
    _validate_project as _validate_project,
)
from trueppm_scheduler.engine.validate import (
    _validate_project_calendar as _validate_project_calendar,
)
from trueppm_scheduler.engine.validate import (
    _validate_project_shape as _validate_project_shape,
)
from trueppm_scheduler.engine.validate import (
    _validate_span_bounds as _validate_span_bounds,
)
from trueppm_scheduler.engine.validate import (
    _validate_task_actual_order as _validate_task_actual_order,
)
from trueppm_scheduler.engine.validate import (
    _validate_task_calendar_id as _validate_task_calendar_id,
)
from trueppm_scheduler.engine.validate import (
    _validate_task_calendars as _validate_task_calendars,
)
from trueppm_scheduler.engine.validate import (
    _validate_task_date_types as _validate_task_date_types,
)
from trueppm_scheduler.engine.validate import (
    _validate_task_durations as _validate_task_durations,
)
from trueppm_scheduler.engine.validate import (
    _validate_task_numerics as _validate_task_numerics,
)
from trueppm_scheduler.engine.validate import (
    _validate_task_span as _validate_task_span,
)
from trueppm_scheduler.engine.validate import (
    _validate_tasks as _validate_tasks,
)
from trueppm_scheduler.engine.validate import (
    _validate_unique_task_ids as _validate_unique_task_ids,
)
from trueppm_scheduler.engine.validate import (
    _velocity_mean as _velocity_mean,
)
from trueppm_scheduler.engine.validate import (
    _velocity_observations as _velocity_observations,
)
from trueppm_scheduler.engine.validate import (
    _velocity_worst_case_days as _velocity_worst_case_days,
)
from trueppm_scheduler.models import (
    Calendar as Calendar,
)
from trueppm_scheduler.models import (
    DateRange as DateRange,
)
from trueppm_scheduler.models import (
    DeliveryMode as DeliveryMode,
)
from trueppm_scheduler.models import (
    Dependency as Dependency,
)
from trueppm_scheduler.models import (
    DependencyType as DependencyType,
)
from trueppm_scheduler.models import (
    Project as Project,
)
from trueppm_scheduler.models import (
    Task as Task,
)
from trueppm_scheduler.models import (
    _is_finite_real as _is_finite_real,
)
from trueppm_scheduler.models import (
    _mask_days_between as _mask_days_between,
)
from trueppm_scheduler.models import (
    _short_repr as _short_repr,
)
from trueppm_scheduler.models import (
    _validate_calendar_fields as _validate_calendar_fields,
)
from trueppm_scheduler.models import (
    _validate_project_fields as _validate_project_fields,
)
