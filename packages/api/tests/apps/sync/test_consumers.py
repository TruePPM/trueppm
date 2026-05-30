"""Tests for the WebSocket ProjectConsumer."""

from __future__ import annotations

from datetime import date
from unittest.mock import AsyncMock, patch

import pytest
from channels.db import database_sync_to_async
from django.contrib.auth import get_user_model

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project

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
async def test_connect_invalid_token_rejected(project: Project) -> None:
    """Connection with an invalid JWT is rejected with close code 4001."""
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
        patch.object(consumer, "_authenticate", new=AsyncMock(return_value=user)),
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
        patch.object(consumer, "_authenticate", new=AsyncMock(return_value=user)),
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
        patch.object(consumer, "_authenticate", new=AsyncMock(return_value=user)),
        patch.object(consumer, "_get_role", new=AsyncMock(return_value=Role.MEMBER)),
        patch(
            "channels.generic.websocket.AsyncJsonWebsocketConsumer.websocket_connect",
            new=super_connect,
        ),
        patch(
            "trueppm_api.apps.sync.consumers.ProjectConsumer._get_redis",
            new=AsyncMock(return_value=mock_redis),
        ),
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
    ):
        await consumer.websocket_connect({"type": "websocket.connect"})

    # Must not have closed.
    close_mock.assert_not_called()
    # Must have joined the project group.
    channel_layer.group_add.assert_called_once_with(f"project_{project.pk}", "test.channel")


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


# ---------------------------------------------------------------------------
# Presence — join and leave broadcasts (#7)
# ---------------------------------------------------------------------------


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
        patch.object(consumer, "_authenticate", new=AsyncMock(return_value=user)),
        patch.object(consumer, "_get_role", new=AsyncMock(return_value=Role.MEMBER)),
        patch(
            "channels.generic.websocket.AsyncJsonWebsocketConsumer.websocket_connect",
            new=super_connect,
        ),
        patch(
            "trueppm_api.apps.sync.consumers.ProjectConsumer._get_redis",
            new=AsyncMock(return_value=mock_redis),
        ),
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event", side_effect=_mock_broadcast),
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
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event", side_effect=_mock_broadcast),
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
