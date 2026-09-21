"""Tests for the Compose-only celery worker self-exit watchdog (#3936).

Covers:
  - self_heal_enabled(): off by default, on for "1"/"true"/"yes" (any case),
    off for anything else
  - stale_seconds(): default, override, and the fallback policy for a
    missing/non-numeric/non-positive value
  - the watchdog loop: a fresh heartbeat does not self-exit, a stale one does
    (with the dedicated exit code), a briefly-missing file is not treated as
    infinite staleness, and the stop event ends the loop without a check
  - worker_ready only starts the watchdog when self-heal is enabled
  - worker_shutting_down stops the watchdog
  - the handlers are actually connected to celery's signals, not merely defined
"""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Any

import pytest

from trueppm_api.core import worker_selfheal


class TestSelfHealEnabled:
    def test_default_is_disabled(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv(worker_selfheal._ENABLE_ENV, raising=False)
        assert worker_selfheal.self_heal_enabled() is False

    @pytest.mark.parametrize("raw", ["1", "true", "True", "TRUE", "yes", "Yes"])
    def test_truthy_values_enable_it(self, monkeypatch: pytest.MonkeyPatch, raw: str) -> None:
        monkeypatch.setenv(worker_selfheal._ENABLE_ENV, raw)
        assert worker_selfheal.self_heal_enabled() is True

    @pytest.mark.parametrize("raw", ["0", "false", "no", "", "  ", "on"])
    def test_other_values_stay_disabled(self, monkeypatch: pytest.MonkeyPatch, raw: str) -> None:
        monkeypatch.setenv(worker_selfheal._ENABLE_ENV, raw)
        assert worker_selfheal.self_heal_enabled() is False


class TestStaleSeconds:
    def test_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv(worker_selfheal._STALE_SECONDS_ENV, raising=False)
        assert worker_selfheal.stale_seconds() == 90.0

    def test_override(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(worker_selfheal._STALE_SECONDS_ENV, "45")
        assert worker_selfheal.stale_seconds() == 45.0

    @pytest.mark.parametrize("raw", ["soon", "-5", "0", "  "])
    def test_invalid_values_fall_back_to_the_default(
        self, monkeypatch: pytest.MonkeyPatch, raw: str
    ) -> None:
        monkeypatch.setenv(worker_selfheal._STALE_SECONDS_ENV, raw)
        assert worker_selfheal.stale_seconds() == 90.0


class _FakeWait:
    """Returns False `stop_after - 1` times, then True — like Event.wait()."""

    def __init__(self, stop_after: int) -> None:
        self.stop_after = stop_after
        self.calls = 0

    def __call__(self, _timeout: float) -> bool:
        self.calls += 1
        return self.calls >= self.stop_after


class TestWatchdogLoop:
    def test_fresh_heartbeat_never_self_exits(self, tmp_path: Path) -> None:
        path = tmp_path / "heartbeat"
        path.touch()
        exits: list[int] = []
        wait = _FakeWait(stop_after=5)

        worker_selfheal._watchdog_loop(
            path,
            threshold=90.0,
            wait=wait,
            now=time.time,
            exit_=exits.append,
        )
        assert exits == []
        assert wait.calls == 5

    def test_stale_heartbeat_self_exits_with_the_dedicated_code(self, tmp_path: Path) -> None:
        path = tmp_path / "heartbeat"
        path.touch()
        # Backdate the mtime well past the threshold.
        stale_time = time.time() - 200
        os.utime(path, (stale_time, stale_time))
        exits: list[int] = []
        wait = _FakeWait(stop_after=5)

        worker_selfheal._watchdog_loop(
            path,
            threshold=90.0,
            wait=wait,
            now=time.time,
            exit_=exits.append,
        )
        assert exits == [worker_selfheal._EXIT_CODE]
        # Exits on the very first check rather than waiting out all 5 ticks.
        assert wait.calls == 1

    def test_missing_file_is_skipped_not_treated_as_infinite_staleness(
        self, tmp_path: Path
    ) -> None:
        path = tmp_path / "does-not-exist"
        exits: list[int] = []
        wait = _FakeWait(stop_after=3)

        worker_selfheal._watchdog_loop(
            path,
            threshold=90.0,
            wait=wait,
            now=time.time,
            exit_=exits.append,
        )
        assert exits == []
        assert wait.calls == 3

    def test_stop_event_ends_the_loop_immediately(self, tmp_path: Path) -> None:
        path = tmp_path / "heartbeat"
        # Stale, but the wait() returning True on the first call (as it would
        # once the stop event is set) must end the loop before any check runs.
        stale_time = time.time() - 200
        path.touch()
        os.utime(path, (stale_time, stale_time))
        exits: list[int] = []

        worker_selfheal._watchdog_loop(
            path,
            threshold=90.0,
            wait=lambda _t: True,
            now=time.time,
            exit_=exits.append,
        )
        assert exits == []

    def test_real_stop_event_stops_a_running_thread(self, tmp_path: Path) -> None:
        """End-to-end with the real threading.Event, on a real background thread."""
        path = tmp_path / "heartbeat"
        path.touch()
        exits: list[int] = []
        stop = threading.Event()

        thread = threading.Thread(
            target=worker_selfheal._watchdog_loop,
            args=(path,),
            kwargs={
                "threshold": 90.0,
                "check_interval": 0.01,
                "wait": stop.wait,
                "now": time.time,
                "exit_": exits.append,
            },
            daemon=True,
        )
        thread.start()
        time.sleep(0.05)
        stop.set()
        thread.join(timeout=2)
        assert not thread.is_alive()
        assert exits == []


class TestSignalHandlers:
    def test_worker_ready_does_not_start_the_watchdog_when_disabled(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv(worker_selfheal._ENABLE_ENV, raising=False)
        calls: list[float] = []
        monkeypatch.setattr(worker_selfheal, "_start_watchdog", calls.append)

        worker_selfheal._on_worker_ready()

        assert calls == []

    def test_worker_ready_starts_the_watchdog_when_enabled(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(worker_selfheal._ENABLE_ENV, "1")
        monkeypatch.setenv(worker_selfheal._STALE_SECONDS_ENV, "45")
        calls: list[float] = []
        monkeypatch.setattr(worker_selfheal, "_start_watchdog", calls.append)

        worker_selfheal._on_worker_ready()

        assert calls == [45.0]

    def test_worker_shutting_down_sets_the_stop_event(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        event = threading.Event()
        monkeypatch.setattr(worker_selfheal, "_shutting_down", event)

        assert not event.is_set()
        worker_selfheal._on_worker_shutting_down()
        assert event.is_set()


# sender=None makes celery's DjangoFixup skip its own worker_init work (and
# warn about it), the same pattern test_worker_broker_wait.py uses.
@pytest.mark.filterwarnings("ignore::celery.fixups.django.FixupWarning")
class TestSignalWiring:
    def test_worker_ready_is_connected_to_the_handler(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from celery.signals import worker_ready

        import trueppm_api.celery  # noqa: F401 — import for the side effect

        monkeypatch.setenv(worker_selfheal._ENABLE_ENV, "1")
        calls: list[Any] = []
        monkeypatch.setattr(
            worker_selfheal, "_start_watchdog", lambda threshold: calls.append(threshold)
        )

        worker_ready.send(sender=None)

        assert calls, "worker_ready is not connected to the self-heal handler"

    def test_worker_shutting_down_is_connected_to_the_handler(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from celery.signals import worker_shutting_down

        import trueppm_api.celery  # noqa: F401 — import for the side effect

        event = threading.Event()
        monkeypatch.setattr(worker_selfheal, "_shutting_down", event)

        worker_shutting_down.send(sender=None)

        assert event.is_set(), "worker_shutting_down is not connected to the self-heal handler"
