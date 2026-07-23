"""Tests for the global rate-limit kill switch (ADR-0604, #2316)."""

from __future__ import annotations

from django.test import override_settings
from rest_framework.throttling import BaseThrottle

from trueppm_api.core.ratelimit import (
    RATE_LIMIT_DISABLE_ACK_SENTINEL,
    apply_rate_limit_disable,
    bypass_when_disabled,
    rate_limiting_disabled,
    resolve_rate_limit_enabled,
)


class TestResolveRateLimitEnabled:
    """The two-key acknowledgment resolution — pure, no Django needed."""

    def test_enabled_default_is_silent(self) -> None:
        assert resolve_rate_limit_enabled(requested_enabled=True, ack="") == (True, None)

    def test_disabled_with_valid_ack(self) -> None:
        enabled, message = resolve_rate_limit_enabled(
            requested_enabled=False, ack=RATE_LIMIT_DISABLE_ACK_SENTINEL
        )
        assert enabled is False
        assert message is not None and "DISABLED" in message

    def test_disabled_without_ack_is_refused(self) -> None:
        # Fail toward the protected state (limits ON), never toward an outage.
        enabled, message = resolve_rate_limit_enabled(requested_enabled=False, ack="")
        assert enabled is True
        assert message is not None and "remains ENABLED" in message

    def test_disabled_with_wrong_ack_is_refused(self) -> None:
        enabled, message = resolve_rate_limit_enabled(requested_enabled=False, ack="please")
        assert enabled is True
        assert message is not None


class TestApplyRateLimitDisable:
    """The DRF-config transform that neutralizes every SimpleRateThrottle scope."""

    def test_empties_classes_and_nones_rates(self) -> None:
        config: dict[str, object] = {
            "DEFAULT_THROTTLE_CLASSES": ["a.B", "c.D"],
            "DEFAULT_THROTTLE_RATES": {"user": "1000/min", "anon": "60/min"},
        }
        apply_rate_limit_disable(config)
        assert config["DEFAULT_THROTTLE_CLASSES"] == []
        assert config["DEFAULT_THROTTLE_RATES"] == {"user": None, "anon": None}

    def test_idempotent_and_handles_missing_rates(self) -> None:
        config: dict[str, object] = {"DEFAULT_THROTTLE_CLASSES": []}
        apply_rate_limit_disable(config)
        apply_rate_limit_disable(config)
        assert config["DEFAULT_THROTTLE_CLASSES"] == []
        assert config["DEFAULT_THROTTLE_RATES"] == {}


class TestRateLimitingDisabled:
    @override_settings(RATE_LIMIT_ENABLED=False)
    def test_true_when_flag_false(self) -> None:
        assert rate_limiting_disabled() is True

    @override_settings(RATE_LIMIT_ENABLED=True)
    def test_false_when_flag_true(self) -> None:
        assert rate_limiting_disabled() is False


class _DenyThrottle(BaseThrottle):
    """A throttle that denies every request and records that it ran."""

    called = False

    def allow_request(self, request: object, view: object) -> bool:
        type(self).called = True
        return False


class TestBypassWhenDisabled:
    """The @bypass_when_disabled decorator applied to the custom Redis throttles."""

    @override_settings(RATE_LIMIT_ENABLED=False)
    def test_short_circuits_without_calling_original(self) -> None:
        cls = bypass_when_disabled(type("_D1", (_DenyThrottle,), {"called": False}))
        assert cls().allow_request(object(), object()) is True
        # The wrapped body — which would deny and touch Redis — never runs.
        assert cls.called is False

    @override_settings(RATE_LIMIT_ENABLED=True)
    def test_delegates_when_enabled(self) -> None:
        cls = bypass_when_disabled(type("_D2", (_DenyThrottle,), {"called": False}))
        assert cls().allow_request(object(), object()) is False
        assert cls.called is True
