"""Kill tests for the ``derive.py`` mutants the #4146 nightly still reported alive.

Two halves, deliberately kept apart:

* **Networks** scheduled through the public :func:`derive_value`. Each one is the
  smallest project found that separates a surviving mutant from the real code,
  and each assertion names every candidate term (kind, source, imposed date,
  slack, binding flag) — a value-only check is what let these survive, because
  the right date is routinely reachable by the wrong term.
* **Helpers called directly**, for branches no scheduled network reaches: the
  milestone late-window floor in ``_derive_backward``, the negative-slack branch
  of ``_inverse_link_constraint``, the ``target=None`` fallback of
  ``_flag_binding``, and the guards that refuse an unscheduled task. The engine
  floors a milestone's late instant at its early instant and bounds every live
  successor's early window by the milestone's own forward edge, so a successor
  bound below the early instant never occurs in a real result (~12,000 random
  networks and a sweep of cross-calendar and weekend-actual cases produced none).
  The derivation carries those branches anyway, mirroring the engine's
  ``max(min(bounds), early)``; this file pins what they emit, in the same
  style as ``test_derive_hardening.py``'s pullback tests.

Mutants judged equivalent — no input distinguishes them — are listed at the end
of this docstring, so the next reader of a mutation report does not re-derive
them:

* ``_cal_for`` default ``calendar`` → ``None``: ``_resolve_task_calendars`` maps
  every task id, so the default is never read (killed directly here anyway).
* ``_derive_scheduled_start`` ``is_binding=False`` omitted: ``False`` is the
  field default.
* ``_pred_forward_contribution`` ``key = ""`` / ``keys is not None or key is not
  None``: keys are read only when the target is a milestone, and then every link
  sets a real key.
* ``_derive_forward`` ``if ctxs or True``, ``zip(strict=...)``: ``any([])`` is
  ``False``, and ``_milestone_context`` builds one context per predecessor.
* ``_derive_forward`` / ``_derive_backward`` ``early_finish`` ↔ ``early_start``
  and ``late_start`` ↔ ``late_finish`` inside the milestone branch: a
  milestone's two dates are one instant.
* ``_derive_backward_finish_fallback`` ``want_start=None``: falsy, same as
  ``False``.
* ``_backward_successor_terms`` / ``_derive_free_float`` passing ``None`` as the
  dependency type to ``refs``: no ``refs`` implementation reads it.
* ``_prefloor_late_window`` ``<`` → ``<=``: at equality the LS-pullback branch
  recomputes ``min(finish_from_start(start_from_finish(lf)), lf)``, which is
  ``lf`` on the working-day ``lf`` every backward term is snapped to.
* ``_late_window_floor_binding`` ``(value is None and early is None) or value !=
  early``: equal to the original for every combination of ``None``.
* ``_inverse_link_constraint`` ``latest < early`` → ``<=``: at equality both
  branches count zero working days.
* ``_derive_free_float``'s three ``assert`` ``and`` → ``or`` mutants: the callee
  ``_inverse_link_constraint`` re-asserts the same four dates.
* ``_milestone_context`` ``own_instants = ""``: falsy, so ``_derive_total_float``
  falls back exactly as for ``None``. ``own is not None or task.id in
  late_instants``: ``late_instants`` only holds milestones ``instants`` holds, and
  no completed milestone reached the branch in the random search.
* ``derive_value`` ``Quantity(Quantity.X)``: returns the member.
  ``result.project_finish`` → ``None``: ``_backward_successor_terms`` reads it only
  when ``finish_instant`` is falsy, and ``_milestone_context`` always supplies one.
  ``next(..., )`` without a default: every derivation branch flags a binding.
* ``_milestone_context`` ``if any(zero-duration) or True``: the replay is keyed
  on the whole project since #4157, so the mutant only adds it to a project with
  no milestone — where ``engine._finish_instant`` over no instants is
  ``project_finish + 1``, the seed the original computes directly. Before #4157
  the replay was keyed on the target's neighbors, and this mutant was the one
  that exposed a terminal milestone's finish instant going unseen
  (``test_milestone_instant``'s #4157 tests now pin that defect).
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from trueppm_scheduler import (
    Calendar,
    Dependency,
    DependencyType,
    Project,
    Quantity,
    Task,
    derive_value,
    schedule,
)
from trueppm_scheduler.derive import (
    DerivationContribution,
    _backward_successor_terms,
    _cal_for,
    _derive_backward,
    _derive_forward,
    _derive_free_float,
    _derive_scheduled_start,
    _derive_total_float,
    _flag_binding,
    _inverse_link_constraint,
    _late_dates,
    _late_window_floor_binding,
    _LinkContext,
    _milestone_context,
    _pred_forward_contribution,
)

MON = date(2026, 1, 5)
FOUR = Calendar(working_days=0b0001111)  # Mon-Thu
SIX = Calendar(working_days=0b0111111)  # Mon-Sat


def _task(tid: str, days: int, **kwargs: object) -> Task:
    t = Task(id=tid, name=tid, duration=timedelta(days=days))
    for key, value in kwargs.items():
        setattr(t, key, value)
    return t


def _dep(
    pred: str, succ: str, dep_type: DependencyType = DependencyType.FS, lag: int = 0
) -> Dependency:
    return Dependency(pred, succ, dep_type=dep_type, lag=timedelta(days=lag))


def _project(tasks: list[Task], deps: list[Dependency], **kwargs: object) -> Project:
    return Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=tasks,
        dependencies=deps,
        **kwargs,  # type: ignore[arg-type]
    )


Row = tuple[str, str | None, str | None, int | None, bool]


def _rows(project: Project, task_id: str, q: Quantity) -> tuple[object, list[Row]]:
    """``(value, [(kind, source, imposed, slack, is_binding), ...])`` for one cell.

    Also asserts the derived value is the engine's own and that exactly one term
    binds, so no row table can encode a value the engine does not report.
    """
    result = schedule(project)
    d = derive_value(project, task_id, q, result)
    engine = next(t for t in result.tasks if t.id == task_id)
    if q in (Quantity.TOTAL_FLOAT, Quantity.FREE_FLOAT):
        assert d.value == getattr(engine, q.value).days
    elif q is not Quantity.SCHEDULED_START:
        assert d.value == getattr(engine, q.value).isoformat()
    if q is not Quantity.TOTAL_FLOAT:  # total float cites both ends as binding
        assert [c for c in d.contributions if c.is_binding] == [d.binding]
    return d.value, [
        (
            c.kind,
            c.source_task_id,
            c.imposed_date.isoformat() if c.imposed_date else None,
            c.slack_days,
            c.is_binding,
        )
        for c in d.contributions
    ]


# ---------------------------------------------------------------------------
# Networks through the public API
# ---------------------------------------------------------------------------


def test_a_floor_beats_a_finish_anchored_link_proposing_the_same_midnight() -> None:
    # FF from A (finishing Wed) proposes the end of Wednesday — Thursday's midnight
    # read end-of-day. The SNET floor proposes the start of Thursday: the same
    # midnight, and a start-of-day reading outranks it, so the floor binds and the
    # milestone shows on Thursday. Pins the FF key as (finish + 1, end-of-day) and
    # a floor's key as (day, start-of-day).
    project = _project(
        [_task("A", 3), _task("M", 0, planned_start=date(2026, 1, 8))],
        [_dep("A", "M", DependencyType.FF)],
    )
    for q in (Quantity.EARLY_START, Quantity.EARLY_FINISH):
        assert _rows(project, "M", q) == (
            "2026-01-08",
            [
                ("project_start", None, "2026-01-05", None, False),
                ("planned_start_snet", None, "2026-01-08", None, True),
                ("predecessor_ff", "A", "2026-01-07", None, False),
            ],
        )


def test_a_finish_anchored_link_outranks_a_start_link_one_midnight_earlier() -> None:
    # SF from A (starting Mon) anchors on Fri, +1 lag → Sat → finishes Mon: its
    # instant is Tuesday's midnight. The FS link from milestone M1 proposes Monday's.
    # Both display Monday; only the instant comparison picks SF.
    project = _project(
        [_task("A", 5), _task("M1", 0), _task("M2", 0)],
        [_dep("A", "M2", DependencyType.SF, 1), _dep("M1", "M2")],
    )
    for q in (Quantity.EARLY_START, Quantity.EARLY_FINISH):
        assert _rows(project, "M2", q) == (
            "2026-01-05",
            [
                ("project_start", None, "2026-01-05", None, False),
                ("predecessor_fs", "M1", "2026-01-05", None, False),
                ("predecessor_sf", "A", "2026-01-05", None, True),
            ],
        )


def test_a_milestone_predecessor_passes_on_its_own_start_of_day_reading() -> None:
    # M1 sits at the start of Monday (held by the project-start floor). An FS link
    # out of it reads the way M1 is shown — start of day — not the end-of-day
    # reading FS from ordinary work takes, so M2 shows on Monday, not Friday. The
    # floor ties on the instant; the tie goes to the real link.
    project = _project([_task("M1", 0), _task("M2", 0)], [_dep("M1", "M2")])
    for q in (Quantity.EARLY_START, Quantity.EARLY_FINISH):
        assert _rows(project, "M2", q) == (
            "2026-01-05",
            [
                ("project_start", None, "2026-01-05", None, False),
                ("predecessor_fs", "M1", "2026-01-05", None, True),
            ],
        )


def test_milestone_total_float_is_measured_between_instants() -> None:
    # A Sunday data date puts the milestone's early instant on Sunday while it is
    # shown Monday. Its late instant is the project's finish instant (Saturday
    # midnight), shown Friday. Between the displayed days the span is 4 working
    # days; between the instants it is 5 — which is what the engine reports.
    project = _project([_task("M", 0), _task("A", 5)], [], status_date=date(2026, 1, 11))
    assert _rows(project, "M", Quantity.TOTAL_FLOAT) == (
        5,
        [
            ("early_start", None, "2026-01-12", 5, True),
            ("late_start", None, "2026-01-16", None, True),
        ],
    )
    assert _rows(project, "M", Quantity.FREE_FLOAT) == (
        5,
        [("total_float", None, None, 5, True)],
    )


def test_a_milestone_successors_late_references_use_its_own_calendar() -> None:
    # M runs on a Mon-Thu calendar; its SF finish reference is the last working
    # day before its late instant *on M's calendar*. Read on the default calendar
    # it would be a Friday and A's late dates would be cited from the wrong day.
    project = _project(
        [_task("A", 1, calendar_id="four"), _task("M", 0, calendar_id="four"), _task("L", 5)],
        [_dep("A", "M", DependencyType.SF, 4)],
        calendars={"four": FOUR},
    )
    assert _rows(project, "A", Quantity.LATE_START) == (
        "2026-01-05",
        [
            ("project_finish", None, "2026-01-08", None, False),
            ("successor_sf", "M", "2026-01-05", None, True),
        ],
    )
    assert _rows(project, "A", Quantity.LATE_FINISH) == (
        "2026-01-05",
        [
            ("project_finish", None, "2026-01-08", None, False),
            ("successor_sf", "M", "2026-01-05", None, False),
            ("duration_from_late_start", "M", "2026-01-05", 1, True),
        ],
    )


def test_a_milestone_successors_early_references_use_its_own_calendar() -> None:
    # The free-float twin of the test above: M (Mon-Sat calendar) sits at Sunday's
    # midnight, so its finish reference is Saturday on its own calendar, Friday on
    # the default one.
    project = _project(
        [_task("A", 1), _task("M", 0, calendar_id="six"), _task("L", 5)],
        [_dep("A", "M", DependencyType.SF, 1)],
        status_date=date(2026, 1, 11),
        calendars={"six": SIX},
    )
    assert _rows(project, "A", Quantity.FREE_FLOAT) == (
        0,
        [("successor_free_slack", "M", "2026-01-12", 0, True)],
    )


def test_a_non_driving_ff_term_does_not_bind_the_finish() -> None:
    # The FF link imposes Monday; B's own duration carries it to Friday. The finish
    # is the duration expansion, and the FF term must stay unflagged.
    project = _project([_task("A", 1), _task("B", 5)], [_dep("A", "B", DependencyType.FF)])
    assert _rows(project, "B", Quantity.EARLY_FINISH) == (
        "2026-01-09",
        [
            ("project_start", None, "2026-01-05", None, False),
            ("predecessor_ff", "A", "2026-01-05", None, False),
            ("duration_from_early_start", None, "2026-01-09", 5, True),
        ],
    )


def test_a_completed_successor_listed_first_does_not_hide_the_live_ones() -> None:
    # X is done and comes first in the dependency list; it is skipped, and the scan
    # must carry on to B rather than stop at it.
    project = _project(
        [_task("A", 2), _task("X", 1, percent_complete=100.0), _task("B", 2)],
        [_dep("A", "X"), _dep("A", "B")],
    )
    assert _rows(project, "A", Quantity.LATE_FINISH) == (
        "2026-01-06",
        [
            ("project_finish", None, "2026-01-08", None, False),
            ("successor_fs", "B", "2026-01-06", None, True),
        ],
    )
    assert _rows(project, "A", Quantity.FREE_FLOAT) == (
        0,
        [("successor_free_slack", "B", "2026-01-06", 0, True)],
    )


def test_the_late_window_floor_cites_each_side_at_its_own_early_date() -> None:
    # A started on a Saturday (kept verbatim) and finishes Monday. The SS link to B
    # pulls its late start to Friday, below the early start, so the engine floors
    # both late dates to the early window. The start floor must cite Saturday and
    # the finish floor Monday — each side's own early date.
    project = _project(
        [_task("A", 1, actual_start=date(2026, 1, 10), percent_complete=50.0), _task("B", 3)],
        [_dep("A", "B", DependencyType.SS, 4)],
    )
    head = [
        ("project_finish", None, "2026-01-16", None, False),
        ("successor_ss", "B", "2026-01-09", None, False),
    ]
    assert _rows(project, "A", Quantity.LATE_START) == (
        "2026-01-10",
        [*head, ("late_window_floor", None, "2026-01-10", None, True)],
    )
    assert _rows(project, "A", Quantity.LATE_FINISH) == (
        "2026-01-12",
        [*head, ("late_window_floor", None, "2026-01-12", None, True)],
    )


def test_scheduled_start_of_barely_started_and_actual_started_work() -> None:
    # 0.5% complete is in progress: the span start is the full-duration back-off,
    # not early_start, and the early_finish it was computed from is cited unbound.
    # With a recorded actual start, the actual itself is cited.
    project = _project(
        [
            _task("A", 4, percent_complete=0.5),
            _task("B", 4, percent_complete=50.0, actual_start=date(2026, 1, 2)),
        ],
        [],
    )
    assert _rows(project, "A", Quantity.SCHEDULED_START) == (
        "2026-01-05",
        [
            ("early_finish", None, "2026-01-08", None, False),
            ("full_duration_backoff", None, "2026-01-05", 4, True),
        ],
    )
    a = derive_value(project, "A", Quantity.SCHEDULED_START)
    assert a.contributions[0].is_binding is False
    assert _rows(project, "B", Quantity.SCHEDULED_START) == (
        "2026-01-02",
        [("actual_start", None, "2026-01-02", None, True)],
    )


# ---------------------------------------------------------------------------
# Helpers called directly
# ---------------------------------------------------------------------------


def _scheduled(tid: str, start: date, finish: date, **kwargs: object) -> Task:
    return _task(tid, (finish - start).days + 1, early_start=start, early_finish=finish, **kwargs)


def test_milestone_late_bound_below_the_early_instant_cites_the_floor() -> None:
    # The successor's late start (Thu) bounds M's instant below its early instant
    # (Mon), so the engine's max(min(bounds), early) floors it and the floor binds.
    m = _task(
        "M",
        0,
        early_start=date(2026, 1, 12),
        early_finish=date(2026, 1, 12),
        late_start=date(2026, 1, 12),
        late_finish=date(2026, 1, 12),
    )
    s = _task("S", 1, late_start=date(2026, 1, 8), late_finish=date(2026, 1, 8))
    for want_start in (True, False):
        value, contribs = _derive_backward(
            m,
            [(s, DependencyType.FS, timedelta(0))],
            Calendar(),
            date(2026, 1, 16),
            want_start=want_start,
            milestone_day=lambda d: d,
            finish_instant=date(2026, 1, 17),
            early_instant=date(2026, 1, 12),
        )
        assert value == "2026-01-12"
        assert [c.to_dict() for c in contribs][-1] == DerivationContribution(
            kind="late_window_floor", imposed_date=date(2026, 1, 12), is_binding=True
        ).to_dict()
        assert [c.kind for c in contribs if c.is_binding] == ["late_window_floor"]


def test_milestone_branch_needs_both_the_day_function_and_the_early_instant() -> None:
    # Without an early instant there is nothing to floor at: the ordinary
    # fallback runs instead of comparing the bounds against None.
    s = _task("S", 1, late_start=date(2026, 1, 8), late_finish=date(2026, 1, 8))
    t = _task("T", 1, late_start=date(2026, 1, 7), late_finish=date(2026, 1, 7))
    value, contribs = _derive_backward(
        t,
        [(s, DependencyType.FS, timedelta(0))],
        Calendar(),
        date(2026, 1, 16),
        want_start=False,
        milestone_day=lambda d: d,
        finish_instant=date(2026, 1, 17),
    )
    assert value == "2026-01-07"
    assert "late_window_floor" not in [c.kind for c in contribs]
    assert sum(c.is_binding for c in contribs) == 1


def test_unscheduled_milestone_derives_a_null_value() -> None:
    # Both milestone branches, like every other branch, return None for a task with
    # no CPM dates rather than raising from None.isoformat().
    blank = _task("M", 0)
    pred = _scheduled("P", MON, MON)
    value, contribs = _derive_forward(
        blank,
        [(pred, DependencyType.FS, timedelta(0))],
        Calendar(),
        MON,
        None,
        want_finish=False,
        links=[_LinkContext(to_milestone=True)],
    )
    assert value is None
    assert sum(c.is_binding for c in contribs) == 1
    value, _ = _derive_backward(
        blank,
        [],
        Calendar(),
        date(2026, 1, 16),
        want_start=True,
        milestone_day=lambda d: d,
        finish_instant=date(2026, 1, 17),
        early_instant=date(2026, 1, 12),
    )
    assert value is None


def test_milestone_free_slack_below_the_early_instant_is_negative() -> None:
    # The successor starts Thu; M's early instant is the following Mon. The slip is
    # counted backward from Thu to Mon: two working days (Thu, Fri) short.
    m = _scheduled("M", date(2026, 1, 12), date(2026, 1, 12))
    s = _scheduled("S", date(2026, 1, 8), date(2026, 1, 9))
    latest, slack = _inverse_link_constraint(
        m,
        s,
        DependencyType.FS,
        timedelta(0),
        Calendar(),
        milestone=(date(2026, 1, 12), lambda d: d),
    )
    assert (latest, slack) == (date(2026, 1, 8), -2)


def test_flag_binding_without_a_target_flags_the_tightest_term() -> None:
    terms = [
        DerivationContribution(kind="a", imposed_date=date(2026, 1, 9)),
        DerivationContribution(kind="b", imposed_date=None),
        DerivationContribution(kind="c", imposed_date=date(2026, 1, 6)),
    ]
    chosen = _flag_binding(terms, None)
    assert chosen is terms[2]
    assert [c.is_binding for c in terms] == [False, False, True]


def test_late_window_floor_needs_the_value_to_sit_on_the_early_date() -> None:
    # The pre-floor replay lands below early, but the reported late start is not
    # the early start — so the floor did not produce it and must not be cited.
    task = _task(
        "T",
        2,
        early_start=date(2026, 1, 12),
        early_finish=date(2026, 1, 13),
        late_start=date(2026, 1, 14),
        late_finish=date(2026, 1, 15),
    )
    lf = [DerivationContribution(kind="project_finish", imposed_date=date(2026, 1, 6))]
    assert _late_window_floor_binding(task, lf, [], Calendar(), want_start=True) is None


def test_backward_seed_without_a_finish_instant_is_the_finish_day_itself() -> None:
    lf, ls = _backward_successor_terms([], Calendar(), date(2026, 1, 8))
    assert [c.imposed_date for c in lf] == [date(2026, 1, 8)]
    assert ls == []


def test_free_float_without_early_references_reads_successor_early_dates() -> None:
    a = _scheduled("A", MON, date(2026, 1, 6))
    b = _scheduled("B", date(2026, 1, 9), date(2026, 1, 9))
    ff, contribs = _derive_free_float(a, [(b, DependencyType.FS, timedelta(0))], Calendar(), 5)
    assert ff == 2
    assert [(c.imposed_date, c.slack_days, c.is_binding) for c in contribs] == [
        (date(2026, 1, 8), 2, True)
    ]


def test_cal_for_falls_back_to_the_pass_calendar_for_an_unmapped_task() -> None:
    cal = Calendar()
    assert _cal_for("x", cal, {}) is cal
    assert _cal_for("x", cal, {"x": FOUR}) is FOUR


def _half(tid: str, **dates: date) -> Task:
    return _task(tid, 1, **dates)


_D = date(2026, 1, 6)


@pytest.mark.parametrize(
    "call",
    [
        pytest.param(lambda: _late_dates(_half("S", late_start=_D)), id="late_dates"),
        pytest.param(
            lambda: _pred_forward_contribution(
                _half("P", early_finish=_D), DependencyType.FS, timedelta(0), Calendar()
            ),
            id="pred_forward_contribution",
        ),
        pytest.param(
            lambda: _derive_scheduled_start(_half("T", early_start=_D), Calendar()),
            id="derive_scheduled_start",
        ),
        pytest.param(
            lambda: _derive_total_float(_half("T", early_start=_D), Calendar()),
            id="derive_total_float",
        ),
        pytest.param(
            lambda: _inverse_link_constraint(
                _half("T", early_finish=_D),
                _half("S", early_start=_D, early_finish=_D),
                DependencyType.FS,
                timedelta(0),
                Calendar(),
            ),
            id="inverse_link_constraint_task",
        ),
        pytest.param(
            lambda: _inverse_link_constraint(
                _half("T", early_start=_D, early_finish=_D),
                _half("S", early_start=_D),
                DependencyType.FS,
                timedelta(0),
                Calendar(),
            ),
            id="inverse_link_constraint_successor",
        ),
    ],
)
def test_unscheduled_inputs_are_refused_not_half_derived(call: object) -> None:
    # Each helper requires *both* dates of the pair it reads; one of the two is
    # enough for most branches to run, so a weakened guard would derive from half
    # a schedule instead of refusing it.
    with pytest.raises(AssertionError):
        call()  # type: ignore[operator]


def test_milestone_context_early_refs_refuse_an_unscheduled_successor() -> None:
    project = _project([_task("A", 1)], [])
    result = schedule(project)
    task = result.tasks[0]
    mctx = _milestone_context(project, result, task, [], Calendar(), Calendar())
    with pytest.raises(AssertionError):
        mctx.early_refs(_half("S", early_finish=_D), DependencyType.FS)
