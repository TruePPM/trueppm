"""Integration tests for the seed v2 event-replay importer (ADR-0113, #1074).

These exercise the replay engine end-to-end: a v2 seed with an explicit anchor
(for determinism) is imported and we assert the demo reads as a program that has
*run* — backdated history that traverses every column, real burndown snapshots,
the scope-injection audit row, baseline-vs-actual actuals — and that replay does
not leak a live side effect (no today-dated burndown).
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.projects.models import (
    Project,
    Risk,
    Sprint,
    SprintBurnSnapshot,
    SprintScopeChange,
    Task,
    TaskComment,
    TaskStatus,
)
from trueppm_api.apps.projects.seed import import_seed

pytestmark = pytest.mark.django_db

User = get_user_model()

# Explicit, clearly-past anchor so every resolved date is deterministic and
# safely before "today" regardless of when CI runs.
ANCHOR = "2026-02-01"


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(username="replay-owner", email="o@example.com")


def _v2_seed() -> dict[str, Any]:
    """One agile project, one completed sprint, three tasks at distinct end states."""
    return {
        "schema_version": "2.0",
        "anchor": ANCHOR,
        "program": {"slug": "demo", "name": "Demo", "methodology": "AGILE", "lead": "alex"},
        "accounts": [
            {"slug": "alex", "username": "demo-alex", "display_name": "Alex", "role": "OWNER"},
            {"slug": "priya", "username": "demo-priya", "display_name": "Priya", "role": "MEMBER"},
        ],
        "calendars": [{"slug": "std", "name": "Std 5-day", "working_days": 31}],
        "projects": [
            {
                "slug": "core",
                "name": "Core",
                "methodology": "AGILE",
                "agile_features": True,
                "start_date": "A-25",
                "calendar": "std",
                "sprints": [
                    {
                        "slug": "s1",
                        "name": "Sprint 1",
                        "state": "COMPLETED",
                        "start_date": "A-20",
                        "finish_date": "A-6",
                        "committed_points": 10,
                        "completed_points": 8,
                    }
                ],
                "tasks": [
                    {
                        "wbs_path": "1",
                        "name": "Build auth",
                        "type": "story",
                        "status": "COMPLETE",
                        "story_points": 5,
                        "assignee": "priya",
                        "sprint": "s1",
                        "delivery_mode": "scrum",
                    },
                    {
                        "wbs_path": "2",
                        "name": "Wire login UI",
                        "type": "story",
                        "status": "IN_PROGRESS",
                        "story_points": 3,
                        "assignee": "priya",
                        "sprint": "s1",
                        "delivery_mode": "scrum",
                    },
                    {
                        "wbs_path": "3",
                        "name": "Rate limiting",
                        "type": "story",
                        "status": "NOT_STARTED",
                        "story_points": 2,
                        "sprint": "s1",
                        "delivery_mode": "scrum",
                    },
                ],
                "risks": [
                    {
                        "slug": "r1",
                        "title": "Auth vendor risk",
                        "status": "OPEN",
                        "probability": 4,
                        "impact": 4,
                    }
                ],
            }
        ],
        "events": [
            {
                "at": "A-15T10:00",
                "actor": "alex",
                "action": "task.comment",
                "target": "task:core:1",
                "body": "Auth flow reviewed — looks good.",
            },
            {
                "at": "A-10T09:00",
                "actor": "alex",
                "action": "risk.status",
                "target": "risk:r1",
                "from": "OPEN",
                "to": "MITIGATING",
            },
            {
                "at": "A-12T11:00",
                "actor": "priya",
                "action": "sprint.scope_inject",
                "target": "task:core:3",
                "goal_impact": True,
            },
        ],
    }


@pytest.fixture
def program(owner: Any) -> Any:
    return import_seed(_v2_seed(), owner=owner, create_users=True)


def _task(program: Any, wbs: str) -> Task:
    return Task.objects.get(project__program=program, wbs_path=wbs)


def test_complete_task_traverses_every_column(program: Any) -> None:
    task = _task(program, "1")
    statuses = set(task.history.values_list("status", flat=True))
    # The synthesizer must walk the task through IN_PROGRESS and REVIEW, never
    # NOT_STARTED -> COMPLETE (a hollow burndown — VoC/Alex).
    assert {
        TaskStatus.NOT_STARTED,
        TaskStatus.IN_PROGRESS,
        TaskStatus.REVIEW,
        TaskStatus.COMPLETE,
    } <= statuses
    assert task.status == TaskStatus.COMPLETE  # final live state matches the seed


def test_history_is_backdated_not_import_time(program: Any) -> None:
    task = _task(program, "1")
    dates = {h.history_date.date() for h in task.history.all()}
    assert len(dates) >= 2  # a progression over time, not one instant
    assert max(dates) <= date.fromisoformat(ANCHOR)  # all before "today" (the anchor)


def test_history_attributed_to_named_people(program: Any) -> None:
    task = _task(program, "1")
    # The assignee (priya) drives the synthesized progression; the authored
    # comment is by alex. At least one row is attributed to a real persona user.
    users = {h.history_user_id for h in task.history.all() if h.history_user_id}
    assert users  # not a single anonymous importer


def test_burndown_is_real_multi_day_history(program: Any) -> None:
    sprint = Sprint.objects.get(project__program=program, name="Sprint 1")
    snaps = SprintBurnSnapshot.objects.filter(sprint=sprint)
    assert snaps.count() >= 2  # a curve, not a single fabricated point
    assert max(s.snapshot_date for s in snaps) <= date.fromisoformat(ANCHOR)


def test_no_today_dated_burndown_leak(program: Any) -> None:
    # If the live task_status_changed receiver were not suppressed during replay
    # it would stamp a snapshot dated today; assert none leaked.
    assert not SprintBurnSnapshot.objects.filter(snapshot_date=date.today()).exists()


def test_relative_dates_resolved_against_anchor(program: Any) -> None:
    project = Project.objects.get(program=program, name="Core")
    # A-25 from 2026-02-01 = 2026-01-07 (a Wednesday, working day, no snap).
    assert project.start_date == date(2026, 1, 7)


def test_risk_status_event_replayed(program: Any) -> None:
    risk = Risk.objects.get(project__program=program, title="Auth vendor risk")
    assert risk.status == "MITIGATING"
    assert "MITIGATING" in set(risk.history.values_list("status", flat=True))


def test_scope_injection_writes_audit_row(program: Any) -> None:
    task = _task(program, "3")
    assert SprintScopeChange.objects.filter(task=task).exists()
    assert task.sprint_pending is True


def test_completed_task_has_actuals_for_variance(program: Any) -> None:
    task = _task(program, "1")
    assert task.actual_start is not None
    assert task.actual_finish is not None


def test_comment_is_backdated(program: Any) -> None:
    task = _task(program, "1")
    comment = TaskComment.objects.get(task=task)
    assert comment.created_at.date() <= date.fromisoformat(ANCHOR)


def test_replay_is_deterministic(owner: Any) -> None:
    p1 = import_seed(_v2_seed(), owner=owner, create_users=True)
    n1 = _task(p1, "1").history.count()
    # Re-import wipes and rebuilds; the seeded synthesizer must reproduce the
    # same number of history rows.
    p2 = import_seed(_v2_seed(), owner=owner, create_users=True)
    n2 = _task(p2, "1").history.count()
    assert n1 == n2 >= 4


def test_v1_seed_has_no_replay(owner: Any) -> None:
    """A v1 document still materializes final state with a single creation row."""
    v1 = {
        "schema_version": "1.0",
        "program": {"slug": "v1demo", "name": "V1", "methodology": "AGILE"},
        "projects": [
            {
                "slug": "core",
                "name": "Core",
                "methodology": "AGILE",
                "start_date": "2026-01-05",
                "tasks": [{"wbs_path": "1", "name": "Done thing", "status": "COMPLETE"}],
            }
        ],
    }
    program = import_seed(v1, owner=owner, create_users=True)
    task = _task(program, "1")
    assert task.status == TaskStatus.COMPLETE
    assert task.history.count() == 1  # no backdated progression
