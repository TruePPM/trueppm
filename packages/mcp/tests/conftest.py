"""Shared fixtures for the trueppm-mcp test suite.

Tests drive the client through ``httpx.MockTransport`` so no network or running
TruePPM instance is required — the API's responses are simulated in-process.
"""

from __future__ import annotations

from collections.abc import Callable

import httpx
import pytest

from trueppm_mcp.config import Settings

# A syntactically valid-looking sample token. Not a real credential — it never
# leaves the test process and is never sent to a live API.
SAMPLE_TOKEN = "tppm_" + "0" * 64

SAMPLE_API_URL = "https://ppm.example.test"


@pytest.fixture
def settings() -> Settings:
    """Resolved settings pointing at the sample instance with the sample token."""
    return Settings.from_env({"TRUEPPM_API_URL": SAMPLE_API_URL, "TRUEPPM_API_TOKEN": SAMPLE_TOKEN})


@pytest.fixture
def make_transport() -> Callable[
    [httpx.Response | Callable[[httpx.Request], httpx.Response]], httpx.MockTransport
]:
    """Factory: build a ``MockTransport`` returning a fixed response or handler."""

    def _make(
        response: httpx.Response | Callable[[httpx.Request], httpx.Response],
    ) -> httpx.MockTransport:
        if isinstance(response, httpx.Response):
            return httpx.MockTransport(lambda _request: response)
        return httpx.MockTransport(response)

    return _make
