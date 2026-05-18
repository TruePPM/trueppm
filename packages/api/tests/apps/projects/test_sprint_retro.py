"""Tests for the Sprint retrospective endpoint (issue #486 / ADR-0071).

Behaviour changes from the original #231 retro endpoint:
- POST no longer auto-promotes action items. ``promote=true`` on items is
  silently ignored. The new explicit ``POST .../action-items/{pk}/promote/``
  action is the only path that creates BACKLOG Tasks from action items.
- ``promote_to_sprint_id`` request field is no longer accepted (it conflicted
  with sprint sovereignty per ADR-0069 / ADR-0071).
- Visibility rule: TEAM_ONLY retros (default) require MEMBER+ to read raw
  ``notes`` / action item text. VIEWER receives a counts-only summary.
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
    RetroVisibility,
    Sprint,
    SprintRetro,
    SprintState,
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
def admin_user(project: Project) -> object:
    u = User.objects.create_user(username="admin_user", password="pw")
    ProjectMembership.objects.create(project=project, user=u, role=Role.ADMIN)
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
def test_get_returns_full_retro_for_member(project: Project, member: object) -> None:
    s = _closed_sprint(project)
    SprintRetro.objects.create(sprint=s, notes="What went well: telemetry stable.")
    resp = _client(member).get(f"/api/v1/sprints/{s.pk}/retro/")
    assert resp.status_code == 200
    assert resp.data["kind"] == "full"
    assert resp.data["notes"] == "What went well: telemetry stable."
    assert resp.data["action_items"] == []
    assert resp.data["team_visibility"] == "team_only"


@pytest.mark.django_db
def test_viewer_on_team_only_retro_gets_summary(project: Project, viewer: object) -> None:
    s = _closed_sprint(project)
    retro = SprintRetro.objects.create(sprint=s, notes="sensitive content")
    RetroActionItem.objects.create(retro=retro, text="action 1")
    RetroActionItem.objects.create(retro=retro, text="action 2")

    resp = _client(viewer).get(f"/api/v1/sprints/{s.pk}/retro/")
    assert resp.status_code == 200
    assert resp.data["kind"] == "summary"
    assert "notes" not in resp.data
    assert "action_items" not in resp.data
    assert resp.data["action_items_count"] == 2
    assert resp.data["promoted_count"] == 0


@pytest.mark.django_db
def test_viewer_on_project_visibility_retro_gets_full(project: Project, viewer: object) -> None:
    s = _closed_sprint(project)
    SprintRetro.objects.create(
        sprint=s,
        notes="shared content",
        team_visibility=RetroVisibility.PROJECT,
    )
    resp = _client(viewer).get(f"/api/v1/sprints/{s.pk}/retro/")
    assert resp.status_code == 200
    assert resp.data["kind"] == "full"
    assert resp.data["notes"] == "shared content"


# ---------------------------------------------------------------------------
# POST — upsert (no auto-promote)
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
    assert all(item["promoted_task_id"] is None for item in resp.data["action_items"])


@pytest.mark.django_db
def test_post_with_promote_flag_does_not_auto_promote(project: Project, member: object) -> None:
    """ADR-0071 §2: the legacy ``promote=true`` flag is silently ignored.

    Promotion must go through the explicit ``/promote/`` endpoint so sprint
    sovereignty cannot be bypassed via the bulk upsert path.
    """
    _planned_sprint(project)  # would have been the auto-promote target pre-ADR-0071
    closed = _closed_sprint(project)
    resp = _client(member).post(
        f"/api/v1/sprints/{closed.pk}/retro/",
        {
            "notes": "",
            "action_items": [
                {"text": "Add deploy gate", "promote": True, "story_points": 3},
            ],
        },
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data["action_items"][0]["promoted_task_id"] is None
    # And no Task created.
    from trueppm_api.apps.projects.models import Task

    assert Task.objects.filter(name="Add deploy gate").count() == 0


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
    items = list(retro.action_items.filter(is_deleted=False))
    assert len(items) == 1
    assert items[0].text == "fresh item"


@pytest.mark.django_db
def test_post_accepts_team_visibility(project: Project, member: object) -> None:
    s = _closed_sprint(project)
    resp = _client(member).post(
        f"/api/v1/sprints/{s.pk}/retro/",
        {
            "notes": "",
            "team_visibility": "project",
            "action_items": [],
        },
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data["team_visibility"] == "project"


@pytest.mark.django_db
def test_post_rejects_invalid_team_visibility(project: Project, member: object) -> None:
    s = _closed_sprint(project)
    resp = _client(member).post(
        f"/api/v1/sprints/{s.pk}/retro/",
        {"notes": "", "team_visibility": "world", "action_items": []},
        format="json",
    )
    assert resp.status_code == 400
    assert "team_visibility" in resp.data


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
# PATCH — visibility toggle
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_patch_visibility_by_author(project: Project, member: object) -> None:
    s = _closed_sprint(project)
    SprintRetro.objects.create(sprint=s, created_by=member)
    resp = _client(member).patch(
        f"/api/v1/sprints/{s.pk}/retro/",
        {"team_visibility": "project"},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data["team_visibility"] == "project"


@pytest.mark.django_db
def test_patch_visibility_by_admin(project: Project, member: object, admin_user: object) -> None:
    s = _closed_sprint(project)
    SprintRetro.objects.create(sprint=s, created_by=member)
    resp = _client(admin_user).patch(
        f"/api/v1/sprints/{s.pk}/retro/",
        {"team_visibility": "org"},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data["team_visibility"] == "org"


@pytest.mark.django_db
def test_patch_visibility_forbidden_for_other_member(project: Project, member: object) -> None:
    s = _closed_sprint(project)
    author = User.objects.create_user(username="author", password="pw")
    ProjectMembership.objects.create(project=project, user=author, role=Role.MEMBER)
    SprintRetro.objects.create(sprint=s, created_by=author)

    resp = _client(member).patch(
        f"/api/v1/sprints/{s.pk}/retro/",
        {"team_visibility": "project"},
        format="json",
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Prior retro endpoint
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_prior_returns_most_recent_completed_retro(project: Project, member: object) -> None:
    s_prior = Sprint.objects.create(
        project=project,
        name="S0",
        start_date=date(2026, 3, 17),
        finish_date=date(2026, 3, 31),
        state=SprintState.COMPLETED,
    )
    SprintRetro.objects.create(sprint=s_prior, notes="from S0")
    s_current = _closed_sprint(project, name="S1")  # starts 2026-04-01

    resp = _client(member).get(f"/api/v1/sprints/{s_current.pk}/retrospective/prior/")
    assert resp.status_code == 200
    assert resp.data["sprint"] == s_prior.pk


@pytest.mark.django_db
def test_prior_returns_404_when_no_prior_retro(project: Project, member: object) -> None:
    s = _closed_sprint(project)
    resp = _client(member).get(f"/api/v1/sprints/{s.pk}/retrospective/prior/")
    assert resp.status_code == 404


@pytest.mark.django_db
def test_prior_skips_cancelled_sprints(project: Project, member: object) -> None:
    Sprint.objects.create(
        project=project,
        name="Cancelled",
        start_date=date(2026, 3, 17),
        finish_date=date(2026, 3, 31),
        state=SprintState.CANCELLED,
    )
    s = _closed_sprint(project, name="S1")
    resp = _client(member).get(f"/api/v1/sprints/{s.pk}/retrospective/prior/")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Permissions
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_viewer_cannot_write(project: Project, viewer: object) -> None:
    s = _closed_sprint(project)
    SprintRetro.objects.create(sprint=s, notes="hi")
    resp = _client(viewer).post(
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
