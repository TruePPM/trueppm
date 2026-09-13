"""Tests for holding a celery worker's start until its broker answers (#3722).

Covers:
  - an already-reachable broker is pinged once, with no sleep
  - connection errors are retried until the broker answers, and counted
  - a broker that never answers exits the process (SystemExit 1), because
    celery's Signal.send would swallow an ordinary exception and start anyway
  - the wait budget env var: default, override, 0 disables, garbage falls back
  - the real ping goes through core.valkey.client on the Celery database
  - the handler is actually connected to celery's worker_init signal
"""

from __future__ import annotations

from typing import Any

import pytest
import redis

from trueppm_api.core import valkey, worker_broker_wait


class _Clock:
    """Fake monotonic clock that advances only when the code under test sleeps."""

    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def _flaky_ping(failures: int) -> Any:
    calls = {"n": 0}

    def ping() -> None:
        calls["n"] += 1
        if calls["n"] <= failures:
            raise redis.ConnectionError("Error 111 connecting to valkey:6379. Connection refused.")

    ping.calls = calls  # type: ignore[attr-defined]
    return ping


class TestWaitForBroker:
    def test_reachable_broker_is_pinged_once_without_sleeping(self) -> None:
        clock = _Clock()
        ping = _flaky_ping(0)
        failures = worker_broker_wait.wait_for_broker(
            120, ping=ping, sleep=clock.sleep, monotonic=clock.monotonic
        )
        assert failures == 0
        assert ping.calls["n"] == 1
        assert clock.sleeps == []

    def test_refused_connections_are_retried_until_the_broker_answers(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        clock = _Clock()
        ping = _flaky_ping(2)
        with caplog.at_level("WARNING"):
            failures = worker_broker_wait.wait_for_broker(
                120, ping=ping, sleep=clock.sleep, monotonic=clock.monotonic
            )
        assert failures == 2
        assert ping.calls["n"] == 3
        assert len(clock.sleeps) == 2
        # The helm drill greps this prefix to report whether the wait engaged.
        assert "worker_broker_wait: broker not reachable yet" in caplog.text
        assert "reachable after 2 failed attempt(s)" in caplog.text

    def test_os_level_errors_are_retried_too(self) -> None:
        clock = _Clock()
        calls = {"n": 0}

        def ping() -> None:
            calls["n"] += 1
            if calls["n"] == 1:
                raise OSError("Name or service not known")

        assert (
            worker_broker_wait.wait_for_broker(
                120, ping=ping, sleep=clock.sleep, monotonic=clock.monotonic
            )
            == 1
        )

    def test_unreachable_broker_exits_the_process_once_the_budget_is_spent(self) -> None:
        clock = _Clock()
        ping = _flaky_ping(10_000)
        with pytest.raises(SystemExit) as excinfo:
            worker_broker_wait.wait_for_broker(
                10, ping=ping, sleep=clock.sleep, monotonic=clock.monotonic
            )
        assert excinfo.value.code == 1
        assert clock.now >= 10

    def test_unexpected_errors_are_not_swallowed(self) -> None:
        def ping() -> None:
            raise RuntimeError("misconfiguration, not an unreachable broker")

        with pytest.raises(RuntimeError):
            worker_broker_wait.wait_for_broker(120, ping=ping, sleep=lambda _s: None)


class TestWaitBudget:
    def test_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("TRUEPPM_CELERY_BROKER_WAIT_SECONDS", raising=False)
        assert worker_broker_wait.wait_budget_seconds() == 120

    def test_override(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("TRUEPPM_CELERY_BROKER_WAIT_SECONDS", "45")
        assert worker_broker_wait.wait_budget_seconds() == 45

    @pytest.mark.parametrize("raw", ["soon", "-5", "  "])
    def test_invalid_values_fall_back_to_the_default(
        self, monkeypatch: pytest.MonkeyPatch, raw: str
    ) -> None:
        monkeypatch.setenv("TRUEPPM_CELERY_BROKER_WAIT_SECONDS", raw)
        assert worker_broker_wait.wait_budget_seconds() == 120

    def test_zero_disables_the_wait(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("TRUEPPM_CELERY_BROKER_WAIT_SECONDS", "0")

        def fail(_budget: float) -> int:
            raise AssertionError("wait_for_broker must not run when the budget is 0")

        monkeypatch.setattr(worker_broker_wait, "wait_for_broker", fail)
        worker_broker_wait._on_worker_init()


class TestRealPing:
    def test_pings_the_celery_database_with_bounded_timeouts(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        seen: dict[str, Any] = {}

        class _FakeClient:
            def ping(self) -> bool:
                seen["pinged"] = True
                return True

        def fake_client(db: int, **kwargs: Any) -> _FakeClient:
            seen["db"] = db
            seen["kwargs"] = kwargs
            return _FakeClient()

        monkeypatch.setattr(valkey, "client", fake_client)
        worker_broker_wait._ping_broker()
        assert seen["db"] == valkey.DB_CELERY
        assert seen["pinged"] is True
        assert seen["kwargs"]["socket_connect_timeout"] > 0
        assert seen["kwargs"]["socket_timeout"] > 0


# sender=None makes celery's DjangoFixup skip its own worker_init work (and warn
# about it), which is what keeps this dispatch from touching Django state.
@pytest.mark.filterwarnings("ignore::celery.fixups.django.FixupWarning")
class TestSignalWiring:
    def test_handler_is_connected_to_worker_init(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Drive celery's real dispatch, as test_worker_heartbeat does.

        Importing ``trueppm_api.celery`` is what imports this module; the handler
        looks ``wait_for_broker`` up at call time, so patching it observes the call.
        """
        from celery.signals import worker_init

        import trueppm_api.celery  # noqa: F401

        monkeypatch.delenv("TRUEPPM_CELERY_BROKER_WAIT_SECONDS", raising=False)
        calls: list[float] = []

        def record(budget: float) -> int:
            calls.append(budget)
            return 0

        monkeypatch.setattr(worker_broker_wait, "wait_for_broker", record)
        worker_init.send(sender=None)
        assert calls == [120], "worker_init is not connected to the broker-wait handler"

    def test_system_exit_propagates_through_celery_signal_dispatch(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Pins the premise the exit path rests on: Signal.send catches Exception only."""
        from celery.signals import worker_init

        import trueppm_api.celery  # noqa: F401

        def exit_(_budget: float) -> int:
            raise SystemExit(1)

        monkeypatch.setattr(worker_broker_wait, "wait_for_broker", exit_)
        with pytest.raises(SystemExit):
            worker_init.send(sender=None)
