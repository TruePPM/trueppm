"""A real MS-Project-saved SF link, checked against the engine's output (#4322).

Every SF rule the engine implements was read from the docs and then calibrated
against our own engine output, because no sample in the set contained a real
SF link saved by MS Project to check against (``tests/oracle/reference_cpm.py``
module docstring). ``tests/fixtures/msproject/link_types_2013.py`` documents
where this one came from (an InfiniteSkills "all four link types" MS Project
2013 course file, MPXJ-extracted) and why it only covers case 1 of #4322 (SF,
zero lag, ordinary work on both ends) — cases 2-4 are #4327.

Kept in its own file, next to ``test_sf_from_work.py`` and
``test_negative_lag.py``, to stay clear of the large, churning
``test_engine.py``.
"""

from __future__ import annotations

from tests.fixtures.msproject.link_types_2013 import (
    EXPECTED_FINISH,
    EXPECTED_START,
    build_project,
)
from trueppm_scheduler import schedule


def test_sf_zero_lag_ordinary_work_matches_ms_project() -> None:
    """Case 1 (#4322): task 5 -SF(0)-> task 6, ordinary 1-day tasks both ends.

    MS Project finished task 6 at the start of task 5's start day (2013-01-08),
    putting task 6's last working day on 2013-01-07 — the day before. This is
    the SF anchor rule (#4145), now checked against a real external tool's own
    saved schedule rather than only against this engine's prior output.
    """
    result = schedule(build_project())
    by_id = {t.id: t for t in result.tasks}

    task5 = by_id["5"]
    task6 = by_id["6"]

    assert task5.early_start == EXPECTED_START["5"] == task5.early_finish
    assert task6.early_finish == EXPECTED_FINISH["6"]
    assert task6.early_start == EXPECTED_START["6"]
    # Stated as the rule, not just the dates, so a future change to this fixture's
    # calendar or durations can't quietly turn this into a different case.
    assert task6.early_finish < task5.early_start


def test_sf_plus_fs_combination_matches_ms_project() -> None:
    """General SF+FS combinator conformance — NOT a #4319 project-start floor case.

    Task 6 has two predecessors: 4 (FS, zero lag) and 5 (SF, zero lag). MS
    Project's own combined result (task 6 starts 2013-01-07) is consistent with
    both: the FS link requires task 6 to start no earlier than 2013-01-07 (the
    working day after task 4's 2013-01-04 finish), and the SF link pins task 6's
    finish to task 5's 2013-01-08 start, which for a 1-day task also starts it
    on 2013-01-07. Task 6 sits on 2013-01-07/08, far from the project start
    (2013-01-01) — this says nothing about the #4319 mixed-links project-start
    floor, which is a different, still-open question.
    """
    result = schedule(build_project())
    by_id = {t.id: t for t in result.tasks}

    assert by_id["6"].early_start == EXPECTED_START["6"]
    assert by_id["6"].early_finish == EXPECTED_FINISH["6"]


def test_upstream_chain_matches_ms_project_saved_dates() -> None:
    """General conformance for tasks 1-6: FF, FS, SS, and this fixture's own inputs.

    Tasks 1-4 feed task 5 and task 6's dates; checking them against MS
    Project's own saved schedule confirms the inputs to the SF case above are
    what this fixture claims they are, not just that the SF link itself landed
    on the right day.

    Task 7 (the milestone) is deliberately excluded here. It is driven by an
    ordinary FS link out of task 6, not by the SF link this fixture exists to
    test, and the engine shows it one calendar day earlier (end of task 6's
    finish day) than MS Project's own saved Start/Finish (start of the next
    day) — the same midnight, labeled on opposite sides of it. That is a
    milestone *display-day* convention question (#4079, #4173, #4178),
    entirely orthogonal to the SF anchor rule (#4145) this branch verifies,
    and already tracked on its own terms — asserting it here would conflate
    two separate, independently-tracked unresolved questions.
    """
    result = schedule(build_project())
    by_id = {t.id: t for t in result.tasks}

    for task_id in ("1", "2", "3", "4", "5", "6"):
        assert by_id[task_id].early_start == EXPECTED_START[task_id], task_id
        assert by_id[task_id].early_finish == EXPECTED_FINISH[task_id], task_id
