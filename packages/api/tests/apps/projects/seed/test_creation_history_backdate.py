"""Creation-history backdating for the seed importer (ADR-0114, #3487).

Before this fix ``_build_task`` returned ``created_on = sprint.start_date or
planned_start or project.start_date`` — a *plan* position, not a record of when
the task came into being. Any task planned or sprinted after the import anchor
therefore got a ``+`` history row dated in the future (56 rows across the five
bundled samples on a fresh load, per #3487).

The fix backdates to a *planning beat* instead — the project's earliest
declared baseline capture (or its start date), and for a sprint-bound task a
few days before the sprint kicks off — then clamps to two floors/ceilings so
the result stays internally consistent: never later than any authored event
against the same task (a comment predating the plan still gets an
earlier-still creation row), and never later than the import anchor itself.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.projects.models import Task, TaskComment
from trueppm_api.apps.projects.seed import import_seed

pytestmark = pytest.mark.django_db

User = get_user_model()

# Explicit, clearly-past anchor so every resolved date is deterministic
# regardless of when CI runs (mirrors test_replay.py's convention).
ANCHOR = date(2026, 2, 1)
_ANCHOR_ISO = ANCHOR.isoformat()


def _seed() -> dict[str, Any]:
    return {
        "schema_version": "2.0",
        "anchor": _ANCHOR_ISO,
        "program": {"slug": "beat-demo", "name": "Beat Demo", "methodology": "HYBRID"},
        "accounts": [
            {"slug": "alex", "username": "beat-alex", "display_name": "Alex", "role": "OWNER"},
        ],
        "projects": [
            {
                # No declared baseline: the fallback is the project's own start.
                "slug": "sched",
                "name": "Scheduled work",
                "methodology": "WATERFALL",
                "start_date": "A-10",
                "tasks": [
                    {
                        # Planned 60 days out — the exact shape of #3487: before
                        # the fix this task's creation row landed on A+60.
                        "wbs_path": "1",
                        "name": "Far-future milestone prep",
                        "planned_start": "A+60!",
                    },
                ],
            },
            {
                # Declares a baseline captured well before the project's own
                # start date, and mixes a sprint-bound task with an authored
                # comment that predates the sprint by a wide margin.
                "slug": "planned",
                "name": "Planned work",
                "methodology": "HYBRID",
                "start_date": "A-10!",
                "sprints": [
                    {
                        "slug": "future",
                        "name": "Future sprint",
                        "state": "PLANNED",
                        "start_date": "A+60",
                        "finish_date": "A+74",
                    },
                    {
                        "slug": "near",
                        "name": "Near sprint",
                        "state": "PLANNED",
                        "start_date": "A-5",
                        "finish_date": "A+9",
                    },
                ],
                "baselines": [
                    {
                        "name": "Kickoff baseline",
                        "captured_at": "A-70",
                        "tasks": [{"task": "4", "start": "A-10", "finish": "A-5"}],
                    },
                ],
                "tasks": [
                    {
                        # Sprinted far in the future — creation must clamp to
                        # the anchor, never to (sprint_start - a few days).
                        "wbs_path": "2",
                        "name": "Future sprint story",
                        "type": "story",
                        "sprint": "future",
                        "delivery_mode": "scrum",
                    },
                    {
                        # Sprinted close to the anchor, but a comment on this
                        # exact task is authored 40 days before that — the
                        # creation row must precede the comment, not just the
                        # sprint's own backdated planning beat.
                        "wbs_path": "3",
                        "name": "Discussed-early story",
                        "type": "story",
                        "sprint": "near",
                        "delivery_mode": "scrum",
                    },
                    {
                        # No sprint, no planned_start: falls back to the
                        # project's earliest declared baseline capture, not to
                        # the (later) project start date.
                        "wbs_path": "4",
                        "name": "Baseline-anchored task",
                    },
                ],
            },
        ],
        "events": [
            {
                "at": "A-40T09:00",
                "actor": "alex",
                "action": "task.comment",
                "target": "task:planned:3",
                "body": "Flagging this early — it's going to be tight.",
            },
        ],
    }


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(username="beat-owner", email="beat@example.com")


@pytest.fixture
def program(owner: Any) -> Any:
    return import_seed(_seed(), owner=owner, create_users=True)


def _creation_date(task: Task) -> date:
    row = task.history.filter(history_type="+").order_by("history_date").first()
    assert row is not None, f"task {task.wbs_path} has no creation history row"
    result: date = row.history_date.date()
    return result


def test_far_future_planned_start_does_not_backdate_to_the_future(program: Any) -> None:
    """Acceptance bullet 1 & 3: a task planned 60 days out is not created in the future."""
    task = Task.objects.get(project__program=program, wbs_path="1")
    created = _creation_date(task)
    assert created <= ANCHOR, f"creation row is future-dated: {created} > anchor {ANCHOR}"
    # Demonstrates the fix, not just the clamp: the naive planned_start-derived
    # date (ANCHOR + 60 days) would have failed the assertion above outright.
    assert created < ANCHOR + timedelta(days=60)


def test_future_sprint_clamps_creation_to_the_anchor(program: Any) -> None:
    """A sprint kicking off 60 days out still clamps creation to "today"."""
    task = Task.objects.get(project__program=program, wbs_path="2")
    created = _creation_date(task)
    assert created == ANCHOR


def test_creation_precedes_an_early_comment_on_the_same_task(program: Any) -> None:
    """Acceptance bullet 2: the creation row precedes every comment on the task.

    The task's sprint starts only ~5 days before the anchor, so a sprint-only
    planning beat would still land after the comment authored 40 days out —
    exactly the class of miss the issue calls out as most likely to slip
    through a clamp that only bounds the upper end.
    """
    task = Task.objects.get(project__program=program, wbs_path="3")
    created = _creation_date(task)
    comment = TaskComment.objects.get(task=task)
    assert created <= comment.created_at.date()
    assert created == ANCHOR - timedelta(days=40)


def test_non_sprint_task_prefers_baseline_capture_over_project_start(program: Any) -> None:
    """Bullet 3's fix detail: baseline capture wins over the (later) project start."""
    task = Task.objects.get(project__program=program, wbs_path="4")
    created = _creation_date(task)
    assert created == ANCHOR - timedelta(days=70)


def test_reimport_reproduces_the_same_creation_dates(owner: Any) -> None:
    """Determinism: no wall-clock or unseeded randomness in the backdating.

    A second owner importing the identical document must land on exactly the
    same creation dates as the first — the sprint-lead jitter is derived from a
    stable hash of the task's own key, never ``random`` or ``datetime.now()``.
    """
    first = import_seed(_seed(), owner=owner, create_users=True)
    second_owner = User.objects.create_user(username="beat-owner-2", email="beat2@example.com")
    second = import_seed(_seed(), owner=second_owner, create_users=True)

    a1 = Task.objects.get(project__program=first, project__name="Scheduled work", wbs_path="1")
    b1 = Task.objects.get(project__program=second, project__name="Scheduled work", wbs_path="1")
    assert _creation_date(a1) == _creation_date(b1)

    for wbs in ("2", "3", "4"):
        a = Task.objects.get(project__program=first, project__name="Planned work", wbs_path=wbs)
        b = Task.objects.get(project__program=second, project__name="Planned work", wbs_path=wbs)
        assert _creation_date(a) == _creation_date(b)
