"""Tests for the Sprint retrospective endpoint (issue #231).

`POST /api/v1/sprints/{sprint_id}/retro/` upserts the retro notes and
replaces the action item set. Items flagged with ``promote=true`` are
created as tasks in the next planned sprint (or an explicit target).
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    RetroActionItem,
    Sprint,
    SprintRetro,
    SprintState,
    Task,
)

User = get_user_model()


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def member(project: Project) -> object:
    u = User.objects.create_user(username="member", password="pw")
    ProjectMembership.objects.create(project=project, user=u, role=Role.MEMBER)
    return u


@pytest.fixture
def viewer(project: Project) -> object:
    u = User.objects.create_user(username="viewer", password="pw")
    ProjectMembership.objects.create(project=project, user=u, role=Role.VIEWER)
    return u


@pytest.fixture
def stranger() -> object:
    return User.objects.create_user(username="stranger", password="pw")


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _closed_sprint(project: Project, name: str = "S1") -> Sprint:
    return Sprint.objects.create(
        project=project,
        name=name,
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.COMPLETED,
    )


def _planned_sprint(project: Project, name: str = "Next sprint") -> Sprint:
    return Sprint.objects.create(
        project=project,
        name=name,
        start_date=date(2026, 4, 15),
        finish_date=date(2026, 4, 28),
        state=SprintState.PLANNED,
    )


# ---------------------------------------------------------------------------
# GET
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_get_returns_404_when_no_retro(project: Project, member: object) -> None:
    s = _closed_sprint(project)
    resp = _client(member).get(f"/api/v1/sprints/{s.pk}/retro/")
    assert resp.status_code == 404


@pytest.mark.django_db
def test_get_returns_existing_retro(project: Project, member: object) -> None:
    s = _closed_sprint(project)
    SprintRetro.objects.create(sprint=s, notes="What went well: telemetry stable.")
    resp = _client(member).get(f"/api/v1/sprints/{s.pk}/retro/")
    assert resp.status_code == 200
    assert resp.data["notes"] == "What went well: telemetry stable."
    assert resp.data["action_items"] == []


# ---------------------------------------------------------------------------
# POST — upsert + items
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_post_creates_retro_with_action_items(project: Project, member: object) -> None:
    s = _closed_sprint(project)
    resp = _client(member).post(
        f"/api/v1/sprints/{s.pk}/retro/",
        {
            "notes": "Burndown skewed by scope-add on day 4.",
            "action_items": [
                {"text": "Add scope-add gate to retro template"},
                {"text": "Document burn discrepancy in playbook"},
            ],
        },
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data["notes"].startswith("Burndown skewed")
    assert len(resp.data["action_items"]) == 2
    # No items were promoted — every promoted_task_id is null.
    assert all(item["promoted_task_id"] is None for item in resp.data["action_items"])


@pytest.mark.django_db
def test_post_replaces_existing_action_items(project: Project, member: object) -> None:
    s = _closed_sprint(project)
    retro = SprintRetro.objects.create(sprint=s, notes="old")
    RetroActionItem.objects.create(retro=retro, text="old item")

    resp = _client(member).post(
        f"/api/v1/sprints/{s.pk}/retro/",
        {"notes": "new", "action_items": [{"text": "fresh item"}]},
        format="json",
    )
    assert resp.status_code == 200
    assert SprintRetro.objects.filter(sprint=s).count() == 1
    items = list(retro.action_items.all())
    assert len(items) == 1
    assert items[0].text == "fresh item"


@pytest.mark.django_db
def test_promoted_action_item_creates_task_in_next_planned_sprint(
    project: Project, member: object
) -> None:
    closed = _closed_sprint(project)
    next_sprint = _planned_sprint(project)

    resp = _client(member).post(
        f"/api/v1/sprints/{closed.pk}/retro/",
        {
            "notes": "",
            "action_items": [
                {"text": "Add deploy gate", "promote": True, "story_points": 3},
                {"text": "Talk to QA"},
            ],
        },
        format="json",
    )
    assert resp.status_code == 200
    items = resp.data["action_items"]
    promoted = next(i for i in items if i["text"] == "Add deploy gate")
    assert promoted["promoted_task_id"] is not None
    task = Task.objects.get(pk=promoted["promoted_task_id"])
    assert task.sprint_id == next_sprint.pk
    assert task.story_points == 3


@pytest.mark.django_db
def test_promote_to_explicit_sprint(project: Project, member: object) -> None:
    closed = _closed_sprint(project)
    target = Sprint.objects.create(
        project=project,
        name="Future",
        start_date=date(2026, 5, 1),
        finish_date=date(2026, 5, 14),
        state=SprintState.PLANNED,
    )

    resp = _client(member).post(
        f"/api/v1/sprints/{closed.pk}/retro/",
        {
            "notes": "",
            "promote_to_sprint_id": str(target.pk),
            "action_items": [{"text": "Targeted promotion", "promote": True}],
        },
        format="json",
    )
    assert resp.status_code == 200
    promoted_id = resp.data["action_items"][0]["promoted_task_id"]
    task = Task.objects.get(pk=promoted_id)
    assert task.sprint_id == target.pk


@pytest.mark.django_db
def test_promote_target_must_belong_to_same_project(
    project: Project, calendar: Calendar, member: object
) -> None:
    closed = _closed_sprint(project)
    other_project = Project.objects.create(
        name="Other", start_date=date(2026, 4, 1), calendar=calendar
    )
    foreign = Sprint.objects.create(
        project=other_project,
        name="Foreign",
        start_date=date(2026, 5, 1),
        finish_date=date(2026, 5, 14),
        state=SprintState.PLANNED,
    )

    resp = _client(member).post(
        f"/api/v1/sprints/{closed.pk}/retro/",
        {"notes": "", "promote_to_sprint_id": str(foreign.pk), "action_items": []},
        format="json",
    )
    assert resp.status_code == 400
    assert "promote_to_sprint_id" in resp.data


@pytest.mark.django_db
def test_post_skips_promotion_when_no_planned_sprint_exists(
    project: Project, member: object
) -> None:
    """Without a target sprint the items are still saved — just unpromoted."""
    closed = _closed_sprint(project)
    resp = _client(member).post(
        f"/api/v1/sprints/{closed.pk}/retro/",
        {"notes": "", "action_items": [{"text": "Will be unpromoted", "promote": True}]},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data["action_items"][0]["promoted_task_id"] is None
    assert Task.objects.filter(name="Will be unpromoted").count() == 0


@pytest.mark.django_db
def test_blank_action_item_text_is_dropped(project: Project, member: object) -> None:
    s = _closed_sprint(project)
    resp = _client(member).post(
        f"/api/v1/sprints/{s.pk}/retro/",
        {
            "notes": "ok",
            "action_items": [
                {"text": "kept"},
                {"text": "   "},
                {"text": ""},
            ],
        },
        format="json",
    )
    assert resp.status_code == 200
    assert len(resp.data["action_items"]) == 1
    assert resp.data["action_items"][0]["text"] == "kept"


# ---------------------------------------------------------------------------
# Permissions
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_viewer_can_read_but_not_write(project: Project, viewer: object) -> None:
    s = _closed_sprint(project)
    SprintRetro.objects.create(sprint=s, notes="hi")
    c = _client(viewer)
    assert c.get(f"/api/v1/sprints/{s.pk}/retro/").status_code == 200
    resp = c.post(
        f"/api/v1/sprints/{s.pk}/retro/",
        {"notes": "hijack", "action_items": []},
        format="json",
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_outsider_gets_403(project: Project, stranger: object) -> None:
    s = _closed_sprint(project)
    resp = _client(stranger).get(f"/api/v1/sprints/{s.pk}/retro/")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_unauthenticated_gets_401(project: Project) -> None:
    s = _closed_sprint(project)
    resp = APIClient().get(f"/api/v1/sprints/{s.pk}/retro/")
    assert resp.status_code == 401
