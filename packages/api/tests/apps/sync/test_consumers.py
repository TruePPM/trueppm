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
    """A Viewer (role=0) cannot connect to the WebSocket."""
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
    """A Member (role=1) can connect and is added to the project group."""
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

    with (
        patch.object(consumer, "_authenticate", new=AsyncMock(return_value=user)),
        patch.object(consumer, "_get_role", new=AsyncMock(return_value=Role.MEMBER)),
        patch(
            "channels.generic.websocket.AsyncJsonWebsocketConsumer.websocket_connect",
            new=super_connect,
        ),
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
