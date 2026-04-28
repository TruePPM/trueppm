"""Tests for BoardColumnConfig GET/PUT endpoint."""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import BoardColumnConfig, Calendar, Project

User = get_user_model()

# 5-column default per Claude Design handoff (issue #178), extended per ADR-0039
# with optional `color` and `wip_limit` keys (issue #170).
DEFAULT_COLUMNS = [
    {
        "status": "BACKLOG",
        "label": "Backlog",
        "visible": True,
        "color": "#94A3B8",
        "wip_limit": None,
    },
    {
        "status": "NOT_STARTED",
        "label": "To Do",
        "visible": True,
        "color": "#64748B",
        "wip_limit": None,
    },
    {
        "status": "IN_PROGRESS",
        "label": "In Progress",
        "visible": True,
        "color": "#3B82F6",
        "wip_limit": 5,
    },
    {"status": "REVIEW", "label": "Review", "visible": True, "color": "#A855F7", "wip_limit": 3},
    {"status": "COMPLETE", "label": "Done", "visible": True, "color": "#22C55E", "wip_limit": None},
]


def _bare(columns: list[dict]) -> list[dict]:
    """Return columns with only the legacy 3-key shape (drop color/wip_limit)."""
    return [{"status": c["status"], "label": c["label"], "visible": c["visible"]} for c in columns]


@pytest.fixture
def calendar(db):
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar):
    return Project.objects.create(name="Board Proj", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def scheduler_user(db):
    return User.objects.create_user(username="scheduler", password="pw")


@pytest.fixture
def member_user(db):
    return User.objects.create_user(username="member", password="pw")


@pytest.fixture
def scheduler_client(scheduler_user, project):
    ProjectMembership.objects.create(project=project, user=scheduler_user, role=Role.SCHEDULER)
    client = APIClient()
    client.force_authenticate(user=scheduler_user)
    return client


@pytest.fixture
def member_client(member_user, project):
    ProjectMembership.objects.create(project=project, user=member_user, role=Role.MEMBER)
    client = APIClient()
    client.force_authenticate(user=member_user)
    return client


@pytest.mark.django_db
def test_get_returns_defaults_when_no_config(scheduler_client, project):
    """GET returns the 5-column default with color and wip_limit when no config row exists."""
    resp = scheduler_client.get(f"/api/v1/projects/{project.pk}/board-config/")
    assert resp.status_code == 200
    assert resp.data["columns"] == DEFAULT_COLUMNS


@pytest.mark.django_db
def test_put_saves_config_with_color_and_wip_limit(scheduler_client, project):
    """PUT accepts the extended JSON shape with color and wip_limit, and GET reflects it."""
    new_columns = [
        {
            "status": "BACKLOG",
            "label": "Ideas",
            "visible": True,
            "color": "#FF00AA",
            "wip_limit": None,
        },
        {
            "status": "NOT_STARTED",
            "label": "Up Next",
            "visible": True,
            "color": None,
            "wip_limit": 10,
        },
        {
            "status": "IN_PROGRESS",
            "label": "Doing",
            "visible": True,
            "color": "#3B82F6",
            "wip_limit": 7,
        },
        {
            "status": "REVIEW",
            "label": "In Review",
            "visible": False,
            "color": "#A855F7",
            "wip_limit": 2,
        },
        {
            "status": "COMPLETE",
            "label": "Done",
            "visible": True,
            "color": "#22C55E",
            "wip_limit": None,
        },
    ]
    put_resp = scheduler_client.put(
        f"/api/v1/projects/{project.pk}/board-config/",
        data={"columns": new_columns},
        format="json",
    )
    assert put_resp.status_code == 200
    assert put_resp.data["columns"] == new_columns

    get_resp = scheduler_client.get(f"/api/v1/projects/{project.pk}/board-config/")
    assert get_resp.data["columns"] == new_columns


@pytest.mark.django_db
def test_put_legacy_shape_normalizes_to_null_color_and_wip(scheduler_client, project):
    """A legacy payload without color/wip_limit keys is accepted and normalized to nulls."""
    legacy = _bare(DEFAULT_COLUMNS)
    put_resp = scheduler_client.put(
        f"/api/v1/projects/{project.pk}/board-config/",
        data={"columns": legacy},
        format="json",
    )
    assert put_resp.status_code == 200
    for col in put_resp.data["columns"]:
        assert col["color"] is None
        assert col["wip_limit"] is None


@pytest.mark.django_db
def test_put_is_idempotent(scheduler_client, project):
    """Repeated PUTs update the single config row (no duplicates)."""
    scheduler_client.put(
        f"/api/v1/projects/{project.pk}/board-config/",
        data={"columns": DEFAULT_COLUMNS},
        format="json",
    )
    scheduler_client.put(
        f"/api/v1/projects/{project.pk}/board-config/",
        data={"columns": DEFAULT_COLUMNS},
        format="json",
    )
    assert BoardColumnConfig.objects.filter(project=project).count() == 1


@pytest.mark.django_db
def test_member_can_read_config(member_client, project):
    """A MEMBER (role=1) can read the config."""
    resp = member_client.get(f"/api/v1/projects/{project.pk}/board-config/")
    assert resp.status_code == 200


@pytest.mark.django_db
def test_member_cannot_write_config(member_client, project):
    """A MEMBER (role=1) cannot PUT the config (requires SCHEDULER)."""
    resp = member_client.put(
        f"/api/v1/projects/{project.pk}/board-config/",
        data={"columns": DEFAULT_COLUMNS},
        format="json",
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_put_rejects_unknown_status(scheduler_client, project):
    """PUT rejects a column with an unknown status value (e.g. ON_HOLD legacy value)."""
    bad_columns = _bare(DEFAULT_COLUMNS)
    bad_columns[0] = {"status": "ON_HOLD", "label": "On Hold", "visible": True}  # legacy
    resp = scheduler_client.put(
        f"/api/v1/projects/{project.pk}/board-config/",
        data={"columns": bad_columns},
        format="json",
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_put_rejects_missing_status(scheduler_client, project):
    """PUT rejects a payload missing one of the five canonical statuses."""
    partial = _bare(DEFAULT_COLUMNS)[1:]  # drops BACKLOG
    resp = scheduler_client.put(
        f"/api/v1/projects/{project.pk}/board-config/",
        data={"columns": partial},
        format="json",
    )
    assert resp.status_code == 400


@pytest.mark.django_db
@pytest.mark.parametrize(
    "bad_color",
    [
        "red",  # not a hex string
        "#FF",  # too short
        "#GGHHII",  # invalid hex digits
        "FF00AA",  # missing leading hash
        "#ff00aa00",  # too long (8 digits)
    ],
)
def test_put_rejects_invalid_color(scheduler_client, project, bad_color):
    """PUT rejects color values that are not #RRGGBB hex strings."""
    columns = [dict(c) for c in DEFAULT_COLUMNS]
    columns[0]["color"] = bad_color
    resp = scheduler_client.put(
        f"/api/v1/projects/{project.pk}/board-config/",
        data={"columns": columns},
        format="json",
    )
    assert resp.status_code == 400


@pytest.mark.django_db
@pytest.mark.parametrize(
    "good_color",
    ["#FF00AA", "#ff00aa", "#000000", "#FFFFFF", None],
)
def test_put_accepts_valid_color(scheduler_client, project, good_color):
    """PUT accepts any well-formed 6-digit hex (upper or lower case) and null."""
    columns = [dict(c) for c in DEFAULT_COLUMNS]
    columns[0]["color"] = good_color
    resp = scheduler_client.put(
        f"/api/v1/projects/{project.pk}/board-config/",
        data={"columns": columns},
        format="json",
    )
    assert resp.status_code == 200


@pytest.mark.django_db
@pytest.mark.parametrize("bad_limit", [0, -1, "5", 1.5, True, False])
def test_put_rejects_invalid_wip_limit(scheduler_client, project, bad_limit):
    """PUT rejects wip_limit values that are not positive integers or null."""
    columns = [dict(c) for c in DEFAULT_COLUMNS]
    columns[2]["wip_limit"] = bad_limit
    resp = scheduler_client.put(
        f"/api/v1/projects/{project.pk}/board-config/",
        data={"columns": columns},
        format="json",
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_put_drops_unknown_keys(scheduler_client, project):
    """Extra keys in the payload are silently dropped from the persisted shape."""
    columns = [dict(c) for c in DEFAULT_COLUMNS]
    columns[0]["bogus"] = "smuggled"
    resp = scheduler_client.put(
        f"/api/v1/projects/{project.pk}/board-config/",
        data={"columns": columns},
        format="json",
    )
    assert resp.status_code == 200
    assert "bogus" not in resp.data["columns"][0]


@pytest.mark.django_db
def test_put_broadcasts_board_config_updated(
    scheduler_client, project, django_capture_on_commit_callbacks
):
    """PUT triggers broadcast_board_event on commit so connected clients refetch."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_broadcast,
        django_capture_on_commit_callbacks(execute=True),
    ):
        scheduler_client.put(
            f"/api/v1/projects/{project.pk}/board-config/",
            data={"columns": DEFAULT_COLUMNS},
            format="json",
        )
    assert mock_broadcast.called
    args, _ = mock_broadcast.call_args
    project_id, event_type, payload = args
    assert project_id == str(project.pk)
    assert event_type == "board_config_updated"
    assert payload["columns"] == DEFAULT_COLUMNS
