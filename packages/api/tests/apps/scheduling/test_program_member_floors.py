"""The program pass floors each member at its own start and data date (#5178).

Once a program holds one accepted cross-project link, the merged program pass is
the persisted writer for every member project. It runs one engine project whose
``start_date`` is the earliest member's and whose ``status_date`` is ``None``, so
before #5178 a later-starting member's work was placed at another member's start,
unstarted work could sit before the data date, and accepting one link moved tasks
that link does not drive. These tests pin the per-member floors against the
single-project pass, which is the reference for what a member's dates mean.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from django.utils import timezone

from trueppm_api.apps.projects.models import Calendar, Dependency, Program, Project, Task
from trueppm_api.apps.projects.program_schedule import gather_program_schedule
from trueppm_api.apps.scheduling.tasks import _run_program_schedule, _run_schedule

A_START = date(2026, 3, 2)  # Monday
A_DATA_DATE = date(2026, 3, 16)  # Monday, after A's start: floors A's open work
B_START = date(2026, 4, 6)  # Monday, five weeks after A
B_DATA_DATE = date(2026, 3, 20)  # before B's start: floors nothing in B


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


def _fixture(calendar: Calendar) -> dict[str, Any]:
    """A program of three members whose starts and data dates all differ.

    No cross-project link: each member's single-project pass is then the exact
    reference for its dates in the program pass.
    """
    program = Program.objects.create(name="GA Launch")
    a = Project.objects.create(
        name="Security",
        start_date=A_START,
        status_date=A_DATA_DATE,
        calendar=calendar,
        program=program,
    )
    b = Project.objects.create(
        name="Marketing",
        start_date=B_START,
        status_date=B_DATA_DATE,
        calendar=calendar,
        program=program,
    )
    # No status_date: the data date resolves to today, as in the single pass.
    c = Project.objects.create(
        name="Support", start_date=date(2026, 1, 5), calendar=calendar, program=program
    )
    t: dict[str, Any] = {"program": program, "a": a, "b": b, "c": c}

    t["a_open"] = Task.objects.create(project=a, name="A open", duration=4)
    t["a_next"] = Task.objects.create(project=a, name="A next", duration=3)
    Dependency.objects.create(predecessor=t["a_open"], successor=t["a_next"], dep_type="FS", lag=0)
    t["a_running"] = Task.objects.create(
        project=a,
        name="A running",
        duration=10,
        percent_complete=50,
        actual_start=date(2026, 3, 4),
    )
    t["a_done"] = Task.objects.create(
        project=a,
        name="A done",
        duration=3,
        percent_complete=100,
        actual_start=date(2026, 3, 2),
        actual_finish=date(2026, 3, 4),
    )

    t["b_open"] = Task.objects.create(project=b, name="B open", duration=5)
    t["b_snet"] = Task.objects.create(
        # An SNET between A's start and B's start: B's own start binds.
        project=b,
        name="B snet",
        duration=2,
        planned_start=date(2026, 3, 23),
    )
    t["b_late_snet"] = Task.objects.create(
        project=b, name="B late snet", duration=2, planned_start=date(2026, 4, 15)
    )
    t["b_gate"] = Task.objects.create(project=b, name="B gate", duration=0, is_milestone=True)
    t["b_after_gate"] = Task.objects.create(project=b, name="B after gate", duration=2)
    Dependency.objects.create(predecessor=t["b_gate"], successor=t["b_after_gate"], dep_type="FS")
    # SF-linked: the single pass places it before B's start (#4218).
    t["b_sf"] = Task.objects.create(project=b, name="B sf", duration=3)
    Dependency.objects.create(predecessor=t["b_open"], successor=t["b_sf"], dep_type="SF", lag=0)

    t["c_open"] = Task.objects.create(project=c, name="C open", duration=2)
    return t


def _dates(task: Task) -> tuple[Any, Any, Any]:
    task.refresh_from_db()
    return task.early_start, task.early_finish, task.scheduled_start


def _task_keys(t: dict[str, Any]) -> list[str]:
    return [k for k, v in t.items() if isinstance(v, Task)]


@pytest.mark.django_db
def test_program_pass_matches_each_members_single_pass(calendar: Calendar) -> None:
    """With no cross link, every member gets the dates its own single pass gives."""
    t = _fixture(calendar)
    for key in ("a", "b", "c"):
        _run_schedule(str(t[key].pk))
    single = {k: _dates(t[k]) for k in _task_keys(t)}

    graph = gather_program_schedule(t["program"], enforce_max=False)

    program = {
        k: (
            graph.result_map[str(t[k].pk)].early_start,
            graph.result_map[str(t[k].pk)].early_finish,
            graph.result_map[str(t[k].pk)].scheduled_start,
        )
        for k in _task_keys(t)
    }
    assert program == single


@pytest.mark.django_db
def test_a_member_is_never_scheduled_before_its_own_start(calendar: Calendar) -> None:
    t = _fixture(calendar)

    graph = gather_program_schedule(t["program"], enforce_max=False)

    for key in ("b_open", "b_snet", "b_gate", "b_after_gate"):
        assert graph.result_map[str(t[key].pk)].early_start >= B_START, key


@pytest.mark.django_db
def test_each_members_data_date_floors_its_open_work(calendar: Calendar) -> None:
    t = _fixture(calendar)

    graph = gather_program_schedule(t["program"], enforce_max=False)

    assert graph.result_map[str(t["a_open"].pk)].early_start == A_DATA_DATE
    # In progress: the remaining work is laid from the data date, the span from
    # where work actually started (ADR-0752).
    running = graph.result_map[str(t["a_running"].pk)]
    assert running.early_start == A_DATA_DATE
    assert running.scheduled_start == date(2026, 3, 4)
    # Completed work is not moved by the data date.
    assert graph.result_map[str(t["a_done"].pk)].early_start == date(2026, 3, 2)
    # An unset data date resolves to today, as the single pass does.
    assert graph.result_map[str(t["c_open"].pk)].early_start >= timezone.localdate()


@pytest.mark.django_db
def test_accepting_a_cross_link_moves_only_the_work_it_drives(calendar: Calendar) -> None:
    """The issue's acceptance test: escalating to the program pass by accepting
    one link leaves every task the link does not drive where it was."""
    t = _fixture(calendar)
    for key in ("a", "b", "c"):
        _run_schedule(str(t[key].pk))
    before = {k: _dates(t[k]) for k in _task_keys(t)}

    # A long upstream task drives only B's late-SNET task.
    upstream = Task.objects.create(project=t["a"], name="A upstream", duration=40)
    _run_schedule(str(t["a"].pk))
    Dependency.objects.create(
        predecessor=upstream,
        successor=t["b_late_snet"],
        dep_type="FS",
        lag=0,
        accepted_at=timezone.now(),
    )

    _run_program_schedule(str(t["program"].pk))

    after = {k: _dates(t[k]) for k in _task_keys(t)}
    driven = after.pop("b_late_snet")
    before_driven = before.pop("b_late_snet")
    assert after == before
    upstream.refresh_from_db()
    assert driven[0] > upstream.early_finish
    assert driven[0] > before_driven[0]


@pytest.mark.django_db
@pytest.mark.xfail(
    strict=True,
    reason=(
        "Known residual of #5178: a milestone held only by a later-starting member's "
        "project start takes that start as an SNET, and an SNET binds the instant its "
        "successors measure from where the project-start floor does not (#4225), so a "
        "lagged successor lands a day earlier than in the single pass. Exact parity "
        "needs a per-member start/data-date anchor in the engine (engine-first)."
    ),
)
def test_a_lagged_successor_of_a_start_held_milestone_matches_the_single_pass(
    calendar: Calendar,
) -> None:
    t = _fixture(calendar)
    lagged = Task.objects.create(project=t["b"], name="B lagged", duration=2)
    Dependency.objects.create(predecessor=t["b_gate"], successor=lagged, dep_type="FS", lag=1)
    _run_schedule(str(t["b"].pk))
    single = _dates(lagged)

    graph = gather_program_schedule(t["program"], enforce_max=False)

    st = graph.result_map[str(lagged.pk)]
    assert (st.early_start, st.early_finish, st.scheduled_start) == single


@pytest.mark.django_db
@pytest.mark.xfail(
    strict=True,
    reason=(
        "Known residual of #5178: a task marked complete with no recorded actuals "
        "is laid back to finish on its project's data date by the single pass "
        "(#4539), which reads the engine-level status_date; the merged program "
        "project carries none. Exact parity needs a per-member data-date anchor in "
        "the engine (engine-first)."
    ),
)
def test_a_completed_task_without_actuals_matches_the_single_pass(calendar: Calendar) -> None:
    t = _fixture(calendar)
    done = Task.objects.create(
        project=t["a"], name="A done, no dates", duration=20, percent_complete=100
    )
    _run_schedule(str(t["a"].pk))
    single = _dates(done)

    graph = gather_program_schedule(t["program"], enforce_max=False)

    st = graph.result_map[str(done.pk)]
    assert (st.early_start, st.early_finish, st.scheduled_start) == single
