"""Tests for the per-project notification preferences endpoint (#522)."""

from __future__ import annotations

from datetime import date, time

import pytest
from django.apps import apps as django_apps
from django.contrib.auth import get_user_model
from django.urls import reverse
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.notifications.backfill import _clean_matrix
from trueppm_api.apps.notifications.models import (
    PROJECT_NOTIFICATION_DEFAULT_MATRIX,
    PROJECT_NOTIFICATION_UNDISPATCHED_EVENTS,
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
    # Derived from the default matrix, not hard-coded: the claim here is that Bob is
    # unaffected by Alice's write, which is true whatever the default happens to be.
    assert (
        bob_response.json()["matrix"][ProjectNotificationEventType.TASK_ASSIGNED]["email"]
        is PROJECT_NOTIFICATION_DEFAULT_MATRIX[ProjectNotificationEventType.TASK_ASSIGNED][
            ProjectNotificationChannel.EMAIL
        ]
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
    # Sibling channel preserved — again derived, so a default change cannot make
    # this fail for a reason that has nothing to do with merge semantics.
    assert (
        body["matrix"][ProjectNotificationEventType.TASK_OVERDUE]["email"]
        is PROJECT_NOTIFICATION_DEFAULT_MATRIX[ProjectNotificationEventType.TASK_OVERDUE][
            ProjectNotificationChannel.EMAIL
        ]
    )
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
    # The model shape is unchanged since this migration, so the live app
    # registry is a valid stand-in for the historical one.
    _clean_matrix(django_apps, None)

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


# ---------------------------------------------------------------------------
# event_delivery — which rows are actually wired (#2904)
# ---------------------------------------------------------------------------


def test_get_reports_which_events_are_dispatched(
    alice_client: APIClient, project: Project, memberships: dict
) -> None:
    """The settings page needs a server fact, not a hard-coded client list.

    Eight of the nine rows have no dispatcher; without this the page renders them
    identically to the one that works and implies a delivery that never happens.
    """
    body = alice_client.get(_url(project)).json()

    delivery = body["event_delivery"]
    assert set(delivery) == set(PROJECT_NOTIFICATION_DEFAULT_MATRIX)
    assert delivery[ProjectNotificationEventType.COMMENT_MENTION] is True
    for event in sorted(PROJECT_NOTIFICATION_UNDISPATCHED_EVENTS):
        assert delivery[event] is False, (
            f"{event} is reported as delivered but nothing dispatches it"
        )


def test_undispatched_events_default_off_over_the_api(
    alice_client: APIClient, project: Project, memberships: dict
) -> None:
    """End-to-end version of the model-level guard: a fresh row must not arrive with
    eight events switched on across in-app, email and Slack."""
    matrix = alice_client.get(_url(project)).json()["matrix"]

    for event in sorted(PROJECT_NOTIFICATION_UNDISPATCHED_EVENTS):
        enabled = sorted(channel for channel, on in matrix[event].items() if on)
        assert not enabled, f"{event} arrives ON for {enabled} but nothing dispatches it"


def test_a_stored_preference_still_round_trips_for_an_undispatched_event(
    alice_client: APIClient, project: Project, memberships: dict
) -> None:
    """Defaulting OFF must not make the row read-only. The setting is kept so it
    applies when the dispatcher lands (#3016) — the API just stops claiming it is
    live today."""
    event = ProjectNotificationEventType.SPRINT_START
    response = alice_client.patch(
        _url(project), {"matrix": {event: {"email": True}}}, format="json"
    )

    assert response.status_code == 200
    assert response.json()["matrix"][event]["email"] is True
    assert response.json()["event_delivery"][event] is False


# ---------------------------------------------------------------------------
# quiet_hours_timezone / _source — the resolved window zone is a server fact (#3377)
# ---------------------------------------------------------------------------


def _set_workspace_tz(name: str) -> None:
    from trueppm_api.apps.workspace.models import Workspace

    ws = Workspace.load()
    ws.timezone = name
    ws.save(update_fields=["timezone"])


@pytest.mark.django_db
def test_get_reports_the_workspace_tier_to_a_plain_member(
    alice_client: APIClient, project: Project, memberships: dict
) -> None:
    """A Member sees the resolved zone and the tier that supplied it (#3377).

    ``quiet_hours_from``/``_until`` are bare wall-clock times, and the winning tier
    is not derivable from the stored values — a project and a workspace set to the
    same zone are indistinguishable to a client. The server reports both.
    """
    _set_workspace_tz("Asia/Tokyo")
    body = alice_client.get(_url(project)).json()
    assert body["quiet_hours_timezone"] == "Asia/Tokyo"
    assert body["quiet_hours_timezone_source"] == "workspace"


@pytest.mark.django_db
def test_workspace_timezone_is_member_readable_at_source(
    alice_client: APIClient, memberships: dict
) -> None:
    """Tripwire: these fields re-expose nothing, *because* /workspace/ GET is open.

    ``IsWorkspaceAdmin`` admits any workspace role on safe methods, so a plain Member
    can already read ``Workspace.timezone`` at the source — which is why surfacing the
    resolved zone on the preferences endpoint is a convenience, not a disclosure. If
    that endpoint is ever narrowed to ``IsWorkspaceAdminStrict`` (#1724) this test
    reds, forcing a decision about whether these two fields should follow it, instead
    of leaving them a silent re-export.
    """
    _set_workspace_tz("Asia/Tokyo")
    resp = alice_client.get("/api/v1/workspace/")
    assert resp.status_code == 200
    assert resp.data["timezone"] == "Asia/Tokyo"


@pytest.mark.django_db
def test_get_reports_the_project_tier_when_the_project_overrides(
    alice_client: APIClient, project: Project, memberships: dict
) -> None:
    """`project` vs `workspace` is the difference between two different admins."""
    _set_workspace_tz("Asia/Tokyo")
    project.timezone = "America/New_York"
    project.save(update_fields=["timezone"])
    body = alice_client.get(_url(project)).json()
    assert body["quiet_hours_timezone"] == "America/New_York"
    assert body["quiet_hours_timezone_source"] == "project"


@pytest.mark.django_db
def test_quiet_hours_timezone_is_read_only(
    alice_client: APIClient, project: Project, memberships: dict
) -> None:
    """It is resolved, not stored — a PATCH of it must be ignored, not persisted."""
    _set_workspace_tz("Asia/Tokyo")
    resp = alice_client.patch(
        _url(project),
        {"quiet_hours_timezone": "Antarctica/Troll", "quiet_hours_timezone_source": "project"},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.json()["quiet_hours_timezone"] == "Asia/Tokyo"
    assert resp.json()["quiet_hours_timezone_source"] == "workspace"


@pytest.mark.django_db
def test_get_does_not_create_the_workspace_row_and_matches_dispatch(
    alice_client: APIClient, project: Project, memberships: dict
) -> None:
    """Reading the resolved tier must not change what the resolved tier IS.

    These fields exist to report what the dispatcher would do. Pre-loading the
    singleton with ``Workspace.load()`` — a get_or_create — would make a GET create
    the row and then answer ``"workspace"``, while the dispatch path (which reads
    without writing) would answer ``"server"`` for the same install. The endpoint
    would be lying about the thing it was added to report.
    """
    from trueppm_api.apps.workspace.models import Workspace

    Workspace.objects.all().delete()
    body = alice_client.get(_url(project)).json()
    assert Workspace.objects.count() == 0
    assert body["quiet_hours_timezone_source"] == "server"


@pytest.mark.django_db
def test_get_reads_the_project_and_workspace_once_each(
    alice_client: APIClient, project: Project, memberships: dict
) -> None:
    """Pin the two query-avoidance mechanisms the behavioral tests cannot see (#3377).

    Delete either one and every other test on this endpoint still passes:

    - the view primes ``pref.project`` because ``get_or_create`` fills the FK cache
      only on its *create* branch, so on the common existing-row path the serializer
      would otherwise lazy-load the project;
    - ``_resolved_quiet_hours_tz`` memoizes per project, so the two method fields
      resolve the chain once between them rather than twice.

    The fan-out path got a query guard at two recipient counts; this is its
    request-path counterpart.
    """
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    _set_workspace_tz("Asia/Tokyo")
    alice_client.get(_url(project))  # materialize the preference row first

    with CaptureQueriesContext(connection) as ctx:
        body = alice_client.get(_url(project)).json()

    assert body["quiet_hours_timezone"] == "Asia/Tokyo"
    workspace_reads = [q for q in ctx.captured_queries if "workspace_workspace" in q["sql"]]
    assert len(workspace_reads) == 1, (
        f"expected one workspace read for two method fields, got {len(workspace_reads)} — "
        "the per-project memo in _resolved_quiet_hours_tz is not holding"
    )
    # Row fetches only. The permission layer also issues an `EXISTS`-shaped
    # `SELECT 1 AS "a" ... LIMIT 21` probe, which is not a row read and is unrelated to
    # the FK cache — counting it would pin an unrelated baseline instead of the
    # mechanism. A serializer lazy-load would show up here as a *second* row fetch on
    # top of the view's own `get_object_or_404`.
    project_row_reads = [
        q
        for q in ctx.captured_queries
        if 'FROM "projects_project"' in q["sql"] and 'SELECT 1 AS "a"' not in q["sql"]
    ]
    assert len(project_row_reads) == 1, (
        f"expected exactly the view's own project fetch, got {len(project_row_reads)} — "
        "pref.project is being lazy-loaded, so the view is no longer priming the FK cache"
    )
