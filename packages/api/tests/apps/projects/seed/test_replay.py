"""Integration tests for the seed v2 event-replay importer (ADR-0114, #1074).

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
    Baseline,
    BaselineTask,
    EstimateStatus,
    Project,
    RetroActionItem,
    Risk,
    ScopeChangeStatus,
    Sprint,
    SprintBurnSnapshot,
    SprintRetro,
    SprintScopeChange,
    SprintState,
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
                    {
                        # Injected mid-sprint then rejected — exercises the
                        # scope_resolve REJECTED path (task drops out of the sprint).
                        "wbs_path": "4",
                        "name": "Telemetry",
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
            # Authored sprint lifecycle — drives the activate/close handlers
            # (the synthesizer is suppressed for sprints the timeline touches).
            {
                "at": "A-20T09:00",
                "actor": "alex",
                "action": "sprint.activate",
                "target": "sprint:core:s1",
            },
            {
                "at": "A-18T12:00",
                "actor": "alex",
                "action": "baseline.capture",
                "target": "project:core",
                "body": "Sprint 1 commitment baseline",
            },
            {
                "at": "A-15T10:00",
                "actor": "alex",
                "action": "task.comment",
                "target": "task:core:1",
                "body": "Auth flow reviewed — looks good.",
            },
            {
                "at": "A-14T09:00",
                "actor": "priya",
                "action": "task.assign",
                "target": "task:core:2",
                "assignee": "alex",
            },
            {
                "at": "A-14T10:00",
                "actor": "priya",
                "action": "task.estimate",
                "target": "task:core:2",
                "estimate": {"optimistic": 2, "most_likely": 3, "pessimistic": 5},
            },
            {
                "at": "A-13T10:00",
                "actor": "priya",
                "action": "task.ac_met",
                "target": "task:core:2",
            },
            {
                "at": "A-12T11:00",
                "actor": "priya",
                "action": "sprint.scope_inject",
                "target": "task:core:3",
                "goal_impact": True,
            },
            {
                "at": "A-11T11:00",
                "actor": "priya",
                "action": "sprint.scope_inject",
                "target": "task:core:4",
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
                "at": "A-9T10:00",
                "actor": "priya",
                "action": "task.points",
                "target": "task:core:2",
                "remaining_points": 2,
            },
            {
                "at": "A-8T11:00",
                "actor": "alex",
                "action": "sprint.scope_resolve",
                "target": "task:core:4",
                "to": "REJECTED",
            },
            {
                "at": "A-6T17:00",
                "actor": "alex",
                "action": "sprint.close",
                "target": "sprint:core:s1",
                "goal_outcome": "PARTIAL",
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


def test_task_assign_event_replayed(program: Any) -> None:
    task = _task(program, "2")
    # The authored reassign moves the task from priya to alex.
    assert task.assignee is not None
    assert task.assignee.username == "demo-alex"


def test_task_estimate_event_replayed(program: Any) -> None:
    task = _task(program, "2")
    assert task.optimistic_duration == 2
    assert task.most_likely_duration == 3
    assert task.pessimistic_duration == 5
    # The estimate event marks the three-point estimate accepted.
    assert str(task.estimate_status) == str(EstimateStatus.ACCEPTED)


def test_task_points_event_replayed(program: Any) -> None:
    task = _task(program, "2")
    # task:core:2 stays IN_PROGRESS (never COMPLETE, which would zero this),
    # so the authored remaining_points survives to the end state.
    assert task.remaining_points == 2


def test_task_ac_met_sets_dor(program: Any) -> None:
    task = _task(program, "2")
    assert task.dor == "ready"


def test_authored_sprint_close_records_goal_outcome(program: Any) -> None:
    sprint = Sprint.objects.get(project__program=program, name="Sprint 1")
    assert str(sprint.state) == str(SprintState.COMPLETED)
    assert sprint.goal_outcome == "PARTIAL"
    assert sprint.activated_at is not None
    assert sprint.closed_at is not None


def test_baseline_capture_creates_baseline_with_tasks(program: Any) -> None:
    project = Project.objects.get(program=program, name="Core")
    baseline = Baseline.objects.get(project=project, name="Sprint 1 commitment baseline")
    # The baseline snapshots the project's tasks at the beat time...
    assert BaselineTask.objects.filter(baseline=baseline).exists()
    # ...and its created_at is backdated, not stamped at import time.
    assert baseline.created_at.date() <= date.fromisoformat(ANCHOR)


def test_scope_resolve_reject_drops_task_from_sprint(program: Any) -> None:
    task = _task(program, "4")
    # A rejected injection removes the task from the sprint and clears pending.
    assert task.sprint is None
    assert task.sprint_pending is False
    change = SprintScopeChange.objects.get(task=task)
    assert str(change.status) == str(ScopeChangeStatus.REJECTED)


def test_replay_is_deterministic(owner: Any) -> None:
    p1 = import_seed(_v2_seed(), owner=owner, create_users=True)
    n1 = _task(p1, "1").history.count()
    # Re-import wipes and rebuilds; the seeded synthesizer must reproduce the
    # same number of history rows.
    p2 = import_seed(_v2_seed(), owner=owner, create_users=True)
    n2 = _task(p2, "1").history.count()
    assert n1 == n2 >= 4


# --- retro.* replay (ADR-0114 §7a / #1109) ---------------------------------


def _retro_seed() -> dict[str, Any]:
    """One completed sprint with two retro action items, one promoted."""
    return {
        "schema_version": "2.0",
        "anchor": ANCHOR,
        "program": {"slug": "retro", "name": "Retro", "methodology": "AGILE", "lead": "alex"},
        "accounts": [
            {"slug": "alex", "username": "retro-alex", "display_name": "Alex", "role": "OWNER"},
            {"slug": "priya", "username": "retro-priya", "display_name": "Priya", "role": "MEMBER"},
        ],
        "projects": [
            {
                "slug": "core",
                "name": "Core",
                "methodology": "AGILE",
                "agile_features": True,
                "start_date": "A-25",
                "sprints": [
                    {
                        "slug": "s1",
                        "name": "Sprint 1",
                        "state": "COMPLETED",
                        "start_date": "A-20",
                        "finish_date": "A-6",
                        "committed_points": 5,
                        "completed_points": 5,
                    }
                ],
                "tasks": [
                    {
                        "wbs_path": "1",
                        "name": "Build auth",
                        "status": "COMPLETE",
                        "story_points": 5,
                        "sprint": "s1",
                        "delivery_mode": "scrum",
                    }
                ],
            }
        ],
        "events": [
            {
                "at": "A-6T17:30",
                "actor": "alex",
                "action": "retro.action",
                "target": "sprint:core:s1",
                "body": "Add integration tests",
                "assignee": "priya",
                "points": 3,
            },
            {
                "at": "A-6T17:35",
                "actor": "alex",
                "action": "retro.action",
                "target": "sprint:core:s1",
                "body": "Document the auth flow",
            },
            {
                "at": "A-5T09:00",
                "actor": "alex",
                "action": "retro.promote",
                "target": "sprint:core:s1",
                "body": "Add integration tests",
            },
        ],
    }


@pytest.fixture
def retro_program(owner: Any) -> Any:
    return import_seed(_retro_seed(), owner=owner, create_users=True)


def test_retro_action_creates_retro_and_items(retro_program: Any) -> None:
    sprint = Sprint.objects.get(project__program=retro_program, name="Sprint 1")
    retro = SprintRetro.objects.get(sprint=sprint)
    items = RetroActionItem.objects.filter(retro=retro).order_by("created_at")
    assert items.count() == 2
    first = items.first()
    assert first is not None
    assert first.text == "Add integration tests"
    assert first.assignee is not None and first.assignee.username == "retro-priya"
    assert first.story_points == 3


def test_retro_action_item_is_backdated(retro_program: Any) -> None:
    sprint = Sprint.objects.get(project__program=retro_program, name="Sprint 1")
    item = RetroActionItem.objects.filter(retro__sprint=sprint).order_by("created_at").first()
    assert item is not None
    assert item.created_at.date() <= date.fromisoformat(ANCHOR)


def test_retro_promote_creates_backlog_task(retro_program: Any) -> None:
    sprint = Sprint.objects.get(project__program=retro_program, name="Sprint 1")
    item = RetroActionItem.objects.get(retro__sprint=sprint, text="Add integration tests")
    # The promoted item links to a real project-backlog task (status BACKLOG,
    # sprint None) — the retro→task loop the demo shows closed.
    assert item.promoted_task_id is not None
    task = Task.objects.get(pk=item.promoted_task_id)
    assert task.status == TaskStatus.BACKLOG
    assert task.sprint_id is None
    assert task.name == "Add integration tests"
    assert task.project_id == sprint.project_id


def test_retro_promote_only_promotes_matching_item(retro_program: Any) -> None:
    sprint = Sprint.objects.get(project__program=retro_program, name="Sprint 1")
    other = RetroActionItem.objects.get(retro__sprint=sprint, text="Document the auth flow")
    assert other.promoted_task_id is None  # only the matched body was promoted


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
