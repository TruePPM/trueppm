"""SSRF-guarded outbound HTTP helper for the integrations app (ADR-0049 §3).

Two integration surfaces make request-cycle HTTP calls to user/operator-supplied
hosts: PAT verification (#677, ``TaskLinkProvider.verify_token``) and git-link
status refresh (#637, ``fetch_status``). Both must defend against SSRF — a PAT's
``base_url`` or a pasted git URL could point at ``169.254.169.254`` (cloud
metadata), ``127.0.0.1`` (loopback), or an RFC1918 host on the cluster network.

This module is the single egress chokepoint. ``assert_url_allowed`` resolves the
target host and rejects any URL that resolves to a private / loopback /
link-local / reserved address; ``get`` validates first, then performs a
time-bounded, redirect-disabled GET with a capped response body. Both #677 and
#637 route through it so the guard is implemented and tested once.

The guard resolves the hostname and checks **every** returned address — a host
with one public and one private A record is rejected. A residual DNS-rebinding
TOCTOU window (re-resolution between check and connect) is accepted for the OSS
tier; pinning the connection to the validated IP would break TLS SNI / cert
validation and is an Enterprise hardening item (ADR-0049 §6).
"""

from __future__ import annotations

import ipaddress
import json
import socket
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

# Synchronous, request-cycle calls — the user is staring at a spinner. Short
# by design; 5s is the ADR-0049 §3 budget for the refresh endpoint.
DEFAULT_TIMEOUT = 5.0

# Cap the response body we buffer. Provider ``/user`` and PR/issue payloads are
# a few KB; anything larger is either hostile or not what we asked for. Reading
# a bounded amount prevents a malicious endpoint from exhausting memory.
_MAX_BODY_BYTES = 256 * 1024

_USER_AGENT = "TruePPM-Integrations/1.0"


class EgressBlocked(Exception):
    """The URL failed the SSRF guard (bad scheme, missing host, or the host
    resolved to a private / loopback / link-local / reserved address)."""


class EgressTimeout(Exception):
    """The request exceeded :data:`DEFAULT_TIMEOUT` (or the caller's timeout)."""


class EgressError(Exception):
    """A transport-level failure — DNS resolution failed, the connection was
    refused, or the socket errored. Distinct from an HTTP error *response*,
    which is returned as an :class:`EgressResponse` so callers can branch on
    the status code (a 401 from ``/user`` means "bad token", not "unreachable").
    """


@dataclass(frozen=True)
class EgressResponse:
    """A buffered HTTP response from a guarded GET.

    Non-2xx responses are returned, not raised — ``verify_token`` needs to read
    a 401/403 to distinguish an invalid token from an unreachable host.
    """

    status: int
    body: bytes
    headers: dict[str, str]

    def json(self) -> Any:
        """Parse the body as JSON, or return ``None`` if it is not valid JSON.

        Providers occasionally answer a 200 with an HTML error page (e.g. a
        login redirect landing). Returning ``None`` lets the caller treat an
        unparseable 200 as "verified but no metadata" rather than 500ing.
        """
        try:
            return json.loads(self.body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None


def _is_blocked_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Return ``True`` for any address an outbound integration call must not reach.

    ``is_global`` is ``False`` for the entire special-use space — private
    (RFC1918), loopback, link-local (incl. ``169.254.169.254`` cloud metadata),
    reserved, multicast, and unspecified — so the single negated check covers
    every SSRF target the ADR-0049 deny-list enumerates without maintaining a
    hand-rolled CIDR table that drifts from the IANA registry.
    """
    return not ip.is_global


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Disable redirect following so a 3xx can't bounce the request to an
    internal host that the original (validated) URL did not resolve to.

    Returning ``None`` from ``redirect_request`` tells urllib not to follow the
    redirect; the 3xx response is surfaced to the caller as-is.
    """

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def assert_url_allowed(url: str) -> None:
    """Raise :class:`EgressBlocked` / :class:`EgressError` if ``url`` is unsafe to fetch.

    Validates the scheme is ``http``/``https``, the host is present, and that
    **every** address the host resolves to is globally routable. Shared by
    #677 PAT verification and #637 git-link refresh so the SSRF policy has one
    implementation and one test surface.

    Raises:
        EgressBlocked: Bad scheme, missing host, or a resolved address is
            private / loopback / link-local / reserved.
        EgressError: The host could not be resolved (DNS failure).
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise EgressBlocked(f"scheme {parsed.scheme!r} is not allowed")
    host = parsed.hostname
    if not host:
        raise EgressBlocked("URL has no host")
    # A bracketed/parseable literal IP still has to clear the deny-list — a
    # user can paste http://169.254.169.254 directly, no DNS involved.
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise EgressError(f"could not resolve host {host!r}") from exc
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:  # pragma: no cover — getaddrinfo returns valid IPs
            raise EgressBlocked(f"unparseable address {addr!r}") from None
        if _is_blocked_ip(ip):
            raise EgressBlocked(f"host {host!r} resolves to non-public address {addr}")


def get(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> EgressResponse:
    """Perform an SSRF-guarded, redirect-disabled, time-bounded GET.

    The URL is validated by :func:`assert_url_allowed` before any socket is
    opened. Non-2xx responses are returned (not raised) so callers can read the
    status code; only transport failures raise.

    Raises:
        EgressBlocked: The URL failed the SSRF guard.
        EgressTimeout: The request exceeded ``timeout``.
        EgressError: DNS / connection / socket failure.
    """
    assert_url_allowed(url)
    request_headers = {"User-Agent": _USER_AGENT, **(headers or {})}
    req = urllib.request.Request(url, headers=request_headers, method="GET")
    try:
        # URL is SSRF-validated by assert_url_allowed above; redirects are
        # disabled via the _NoRedirect opener so a 3xx can't escape the guard.
        with _opener.open(req, timeout=timeout) as resp:  # nosec B310
            body = resp.read(_MAX_BODY_BYTES)
            resp_headers = {k.lower(): v for k, v in resp.headers.items()}
            return EgressResponse(status=resp.status, body=body, headers=resp_headers)
    except urllib.error.HTTPError as exc:
        # An HTTP error response is still a response — return it so the caller
        # can map 401/403 → invalid token and 5xx → unreachable.
        try:
            body = exc.read(_MAX_BODY_BYTES)
        except (AttributeError, OSError, ValueError):  # no body / closed fp
            body = b""
        resp_headers = {k.lower(): v for k, v in (exc.headers or {}).items()}
        return EgressResponse(status=exc.code, body=body, headers=resp_headers)
    except TimeoutError as exc:
        raise EgressTimeout(f"request to {url!r} timed out after {timeout}s") from exc
    except urllib.error.URLError as exc:
        # URLError wraps socket.timeout on some platforms.
        if isinstance(exc.reason, (TimeoutError, socket.timeout)):
            raise EgressTimeout(f"request to {url!r} timed out after {timeout}s") from exc
        raise EgressError(f"request to {url!r} failed: {exc.reason}") from exc
    except OSError as exc:
        raise EgressError(f"request to {url!r} failed: {exc}") from exc
