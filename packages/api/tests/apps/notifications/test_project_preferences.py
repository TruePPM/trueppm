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
    PROJECT_NOTIFICATION_DELIVERABLE_CHANNELS,
    PROJECT_NOTIFICATION_DISPATCHED_EVENTS,
    PROJECT_NOTIFICATION_UNDELIVERABLE_CHANNELS,
    PROJECT_NOTIFICATION_UNDISPATCHED_EVENTS,
    ProjectNotificationChannel,
    ProjectNotificationEventType,
    ProjectNotificationPreference,
    project_notification_channel_delivery,
    project_notification_event_delivery,
)
from trueppm_api.apps.projects.models import Calendar, Project

from ...test_openapi_response_conformance import (
    assert_declared_properties_match_body,
    assert_response_matches_schema,
    declared_object_properties,
    load_committed_schema,
)

User = get_user_model()

#: Templated OpenAPI path — the key `docs/api/openapi.json` is indexed by.
PREF_PATH = "/api/v1/projects/{id}/notification-preferences/"


@pytest.fixture(scope="module")
def committed_schema() -> dict:
    """The published contract, parsed once — it is a multi-megabyte document."""
    return load_committed_schema()


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


def test_a_viewer_may_read_and_write_their_own_routing(project: Project, memberships: dict) -> None:
    """The endpoint's real lower bound, pinned.

    ``IsProjectMember`` admits Viewer, deliberately: ADR-0075 gives every member
    their own notification contract, so someone who can change nothing else on the
    project must still be able to silence it. Nothing else in this file would fail if
    a future change tightened this to a write-role gate — both existing fixture users
    are MEMBER, and the only 403 cases are non-members.
    """
    viewer = User.objects.create_user(username="dana", password="pw")
    ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)
    client = APIClient()
    client.force_authenticate(user=viewer)

    assert client.get(_url(project)).status_code == 200

    response = client.patch(_url(project), {"paused": True}, format="json")
    assert response.status_code == 200
    assert response.json()["paused"] is True

    # And a matrix cell: `paused` is a plain BooleanField, while the matrix goes
    # through the nested field's own validation, so a gate could tighten on one
    # without the other.
    matrix_write = client.patch(
        _url(project),
        {"matrix": {ProjectNotificationEventType.COMMENT_MENTION: {"email": False}}},
        format="json",
    )
    assert matrix_write.status_code == 200
    row = matrix_write.json()["matrix"][ProjectNotificationEventType.COMMENT_MENTION]
    assert row["email"] is False


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
# channel_delivery — which columns TruePPM delivers on at all (#3378)
# ---------------------------------------------------------------------------


def test_get_reports_which_channels_deliver(
    alice_client: APIClient, project: Project, memberships: dict
) -> None:
    """The per-column twin of ``event_delivery``, and for the same reason.

    The web client was hard-coding ``['slack', 'mobile_push']`` with its own comment
    saying the copy should not survive. Whether a channel delivers is server state,
    so a client-side copy drifts the moment a delivery path lands.
    """
    body = alice_client.get(_url(project)).json()

    delivery = body["channel_delivery"]
    assert set(delivery) == {member.value for member in ProjectNotificationChannel}
    for channel in sorted(PROJECT_NOTIFICATION_DELIVERABLE_CHANNELS):
        assert delivery[channel] is True
    for channel in sorted(PROJECT_NOTIFICATION_UNDELIVERABLE_CHANNELS):
        assert delivery[channel] is False, (
            f"{channel} is reported as delivering but nothing sends to it"
        )


def test_patch_echoes_channel_delivery(
    alice_client: APIClient, project: Project, memberships: dict
) -> None:
    """The PATCH echo assembles from the bound write serializer, so the map has to be
    injected there by hand. Omitting it would drop the column labels the moment a
    member toggled anything — the whole grid would silently re-arm."""
    response = alice_client.patch(
        _url(project),
        {"matrix": {ProjectNotificationEventType.COMMENT_MENTION: {"email": False}}},
        format="json",
    )

    assert response.status_code == 200
    assert response.json()["channel_delivery"] == project_notification_channel_delivery()


def test_a_stored_preference_still_round_trips_for_an_undeliverable_channel(
    alice_client: APIClient, project: Project, memberships: dict
) -> None:
    """Labeling a column must not make it read-only. The choice is kept so it applies
    when delivery ships (#3252) — the API just stops claiming it is live today."""
    event = ProjectNotificationEventType.COMMENT_MENTION
    response = alice_client.patch(
        _url(project), {"matrix": {event: {"slack": True}}}, format="json"
    )

    assert response.status_code == 200
    assert response.json()["matrix"][event]["slack"] is True
    assert response.json()["channel_delivery"]["slack"] is False


def test_channel_delivery_is_not_writable(
    alice_client: APIClient, project: Project, memberships: dict
) -> None:
    """A server capability claim must not be settable by the client that reads it.

    True by construction today — ``channel_delivery`` is a ``SerializerMethodField``
    on the DOCUMENT serializer, and PATCH binds its PARENT. But the subclassing runs
    the wrong way for safety: the document serializer inherits from the write
    serializer precisely so a new field reaches the response without a second edit,
    which means a field added to the parent becomes writable *and* published. Nothing
    else would fail if one of the delivery maps were promoted up there.
    """
    response = alice_client.patch(
        _url(project), {"channel_delivery": {"slack": True}}, format="json"
    )

    assert response.status_code == 200
    assert response.json()["channel_delivery"]["slack"] is False
    assert alice_client.get(_url(project)).json()["channel_delivery"]["slack"] is False


def test_event_delivery_is_not_writable_either(
    alice_client: APIClient, project: Project, memberships: dict
) -> None:
    """Twin of the pin above — same promotion risk, other axis.

    Pinning one delivery map and not the other is how the unpinned one moves.
    """
    response = alice_client.patch(
        _url(project),
        {"event_delivery": {ProjectNotificationEventType.SPRINT_START: True}},
        format="json",
    )

    assert response.status_code == 200
    assert response.json()["event_delivery"] == project_notification_event_delivery()
    assert (
        alice_client.get(_url(project)).json()["event_delivery"]
        == project_notification_event_delivery()
    )


def test_the_one_dispatched_event_does_not_default_an_undeliverable_channel_on(
    alice_client: APIClient, project: Project, memberships: dict
) -> None:
    """End-to-end version of the model-level guard. ``comment_mention`` IS dispatched,
    so #2904's event-axis guard passed it while it still arrived with Slack and mobile
    push ON — a claim that a mention would reach a channel that sends nothing."""
    matrix = alice_client.get(_url(project)).json()["matrix"]
    row = matrix[ProjectNotificationEventType.COMMENT_MENTION]

    for channel in sorted(PROJECT_NOTIFICATION_UNDELIVERABLE_CHANNELS):
        assert row[channel] is False, (
            f"comment_mention arrives ON for {channel} but nothing delivers on it"
        )


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


# ---------------------------------------------------------------------------
# The declared 200 vs. the body actually returned (#3396, #3399)
# ---------------------------------------------------------------------------
#
# Both methods published `"200": {"description": "No response body"}` while
# returning a full document — the view is a plain APIView with no
# `serializer_class`, so drf-spectacular had nothing to infer from. The obvious
# fix, `responses={200: ProjectNotificationPreferenceSerializer}`, would have been
# worse than the hole: `event_delivery` is added by the view and is not a
# serializer field, so the schema would have been self-consistent, drift-clean and
# missing the one key a client needs to label the rows nothing dispatches.
#
# These tests therefore assert the declaration against the real body from both
# ends: key-set equality (which catches the omission — JSON Schema ignores extra
# keys and would not) and full validation (which catches a wrong type or a value
# outside the four-member `quiet_hours_timezone_source` enum).


def test_get_body_matches_its_declared_schema(
    committed_schema: dict, alice_client: APIClient, project: Project, memberships: dict
) -> None:
    response = alice_client.get(_url(project))

    assert_declared_properties_match_body(committed_schema, response, PREF_PATH, "get")
    assert_response_matches_schema(committed_schema, response, PREF_PATH, "get")


def test_patch_body_matches_its_declared_schema(
    committed_schema: dict, alice_client: APIClient, project: Project, memberships: dict
) -> None:
    """PATCH assembles its payload from the bound write serializer, not the document
    serializer GET uses — the two must still publish the same document."""
    response = alice_client.patch(
        _url(project),
        {"matrix": {ProjectNotificationEventType.COMMENT_MENTION: {"email": False}}},
        format="json",
    )

    assert_declared_properties_match_body(committed_schema, response, PREF_PATH, "patch")
    assert_response_matches_schema(committed_schema, response, PREF_PATH, "patch")


def test_the_declared_document_names_event_delivery(
    committed_schema: dict, alice_client: APIClient, project: Project, memberships: dict
) -> None:
    """The pin, stated directly: the omission #3399 describes must not come back.

    Key-set equality above would fail if `event_delivery` were dropped from either
    side — but it would also pass if BOTH were dropped, which is how the endpoint
    got here. Naming the key explicitly means the schema cannot go quiet again by
    the view and the declaration agreeing on nothing.
    """
    declared = declared_object_properties(committed_schema, PREF_PATH, "get")

    assert "event_delivery" in declared
    assert "event_delivery" in alice_client.get(_url(project)).json()


def test_declared_event_delivery_keys_are_the_classification_itself(
    committed_schema: dict,
) -> None:
    """The declaration is derived from the classification, not restated beside it.

    `project_notification_event_delivery` reports one boolean per
    `PROJECT_NOTIFICATION_DEFAULT_MATRIX`
    row, and the two halves of the classification must together cover the enum
    (`test_project_notification_dispatch_coverage` pins that). So adding an event
    type has to reach the published schema in the same edit — this is the #3399
    "pin it against PROJECT_NOTIFICATION_DISPATCHED_EVENTS" checkbox.
    """
    declared = set(
        committed_schema["components"]["schemas"]["ProjectNotificationPreferenceDocument"][
            "properties"
        ]["event_delivery"]["properties"]
    )

    assert declared == set(PROJECT_NOTIFICATION_DEFAULT_MATRIX)
    assert declared == (
        set(PROJECT_NOTIFICATION_DISPATCHED_EVENTS) | set(PROJECT_NOTIFICATION_UNDISPATCHED_EVENTS)
    )
    assert declared == set(project_notification_event_delivery())


def test_the_declared_document_names_channel_delivery(
    committed_schema: dict, alice_client: APIClient, project: Project, memberships: dict
) -> None:
    """Same pin as ``event_delivery`` one axis over: key-set equality would also pass
    if the key were dropped from BOTH the view and the declaration, which is how this
    endpoint went quiet the first time."""
    declared = declared_object_properties(committed_schema, PREF_PATH, "get")

    assert "channel_delivery" in declared
    assert "channel_delivery" in alice_client.get(_url(project)).json()


def test_declared_channel_delivery_keys_are_the_matrix_columns_themselves(
    committed_schema: dict,
) -> None:
    """The declaration is derived from the enum, not restated beside it — so adding a
    channel reaches the published schema in the same edit that adds the column."""
    declared = set(
        committed_schema["components"]["schemas"]["ProjectNotificationPreferenceDocument"][
            "properties"
        ]["channel_delivery"]["properties"]
    )

    assert declared == {member.value for member in ProjectNotificationChannel}
    assert declared == (
        set(PROJECT_NOTIFICATION_DELIVERABLE_CHANNELS)
        | set(PROJECT_NOTIFICATION_UNDELIVERABLE_CHANNELS)
    )
    assert declared == set(project_notification_channel_delivery())


def test_quiet_hours_timezone_source_is_published_as_a_closed_enum(
    committed_schema: dict,
) -> None:
    """`stability.md` promises that a new value on a non-exhaustive field is Additive.

    That guarantee is vacuous while the field is published as a bare string — a
    client has nothing to be non-exhaustive *about*. Four members, from the
    resolver's four tiers.
    """
    field = committed_schema["components"]["schemas"]["ProjectNotificationPreferenceDocument"][
        "properties"
    ]["quiet_hours_timezone_source"]
    ref = field.get("$ref") or field["allOf"][0]["$ref"]

    assert set(committed_schema["components"]["schemas"][ref.rsplit("/", 1)[-1]]["enum"]) == {
        "project",
        "workspace",
        "server",
        "fallback",
    }


def test_matrix_is_published_as_the_event_by_channel_grid(committed_schema: dict) -> None:
    """Typed, not an untyped object — the #3396 checkbox. The response side inherits
    the grid #3364 declared for the request side, from the same enums."""
    document = committed_schema["components"]["schemas"]["ProjectNotificationPreferenceDocument"]
    matrix = document["properties"]["matrix"]

    assert set(matrix["properties"]) == set(PROJECT_NOTIFICATION_DEFAULT_MATRIX)
    assert set(
        matrix["properties"][ProjectNotificationEventType.COMMENT_MENTION]["properties"]
    ) == {channel.value for channel in ProjectNotificationChannel}
