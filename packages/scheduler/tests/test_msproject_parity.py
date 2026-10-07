"""Known-answer parity with dates MS Project itself computed and saved (#4323).

Every other oracle in this suite checks the engines against the *documented*
rules (``README.md``, the website's Scheduler Conventions page) or against
``tests/oracle/reference_cpm.py``, which was partly calibrated against engine
output (see that module's docstring). None of them compares ``schedule()``
against a project MS Project actually scheduled and a user actually saved.
This module closes that gap with two real-world ``.mpp`` samples, extracted via
MPXJ (not run through MS Project by us) into
``tests/fixtures/msproject/*.json``. See each fixture's ``_source`` header for
provenance.

* ``advanced_analytics.json`` — a 29-leaf-task all-FS-zero-lag chain from the
  public Microsoft "Advanced Analytics" sample, including all 10 zero-duration
  milestones. This is the milestone reference: MS Project saved every one of
  them at 17:00 on its predecessor's finish day, which is exactly the
  "milestone follows work, shown at the end of its predecessor's finish day"
  display rule documented on :class:`trueppm_scheduler.engine.ScheduleResult`
  (``milestone_at_day_end=True``).
* ``linktypes_ff_ss.json`` — the zero-lag FF and zero-lag SS slice of
  InfiniteSkills' ``LinkTypes.mpp`` teaching file, the first known whole-day
  FF/SS sample for this issue (the SF relation in the same source file is
  #4322/#4327's fixture, not this one's).

Both fixtures were checked against ``schedule()`` while writing this test and
matched every saved Start/Finish at day level with no mismatches — see the
issue for the full comparison. Nothing here forces a result to pass or edits
engine semantics; if a future engine change breaks one of these, that is a
real regression against ground truth, not a snapshot to update.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest

from trueppm_scheduler import Project, schedule

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "msproject"


def _fixture_names() -> list[str]:
    return sorted(p.stem for p in FIXTURES_DIR.glob("*.json"))


_FIXTURES = _fixture_names()
assert _FIXTURES, (
    f"No *.json fixtures found in {FIXTURES_DIR} — the MS Project known-answer "
    "parity suite would vanish with a green run."
)


@pytest.mark.parametrize("fixture_name", _FIXTURES, ids=_FIXTURES)
def test_known_answer_parity(fixture_name: str) -> None:
    """``schedule()`` reproduces every Start/Finish MS Project saved, at day level."""
    with open(FIXTURES_DIR / f"{fixture_name}.json") as f:
        doc = json.load(f)

    project = Project.from_dict(doc["project"])
    result = schedule(project)
    by_id = {t.id: t for t in result.tasks}

    for task_id, expected in doc["expected"].items():
        assert task_id in by_id, f"{fixture_name}: fixture references unknown task {task_id!r}"
        task = by_id[task_id]
        exp_start = date.fromisoformat(expected["early_start"])
        exp_finish = date.fromisoformat(expected["early_finish"])
        assert task.early_start == exp_start, (
            f"{fixture_name}: task {task_id} ({task.name!r}) early_start "
            f"{task.early_start} != MS Project's saved {exp_start}"
        )
        assert task.early_finish == exp_finish, (
            f"{fixture_name}: task {task_id} ({task.name!r}) early_finish "
            f"{task.early_finish} != MS Project's saved {exp_finish}"
        )
        if expected.get("milestone"):
            assert task.duration.total_seconds() == 0, (
                f"{fixture_name}: task {task_id} is marked a milestone in the fixture "
                "but has a nonzero duration"
            )
            expected_day_end = expected.get("milestone_at_day_end", False)
            assert task.milestone_at_day_end == expected_day_end, (
                f"{fixture_name}: milestone {task_id} ({task.name!r}) "
                f"milestone_at_day_end={task.milestone_at_day_end} != expected "
                f"{expected_day_end} (the 'milestone follows work, shown at the "
                "end of its predecessor's finish day' display rule)"
            )


def test_advanced_analytics_has_ten_milestones() -> None:
    """Guards the fixture itself: the issue's milestone count (10) must hold.

    A future edit to the fixture that drops or adds a milestone row should fail
    loudly here rather than silently shrinking what the "10 milestones" claim in
    the module docstring and the issue actually covers.
    """
    with open(FIXTURES_DIR / "advanced_analytics.json") as f:
        doc = json.load(f)
    milestone_count = sum(1 for t in doc["expected"].values() if t.get("milestone"))
    assert milestone_count == 10
    all_day_end = all(
        t.get("milestone_at_day_end") is True
        for t in doc["expected"].values()
        if t.get("milestone")
    )
    assert all_day_end, "every Advanced Analytics milestone follows work and must be day-end"
