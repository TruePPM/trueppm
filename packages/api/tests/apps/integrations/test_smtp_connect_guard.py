"""SMTP relay is dialed through the connect-time egress guard (#4647).

``assert_host_allowed`` is a pre-flight; Django's stock backend re-resolves at
connect, so a low-TTL record could answer the pre-flight public and the connect
with an internal address. A local TCP server stands in for the "internal SMTP
service" so we can prove no byte (not even the TCP handshake) reached it.
"""

from __future__ import annotations

import socket
import threading
from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import pytest
from django.test import override_settings

from trueppm_api.apps.integrations import http as egress
from trueppm_api.apps.integrations.smtp import GuardedSMTPEmailBackend

PUBLIC_IP = "93.184.216.34"
HOST = "relay.rebind.example.test"

_real_getaddrinfo = socket.getaddrinfo


class _SmtpStub:
    """Greets with a 220 banner and records every byte the client sends."""

    def __init__(self) -> None:
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(5)
        self.port: int = self.sock.getsockname()[1]
        self.accepted = 0
        self.received = bytearray()
        self._stop = False
        self._t = threading.Thread(target=self._run, daemon=True)
        self._t.start()

    def _run(self) -> None:
        self.sock.settimeout(0.2)
        while not self._stop:
            try:
                conn, _ = self.sock.accept()
            except (TimeoutError, OSError):
                continue
            self.accepted += 1
            conn.settimeout(1.0)
            try:
                conn.sendall(b"220 stub ESMTP\r\n")
                while True:
                    data = conn.recv(4096)
                    if not data:
                        break
                    self.received += data
                    conn.sendall(b"250 ok\r\n")
            except OSError:
                pass
            finally:
                conn.close()

    def close(self) -> None:
        self._stop = True
        self._t.join(timeout=2)
        self.sock.close()


@pytest.fixture
def smtp_stub() -> Iterator[_SmtpStub]:
    srv = _SmtpStub()
    yield srv
    srv.close()


@pytest.fixture
def connect_log(monkeypatch: pytest.MonkeyPatch) -> list[Any]:
    calls: list[Any] = []
    real = socket.socket.connect

    def spy(self: socket.socket, address: Any) -> Any:
        calls.append(address)
        return real(self, address)

    monkeypatch.setattr(socket.socket, "connect", spy)
    return calls


def _fake_getaddrinfo(port: int, answers: list[str], host: str = HOST) -> Any:
    """Answer ``answers`` in order for ``host`` (last one repeats); others real."""
    seen: list[str] = []

    def fake(h: Any, p: Any, *args: Any, **kwargs: Any) -> Any:
        if h != host:
            return _real_getaddrinfo(h, p, *args, **kwargs)
        ip = answers[min(len(seen), len(answers) - 1)]
        seen.append(ip)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port))]

    return fake


def _backend(port: int, host: str = HOST, **kw: Any) -> GuardedSMTPEmailBackend:
    kw.setdefault("use_tls", False)
    return GuardedSMTPEmailBackend(host=host, port=port, timeout=3, **kw)


@pytest.mark.parametrize("use_ssl", [False, True])
def test_rebinding_public_then_private_is_refused_at_connect(
    smtp_stub: _SmtpStub, connect_log: list[Any], use_ssl: bool
) -> None:
    # The pre-flight sees the public answer; the connection's own lookup sees
    # loopback. The guard must refuse before any handshake or SMTP byte.
    fake = _fake_getaddrinfo(smtp_stub.port, [PUBLIC_IP, "127.0.0.1"])
    with patch.object(socket, "getaddrinfo", fake):
        egress.assert_host_allowed(HOST, smtp_stub.port, purpose=egress.EgressPurpose.SMTP)
        with pytest.raises(egress.EgressBlocked):
            _backend(smtp_stub.port, use_ssl=use_ssl).open()
    assert [c for c in connect_log if c[0] == "127.0.0.1"] == []
    assert smtp_stub.accepted == 0
    assert bytes(smtp_stub.received) == b""


def test_literal_private_relay_is_refused_at_connect(smtp_stub: _SmtpStub) -> None:
    with pytest.raises(egress.EgressBlocked):
        _backend(smtp_stub.port, host="127.0.0.1").open()
    assert smtp_stub.accepted == 0


@override_settings(EGRESS_ALLOWLISTED_HOSTS_SMTP=[HOST])
def test_smtp_allowlisted_host_stays_exempt_at_connect(smtp_stub: _SmtpStub) -> None:
    fake = _fake_getaddrinfo(smtp_stub.port, ["127.0.0.1"])
    backend = _backend(smtp_stub.port)
    with patch.object(socket, "getaddrinfo", fake):
        assert backend.open() is True  # banner read, connection established
    backend.close()
    assert smtp_stub.accepted == 1


@override_settings(EGRESS_ALLOWLISTED_HOSTS_SMTP=[HOST])
def test_lookalike_hostname_is_not_exempt(smtp_stub: _SmtpStub) -> None:
    lookalike = HOST + ".attacker.example"
    fake = _fake_getaddrinfo(smtp_stub.port, ["127.0.0.1"], host=lookalike)
    with patch.object(socket, "getaddrinfo", fake), pytest.raises(egress.EgressBlocked):
        _backend(smtp_stub.port, host=lookalike).open()
    assert smtp_stub.accepted == 0


@override_settings(
    EGRESS_ALLOWLISTED_HOSTS_SSO=[HOST],
    EGRESS_ALLOWLISTED_HOSTS=[HOST],
    EGRESS_ALLOWLISTED_HOSTS_INTEGRATIONS=[HOST],
    EGRESS_ALLOWLISTED_HOSTS_WEBHOOKS=[HOST],
    EGRESS_ALLOWLISTED_HOSTS_SMTP=[],
)
def test_other_surfaces_allow_lists_do_not_exempt_smtp(smtp_stub: _SmtpStub) -> None:
    fake = _fake_getaddrinfo(smtp_stub.port, ["127.0.0.1"])
    with patch.object(socket, "getaddrinfo", fake), pytest.raises(egress.EgressBlocked):
        _backend(smtp_stub.port).open()
    assert smtp_stub.accepted == 0


def test_resolve_email_connection_uses_the_guarded_backend() -> None:
    from trueppm_api.apps.notifications.email_backend import build_smtp_connection

    with patch.object(
        egress.socket,
        "getaddrinfo",
        _fake_getaddrinfo(25, [PUBLIC_IP], host="mail.corp.test"),
    ):
        conn = build_smtp_connection(
            transport_mode="smtp",
            host="mail.corp.test",
            port=25,
            security="none",
            username="",
            password="",
        )
    assert isinstance(conn, GuardedSMTPEmailBackend)
    assert conn.connection_class.__name__ == "GuardedSMTP"
    ssl_conn = GuardedSMTPEmailBackend(host="x", port=465, use_ssl=True, use_tls=False)
    assert ssl_conn.connection_class.__name__ == "GuardedSMTPSSL"
