"""Contribution-structure hardening for derive.py (#2330 — mutation survivors).

``test_derive.py`` asserts that ``derive_value(...).value`` matches the engine,
but the *explanation* — the ordered ``contributions`` list with each term's
``kind``, driving task, ``dep_type``, ``lag_days``, ``imposed_date``,
``calendar_days_added``, ``slack_days`` and ``is_binding`` flag — was largely
executed-but-unasserted (mutation survivors clustered in ``_derive_forward``,
``_derive_backward``, ``_completed_forward_contribs``, ``_derive_total_float``,
``_derive_free_float`` and ``_flag_binding``).

The ``Derivation`` is a serialized API contract (ADR-0218), so these pin the
*whole* contribution list per scenario as a golden. The expected dicts below are
captured output, not a re-implementation of the derivation arithmetic: a change
to how a value is explained must break a test on purpose.

Scenarios use the default Mon-Fri calendar and a Monday project start
(2026-03-02) so weekend snaps are explicit, and a 2-day lag so lag arithmetic is
distinguishable from the +1 FS inclusive-day offset.
"""

from __future__ import annotations

from datetime import date, timedelta

from trueppm_scheduler import Calendar, Dependency, Project, Task
from trueppm_scheduler.derive import Quantity, derive_value
from trueppm_scheduler.models import DependencyType


def _c(kind: str, **over: object) -> dict[str, object]:
    """A DerivationContribution.to_dict() with defaults, overridden per term."""
    base: dict[str, object] = {
        "kind": kind,
        "source_task_id": None,
        "source_task_name": None,
        "dep_type": None,
        "lag_days": None,
        "imposed_date": None,
        "calendar_days_added": None,
        "slack_days": None,
        "is_binding": False,
    }
    base.update(over)
    return base


def _contribs(project: Project, task_id: str, q: Quantity) -> list[dict[str, object]]:
    d = derive_value(project, task_id, q)
    # The flagged binding must be exactly the one contribution with is_binding.
    flagged = [c for c in d.contributions if c.is_binding]
    assert len(flagged) == 1
    assert d.binding is flagged[0]
    return [c.to_dict() for c in d.contributions]


def _fwd(dep_type: DependencyType) -> Project:
    """P →(dep_type, lag 2) S — explain S's forward values."""
    return Project(
        id="pr",
        name="Pr",
        start_date=date(2026, 3, 2),
        tasks=[
            Task(id="P", name="Pred", duration=timedelta(days=3)),
            Task(id="S", name="Succ", duration=timedelta(days=2)),
        ],
        dependencies=[Dependency("P", "S", dep_type=dep_type, lag=timedelta(days=2))],
        calendar=Calendar(),
    )


def _bwd(dep_type: DependencyType) -> Project:
    """T →(dep_type, lag 2) S — explain T's backward values."""
    return Project(
        id="pr",
        name="Pr",
        start_date=date(2026, 3, 2),
        tasks=[
            Task(id="T", name="Targ", duration=timedelta(days=2)),
            Task(id="S", name="Succ", duration=timedelta(days=3)),
        ],
        dependencies=[Dependency("T", "S", dep_type=dep_type, lag=timedelta(days=2))],
        calendar=Calendar(),
    )


_PROJECT_START = _c("project_start", imposed_date="2026-03-02", calendar_days_added=0)


# --------------------------------------------------------------------------- #
# Forward pass: predecessor FS / SS / FF / SF (_derive_forward, _pred_forward). #
# --------------------------------------------------------------------------- #


def test_forward_fs() -> None:
    p = _fwd(DependencyType.FS)
    fs = _c(
        "predecessor_fs",
        source_task_id="P",
        source_task_name="Pred",
        dep_type="FS",
        lag_days=2,
        imposed_date="2026-03-09",
        calendar_days_added=2,
    )
    assert _contribs(p, "S", Quantity.EARLY_START) == [
        _PROJECT_START,
        {**fs, "is_binding": True},
    ]
    assert _contribs(p, "S", Quantity.EARLY_FINISH) == [
        _PROJECT_START,
        fs,
        _c("duration_from_early_start", imposed_date="2026-03-10", slack_days=2, is_binding=True),
    ]


def test_forward_ss() -> None:
    p = _fwd(DependencyType.SS)
    ss = _c(
        "predecessor_ss",
        source_task_id="P",
        source_task_name="Pred",
        dep_type="SS",
        lag_days=2,
        imposed_date="2026-03-04",
        calendar_days_added=0,
    )
    assert _contribs(p, "S", Quantity.EARLY_START) == [
        _PROJECT_START,
        {**ss, "is_binding": True},
    ]
    assert _contribs(p, "S", Quantity.EARLY_FINISH) == [
        _PROJECT_START,
        ss,
        _c("duration_from_early_start", imposed_date="2026-03-05", slack_days=2, is_binding=True),
    ]


def test_forward_ff_imposes_finish_and_pulls_start_back() -> None:
    p = _fwd(DependencyType.FF)
    ff = _c(
        "predecessor_ff",
        source_task_id="P",
        source_task_name="Pred",
        dep_type="FF",
        lag_days=2,
        imposed_date="2026-03-06",
        calendar_days_added=0,
    )
    # EF is bound by the FF term directly.
    assert _contribs(p, "S", Quantity.EARLY_FINISH) == [
        _PROJECT_START,
        {**ff, "is_binding": True},
    ]
    # ES is the EF-pullback: the FF finish drives a start below every ES candidate.
    assert _contribs(p, "S", Quantity.EARLY_START) == [
        _PROJECT_START,
        ff,
        _c(
            "early_finish_pullback",
            source_task_id="P",
            source_task_name="Pred",
            dep_type="FF",
            lag_days=2,
            imposed_date="2026-03-05",
            is_binding=True,
        ),
    ]


def test_forward_sf_imposes_finish_and_pulls_start_back() -> None:
    p = _fwd(DependencyType.SF)
    sf = _c(
        "predecessor_sf",
        source_task_id="P",
        source_task_name="Pred",
        dep_type="SF",
        lag_days=2,
        imposed_date="2026-03-04",
        calendar_days_added=0,
    )
    assert _contribs(p, "S", Quantity.EARLY_FINISH) == [
        _PROJECT_START,
        {**sf, "is_binding": True},
    ]
    assert _contribs(p, "S", Quantity.EARLY_START) == [
        _PROJECT_START,
        sf,
        _c(
            "early_finish_pullback",
            source_task_id="P",
            source_task_name="Pred",
            dep_type="SF",
            lag_days=2,
            imposed_date="2026-03-03",
            is_binding=True,
        ),
    ]


def test_forward_anchors_project_start_data_date_and_snet() -> None:
    p = Project(
        id="p4",
        name="Anchors",
        start_date=date(2026, 3, 2),
        status_date=date(2026, 3, 4),
        tasks=[
            Task(id="A", name="Alpha", duration=timedelta(days=2), planned_start=date(2026, 3, 5))
        ],
        dependencies=[],
        calendar=Calendar(),
    )
    # SNET (planned_start) wins over the earlier project-start and data-date anchors.
    assert _contribs(p, "A", Quantity.EARLY_START) == [
        _PROJECT_START,
        _c("data_date", imposed_date="2026-03-04", calendar_days_added=0),
        _c("planned_start_snet", imposed_date="2026-03-05", calendar_days_added=0, is_binding=True),
    ]


def test_forward_flag_binding_prefers_driver_over_anchor_on_tie() -> None:
    # A zero-duration predecessor + SS lag 0 makes the predecessor term impose the
    # very same date as project_start; the link (driver) must be flagged, not the anchor.
    p = Project(
        id="c4",
        name="C4",
        start_date=date(2026, 3, 2),
        tasks=[
            Task(id="P", name="Pred", duration=timedelta(0)),
            Task(id="S", name="Succ", duration=timedelta(days=2)),
        ],
        dependencies=[Dependency("P", "S", dep_type=DependencyType.SS, lag=timedelta(0))],
        calendar=Calendar(),
    )
    assert _contribs(p, "S", Quantity.EARLY_START) == [
        _c("project_start", imposed_date="2026-03-02", calendar_days_added=0),
        _c(
            "predecessor_ss",
            source_task_id="P",
            source_task_name="Pred",
            dep_type="SS",
            lag_days=0,
            imposed_date="2026-03-02",
            calendar_days_added=0,
            is_binding=True,
        ),
    ]


# --------------------------------------------------------------------------- #
# Backward pass: successor FS / SS / FF / SF (_derive_backward, _flag_binding). #
# --------------------------------------------------------------------------- #


def test_backward_fs() -> None:
    p = _bwd(DependencyType.FS)
    pf = _c("project_finish", imposed_date="2026-03-10")
    fs = _c(
        "successor_fs",
        source_task_id="S",
        source_task_name="Succ",
        dep_type="FS",
        lag_days=2,
        imposed_date="2026-03-03",
        calendar_days_added=0,
    )
    assert _contribs(p, "T", Quantity.LATE_FINISH) == [pf, {**fs, "is_binding": True}]
    assert _contribs(p, "T", Quantity.LATE_START) == [
        pf,
        fs,
        _c("duration_from_late_finish", imposed_date="2026-03-02", slack_days=2, is_binding=True),
    ]


def test_backward_ss_pulls_finish_via_late_start_duration() -> None:
    p = _bwd(DependencyType.SS)
    pf = _c("project_finish", imposed_date="2026-03-06")
    ss = _c(
        "successor_ss",
        source_task_id="S",
        source_task_name="Succ",
        dep_type="SS",
        lag_days=2,
        imposed_date="2026-03-02",
        calendar_days_added=0,
    )
    assert _contribs(p, "T", Quantity.LATE_START) == [pf, {**ss, "is_binding": True}]
    # LF is the LS-pullback branch: the SS successor drove late_start below the
    # LF-derived start, so late_finish matches no LF term and cites the driver.
    assert _contribs(p, "T", Quantity.LATE_FINISH) == [
        pf,
        ss,
        _c(
            "duration_from_late_start",
            source_task_id="S",
            source_task_name="Succ",
            dep_type="SS",
            lag_days=2,
            imposed_date="2026-03-03",
            slack_days=2,
            is_binding=True,
        ),
    ]


def test_backward_ff() -> None:
    p = _bwd(DependencyType.FF)
    pf = _c("project_finish", imposed_date="2026-03-05")
    ff = _c(
        "successor_ff",
        source_task_id="S",
        source_task_name="Succ",
        dep_type="FF",
        lag_days=2,
        imposed_date="2026-03-03",
        calendar_days_added=0,
    )
    assert _contribs(p, "T", Quantity.LATE_FINISH) == [pf, {**ff, "is_binding": True}]
    assert _contribs(p, "T", Quantity.LATE_START) == [
        pf,
        ff,
        _c("duration_from_late_finish", imposed_date="2026-03-02", slack_days=2, is_binding=True),
    ]


def test_backward_sf_pulls_finish_via_late_start_duration() -> None:
    p = _bwd(DependencyType.SF)
    pf = _c("project_finish", imposed_date="2026-03-04")
    sf = _c(
        "successor_sf",
        source_task_id="S",
        source_task_name="Succ",
        dep_type="SF",
        lag_days=2,
        imposed_date="2026-03-02",
        calendar_days_added=0,
    )
    assert _contribs(p, "T", Quantity.LATE_START) == [pf, {**sf, "is_binding": True}]
    assert _contribs(p, "T", Quantity.LATE_FINISH) == [
        pf,
        sf,
        _c(
            "duration_from_late_start",
            source_task_id="S",
            source_task_name="Succ",
            dep_type="SF",
            lag_days=2,
            imposed_date="2026-03-03",
            slack_days=2,
            is_binding=True,
        ),
    ]


def test_backward_skips_completed_successor() -> None:
    # A done successor imposes no live backward constraint (#1819); it must not
    # appear as a term, leaving only the project-finish anchor.
    p = Project(
        id="c3",
        name="C3",
        start_date=date(2026, 3, 2),
        tasks=[
            Task(id="T", name="Targ", duration=timedelta(days=2)),
            Task(
                id="Sd",
                name="SuccDone",
                duration=timedelta(days=2),
                actual_start=date(2026, 3, 2),
                actual_finish=date(2026, 3, 3),
                percent_complete=100,
            ),
        ],
        dependencies=[Dependency("T", "Sd")],
        calendar=Calendar(),
    )
    assert _contribs(p, "T", Quantity.LATE_FINISH) == [
        _c("project_finish", imposed_date="2026-03-03", is_binding=True),
    ]


# --------------------------------------------------------------------------- #
# Completed tasks: _completed_forward_contribs three branches.                 #
# --------------------------------------------------------------------------- #


def _completed(**task_over: object) -> Project:
    return Project(
        id="c",
        name="C",
        start_date=date(2026, 3, 2),
        tasks=[
            Task(
                id="A", name="Done", duration=timedelta(days=3), percent_complete=100, **task_over
            ),
            Task(id="B", name="Next", duration=timedelta(days=2)),
        ],
        dependencies=[Dependency("A", "B")],
        calendar=Calendar(),
    )


def test_completed_with_actual_finish_is_finish_first() -> None:
    p = _completed(actual_start=date(2026, 3, 2), actual_finish=date(2026, 3, 4))
    af = _c("actual_finish", imposed_date="2026-03-04")
    as_ = _c("actual_start", imposed_date="2026-03-02")
    # Finish-first ordering; the binding follows the requested quantity.
    assert _contribs(p, "A", Quantity.EARLY_FINISH) == [{**af, "is_binding": True}, as_]
    assert _contribs(p, "A", Quantity.EARLY_START) == [af, {**as_, "is_binding": True}]


def test_completed_with_actual_start_only_is_start_first() -> None:
    p = _completed(actual_start=date(2026, 3, 2))
    as_ = _c("actual_start", imposed_date="2026-03-02")
    af = _c("actual_finish", imposed_date="2026-03-04")
    assert _contribs(p, "A", Quantity.EARLY_START) == [{**as_, "is_binding": True}, af]
    assert _contribs(p, "A", Quantity.EARLY_FINISH) == [as_, {**af, "is_binding": True}]


def test_completed_bare_100_percent_uses_planning_position() -> None:
    p = _completed()  # 100% complete, no recorded actuals
    ps = _c("project_start", imposed_date="2026-03-02")
    ef = _c("early_start", imposed_date="2026-03-04")
    assert _contribs(p, "A", Quantity.EARLY_START) == [{**ps, "is_binding": True}, ef]
    assert _contribs(p, "A", Quantity.EARLY_FINISH) == [ps, {**ef, "is_binding": True}]


def test_completed_backward_pins_late_to_early() -> None:
    p = _completed(actual_start=date(2026, 3, 2), actual_finish=date(2026, 3, 4))
    assert _contribs(p, "A", Quantity.LATE_START) == [
        _c("early_start", imposed_date="2026-03-02", is_binding=True),
        _c("project_finish", imposed_date="2026-03-04"),
    ]


# --------------------------------------------------------------------------- #
# Floats: _derive_total_float, _derive_free_float (binding + fallback).        #
# --------------------------------------------------------------------------- #


def _parallel() -> Project:
    """A→C and B→C; B floats 4 working days off the critical path."""
    return Project(
        id="p2",
        name="Para",
        start_date=date(2026, 3, 2),
        tasks=[
            Task(id="A", name="Alpha", duration=timedelta(days=5)),
            Task(id="B", name="Beta", duration=timedelta(days=1)),
            Task(id="C", name="Gamma", duration=timedelta(days=1)),
        ],
        dependencies=[Dependency("A", "C"), Dependency("B", "C")],
        calendar=Calendar(),
    )


def test_total_float_early_and_late_start_terms() -> None:
    p = _parallel()
    d = derive_value(p, "B", Quantity.TOTAL_FLOAT)
    assert d.value == 4
    assert [c.to_dict() for c in d.contributions] == [
        _c("early_start", imposed_date="2026-03-02", slack_days=4, is_binding=True),
        _c("late_start", imposed_date="2026-03-06", is_binding=True),
    ]


def test_free_float_binding_successor_slack() -> None:
    p = _parallel()
    d = derive_value(p, "B", Quantity.FREE_FLOAT)
    assert d.value == 4
    assert [c.to_dict() for c in d.contributions] == [
        _c(
            "successor_free_slack",
            source_task_id="C",
            source_task_name="Gamma",
            dep_type="FS",
            lag_days=0,
            imposed_date="2026-03-06",
            slack_days=4,
            is_binding=True,
        ),
    ]


def test_free_float_falls_back_to_total_float_without_successors() -> None:
    p = Project(
        id="p3",
        name="NoSucc",
        start_date=date(2026, 3, 2),
        tasks=[
            Task(id="A", name="Alpha", duration=timedelta(days=2)),
            Task(id="B", name="Beta", duration=timedelta(days=2)),
        ],
        dependencies=[Dependency("A", "B")],
        calendar=Calendar(),
    )
    d = derive_value(p, "B", Quantity.FREE_FLOAT)
    assert d.value == 0
    assert [c.to_dict() for c in d.contributions] == [
        _c("total_float", slack_days=0, is_binding=True),
    ]
