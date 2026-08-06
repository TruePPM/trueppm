"""The client surfaces the API's refusal taxonomy instead of discarding it (#2689).

The API records a two-axis refusal taxonomy on every refused agent call and, since
ADR-0809, returns it in the 401/403 body. This client used to raise a bare
``AuthError``/``ApiError`` derived from the status code alone and never read the
body, so an operator saw an HTTP status and had to make a second, separate call to
``GET /agent-actions/?constraint=…`` to learn why.

These are the client half. They are deliberately **not** a stand-in for the API
contract test (``packages/api/tests/apps/agents/test_refusal_disclosure.py``):
these mock the response, so they prove the client reads the shape correctly and
prove nothing about the server producing it. Both halves are required.
"""

from __future__ import annotations

from collections.abc import Callable

import httpx
import pytest

from trueppm_mcp.client import (
    AUTH_VERIFY_PATH,
    ApiError,
    AuthError,
    Refusal,
    TruePPMClient,
    parse_refusal,
)
from trueppm_mcp.config import Settings

MockFactory = Callable[
    [httpx.Response | Callable[[httpx.Request], httpx.Response]], httpx.MockTransport
]

IDENTITY_BODY = {
    "detail": "Invalid or expired token.",
    "refusal": {
        "verdict": "refused",
        "reason": "identity",
        "constraint": "token_identity",
    },
}

POLICY_BODY = {
    "detail": "You do not have permission to perform this action.",
    "refusal": {
        "verdict": "refused",
        "reason": "policy",
        "constraint": "capability_scope",
    },
}


# ---------------------------------------------------------------------------
# parse_refusal — total by design
# ---------------------------------------------------------------------------


class TestParseRefusal:
    """A malformed envelope must never turn a clean 403 into a client-side crash."""

    def test_parses_a_full_envelope(self) -> None:
        refusal = parse_refusal(httpx.Response(403, json=POLICY_BODY))
        assert refusal == Refusal(verdict="refused", reason="policy", constraint="capability_scope")

    def test_withheld_constraint_is_absence_not_failure(self) -> None:
        """The API discloses constraints from an allow-list.

        A refusal whose constraint is withheld still explains itself at the coarse
        axis, and the client must present that rather than treating the partial
        envelope as unparseable.
        """
        response = httpx.Response(403, json={"refusal": {"verdict": "refused", "reason": "policy"}})
        refusal = parse_refusal(response)
        assert refusal == Refusal(verdict="refused", reason="policy", constraint="")
        assert refusal.describe() == "policy refusal"

    @pytest.mark.parametrize(
        ("label", "response"),
        [
            ("no envelope", httpx.Response(403, json={"detail": "nope"})),
            ("envelope is not an object", httpx.Response(403, json={"refusal": "policy"})),
            ("reason missing", httpx.Response(403, json={"refusal": {"verdict": "refused"}})),
            ("reason not a string", httpx.Response(403, json={"refusal": {"reason": 7}})),
            ("reason empty", httpx.Response(403, json={"refusal": {"reason": ""}})),
            ("body is a list", httpx.Response(403, json=[1, 2, 3])),
            ("body is not JSON", httpx.Response(403, content=b"<html>gateway</html>")),
            ("body is empty", httpx.Response(403, content=b"")),
        ],
    )
    def test_unusable_bodies_yield_none(self, label: str, response: httpx.Response) -> None:
        assert parse_refusal(response) is None, label

    def test_missing_verdict_defaults_rather_than_discarding(self) -> None:
        """``reason`` is the load-bearing field; a missing verdict is not fatal.

        An older or partial server that sends a reason without a verdict still
        told the operator something useful, and discarding it would reintroduce
        exactly the silence this issue is about.
        """
        refusal = parse_refusal(httpx.Response(401, json={"refusal": {"reason": "identity"}}))
        assert refusal == Refusal(verdict="refused", reason="identity", constraint="")


# ---------------------------------------------------------------------------
# Over the client
# ---------------------------------------------------------------------------


async def test_auth_error_carries_the_identity_refusal(
    settings: Settings, make_transport: MockFactory
) -> None:
    transport = make_transport(httpx.Response(401, json=IDENTITY_BODY))
    async with TruePPMClient(settings, transport=transport) as client:
        with pytest.raises(AuthError) as exc_info:
            await client.verify_auth()

    assert exc_info.value.refusal == Refusal("refused", "identity", "token_identity")
    assert "identity refusal (token_identity)" in str(exc_info.value)


async def test_get_surfaces_a_policy_refusal(
    settings: Settings, make_transport: MockFactory
) -> None:
    transport = make_transport(httpx.Response(403, json=POLICY_BODY))
    async with TruePPMClient(settings, transport=transport) as client:
        with pytest.raises(ApiError) as exc_info:
            await client.get("projects/")

    assert exc_info.value.refusal == Refusal("refused", "policy", "capability_scope")
    assert "policy refusal (capability_scope)" in str(exc_info.value)


async def test_error_without_a_refusal_still_raises_cleanly(
    settings: Settings, make_transport: MockFactory
) -> None:
    """An older server, or a plain 404, must behave exactly as before.

    ``refusal`` is ``None`` — "no reason given" — and the message keeps its
    original shape. A caller must never read ``None`` as an error in itself.
    """
    transport = make_transport(httpx.Response(404, json={"detail": "Not found."}))
    async with TruePPMClient(settings, transport=transport) as client:
        with pytest.raises(ApiError) as exc_info:
            await client.get("projects/nope/")

    assert exc_info.value.refusal is None
    assert "HTTP 404." in str(exc_info.value)


async def test_refusal_message_never_contains_token_material(
    settings: Settings, make_transport: MockFactory
) -> None:
    """The pre-existing guarantee survives the richer message.

    The whole point of the change is a more informative error, which is exactly
    the change most likely to start echoing the credential.
    """
    from tests.conftest import SAMPLE_TOKEN

    transport = make_transport(httpx.Response(401, json=IDENTITY_BODY))
    async with TruePPMClient(settings, transport=transport) as client:
        with pytest.raises(AuthError) as exc_info:
            await client.verify_auth()

    assert SAMPLE_TOKEN not in str(exc_info.value)
    assert AUTH_VERIFY_PATH in str(exc_info.value) or "token" in str(exc_info.value)
