"""Outbound-email delivery limits and the shared per-minute budget.

#2860 gave ``max_recipients`` / ``throttle_per_min`` their first consumer; #2887
made that consumer shared, so the invite drain and the transactional one-off sends
draw from the same allowance instead of each having their own.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from django.core.cache import cache

from trueppm_api.apps.notifications.delivery_limits import (
    EMAIL_MAX_BATCH_SIZE,
    beat_ticks_per_minute,
    note_unbudgeted_send,
    per_tick_cap,
    reserve_send_budget,
)
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
        """EMAIL_BATCH_SIZE also protects the worker from one monopolizing tick.

        The serializer now *rejects* a value above the ceiling instead of accepting,
        persisting and echoing it back before silently discarding it (#2887 item 2) —
        see ``test_workspace_email_settings``. This clamp remains as the runtime
        backstop for a row written before that validation existed.
        """
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


# ---------------------------------------------------------------------------
# The per-tick divisor is derived, not hand-copied (#2887 item 4)
# ---------------------------------------------------------------------------


class TestBeatTicksPerMinute:
    """``EMAIL_DRAIN_TICKS_PER_MINUTE = 2`` was a second copy of the beat cadence.

    Its comment said "keep in step with the beat schedule" and nothing enforced it;
    changing ``schedule: 30.0`` would have made ``throttle_per_min`` silently mean
    something other than what it says. Deriving the divisor deletes the second copy.
    """

    def test_derives_the_real_cadence_from_the_beat_schedule(self) -> None:
        """Both mail drains are on ``schedule: 30.0`` in settings today."""
        assert beat_ticks_per_minute("notifications.drain_notification_emails") == 2
        assert beat_ticks_per_minute("workspace.drain_invite_emails") == 2

    def test_tracks_a_changed_cadence(self, settings: object) -> None:
        settings.CELERY_BEAT_SCHEDULE = {
            "x": {"task": "notifications.drain_notification_emails", "schedule": 10.0}
        }
        assert beat_ticks_per_minute("notifications.drain_notification_emails") == 6

    def test_a_slower_than_minutely_cadence_under_delivers(self, settings: object) -> None:
        """1 is the floor: a tick may spend a full minute's allowance but runs less
        often than once a minute, so the realized rate is below the configured one —
        the safe direction for a rate limit."""
        settings.CELERY_BEAT_SCHEDULE = {
            "x": {"task": "notifications.drain_notification_emails", "schedule": 300.0}
        }
        assert beat_ticks_per_minute("notifications.drain_notification_emails") == 1

    def test_unknown_task_or_cron_entry_falls_back(self, settings: object) -> None:
        assert beat_ticks_per_minute("nope.not_a_task", default=3) == 3
        settings.CELERY_BEAT_SCHEDULE = {"x": {"task": "t", "schedule": object()}}
        assert beat_ticks_per_minute("t", default=4) == 4


# ---------------------------------------------------------------------------
# One shared per-minute budget across every mail path (#2887 item 3)
# ---------------------------------------------------------------------------


class TestSharedSendBudget:
    """``throttle_per_min`` claimed to bound "the most messages TruePPM sends per
    minute" while only ``notifications.drain_notification_emails`` consulted it.

    The invite drain ran on the same 30 s cadence with its own hardcoded batch of
    50, so an operator who dialed the throttle down to protect a rate-limited relay
    was still exposed to a bulk-invite burst at double the configured rate.
    """

    @pytest.fixture(autouse=True)
    def _clear_cache(self) -> None:
        cache.clear()

    def test_no_throttle_grants_everything_untouched(self) -> None:
        assert reserve_send_budget(0, 40).granted == 40

    def test_two_paths_share_one_minute_allowance(self) -> None:
        """The whole point: the second caller sees what the first already spent."""
        assert reserve_send_budget(20, 15).granted == 15
        assert reserve_send_budget(20, 15).granted == 5
        assert reserve_send_budget(20, 15).granted == 0

    def test_an_unspent_reservation_is_returned(self) -> None:
        """An idle drain must not starve the other paths for the rest of the minute."""
        budget = reserve_send_budget(20, 20)
        assert budget.granted == 20
        budget.release(18)
        assert reserve_send_budget(20, 20).granted == 18

    def test_a_transactional_send_charges_without_being_refused(self) -> None:
        """Password reset and export-ready always send, but they tighten the drains.

        Refusing a user-blocking reset because a batch of invites spent the minute
        would be a worse failure than briefly exceeding a soft rate.
        """
        note_unbudgeted_send(10, 4)
        assert reserve_send_budget(10, 10).granted == 6

    def test_zero_request_grants_zero(self) -> None:
        assert reserve_send_budget(20, 0).granted == 0

    def test_a_cache_fault_grants_in_full_rather_than_stopping_mail(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The budget is advisory smoothing; a Valkey blip must not wedge the queue."""

        def boom(*_a: object, **_k: object) -> None:
            raise RuntimeError("cache down")

        monkeypatch.setattr(cache, "add", boom)
        assert reserve_send_budget(5, 30).granted == 30


class TestPerTickCap:
    def test_fallback_is_configurable_per_caller(self) -> None:
        s = SimpleNamespace(max_recipients=0, throttle_per_min=0)
        assert per_tick_cap(s, ticks_per_minute=2, fallback=7) == 7
        assert per_tick_cap(s, ticks_per_minute=2) == EMAIL_MAX_BATCH_SIZE

    def test_a_zero_tick_rate_cannot_divide_by_zero(self) -> None:
        s = SimpleNamespace(max_recipients=0, throttle_per_min=10)
        assert per_tick_cap(s, ticks_per_minute=0) == 10
