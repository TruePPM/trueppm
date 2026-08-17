"""The notification-email drain honors the operator's delivery limits (#2860)."""

from __future__ import annotations

from types import SimpleNamespace

from trueppm_api.apps.notifications.tasks import EMAIL_BATCH_SIZE, _drain_batch_size

# ---------------------------------------------------------------------------
# Operator delivery limits actually bound the drain (#2860)
# ---------------------------------------------------------------------------


class TestDrainBatchSize:
    """``max_recipients`` and ``throttle_per_min`` were dead controls.

    Both persisted, validated and rendered back in Workspace -> Email while the
    drain capped every tick at a hardcoded ``EMAIL_BATCH_SIZE = 50`` regardless.
    ``_drain_batch_size`` is the consumer they never had.
    """

    @staticmethod
    def _settings(max_recipients: int = 0, throttle_per_min: int = 0) -> SimpleNamespace:
        return SimpleNamespace(max_recipients=max_recipients, throttle_per_min=throttle_per_min)

    def test_defaults_fall_back_to_the_module_cap(self) -> None:
        assert _drain_batch_size(self._settings()) == EMAIL_BATCH_SIZE

    def test_max_recipients_caps_the_tick(self) -> None:
        assert _drain_batch_size(self._settings(max_recipients=10)) == 10

    def test_a_max_above_the_module_cap_does_not_raise_it(self) -> None:
        """EMAIL_BATCH_SIZE also protects the worker from one monopolizing tick."""
        assert _drain_batch_size(self._settings(max_recipients=5000)) == EMAIL_BATCH_SIZE

    def test_throttle_is_per_minute_and_divided_across_ticks(self) -> None:
        """The queue drains every 30s, so a per-minute rate is half of it per tick."""
        assert _drain_batch_size(self._settings(throttle_per_min=20)) == 10

    def test_zero_throttle_means_no_throttle(self) -> None:
        """``0`` is the documented sentinel and the shipped default."""
        assert _drain_batch_size(self._settings(throttle_per_min=0)) == EMAIL_BATCH_SIZE

    def test_the_tighter_of_the_two_limits_wins(self) -> None:
        assert _drain_batch_size(self._settings(max_recipients=3, throttle_per_min=20)) == 3
        assert _drain_batch_size(self._settings(max_recipients=30, throttle_per_min=4)) == 2

    def test_a_sub_tick_throttle_still_sends_one(self) -> None:
        """A rate limit that can deadlock the queue is worse than rounding up.

        ``throttle_per_min=1`` integer-divides to 0 per tick; the queue would never
        drain again. One per tick over-delivers a very low rate; zero is a stall.
        """
        assert _drain_batch_size(self._settings(throttle_per_min=1)) == 1
