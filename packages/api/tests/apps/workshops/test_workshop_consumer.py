"""Tests for the WorkshopConsumer auth and receive_json hardening (#888, #895)."""

from __future__ import annotations

from datetime import date
from unittest.mock import AsyncMock, patch

import pytest
from channels.db import database_sync_to_async
from django.contrib.auth import get_user_model

from trueppm_api.apps.projects.models import Calendar, Project
from trueppm_api.apps.workshops.consumers import MAX_FRAME_BYTES, WorkshopConsumer

User = get_user_model()


def _make_scope(project_pk: str, token: str = "") -> dict:
    query_string = f"token={token}".encode() if token else b""
    return {
        "type": "websocket",
        "path": f"/ws/v1/projects/{project_pk}/workshop/",
        "query_string": query_string,
        "url_route": {"kwargs": {"pk": project_pk}},
        "headers": [],
    }


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="WS Proj", start_date=date(2026, 1, 1), calendar=calendar)


# ---------------------------------------------------------------------------
# #888 — inactive user cannot authenticate to the workshop socket
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_connect_inactive_user_rejected(project: Project) -> None:
    """A deactivated user with a valid JWT cannot connect to the workshop (#888)."""
    from rest_framework_simplejwt.tokens import AccessToken

    inactive = await database_sync_to_async(User.objects.create_user)(
        username="wsk_inactive", password="pw", is_active=False
    )
    token = await database_sync_to_async(lambda u: str(AccessToken.for_user(u)))(inactive)

    consumer = WorkshopConsumer()
    consumer.scope = _make_scope(str(project.pk), token=token)
    consumer.channel_layer = AsyncMock()
    consumer.channel_name = "test.channel"
    close_mock = AsyncMock()
    consumer.close = close_mock

    await consumer.websocket_connect({"type": "websocket.connect"})

    close_mock.assert_called_once_with(code=4001)


# ---------------------------------------------------------------------------
# #895 — receive_json DoS hardening (size cap, allowlist, rate limit)
# ---------------------------------------------------------------------------


def _ready_consumer(user: object, project: Project) -> WorkshopConsumer:
    """A consumer wired up as if it had already connected, ready to receive."""
    consumer = WorkshopConsumer()
    consumer.channel_layer = AsyncMock()
    consumer.channel_name = "test.channel"
    consumer.group_name = f"project_{project.pk}_workshop"
    consumer.project_pk = str(project.pk)
    consumer._user = user  # type: ignore[attr-defined]
    consumer._display_name = "Tester"  # type: ignore[attr-defined]
    return consumer


@pytest.mark.django_db
@pytest.mark.asyncio
async def test_receive_relays_known_event_type(user_obj: object, project: Project) -> None:
    """A known-type, in-size, under-limit frame is relayed (golden path)."""
    consumer = _ready_consumer(user_obj, project)
    with patch.object(consumer, "_allow_relay", new=AsyncMock(return_value=True)):
        await consumer.receive_json({"type": "cursor_move", "x": 1, "y": 2})

    consumer.channel_layer.group_send.assert_awaited_once()
    args = consumer.channel_layer.group_send.await_args
    relayed = args.args[1]["content"]
    assert relayed["type"] == "cursor_move"
    # Identity is stamped server-side, not trusted from the client.
    assert relayed["user_id"] == str(user_obj.pk)  # type: ignore[attr-defined]


@pytest.mark.django_db
@pytest.mark.asyncio
async def test_receive_drops_unknown_event_type(user_obj: object, project: Project) -> None:
    """An unknown top-level type is dropped, not amplified to the group (#895c)."""
    consumer = _ready_consumer(user_obj, project)
    with patch.object(consumer, "_allow_relay", new=AsyncMock(return_value=True)):
        await consumer.receive_json({"type": "exfiltrate", "blob": "x"})

    consumer.channel_layer.group_send.assert_not_awaited()


@pytest.mark.django_db
@pytest.mark.asyncio
async def test_receive_drops_oversize_frame(user_obj: object, project: Project) -> None:
    """A frame whose JSON exceeds MAX_FRAME_BYTES is dropped before fan-out (#895a)."""
    consumer = _ready_consumer(user_obj, project)
    big = {"type": "task_add", "payload": "A" * (MAX_FRAME_BYTES + 100)}
    with patch.object(consumer, "_allow_relay", new=AsyncMock(return_value=True)):
        await consumer.receive_json(big)

    consumer.channel_layer.group_send.assert_not_awaited()


@pytest.mark.django_db
@pytest.mark.asyncio
async def test_receive_drops_when_rate_limited(user_obj: object, project: Project) -> None:
    """When the per-user rate limit is exceeded the frame is dropped (#895b)."""
    consumer = _ready_consumer(user_obj, project)
    with patch.object(consumer, "_allow_relay", new=AsyncMock(return_value=False)):
        await consumer.receive_json({"type": "cursor_move", "x": 1})

    consumer.channel_layer.group_send.assert_not_awaited()


@pytest.mark.django_db
@pytest.mark.asyncio
async def test_receive_drops_non_dict_frame(user_obj: object, project: Project) -> None:
    """A non-object frame (e.g. a bare list) is dropped (#895c)."""
    consumer = _ready_consumer(user_obj, project)
    with patch.object(consumer, "_allow_relay", new=AsyncMock(return_value=True)):
        await consumer.receive_json(["not", "an", "object"])

    consumer.channel_layer.group_send.assert_not_awaited()


@pytest.fixture
def user_obj(db: object) -> object:
    return User.objects.create_user(username="wsk_relay", password="pw")
