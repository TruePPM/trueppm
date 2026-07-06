"""The suite-wide socket ban (#1653).

Verifies the autouse guard in ``conftest.py``: a real outbound connection to a
non-infrastructure host fails fast and deterministically instead of hanging on a
connect timeout and flaking (the #1652 webhook-SSRF incident). Connections to the
allowlisted DB/Redis/loopback hosts still work, and ``@pytest.mark.enable_socket``
is a reviewable escape hatch for the rare test that genuinely needs the network.

These tests deliberately require **no** database, so they exercise the ban itself
without any DB I/O. The black-hole target ``192.0.2.1`` is a TEST-NET-1 address
reserved by RFC 5737 — it never routes anywhere — and every connect is bounded by a
short timeout so even the escape-hatch path cannot hang.
"""

from __future__ import annotations

import socket

import pytest
from pytest_socket import SocketConnectBlockedError

# RFC 5737 reserved black-hole address — guaranteed not to be an infra host and
# never routable, so the escape-hatch path times out fast rather than connecting.
_BLACKHOLE = ("192.0.2.1", 80)


def test_external_connect_is_blocked() -> None:
    """A connect to a non-allowlisted host raises before any network I/O."""
    with pytest.raises(SocketConnectBlockedError):
        socket.create_connection(_BLACKHOLE, timeout=0.05)


def test_loopback_is_allowed() -> None:
    """Loopback is allowlisted — a connect is refused by the OS, never by the ban."""
    with pytest.raises(OSError) as excinfo:
        # Port 1 has nothing listening: an instant ConnectionRefusedError.
        socket.create_connection(("127.0.0.1", 1), timeout=0.5)
    assert not isinstance(excinfo.value, SocketConnectBlockedError)


@pytest.mark.enable_socket
def test_enable_socket_marker_lifts_the_ban() -> None:
    """The escape hatch restores real sockets — the block does not fire.

    With the ban lifted the connect reaches the network and times out against the
    black-hole address (a plain ``OSError``), proving the guard was not applied.
    """
    with pytest.raises(OSError) as excinfo:
        socket.create_connection(_BLACKHOLE, timeout=0.05)
    assert not isinstance(excinfo.value, SocketConnectBlockedError)
