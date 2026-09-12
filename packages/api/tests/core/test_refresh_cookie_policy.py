"""Tests for the refresh-cookie SameSite validator (#3556, ADR-0604 ack pattern)."""

from __future__ import annotations

import pytest

from trueppm_api.core.refresh_cookie_policy import (
    REFRESH_COOKIE_SAMESITE_NONE_ACK_SENTINEL,
    resolve_refresh_cookie_samesite,
)


class TestResolveRefreshCookieSamesite:
    """Pure resolution — no Django needed."""

    def test_strict_is_silent(self) -> None:
        result = resolve_refresh_cookie_samesite(requested="Strict", ack="")
        assert result.value == "Strict"
        assert result.warning is None
        assert result.critical is None

    @pytest.mark.parametrize("casing", ["strict", "STRICT", "Strict", " Strict "])
    def test_strict_is_case_and_whitespace_insensitive(self, casing: str) -> None:
        result = resolve_refresh_cookie_samesite(requested=casing, ack="")
        assert result.value == "Strict"
        assert result.warning is None
        assert result.critical is None

    def test_lax_is_accepted_with_a_warning(self) -> None:
        result = resolve_refresh_cookie_samesite(requested="Lax", ack="")
        assert result.value == "Lax"
        assert result.warning is not None
        assert "cross-site" in result.warning
        assert result.critical is None

    @pytest.mark.parametrize("casing", ["lax", "LAX", "Lax"])
    def test_lax_casing_is_normalized(self, casing: str) -> None:
        result = resolve_refresh_cookie_samesite(requested=casing, ack="")
        assert result.value == "Lax"

    def test_none_with_valid_ack_is_accepted_with_a_critical(self) -> None:
        result = resolve_refresh_cookie_samesite(
            requested="None", ack=REFRESH_COOKIE_SAMESITE_NONE_ACK_SENTINEL
        )
        assert result.value == "None"
        assert result.warning is None
        assert result.critical is not None
        assert "ACTIVE" in result.critical

    def test_none_without_ack_falls_back_to_strict(self) -> None:
        # Fail toward the protected state (Strict), never toward a silent
        # weakening — mirrors resolve_rate_limit_enabled's refusal shape.
        result = resolve_refresh_cookie_samesite(requested="None", ack="")
        assert result.value == "Strict"
        assert result.warning is None
        assert result.critical is not None
        assert "Ignoring" in result.critical

    def test_none_with_wrong_ack_falls_back_to_strict(self) -> None:
        result = resolve_refresh_cookie_samesite(requested="None", ack="yes-please")
        assert result.value == "Strict"
        assert result.critical is not None

    @pytest.mark.parametrize("bad_value", ["", "  ", "none-ish", "Permissive", "STRICTLY"])
    def test_unrecognized_value_falls_back_to_strict(self, bad_value: str) -> None:
        result = resolve_refresh_cookie_samesite(requested=bad_value, ack="")
        assert result.value == "Strict"
        assert result.warning is None
        assert result.critical is not None
        assert "not a recognized SameSite value" in result.critical

    def test_ack_alone_does_not_relax_strict_or_lax(self) -> None:
        # The ack sentinel only matters for the None branch — it must not act
        # as a blanket "trust me" for other values.
        strict = resolve_refresh_cookie_samesite(
            requested="Strict", ack=REFRESH_COOKIE_SAMESITE_NONE_ACK_SENTINEL
        )
        assert strict.value == "Strict"
        assert strict.critical is None

        lax = resolve_refresh_cookie_samesite(
            requested="Lax", ack=REFRESH_COOKIE_SAMESITE_NONE_ACK_SENTINEL
        )
        assert lax.value == "Lax"
        assert lax.critical is None
