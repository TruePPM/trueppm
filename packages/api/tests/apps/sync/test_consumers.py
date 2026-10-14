"""Tests for the WebSocket ProjectConsumer."""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Iterator
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
    consumer.accept = AsyncMock()

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
    consumer.accept = AsyncMock()

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
    consumer.accept = AsyncMock()

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
    consumer.accept = AsyncMock()

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
    consumer.accept = AsyncMock()

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
    consumer.accept = AsyncMock()

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
    consumer.accept = AsyncMock()

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
    consumer.accept = AsyncMock()

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
    consumer.accept = AsyncMock()

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
    consumer.accept = AsyncMock()

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
    consumer.accept = AsyncMock()

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


async def _forward(project: Project, message: dict) -> list[dict]:
    """Run one channel-layer message through ``ProjectConsumer.board_event``."""
    from trueppm_api.apps.sync.consumers import ProjectConsumer

    consumer = ProjectConsumer()
    consumer.scope = _make_scope(str(project.pk), token="valid.token")
    consumer.channel_layer = AsyncMock()
    consumer.channel_name = "test.channel"
    consumer.group_name = f"project_{project.pk}"
    sent: list[dict] = []

    async def _send_json(content: dict, close: bool = False) -> None:
        sent.append(content)

    consumer.send_json = _send_json  # type: ignore[method-assign]
    await consumer.board_event(message)
    return sent


@pytest.mark.django_db
@pytest.mark.asyncio
async def test_board_event_forwards_seq_marked_as_per_project(
    user: object, project: Project
) -> None:
    """A message built by the current broadcast helper carries its seq to the client."""
    from trueppm_api.apps.sync.broadcast import _board_message

    sent = await _forward(project, _board_message("task_created", {"id": "t1"}, 7))
    assert sent[0]["seq"] == 7
    # The scope marker is channel-layer-internal and never reaches the wire.
    assert "seq_scope" not in sent[0]


@pytest.mark.django_db
@pytest.mark.asyncio
async def test_board_event_strips_unmarked_seq_from_a_previous_release_pod(
    user: object, project: Project
) -> None:
    """During a rolling update an older pod group-sends its global row id as ``seq``
    with no scope marker (#4386). Forwarding it would hand the client a cursor from
    the other number space, so it goes out unsequenced — applied, never gated."""
    message = {
        "type": "board.event",
        "protocol_version": 1,
        "event_type": "task_created",
        "payload": {"id": "t1"},
        "seq": 987654,
    }
    sent = await _forward(project, message)
    assert sent[0]["event_type"] == "task_created"
    assert sent[0]["seq"] is None


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_events_committed_in_order_but_delivered_reversed_both_reach_the_client(
    user: object, project: Project
) -> None:
    """#4386 test plan: two events commit as seq 1 then 2, but the second worker's
    group_send lands first. The consumer forwards both, each with its own dense
    seq, so the client can apply them in order (its reorder gate is pinned in
    ``wsSeqGate.test.ts``) instead of dropping 1 as a duplicate of 2."""
    from trueppm_api.apps.sync.broadcast import _board_message, _persist_board_event

    persist = database_sync_to_async(_persist_board_event)
    first = await persist(str(project.pk), "task_dates_updated", {"tasks": []})
    second = await persist(str(project.pk), "task_updated", {"id": "t1"})
    assert (first, second) == (1, 2)

    reversed_delivery = [
        *await _forward(project, _board_message("task_updated", {"id": "t1"}, second)),
        *await _forward(project, _board_message("task_dates_updated", {"tasks": []}, first)),
    ]
    assert [(f["event_type"], f["seq"]) for f in reversed_delivery] == [
        ("task_updated", 2),
        ("task_dates_updated", 1),
    ]


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


def _persist(project: Project, event_type: str, payload: dict) -> int:
    """Persist one replayable event through the real allocator; return its seq."""
    from trueppm_api.apps.sync.broadcast import _persist_board_event

    seq = _persist_board_event(str(project.pk), event_type, payload)
    assert seq is not None
    return seq


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

    persist = database_sync_to_async(_persist)
    s1 = await persist(project, "task_created", {"id": "t1"})
    # Another project's traffic interleaves — it must neither appear in this replay
    # (no IDOR) nor punch a hole in this project's sequence (#4386).
    await persist(other, "task_created", {"id": "x1"})
    s2 = await persist(project, "task_updated", {"id": "t1"})
    s3 = await persist(project, "task_deleted", {"id": "t1"})
    assert [s1, s2, s3] == [1, 2, 3]

    sent = await _connect_capturing(str(project.pk), user, since=s1)

    replayed = [f for f in sent if f.get("replayed")]
    assert [f["seq"] for f in replayed] == [2, 3]
    assert [f["event_type"] for f in replayed] == ["task_updated", "task_deleted"]
    assert all(f["event_type"] != "resync_required" for f in sent)


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_replay_sends_resync_when_part_of_the_gap_was_purged(
    user: object, project: Project
) -> None:
    """Owed events missing from the buffer yield resync_required, not a partial replay."""
    await database_sync_to_async(ProjectMembership.objects.create)(
        project=project, user=user, role=Role.MEMBER
    )

    from trueppm_api.apps.sync.models import BoardEvent

    persist = database_sync_to_async(_persist)
    for i in range(3):
        await persist(project, "task_updated", {"id": f"t{i}"})
    # The purge reaped seq 2: a client at since=1 is owed 2 and 3 but only 3 survives.
    await database_sync_to_async(BoardEvent.objects.filter(project_id=project.pk, seq=2).delete)()

    sent = await _connect_capturing(str(project.pk), user, since=1)

    resync = [f for f in sent if f["event_type"] == "resync_required"]
    assert len(resync) == 1
    assert resync[0]["payload"]["latest_seq"] == 3
    assert not [f for f in sent if f.get("replayed")]


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_replay_resyncs_a_cursor_above_the_project_head(
    user: object, project: Project
) -> None:
    """A since above the head is from another number space — a client that crossed
    the #4386 upgrade still holding a global row id. It is re-baselined, not ignored:
    ignoring it would leave the client dropping every new frame as a duplicate."""
    await database_sync_to_async(ProjectMembership.objects.create)(
        project=project, user=user, role=Role.MEMBER
    )
    persist = database_sync_to_async(_persist)
    await persist(project, "task_created", {"id": "t1"})
    await persist(project, "task_updated", {"id": "t1"})

    sent = await _connect_capturing(str(project.pk), user, since=50_000)

    assert sent == [
        {
            "protocol_version": 1,
            "event_type": "resync_required",
            "payload": {"latest_seq": 2},
            "seq": None,
        }
    ]


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_replay_resyncs_a_cursor_on_a_project_with_no_events(
    user: object, project: Project
) -> None:
    """No counter row yet: the head is 0, so any positive since is re-baselined to 0."""
    await database_sync_to_async(ProjectMembership.objects.create)(
        project=project, user=user, role=Role.MEMBER
    )
    sent = await _connect_capturing(str(project.pk), user, since=5)
    assert [f["payload"] for f in sent] == [{"latest_seq": 0}]


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_replay_at_the_head_sends_nothing(user: object, project: Project) -> None:
    """A client already at the head is owed nothing — no replay and no resync."""
    await database_sync_to_async(ProjectMembership.objects.create)(
        project=project, user=user, role=Role.MEMBER
    )
    persist = database_sync_to_async(_persist)
    await persist(project, "task_created", {"id": "t1"})
    head = await persist(project, "task_updated", {"id": "t1"})

    sent = await _connect_capturing(str(project.pk), user, since=head)
    assert sent == []


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_replay_beyond_the_cap_resyncs(user: object, project: Project) -> None:
    """A client further behind than _REPLAY_CAP is told to refetch, not streamed to."""
    await database_sync_to_async(ProjectMembership.objects.create)(
        project=project, user=user, role=Role.MEMBER
    )
    persist = database_sync_to_async(_persist)
    for i in range(4):
        await persist(project, "task_updated", {"id": f"t{i}"})

    with patch("trueppm_api.apps.sync.consumers._REPLAY_CAP", 2):
        sent = await _connect_capturing(str(project.pk), user, since=1)

    assert [f["event_type"] for f in sent] == ["resync_required"]
    assert sent[0]["payload"] == {"latest_seq": 4}


def _upgrade_with_old_rows(project: Project, other: Project) -> dict[str, int]:
    """Write pre-#4386 rows (global ids, no seq), then run the migration's seeding.

    Mirrors the reproduction from the completeness audit: rows ``other:1``, ``P:2``,
    ``P:3`` (the client saw this one), ``P:4`` (the client missed it). Returns the
    global ids, which are what an old client holds as its cursor.
    """
    from django.db import connection

    from trueppm_api.apps.sync.models import BoardEvent, BoardEventSequence
    from trueppm_api.apps.sync.sequence import seed_board_event_sequences

    ids = {
        "other": BoardEvent.objects.create(project=other, event_type="x", payload={}).pk,
        "p2": BoardEvent.objects.create(project=project, event_type="a", payload={}).pk,
        "p3_seen": BoardEvent.objects.create(project=project, event_type="b", payload={}).pk,
        "p4_missed": BoardEvent.objects.create(project=project, event_type="c", payload={}).pk,
    }
    seed_board_event_sequences(BoardEvent, BoardEventSequence, Project, connection)
    return ids


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_pre_upgrade_cursor_that_missed_an_event_gets_a_resync(
    user: object, project: Project, calendar: Calendar
) -> None:
    """The completeness-audit reproduction. A client last saw P's third old event and
    missed the fourth. Under the first (renumbering) design its old cursor landed at
    or below the new head and the replay returned nothing, so the missed event was
    lost silently. Seeding above the old ids makes every such cursor resync."""
    await database_sync_to_async(ProjectMembership.objects.create)(
        project=project, user=user, role=Role.MEMBER
    )
    other = await database_sync_to_async(Project.objects.create)(
        name="Other", start_date=date(2026, 1, 1), calendar=calendar
    )
    ids = await database_sync_to_async(_upgrade_with_old_rows)(project, other)
    # Some new events after the upgrade, too.
    await database_sync_to_async(_persist)(project, "task_updated", {"id": "t1"})

    sent = await _connect_capturing(str(project.pk), user, since=ids["p3_seen"])

    assert [f["event_type"] for f in sent] == ["resync_required"]
    assert sent[0]["payload"]["latest_seq"] == ids["p4_missed"] + 1


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_pre_upgrade_cursor_before_any_new_event_gets_a_resync(
    user: object, project: Project, calendar: Calendar
) -> None:
    """The same missed-event cursor with no new events yet: still a resync, never []."""
    await database_sync_to_async(ProjectMembership.objects.create)(
        project=project, user=user, role=Role.MEMBER
    )
    other = await database_sync_to_async(Project.objects.create)(
        name="Other", start_date=date(2026, 1, 1), calendar=calendar
    )
    ids = await database_sync_to_async(_upgrade_with_old_rows)(project, other)

    sent = await _connect_capturing(str(project.pk), user, since=ids["p3_seen"])
    assert [f["event_type"] for f in sent] == ["resync_required"]


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_pre_upgrade_cursor_at_the_seed_replays_exactly_the_new_events(
    user: object, project: Project, calendar: Calendar
) -> None:
    """A client that had seen every old event (cursor == P's highest old id, the
    seed) is owed only what happened after the upgrade, and gets exactly that."""
    await database_sync_to_async(ProjectMembership.objects.create)(
        project=project, user=user, role=Role.MEMBER
    )
    other = await database_sync_to_async(Project.objects.create)(
        name="Other", start_date=date(2026, 1, 1), calendar=calendar
    )
    ids = await database_sync_to_async(_upgrade_with_old_rows)(project, other)
    persist = database_sync_to_async(_persist)
    s1 = await persist(project, "task_created", {"id": "n1"})
    s2 = await persist(project, "task_updated", {"id": "n1"})
    seed = ids["p4_missed"]
    assert (s1, s2) == (seed + 1, seed + 2)

    sent = await _connect_capturing(str(project.pk), user, since=seed)

    assert [(f["event_type"], f["seq"], f.get("replayed")) for f in sent] == [
        ("task_created", seed + 1, True),
        ("task_updated", seed + 2, True),
    ]


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_no_since_skips_replay_entirely(user: object, project: Project) -> None:
    """A fresh connect (since=0) streams no replay frames — REST provides current state."""
    await database_sync_to_async(ProjectMembership.objects.create)(
        project=project, user=user, role=Role.MEMBER
    )
    await database_sync_to_async(_persist)(project, "task_created", {"id": "t1"})

    sent = await _connect_capturing(str(project.pk), user, since=0)
    assert sent == []


# ---------------------------------------------------------------------------
# Active-connection gauge wiring (#1900) — connect counts, disconnect discounts.
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_accepted_connect_and_disconnect_balance_connection_gauge(
    user: object, project: Project
) -> None:
    """An accepted socket records +1 on connect and -1 on disconnect exactly once.

    Spies on the record_* helpers the consumer calls (patched on the metrics module
    it imports) rather than a live meter, so the wiring — increment after accept,
    balanced decrement guarded by _ws_counted — is the code under test."""
    await database_sync_to_async(ProjectMembership.objects.create)(
        project=project, user=user, role=Role.MEMBER
    )

    from trueppm_api.apps.sync.consumers import ProjectConsumer

    consumer = ProjectConsumer()
    consumer.scope = _make_scope(str(project.pk), token="valid.token")
    consumer.channel_layer = AsyncMock()
    consumer.channel_name = "test.channel"
    consumer.close = AsyncMock()

    opened = MagicMock()
    closed = MagicMock()

    with (
        _stack(_connect_ctx(user)),
        patch("trueppm_api.apps.observability.otel.metrics.record_ws_connection_opened", opened),
        patch("trueppm_api.apps.observability.otel.metrics.record_ws_connection_closed", closed),
    ):
        await consumer.websocket_connect({"type": "websocket.connect"})
        opened.assert_called_once()
        closed.assert_not_called()
        assert consumer._ws_counted is True

        await consumer.disconnect(1000)
        closed.assert_called_once()
        assert consumer._ws_counted is False


@pytest.mark.django_db
@pytest.mark.asyncio
async def test_rejected_connect_does_not_discount_gauge(project: Project) -> None:
    """A refused handshake never counted, so disconnect must not discount.

    Refusals are accept-then-close since #4375, so "refused" no longer means "never
    accepted" — the gauge must still stay untouched, because it counts sockets that
    reached the live stream, not handshakes the server answered.
    """
    from trueppm_api.apps.sync.consumers import ProjectConsumer

    consumer = ProjectConsumer()
    consumer.scope = _make_scope(str(project.pk), token="")  # no credential → 4001
    consumer.channel_layer = AsyncMock()
    consumer.channel_name = "test.channel"
    consumer.close = AsyncMock()
    consumer.accept = AsyncMock()

    opened = MagicMock()
    closed = MagicMock()
    with (
        patch("trueppm_api.apps.observability.otel.metrics.record_ws_connection_opened", opened),
        patch("trueppm_api.apps.observability.otel.metrics.record_ws_connection_closed", closed),
    ):
        await consumer.websocket_connect({"type": "websocket.connect"})
        opened.assert_not_called()
        assert consumer._ws_counted is False

        await consumer.disconnect(4001)
        closed.assert_not_called()


# ---------------------------------------------------------------------------
# Presence — the keepalive that stops the roster emptying (#2607)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_presence_keepalive_rearms_the_ttl_while_the_socket_is_idle() -> None:
    """The roster must reflect who is connected, not who is generating traffic.

    The TTL used to be refreshed only from ``receive_json`` — a heartbeat no
    client sends (the web project socket is receive-only), so the roster emptied
    about a minute into every session while everyone was still connected. This
    asserts the refresh happens with **zero** inbound frames, which is the exact
    condition that was broken.

    The interval is patched to something tiny so the test does not sleep for 30
    real seconds; the production value is asserted separately below, since a test
    that only ever sees a patched interval cannot notice the real one drifting
    above the TTL.
    """
    from trueppm_api.apps.sync import consumers as consumers_mod
    from trueppm_api.apps.sync.consumers import ProjectConsumer

    consumer = ProjectConsumer()
    consumer.project_pk = "11111111-1111-1111-1111-111111111111"

    mock_redis = AsyncMock()
    mock_redis.expire = AsyncMock()

    with (
        patch.object(consumers_mod, "_PRESENCE_REFRESH_INTERVAL", 0.01),
        patch(
            "trueppm_api.apps.sync.consumers.ProjectConsumer._get_redis",
            new=AsyncMock(return_value=mock_redis),
        ),
    ):
        task = asyncio.create_task(consumer._presence_keepalive())
        await asyncio.sleep(0.05)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    assert mock_redis.expire.await_count >= 2, "keepalive did not re-arm the TTL"
    key, ttl = mock_redis.expire.await_args.args
    assert key == f"project:{consumer.project_pk}:presence"
    assert ttl == consumers_mod._PRESENCE_TTL


def test_presence_refresh_interval_is_below_the_ttl() -> None:
    """A refresh interval at or above the TTL reintroduces the bug silently.

    Nothing else would fail: the keepalive would still run, just always a beat
    late, and the roster would empty exactly as it did before — which is why this
    relationship is asserted rather than left to the constant's comment.
    """
    from trueppm_api.apps.sync import consumers as consumers_mod

    assert 0 < consumers_mod._PRESENCE_REFRESH_INTERVAL < consumers_mod._PRESENCE_TTL


@pytest.mark.asyncio
async def test_presence_keepalive_survives_a_redis_failure() -> None:
    """A Redis blip must cost one refresh, not the whole socket.

    The keepalive runs as a bare task; an escaping exception would surface as an
    unhandled task error and, worse, silently stop refreshing for a connection
    that is otherwise perfectly healthy — trading a supporting affordance for a
    live collaboration session.
    """
    from trueppm_api.apps.sync import consumers as consumers_mod
    from trueppm_api.apps.sync.consumers import ProjectConsumer

    consumer = ProjectConsumer()
    consumer.project_pk = "22222222-2222-2222-2222-222222222222"

    mock_redis = AsyncMock()
    mock_redis.expire = AsyncMock(side_effect=[ConnectionError("valkey down"), None, None])

    with (
        patch.object(consumers_mod, "_PRESENCE_REFRESH_INTERVAL", 0.01),
        patch(
            "trueppm_api.apps.sync.consumers.ProjectConsumer._get_redis",
            new=AsyncMock(return_value=mock_redis),
        ),
    ):
        task = asyncio.create_task(consumer._presence_keepalive())
        await asyncio.sleep(0.05)
        still_running = not task.done()
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    assert still_running, "keepalive died on a transient Redis error"
    assert mock_redis.expire.await_count >= 2, "keepalive stopped refreshing after the failure"


# ---------------------------------------------------------------------------
# #4375 — policy refusals are accept-then-close at the ASGI level
#
# A close sent BEFORE accept makes the ASGI server (uvicorn) reject the HTTP upgrade with a
# 403, which a browser reports as close code 1006 — the application code never
# arrives, so the web client cannot tell "refused" from "network drop" and
# reconnects forever. These drive the real router through WebsocketCommunicator
# and assert the wire sequence: websocket.accept, then websocket.close carrying
# the code. A pre-accept close shows up here as ``connect() -> (False, code)``.
# ---------------------------------------------------------------------------


def _ws_app() -> Any:
    """The production websocket router, including the unrouted-path catch-all."""
    from channels.routing import URLRouter
    from django.urls import re_path

    from trueppm_api.asgi import _CloseConsumer
    from trueppm_api.routing import websocket_urlpatterns

    return URLRouter([*websocket_urlpatterns, re_path(r".*", _CloseConsumer.as_asgi())])


@pytest.fixture
def in_memory_channel_layer(settings: Any) -> Iterator[None]:
    """Swap the Redis channel layer for the in-memory one (no Valkey needed)."""
    from channels.layers import channel_layers

    settings.CHANNEL_LAYERS = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}
    channel_layers.backends.clear()
    yield
    channel_layers.backends.clear()


async def _connect_and_read_close(path: str) -> tuple[bool, Any, dict[str, Any] | None]:
    """Drive one handshake and return ``(accepted, pre_accept_code, close_frame)``.

    Uses asgiref's ``ApplicationCommunicator`` rather than Channels'
    ``WebsocketCommunicator``: importing ``channels.testing`` pulls in
    ``daphne.testing``, and this project serves ASGI with uvicorn, not Daphne.
    The frames asserted are the raw ASGI messages either server translates.
    """
    from asgiref.testing import ApplicationCommunicator

    raw_path, _, query = path.partition("?")
    scope = {
        "type": "websocket",
        "path": raw_path,
        "raw_path": raw_path.encode(),
        "query_string": query.encode(),
        "headers": [],
        "subprotocols": [],
    }
    communicator = ApplicationCommunicator(_ws_app(), scope)
    await communicator.send_input({"type": "websocket.connect"})
    first = await communicator.receive_output(timeout=2)
    if first["type"] == "websocket.close":
        # Closed before accept: a real server answers the upgrade with HTTP 403.
        await communicator.send_input({"type": "websocket.disconnect", "code": first["code"]})
        await communicator.wait(timeout=2)
        return False, first.get("code"), None
    assert first["type"] == "websocket.accept", first
    close_frame = await communicator.receive_output(timeout=2)
    await communicator.send_input({"type": "websocket.disconnect", "code": close_frame["code"]})
    await communicator.wait(timeout=2)
    return True, None, close_frame


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
@pytest.mark.usefixtures("in_memory_channel_layer")
async def test_unauthenticated_connect_is_accepted_then_closed_4001(project: Project) -> None:
    """No credential → accept, then close 4001 (so a browser's CloseEvent carries it)."""
    connected, detail, close_frame = await _connect_and_read_close(f"/ws/v1/projects/{project.pk}/")

    assert connected is True, f"refused before accept (code {detail}) — browser would see 1006"
    assert close_frame == {"type": "websocket.close", "code": 4001}


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
@pytest.mark.usefixtures("in_memory_channel_layer")
async def test_viewer_connect_is_accepted_then_closed_4003(
    viewer_user: object, project: Project
) -> None:
    """A real Viewer membership → accept, then close 4003; never joins the group."""
    await database_sync_to_async(ProjectMembership.objects.create)(
        project=project, user=viewer_user, role=Role.VIEWER
    )
    with patch(
        "trueppm_api.apps.sync.consumers.authenticate_scope",
        new=AsyncMock(return_value=WsAuthResult(user=viewer_user, via="ticket")),
    ):
        connected, detail, close_frame = await _connect_and_read_close(
            f"/ws/v1/projects/{project.pk}/?ticket=t"
        )

    assert connected is True, f"refused before accept (code {detail}) — browser would see 1006"
    assert close_frame == {"type": "websocket.close", "code": 4003}


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
@pytest.mark.usefixtures("in_memory_channel_layer")
async def test_non_member_and_missing_project_refuse_identically(user: object) -> None:
    """A real project the caller is not in and a project that does not exist both
    produce accept + 4003 — accepting first must not open an existence oracle."""
    calendar = await database_sync_to_async(Calendar.objects.create)(name="Std")
    other = await database_sync_to_async(Project.objects.create)(
        name="Not mine", start_date=date(2026, 1, 1), calendar=calendar
    )
    missing = "00000000-0000-4000-8000-000000000000"
    with patch(
        "trueppm_api.apps.sync.consumers.authenticate_scope",
        new=AsyncMock(return_value=WsAuthResult(user=user, via="ticket")),
    ):
        real = await _connect_and_read_close(f"/ws/v1/projects/{other.pk}/?ticket=t")
        absent = await _connect_and_read_close(f"/ws/v1/projects/{missing}/?ticket=t")

    assert real[0] is True
    assert absent[0] is True
    assert real[2] == absent[2] == {"type": "websocket.close", "code": 4003}


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
@pytest.mark.usefixtures("in_memory_channel_layer")
async def test_unrouted_path_stays_pre_accept_4404() -> None:
    """The router catch-all is the one deliberate pre-accept rejection (see asgi.py)."""
    connected, detail, close_frame = await _connect_and_read_close("/ws/v1/nope/")

    assert connected is False
    assert detail == 4404
    assert close_frame is None


def test_role_can_subscribe_live_floor() -> None:
    """The shared predicate behind both the consumer gate and the serializer field."""
    from trueppm_api.apps.access.permissions import role_can_subscribe_live

    assert role_can_subscribe_live(None) is False
    assert role_can_subscribe_live(Role.VIEWER) is False
    assert role_can_subscribe_live(Role.MEMBER - 1) is False
    for role in (Role.MEMBER, Role.SCHEDULER, Role.ADMIN, Role.OWNER):
        assert role_can_subscribe_live(role) is True
