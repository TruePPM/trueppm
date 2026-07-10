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

#: Cap on the number of rows a paginated read tool accumulates before it stops
#: following ``next`` and reports the result as truncated. The API paginates at
#: ``PAGE_SIZE`` (50) rows/page, so this follows up to ~20 pages. It bounds the
#: LLM context a single ``list_*`` tool can spend: a well-behaved list returns in
#: full, and a pathologically large one is capped with an explicit ``truncated``
#: signal rather than silently cut at the first page (#1731).
DEFAULT_MAX_ROWS = 1000


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

    async def get_paginated(
        self,
        path: str,
        params: Mapping[str, Any] | None = None,
        *,
        max_rows: int = DEFAULT_MAX_ROWS,
    ) -> tuple[list[Any], int, bool]:
        """Follow DRF pagination, accumulating rows up to ``max_rows`` (#1731).

        The list tools must not silently reason over only the first page: a DRF
        collection returns ``{count, next, previous, results}`` at ``PAGE_SIZE``
        (50) rows/page, so a bare ``results`` read truncates at 50 with no signal.
        This method follows the absolute ``next`` links until it has ``max_rows``
        rows or runs out of pages, and reports whether more rows exist server-side
        so the caller can tell the model the set is partial.

        Args:
            path: Path relative to the ``/api/v1/`` base (e.g. ``"tasks/"``).
            params: Query parameters for the first page. ``next`` carries its own
                params, so following pages send none of their own.
            max_rows: Stop accumulating once this many rows are collected.

        Returns:
            ``(rows, total_count, truncated)``:
              * ``rows`` — the accumulated result rows, capped at ``max_rows``.
              * ``total_count`` — the server's reported ``count`` (the true total),
                or ``len(rows)`` for an unpaginated (bare-list) body.
              * ``truncated`` — ``True`` when fewer rows were returned than exist
                server-side (``next`` remained, or the cap was hit).

        Raises:
            AuthError: On HTTP 401 (see :meth:`get`).
            ApiError: On any other error status (see :meth:`get`).
        """
        payload = await self.get(path, params=params)
        # An endpoint that returns a bare JSON list is unpaginated; the whole body
        # is the row set (still cap it defensively).
        if isinstance(payload, list):
            return payload[:max_rows], len(payload), len(payload) > max_rows
        if not isinstance(payload, Mapping) or "results" not in payload:
            return [], 0, False

        rows: list[Any] = []
        results = payload.get("results")
        if isinstance(results, list):
            rows.extend(results)
        total_count = payload.get("count")
        next_url = payload.get("next")
        # ``next`` is an absolute URL carrying its own page/query params, so it is
        # passed to get() as the full path with no additional params.
        while isinstance(next_url, str) and next_url and len(rows) < max_rows:
            page = await self.get(next_url)
            if not isinstance(page, Mapping):
                break
            page_results = page.get("results")
            if not isinstance(page_results, list) or not page_results:
                # A well-behaved DRF page never advertises ``next`` past the last
                # populated page. Stop on the first empty/malformed page so a
                # misbehaving server that keeps returning a non-null ``next`` with
                # no rows can't spin this loop — it stays provably bounded.
                break
            rows.extend(page_results)
            next_url = page.get("next")

        truncated = (isinstance(next_url, str) and bool(next_url)) or len(rows) > max_rows
        rows = rows[:max_rows]
        if not isinstance(total_count, int):
            total_count = len(rows)
        # A count larger than what we returned is truncation even if we exhausted
        # ``next`` (defensive against an inconsistent count/next).
        truncated = truncated or total_count > len(rows)
        return rows, total_count, truncated

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
