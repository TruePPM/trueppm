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

Fail-closed on a configured-but-unusable transport (#2886 item 2). This module
used to log a warning and fall back to the process-global ``EMAIL_BACKEND`` when
the stored password would not decrypt or the stored host failed the egress guard.
The intent — one corrupt row must not dead-letter a whole drain batch — was
sound; the effect was that mail configured for the operator's relay went out over
an entirely different transport (or into a console/dummy backend and nowhere at
all) while the Email settings page still reported ``configured_via: "database"``
and ``password_is_set: true``. Both faults now raise
:class:`EmailTransportError`, and the queued drains catch it, log an ERROR, and
leave their rows pending rather than burning retries on a configuration fault
that an operator fix will clear. :func:`transport_status` exposes the same
condition as a read-derived signal, which is what the System Health card and the
``trueppm_email_transport_unavailable`` gauge report on — the fail-closed path is
therefore observable rather than merely silent-but-safe.

This matches ``apps.integrations.encryption``, which has always been fail-closed:
``decrypt_secret`` raises ``CredentialEncryptionError`` rather than returning a
usable-looking empty string. Falling open was this module's own deviation from
the mechanism it borrows.
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
        # Do NOT copy the EgressBlocked text into EmailTransportError: it can
        # embed the DNS-resolved internal address, which the serializer would
        # otherwise surface to the client (SSRF oracle). Log the detail, raise a
        # curated message (security review M1; CodeQL py/stack-trace-exposure).
        logger.info("SMTP host rejected by egress guard (host=%s port=%s): %s", host, port, exc)
        raise EmailTransportError(
            "The mail server host is not permitted — it resolves to a non-public address."
        ) from exc
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


# Read-derived transport-status literals (#2886). Reported by the System Health
# notification card and by the ``trueppm_email_transport_unavailable`` gauge.
TRANSPORT_OK = "ok"
TRANSPORT_GLOBAL = "global"  # cloud / unconfigured — the process-global backend
TRANSPORT_UNDECRYPTABLE = "undecryptable"


def resolve_email_connection(
    settings_obj: WorkspaceEmailSettings | None = None,
) -> BaseEmailBackend:
    """Return the mail connection for the workspace's configured transport.

    ``cloud`` / unconfigured → the process-global ``EMAIL_BACKEND`` (today's
    behaviour). Otherwise an SMTP connection built from the singleton, with the
    password decrypted here and the host SSRF-re-checked at send time.

    Raises:
        EmailTransportError: The workspace has a transport configured but it cannot
            be built — the stored password will not decrypt (the encryption key
            rotated out from under the row) or the stored host fails the egress
            guard. This is deliberately **not** a fall back to the global backend:
            sending the operator's mail over a transport they did not configure,
            while the settings page reports the configured one, is a silent reroute
            (#2886 item 2). Callers on a queued path catch this and leave their rows
            pending; callers on a synchronous path surface a generic failure.
    """
    from .models import EmailTransportMode, WorkspaceEmailSettings

    obj = settings_obj or WorkspaceEmailSettings.load()
    if obj.transport_mode == EmailTransportMode.CLOUD:
        return cast("BaseEmailBackend", get_connection())

    try:
        password = obj.get_password()
    except Exception as exc:
        # ERROR, not WARNING: no mail leaves the workspace until an operator
        # re-enters the password, so this is an outage rather than a degradation.
        logger.error(
            "resolve_email_connection: could not decrypt the stored SMTP password "
            "(transport=%s host=%s) — refusing to send over a different transport. "
            "The encryption key may have rotated; re-enter the password in "
            "Workspace -> Email.",
            obj.transport_mode,
            obj.host,
        )
        raise EmailTransportError(
            "The stored mail credential could not be decrypted. Re-enter the "
            "password for this transport."
        ) from exc

    return build_smtp_connection(
        transport_mode=str(obj.transport_mode),
        host=obj.host,
        port=obj.port,
        security=str(obj.security),
        username=obj.username,
        password=password,
    )


def transport_status(settings_obj: WorkspaceEmailSettings | None = None) -> str:
    """Classify whether the configured transport's credential can be used, on read.

    The credential fault in :func:`resolve_email_connection` is a deterministic
    function of committed state (the stored ciphertext) and live configuration (the
    encryption key) — not of anything a worker writes. So the web process can evaluate
    it directly, which is what makes this a *positive* health signal rather than an
    inference from the absence of one: it is true at the instant the credential breaks,
    with no row having to fail first and no window in which anything could clear it.

    Deliberately does **not** re-run the egress guard. That check resolves DNS, and
    this function is called on a polled health endpoint and a Prometheus scrape — a
    lookup per poll is a real egress and latency cost for a fault the queued-backlog
    signal already catches (a host the guard rejects makes every send raise, so rows
    stay pending and the notification card's aging-backlog signal fires).

    Returns one of :data:`TRANSPORT_OK`, :data:`TRANSPORT_GLOBAL` (no workspace
    transport configured — the process-global backend is in use, which is the shipped
    default and not a fault), or :data:`TRANSPORT_UNDECRYPTABLE`. Never raises: a
    status probe that can throw is unusable in a health endpoint.
    """
    from .models import EmailTransportMode, WorkspaceEmailSettings

    try:
        obj = settings_obj or WorkspaceEmailSettings.load()
        if obj.transport_mode == EmailTransportMode.CLOUD:
            return TRANSPORT_GLOBAL
        try:
            obj.get_password()
        except Exception:
            return TRANSPORT_UNDECRYPTABLE
    except Exception:  # pragma: no cover — guard, not behavior
        logger.warning("transport_status: could not classify the mail transport", exc_info=True)
        return TRANSPORT_OK
    return TRANSPORT_OK


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
