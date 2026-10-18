"""The direct-object path and the document path accept the same projects (#4517).

``schedule()``/``monte_carlo()``/``derive_value()`` take a :class:`Project` built in
Python; ``Project.from_dict``/``from_json`` take its document form. Before #4517 the
direct-object validators guarded only the fields the CPM pass reads, so a project
with ``Calendar(hours_per_day="x")`` or ``Task(early_start="x")`` scheduled, while
``Project.from_json(p.to_json())`` refused it; and ``to_dict``/``to_json`` leaked a
bare ``AttributeError``/``TypeError`` for a field they could not serialize.

The property, for any generated project (valid, or with one to three fields set to
a value of the wrong type or out of range):

* ``schedule()`` accepts it ⇒ ``to_json()`` succeeds, ``from_json()`` loads it back,
  the reloaded project serializes identically, and schedules identically;
* ``schedule()``, ``monte_carlo()`` and ``derive_value()`` agree on acceptance, and
  a refusal is a :class:`SchedulerError`;
* ``to_json()`` either succeeds — and then ``from_json()`` accepts the output — or
  raises :class:`InvalidScheduleInput`; never a bare exception.
"""

from __future__ import annotations

import dataclasses
from datetime import date, datetime, timedelta
from typing import Any

import pytest
from hypothesis import given
from hypothesis import strategies as st

from trueppm_scheduler import (
    Calendar,
    DateRange,
    DeliveryMode,
    Dependency,
    DependencyType,
    InvalidScheduleInput,
    Project,
    SchedulerError,
    Task,
    derive_value,
    monte_carlo,
    schedule,
)

pytestmark = pytest.mark.fuzz

_START = date(2026, 1, 5)  # a Monday


def _raw_date_range(start: Any, end: Any) -> DateRange:
    """A ``DateRange`` holding arbitrary bounds, bypassing any construction check.

    The serializable-field rules must hold whatever ``DateRange.__post_init__``
    accepts, so the test does not rely on it refusing a ``datetime`` bound.
    """
    dr = object.__new__(DateRange)
    object.__setattr__(dr, "start", start)
    object.__setattr__(dr, "end", end)
    return dr


# Wrong-typed and out-of-range values drawn for any field. Several are the right
# type for *some* field (a date, a timedelta, a bool, a Calendar) so a mutation can
# also land a valid value; the property must hold either way.
_ANY_VALUE: list[Any] = [
    None,
    "x",
    "2026-01-06",
    "FS",
    "scrum",
    0,
    5,
    200,
    -1,
    2.5,
    True,
    float("inf"),
    float("nan"),
    10**400,
    date(2026, 1, 6),
    datetime(2026, 1, 6),
    timedelta(days=1),
    timedelta(seconds=1),
    [],
    {},
    (1.0, 2.0),
    [3.0, None],
    Calendar(),
    {"c1": Calendar()},
    {1: Calendar()},
    DependencyType.SS,
    DeliveryMode.SCRUM,
]

_TASK_FIELDS = [f.name for f in dataclasses.fields(Task)]
_DEP_FIELDS = [f.name for f in dataclasses.fields(Dependency)]
_PROJECT_FIELDS = [f.name for f in dataclasses.fields(Project)]
_CALENDAR_FIELDS = ["working_days", "hours_per_day", "timezone"]
_EXCEPTION_VALUES: list[Any] = [
    [DateRange(date(2026, 1, 7), date(2026, 1, 8))],
    ["ab"],
    [None],
    [_raw_date_range(datetime(2026, 1, 7), datetime(2026, 1, 8))],
    [_raw_date_range("2026-01-07", "2026-01-08")],
]


@st.composite
def _base_projects(draw: st.DrawFn) -> Project:
    """A small, schedulable project exercising the optional fields."""
    n = draw(st.integers(1, 4))
    use_registry = draw(st.booleans())
    tasks: list[Task] = []
    for i in range(n):
        d = draw(st.integers(0, 5))
        pert = draw(st.booleans())
        tasks.append(
            Task(
                id=f"t{i}",
                name=f"T{i}",
                duration=timedelta(days=d),
                planned_start=draw(st.none() | st.just(_START + timedelta(days=2))),
                percent_complete=draw(st.sampled_from([0.0, 25, 50.0])),
                optimistic_duration=timedelta(days=d) if pert else None,
                most_likely_duration=timedelta(days=d + 1) if pert else None,
                pessimistic_duration=timedelta(days=d + 2) if pert else None,
                delivery_mode=draw(st.none() | st.just(DeliveryMode.SCRUM)),
                story_points=draw(st.none() | st.just(8.0)),
                calendar_id="c1" if use_registry and i % 2 else None,
            )
        )
    deps = [
        Dependency(
            f"t{i}",
            f"t{i + 1}",
            dep_type=draw(st.sampled_from(list(DependencyType))),
            lag=timedelta(days=draw(st.integers(-1, 2))),
        )
        for i in range(n - 1)
    ]
    project = Project(
        id="p",
        name="P",
        start_date=_START,
        tasks=tasks,
        dependencies=deps,
        calendar=Calendar(
            exceptions=draw(st.sampled_from([(), (DateRange(date(2026, 1, 9), date(2026, 1, 9)),)]))
        ),
        velocity_samples=draw(st.none() | st.just([5.0, 8.0, None])),
        sprint_length_days=draw(st.none() | st.just(10)),
        status_date=draw(st.none() | st.just(_START + timedelta(days=1))),
        calendars={"c1": Calendar(working_days=0b1111111)} if use_registry else None,
    )
    if draw(st.booleans()):
        # Feed computed dates/floats/flags back in as input, as a caller re-scheduling
        # a previous result does.
        project.tasks = schedule(project).tasks
    return project


@st.composite
def _mutated_projects(draw: st.DrawFn) -> tuple[Project, list[str]]:
    project = draw(_base_projects())
    applied: list[str] = []
    for _ in range(draw(st.integers(0, 3))):
        target = draw(st.sampled_from(["project", "task", "dependency", "calendar", "registry"]))
        if target == "project":
            name = draw(st.sampled_from(_PROJECT_FIELDS))
            value = draw(st.sampled_from(_ANY_VALUE))
            setattr(project, name, value)
        elif target == "task" and isinstance(project.tasks, list) and project.tasks:
            obj = draw(st.sampled_from(project.tasks))
            if not isinstance(obj, Task):
                continue
            name = draw(st.sampled_from(_TASK_FIELDS))
            value = draw(st.sampled_from(_ANY_VALUE))
            setattr(obj, name, value)
        elif (
            target == "dependency"
            and isinstance(project.dependencies, list)
            and (project.dependencies)
        ):
            obj = draw(st.sampled_from(project.dependencies))
            if not isinstance(obj, Dependency):
                continue
            name = draw(st.sampled_from(_DEP_FIELDS))
            value = draw(st.sampled_from(_ANY_VALUE))
            setattr(obj, name, value)
        elif target in ("calendar", "registry"):
            if target == "calendar":
                cal = project.calendar
            else:
                regs = project.calendars
                cal = next(iter(regs.values()), None) if isinstance(regs, dict) else None
            if not isinstance(cal, Calendar):
                continue
            if draw(st.booleans()):
                name, value = "exceptions", draw(st.sampled_from(_EXCEPTION_VALUES))
            else:
                name = draw(st.sampled_from(_CALENDAR_FIELDS))
                value = draw(st.sampled_from(_ANY_VALUE))
            setattr(cal, name, value)
        else:
            continue
        applied.append(f"{target}.{name}={value!r}")
    return project, applied


def _outcome(fn: Any) -> tuple[bool, BaseException | None]:
    try:
        fn()
    except SchedulerError as err:
        return False, err
    except Exception as err:
        pytest.fail(f"leaked {type(err).__name__}: {err}")
    return True, None


def _first_task_id(project: Project) -> str:
    return project.tasks[0].id


@given(_mutated_projects())
def test_schedule_acceptance_implies_json_round_trip(case: tuple[Project, list[str]]) -> None:
    project, applied = case
    note = f"mutations: {applied}"

    accepted, _ = _outcome(lambda: schedule(project))
    mc_accepted, _ = _outcome(lambda: monte_carlo(project, runs=3, seed=0))
    assert mc_accepted == accepted, f"schedule/monte_carlo disagree on acceptance; {note}"
    if accepted:
        dv_accepted, _ = _outcome(
            lambda: derive_value(project, _first_task_id(project), "early_start")
        )
        assert dv_accepted, f"derive_value refused what schedule accepted; {note}"

    try:
        doc = project.to_json()
    except InvalidScheduleInput:
        assert not accepted, f"schedule accepted a project to_json refuses; {note}"
        return
    except Exception as err:
        pytest.fail(f"to_json leaked {type(err).__name__}: {err}; {note}")

    try:
        reloaded = Project.from_json(doc)
    except InvalidScheduleInput as err:
        pytest.fail(f"from_json refused to_json's own output ({err}); {note}")
    assert reloaded.to_dict() == project.to_dict(), note

    if accepted:
        assert schedule(reloaded).to_dict() == schedule(project).to_dict(), note
    else:
        # The reloaded project is the same project: it must be refused too.
        assert not _outcome(lambda: schedule(reloaded))[0], note


# --- Deterministic pins for the audit cases (#4517) --------------------------------


def _project() -> Project:
    return Project(
        id="p",
        name="P",
        start_date=_START,
        tasks=[
            Task(id="a", name="A", duration=timedelta(days=2)),
            Task(id="b", name="B", duration=timedelta(days=1)),
        ],
        dependencies=[Dependency("a", "b")],
    )


_REFUSED_BY_BOTH: dict[str, Any] = {
    "calendar.hours_per_day='x'": lambda p: setattr(p.calendar, "hours_per_day", "x"),
    "calendar.hours_per_day=inf": lambda p: setattr(p.calendar, "hours_per_day", float("inf")),
    "calendar.timezone=5": lambda p: setattr(p.calendar, "timezone", 5),
    # #4435: from_dict's [0, 127] range, previously unchecked on the object path.
    "calendar.working_days=200": lambda p: setattr(p.calendar, "working_days", 200),
    "calendar.working_days=-1": lambda p: setattr(p.calendar, "working_days", -1),
    "registry working_days=129": lambda p: setattr(
        p, "calendars", {"c1": Calendar(working_days=129)}
    ),
    "calendar.exceptions datetime": lambda p: setattr(
        p.calendar,
        "exceptions",
        [_raw_date_range(datetime(2026, 1, 7), datetime(2026, 1, 8))],
    ),
    "calendar.exceptions=['ab']": lambda p: setattr(p.calendar, "exceptions", ["ab"]),
    "task.planned_finish='garbage'": lambda p: setattr(p.tasks[0], "planned_finish", "garbage"),
    "task.planned_finish=5": lambda p: setattr(p.tasks[0], "planned_finish", 5),
    "task.early_start='x'": lambda p: setattr(p.tasks[0], "early_start", "x"),
    "task.total_float='x'": lambda p: setattr(p.tasks[0], "total_float", "x"),
    "task.is_critical=1": lambda p: setattr(p.tasks[0], "is_critical", 1),
    "task.delivery_mode='scrum'": lambda p: setattr(p.tasks[0], "delivery_mode", "scrum"),
    "task.story_points=10**400": lambda p: setattr(p.tasks[0], "story_points", 10**400),
    "project.start_date str": lambda p: setattr(p, "start_date", "2026-01-05"),
    "project.status_date str": lambda p: setattr(p, "status_date", "2026-01-05"),
    "project.tasks=None": lambda p: setattr(p, "tasks", None),
    "project.calendar=None": lambda p: setattr(p, "calendar", None),
    "project.calendars=[...]": lambda p: setattr(p, "calendars", [Calendar()]),
    "project.calendars int key": lambda p: setattr(p, "calendars", {1: Calendar()}),
    "project.velocity_samples=[10**400]": lambda p: setattr(p, "velocity_samples", [10**400]),
    "dependency.lag=2": lambda p: setattr(p.dependencies[0], "lag", 2),
    "dependency.dep_type='FS'": lambda p: setattr(p.dependencies[0], "dep_type", "FS"),
}


@pytest.mark.parametrize("case", sorted(_REFUSED_BY_BOTH))
def test_audit_case_refused_by_schedule_and_to_json(case: str) -> None:
    project = _project()
    _REFUSED_BY_BOTH[case](project)
    with pytest.raises(InvalidScheduleInput):
        schedule(project)
    with pytest.raises(InvalidScheduleInput):
        monte_carlo(project, runs=3, seed=0)
    with pytest.raises(InvalidScheduleInput):
        project.to_json()
    with pytest.raises(InvalidScheduleInput):
        project.to_dict()


def test_to_dict_lists_a_tuple_of_velocity_samples() -> None:
    """A tuple is accepted by ``schedule()`` and must serialize as the list it loads as."""
    project = _project()
    project.velocity_samples = (5.0, 8.0)  # type: ignore[assignment]
    schedule(project)
    assert project.to_dict()["velocity_samples"] == [5.0, 8.0]
    assert Project.from_json(project.to_json()).to_dict() == project.to_dict()


@pytest.mark.parametrize(
    ("doc_patch", "label"),
    [
        ({"calendar": {"hours_per_day": float("nan")}}, "hours_per_day NaN via dict"),
        ({"calendar": {"hours_per_day": float("inf")}}, "hours_per_day inf via dict"),
        ({"calendars": {1: {}}}, "calendars int key via dict"),
    ],
)
def test_from_dict_refuses_what_the_object_path_refuses(
    doc_patch: dict[str, Any], label: str
) -> None:
    doc = _project().to_dict()
    doc.update(doc_patch)
    with pytest.raises(InvalidScheduleInput):
        Project.from_dict(doc)


def test_from_dict_refuses_non_string_calendar_id() -> None:
    doc = _project().to_dict()
    doc["tasks"][0]["calendar_id"] = 5
    with pytest.raises(InvalidScheduleInput, match="calendar_id"):
        Project.from_dict(doc)


def test_empty_project_still_serializes() -> None:
    """``to_dict`` checks serializability, not scheduling: no tasks is fine to save."""
    project = Project(id="p", name="P", start_date=_START)
    with pytest.raises(InvalidScheduleInput):
        schedule(project)
    assert Project.from_json(project.to_json()).to_dict() == project.to_dict()
