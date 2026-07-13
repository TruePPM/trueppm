"""Tests for BoardSavedView list/create/patch/delete endpoints (issue #191)."""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import BoardSavedView, Calendar, Project

User = get_user_model()

VALID_CONFIG = {
    "sort": "priority",
    "show_wip": True,
    "show_col_tints": True,
    "evm_mode": "off",
    "show_cost": False,
    "risk_linked_only": False,
}


@pytest.fixture
def calendar(db):
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar):
    return Project.objects.create(name="Views Proj", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def pm(project):
    user = User.objects.create_user(username="pm", password="x")
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    return user


@pytest.fixture
def member(project):
    user = User.objects.create_user(username="member", password="x")
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    return user


@pytest.fixture
def outsider(db):
    return User.objects.create_user(username="outsider", password="x")


@pytest.fixture
def pm_client(pm):
    c = APIClient()
    c.force_authenticate(pm)
    return c


@pytest.fixture
def member_client(member):
    c = APIClient()
    c.force_authenticate(member)
    return c


def _url(project_id, view_id=None):
    base = f"/api/v1/projects/{project_id}/board-views/"
    return base if view_id is None else f"{base}{view_id}/"


# ---------------------------------------------------------------------------
# GET list
# ---------------------------------------------------------------------------


def test_get_empty_list(pm_client, project):
    resp = pm_client.get(_url(project.pk))
    assert resp.status_code == 200
    assert resp.json() == []


def test_get_list_returns_saved_views(pm_client, pm, project):
    BoardSavedView.objects.create(
        project=project,
        name="My view",
        config=VALID_CONFIG,
        created_by=pm,
    )
    resp = pm_client.get(_url(project.pk))
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["name"] == "My view"
    assert data[0]["config"]["sort"] == "priority"


def test_get_list_requires_auth(client, project):
    resp = client.get(f"/api/v1/projects/{project.pk}/board-views/")
    assert resp.status_code in (401, 403)


def test_get_list_blocked_for_outsider(outsider, project):
    """A non-member must not read another project's saved views.

    ``BoardSavedViewListView.get`` calls ``check_object_permissions`` on the
    project, so ``IsProjectMemberWrite.has_object_permission`` runs and 403s a
    caller with no membership row. Pinning exactly 403 (not ``in (200, 403)``)
    is what makes this test able to catch a regression that removes the
    object-level membership check — the escalation this suite exists to block.
    """
    c = APIClient()
    c.force_authenticate(outsider)
    resp = c.get(_url(project.pk))
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# POST create
# ---------------------------------------------------------------------------


def test_post_creates_view(pm_client, pm, project):
    resp = pm_client.post(
        _url(project.pk),
        {"name": "Sprint alpha", "config": VALID_CONFIG},
        format="json",
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["name"] == "Sprint alpha"
    assert data["config"]["evm_mode"] == "off"
    assert BoardSavedView.objects.filter(project=project, name="Sprint alpha").exists()


def test_post_sets_created_by(pm_client, pm, project):
    resp = pm_client.post(
        _url(project.pk),
        {"name": "My view", "config": VALID_CONFIG},
        format="json",
    )
    assert resp.status_code == 201
    view = BoardSavedView.objects.get(pk=resp.json()["id"])
    assert view.created_by == pm


def test_post_rejects_duplicate_name(pm_client, pm, project):
    BoardSavedView.objects.create(project=project, name="Dup", config=VALID_CONFIG, created_by=pm)
    resp = pm_client.post(
        _url(project.pk),
        {"name": "Dup", "config": VALID_CONFIG},
        format="json",
    )
    assert resp.status_code == 400


def test_post_rejects_invalid_sort(pm_client, project):
    bad = {**VALID_CONFIG, "sort": "nonsense"}
    resp = pm_client.post(
        _url(project.pk),
        {"name": "Bad", "config": bad},
        format="json",
    )
    assert resp.status_code == 400


def test_post_rejects_invalid_evm_mode(pm_client, project):
    bad = {**VALID_CONFIG, "evm_mode": "quarterly"}
    resp = pm_client.post(
        _url(project.pk),
        {"name": "Bad", "config": bad},
        format="json",
    )
    assert resp.status_code == 400


def test_post_rejects_name_too_long(pm_client, project):
    resp = pm_client.post(
        _url(project.pk),
        {"name": "x" * 65, "config": VALID_CONFIG},
        format="json",
    )
    assert resp.status_code == 400


@pytest.mark.django_db(transaction=True)
@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_post_broadcasts_board_view_created(mock_broadcast, pm_client, project):
    resp = pm_client.post(
        _url(project.pk),
        {"name": "Broadcast test", "config": VALID_CONFIG},
        format="json",
    )
    assert resp.status_code == 201
    mock_broadcast.assert_called_once()
    args = mock_broadcast.call_args[0]
    assert args[1] == "board_view_created"


# ---------------------------------------------------------------------------
# PATCH update
# ---------------------------------------------------------------------------


@pytest.fixture
def saved_view(project, pm):
    return BoardSavedView.objects.create(
        project=project, name="Original", config=VALID_CONFIG, created_by=pm
    )


def test_patch_name_by_creator(pm_client, project, saved_view):
    resp = pm_client.patch(
        _url(project.pk, saved_view.pk),
        {"name": "Renamed"},
        format="json",
    )
    assert resp.status_code == 200
    saved_view.refresh_from_db()
    assert saved_view.name == "Renamed"


def test_patch_config_by_creator(pm_client, project, saved_view):
    new_config = {**VALID_CONFIG, "evm_mode": "spi"}
    resp = pm_client.patch(
        _url(project.pk, saved_view.pk),
        {"config": new_config},
        format="json",
    )
    assert resp.status_code == 200
    saved_view.refresh_from_db()
    assert saved_view.config["evm_mode"] == "spi"


def test_patch_blocked_for_non_creator_member(member_client, project, saved_view):
    """Team Member who did not create the view cannot patch it."""
    resp = member_client.patch(
        _url(project.pk, saved_view.pk),
        {"name": "Hijack"},
        format="json",
    )
    assert resp.status_code == 403


def test_patch_allowed_for_scheduler(member, project, saved_view):
    """A Scheduler-role member may patch any view even if not the creator."""
    ProjectMembership.objects.filter(project=project, user=member).update(role=Role.SCHEDULER)
    c = APIClient()
    c.force_authenticate(member)
    resp = c.patch(
        _url(project.pk, saved_view.pk),
        {"name": "Scheduler rename"},
        format="json",
    )
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# DELETE
# ---------------------------------------------------------------------------


def test_delete_by_creator(pm_client, project, saved_view):
    resp = pm_client.delete(_url(project.pk, saved_view.pk))
    assert resp.status_code == 204
    assert not BoardSavedView.objects.filter(pk=saved_view.pk).exists()


def test_delete_blocked_for_non_creator(member_client, project, saved_view):
    resp = member_client.delete(_url(project.pk, saved_view.pk))
    assert resp.status_code == 403
    assert BoardSavedView.objects.filter(pk=saved_view.pk).exists()


def test_delete_allowed_for_scheduler(member, project, saved_view):
    ProjectMembership.objects.filter(project=project, user=member).update(role=Role.SCHEDULER)
    c = APIClient()
    c.force_authenticate(member)
    resp = c.delete(_url(project.pk, saved_view.pk))
    assert resp.status_code == 204


@pytest.mark.django_db(transaction=True)
@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_delete_broadcasts_board_view_deleted(mock_broadcast, pm_client, project, saved_view):
    resp = pm_client.delete(_url(project.pk, saved_view.pk))
    assert resp.status_code == 204
    mock_broadcast.assert_called_once()
    args = mock_broadcast.call_args[0]
    assert args[1] == "board_view_deleted"


# ---------------------------------------------------------------------------
# RBAC: creating a shared view requires Member+ (#820)
# ---------------------------------------------------------------------------


@pytest.fixture
def viewer(project):
    user = User.objects.create_user(username="viewer", password="x")
    ProjectMembership.objects.create(project=project, user=user, role=Role.VIEWER)
    return user


@pytest.fixture
def viewer_client(viewer):
    c = APIClient()
    c.force_authenticate(viewer)
    return c


def test_viewer_can_list_saved_views(viewer_client, pm, project):
    """A Viewer may read shared views — read stays open (#820)."""
    BoardSavedView.objects.create(
        project=project, name="Shared", config=VALID_CONFIG, created_by=pm
    )
    resp = viewer_client.get(_url(project.pk))
    assert resp.status_code == 200
    assert len(resp.json()) == 1


def test_viewer_cannot_create_saved_view(viewer_client, project):
    """A Viewer may NOT create a project-shared view — writes require Member+ (#820)."""
    resp = viewer_client.post(
        _url(project.pk),
        {"name": "Viewer view", "config": VALID_CONFIG},
        format="json",
    )
    assert resp.status_code == 403
    assert not BoardSavedView.objects.filter(name="Viewer view").exists()


def test_member_can_create_saved_view(member_client, project):
    """A Member may create a shared view."""
    resp = member_client.post(
        _url(project.pk),
        {"name": "Member view", "config": VALID_CONFIG},
        format="json",
    )
    assert resp.status_code == 201
    assert BoardSavedView.objects.filter(project=project, name="Member view").exists()


# ---------------------------------------------------------------------------
# Filter facets round-trip (#1918) — config.filter_assignees/priority/due
# ---------------------------------------------------------------------------


def test_post_round_trips_filter_facets(pm_client, project):
    """Saving a view with active facets returns them unchanged on the same response."""
    config = {
        **VALID_CONFIG,
        "filter_assignees": ["res-1", "res-2", "__unassigned__"],
        "filter_priority": ["high", "medium"],
        "filter_due": ["overdue"],
    }
    resp = pm_client.post(
        _url(project.pk),
        {"name": "Filtered view", "config": config},
        format="json",
    )
    assert resp.status_code == 201
    data = resp.json()["config"]
    assert data["filter_assignees"] == ["res-1", "res-2", "__unassigned__"]
    assert data["filter_priority"] == ["high", "medium"]
    assert data["filter_due"] == ["overdue"]


def test_post_defaults_missing_filter_facets_to_empty(pm_client, project):
    """A config that omits the filter_* keys entirely round-trips to empty lists."""
    resp = pm_client.post(
        _url(project.pk),
        {"name": "No filters", "config": VALID_CONFIG},
        format="json",
    )
    assert resp.status_code == 201
    data = resp.json()["config"]
    assert data["filter_assignees"] == []
    assert data["filter_priority"] == []
    assert data["filter_due"] == []


def test_post_rejects_invalid_priority_facet(pm_client, project):
    bad = {**VALID_CONFIG, "filter_priority": ["extremely-urgent"]}
    resp = pm_client.post(
        _url(project.pk),
        {"name": "Bad", "config": bad},
        format="json",
    )
    assert resp.status_code == 400


def test_post_rejects_invalid_due_facet(pm_client, project):
    bad = {**VALID_CONFIG, "filter_due": ["next_month"]}
    resp = pm_client.post(
        _url(project.pk),
        {"name": "Bad", "config": bad},
        format="json",
    )
    assert resp.status_code == 400


def test_post_rejects_non_string_assignee_facet(pm_client, project):
    """filter_assignees has no enum (opaque resource ids) but must still be a string list."""
    bad = {**VALID_CONFIG, "filter_assignees": [123]}
    resp = pm_client.post(
        _url(project.pk),
        {"name": "Bad", "config": bad},
        format="json",
    )
    assert resp.status_code == 400


def test_post_dedupes_filter_facet_values(pm_client, project):
    config = {**VALID_CONFIG, "filter_priority": ["high", "high", "low"]}
    resp = pm_client.post(
        _url(project.pk),
        {"name": "Dup facets", "config": config},
        format="json",
    )
    assert resp.status_code == 201
    assert resp.json()["config"]["filter_priority"] == ["high", "low"]


def test_post_stamps_current_schema_version(pm_client, project):
    """A fresh write is born at schema_version=2 (#1918 bumped the surface)."""
    resp = pm_client.post(
        _url(project.pk),
        {"name": "Versioned", "config": VALID_CONFIG},
        format="json",
    )
    assert resp.status_code == 201
    assert resp.json()["schema_version"] == 2
    view = BoardSavedView.objects.get(pk=resp.json()["id"])
    assert view.schema_version == 2


def test_get_upgrades_a_stale_v1_row_on_read(pm_client, pm, project):
    """A pre-#1918 row (6-key config, schema_version=1) reads back with facet defaults.

    Exercises the forward-migration registry directly: a row written before the
    filter-facet keys existed must not 500 or silently omit the keys on read —
    ``_board_view_v1_to_v2`` backfills them to the empty-list default.
    """
    view = BoardSavedView.objects.create(
        project=project,
        name="Legacy",
        config=dict(VALID_CONFIG),  # 6-key shape only, no filter_* keys
        schema_version=1,
        created_by=pm,
    )
    resp = pm_client.get(_url(project.pk))
    assert resp.status_code == 200
    data = next(v for v in resp.json() if v["id"] == str(view.pk))
    assert data["schema_version"] == 2
    assert data["config"]["filter_assignees"] == []
    assert data["config"]["filter_priority"] == []
    assert data["config"]["filter_due"] == []
    # The stored row itself is untouched by a read (upgrade happens in the
    # response only) — this is a read-time projection, not a write-on-read.
    view.refresh_from_db()
    assert view.schema_version == 1


def test_patch_with_config_stamps_current_schema_version(pm_client, project, saved_view):
    """A PATCH that rewrites config is stamped to the current schema_version."""
    new_config = {**VALID_CONFIG, "filter_priority": ["high"]}
    resp = pm_client.patch(
        _url(project.pk, saved_view.pk),
        {"config": new_config},
        format="json",
    )
    assert resp.status_code == 200
    saved_view.refresh_from_db()
    assert saved_view.schema_version == 2
    assert saved_view.config["filter_priority"] == ["high"]


def test_patch_name_only_does_not_bump_schema_version(pm_client, project):
    """A name-only PATCH must not falsely claim a v1 config is v2-shaped.

    Regression guard: stamping schema_version on every PATCH (regardless of
    whether config was rewritten) would make the read-side migration chain skip
    backfilling filter_* onto a row whose stored config never actually gained
    those keys (#1918).
    """
    stale = BoardSavedView.objects.create(
        project=project,
        name="Original",
        config=dict(VALID_CONFIG),
        schema_version=1,
    )
    resp = pm_client.patch(
        _url(project.pk, stale.pk),
        {"name": "Renamed"},
        format="json",
    )
    assert resp.status_code == 200
    stale.refresh_from_db()
    assert stale.name == "Renamed"
    assert stale.schema_version == 1
    assert "filter_assignees" not in stale.config

    # The read path still self-heals: the response upgrades on the fly.
    resp = pm_client.get(_url(project.pk))
    data = next(v for v in resp.json() if v["id"] == str(stale.pk))
    assert data["config"]["filter_assignees"] == []
