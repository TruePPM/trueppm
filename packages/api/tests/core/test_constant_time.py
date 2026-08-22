"""Properties the two constant-time comparison call sites depend on (#2881, #2929).

The primitive exists because ``compare_digest`` raises ``TypeError`` on a
non-ASCII ``str``, and both call sites feed it caller-controlled text. These
tests pin the three properties that make it a safe replacement rather than just
a non-raising one.
"""

from __future__ import annotations

import pytest

from trueppm_api.core.constant_time import constant_time_equal


@pytest.mark.parametrize(
    "value",
    [
        pytest.param("", id="empty"),
        pytest.param("plain-ascii-token", id="ascii"),
        pytest.param("nevér-issued", id="latin1"),
        pytest.param("state-\U0001f4a5", id="astral"),
    ],
)
def test_identical_values_compare_equal_whatever_the_code_points(value: str) -> None:
    assert constant_time_equal(value, value) is True


@pytest.mark.parametrize(
    ("provided", "expected"),
    [
        pytest.param("abc", "abd", id="ascii-mismatch"),
        pytest.param("nevér-a", "nevér-b", id="latin1-mismatch"),
        pytest.param("nevér-issued", "never-issued", id="non-ascii-vs-ascii"),
        pytest.param("state-\U0001f4a5", "state-", id="astral-vs-prefix"),
        pytest.param("", "not-empty", id="empty-vs-value"),
    ],
)
def test_different_values_never_compare_equal(provided: str, expected: str) -> None:
    assert constant_time_equal(provided, expected) is False


def test_it_does_not_raise_where_compare_digest_would() -> None:
    """The whole point: the stdlib call this replaces raises here, and DRF 500s on it."""
    import hmac

    with pytest.raises(TypeError):
        hmac.compare_digest("nevér-issued", "never-issued")

    assert constant_time_equal("nevér-issued", "never-issued") is False


def test_latin1_utf8_confusables_do_not_collide() -> None:
    """Both sides must take the *same* codec, or unequal strings compare equal.

    ``"Ã©"`` encodes under latin-1 to the same two bytes ``"é"`` does under utf-8.
    The #2881 helper this replaced encoded ``provided`` with latin-1 and ``expected``
    with utf-8, so that pair compared equal. It was unreachable at the time — the
    webhook secret carries an enforced ASCII invariant (``BoardAutomation.set_secret``)
    and a server-minted OAuth state is ASCII by construction — but a shared primitive
    is used by callers that have not been written yet, so the asymmetry is closed
    rather than documented.
    """
    assert "Ã©".encode("latin-1") == "é".encode()
    assert constant_time_equal("Ã©", "é") is False
