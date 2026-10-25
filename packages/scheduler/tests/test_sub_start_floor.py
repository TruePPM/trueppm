"""A floor at or before the project start moves nothing (#4635).

The engine places work at the latest of its lower bounds — project start, data date
(status date), SNET (``planned_start``), a recorded actual start, incoming links.
Taking a maximum is monotone, so a bound that sits at or below the project start can
never move work: the project-start floor already covers it. Two rules broke that in
combination:

* a milestone's *link* instant (what its successors measure their lag from) leaves
  the project-start floor out, which only bounds where it is shown (#4225); and
* the data date and SNET were handed to that instant verbatim, never raised to the
  project start.

So a free milestone ``K`` with a status date or SNET before the start measured its
outgoing lag from that earlier day, and ``K -FS(+10cd)-> A`` finished ``A`` up to
(start - status date) days *earlier* than with no status date at all. The API passes
``timezone.localdate()`` as the status date whenever none is set
(``resolve_cpm_status_date``), so this was every future-start project in production.

The rule these tests pin, in both engines (the package README): a data date that
snaps to a day at or before the project-start floor is no floor at all, for every
task, SF-linked ones included; an SNET there is no floor either, except on an
SF-linked task, which takes no project-start floor, so its SNET can only hold it
later and is kept verbatim (the Schedule's snap-to-start commits write exactly such
an SNET, see ``test_sf_from_work.py``). A recorded actual start is kept verbatim; it
is a fact, and a fact may precede the plan.
"""

from __future__ import annotations

import dataclasses
from datetime import date, timedelta

import pytest
from hypothesis import given
from hypothesis import strategies as st

from tests.test_contract_fuzz import _PLAUSIBLE_ANCHOR, _plausible_projects
from trueppm_scheduler import (
    Dependency,
    DependencyType,
    Project,
    SchedulerError,
    ScheduleResult,
    Task,
    monte_carlo,
    schedule,
)

_START = date(2026, 2, 2)  # Monday
_LINKS = list(DependencyType)


def _positions(result: ScheduleResult) -> dict[str, tuple[object, ...]]:
    """Every per-task date the forward and backward passes produce, plus the finish."""
    out: dict[str, tuple[object, ...]] = {
        t.id: (
            t.early_start,
            t.early_finish,
            t.late_start,
            t.late_finish,
            t.total_float,
            t.milestone_at_day_end,
        )
        for t in result.tasks
    }
    out["__finish__"] = (result.project_finish,)
    return out


def _free_milestone(
    dep_type: DependencyType,
    *,
    status_date: date | None = None,
    snet: date | None = None,
    sf_into_k: bool = False,
) -> Project:
    """``K`` (milestone, no predecessors) ``-X(+10cd)->`` ``A`` (5d).

    ``sf_into_k`` adds ``W(3d) -SF-> K`` so ``K`` is SF-linked (#4218): the project
    start does not floor it at all, and the SF link places it before the start.
    """
    tasks = [
        Task(id="K", name="K", duration=timedelta(0), planned_start=snet),
        Task(id="A", name="A", duration=timedelta(days=5)),
    ]
    deps = [
        Dependency(predecessor_id="K", successor_id="A", dep_type=dep_type, lag=timedelta(days=10))
    ]
    if sf_into_k:
        tasks.append(Task(id="W", name="W", duration=timedelta(days=3)))
        deps.append(Dependency(predecessor_id="W", successor_id="K", dep_type=DependencyType.SF))
    return Project(
        id="p",
        name="p",
        start_date=_START,
        tasks=tasks,
        dependencies=deps,
        status_date=status_date,
    )


_SUB_START_DATA_DATES = [
    {"status_date": date(2026, 1, 15)},
    {"status_date": _START},
    {"status_date": date(2026, 2, 1)},  # Sunday: snaps to the start itself
]
_SUB_START = [
    *_SUB_START_DATA_DATES,
    {"snet": date(2026, 1, 20)},
    {"snet": _START},
    {"status_date": date(2026, 1, 15), "snet": date(2026, 1, 20)},
]
_CASES = [
    *[pytest.param(f, False, id=f"free-{f!r}") for f in _SUB_START],
    # An SF-linked milestone keeps a sub-start SNET (see the test below), so only
    # the data date is clamped on it.
    *[pytest.param(f, True, id=f"sf-linked-{f!r}") for f in _SUB_START_DATA_DATES],
]


@pytest.mark.parametrize("dep_type", _LINKS, ids=lambda d: d.value)
@pytest.mark.parametrize(("floors", "sf_into_k"), _CASES)
def test_sub_start_floor_on_a_milestone_moves_nothing(
    dep_type: DependencyType, floors: dict[str, date], sf_into_k: bool
) -> None:
    """The issue's table: every link type, data date and SNET before/at the start.

    Before the fix ``A`` finished on 02-06 (FS/SS/FF) or 02-02 (SF) instead of 02-18 /
    02-11 with a free ``K``. The SF-linked rows pin the data-date half of the rule
    on an SF-linked milestone: it sits wherever its SF link puts it, and a sub-start
    data date does not pull it up toward the start.
    """
    baseline = schedule(_free_milestone(dep_type, sf_into_k=sf_into_k))
    floored = schedule(_free_milestone(dep_type, sf_into_k=sf_into_k, **floors))
    assert _positions(floored) == _positions(baseline)


@pytest.mark.parametrize(
    ("dep_type", "finish"),
    [
        (DependencyType.FS, date(2026, 2, 18)),
        (DependencyType.SS, date(2026, 2, 18)),
        (DependencyType.FF, date(2026, 2, 11)),
        (DependencyType.SF, date(2026, 2, 11)),
    ],
    ids=lambda v: getattr(v, "value", str(v)),
)
def test_future_start_project_keeps_the_full_lag(dep_type: DependencyType, finish: date) -> None:
    """Known answer: ``K`` on 02-02 + 10 calendar days, whatever the data date says.

    FS/SS from a start-of-day milestone anchor on 02-02 00:00; +10cd is 02-12, so
    the 5-day ``A`` runs 02-12..02-18. FF/SF constrain ``A``'s finish at 02-12 00:00,
    i.e. the end of 02-11.
    """
    result = schedule(_free_milestone(dep_type, status_date=date(2026, 1, 15)))
    assert result.project_finish == finish


def test_a_completed_milestone_with_a_pre_start_snet_links_from_the_start() -> None:
    """A completed milestone (100%, no actuals) is pinned on the later of the project
    start and its SNET, and links from that same instant.

    It used to link from a pre-start SNET verbatim, so ``C -FS(+10cd)-> A`` started
    ``A`` on 02-02 instead of 02-12 — the same #4635 defect on the pinned path.
    """

    def build(snet: date | None) -> Project:
        return Project(
            id="p",
            name="p",
            start_date=_START,
            tasks=[
                Task(
                    id="C",
                    name="C",
                    duration=timedelta(0),
                    planned_start=snet,
                    percent_complete=100.0,
                ),
                Task(id="A", name="A", duration=timedelta(days=5)),
            ],
            dependencies=[Dependency(predecessor_id="C", successor_id="A", lag=timedelta(days=10))],
        )

    floored = schedule(build(date(2026, 1, 20)))
    assert _positions(floored) == _positions(schedule(build(None)))
    assert {t.id: t for t in floored.tasks}["A"].early_start == date(2026, 2, 12)
    mc = monte_carlo(build(date(2026, 1, 20)), runs=8, seed=3)
    assert mc.p50 == mc.p95 == floored.project_finish


@pytest.mark.parametrize("dep_type", _LINKS, ids=lambda d: d.value)
def test_an_sf_linked_milestone_keeps_its_sub_start_snet(dep_type: DependencyType) -> None:
    """An SF-linked milestone's SNET on the start holds it there, verbatim (#4635).

    ``W -SF-> K`` places ``K`` before the start (it takes no project-start floor,
    #4218); an SNET on the start lifts it, and its successor, to 02-02 — later than
    without the SNET, never earlier. A sub-start SNET below the SF placement binds
    nothing, as any non-binding floor.
    """
    bare = {t.id: t for t in schedule(_free_milestone(dep_type, sf_into_k=True)).tasks}
    held_project = _free_milestone(dep_type, sf_into_k=True, snet=_START)
    held_result = schedule(held_project)
    held = {t.id: t for t in held_result.tasks}
    # Monte Carlo reads the same SNET (``_mc_milestone_floors``).
    mc = monte_carlo(held_project, runs=8, seed=3)
    assert mc.p50 == mc.p95 == held_result.project_finish
    assert bare["K"].early_start is not None and bare["K"].early_start < _START
    assert held["K"].early_start == _START
    assert held["A"].early_finish is not None and bare["A"].early_finish is not None
    assert held["A"].early_finish > bare["A"].early_finish
    below = schedule(_free_milestone(dep_type, sf_into_k=True, snet=date(2025, 12, 1)))
    assert _positions(below) == _positions(schedule(_free_milestone(dep_type, sf_into_k=True)))


def test_a_status_date_after_the_start_still_binds() -> None:
    """The clamp is "at or before", not "never": a later data date still floors K."""
    base = schedule(_free_milestone(DependencyType.FS))
    later = schedule(_free_milestone(DependencyType.FS, status_date=date(2026, 2, 4)))
    assert later.project_finish > base.project_finish


@pytest.mark.parametrize("status_date", [None, date(2026, 1, 5)], ids=["no-data-date", "sub-start"])
def test_a_pre_start_actual_start_is_kept_verbatim(status_date: date | None) -> None:
    """A recorded actual is a fact, and a fact may precede the plan: it is not clamped.

    ``T`` is SF-linked, so the project start does not floor it (#4218), and its SF
    lead puts its finish bound well before 01-12; the recorded 01-12 start is what
    binds its early start, before the 02-02 project start. A sub-start data date
    changes nothing about it.
    """
    project = Project(
        id="p",
        name="p",
        start_date=_START,
        status_date=status_date,
        tasks=[
            Task(id="W", name="W", duration=timedelta(days=3)),
            Task(
                id="T",
                name="T",
                duration=timedelta(days=5),
                actual_start=date(2026, 1, 12),
                percent_complete=40.0,
            ),
        ],
        dependencies=[
            Dependency(
                predecessor_id="W",
                successor_id="T",
                dep_type=DependencyType.SF,
                lag=timedelta(days=-28),
            )
        ],
    )
    by_id = {t.id: t for t in schedule(project).tasks}
    assert by_id["T"].early_start == date(2026, 1, 12)


# ---------------------------------------------------------------------------
# Metamorphic properties over the plausible-project space
# ---------------------------------------------------------------------------


@st.composite
def _with_free_milestone(draw: st.DrawFn) -> Project:
    """A plausible project with its status date cleared and a free lagged milestone planted.

    The uniform generator draws a zero-duration task 1 time in 41 and almost never
    one with no predecessor and a positive outgoing lag, which is the shape #4635
    lives in — so it is planted, over every link type, into a base task.
    """
    base = draw(_plausible_projects())
    k = Task(id="K", name="K", duration=timedelta(0))
    target = draw(st.sampled_from([t.id for t in base.tasks]))
    link = Dependency(
        predecessor_id="K",
        successor_id=target,
        dep_type=draw(st.sampled_from(_LINKS)),
        lag=timedelta(days=draw(st.integers(min_value=0, max_value=15))),
    )
    if draw(st.booleans()):
        # Make K SF-linked too: the data date is clamped on it as well.
        w = Task(id="W", name="W", duration=timedelta(days=draw(st.integers(1, 5))))
        into = Dependency(
            predecessor_id="W",
            successor_id="K",
            dep_type=DependencyType.SF,
            lag=timedelta(days=draw(st.integers(min_value=-3, max_value=3))),
        )
        extra_tasks, extra_deps = [w, k], [into, link]
    else:
        extra_tasks, extra_deps = [k], [link]
    return dataclasses.replace(
        base,
        status_date=None,
        tasks=[*extra_tasks, *base.tasks],
        dependencies=[*extra_deps, *base.dependencies],
    )


_sub_start_offset = st.integers(min_value=0, max_value=60)


@given(project=_with_free_milestone(), back=_sub_start_offset)
def test_a_status_date_at_or_before_the_start_moves_nothing(project: Project, back: int) -> None:
    """Adding ``status_date <= start_date`` changes no ES/EF/LS/LF and not the finish."""
    try:
        baseline = schedule(project)
    except SchedulerError:
        return
    floored = dataclasses.replace(project, status_date=_PLAUSIBLE_ANCHOR - timedelta(days=back))
    assert _positions(schedule(floored)) == _positions(baseline)


@given(project=_with_free_milestone(), back=_sub_start_offset, data=st.data())
def test_an_snet_at_or_before_the_start_moves_nothing(
    project: Project, back: int, data: st.DataObject
) -> None:
    """Replacing a task's absent SNET with one at or before the start moves nothing.

    Not on an SF-linked task, which keeps a sub-start SNET verbatim (it takes no
    project-start floor, so the SNET can hold it later).
    """
    sf_linked = {d.successor_id for d in project.dependencies if d.dep_type is DependencyType.SF}
    candidates = [t.id for t in project.tasks if t.planned_start is None and t.id not in sf_linked]
    if not candidates:
        return
    tid = data.draw(st.sampled_from(candidates))
    try:
        baseline = schedule(project)
    except SchedulerError:
        return
    snet = _PLAUSIBLE_ANCHOR - timedelta(days=back)
    pinned = dataclasses.replace(
        project,
        tasks=[
            dataclasses.replace(t, planned_start=snet) if t.id == tid else t for t in project.tasks
        ],
    )
    assert _positions(schedule(pinned)) == _positions(baseline)


@given(project=_with_free_milestone())
def test_null_status_date_matches_status_date_at_the_start(project: Project) -> None:
    """The API's interaction, in library terms: ``None`` and ``start_date`` agree.

    ``resolve_cpm_status_date`` turns a null status date into today, which on a
    future-start project is at or before the start. That must schedule exactly like
    a status date on the start itself, and like no status date at all.
    """
    try:
        baseline = schedule(project)
    except SchedulerError:
        return
    at_start = dataclasses.replace(project, status_date=project.start_date)
    assert _positions(schedule(at_start)) == _positions(baseline)


def _sf_work_project(**kw: object) -> Project:
    """``W(3d) -SF(-10cd)-> B(5d) -FS-> C(2d)``: B is SF-linked work placed before the start."""
    b = Task(id="B", name="B", duration=timedelta(days=5), **kw)  # type: ignore[arg-type]
    return Project(
        id="p",
        name="p",
        start_date=_START,
        tasks=[Task(id="W", name="W", duration=timedelta(days=3)), b],
        dependencies=[
            Dependency(
                predecessor_id="W",
                successor_id="B",
                dep_type=DependencyType.SF,
                lag=timedelta(days=-10),
            )
        ],
    )


@pytest.mark.parametrize(
    ("task_kw", "status_date"),
    [
        ({}, date(2026, 1, 26)),
        ({"planned_start": date(2026, 1, 27)}, None),
        # A Saturday actual start after the plan opens takes the verbatim-actual
        # path (``_mc_verbatim_actuals``), whose SF branch drops the same data date.
        # There the drop cannot change the outcome (an actual after the start always
        # beats a floor at or before it), so these two only pin that the path stays
        # consistent with the deterministic pass.
        ({"actual_start": date(2026, 2, 7), "percent_complete": 20.0}, date(2026, 1, 26)),
        (
            {"actual_start": date(2026, 2, 7), "percent_complete": 20.0},
            date(2026, 2, 2),
        ),
    ],
    ids=["data-date", "snet", "saturday-actual+data-date", "saturday-actual+data-date-on-start"],
)
def test_monte_carlo_treats_sub_start_floors_like_cpm(
    task_kw: dict[str, object], status_date: date | None
) -> None:
    """Zero-variance Monte Carlo agrees with ``schedule()`` on an SF-linked task (#4635).

    Both passes must drop a sub-start data date from an SF-linked task and keep its
    sub-start SNET, or the simulation samples from a window the deterministic pass
    does not use. B is placed before the start, so a lagged ``B -FS(+20cd)-> C``
    carries B's placement to the finish where a mismatch shows.
    """
    base = _sf_work_project(**task_kw)
    project = dataclasses.replace(
        base,
        status_date=status_date,
        tasks=[*base.tasks, Task(id="C", name="C", duration=timedelta(days=2))],
        dependencies=[
            *base.dependencies,
            Dependency(predecessor_id="B", successor_id="C", lag=timedelta(days=20)),
        ],
    )
    result = schedule(project)
    cpm = result.project_finish
    if "planned_start" in task_kw:
        # Kept verbatim: the 01-27 SNET holds B past its SF placement.
        assert {t.id: t for t in result.tasks}["B"].early_start == date(2026, 1, 27)
    else:
        assert cpm == schedule(dataclasses.replace(project, status_date=None)).project_finish
    mc = monte_carlo(project, runs=8, seed=3)
    assert mc.p50 == mc.p80 == mc.p95 == cpm
