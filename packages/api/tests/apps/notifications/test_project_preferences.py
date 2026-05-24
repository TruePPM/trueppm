"""Tests for the per-project notification preferences endpoint (#522)."""

from __future__ import annotations

from datetime import date, time
from importlib import import_module

import pytest
from django.apps import apps as django_apps
from django.contrib.auth import get_user_model
from django.urls import reverse
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.notifications.models import (
    PROJECT_NOTIFICATION_DEFAULT_MATRIX,
    ProjectNotificationChannel,
    ProjectNotificationEventType,
    ProjectNotificationPreference,
)
from trueppm_api.apps.projects.models import Calendar, Project

User = get_user_model()


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def alice(db: object) -> object:
    return User.objects.create_user(username="alice", password="pw")


@pytest.fixture
def bob(db: object) -> object:
    return User.objects.create_user(username="bob", password="pw")


@pytest.fixture
def carol(db: object) -> object:
    return User.objects.create_user(username="carol", password="pw")


@pytest.fixture
def memberships(project: Project, alice: object, bob: object) -> dict[str, ProjectMembership]:
    return {
        "alice": ProjectMembership.objects.create(project=project, user=alice, role=Role.MEMBER),
        "bob": ProjectMembership.objects.create(project=project, user=bob, role=Role.MEMBER),
    }


@pytest.fixture
def alice_client(alice: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=alice)
    return c


@pytest.fixture
def bob_client(bob: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=bob)
    return c


@pytest.fixture
def carol_client(carol: object) -> APIClient:
    """Authenticated but not a project member — used for 403 tests."""
    c = APIClient()
    c.force_authenticate(user=carol)
    return c


def _url(project: Project) -> str:
    return reverse("project-notification-preferences", kwargs={"pk": project.pk})


# ---------------------------------------------------------------------------
# GET — defaults backfill + per-user isolation
# ---------------------------------------------------------------------------


def test_get_first_time_returns_default_matrix(
    alice_client: APIClient, project: Project, memberships: dict
) -> None:
    """A member with no row gets the lazy-built default matrix + quiet hours."""
    response = alice_client.get(_url(project))
    assert response.status_code == 200
    body = response.json()
    assert set(body["matrix"].keys()) == {choice.value for choice in ProjectNotificationEventType}
    for chans in body["matrix"].values():
        assert set(chans.keys()) == {choice.value for choice in ProjectNotificationChannel}
    assert body["quiet_hours_enabled"] is True
    assert body["quiet_hours_from"] == "20:00:00"
    assert body["quiet_hours_until"] == "07:00:00"


def test_get_creates_single_row_per_user(
    alice_client: APIClient, project: Project, alice: object, memberships: dict
) -> None:
    """Repeat GETs are idempotent — one row per (project, user)."""
    alice_client.get(_url(project))
    alice_client.get(_url(project))
    assert ProjectNotificationPreference.objects.filter(project=project, user=alice).count() == 1


def test_get_is_per_user(
    alice_client: APIClient,
    bob_client: APIClient,
    project: Project,
    alice: object,
    bob: object,
    memberships: dict,
) -> None:
    """Bob's preferences are isolated from Alice's."""
    alice_client.patch(
        _url(project),
        {"matrix": {ProjectNotificationEventType.TASK_ASSIGNED: {"email": False}}},
        format="json",
    )
    bob_response = bob_client.get(_url(project))
    assert (
        bob_response.json()["matrix"][ProjectNotificationEventType.TASK_ASSIGNED]["email"] is True
    )


# ---------------------------------------------------------------------------
# PATCH — round-trip
# ---------------------------------------------------------------------------


def test_patch_partial_matrix_merges(
    alice_client: APIClient, project: Project, alice: object, memberships: dict
) -> None:
    """A partial PATCH updates only the supplied cells; siblings persist."""
    response = alice_client.patch(
        _url(project),
        {"matrix": {ProjectNotificationEventType.TASK_OVERDUE: {"mobile_push": False}}},
        format="json",
    )
    assert response.status_code == 200
    body = response.json()
    assert body["matrix"][ProjectNotificationEventType.TASK_OVERDUE]["mobile_push"] is False
    # Sibling channel preserved
    assert body["matrix"][ProjectNotificationEventType.TASK_OVERDUE]["email"] is True
    # Sibling event preserved
    assert (
        body["matrix"][ProjectNotificationEventType.TASK_ASSIGNED]["email"]
        is PROJECT_NOTIFICATION_DEFAULT_MATRIX[ProjectNotificationEventType.TASK_ASSIGNED][
            ProjectNotificationChannel.EMAIL
        ]
    )


def test_paused_defaults_to_false_on_first_get(
    alice_client: APIClient, project: Project, memberships: dict
) -> None:
    """A freshly created row has the kill-switch off (#589)."""
    body = alice_client.get(_url(project)).json()
    assert body["paused"] is False


def test_patch_paused_round_trip(
    alice_client: APIClient,
    project: Project,
    alice: object,
    memberships: dict,
) -> None:
    """PATCH paused=True persists and is visible on subsequent GET (#589)."""
    response = alice_client.patch(_url(project), {"paused": True}, format="json")
    assert response.status_code == 200
    assert response.json()["paused"] is True

    body = alice_client.get(_url(project)).json()
    assert body["paused"] is True
    row = ProjectNotificationPreference.objects.get(project=project, user=alice)
    assert row.paused is True

    # Unpausing restores the existing matrix exactly — no preference loss.
    response = alice_client.patch(_url(project), {"paused": False}, format="json")
    assert response.status_code == 200
    assert response.json()["paused"] is False


def test_patch_quiet_hours(alice_client: APIClient, project: Project, memberships: dict) -> None:
    response = alice_client.patch(
        _url(project),
        {
            "quiet_hours_enabled": False,
            "quiet_hours_from": "22:00",
            "quiet_hours_until": "06:00",
        },
        format="json",
    )
    assert response.status_code == 200
    body = response.json()
    assert body["quiet_hours_enabled"] is False
    assert body["quiet_hours_from"] == "22:00:00"
    assert body["quiet_hours_until"] == "06:00:00"


def test_patch_round_trip_persists(
    alice_client: APIClient,
    project: Project,
    alice: object,
    memberships: dict,
) -> None:
    """After PATCH, a fresh GET returns the same body."""
    alice_client.patch(
        _url(project),
        {
            "matrix": {ProjectNotificationEventType.BUDGET_ALERT: {"slack": False}},
            "quiet_hours_from": "21:30",
        },
        format="json",
    )
    body = alice_client.get(_url(project)).json()
    assert body["matrix"][ProjectNotificationEventType.BUDGET_ALERT]["slack"] is False
    assert body["quiet_hours_from"] == "21:30:00"
    row = ProjectNotificationPreference.objects.get(project=project, user=alice)
    assert row.quiet_hours_from == time(21, 30)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def test_patch_rejects_unknown_event_type(
    alice_client: APIClient, project: Project, memberships: dict
) -> None:
    response = alice_client.patch(
        _url(project),
        {"matrix": {"not_a_real_event": {"email": True}}},
        format="json",
    )
    assert response.status_code == 400


def test_patch_rejects_unknown_channel(
    alice_client: APIClient, project: Project, memberships: dict
) -> None:
    response = alice_client.patch(
        _url(project),
        {"matrix": {ProjectNotificationEventType.TASK_ASSIGNED: {"pager": True}}},
        format="json",
    )
    assert response.status_code == 400


def test_patch_rejects_non_bool_value(
    alice_client: APIClient, project: Project, memberships: dict
) -> None:
    response = alice_client.patch(
        _url(project),
        {"matrix": {ProjectNotificationEventType.TASK_ASSIGNED: {"email": "yes"}}},
        format="json",
    )
    assert response.status_code == 400


def test_get_drops_legacy_unknown_keys(
    alice_client: APIClient, project: Project, alice: object, memberships: dict
) -> None:
    """A row carrying pre-validation garbage returns only valid keys on GET (#675).

    The serializer now rejects unknown keys on write, but rows persisted before
    that shipped can still hold them. _merge_matrix filters them out so they
    never reach the client or the dispatcher, independent of the cleanup
    migration.
    """
    ProjectNotificationPreference.objects.create(
        project=project,
        user=alice,
        matrix={
            "not_an_event": {"not_a_channel": True},
            ProjectNotificationEventType.TASK_ASSIGNED.value: {
                "email": False,
                "pager": True,  # unknown channel
            },
        },
    )
    body = alice_client.get(_url(project)).json()
    assert "not_an_event" not in body["matrix"]
    assert set(body["matrix"].keys()) == {c.value for c in ProjectNotificationEventType}
    task_assigned = body["matrix"][ProjectNotificationEventType.TASK_ASSIGNED.value]
    assert "pager" not in task_assigned
    assert set(task_assigned.keys()) == {c.value for c in ProjectNotificationChannel}
    # The valid cell the user actually set is preserved.
    assert task_assigned["email"] is False


def test_cleanup_migration_strips_unknown_keys(
    project: Project, alice: object, memberships: dict
) -> None:
    """The 0004 data migration drops persisted garbage keys in place (#675)."""
    row = ProjectNotificationPreference.objects.create(
        project=project,
        user=alice,
        matrix={
            "not_an_event": {"email": True},
            ProjectNotificationEventType.TASK_ASSIGNED.value: {
                "email": True,
                "pager": True,  # unknown channel
                "slack": "yes",  # non-bool leaf
            },
        },
    )
    migration = import_module(
        "trueppm_api.apps.notifications.migrations.0004_clean_unknown_matrix_keys"
    )
    # The model shape is unchanged since this migration, so the live app
    # registry is a valid stand-in for the historical one.
    migration._clean_matrix(django_apps, None)

    row.refresh_from_db()
    assert "not_an_event" not in row.matrix
    task_assigned = row.matrix[ProjectNotificationEventType.TASK_ASSIGNED.value]
    assert task_assigned == {"email": True}  # unknown + non-bool dropped, valid kept


# ---------------------------------------------------------------------------
# Permissions
# ---------------------------------------------------------------------------


def test_unauthenticated_returns_401(project: Project) -> None:
    response = APIClient().get(_url(project))
    assert response.status_code in (401, 403)


def test_non_member_cannot_read(
    carol_client: APIClient, project: Project, memberships: dict
) -> None:
    response = carol_client.get(_url(project))
    assert response.status_code == 403


def test_non_member_cannot_write(
    carol_client: APIClient, project: Project, memberships: dict
) -> None:
    response = carol_client.patch(
        _url(project),
        {"matrix": {ProjectNotificationEventType.TASK_ASSIGNED: {"email": False}}},
        format="json",
    )
    assert response.status_code == 403


def test_deleted_project_returns_404(
    alice_client: APIClient, project: Project, memberships: dict
) -> None:
    project.is_deleted = True
    project.save()
    response = alice_client.get(_url(project))
    assert response.status_code == 404
