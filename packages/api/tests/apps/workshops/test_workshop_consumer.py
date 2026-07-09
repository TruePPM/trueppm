"""Tests for the WorkshopConsumer auth and receive_json hardening (#888, #895)."""

from __future__ import annotations

from contextlib import ExitStack
from datetime import date
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from channels.db import database_sync_to_async
from django.contrib.auth import get_user_model

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project
from trueppm_api.apps.sync.ws_auth import WsAuthResult
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
async def test_connect_inactive_user_rejected(project: Project, settings: Any) -> None:
    """A deactivated user with a valid JWT cannot connect to the workshop (#888).

    Exercises the legacy ?token= path's is_active filter, so the opt-in flag is
    enabled here (#1723) — with it off the token is ignored entirely, which also
    4001s but for a different reason and would leave this test vacuous.
    """
    settings.TRUEPPM_WS_LEGACY_TOKEN_AUTH_ENABLED = True
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
# #1507 — WorkshopConsumer authorization gates (role 4003, active-session 4004)
#
# consumers.py:111-118 enforces a Member-floor role gate and an active
# WorkshopSession gate, but no test exercised either — every receive/relay test
# pre-wires _ready_consumer past the gates. These connect tests create real DB
# rows and patch ONLY authenticate_scope, so deleting or inverting either gate
# (letting a Viewer/non-member join the live cursor/edit group, or connecting
# with no active session) fails CI instead of shipping green.
# ---------------------------------------------------------------------------


@pytest.fixture
def member_user(db: object) -> object:
    return User.objects.create_user(username="wsk_member", password="pw")


@pytest.fixture
def viewer_user(db: object) -> object:
    return User.objects.create_user(username="wsk_viewer", password="pw")


def _stack(patches: list) -> ExitStack:
    stack = ExitStack()
    for p in patches:
        stack.enter_context(p)
    return stack


def _auth_patches(user: object) -> list:
    """Patch only authenticate_scope; leave _get_role / _get_active_session real."""
    return [
        patch(
            "trueppm_api.apps.workshops.consumers.authenticate_scope",
            new=AsyncMock(return_value=WsAuthResult(user=user, via="ticket")),
        ),
        patch(
            "channels.generic.websocket.AsyncJsonWebsocketConsumer.websocket_connect",
            new=AsyncMock(),
        ),
        # _participant_join fires a sync broadcast via transaction.on_commit; stub
        # it so the happy-path connect test doesn't depend on a live channel layer.
        patch(
            "trueppm_api.apps.workshops.broadcast.broadcast_workshop_event",
            new=lambda **kwargs: None,
        ),
    ]


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_connect_viewer_rejected(viewer_user: object, project: Project) -> None:
    """A Viewer (role < MEMBER) cannot join the workshop group — close 4003 (#1507)."""
    await database_sync_to_async(ProjectMembership.objects.create)(
        project=project, user=viewer_user, role=Role.VIEWER
    )

    consumer = WorkshopConsumer()
    consumer.scope = _make_scope(str(project.pk), token="valid.token")
    consumer.channel_layer = AsyncMock()
    consumer.channel_name = "test.channel"
    close_mock = AsyncMock()
    consumer.close = close_mock

    with _stack(_auth_patches(viewer_user)):
        await consumer.websocket_connect({"type": "websocket.connect"})

    close_mock.assert_called_once_with(code=4003)
    consumer.channel_layer.group_add.assert_not_called()


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_connect_non_member_rejected(member_user: object, project: Project) -> None:
    """A user with no membership cannot join the workshop group — close 4003 (#1507)."""
    consumer = WorkshopConsumer()
    consumer.scope = _make_scope(str(project.pk), token="valid.token")
    consumer.channel_layer = AsyncMock()
    consumer.channel_name = "test.channel"
    close_mock = AsyncMock()
    consumer.close = close_mock

    with _stack(_auth_patches(member_user)):
        await consumer.websocket_connect({"type": "websocket.connect"})

    close_mock.assert_called_once_with(code=4003)
    consumer.channel_layer.group_add.assert_not_called()


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_connect_member_without_active_session_rejected(
    member_user: object, project: Project
) -> None:
    """A Member connecting with no active WorkshopSession is rejected — close 4004 (#1507)."""
    await database_sync_to_async(ProjectMembership.objects.create)(
        project=project, user=member_user, role=Role.MEMBER
    )

    consumer = WorkshopConsumer()
    consumer.scope = _make_scope(str(project.pk), token="valid.token")
    consumer.channel_layer = AsyncMock()
    consumer.channel_name = "test.channel"
    close_mock = AsyncMock()
    consumer.close = close_mock

    with _stack(_auth_patches(member_user)):
        await consumer.websocket_connect({"type": "websocket.connect"})

    close_mock.assert_called_once_with(code=4004)
    consumer.channel_layer.group_add.assert_not_called()


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_connect_member_with_active_session_accepted(
    member_user: object, project: Project
) -> None:
    """A Member with an active session joins the group and gets a participant row (#1507)."""
    from trueppm_api.apps.workshops.models import WorkshopParticipant, WorkshopSession

    await database_sync_to_async(ProjectMembership.objects.create)(
        project=project, user=member_user, role=Role.MEMBER
    )
    session = await database_sync_to_async(WorkshopSession.objects.create)(
        project=project, started_by=member_user
    )

    consumer = WorkshopConsumer()
    consumer.scope = _make_scope(str(project.pk), token="valid.token")
    channel_layer = AsyncMock()
    consumer.channel_layer = channel_layer
    consumer.channel_name = "test.channel"
    close_mock = AsyncMock()
    consumer.close = close_mock

    with _stack(_auth_patches(member_user)):
        await consumer.websocket_connect({"type": "websocket.connect"})

    close_mock.assert_not_called()
    channel_layer.group_add.assert_called_once_with(
        f"project_{project.pk}_workshop", "test.channel"
    )
    exists = await database_sync_to_async(
        WorkshopParticipant.objects.filter(session=session, user=member_user).exists
    )()
    assert exists


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


# ---------------------------------------------------------------------------
# #1355 — workshop_event stamps the shared protocol_version onto every frame
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.asyncio
async def test_workshop_event_stamps_protocol_version(user_obj: object, project: Project) -> None:
    """Every frame the consumer pushes to a client carries protocol_version (#1355)."""
    from trueppm_api.apps.sync.broadcast import WS_PROTOCOL_VERSION

    consumer = _ready_consumer(user_obj, project)
    consumer.send_json = AsyncMock()  # type: ignore[method-assign]

    await consumer.workshop_event(
        {"type": "workshop.event", "content": {"type": "cursor_move", "x": 1}, "sender": "other"}
    )

    consumer.send_json.assert_awaited_once()
    sent = consumer.send_json.await_args.args[0]
    assert sent["protocol_version"] == WS_PROTOCOL_VERSION
    assert sent["type"] == "cursor_move"


@pytest.mark.django_db
@pytest.mark.asyncio
async def test_workshop_event_does_not_mutate_source(user_obj: object, project: Project) -> None:
    """The shared channel-layer event dict is copied, never mutated (#1355)."""
    consumer = _ready_consumer(user_obj, project)
    consumer.send_json = AsyncMock()  # type: ignore[method-assign]

    content = {"type": "cursor_move", "x": 1}
    await consumer.workshop_event({"type": "workshop.event", "content": content, "sender": "other"})

    # The fan-out source dict must not gain protocol_version — other group
    # members each stamp their own copy.
    assert "protocol_version" not in content


@pytest.mark.django_db
@pytest.mark.asyncio
async def test_workshop_event_excludes_sender(user_obj: object, project: Project) -> None:
    """A frame originating from this channel is not echoed back to its sender."""
    consumer = _ready_consumer(user_obj, project)
    consumer.send_json = AsyncMock()  # type: ignore[method-assign]

    await consumer.workshop_event(
        {
            "type": "workshop.event",
            "content": {"type": "cursor_move"},
            "sender": consumer.channel_name,
        }
    )

    consumer.send_json.assert_not_awaited()
