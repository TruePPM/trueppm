"""Dynamic outbound-mail connection resolution (#712, ADR-0213).

All transactional mail is sent through a connection returned by
:func:`resolve_email_connection`, which reads the writable
:class:`~trueppm_api.apps.notifications.models.WorkspaceEmailSettings` singleton
and builds a ``django.core.mail`` SMTP connection from it — overriding the
process-global ``EMAIL_BACKEND`` when a transport is configured. When the
workspace transport is ``cloud`` (the unconfigured default) it falls back to the
global backend, so a fresh install behaves exactly as it did before #712.

Security posture (ADR-0213 §4, security review C1/H1/H2/M1):
- The custom SMTP / SES host is SSRF-checked with ``assert_host_allowed`` both
  at save (serializer) *and* here at send time — closing the DNS-rebinding
  window where a host resolves public at save and private at send.
- The Fernet-encrypted password is decrypted only here, server-side, never
  logged and never returned by the API.
- Connection-build failures raise :class:`EmailTransportError` carrying a
  generic message; callers must not surface the underlying ``smtplib``
  exception (which can echo credentials) to clients.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, cast

from django.conf import settings
from django.core.mail import get_connection

if TYPE_CHECKING:
    from django.core.mail.backends.base import BaseEmailBackend

    from .models import WorkspaceEmailSettings

logger = logging.getLogger(__name__)

_SMTP_BACKEND = "django.core.mail.backends.smtp.EmailBackend"

# Provider-fixed relay parameters. SendGrid's SMTP relay uses a constant host and
# the literal username "apikey" (the API key travels as the password); SES uses a
# region-specific host that the UI composes into ``host`` (ADR-0213 §2). Both are
# STARTTLS on 587, so 0.4 needs no backend class beyond Django's SMTP backend.
SENDGRID_HOST = "smtp.sendgrid.net"
SENDGRID_PORT = 587
SENDGRID_USERNAME = "apikey"
SES_PORT = 587


class EmailTransportError(RuntimeError):
    """A workspace mail transport could not be built or opened.

    Carries a client-safe message only — never the underlying ``smtplib``
    exception or the connection kwargs (which include the password).
    """


def _effective_smtp(
    *,
    transport_mode: str,
    host: str,
    port: int,
    security: str,
    username: str,
) -> tuple[str, int, str, str]:
    """Resolve (host, port, username, security) after applying provider defaults.

    Each provider's fixed host/port/username is applied so the caller only ever
    supplies the credential and (for SES) the region-composed host.
    """
    if transport_mode == "sendgrid":
        return SENDGRID_HOST, SENDGRID_PORT, SENDGRID_USERNAME, "tls"
    if transport_mode == "ses":
        # host is the region relay (email-smtp.<region>.amazonaws.com), composed
        # by the UI; only port/security are forced.
        return host, SES_PORT, username, "tls"
    return host, port, username, security


def build_smtp_connection(
    *,
    transport_mode: str,
    host: str,
    port: int,
    security: str,
    username: str,
    password: str,
    validate_host: bool = True,
) -> BaseEmailBackend:
    """Build (but do not open) an SMTP connection for a non-cloud transport.

    Used both by the serializer's validate-before-persist probe (with the
    *incoming* candidate values) and by :func:`resolve_email_connection` (with
    the persisted model values). Re-runs the SSRF host check unless a caller has
    already validated the exact same host in the same request.

    Raises:
        EmailTransportError: The host resolves to a non-public address.
    """
    eff_host, eff_port, eff_username, eff_security = _effective_smtp(
        transport_mode=transport_mode,
        host=host,
        port=port,
        security=security,
        username=username,
    )
    if validate_host:
        _assert_host_public(eff_host, eff_port)
    # Never enable smtplib debuglevel — it prints the base64 AUTH line
    # (username + password) to stderr (security review M1).
    conn = get_connection(
        _SMTP_BACKEND,
        host=eff_host,
        port=eff_port,
        username=eff_username,
        password=password,
        use_tls=eff_security == "tls",
        use_ssl=eff_security == "ssl",
        timeout=getattr(settings, "EMAIL_TIMEOUT", 10),
    )
    return cast("BaseEmailBackend", conn)


def _assert_host_public(host: str, port: int) -> None:
    """SSRF guard for the SMTP relay host (ADR-0213 §4). Blocks internal targets.

    A DNS-resolution failure is allowed through (the host may resolve later and
    the actual connect will fail cleanly), mirroring the webhook-URL validator;
    a host that resolves to a private/loopback/link-local/metadata address is
    rejected outright.
    """
    from trueppm_api.apps.integrations.http import (
        EgressBlocked,
        EgressError,
        assert_host_allowed,
    )

    try:
        assert_host_allowed(host, port)
    except EgressBlocked as exc:
        raise EmailTransportError(str(exc)) from exc
    except EgressError:
        # Unresolvable now; the connect attempt re-checks and fails cleanly.
        return


def probe_transport(
    *,
    transport_mode: str,
    host: str,
    port: int,
    security: str,
    username: str,
    password: str,
) -> None:
    """Open and immediately close a candidate SMTP connection, or raise.

    The validate-before-persist gate (ADR-0213 §3): a bad transport must be
    rejected *before* the row is written so the workspace can't be locked out of
    mail. Raises :class:`EmailTransportError` with a **generic** message on any
    build or connect failure — the underlying ``smtplib`` exception (which can
    echo credentials) is deliberately swallowed (security review M1).
    """
    try:
        conn = build_smtp_connection(
            transport_mode=transport_mode,
            host=host,
            port=port,
            security=security,
            username=username,
            password=password,
        )
    except EmailTransportError:
        raise
    try:
        conn.open()
        conn.close()
    except Exception as exc:
        logger.info(
            "probe_transport: connect failed (transport=%s host=%s port=%s)",
            transport_mode,
            host,
            port,
        )
        raise EmailTransportError(
            "Could not connect to the mail server. Check the host, port, security, and credentials."
        ) from exc


def resolve_email_connection(
    settings_obj: WorkspaceEmailSettings | None = None,
) -> BaseEmailBackend:
    """Return the mail connection for the workspace's configured transport.

    ``cloud`` / unconfigured → the process-global ``EMAIL_BACKEND`` (today's
    behaviour). Otherwise an SMTP connection built from the singleton, with the
    password decrypted here and the host SSRF-re-checked at send time.

    On a decrypt failure (e.g. the encryption key rotated out from under a
    stored row) this logs a distinct warning and falls back to the global
    backend rather than letting one corrupt row dead-letter the whole drain
    batch (ADR-0213 §Durable-Execution 8, security review L3).
    """
    from .models import EmailTransportMode, WorkspaceEmailSettings

    obj = settings_obj or WorkspaceEmailSettings.load()
    if obj.transport_mode == EmailTransportMode.CLOUD:
        return cast("BaseEmailBackend", get_connection())

    try:
        password = obj.get_password()
    except Exception:
        logger.warning(
            "resolve_email_connection: could not decrypt stored SMTP password "
            "(transport=%s host=%s) — falling back to the global mail backend. "
            "The encryption key may have rotated; re-enter the password.",
            obj.transport_mode,
            obj.host,
        )
        return cast("BaseEmailBackend", get_connection())

    try:
        return build_smtp_connection(
            transport_mode=str(obj.transport_mode),
            host=obj.host,
            port=obj.port,
            security=str(obj.security),
            username=obj.username,
            password=password,
        )
    except EmailTransportError:
        logger.warning(
            "resolve_email_connection: SMTP host failed the SSRF guard "
            "(transport=%s host=%s) — falling back to the global mail backend.",
            obj.transport_mode,
            obj.host,
        )
        return cast("BaseEmailBackend", get_connection())


def resolve_from_email(settings_obj: WorkspaceEmailSettings | None = None) -> str:
    """Return the effective From header ("Name <addr>" or the settings default)."""
    from .models import WorkspaceEmailSettings

    obj = settings_obj or WorkspaceEmailSettings.load()
    addr = obj.from_email.strip()
    if not addr:
        return getattr(settings, "DEFAULT_FROM_EMAIL", "notifications@trueppm.local")
    name = obj.from_name.strip()
    return f"{name} <{addr}>" if name else addr


def resolve_reply_to(settings_obj: WorkspaceEmailSettings | None = None) -> list[str]:
    """Return the reply-to list for outbound mail, or [] when unset."""
    from .models import WorkspaceEmailSettings

    obj = settings_obj or WorkspaceEmailSettings.load()
    return [obj.reply_to.strip()] if obj.reply_to.strip() else []
