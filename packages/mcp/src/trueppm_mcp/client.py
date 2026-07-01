"""Async HTTP client for the TruePPM REST API.

The MCP server is *only* an HTTP client of the public REST API (ADR-0186 §C/§I):
it never imports Django, never touches the ORM or the database, and never imports
from the proprietary enterprise repo. Authorization — RBAC role gates,
member-scoped querysets, the 404-vs-403 existence oracle — is enforced once, at
the API layer, identically for this client and the web client. This module holds
no privileged path and is not the security boundary.

The bearer token is set as a request header and is never logged.
"""

from __future__ import annotations

from collections.abc import Mapping
from types import TracebackType
from typing import Any

import httpx

from trueppm_mcp.config import Settings

#: Connection-verification endpoint (relative to ``/api/v1/``). Returns the
#: identity of the token's owner; a 401 means the token does not authenticate.
AUTH_VERIFY_PATH = "auth/me/"

#: Per-request timeout (seconds). Read tools are simple GETs; a slow API should
#: surface as a clear error rather than hang the AI client indefinitely.
DEFAULT_TIMEOUT = 30.0


class ApiError(RuntimeError):
    """Raised when the API returns an unexpected (non-401) error status."""


class AuthError(RuntimeError):
    """Raised when the API rejects the configured bearer token (HTTP 401)."""


class TruePPMClient:
    """Thin async wrapper over ``httpx.AsyncClient`` carrying the bearer token.

    Args:
        settings: Resolved :class:`~trueppm_mcp.config.Settings`.
        transport: Optional ``httpx`` transport. Injected in tests
            (``httpx.MockTransport``); ``None`` uses the real network transport.
        timeout: Per-request timeout in seconds.
    """

    def __init__(
        self,
        settings: Settings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        # A trailing slash on the base URL makes httpx's RFC-3986 relative join
        # append the path segment instead of replacing the last one, so
        # "auth/me/" resolves to ".../api/v1/auth/me/".
        self._client = httpx.AsyncClient(
            base_url=f"{settings.api_base_url}/",
            headers={
                "Authorization": f"Bearer {settings.token}",
                "Accept": "application/json",
            },
            timeout=timeout,
            transport=transport,
        )

    async def verify_auth(self) -> dict[str, Any]:
        """Confirm the token authenticates by calling ``GET /auth/me/``.

        Returns:
            The identity payload (the token owner's user record) on HTTP 200.

        Raises:
            AuthError: On HTTP 401 — the token is missing, malformed, or revoked.
            ApiError: On any other non-success status.
        """
        response = await self._client.get(AUTH_VERIFY_PATH)
        if response.status_code == httpx.codes.UNAUTHORIZED:
            # No token material in the message — only the fact of rejection.
            raise AuthError("The TruePPM API rejected the configured token (HTTP 401).")
        if response.is_error:
            raise ApiError(
                f"Unexpected response from {AUTH_VERIFY_PATH}: HTTP {response.status_code}."
            )
        result: dict[str, Any] = response.json()
        return result

    async def get(self, path: str, params: Mapping[str, Any] | None = None) -> Any:
        """Issue an authenticated ``GET`` and return the decoded JSON body.

        Every read tool routes through here (ADR-0186 §D/§I): the request is a
        plain ``GET`` against ``/api/v1/<path>`` carrying the bearer token, so
        authorization is enforced once, at the API layer, exactly as for the web
        client. This method holds no privileged path.

        Args:
            path: Path relative to the ``/api/v1/`` base (e.g. ``"projects/"`` or
                ``"projects/{id}/forecast/"``). No leading slash.
            params: Optional query parameters. Callers omit ``None`` values; a
                filter left unset is simply not sent.

        Returns:
            The decoded JSON body — a ``dict`` for object endpoints, a ``list``
            or paginated ``dict`` for collection endpoints.

        Raises:
            AuthError: On HTTP 401 — the token is missing, malformed, or revoked.
                The message never contains token material.
            ApiError: On any other error status (404 for a resource the caller
                cannot read, 5xx, etc.).
        """
        response = await self._client.get(path, params=dict(params) if params else None)
        if response.status_code == httpx.codes.UNAUTHORIZED:
            # No token material in the message — only the fact of rejection.
            raise AuthError("The TruePPM API rejected the configured token (HTTP 401).")
        if response.is_error:
            raise ApiError(f"Unexpected response from {path}: HTTP {response.status_code}.")
        return response.json()

    async def aclose(self) -> None:
        """Close the underlying connection pool."""
        await self._client.aclose()

    async def __aenter__(self) -> TruePPMClient:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self.aclose()
