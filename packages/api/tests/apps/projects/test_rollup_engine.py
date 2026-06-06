"""Rollup engine — delivery-mode-aware parent percent_complete (ADR-0108 §1/§4, #408).

Phase 1: the summary percent_complete a parent reports is a delivery-mode-aware
weighted average of its leaf descendants (waterfall=duration-weighted explicit %,
scrum=story-point burndown, kanban=item throughput, milestone=zero-weight gate),
computed on read; and a manual write to a summary task's percent_complete is
rejected (the value is computed, not stored).
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Baseline,
    BaselineTask,
    Calendar,
    DeliveryMode,
    Project,
    Task,
    TaskStatus,
)

User = get_user_model()


@pytest.fixture
def owner(db: object) -> object:
    return User.objects.create_user(username="po", password="pw")


@pytest.fixture
def project(owner: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    p = Project.objects.create(name="Artemis", start_date=date(2026, 1, 1), calendar=cal)
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    return p


@pytest.fixture
def client(owner: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=owner)
    return c


def _task(project: Project, wbs_path: str, **kwargs: object) -> Task:
    kwargs.setdefault("name", f"T{wbs_path}")
    return Task.objects.create(project=project, wbs_path=wbs_path, **kwargs)


def _rollup(client: APIClient, task: Task) -> float | None:
    resp = client.get(f"/api/v1/tasks/{task.pk}/")
    assert resp.status_code == 200, resp.data
    return resp.data["percent_complete"]


# ---------------------------------------------------------------------------
# Delivery-mode-aware percent rollup
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_single_waterfall_child(client: APIClient, project: Project) -> None:
    parent = _task(project, "1")
    _task(project, "1.1", duration=5, percent_complete=60.0, status=TaskStatus.IN_PROGRESS)
    assert _rollup(client, parent) == 60.0


@pytest.mark.django_db
def test_multi_waterfall_children_duration_weighted(client: APIClient, project: Project) -> None:
    parent = _task(project, "1")
    _task(project, "1.1", duration=2, percent_complete=100.0, status=TaskStatus.IN_PROGRESS)
    _task(project, "1.2", duration=8, percent_complete=0.0, status=TaskStatus.NOT_STARTED)
    # (2*100 + 8*0) / 10 = 20
    assert _rollup(client, parent) == 20.0


@pytest.mark.django_db
def test_scrum_child_rolls_up_story_point_burndown(client: APIClient, project: Project) -> None:
    parent = _task(project, "1")
    # remaining 5 of 10 committed → 50% burned down, weight = story_points (10)
    _task(
        project,
        "1.1",
        delivery_mode=DeliveryMode.SCRUM,
        story_points=10,
        remaining_points=5,
        status=TaskStatus.IN_PROGRESS,
    )
    assert _rollup(client, parent) == 50.0


@pytest.mark.django_db
def test_mixed_scrum_and_waterfall(client: APIClient, project: Project) -> None:
    parent = _task(project, "1")
    # scrum: pct 50, weight 10 (story_points)
    _task(
        project,
        "1.1",
        delivery_mode=DeliveryMode.SCRUM,
        story_points=10,
        remaining_points=5,
        status=TaskStatus.IN_PROGRESS,
    )
    # waterfall: pct 80, weight 10 (duration)
    _task(project, "1.2", duration=10, percent_complete=80.0, status=TaskStatus.IN_PROGRESS)
    # (10*50 + 10*80) / 20 = 65
    assert _rollup(client, parent) == 65.0


@pytest.mark.django_db
def test_kanban_children_roll_up_as_throughput(client: APIClient, project: Project) -> None:
    parent = _task(project, "1")
    # done/total: 2 COMPLETE, 2 not → 50%, each weight 1
    _task(project, "1.1", delivery_mode=DeliveryMode.KANBAN, status=TaskStatus.COMPLETE)
    _task(project, "1.2", delivery_mode=DeliveryMode.KANBAN, status=TaskStatus.COMPLETE)
    _task(project, "1.3", delivery_mode=DeliveryMode.KANBAN, status=TaskStatus.IN_PROGRESS)
    _task(project, "1.4", delivery_mode=DeliveryMode.KANBAN, status=TaskStatus.NOT_STARTED)
    assert _rollup(client, parent) == 50.0


@pytest.mark.django_db
def test_milestone_leaf_has_zero_weight(client: APIClient, project: Project) -> None:
    parent = _task(project, "1")
    _task(project, "1.1", duration=5, percent_complete=40.0, status=TaskStatus.IN_PROGRESS)
    # a zero-work milestone gate must not dilute the phase percent (weight 0)
    _task(
        project,
        "1.2",
        delivery_mode=DeliveryMode.MILESTONE,
        duration=0,
        status=TaskStatus.NOT_STARTED,
    )
    assert _rollup(client, parent) == 40.0


@pytest.mark.django_db
def test_leaf_task_keeps_its_own_percent(client: APIClient, project: Project) -> None:
    # No children → annotation is NULL → the stored value is reported unchanged.
    leaf = _task(project, "5", duration=3, percent_complete=42.0, status=TaskStatus.IN_PROGRESS)
    assert _rollup(client, leaf) == 42.0


@pytest.mark.django_db
def test_three_level_grandparent_rolls_up_over_leaves(client: APIClient, project: Project) -> None:
    grandparent = _task(project, "1")
    _task(project, "1.1")  # intermediate summary, no stored percent
    _task(project, "1.1.1", duration=1, percent_complete=100.0, status=TaskStatus.IN_PROGRESS)
    _task(project, "1.1.2", duration=1, percent_complete=0.0, status=TaskStatus.NOT_STARTED)
    # grandparent must read the leaves, not the (unpersisted) intermediate summary → 50
    assert _rollup(client, grandparent) == 50.0


# ---------------------------------------------------------------------------
# §4 — summary percent_complete is read-only
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_summary_percent_write_is_rejected(client: APIClient, project: Project) -> None:
    parent = _task(project, "1")
    _task(project, "1.1", duration=5, percent_complete=10.0, status=TaskStatus.IN_PROGRESS)
    resp = client.patch(f"/api/v1/tasks/{parent.pk}/", {"percent_complete": 90.0}, format="json")
    assert resp.status_code == 400
    assert "percent_complete" in resp.data


@pytest.mark.django_db
def test_leaf_percent_write_is_allowed(client: APIClient, project: Project) -> None:
    leaf = _task(
        project, "1", duration=5, planned_start=date(2026, 1, 5), status=TaskStatus.IN_PROGRESS
    )
    resp = client.patch(f"/api/v1/tasks/{leaf.pk}/", {"percent_complete": 30.0}, format="json")
    assert resp.status_code == 200
    leaf.refresh_from_db()
    assert leaf.percent_complete == 30.0


# ---------------------------------------------------------------------------
# §3 — scope rollup + delta
# ---------------------------------------------------------------------------


def _scope(client: APIClient, task: Task) -> dict[str, object]:
    resp = client.get(f"/api/v1/tasks/{task.pk}/scope/")
    assert resp.status_code == 200, resp.data
    return resp.data


@pytest.mark.django_db
def test_scope_sums_leaf_story_points_no_baseline(client: APIClient, project: Project) -> None:
    parent = _task(project, "1")
    _task(project, "1.1", story_points=5)
    _task(project, "1.2", story_points=8)
    body = _scope(client, parent)
    assert body["current_scope"] == 13
    # No active baseline → delta is null (not a misleading 0), and the UI can tell.
    assert body["has_baseline"] is False
    assert body["baselined_scope"] is None
    assert body["scope_delta"] is None


@pytest.mark.django_db
def test_scope_delta_against_active_baseline(client: APIClient, project: Project) -> None:
    parent = _task(project, "1")
    leaf_a = _task(project, "1.1", story_points=5)
    leaf_b = _task(project, "1.2", story_points=8)
    baseline = Baseline.objects.create(project=project, name="B1", is_active=True)
    BaselineTask.objects.create(
        baseline=baseline, task_id=leaf_a.pk, task_name="1.1", duration=1, story_points=5
    )
    BaselineTask.objects.create(
        baseline=baseline, task_id=leaf_b.pk, task_name="1.2", duration=1, story_points=8
    )
    # Scope grows: bump leaf A from 5 → 20 (current 28 vs baselined 13).
    leaf_a.story_points = 20
    leaf_a.save(update_fields=["story_points"])

    body = _scope(client, parent)
    assert body["current_scope"] == 28
    assert body["baselined_scope"] == 13
    assert body["scope_delta"] == 15
    assert body["has_baseline"] is True


@pytest.mark.django_db
def test_scope_leaf_task_uses_own_points(client: APIClient, project: Project) -> None:
    leaf = _task(project, "5", story_points=7)
    assert _scope(client, leaf)["current_scope"] == 7


@pytest.mark.django_db
def test_scope_zero_when_no_points(client: APIClient, project: Project) -> None:
    parent = _task(project, "1")
    _task(project, "1.1")  # no story_points
    _task(project, "1.2")
    assert _scope(client, parent)["current_scope"] == 0


@pytest.mark.django_db
def test_baseline_snapshot_captures_story_points(client: APIClient, project: Project) -> None:
    _task(project, "1", story_points=13, status=TaskStatus.IN_PROGRESS)
    resp = client.post(f"/api/v1/projects/{project.pk}/baselines/", {"name": "B1"}, format="json")
    assert resp.status_code == 201, resp.data
    bt = BaselineTask.objects.get(baseline_id=resp.data["id"])
    assert bt.story_points == 13
