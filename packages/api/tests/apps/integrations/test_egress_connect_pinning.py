"""Connect-time peer check closes the DNS-rebinding window (#3849).

``assert_url_allowed`` and the connection each resolve the hostname, so a
low-TTL record can answer the pre-flight with a public address and the connect
with loopback / RFC1918 / cloud metadata. These tests simulate exactly that by
making ``socket.getaddrinfo`` answer differently on successive calls, with a
real local server standing in for the "internal service" so we can prove no
request byte ever reached it.
"""

from __future__ import annotations

import datetime
import ipaddress
import socket
import ssl
import threading
from collections.abc import Iterator
from datetime import date
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.integrations import http as egress
from trueppm_api.apps.projects.models import Calendar, Project
from trueppm_api.apps.webhooks import tasks as wh_tasks
from trueppm_api.apps.webhooks.models import DeliveryStatus, Webhook, WebhookDelivery

PUBLIC_IP = "93.184.216.34"
HOST = "rebind.example.test"

_real_getaddrinfo = socket.getaddrinfo


class _LocalServer:
    """Plain-TCP stand-in for an internal service; records every byte received."""

    def __init__(self) -> None:
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(5)
        self.port: int = self.sock.getsockname()[1]
        self.received = bytearray()
        self.accepted = 0
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
                while True:
                    data = conn.recv(4096)
                    if not data:
                        break
                    self.received += data
                    if b"\r\n\r\n" in self.received:
                        conn.sendall(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
                        )
                        break
            except OSError:
                pass
            finally:
                conn.close()

    def close(self) -> None:
        self._stop = True
        self._t.join(timeout=2)
        self.sock.close()


@pytest.fixture
def internal_server() -> Iterator[_LocalServer]:
    srv = _LocalServer()
    yield srv
    srv.close()


def _rebinding_getaddrinfo(
    port: int, *, first: str, then: str, host: str = HOST
) -> tuple[Any, list[str]]:
    """getaddrinfo answering ``first`` for the guard's lookup, ``then`` afterwards."""
    answers: list[str] = []

    def fake(h: Any, p: Any, *args: Any, **kwargs: Any) -> Any:
        if h != host:
            return _real_getaddrinfo(h, p, *args, **kwargs)
        ip = first if not answers else then
        answers.append(ip)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port))]

    return fake, answers


def test_rebinding_public_then_private_is_refused_at_connect(
    internal_server: _LocalServer,
) -> None:
    fake, answers = _rebinding_getaddrinfo(internal_server.port, first=PUBLIC_IP, then="127.0.0.1")
    with patch.object(socket, "getaddrinfo", fake), pytest.raises(egress.EgressBlocked):
        egress.get(f"http://{HOST}:{internal_server.port}/")
    # The pre-flight passed on the public answer; the connection's own lookup got
    # the private one — and the connected peer was refused before any bytes.
    assert answers[:2] == [PUBLIC_IP, "127.0.0.1"]
    assert bytes(internal_server.received) == b""


def test_post_form_rebinding_is_refused_at_connect(internal_server: _LocalServer) -> None:
    fake, _ = _rebinding_getaddrinfo(internal_server.port, first=PUBLIC_IP, then="127.0.0.1")
    with patch.object(socket, "getaddrinfo", fake), pytest.raises(egress.EgressBlocked):
        egress.post_form(f"http://{HOST}:{internal_server.port}/", data={"a": "b"})
    assert bytes(internal_server.received) == b""


def test_metadata_address_at_connect_is_refused(internal_server: _LocalServer) -> None:
    """The peer classifier is the shared one (``_is_blocked_ip``): a tunneled
    IPv4 metadata address is blocked by the same unwrapping the pre-flight uses."""
    with patch.object(egress, "_peer_ip", lambda s: ipaddress.ip_address("::ffff:169.254.169.254")):
        fake, _ = _rebinding_getaddrinfo(internal_server.port, first=PUBLIC_IP, then="127.0.0.1")
        with patch.object(socket, "getaddrinfo", fake), pytest.raises(egress.EgressBlocked):
            egress.get(f"http://{HOST}:{internal_server.port}/")


def test_public_then_public_succeeds(internal_server: _LocalServer) -> None:
    """Negative control: a stable public answer is not refused.

    The sandbox cannot reach a real public IP, so the socket really lands on the
    local server while ``_peer_ip`` reports the public address the DNS answered —
    the only seam that differs from production is which IP the kernel connected to.
    """
    fake, answers = _rebinding_getaddrinfo(
        internal_server.port, first="127.0.0.1", then="127.0.0.1"
    )
    # Pre-flight must see a public answer; connect resolves to the local server.
    seq = iter([PUBLIC_IP])

    def fake2(h: Any, p: Any, *a: Any, **k: Any) -> Any:
        if h == HOST:
            ip = next(seq, "127.0.0.1")
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, internal_server.port))]
        return _real_getaddrinfo(h, p, *a, **k)

    del fake, answers
    with (
        patch.object(socket, "getaddrinfo", fake2),
        patch.object(egress, "_peer_ip", lambda s: ipaddress.ip_address(PUBLIC_IP)),
    ):
        resp = egress.get(f"http://{HOST}:{internal_server.port}/")
    assert resp.status == 200
    assert resp.body == b"ok"
    assert b"Host: " + HOST.encode() in bytes(internal_server.received)


def test_allowlisted_host_is_exempt_at_connect(
    internal_server: _LocalServer, settings: Any
) -> None:
    """ADR-0590 allow-list is honored identically at connect time, exact match."""
    settings.EGRESS_ALLOWLISTED_HOSTS = [HOST]
    with patch.object(
        socket,
        "getaddrinfo",
        _rebinding_getaddrinfo(internal_server.port, first="127.0.0.1", then="127.0.0.1")[0],
    ):
        resp = egress.get(f"http://{HOST}:{internal_server.port}/")
    assert resp.status == 200


def test_allowlist_is_not_widened_to_lookalike_at_connect(
    internal_server: _LocalServer, settings: Any
) -> None:
    settings.EGRESS_ALLOWLISTED_HOSTS = [HOST]
    other = "x." + HOST
    fake, _ = _rebinding_getaddrinfo(
        internal_server.port, first=PUBLIC_IP, then="127.0.0.1", host=other
    )
    with patch.object(socket, "getaddrinfo", fake), pytest.raises(egress.EgressBlocked):
        egress.get(f"http://{other}:{internal_server.port}/")
    assert bytes(internal_server.received) == b""


def test_env_proxy_is_ignored(
    internal_server: _LocalServer, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A proxy env var must not redirect the socket: the peer check needs the real target."""
    monkeypatch.setenv("HTTP_PROXY", f"http://127.0.0.1:{internal_server.port}")
    monkeypatch.setenv("http_proxy", f"http://127.0.0.1:{internal_server.port}")
    fake, _ = _rebinding_getaddrinfo(1, first=PUBLIC_IP, then="127.0.0.1")
    # Connection goes to the (closed) port 1 on the target, not to the proxy.
    with (
        patch.object(socket, "getaddrinfo", fake),
        pytest.raises((egress.EgressError, egress.EgressBlocked)),
    ):
        egress.get(f"http://{HOST}:1/", timeout=1)
    assert internal_server.accepted == 0


# --- HTTPS: SNI / hostname verification survive the peer check -----------------


def _make_cert(tmp_path: Path, name: str) -> tuple[Path, Path]:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)])
    now = datetime.datetime.now(datetime.UTC)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(name)]), critical=False)
        .sign(key, hashes.SHA256())
    )
    crt = tmp_path / f"{name}.crt"
    k = tmp_path / f"{name}.key"
    crt.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    k.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        )
    )
    return crt, k


class _TLSServer:
    def __init__(self, crt: Path, key: Path) -> None:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(str(crt), str(key))
        self.sni: list[str | None] = []

        def on_sni(_s: Any, name: str | None, _c: Any) -> None:
            self.sni.append(name)

        ctx.sni_callback = on_sni
        self.ctx = ctx
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(5)
        self.port: int = self.sock.getsockname()[1]
        self._stop = False
        self._t = threading.Thread(target=self._run, daemon=True)
        self._t.start()

    def _run(self) -> None:
        self.sock.settimeout(0.2)
        while not self._stop:
            try:
                raw, _ = self.sock.accept()
            except (TimeoutError, OSError):
                continue
            raw.settimeout(2.0)
            try:
                with self.ctx.wrap_socket(raw, server_side=True) as tls:
                    tls.recv(4096)
                    tls.sendall(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
                    )
            except (OSError, ssl.SSLError):
                pass

    def close(self) -> None:
        self._stop = True
        self._t.join(timeout=2)
        self.sock.close()


@pytest.fixture
def tls_server(tmp_path: Path) -> Iterator[tuple[_TLSServer, Path]]:
    crt, key = _make_cert(tmp_path, HOST)
    srv = _TLSServer(crt, key)
    yield srv, crt
    srv.close()


def _https_get(port: int, ctx: ssl.SSLContext, host: str = HOST) -> egress.EgressResponse:
    import urllib.request

    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        egress.NoRedirectHandler,
        egress._GuardedHTTPSHandler(context=ctx),
    )
    with (
        patch.object(egress, "_opener", opener),
        patch.object(egress, "assert_url_allowed", lambda u: None),
        patch.object(egress, "_peer_ip", lambda s: ipaddress.ip_address(PUBLIC_IP)),
        patch.object(
            socket,
            "getaddrinfo",
            lambda h, p, *a, **k: (
                [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port))]
                if h == host
                else _real_getaddrinfo(h, p, *a, **k)
            ),
        ),
    ):
        return egress.get(f"https://{host}:{port}/", timeout=3)


def test_https_sni_and_hostname_verification_intact(
    tls_server: tuple[_TLSServer, Path],
) -> None:
    srv, crt = tls_server
    ctx = ssl.create_default_context(cafile=str(crt))
    resp = _https_get(srv.port, ctx)
    assert resp.status == 200
    # SNI carries the original hostname, not the connected IP.
    assert HOST in srv.sni


def test_https_hostname_mismatch_still_fails_verification(
    tls_server: tuple[_TLSServer, Path],
) -> None:
    srv, crt = tls_server
    ctx = ssl.create_default_context(cafile=str(crt))
    with pytest.raises(egress.EgressError, match=r"certificate|hostname|verify"):
        _https_get(srv.port, ctx, host="other.example.test")


def test_https_default_context_rejects_self_signed(tls_server: tuple[_TLSServer, Path]) -> None:
    srv, _ = tls_server
    with pytest.raises(egress.EgressError, match=r"certificate|verify"):
        _https_get(srv.port, ssl.create_default_context())


def test_https_rebinding_refused_before_tls_handshake(internal_server: _LocalServer) -> None:
    """The peer is refused after TCP connect and before the TLS ClientHello."""
    fake, _ = _rebinding_getaddrinfo(internal_server.port, first=PUBLIC_IP, then="127.0.0.1")
    with patch.object(socket, "getaddrinfo", fake), pytest.raises(egress.EgressBlocked):
        egress.get(f"https://{HOST}:{internal_server.port}/")
    assert bytes(internal_server.received) == b""


# --- Webhook delivery path -----------------------------------------------------

User = get_user_model()


@pytest.fixture
def delivery(db: object) -> WebhookDelivery:
    cal = Calendar.objects.create(name="Standard")
    project = Project.objects.create(name="Rebind", start_date=date(2026, 3, 1), calendar=cal)
    user = User.objects.create_user(username="rebind_owner", password="pw")
    hook = Webhook.objects.create(
        project=project,
        url=f"http://{HOST}:9/hook",
        secret="s" * 32,
        events=["task.created"],
        created_by=user,
    )
    return WebhookDelivery.objects.create(
        webhook=hook, event_type="task.created", payload={"id": "t1"}
    )


@pytest.mark.django_db
def test_webhook_delivery_rebinding_refused_and_not_counted(
    delivery: WebhookDelivery, internal_server: _LocalServer
) -> None:
    Webhook.objects.filter(pk=delivery.webhook_id).update(
        url=f"http://{HOST}:{internal_server.port}/hook"
    )
    fake, _ = _rebinding_getaddrinfo(internal_server.port, first=PUBLIC_IP, then="127.0.0.1")
    with patch.object(socket, "getaddrinfo", fake):
        wh_tasks.deliver_webhook.run(str(delivery.pk))
    assert bytes(internal_server.received) == b""
    delivery.refresh_from_db()
    assert delivery.status == DeliveryStatus.FAILED
    assert delivery.response_status is None
    # Guard-neutral: a rebinding answer is not evidence about receiver health.
    delivery.webhook.refresh_from_db()
    assert delivery.webhook.is_active


@pytest.mark.django_db
def test_webhook_delivery_stable_public_answer_delivers(
    delivery: WebhookDelivery, internal_server: _LocalServer
) -> None:
    Webhook.objects.filter(pk=delivery.webhook_id).update(
        url=f"http://{HOST}:{internal_server.port}/hook"
    )
    seq = iter([PUBLIC_IP])

    def fake(h: Any, p: Any, *a: Any, **k: Any) -> Any:
        if h == HOST:
            ip = next(seq, "127.0.0.1")
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, internal_server.port))]
        return _real_getaddrinfo(h, p, *a, **k)

    with (
        patch.object(socket, "getaddrinfo", fake),
        patch.object(egress, "_peer_ip", lambda s: ipaddress.ip_address(PUBLIC_IP)),
    ):
        wh_tasks.deliver_webhook.run(str(delivery.pk))
    delivery.refresh_from_db()
    assert delivery.status == DeliveryStatus.SUCCESS
    assert delivery.response_status == 200
