"""SMTP email backend whose socket is dialed through the egress guard (#4647).

``assert_host_allowed`` is a resolve-then-connect pre-flight: Django's stock SMTP
backend re-resolves the relay host when it opens the connection, so a low-TTL DNS
record can answer the pre-flight with a public address and the connect with an
internal one (DNS rebinding). This backend closes that window the way the HTTP
opener does (#3849): :func:`~trueppm_api.apps.integrations.http._guarded_create_connection`
resolves the name once, refuses if any answer is non-public, dials only those
checked addresses and re-checks ``getpeername()`` — all before STARTTLS, TLS or
any SMTP byte. The hostname is untouched, so STARTTLS / implicit-TLS certificate
verification (``server_hostname``) is unchanged.

The guard is bound to :attr:`EgressPurpose.SMTP`: only
``EGRESS_ALLOWLISTED_HOSTS_SMTP`` (exact, case-insensitive hostname) exempts a
relay, exactly as in the pre-flight. Proxies do not apply to SMTP.

Lives in ``integrations`` beside the HTTP guard it reuses; the notifications
transport selects it by dotted path, so no new cross-app import is introduced.
"""

from __future__ import annotations

import smtplib
import socket
from typing import Any, cast

from django.core.mail.backends.smtp import EmailBackend

from .http import EgressPurpose, _guarded_create_connection


def _dial(smtp: smtplib.SMTP, host: str, port: int, timeout: float | None) -> socket.socket:
    if timeout is not None and not timeout:
        raise ValueError("Non-blocking socket (timeout=0) is not supported")
    return _guarded_create_connection(
        (host, port),
        timeout,
        cast("tuple[str, int] | None", smtp.source_address),
        purpose=EgressPurpose.SMTP,
    )


class GuardedSMTP(smtplib.SMTP):
    """``smtplib.SMTP`` that connects only to deny-list-checked addresses."""

    def _get_socket(self, host: str, port: int, timeout: float | None) -> socket.socket:
        return _dial(self, host, port, timeout)


class GuardedSMTPSSL(smtplib.SMTP_SSL):
    """Implicit-TLS variant: guard first, then wrap with the original hostname."""

    def _get_socket(self, host: str, port: int, timeout: float | None) -> socket.socket:
        raw = _dial(self, host, port, timeout)
        try:
            # smtplib sets ``_host`` in __init__ but typeshed omits it.
            hostname: str = self._host  # type: ignore[attr-defined]
            return self.context.wrap_socket(raw, server_hostname=hostname)
        except BaseException:
            raw.close()
            raise


class GuardedSMTPEmailBackend(EmailBackend):
    """Django's SMTP backend with the guarded connection classes."""

    @property
    def connection_class(self) -> Any:
        return GuardedSMTPSSL if self.use_ssl else GuardedSMTP
