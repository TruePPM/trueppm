"""Tests for the daily standup walk-the-board surface (ADR-0166, #1278).

Covers the per-assignee bucketing (done / in-progress / blockers), the
**calendar-aware** "done since the last working day" window (a Monday standup must
include Friday's completions, and carried already-complete cards are excluded), the
aging flag (per-column threshold falling back to the #992 3-day policy), the
``blocked_reason`` non-leak privacy guarantee, the honest-empty payloads (no active
sprint / continuous cadence), and the membership RBAC boundary.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    BoardCadence,
    BoardColumnConfig,
    Calendar,
    Project,
    Sprint,
    SprintState,
    Task,
    TaskStatus,
)
from trueppm_api.apps.projects.standup import standup_walk

User = get_user_model()
pytestmark = pytest.mark.django_db


# --------------------------------------------------------------------------- #
# Fixtures / helpers
# --------------------------------------------------------------------------- #


@pytest.fixture
def project(db: object) -> Project:
    # Default Calendar.working_days = 31 (Mon–Fri); board_cadence defaults to SPRINT.
    calendar = Calendar.objects.create(name="Std")
    return Project.objects.create(name="Proj", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="Sprint 1",
        goal="Ship the checkout redesign",
        start_date=date(2026, 6, 1),
        finish_date=date(2026, 6, 14),
        state=SprintState.ACTIVE,
        activated_at=timezone.make_aware(datetime(2026, 6, 1, 9, 0)),
    )


def _member(project: Project, username: str, role: int) -> Any:
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    return user


@pytest.fixture
def dev(project: Project) -> Any:
    return _member(project, "dev", Role.MEMBER)


@pytest.fixture
def viewer(project: Project) -> Any:
    return _member(project, "viewer", Role.VIEWER)


@pytest.fixture
def outsider(db: object) -> Any:
    return User.objects.create_user(username="outsider", password="pw")


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/standup/"


def _task(
    project: Project,
    sprint: Sprint,
    name: str,
    *,
    status: str = TaskStatus.IN_PROGRESS,
    assignee: Any = None,
    blocked_reason: str = "",
    blocker_type: str = "",
) -> Task:
    return Task.objects.create(
        project=project,
        name=name,
        duration=1,
        sprint=sprint,
        status=status,
        assignee=assignee,
        blocked_reason=blocked_reason,
        blocker_type=blocker_type,
    )


def _complete_at(task: Task, when: datetime) -> None:
    """Transition ``task`` to COMPLETE and stamp the resulting history row at ``when``."""
    task.status = TaskStatus.COMPLETE
    task.save()
    record = task.history.latest()  # type: ignore[attr-defined]
    record.history_date = when
    record.save()


def _freeze_now(monkeypatch: pytest.MonkeyPatch, when: datetime) -> None:
    monkeypatch.setattr(timezone, "now", lambda: when)


# --------------------------------------------------------------------------- #
# Bucketing + ordering
# --------------------------------------------------------------------------- #


def test_walk_groups_by_assignee_with_three_buckets(
    project: Project, sprint: Sprint, dev: Any
) -> None:
    bea = _member(project, "bea", Role.MEMBER)
    _task(project, sprint, "In flight", status=TaskStatus.IN_PROGRESS, assignee=dev)
    _task(
        project,
        sprint,
        "Stuck",
        status=TaskStatus.IN_PROGRESS,
        assignee=bea,
        blocked_reason="waiting on vendor",
        blocker_type="vendor",
    )

    walk = standup_walk(project)

    assert walk["active"] is True
    assert walk["sprint"]["goal"] == "Ship the checkout redesign"
    # Ordered by name: bea before dev.
    names = [(b["assignee"] or {}).get("name") for b in walk["walk"]]
    assert names == ["bea", "dev"]
    bea_bucket = walk["walk"][0]
    assert [c["name"] for c in bea_bucket["blockers"]] == ["Stuck"]
    assert bea_bucket["in_progress"] == []
    dev_bucket = walk["walk"][1]
    assert [c["name"] for c in dev_bucket["in_progress"]] == ["In flight"]


def test_unassigned_bucket_is_last(project: Project, sprint: Sprint, dev: Any) -> None:
    _task(project, sprint, "Owned", status=TaskStatus.IN_PROGRESS, assignee=dev)
    _task(project, sprint, "Orphan", status=TaskStatus.IN_PROGRESS, assignee=None)

    walk = standup_walk(project)

    assert walk["walk"][-1]["assignee"] is None
    assert [c["name"] for c in walk["walk"][-1]["in_progress"]] == ["Orphan"]


# --------------------------------------------------------------------------- #
# Calendar-aware "done since last working day"
# --------------------------------------------------------------------------- #


def test_done_window_is_calendar_aware_monday_includes_friday(
    project: Project, sprint: Sprint, dev: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monday = timezone.make_aware(datetime(2026, 6, 15, 9, 0))
    assert monday.weekday() == 0  # self-documenting: the standup runs on a Monday

    friday_done = _task(
        project, sprint, "Friday finish", status=TaskStatus.NOT_STARTED, assignee=dev
    )
    _complete_at(friday_done, timezone.make_aware(datetime(2026, 6, 12, 10, 0)))  # prior Friday

    thursday_done = _task(
        project, sprint, "Thursday finish", status=TaskStatus.NOT_STARTED, assignee=dev
    )
    _complete_at(thursday_done, timezone.make_aware(datetime(2026, 6, 11, 10, 0)))  # before window

    _freeze_now(monkeypatch, monday)
    walk = standup_walk(project)

    # window_since is Friday 00:00 (skipping Sat/Sun), so Friday's completion is in.
    assert walk["window_since"] == timezone.make_aware(datetime(2026, 6, 12, 0, 0)).isoformat()
    done = [c["name"] for b in walk["walk"] for c in b["done"]]
    assert "Friday finish" in done
    assert "Thursday finish" not in done


def test_carried_complete_card_excluded_from_done(
    project: Project, sprint: Sprint, dev: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monday = timezone.make_aware(datetime(2026, 6, 15, 9, 0))
    carried = _task(project, sprint, "Carried", status=TaskStatus.NOT_STARTED, assignee=dev)
    # Completed in a prior standup (before the window)...
    _complete_at(carried, timezone.make_aware(datetime(2026, 6, 8, 10, 0)))
    # ...then re-saved this morning (a COMPLETE row inside the window) — must NOT
    # resurface as "done" because it was already complete before the window.
    carried.name = "Carried (edited)"
    carried.save()
    record = carried.history.latest()  # type: ignore[attr-defined]
    record.history_date = monday
    record.save()

    _freeze_now(monkeypatch, monday)
    walk = standup_walk(project)

    done = [c["name"] for b in walk["walk"] for c in b["done"]]
    assert done == []


# --------------------------------------------------------------------------- #
# Blocker privacy + aging
# --------------------------------------------------------------------------- #


def test_blocker_bucket_never_serializes_reason(project: Project, sprint: Sprint, dev: Any) -> None:
    _task(
        project,
        sprint,
        "Blocked card",
        status=TaskStatus.IN_PROGRESS,
        assignee=dev,
        blocked_reason="secret internal reason",
        blocker_type="dependency",
    )

    walk = standup_walk(project)
    card = walk["walk"][0]["blockers"][0]

    assert card["blocker_type"] == "dependency"
    assert card["blocked_since"] is not None  # stamped on the empty->non-empty transition
    assert "blocked_reason" not in card
    # The private reason text must not appear anywhere in the payload.
    assert "secret internal reason" not in str(walk)


def test_aging_flag_uses_dwell_threshold(project: Project, sprint: Sprint, dev: Any) -> None:
    stale = _task(project, sprint, "Stale", status=TaskStatus.IN_PROGRESS, assignee=dev)
    _task(project, sprint, "Fresh", status=TaskStatus.IN_PROGRESS, assignee=dev)
    # Backdate the stale card's column entry past the default 3-day threshold via
    # .update() so save() does not re-stamp status_changed_at.
    Task.objects.filter(pk=stale.pk).update(
        status_changed_at=timezone.now() - timezone.timedelta(days=8)
    )

    walk = standup_walk(project)
    by_name = {c["name"]: c for b in walk["walk"] for c in b["in_progress"]}

    assert by_name["Stale"]["aging"] is True
    assert by_name["Stale"]["dwell_days"] >= 8
    assert by_name["Fresh"]["aging"] is False


def test_aging_respects_configured_column_threshold(
    project: Project, sprint: Sprint, dev: Any
) -> None:
    # A generous per-column override (#410) suppresses the default 3-day aging.
    BoardColumnConfig.objects.create(
        project=project,
        columns=[{"status": "IN_PROGRESS", "label": "In progress", "age_threshold_days": 30}],
    )
    task = _task(project, sprint, "Old but tolerated", status=TaskStatus.IN_PROGRESS, assignee=dev)
    Task.objects.filter(pk=task.pk).update(
        status_changed_at=timezone.now() - timezone.timedelta(days=8)
    )

    walk = standup_walk(project)
    card = walk["walk"][0]["in_progress"][0]
    assert card["aging"] is False  # 8 days < 30-day configured threshold


# --------------------------------------------------------------------------- #
# Honest-empty payloads
# --------------------------------------------------------------------------- #


def test_no_active_sprint_returns_honest_empty(project: Project) -> None:
    walk = standup_walk(project)
    assert walk["active"] is False
    assert walk["reason"] == "no_active_sprint"
    assert walk["sprint"] is None
    assert walk["walk"] == []


def test_continuous_cadence_returns_honest_empty(project: Project, sprint: Sprint) -> None:
    project.board_cadence = BoardCadence.CONTINUOUS
    project.save(update_fields=["board_cadence"])

    walk = standup_walk(project)
    assert walk["active"] is False
    assert walk["reason"] == "continuous_cadence"


# --------------------------------------------------------------------------- #
# RBAC boundary (Morgan's constraint: membership IS the boundary)
# --------------------------------------------------------------------------- #


def test_member_reads_standup(project: Project, sprint: Sprint, viewer: Any) -> None:
    resp = _client(viewer).get(_url(project))
    assert resp.status_code == 200
    assert resp.json()["active"] is True


def test_nonmember_is_forbidden(project: Project, sprint: Sprint, outsider: Any) -> None:
    resp = _client(outsider).get(_url(project))
    assert resp.status_code == 403
