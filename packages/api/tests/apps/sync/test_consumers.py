"""Tests for the WebSocket ProjectConsumer."""

from __future__ import annotations

from contextlib import ExitStack
from datetime import date
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from channels.db import database_sync_to_async
from django.contrib.auth import get_user_model

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project
from trueppm_api.apps.sync.ws_auth import WsAuthResult

User = get_user_model()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_scope(project_pk: str, token: str = "") -> dict:
    """Build a minimal ASGI scope dict for a WebSocket connection."""
    query_string = f"token={token}".encode() if token else b""
    return {
        "type": "websocket",
        "path": f"/ws/v1/projects/{project_pk}/",
        "query_string": query_string,
        "url_route": {"kwargs": {"pk": project_pk}},
        "headers": [],
    }


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="ws_user", password="pw")


@pytest.fixture
def viewer_user(db: object) -> object:
    return User.objects.create_user(username="ws_viewer", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="WS Proj", start_date=date(2026, 1, 1), calendar=calendar)


# ---------------------------------------------------------------------------
# Consumer unit tests — patch the async channel layer
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.asyncio
async def test_connect_no_token_rejected(project: Project) -> None:
    """Connection without ?token= is rejected with close code 4001."""
    from trueppm_api.apps.sync.consumers import ProjectConsumer

    scope = _make_scope(str(project.pk), token="")
    consumer = ProjectConsumer()
    consumer.scope = scope
    consumer.channel_layer = AsyncMock()
    consumer.channel_name = "test.channel"

    close_mock = AsyncMock()
    consumer.close = close_mock

    await consumer.websocket_connect({"type": "websocket.connect"})
    close_mock.assert_called_once_with(code=4001)


@pytest.mark.django_db
@pytest.mark.asyncio
async def test_connect_invalid_token_rejected(project: Project, settings: Any) -> None:
    """Connection with an invalid JWT is rejected with close code 4001.

    Exercises the legacy ?token= path itself, so the opt-in flag is enabled here
    (#1723) — with it off the token is ignored entirely, which also 4001s but for a
    different reason. This asserts the JWT validation branch still rejects garbage.
    """
    settings.TRUEPPM_WS_LEGACY_TOKEN_AUTH_ENABLED = True
    from trueppm_api.apps.sync.consumers import ProjectConsumer

    scope = _make_scope(str(project.pk), token="not.a.valid.jwt")
    consumer = ProjectConsumer()
    consumer.scope = scope
    consumer.channel_layer = AsyncMock()
    consumer.channel_name = "test.channel"

    close_mock = AsyncMock()
    consumer.close = close_mock

    await consumer.websocket_connect({"type": "websocket.connect"})
    close_mock.assert_called_once_with(code=4001)


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_connect_inactive_user_rejected(project: Project, settings: Any) -> None:
    """A deactivated user with an otherwise-valid JWT cannot connect (#888).

    _authenticate resolves the user with is_active=True; a JWT issued before the
    account was disabled must no longer resolve, so the socket is rejected (4001)
    instead of streaming board events to a deactivated account.

    The is_active filter lives on the legacy ?token= path, so the opt-in flag is
    enabled here (#1723) to exercise it directly.
    """
    settings.TRUEPPM_WS_LEGACY_TOKEN_AUTH_ENABLED = True
    from rest_framework_simplejwt.tokens import AccessToken

    inactive = await database_sync_to_async(User.objects.create_user)(
        username="ws_inactive", password="pw", is_active=False
    )
    # A genuine, unexpired access token for the now-inactive user.
    token = await database_sync_to_async(lambda u: str(AccessToken.for_user(u)))(inactive)

    from trueppm_api.apps.sync.consumers import ProjectConsumer

    scope = _make_scope(str(project.pk), token=token)
    consumer = ProjectConsumer()
    consumer.scope = scope
    consumer.channel_layer = AsyncMock()
    consumer.channel_name = "test.channel"
    close_mock = AsyncMock()
    consumer.close = close_mock

    await consumer.websocket_connect({"type": "websocket.connect"})

    # _authenticate returned None (inactive filtered out) → 4001.
    close_mock.assert_called_once_with(code=4001)


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_connect_viewer_rejected(user: object, project: Project) -> None:
    """A Viewer (role == Role.VIEWER) cannot connect to the WebSocket."""
    await database_sync_to_async(ProjectMembership.objects.create)(
        project=project, user=user, role=Role.VIEWER
    )

    from trueppm_api.apps.sync.consumers import ProjectConsumer

    scope = _make_scope(str(project.pk), token="valid.token")
    consumer = ProjectConsumer()
    consumer.scope = scope
    consumer.channel_layer = AsyncMock()
    consumer.channel_name = "test.channel"

    close_mock = AsyncMock()
    consumer.close = close_mock

    # Patch _authenticate to return the user, _get_role to return VIEWER.
    with (
        patch(
            "trueppm_api.apps.sync.consumers.authenticate_scope",
            new=AsyncMock(return_value=WsAuthResult(user=user, via="ticket")),
        ),
        patch.object(consumer, "_get_role", new=AsyncMock(return_value=Role.VIEWER)),
    ):
        await consumer.websocket_connect({"type": "websocket.connect"})

    close_mock.assert_called_once_with(code=4003)


@pytest.mark.django_db
@pytest.mark.asyncio
async def test_connect_non_member_rejected(user: object, project: Project) -> None:
    """A user with no membership cannot connect."""
    from trueppm_api.apps.sync.consumers import ProjectConsumer

    scope = _make_scope(str(project.pk), token="valid.token")
    consumer = ProjectConsumer()
    consumer.scope = scope
    consumer.channel_layer = AsyncMock()
    consumer.channel_name = "test.channel"

    close_mock = AsyncMock()
    consumer.close = close_mock

    with (
        patch(
            "trueppm_api.apps.sync.consumers.authenticate_scope",
            new=AsyncMock(return_value=WsAuthResult(user=user, via="ticket")),
        ),
        patch.object(consumer, "_get_role", new=AsyncMock(return_value=None)),
    ):
        await consumer.websocket_connect({"type": "websocket.connect"})

    close_mock.assert_called_once_with(code=4003)


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_connect_member_accepted(user: object, project: Project) -> None:
    """A Member (role == Role.MEMBER) can connect and is added to the project group."""
    await database_sync_to_async(ProjectMembership.objects.create)(
        project=project, user=user, role=Role.MEMBER
    )

    from trueppm_api.apps.sync.consumers import ProjectConsumer

    scope = _make_scope(str(project.pk), token="valid.token")
    consumer = ProjectConsumer()
    consumer.scope = scope
    channel_layer = AsyncMock()
    consumer.channel_layer = channel_layer
    consumer.channel_name = "test.channel"

    # Patch super().websocket_connect to avoid needing a full ASGI setup.
    super_connect = AsyncMock()
    close_mock = AsyncMock()
    consumer.close = close_mock

    mock_redis = AsyncMock()
    mock_redis.hset = AsyncMock()
    mock_redis.expire = AsyncMock()

    with (
        patch(
            "trueppm_api.apps.sync.consumers.authenticate_scope",
            new=AsyncMock(return_value=WsAuthResult(user=user, via="ticket")),
        ),
        patch.object(consumer, "_get_role", new=AsyncMock(return_value=Role.MEMBER)),
        patch(
            "channels.generic.websocket.AsyncJsonWebsocketConsumer.websocket_connect",
            new=super_connect,
        ),
        patch(
            "trueppm_api.apps.sync.consumers.ProjectConsumer._get_redis",
            new=AsyncMock(return_value=mock_redis),
        ),
        patch("trueppm_api.apps.sync.broadcast.abroadcast_board_event", new=AsyncMock()),
    ):
        await consumer.websocket_connect({"type": "websocket.connect"})

    # Must not have closed.
    close_mock.assert_not_called()
    # Must have joined the project group.
    channel_layer.group_add.assert_called_once_with(f"project_{project.pk}", "test.channel")


# ---------------------------------------------------------------------------
# Connect-gate RBAC with the REAL membership query (#1507)
#
# The connect tests above patch _get_role to a fixed ordinal, so the production
# query in ProjectConsumer._get_role
# (ProjectMembership.objects.get(project_id=pk, user=u, is_deleted=False)) had
# zero unmocked coverage. These tests create real ProjectMembership rows and
# patch ONLY authenticate_scope, leaving _get_role to hit the DB — so dropping
# the is_deleted=False filter or mis-scoping the project (a WS-surface IDOR)
# fails CI. Mirrors the REST analogue in test_rbac.py:369-376.
# ---------------------------------------------------------------------------


def _stack(patches: list) -> ExitStack:
    """Enter a list of patch context managers under a single ExitStack."""
    stack = ExitStack()
    for p in patches:
        stack.enter_context(p)
    return stack


def _connect_ctx(user: object) -> list:
    """Patches for a connect that reaches super().websocket_connect without a
    live ASGI/Redis stack, while leaving ProjectConsumer._get_role real."""
    mock_redis = AsyncMock()
    mock_redis.hset = AsyncMock()
    mock_redis.expire = AsyncMock()
    return [
        patch(
            "trueppm_api.apps.sync.consumers.authenticate_scope",
            new=AsyncMock(return_value=WsAuthResult(user=user, via="ticket")),
        ),
        patch(
            "channels.generic.websocket.AsyncJsonWebsocketConsumer.websocket_connect",
            new=AsyncMock(),
        ),
        patch(
            "trueppm_api.apps.sync.consumers.ProjectConsumer._get_redis",
            new=AsyncMock(return_value=mock_redis),
        ),
        patch("trueppm_api.apps.sync.broadcast.abroadcast_board_event", new=AsyncMock()),
    ]


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_connect_member_accepted_real_role_query(user: object, project: Project) -> None:
    """A real Member membership row is resolved by the unmocked _get_role and accepted."""
    await database_sync_to_async(ProjectMembership.objects.create)(
        project=project, user=user, role=Role.MEMBER
    )

    from trueppm_api.apps.sync.consumers import ProjectConsumer

    consumer = ProjectConsumer()
    consumer.scope = _make_scope(str(project.pk), token="valid.token")
    channel_layer = AsyncMock()
    consumer.channel_layer = channel_layer
    consumer.channel_name = "test.channel"
    close_mock = AsyncMock()
    consumer.close = close_mock

    with _stack(_connect_ctx(user)):
        await consumer.websocket_connect({"type": "websocket.connect"})

    close_mock.assert_not_called()
    channel_layer.group_add.assert_called_once_with(f"project_{project.pk}", "test.channel")


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_connect_viewer_rejected_real_role_query(
    viewer_user: object, project: Project
) -> None:
    """A real Viewer membership (role < MEMBER) is resolved by _get_role and rejected 4003."""
    await database_sync_to_async(ProjectMembership.objects.create)(
        project=project, user=viewer_user, role=Role.VIEWER
    )

    from trueppm_api.apps.sync.consumers import ProjectConsumer

    consumer = ProjectConsumer()
    consumer.scope = _make_scope(str(project.pk), token="valid.token")
    consumer.channel_layer = AsyncMock()
    consumer.channel_name = "test.channel"
    close_mock = AsyncMock()
    consumer.close = close_mock

    with _stack(_connect_ctx(viewer_user)):
        await consumer.websocket_connect({"type": "websocket.connect"})

    close_mock.assert_called_once_with(code=4003)
    consumer.channel_layer.group_add.assert_not_called()


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_connect_non_member_rejected_real_role_query(user: object, project: Project) -> None:
    """A user with no membership row at all is rejected 4003 by the real query (None)."""
    from trueppm_api.apps.sync.consumers import ProjectConsumer

    consumer = ProjectConsumer()
    consumer.scope = _make_scope(str(project.pk), token="valid.token")
    consumer.channel_layer = AsyncMock()
    consumer.channel_name = "test.channel"
    close_mock = AsyncMock()
    consumer.close = close_mock

    with _stack(_connect_ctx(user)):
        await consumer.websocket_connect({"type": "websocket.connect"})

    close_mock.assert_called_once_with(code=4003)
    consumer.channel_layer.group_add.assert_not_called()


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_connect_soft_deleted_member_rejected_real_role_query(
    user: object, project: Project
) -> None:
    """A soft-deleted (evicted) Member membership must NOT connect (#1507 WS IDOR).

    The is_deleted=False filter in _get_role is the only thing standing between a
    soft-removed member and a live board-event stream. Dropping it makes this
    test fail rather than passing green CI.
    """
    await database_sync_to_async(ProjectMembership.objects.create)(
        project=project, user=user, role=Role.MEMBER, is_deleted=True
    )

    from trueppm_api.apps.sync.consumers import ProjectConsumer

    consumer = ProjectConsumer()
    consumer.scope = _make_scope(str(project.pk), token="valid.token")
    consumer.channel_layer = AsyncMock()
    consumer.channel_name = "test.channel"
    close_mock = AsyncMock()
    consumer.close = close_mock

    with _stack(_connect_ctx(user)):
        await consumer.websocket_connect({"type": "websocket.connect"})

    close_mock.assert_called_once_with(code=4003)
    consumer.channel_layer.group_add.assert_not_called()


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_connect_membership_other_project_rejected_real_role_query(
    user: object, project: Project, calendar: Calendar
) -> None:
    """A Member of a DIFFERENT project cannot connect to this project (#1507 IDOR).

    The project_id scoping in _get_role must not leak: holding Member on project B
    grants nothing on project A.
    """
    other_project = await database_sync_to_async(Project.objects.create)(
        name="Other Proj", start_date=date(2026, 1, 1), calendar=calendar
    )
    await database_sync_to_async(ProjectMembership.objects.create)(
        project=other_project, user=user, role=Role.MEMBER
    )

    from trueppm_api.apps.sync.consumers import ProjectConsumer

    # Connecting to `project`, but membership is on `other_project`.
    consumer = ProjectConsumer()
    consumer.scope = _make_scope(str(project.pk), token="valid.token")
    consumer.channel_layer = AsyncMock()
    consumer.channel_name = "test.channel"
    close_mock = AsyncMock()
    consumer.close = close_mock

    with _stack(_connect_ctx(user)):
        await consumer.websocket_connect({"type": "websocket.connect"})

    close_mock.assert_called_once_with(code=4003)
    consumer.channel_layer.group_add.assert_not_called()


# ---------------------------------------------------------------------------
# Direct unit tests of the production _get_role query (#1507)
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_get_role_returns_role_for_active_membership(user: object, project: Project) -> None:
    """_get_role returns the stored ordinal for a live membership."""
    await database_sync_to_async(ProjectMembership.objects.create)(
        project=project, user=user, role=Role.MEMBER
    )

    from trueppm_api.apps.sync.consumers import ProjectConsumer

    role = await ProjectConsumer()._get_role(user, str(project.pk))
    assert role == Role.MEMBER


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_get_role_ignores_soft_deleted_membership(user: object, project: Project) -> None:
    """_get_role returns None for a soft-deleted membership (is_deleted=False filter)."""
    await database_sync_to_async(ProjectMembership.objects.create)(
        project=project, user=user, role=Role.MEMBER, is_deleted=True
    )

    from trueppm_api.apps.sync.consumers import ProjectConsumer

    role = await ProjectConsumer()._get_role(user, str(project.pk))
    assert role is None


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_get_role_scoped_to_project(
    user: object, project: Project, calendar: Calendar
) -> None:
    """_get_role does not leak a membership on another project onto this one."""
    other_project = await database_sync_to_async(Project.objects.create)(
        name="Other Proj", start_date=date(2026, 1, 1), calendar=calendar
    )
    await database_sync_to_async(ProjectMembership.objects.create)(
        project=other_project, user=user, role=Role.MEMBER
    )

    from trueppm_api.apps.sync.consumers import ProjectConsumer

    role = await ProjectConsumer()._get_role(user, str(project.pk))
    assert role is None


@pytest.mark.django_db
@pytest.mark.asyncio
async def test_disconnect_leaves_group(user: object, project: Project) -> None:
    """Disconnecting removes the channel from the project group."""
    from trueppm_api.apps.sync.consumers import ProjectConsumer

    scope = _make_scope(str(project.pk), token="valid.token")
    consumer = ProjectConsumer()
    consumer.scope = scope
    channel_layer = AsyncMock()
    consumer.channel_layer = channel_layer
    consumer.channel_name = "test.channel"
    consumer.group_name = f"project_{project.pk}"
    # disconnect() also hits Redis for presence; no _user set → presence leave skipped.

    await consumer.disconnect(1000)

    channel_layer.group_discard.assert_called_once_with(f"project_{project.pk}", "test.channel")


@pytest.mark.django_db
@pytest.mark.asyncio
async def test_board_event_forwarded_to_client(user: object, project: Project) -> None:
    """board.event channel messages are forwarded to the WebSocket client."""
    from trueppm_api.apps.sync.consumers import ProjectConsumer

    scope = _make_scope(str(project.pk), token="valid.token")
    consumer = ProjectConsumer()
    consumer.scope = scope
    consumer.channel_layer = AsyncMock()
    consumer.channel_name = "test.channel"
    consumer.group_name = f"project_{project.pk}"

    sent: list[dict] = []

    async def _send_json(content: dict, close: bool = False) -> None:
        sent.append(content)

    consumer.send_json = _send_json  # type: ignore[method-assign]

    event = {
        "type": "board.event",
        "event_type": "cpm_complete",
        "payload": {"project_finish": "2026-06-01"},
    }
    await consumer.board_event(event)

    assert len(sent) == 1
    assert sent[0]["event_type"] == "cpm_complete"
    assert sent[0]["payload"]["project_finish"] == "2026-06-01"
    # The wire envelope carries the protocol version (#1325) so clients can branch
    # on it without a future handshake; defaulted here since the inbound channel
    # message predates the field.
    assert sent[0]["protocol_version"] == 1


@pytest.mark.django_db
@pytest.mark.asyncio
async def test_board_event_on_closed_socket_is_dropped(user: object, project: Project) -> None:
    """A board.event dispatched after the socket closed is swallowed, not raised.

    Reproduces the fanout/disconnect race: a group_send reaches the channel
    after the client disconnected, so the underlying send_json raises the ASGI
    'send after close' RuntimeError. board_event must drop it rather than let it
    bubble up as an unhandled ASGI application exception.
    """
    from trueppm_api.apps.sync.consumers import ProjectConsumer

    scope = _make_scope(str(project.pk), token="valid.token")
    consumer = ProjectConsumer()
    consumer.scope = scope
    consumer.channel_layer = AsyncMock()
    consumer.channel_name = "test.channel"
    consumer.group_name = f"project_{project.pk}"
    consumer.project_pk = str(project.pk)

    async def _send_json_closed(content: dict, close: bool = False) -> None:
        raise RuntimeError(
            "Unexpected ASGI message 'websocket.send', after sending "
            "'websocket.close' or response already completed."
        )

    consumer.send_json = _send_json_closed  # type: ignore[method-assign]

    event = {
        "type": "board.event",
        "event_type": "cpm_complete",
        "payload": {"project_finish": "2026-06-01"},
    }

    # Must not raise — the stale event is dropped.
    await consumer.board_event(event)


# ---------------------------------------------------------------------------
# Presence — join and leave broadcasts (#7)
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_presence_join_reaches_channel_layer_on_event_loop(
    user: object, project: Project
) -> None:
    """Regression for #958: the presence broadcast must reach the channel layer
    when fired from the consumer's running event loop.

    The helper is intentionally **not** mocked here — this exercises the real
    broadcast path on the asyncio loop. The original sync ``broadcast_board_event``
    wrapped ``group_send`` in ``async_to_sync``, which raises
    ``RuntimeError: cannot use AsyncToSync in the same thread as an async event
    loop``; the helper swallowed it, so ``group_send`` was never reached and the
    presence_join event silently vanished. Asserting the layer actually received
    the envelope guards against re-introducing the sync helper here.
    """

    class _FakeAsyncLayer:
        def __init__(self) -> None:
            self.sent: list[tuple[str, dict]] = []

        async def group_send(self, group: str, message: dict) -> None:
            self.sent.append((group, message))

    layer = _FakeAsyncLayer()

    from trueppm_api.apps.sync.consumers import ProjectConsumer

    consumer = ProjectConsumer()
    consumer.project_pk = str(project.pk)
    consumer._user = user  # type: ignore[attr-defined]
    consumer._display_name = user.username  # type: ignore[attr-defined]

    mock_redis = AsyncMock()
    mock_redis.hset = AsyncMock()
    mock_redis.expire = AsyncMock()

    with (
        patch(
            "trueppm_api.apps.sync.consumers.ProjectConsumer._get_redis",
            new=AsyncMock(return_value=mock_redis),
        ),
        patch("channels.layers.get_channel_layer", return_value=layer),
    ):
        await consumer._presence_join()

    assert len(layer.sent) == 1
    group, message = layer.sent[0]
    assert group == f"project_{project.pk}"
    assert message["type"] == "board.event"
    assert message["event_type"] == "presence_join"
    assert message["payload"]["user_id"] == str(user.pk)  # type: ignore[attr-defined]


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_presence_join_broadcast_on_connect(user: object, project: Project) -> None:
    """When a user connects, a presence_join event is broadcast to the project group."""
    await database_sync_to_async(ProjectMembership.objects.create)(
        project=project, user=user, role=Role.MEMBER
    )

    from trueppm_api.apps.sync.consumers import ProjectConsumer

    scope = _make_scope(str(project.pk), token="valid.token")
    consumer = ProjectConsumer()
    consumer.scope = scope
    channel_layer = AsyncMock()
    consumer.channel_layer = channel_layer
    consumer.channel_name = "test.channel"

    super_connect = AsyncMock()
    consumer.close = AsyncMock()

    broadcast_calls: list[dict] = []

    def _mock_broadcast(project_id: str, event_type: str, payload: dict) -> None:
        broadcast_calls.append({"event_type": event_type, "payload": payload})

    mock_redis = AsyncMock()
    mock_redis.hset = AsyncMock()
    mock_redis.expire = AsyncMock()

    with (
        patch(
            "trueppm_api.apps.sync.consumers.authenticate_scope",
            new=AsyncMock(return_value=WsAuthResult(user=user, via="ticket")),
        ),
        patch.object(consumer, "_get_role", new=AsyncMock(return_value=Role.MEMBER)),
        patch(
            "channels.generic.websocket.AsyncJsonWebsocketConsumer.websocket_connect",
            new=super_connect,
        ),
        patch(
            "trueppm_api.apps.sync.consumers.ProjectConsumer._get_redis",
            new=AsyncMock(return_value=mock_redis),
        ),
        patch(
            "trueppm_api.apps.sync.broadcast.abroadcast_board_event",
            new_callable=AsyncMock,
            side_effect=_mock_broadcast,
        ),
    ):
        await consumer.websocket_connect({"type": "websocket.connect"})

    join_events = [c for c in broadcast_calls if c["event_type"] == "presence_join"]
    assert len(join_events) == 1
    assert join_events[0]["payload"]["user_id"] == str(user.pk)  # type: ignore[attr-defined]


@pytest.mark.django_db
@pytest.mark.asyncio
async def test_presence_leave_broadcast_on_disconnect(user: object, project: Project) -> None:
    """When a user disconnects, a presence_leave event is broadcast to the project group."""
    from trueppm_api.apps.sync.consumers import ProjectConsumer

    scope = _make_scope(str(project.pk), token="valid.token")
    consumer = ProjectConsumer()
    consumer.scope = scope
    channel_layer = AsyncMock()
    consumer.channel_layer = channel_layer
    consumer.channel_name = "test.channel"
    consumer.group_name = f"project_{project.pk}"
    consumer.project_pk = str(project.pk)
    consumer._user = user
    consumer._display_name = user.username  # type: ignore[attr-defined]

    broadcast_calls: list[dict] = []

    def _mock_broadcast(project_id: str, event_type: str, payload: dict) -> None:
        broadcast_calls.append({"event_type": event_type, "payload": payload})

    mock_redis = AsyncMock()
    mock_redis.hdel = AsyncMock()

    with (
        patch(
            "trueppm_api.apps.sync.consumers.ProjectConsumer._get_redis",
            new=AsyncMock(return_value=mock_redis),
        ),
        patch(
            "trueppm_api.apps.sync.broadcast.abroadcast_board_event",
            new_callable=AsyncMock,
            side_effect=_mock_broadcast,
        ),
    ):
        await consumer.disconnect(1000)

    leave_events = [c for c in broadcast_calls if c["event_type"] == "presence_leave"]
    assert len(leave_events) == 1
    assert leave_events[0]["payload"]["user_id"] == str(user.pk)  # type: ignore[attr-defined]
    # Presence entry must be removed from Redis.
    mock_redis.hdel.assert_called_once()


# ---------------------------------------------------------------------------
# Mid-session eviction on membership revocation (#813)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.asyncio
async def test_connection_evict_closes_matching_user(user: object, project: Project) -> None:
    """A connection.evict for this socket's user closes it with code 4003."""
    from trueppm_api.apps.sync.consumers import ProjectConsumer

    consumer = ProjectConsumer()
    consumer.scope = _make_scope(str(project.pk), token="valid.token")
    consumer.channel_layer = AsyncMock()
    consumer.channel_name = "test.channel"
    consumer._user = user  # type: ignore[attr-defined]
    consumer.close = AsyncMock()  # type: ignore[method-assign]

    await consumer.connection_evict({"type": "connection.evict", "user_id": str(user.pk)})  # type: ignore[attr-defined]

    consumer.close.assert_awaited_once_with(code=4003)


@pytest.mark.django_db
@pytest.mark.asyncio
async def test_connection_evict_ignores_other_user(user: object, project: Project) -> None:
    """A connection.evict for a different user leaves this socket open."""
    from trueppm_api.apps.sync.consumers import ProjectConsumer

    consumer = ProjectConsumer()
    consumer.channel_layer = AsyncMock()
    consumer._user = user  # type: ignore[attr-defined]
    consumer.close = AsyncMock()  # type: ignore[method-assign]

    await consumer.connection_evict(
        {"type": "connection.evict", "user_id": "00000000-0000-0000-0000-000000000000"}
    )

    consumer.close.assert_not_awaited()


# ---------------------------------------------------------------------------
# Heartbeat: receive_json refreshes the presence TTL (#784)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.asyncio
async def test_receive_json_heartbeat_refreshes_presence_ttl(
    user: object, project: Project
) -> None:
    """Any inbound client message resets the presence key's expiry so an open but
    idle socket is not evicted (``receive_json`` → ``_presence_heartbeat``)."""
    from trueppm_api.apps.sync.consumers import (
        _PRESENCE_TTL,
        ProjectConsumer,
        _presence_key,
    )

    consumer = ProjectConsumer()
    consumer.project_pk = str(project.pk)
    consumer._user = user  # type: ignore[attr-defined]

    mock_redis = AsyncMock()
    mock_redis.expire = AsyncMock()

    with patch(
        "trueppm_api.apps.sync.consumers.ProjectConsumer._get_redis",
        new=AsyncMock(return_value=mock_redis),
    ):
        await consumer.receive_json({"type": "ping"})

    mock_redis.expire.assert_awaited_once_with(_presence_key(str(project.pk)), _PRESENCE_TTL)


@pytest.mark.django_db
@pytest.mark.asyncio
async def test_receive_json_without_user_is_a_noop(project: Project) -> None:
    """A message that arrives before the handshake bound ``_user`` must not touch
    Redis — the ``hasattr(self, "_user")`` guard short-circuits the heartbeat."""
    from trueppm_api.apps.sync.consumers import ProjectConsumer

    consumer = ProjectConsumer()
    consumer.project_pk = str(project.pk)

    get_redis = AsyncMock()
    with patch(
        "trueppm_api.apps.sync.consumers.ProjectConsumer._get_redis",
        new=get_redis,
    ):
        await consumer.receive_json({"type": "ping"})

    get_redis.assert_not_awaited()


# ---------------------------------------------------------------------------
# Redis client lifecycle: one client per socket, closed on disconnect (#1530)
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_single_redis_client_reused_across_frames_and_closed_on_disconnect(
    user: object, project: Project
) -> None:
    """The consumer builds one Redis client for its lifetime and closes it (#1530).

    Regression for the presence connection leak: ``_get_redis`` previously called
    ``aioredis.from_url`` on every presence call (connect + every heartbeat frame)
    and nothing ever closed the resulting connection pools. This drives a real
    connect followed by three heartbeat frames and a disconnect, asserting
    ``from_url`` is invoked exactly once and the client's ``aclose`` runs on
    disconnect. ``_get_redis`` is deliberately NOT mocked so the caching + close
    lifecycle is the code under test; only ``aioredis.from_url`` is stubbed.
    """
    await database_sync_to_async(ProjectMembership.objects.create)(
        project=project, user=user, role=Role.MEMBER
    )

    from trueppm_api.apps.sync.consumers import ProjectConsumer

    consumer = ProjectConsumer()
    consumer.scope = _make_scope(str(project.pk), token="valid.token")
    consumer.channel_layer = AsyncMock()
    consumer.channel_name = "test.channel"
    consumer.close = AsyncMock()

    # aioredis.from_url is synchronous and returns the client; the client's async
    # methods (hset/expire/hdel/aclose) are awaited, so the client is an AsyncMock.
    mock_client = AsyncMock()
    from_url_mock = MagicMock(return_value=mock_client)

    with (
        patch(
            "trueppm_api.apps.sync.consumers.authenticate_scope",
            new=AsyncMock(return_value=WsAuthResult(user=user, via="ticket")),
        ),
        patch.object(consumer, "_get_role", new=AsyncMock(return_value=Role.MEMBER)),
        patch(
            "channels.generic.websocket.AsyncJsonWebsocketConsumer.websocket_connect",
            new=AsyncMock(),
        ),
        patch("trueppm_api.apps.sync.broadcast.abroadcast_board_event", new=AsyncMock()),
        patch("redis.asyncio.from_url", new=from_url_mock),
    ):
        await consumer.websocket_connect({"type": "websocket.connect"})
        await consumer.receive_json({"type": "ping"})
        await consumer.receive_json({"type": "ping"})
        await consumer.receive_json({"type": "ping"})

        # One client for connect + three heartbeat frames — no per-call leak.
        from_url_mock.assert_called_once()
        mock_client.aclose.assert_not_awaited()

        await consumer.disconnect(1000)

    # The single client is closed exactly once on disconnect.
    mock_client.aclose.assert_awaited_once()


@pytest.mark.django_db
@pytest.mark.asyncio
async def test_disconnect_before_connect_does_not_close_missing_client(
    project: Project,
) -> None:
    """disconnect() must not blow up when no Redis client was ever created.

    A socket rejected during the handshake never reaches a presence call, so
    ``self._redis`` is unset; the ``getattr(..., None)`` guard skips the close.
    """
    from trueppm_api.apps.sync.consumers import ProjectConsumer

    consumer = ProjectConsumer()
    consumer.scope = _make_scope(str(project.pk), token="valid.token")
    consumer.channel_layer = AsyncMock()
    consumer.channel_name = "test.channel"

    # Must not raise even though no group/user/redis lifecycle ran.
    await consumer.disconnect(1000)


# ---------------------------------------------------------------------------
# WebSocket event replay (ADR-0236, #321)
#
# ProjectConsumer._replay_missed_events streams buffered BoardEvent rows with
# seq > since on reconnect, scoped to the connecting project, and falls back to a
# resync_required frame when the requested point aged out of retention.
# ---------------------------------------------------------------------------


def _make_scope_since(project_pk: str, since: int) -> dict:
    """Scope dict carrying ?ticket=&since= (authenticate_scope is patched away)."""
    return {
        "type": "websocket",
        "path": f"/ws/v1/projects/{project_pk}/",
        "query_string": f"ticket=valid&since={since}".encode(),
        "url_route": {"kwargs": {"pk": project_pk}},
        "headers": [],
    }


async def _connect_capturing(project_pk: str, user: object, since: int) -> list[dict]:
    """Drive a member connect with ?since= and return the frames send_json emitted."""
    from trueppm_api.apps.sync.consumers import ProjectConsumer

    consumer = ProjectConsumer()
    consumer.scope = _make_scope_since(project_pk, since)
    consumer.channel_layer = AsyncMock()
    consumer.channel_name = "test.channel"
    consumer.close = AsyncMock()

    sent: list[dict] = []

    async def _send_json(content: dict, close: bool = False) -> None:
        sent.append(content)

    consumer.send_json = _send_json  # type: ignore[method-assign]

    with _stack(_connect_ctx(user)):
        await consumer.websocket_connect({"type": "websocket.connect"})
    return sent


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_replay_streams_missed_events_scoped_to_project(
    user: object, project: Project, calendar: Calendar
) -> None:
    """?since=N replays this project's BoardEvents with seq > N, in order, and no other's."""
    await database_sync_to_async(ProjectMembership.objects.create)(
        project=project, user=user, role=Role.MEMBER
    )
    other = await database_sync_to_async(Project.objects.create)(
        name="Other", start_date=date(2026, 1, 1), calendar=calendar
    )

    from trueppm_api.apps.sync.models import BoardEvent

    make = database_sync_to_async(BoardEvent.objects.create)
    e1 = await make(project=project, event_type="task_created", payload={"id": "t1"})
    e2 = await make(project=project, event_type="task_updated", payload={"id": "t1"})
    e3 = await make(project=project, event_type="task_deleted", payload={"id": "t1"})
    # An event on a different project must never appear in this replay (no IDOR).
    await make(project=other, event_type="task_created", payload={"id": "x1"})

    sent = await _connect_capturing(str(project.pk), user, since=e1.pk)

    replayed = [f for f in sent if f.get("replayed")]
    assert [f["seq"] for f in replayed] == [e2.pk, e3.pk]
    assert [f["event_type"] for f in replayed] == ["task_updated", "task_deleted"]
    assert all(f["event_type"] != "resync_required" for f in sent)


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_replay_sends_resync_when_since_predates_retention(
    user: object, project: Project
) -> None:
    """A ?since= older than the oldest surviving row yields resync_required, not partial replay."""
    await database_sync_to_async(ProjectMembership.objects.create)(
        project=project, user=user, role=Role.MEMBER
    )

    from trueppm_api.apps.sync.models import BoardEvent

    make = database_sync_to_async(BoardEvent.objects.create)
    e1 = await make(project=project, event_type="task_created", payload={"id": "t1"})
    e2 = await make(project=project, event_type="task_updated", payload={"id": "t1"})
    e3 = await make(project=project, event_type="task_deleted", payload={"id": "t1"})

    # Simulate the purge trimming the contiguous low-id prefix: delete the two
    # oldest so the smallest surviving id is e3. A client that had only seen up to
    # e1 now has a gap it can't stream — expect resync.
    await database_sync_to_async(BoardEvent.objects.filter(pk__in=[e1.pk, e2.pk]).delete)()

    # e1,e2,e3 are consecutive ids, so (e3 - 2) == e1 — a positive `since` that is
    # strictly below the oldest surviving id (e3), the resync trigger. Derived from
    # e3 (never 0) rather than e1-1, which would be 0 on a fresh PK sequence and
    # skip replay entirely.
    sent = await _connect_capturing(str(project.pk), user, since=e3.pk - 2)

    resync = [f for f in sent if f["event_type"] == "resync_required"]
    assert len(resync) == 1
    assert resync[0]["payload"]["latest_seq"] == e3.pk
    assert not [f for f in sent if f.get("replayed")]


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_no_since_skips_replay_entirely(user: object, project: Project) -> None:
    """A fresh connect (since=0) streams no replay frames — REST provides current state."""
    await database_sync_to_async(ProjectMembership.objects.create)(
        project=project, user=user, role=Role.MEMBER
    )

    from trueppm_api.apps.sync.models import BoardEvent

    await database_sync_to_async(BoardEvent.objects.create)(
        project=project, event_type="task_created", payload={"id": "t1"}
    )

    sent = await _connect_capturing(str(project.pk), user, since=0)
    assert sent == []
