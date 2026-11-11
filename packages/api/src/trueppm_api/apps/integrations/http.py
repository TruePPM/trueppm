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
with one public and one private A record is rejected. That pre-flight check
alone is resolve-then-reconnect: the connection performs its own lookup, so a
low-TTL record could answer the check with a public address and the connect with
``169.254.169.254``. The connection layer therefore resolves the name once,
refuses if any answer is non-public, and dials only those checked addresses —
never connecting to a rebinding answer — then re-checks ``getpeername()`` as
defense in depth, all before TLS or any request byte
(:func:`build_guarded_opener`). This closes the
DNS-rebinding window without rewriting the URL (the hostname — and so SNI and
certificate verification — is untouched). Every urllib-based egress caller must
use that opener; webhook delivery shares it.

**Proxies.** The opener honors ``HTTP_PROXY`` / ``HTTPS_PROXY`` / ``NO_PROXY``
through urllib's normal ``ProxyHandler``. A request that goes **direct** gets the
connect-time peer check. A request that goes **through a proxy** gets only the
resolve-time pre-flight (:func:`assert_url_allowed`, advisory): the connected
peer is the proxy, which does the resolving and is the real egress control, so
checking it would be meaningless (and would reject a private proxy address). A
one-time WARNING is logged when a proxied request is first made.

**Operator allow-lists (ADR-0590, scoped per purpose by #2851).** A self-hoster
who runs an identity provider *inside the same cluster* has an OIDC issuer that
resolves to a private ClusterIP (e.g. ``keycloak.sso.svc``); the deny-list above
would block discovery / token / JWKS and make in-cluster SSO impossible. The
operator can name exact hostnames that bypass the private-address check — but each
list is bound to one :class:`EgressPurpose`, and a caller only consults the list for
the purpose it declares. An IdP host trusted for SSO is therefore **not** reachable
through a project Admin's webhook URL, a pasted git link, or a user's connected
account, which take user-supplied destinations. The settings are
``EGRESS_ALLOWLISTED_HOSTS_SSO`` (plus the legacy ``EGRESS_ALLOWLISTED_HOSTS``, which
now applies to SSO only), ``EGRESS_ALLOWLISTED_HOSTS_SMTP``,
``EGRESS_ALLOWLISTED_HOSTS_INTEGRATIONS`` and ``EGRESS_ALLOWLISTED_HOSTS_WEBHOOKS``.
Each is **operator configuration only** — never derived from request or user input
— and matches on an **exact, case-insensitive hostname** (no wildcard / suffix), so
allow-listing ``keycloak`` cannot admit ``keycloak.attacker.example``. A caller that
passes no purpose gets no exemption at all (fail closed), so a new egress caller
cannot inherit another surface's trust by omission.
"""

from __future__ import annotations

import enum
import functools
import http.client
import ipaddress
import json
import logging
import socket
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

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


# RFC6052 well-known NAT64 prefix. ``64:ff9b::/96`` embeds an IPv4 address in
# its low 32 bits; a NAT64 gateway (common on dual-stack k8s) translates it back
# to that IPv4 on the wire. Python reports the wrapper as ``is_global`` True, so
# without unwrapping it a user-supplied ``[64:ff9b::a9fe:a9fe]`` URL would reach
# cloud metadata (169.254.169.254) straight through the guard (#900).
_NAT64_WELLKNOWN = ipaddress.ip_network("64:ff9b::/96")


def _embedded_ipv4(ip: ipaddress.IPv6Address) -> ipaddress.IPv4Address | None:
    """Extract the IPv4 address tunneled inside a transition-format IPv6 address.

    Covers the forms whose ``is_global`` reflects the *wrapper* rather than the
    embedded target, so a private/metadata IPv4 can be smuggled past the guard:
    IPv4-mapped (``::ffff:0:0/96``), 6to4 (``2002::/16``), Teredo, the RFC6052
    NAT64 well-known prefix, and the deprecated IPv4-compatible form
    (``::a.b.c.d``, ``::/96``). Returns ``None`` for a native IPv6 address.
    """
    if ip.ipv4_mapped is not None:
        return ip.ipv4_mapped
    if ip.sixtofour is not None:
        return ip.sixtofour
    if ip.teredo is not None:
        return ip.teredo[1]
    if ip in _NAT64_WELLKNOWN:
        return ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
    # IPv4-compatible (deprecated, RFC4291 ``::/96``). No stdlib accessor: the
    # high 96 bits are zero and the low 32 are the embedded IPv4. ``is_global``
    # is True on the wrapper, so ``[::169.254.169.254]`` would otherwise reach
    # metadata. Exclude ``::`` (unspecified) and ``::1`` (loopback) — those are
    # native IPv6 that ``is_global`` already blocks, not tunneled IPv4.
    as_int = int(ip)
    if as_int >> 32 == 0 and as_int > 1:
        return ipaddress.IPv4Address(as_int & 0xFFFFFFFF)
    return None


def _is_blocked_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Return ``True`` for any address an outbound integration call must not reach.

    ``is_global`` is ``False`` for the entire special-use space — private
    (RFC1918), loopback, link-local (incl. ``169.254.169.254`` cloud metadata),
    reserved, multicast, and unspecified — so the single negated check covers
    every SSRF target the ADR-0049 deny-list enumerates without maintaining a
    hand-rolled CIDR table that drifts from the IANA registry.

    IPv6 transition formats are unwrapped first: ``is_global`` is computed on the
    wrapper, so a metadata/RFC1918 IPv4 tunneled via NAT64, 6to4, Teredo, or an
    IPv4-mapped address would otherwise pass. The embedded IPv4 is re-checked
    through this same guard (#900).
    """
    if isinstance(ip, ipaddress.IPv6Address):
        embedded = _embedded_ipv4(ip)
        if embedded is not None:
            return _is_blocked_ip(embedded)
    return not ip.is_global


class EgressPurpose(enum.StrEnum):
    """Which surface an egress call serves — selects the operator allow-list it honors.

    The deny-list is identical for every purpose; only the operator's exemption
    differs. Scoping it is the point (#2851, #3561): the allow-list exists so an
    operator can reach a *specific* trusted internal service from the surface that
    needs it, and a flat list let every user-supplied URL surface reach it too.
    """

    #: OIDC / OAuth discovery, token exchange, JWKS, GitHub login (ADR-0187). The
    #: destination is operator-configured (a workspace admin's IdP issuer).
    SSO = "sso"
    #: Workspace SMTP relay reachability (ADR-0213 §4).
    SMTP = "smtp"
    #: A user's connected account — PAT verification, git-link status refresh and
    #: the external task sources (ADR-0097 / ADR-0589). User-supplied destinations.
    INTEGRATIONS = "integrations"
    #: Outbound webhook delivery and registration. Project-Admin-supplied URLs.
    WEBHOOKS = "webhooks"


#: Settings consulted for each purpose. The legacy un-suffixed
#: ``EGRESS_ALLOWLISTED_HOSTS`` keeps working for its documented, intended use —
#: an in-cluster IdP — and for nothing else; before #2851 it applied to every
#: purpose, which is the amplification this mapping removes.
_PURPOSE_SETTINGS: dict[EgressPurpose, tuple[str, ...]] = {
    EgressPurpose.SSO: ("EGRESS_ALLOWLISTED_HOSTS_SSO", "EGRESS_ALLOWLISTED_HOSTS"),
    EgressPurpose.SMTP: ("EGRESS_ALLOWLISTED_HOSTS_SMTP",),
    EgressPurpose.INTEGRATIONS: ("EGRESS_ALLOWLISTED_HOSTS_INTEGRATIONS",),
    EgressPurpose.WEBHOOKS: ("EGRESS_ALLOWLISTED_HOSTS_WEBHOOKS",),
}


def _allowlisted_hosts(purpose: EgressPurpose | None) -> frozenset[str]:
    """Operator-trusted hostnames exempt from the deny-list for ``purpose`` (ADR-0590).

    ``None`` — a caller that declared no purpose — gets the empty set, so an
    unclassified caller is held to the full deny-list rather than inheriting some
    other surface's exemption.

    Safety: the values are **configuration only** — never request/user-derived — so
    they cannot be widened by an attacker. Membership is an **exact, case-insensitive
    hostname** compare, so an allow-listed ``keycloak`` never admits a lookalike
    like ``keycloak.attacker.example``. ``django.conf`` is imported lazily to keep
    this module importable without Django configured (it is otherwise pure stdlib).
    """
    if purpose is None:
        return frozenset()
    from django.conf import settings

    hosts: set[str] = set()
    for name in _PURPOSE_SETTINGS[EgressPurpose(purpose)]:
        for h in getattr(settings, name, ()) or ():
            if h and h.strip():
                hosts.add(h.strip().lower())
    return frozenset(hosts)


def _blocked_if_literal(host: str) -> bool | None:
    """Return the deny-decision for ``host`` if it is an IP literal, else ``None``.

    A literal IP needs no DNS. Classifying it directly avoids a pointless
    ``getaddrinfo`` round-trip on every IP-literal target and — critically —
    removes the only resolver dependency from the guard's rejection of a literal
    SSRF target (``169.254.169.254`` cloud metadata, an RFC1918 host). That deny
    becomes a pure, syscall-free computation, so a constrained network namespace
    (e.g. a CI runner) can never turn it into a transient ``EgressError`` /
    resolver failure and let the caller retry into a real connection (#1628).
    """
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return None
    return _is_blocked_ip(ip)


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Disable redirect following so a 3xx can't bounce the request to an
    internal host that the original (validated) URL did not resolve to.

    Returning ``None`` from ``redirect_request`` tells urllib not to follow the
    redirect; the 3xx response is surfaced to the caller as-is.

    Public so sibling SSRF-guarded callers (webhook delivery, anywhere we POST
    to a user-supplied URL) can compose their own opener without re-deriving
    the handler. The original underscore name is kept as an alias for
    backwards-compatibility inside this module.
    """

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


def _peer_ip(sock: socket.socket) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    """Return the connected peer's IP, or ``None`` if the socket has no peer."""
    try:
        addr = sock.getpeername()[0]
    except OSError:
        return None
    # Strip an IPv6 zone id (``fe80::1%eth0``) that ip_address() rejects.
    try:
        return ipaddress.ip_address(str(addr).split("%", 1)[0])
    except ValueError:
        return None


_DEFAULT_SOCKET_TIMEOUT = socket.getdefaulttimeout()


def _assert_addrinfos_public(host: str, infos: list[Any]) -> None:
    """Refuse if ANY resolved address is non-public (same rule as the pre-flight)."""
    for info in infos:
        addr = str(info[4][0]).split("%", 1)[0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            raise EgressBlocked(f"unparseable address {addr!r}") from None
        if _is_blocked_ip(ip):
            raise EgressBlocked(f"host {host!r} resolves to non-public address {addr}")


def _guarded_create_connection(
    address: tuple[str, int],
    timeout: Any = _DEFAULT_SOCKET_TIMEOUT,
    source_address: tuple[str, int] | None = None,
    *,
    purpose: EgressPurpose | None = None,
) -> socket.socket:
    """``socket.create_connection`` that only ever dials checked addresses (#3849).

    Resolves the name ONCE, refuses if any returned address is non-public, then
    connects to those already-checked sockaddrs with the stdlib try-each-address
    loop. The pre-flight :func:`assert_url_allowed` and a plain connect each
    resolve independently, so a rebinding answer must never be dialed: refusing
    before ``connect`` also means an open and a closed internal port are
    indistinguishable (both a permanent ``EgressBlocked``, no handshake). The
    ``getpeername()`` check after the handshake stays as defense in depth. Runs
    before the TLS wrap and any request byte; the hostname is untouched so SNI and
    certificate verification are unchanged. A host on the operator allow-list for
    ``purpose`` (ADR-0590, exact match) skips the deny-list, as in
    :func:`assert_url_allowed`; the purpose is bound into the connection by the
    opener, so a webhook delivery socket never honors the SSO list.
    """
    host, port = address[0], address[1]
    allowlisted = host.lower().strip("[]") in _allowlisted_hosts(purpose)
    infos = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
    if not infos:
        raise OSError("getaddrinfo returns an empty list")
    if not allowlisted:
        _assert_addrinfos_public(host, infos)
    err: OSError | None = None
    for af, socktype, proto, _canon, sa in infos:
        sock: socket.socket | None = None
        try:
            sock = socket.socket(af, socktype, proto)
            if timeout is not _DEFAULT_SOCKET_TIMEOUT:
                sock.settimeout(timeout)
            if source_address:
                sock.bind(source_address)
            sock.connect(sa)
        except OSError as exc:
            err = exc
            if sock is not None:
                sock.close()
            continue
        if not allowlisted:
            ip = _peer_ip(sock)
            if ip is None or _is_blocked_ip(ip):
                sock.close()
                raise EgressBlocked(f"host {host!r} connected to a non-public address")
        return sock
    assert err is not None
    raise err


class _GuardedHTTPConnection(http.client.HTTPConnection):
    """HTTP connection whose connected peer is deny-list checked (#3849)."""

    def __init__(
        self, *args: Any, egress_purpose: EgressPurpose | None = None, **kwargs: Any
    ) -> None:
        super().__init__(*args, **kwargs)
        self._create_connection = functools.partial(
            _guarded_create_connection, purpose=egress_purpose
        )


class _GuardedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS connection whose peer is checked before the TLS handshake.

    ``HTTPSConnection.connect`` calls the parent ``connect`` (which uses
    ``_create_connection``) and then wraps with ``server_hostname=self.host``, so
    SNI and certificate hostname verification keep using the original name.
    """

    def __init__(
        self, *args: Any, egress_purpose: EgressPurpose | None = None, **kwargs: Any
    ) -> None:
        super().__init__(*args, **kwargs)
        self._create_connection = functools.partial(
            _guarded_create_connection, purpose=egress_purpose
        )


_proxy_warned = False


def _is_proxied(req: urllib.request.Request) -> bool:
    """True if urllib's ProxyHandler rerouted ``req`` through a proxy."""
    return req.has_proxy() or getattr(req, "_tunnel_host", None) is not None


def _note_proxied() -> None:
    global _proxy_warned
    if not _proxy_warned:
        _proxy_warned = True
        logger.warning(
            "Outbound request is going through a proxy (HTTP_PROXY/HTTPS_PROXY): the "
            "connected-IP SSRF guard does not apply behind a proxy; only the resolve-time "
            "pre-flight does. The proxy must enforce egress policy."
        )


class _GuardedHTTPHandler(urllib.request.HTTPHandler):
    def __init__(self, *args: Any, purpose: EgressPurpose | None = None, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._egress_purpose = purpose

    def http_open(self, req: urllib.request.Request) -> Any:
        if _is_proxied(req):
            _note_proxied()
            return self.do_open(http.client.HTTPConnection, req)
        conn = functools.partial(_GuardedHTTPConnection, egress_purpose=self._egress_purpose)
        return self.do_open(conn, req)  # type: ignore[arg-type]


class _GuardedHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self, *args: Any, purpose: EgressPurpose | None = None, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._egress_purpose = purpose

    def https_open(self, req: urllib.request.Request) -> Any:
        ctx = self._context  # type: ignore[attr-defined]
        if _is_proxied(req):
            _note_proxied()
            return self.do_open(http.client.HTTPSConnection, req, context=ctx)
        conn = functools.partial(_GuardedHTTPSConnection, egress_purpose=self._egress_purpose)
        return self.do_open(conn, req, context=ctx)  # type: ignore[arg-type]


def build_guarded_opener(*, purpose: EgressPurpose | None = None) -> urllib.request.OpenerDirector:
    """Build the one opener every user-controlled-URL egress call must use.

    Redirects disabled; env proxies honored (see module docstring); direct
    connections have their connected peer re-checked at connect time. A refused
    peer raises :class:`EgressBlocked` out of ``open`` *unwrapped* — it is not an
    ``OSError``, so urllib's ``do_open`` does not convert it to ``URLError``.
    Proxy settings are read from the environment when this is called.

    ``purpose`` selects the operator allow-list the connect-time check honors
    (:class:`EgressPurpose`); omitted, no host is exempt.
    """
    return urllib.request.build_opener(
        urllib.request.ProxyHandler(),
        NoRedirectHandler,
        _GuardedHTTPHandler(purpose=purpose),
        _GuardedHTTPSHandler(purpose=purpose),
    )


def blocked_reason(exc: BaseException) -> EgressBlocked | None:
    """Return ``exc`` if it is an :class:`EgressBlocked`, or one wrapped as ``.reason``.

    Defensive: the guarded connection's refusal normally propagates unwrapped,
    but a caller may hold a ``URLError`` whose ``reason`` carries it.
    """
    if isinstance(exc, EgressBlocked):
        return exc
    reason = getattr(exc, "reason", None)
    return reason if isinstance(reason, EgressBlocked) else None


_opener = build_guarded_opener()
_purpose_openers: dict[EgressPurpose, urllib.request.OpenerDirector] = {
    p: build_guarded_opener(purpose=p) for p in EgressPurpose
}


def _opener_for(purpose: EgressPurpose | None) -> urllib.request.OpenerDirector:
    """The module opener for ``purpose`` (``None`` → the no-exemption opener)."""
    return _opener if purpose is None else _purpose_openers[EgressPurpose(purpose)]


def assert_url_allowed(url: str, *, purpose: EgressPurpose | None = None) -> None:
    """Raise :class:`EgressBlocked` / :class:`EgressError` if ``url`` is unsafe to fetch.

    Validates the scheme is ``http``/``https``, the host is present, and that
    **every** address the host resolves to is globally routable. Shared by
    #677 PAT verification and #637 git-link refresh so the SSRF policy has one
    implementation and one test surface. ``purpose`` selects which operator
    allow-list may exempt the host (:class:`EgressPurpose`); omitted, none does.

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
    # Operator escape hatch (ADR-0590): a hostname the operator explicitly trusts
    # FOR THIS PURPOSE (e.g. an in-cluster IdP for SSO) bypasses the private-address
    # deny-list. Config-only, exact-match — the scheme gate above still applies.
    if host.lower() in _allowlisted_hosts(purpose):
        return
    # A bracketed/parseable literal IP still has to clear the deny-list — a
    # user can paste http://169.254.169.254 directly — but needs no resolution.
    literal = _blocked_if_literal(host)
    if literal is not None:
        if literal:
            raise EgressBlocked(f"host {host!r} is a non-public address")
        return
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


def assert_host_allowed(host: str, port: int, *, purpose: EgressPurpose | None = None) -> None:
    """Raise :class:`EgressBlocked` / :class:`EgressError` if ``host`` is unsafe.

    Scheme-free sibling of :func:`assert_url_allowed` for non-HTTP egress —
    e.g. an SMTP relay host (#712). It runs the same deny-list check (every
    resolved address must be globally routable) but without the ``http``/
    ``https`` scheme gate, which would reject an SMTP target outright. Reused by
    the workspace-SMTP serializer (validate-at-save) *and* the connection
    resolver (re-validate at send, which narrows but does not close the
    DNS-rebinding window — the SMTP residual is tracked in #4647; ADR-0213 §4).

    Raises:
        EgressBlocked: Missing host or a resolved address is private /
            loopback / link-local / reserved (SSRF to metadata / internal svc).
        EgressError: The host could not be resolved (DNS failure).
    """
    if not host:
        raise EgressBlocked("SMTP host is empty")
    # Operator escape hatch (ADR-0590), shared with assert_url_allowed: a host
    # trusted for ``purpose`` (e.g. an in-cluster SMTP relay) bypasses the deny-list.
    if host.lower() in _allowlisted_hosts(purpose):
        return
    # A literal IP SMTP relay needs no resolution — classify it directly (#1628).
    literal = _blocked_if_literal(host)
    if literal is not None:
        if literal:
            raise EgressBlocked(f"host {host!r} is a non-public address")
        return
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
    purpose: EgressPurpose | None = None,
) -> EgressResponse:
    """Perform an SSRF-guarded, redirect-disabled, time-bounded GET.

    The URL is validated by :func:`assert_url_allowed` before any socket is
    opened. Non-2xx responses are returned (not raised) so callers can read the
    status code; only transport failures raise. ``purpose`` selects the operator
    allow-list honored by both the pre-flight and the connect-time check.

    Raises:
        EgressBlocked: The URL failed the SSRF guard.
        EgressTimeout: The request exceeded ``timeout``.
        EgressError: DNS / connection / socket failure.
    """
    assert_url_allowed(url, purpose=purpose)
    request_headers = {"User-Agent": _USER_AGENT, **(headers or {})}
    req = urllib.request.Request(url, headers=request_headers, method="GET")
    try:
        # URL is SSRF-validated by assert_url_allowed above; redirects are
        # disabled via the _opener (NoRedirectHandler) so a 3xx can't escape the guard.
        with _opener_for(purpose).open(req, timeout=timeout) as resp:  # nosec B310
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
        blocked = blocked_reason(exc)
        if blocked is not None:
            raise blocked from exc
        # URLError wraps socket.timeout on some platforms.
        if isinstance(exc.reason, (TimeoutError, socket.timeout)):
            raise EgressTimeout(f"request to {url!r} timed out after {timeout}s") from exc
        raise EgressError(f"request to {url!r} failed: {exc.reason}") from exc
    except EgressBlocked:
        raise
    except OSError as exc:
        raise EgressError(f"request to {url!r} failed: {exc}") from exc


def post_form(
    url: str,
    *,
    data: dict[str, str],
    headers: dict[str, str] | None = None,
    timeout: float = DEFAULT_TIMEOUT,
    purpose: EgressPurpose | None = None,
) -> EgressResponse:
    """Perform an SSRF-guarded, redirect-disabled, time-bounded form POST.

    Same egress policy as :func:`get` — the URL is validated by
    :func:`assert_url_allowed` before any socket is opened, redirects are
    disabled (a 3xx can't bounce the request to an internal host), the response
    body is capped, and non-2xx responses are returned (not raised) so callers
    can read an OAuth error body. ``data`` is ``application/x-www-form-urlencoded``
    encoded — the OAuth 2.0 token endpoint shape (ADR-0187 SSO token exchange).

    Raises:
        EgressBlocked: The URL failed the SSRF guard.
        EgressTimeout: The request exceeded ``timeout``.
        EgressError: DNS / connection / socket failure.
    """
    assert_url_allowed(url, purpose=purpose)
    body = urllib.parse.urlencode(data).encode("ascii")
    request_headers = {
        "User-Agent": _USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        **(headers or {}),
    }
    req = urllib.request.Request(url, data=body, headers=request_headers, method="POST")
    try:
        # URL is SSRF-validated by assert_url_allowed above; redirects are
        # disabled via the _opener (NoRedirectHandler) so a 3xx can't escape the guard.
        with _opener_for(purpose).open(req, timeout=timeout) as resp:  # nosec B310
            resp_body = resp.read(_MAX_BODY_BYTES)
            resp_headers = {k.lower(): v for k, v in resp.headers.items()}
            return EgressResponse(status=resp.status, body=resp_body, headers=resp_headers)
    except urllib.error.HTTPError as exc:
        try:
            resp_body = exc.read(_MAX_BODY_BYTES)
        except (AttributeError, OSError, ValueError):
            resp_body = b""
        resp_headers = {k.lower(): v for k, v in (exc.headers or {}).items()}
        return EgressResponse(status=exc.code, body=resp_body, headers=resp_headers)
    except TimeoutError as exc:
        raise EgressTimeout(f"request to {url!r} timed out after {timeout}s") from exc
    except urllib.error.URLError as exc:
        blocked = blocked_reason(exc)
        if blocked is not None:
            raise blocked from exc
        if isinstance(exc.reason, (TimeoutError, socket.timeout)):
            raise EgressTimeout(f"request to {url!r} timed out after {timeout}s") from exc
        raise EgressError(f"request to {url!r} failed: {exc.reason}") from exc
    except EgressBlocked:
        raise
    except OSError as exc:
        raise EgressError(f"request to {url!r} failed: {exc}") from exc
