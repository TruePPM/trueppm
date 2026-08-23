"""The client surfaces a 429 as an actionable wait, not an opaque error (#2924).

``client.py`` folded every non-401 response into ``"Unexpected response from
<path>: HTTP 429."`` — the model saw a sentence, not a retry hint, and had no way
to know the same call would succeed shortly.

That is not a rare edge. ``MCP_TOKEN_COMPUTE_RATE`` is **12/min** and covers
``whatif``, ``monte-carlo/latest``, ``forecast`` and ``sprint-forecast`` — exactly
the tools an agent exercises in a burst while exploring a schedule. The
first-five-minutes experience of the 0.4 headliner was an agent hitting the wall
and reporting a nonspecific failure.

These are the client half only: the responses are mocked, so they prove the client
reads ``Retry-After`` correctly and prove nothing about the API emitting it.
"""

from __future__ import annotations

from collections.abc import Callable

import httpx
import pytest

from trueppm_mcp.client import (
    AUTH_VERIFY_PATH,
    ApiError,
    RateLimitError,
    TruePPMClient,
    parse_retry_after,
)
from trueppm_mcp.config import Settings

MockFactory = Callable[
    [httpx.Response | Callable[[httpx.Request], httpx.Response]], httpx.MockTransport
]


# --------------------------------------------------------------------------- #
# Retry-After parsing
# --------------------------------------------------------------------------- #


def test_delta_seconds_is_parsed() -> None:
    response = httpx.Response(429, headers={"Retry-After": "30"})
    assert parse_retry_after(response) == 30.0


def test_http_date_is_parsed_against_the_servers_own_date() -> None:
    """Using the response's Date header keeps client clock skew out of the wait."""
    response = httpx.Response(
        429,
        headers={
            "Date": "Wed, 21 Oct 2026 07:28:00 GMT",
            "Retry-After": "Wed, 21 Oct 2026 07:28:45 GMT",
        },
    )
    assert parse_retry_after(response) == 45.0


def test_a_malformed_date_header_does_not_crash_the_parse() -> None:
    """Both parsedate calls raise on junk; neither may crash the 429 path."""
    response = httpx.Response(
        429, headers={"Date": "not-a-date", "Retry-After": "Wed, 21 Oct 2026 07:28:45 GMT"}
    )
    # Falls back to local time rather than raising; the value is unpredictable
    # here, so assert only that it did not blow up and stayed sane.
    result = parse_retry_after(response)
    assert result is None or result >= 0


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Retry-After": ""},
        {"Retry-After": "soon"},
        {"Retry-After": "-5"},
        {"Date": "Wed, 21 Oct 2026 07:28:00 GMT", "Retry-After": "Wed, 21 Oct 2026 07:27:00 GMT"},
    ],
    ids=["absent", "empty", "unparseable", "negative", "date-in-the-past"],
)
def test_unusable_headers_degrade_to_no_hint(headers: dict[str, str]) -> None:
    """A malformed header must never crash the call that is already failing."""
    assert parse_retry_after(httpx.Response(429, headers=headers)) is None


# --------------------------------------------------------------------------- #
# get()
# --------------------------------------------------------------------------- #


async def test_get_raises_rate_limit_error_carrying_the_wait(
    settings: Settings, make_transport: MockFactory
) -> None:
    transport = make_transport(httpx.Response(429, headers={"Retry-After": "42"}))
    async with TruePPMClient(settings, transport=transport) as client:
        with pytest.raises(RateLimitError) as excinfo:
            await client.get("projects/abc/monte-carlo/whatif/")

    assert excinfo.value.retry_after == 42.0
    message = str(excinfo.value)
    # The model must be able to act on the message alone.
    assert "429" in message
    assert "42 second(s)" in message
    assert "Retry the same call" in message


async def test_rate_limit_error_is_an_api_error(
    settings: Settings, make_transport: MockFactory
) -> None:
    """Existing `except ApiError` handlers keep working."""
    transport = make_transport(httpx.Response(429))
    async with TruePPMClient(settings, transport=transport) as client:
        with pytest.raises(ApiError):
            await client.get("projects/")


async def test_missing_header_still_tells_the_model_to_wait(
    settings: Settings, make_transport: MockFactory
) -> None:
    transport = make_transport(httpx.Response(429))
    async with TruePPMClient(settings, transport=transport) as client:
        with pytest.raises(RateLimitError) as excinfo:
            await client.get("projects/")

    assert excinfo.value.retry_after is None
    assert "wait a few seconds and retry" in str(excinfo.value).lower()


async def test_other_error_statuses_are_unchanged(
    settings: Settings, make_transport: MockFactory
) -> None:
    """Only 429 changes shape — a 404 stays a plain ApiError."""
    transport = make_transport(httpx.Response(404))
    async with TruePPMClient(settings, transport=transport) as client:
        with pytest.raises(ApiError) as excinfo:
            await client.get("projects/nope/")

    assert not isinstance(excinfo.value, RateLimitError)
    assert "Unexpected response" in str(excinfo.value)


# --------------------------------------------------------------------------- #
# verify_auth()
# --------------------------------------------------------------------------- #


async def test_verify_auth_reports_a_rate_limit_as_such(
    settings: Settings, make_transport: MockFactory
) -> None:
    """Boot-time auth check: a throttled instance must not read as a bad token."""
    transport = make_transport(httpx.Response(429, headers={"Retry-After": "10"}))
    async with TruePPMClient(settings, transport=transport) as client:
        with pytest.raises(RateLimitError) as excinfo:
            await client.verify_auth()

    assert excinfo.value.retry_after == 10.0
    assert AUTH_VERIFY_PATH in str(excinfo.value)
