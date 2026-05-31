"""Content-Security-Policy response-header middleware (#897).

A strict CSP is the primary defense-in-depth control against XSS: even if an
injection lands, ``script-src 'self'`` forbids inline and remote script
execution, ``base-uri 'none'`` blocks base-tag hijacking, and
``frame-ancestors 'none'`` prevents clickjacking. The policy is assembled from
settings so the ``connect-src`` host (e.g. the wss:// endpoint) and the
theme-init script hash can be overridden per deploy without code changes.

The CSP is set as an HTTP response header (not only a ``<meta>`` tag) because
``frame-ancestors`` and a handful of other directives are ignored when delivered
via ``<meta>`` — the header is authoritative.
"""

from __future__ import annotations

from collections.abc import Callable

from django.conf import settings
from django.http import HttpRequest, HttpResponse


def _build_policy() -> str:
    """Assemble the CSP header value from ``settings.CSP_DIRECTIVES``.

    Each directive maps to a list of source expressions; they are joined into the
    standard ``name src1 src2; name2 ...`` header syntax. Centralizing the policy
    in settings keeps per-deploy overrides (connect-src host, script hash) in one
    place rather than scattered string concatenation.
    """
    directives: dict[str, list[str]] = settings.CSP_DIRECTIVES
    parts = []
    for name, sources in directives.items():
        if sources:
            parts.append(f"{name} {' '.join(sources)}")
        else:
            # Valueless directive (e.g. nothing) is uncommon; emit the name alone.
            parts.append(name)
    return "; ".join(parts)


class ContentSecurityPolicyMiddleware:
    """Attach a ``Content-Security-Policy`` header to every response."""

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response
        # Build once at process start — the policy is static per deploy.
        self.policy = _build_policy()

    def __call__(self, request: HttpRequest) -> HttpResponse:
        response = self.get_response(request)
        # Do not clobber a per-view CSP if one was already set deliberately.
        response.setdefault("Content-Security-Policy", self.policy)
        return response
