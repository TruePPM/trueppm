"""Tests for evict_project_connection (#813) — the push-based WS eviction helper.

The consumer-side connection_evict handler is covered in test_consumers.py; this
file covers the broadcast helper that fans the evict out to both the board and
workshop groups, including its best-effort failure handling.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

from trueppm_api.apps.sync.broadcast import evict_project_connection

_GET_LAYER = "channels.layers.get_channel_layer"


class _FakeChannelLayer:
    """Records group_send calls instead of touching a real channel backend."""

    def __init__(self) -> None:
        self.sent: list[tuple[str, dict[str, Any]]] = []

    async def group_send(self, group: str, message: dict[str, Any]) -> None:
        self.sent.append((group, message))


def test_evict_sends_to_board_and_workshop_groups() -> None:
    layer = _FakeChannelLayer()
    with patch(_GET_LAYER, return_value=layer):
        evict_project_connection("p1", "u9")
    assert layer.sent == [
        ("project_p1", {"type": "connection.evict", "user_id": "u9"}),
        ("project_p1_workshop", {"type": "connection.evict", "user_id": "u9"}),
    ]


def test_evict_is_noop_when_no_channel_layer_configured() -> None:
    # No layer (e.g. layers disabled in a worker) → log + return, never raise.
    with patch(_GET_LAYER, return_value=None):
        evict_project_connection("p1", "u9")


def test_evict_swallows_group_send_failure() -> None:
    """Best-effort like broadcast_board_event: a layer error is logged, not raised."""

    class _BoomLayer:
        async def group_send(self, group: str, message: dict[str, Any]) -> None:
            raise RuntimeError("channel layer down")

    with patch(_GET_LAYER, return_value=_BoomLayer()):
        evict_project_connection("p1", "u9")
