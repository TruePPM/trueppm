"""Tests for cross-process OTLP export-health recording (ADR-0601, #2109).

Covers the three units of :mod:`trueppm_api.apps.observability.otel.export_health`:

  - the recording wrappers — they propagate the wrapped exporter's result/exception
    unchanged and record the outcome as a non-fatal side effect (a recorder or
    Valkey failure can never alter or crash export);
  - the recorder — it publishes success/failure/counts into the (faked) store;
  - the reader — it aggregates live pods into the ``live`` block, computes each
    signal's ``state`` verdict server-side, and degrades to ``available: false`` on
    a store error or when the feature is switched off.

Redis is faked (no fakeredis dependency); the fake implements just the hash + ZSET
+ pipeline surface the module uses, matching the hand-rolled ``_FakeRedis`` idiom
used by the throttle tests.
"""

from __future__ import annotations

import pytest
from django.test import override_settings
from opentelemetry.sdk.trace.export import SpanExportResult

from trueppm_api.apps.observability.otel import export_health

# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


def _parse_score(value: object) -> tuple[float, bool]:
    """Parse a redis score bound into (value, exclusive)."""
    s = str(value)
    if s in ("+inf", "inf"):
        return float("inf"), False
    if s == "-inf":
        return float("-inf"), False
    if s.startswith("("):
        return float(s[1:]), True
    return float(s), False


class _FakeRedis:
    """Minimal in-memory redis supporting the hash + ZSET + pipeline ops we use."""

    def __init__(self) -> None:
        self.hashes: dict[str, dict[str, str]] = {}
        self.zsets: dict[str, dict[str, float]] = {}

    def hset(self, key: str, mapping: dict[str, object]) -> None:
        self.hashes.setdefault(key, {}).update({k: str(v) for k, v in mapping.items()})

    def hgetall(self, key: str) -> dict[str, str]:
        return dict(self.hashes.get(key, {}))

    def expire(self, key: str, ttl: int) -> None:
        return None

    def zadd(self, key: str, mapping: dict[str, float]) -> None:
        self.zsets.setdefault(key, {}).update(mapping)

    def zrangebyscore(self, key: str, lo: object, hi: object) -> list[str]:
        z = self.zsets.get(key, {})
        lov, loex = _parse_score(lo)
        hiv, hiex = _parse_score(hi)
        members = [
            m
            for m, s in z.items()
            if (s > lov if loex else s >= lov) and (s < hiv if hiex else s <= hiv)
        ]
        return sorted(members, key=lambda m: z[m])

    def zremrangebyscore(self, key: str, lo: object, hi: object) -> int:
        z = self.zsets.get(key, {})
        lov, loex = _parse_score(lo)
        hiv, hiex = _parse_score(hi)
        gone = [
            m
            for m, s in z.items()
            if (s > lov if loex else s >= lov) and (s < hiv if hiex else s <= hiv)
        ]
        for m in gone:
            del z[m]
        return len(gone)

    def pipeline(self) -> _FakePipe:
        return _FakePipe(self)


class _FakePipe:
    def __init__(self, client: _FakeRedis) -> None:
        self._client = client
        self._cmds: list[tuple[str, tuple, dict]] = []

    def hset(self, *a: object, **k: object) -> _FakePipe:
        self._cmds.append(("hset", a, k))
        return self

    def expire(self, *a: object, **k: object) -> _FakePipe:
        self._cmds.append(("expire", a, k))
        return self

    def zadd(self, *a: object, **k: object) -> _FakePipe:
        self._cmds.append(("zadd", a, k))
        return self

    def hgetall(self, *a: object, **k: object) -> _FakePipe:
        self._cmds.append(("hgetall", a, k))
        return self

    def execute(self) -> list[object]:
        return [getattr(self._client, name)(*a, **k) for name, a, k in self._cmds]


class _FakeSpanExporter:
    """Stands in for the wrapped OTLP span exporter."""

    def __init__(self, result: SpanExportResult = SpanExportResult.SUCCESS, raises: bool = False):
        self._result = result
        self._raises = raises
        self.flushed = False
        self.shut = False

    def export(self, spans: object) -> SpanExportResult:
        if self._raises:
            raise RuntimeError("boom")
        return self._result

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        self.flushed = True
        return True

    def shutdown(self) -> None:
        self.shut = True


class _RecordingSpy:
    """Captures recorder calls; can be made to raise to prove non-fatality."""

    def __init__(self, raises: bool = False) -> None:
        self.successes: list[int] = []
        self.failures: list[str] = []
        self._raises = raises

    def record_success(self, item_count: int) -> None:
        if self._raises:
            raise RuntimeError("recorder blew up")
        self.successes.append(item_count)

    def record_failure(self, error: str) -> None:
        if self._raises:
            raise RuntimeError("recorder blew up")
        self.failures.append(error)


# ---------------------------------------------------------------------------
# Wrappers
# ---------------------------------------------------------------------------


class TestRecordingSpanExporter:
    def test_success_records_count_and_returns_result(self) -> None:
        spy = _RecordingSpy()
        wrapper = export_health.RecordingSpanExporter(_FakeSpanExporter(), spy)  # type: ignore[arg-type]
        result = wrapper.export([object(), object(), object()])
        assert result == SpanExportResult.SUCCESS
        assert spy.successes == [3]
        assert spy.failures == []

    def test_failure_result_records_failure_and_propagates(self) -> None:
        spy = _RecordingSpy()
        wrapper = export_health.RecordingSpanExporter(
            _FakeSpanExporter(result=SpanExportResult.FAILURE),  # type: ignore[arg-type]
            spy,
        )
        result = wrapper.export([object()])
        assert result == SpanExportResult.FAILURE
        assert spy.successes == []
        assert spy.failures  # a failure was recorded

    def test_wrapped_exception_is_recorded_and_reraised(self) -> None:
        spy = _RecordingSpy()
        wrapper = export_health.RecordingSpanExporter(
            _FakeSpanExporter(raises=True),  # type: ignore[arg-type]
            spy,
        )
        with pytest.raises(RuntimeError, match="boom"):
            wrapper.export([object()])
        assert any("RuntimeError" in f for f in spy.failures)

    def test_recorder_failure_never_breaks_export(self) -> None:
        # A recorder that raises must NOT alter or crash the export result.
        spy = _RecordingSpy(raises=True)
        wrapper = export_health.RecordingSpanExporter(_FakeSpanExporter(), spy)  # type: ignore[arg-type]
        assert wrapper.export([object()]) == SpanExportResult.SUCCESS

    def test_flush_and_shutdown_delegate(self) -> None:
        inner = _FakeSpanExporter()
        wrapper = export_health.RecordingSpanExporter(inner, _RecordingSpy())  # type: ignore[arg-type]
        assert wrapper.force_flush(1000) is True
        wrapper.shutdown()
        assert inner.flushed and inner.shut


class TestCountDataPoints:
    def test_counts_across_the_metrics_hierarchy(self) -> None:
        class _DP:  # a data point
            pass

        class _Data:
            def __init__(self, n: int) -> None:
                self.data_points = [_DP() for _ in range(n)]

        class _Metric:
            def __init__(self, n: int) -> None:
                self.data = _Data(n)

        class _Scope:
            def __init__(self, counts: list[int]) -> None:
                self.metrics = [_Metric(n) for n in counts]

        class _Resource:
            def __init__(self, scopes: list[list[int]]) -> None:
                self.scope_metrics = [_Scope(c) for c in scopes]

        class _MetricsData:
            def __init__(self) -> None:
                self.resource_metrics = [_Resource([[2, 3]]), _Resource([[5]])]

        assert export_health._count_data_points(_MetricsData()) == 10  # type: ignore[arg-type]

    def test_malformed_batch_counts_zero_not_raises(self) -> None:
        class _Bad:
            @property
            def resource_metrics(self) -> object:
                raise ValueError("nope")

        assert export_health._count_data_points(_Bad()) == 0  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Recorder
# ---------------------------------------------------------------------------


class TestExportHealthRecorder:
    @override_settings(OTEL_SERVICE_NAME="trueppm-api", TRUEPPM_POD_NAME="pod-a")
    def test_success_writes_hash_and_index(self, monkeypatch: pytest.MonkeyPatch) -> None:
        fake = _FakeRedis()
        monkeypatch.setattr(export_health, "_client", lambda: fake)
        rec = export_health.ExportHealthRecorder("traces", "trueppm-api")
        rec.record_success(7)

        pod_key = "otel:exphealth:pod:traces:pod-a"
        assert fake.hashes[pod_key]["items_60s"] == "7"
        assert fake.hashes[pod_key]["exporting"] == "1"
        assert "last_success_at" in fake.hashes[pod_key]
        # the pod is registered in the live index for its signal
        assert "pod-a" in fake.zsets["otel:exphealth:idx:traces"]

    @override_settings(OTEL_SERVICE_NAME="trueppm-api", TRUEPPM_POD_NAME="pod-a")
    def test_failure_records_error_without_clearing_success(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake = _FakeRedis()
        monkeypatch.setattr(export_health, "_client", lambda: fake)
        rec = export_health.ExportHealthRecorder("metrics", "trueppm-api")
        rec.record_success(3)
        rec.record_failure("connection refused")

        pod_key = "otel:exphealth:pod:metrics:pod-a"
        assert fake.hashes[pod_key]["last_error"] == "connection refused"
        # last_success_at survives a later failure (reader compares the two).
        assert "last_success_at" in fake.hashes[pod_key]

    @override_settings(OTEL_SERVICE_NAME="trueppm-api", TRUEPPM_POD_NAME="pod-a")
    def test_store_error_is_swallowed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def _boom() -> object:
            raise export_health.redis.ConnectionError("down")

        monkeypatch.setattr(export_health, "_client", _boom)
        rec = export_health.ExportHealthRecorder("traces", "trueppm-api")
        # Must not raise — recording is best-effort.
        rec.record_success(1)
        rec.record_failure("x")


# ---------------------------------------------------------------------------
# Reader
# ---------------------------------------------------------------------------


class TestReadExportHealth:
    def _seed(
        self, fake: _FakeRedis, signal: str, pod: str, *, score: float, **fields: object
    ) -> None:
        fake.hashes[f"otel:exphealth:pod:{signal}:{pod}"] = {k: str(v) for k, v in fields.items()}
        fake.zsets.setdefault(f"otel:exphealth:idx:{signal}", {})[pod] = score

    def test_disabled_signal_is_disabled_state(self, monkeypatch: pytest.MonkeyPatch) -> None:
        fake = _FakeRedis()
        monkeypatch.setattr(export_health, "_client", lambda: fake)
        live = export_health.read_export_health(
            traces_enabled=False, metrics_enabled=False, now_epoch=1000.0
        )
        assert live["available"] is True
        assert live["traces"]["state"] == "disabled"
        assert live["metrics"]["state"] == "disabled"

    def test_never_when_enabled_but_no_records(self, monkeypatch: pytest.MonkeyPatch) -> None:
        fake = _FakeRedis()
        monkeypatch.setattr(export_health, "_client", lambda: fake)
        live = export_health.read_export_health(
            traces_enabled=True, metrics_enabled=True, now_epoch=1000.0
        )
        assert live["traces"]["state"] == "never"
        assert live["metrics"]["state"] == "never"
        assert live["pods_reporting"] == 0

    def test_aggregates_counts_and_latest_success_across_pods(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake = _FakeRedis()
        monkeypatch.setattr(export_health, "_client", lambda: fake)
        now = 1000.0
        self._seed(fake, "traces", "pod-a", score=now - 5, last_success_at=now - 5, items_60s=1000)
        self._seed(fake, "traces", "pod-b", score=now - 2, last_success_at=now - 2, items_60s=204)
        live = export_health.read_export_health(
            traces_enabled=True, metrics_enabled=True, now_epoch=now
        )
        traces = live["traces"]
        assert traces["state"] == "healthy"
        assert traces["items_per_window"] == 1204
        assert traces["pods_reporting"] == 2
        # Age reflects the freshest pod (2s), computed server-side.
        assert traces["last_success_age_seconds"] == 2
        assert live["pods_reporting"] == 2  # distinct across both signals

    def test_failing_when_latest_outcome_is_error(self, monkeypatch: pytest.MonkeyPatch) -> None:
        fake = _FakeRedis()
        monkeypatch.setattr(export_health, "_client", lambda: fake)
        now = 1000.0
        self._seed(
            fake,
            "metrics",
            "pod-a",
            score=now - 1,
            last_success_at=now - 120,
            last_error_at=now - 1,
            last_error="connection refused",
            items_60s=0,
        )
        live = export_health.read_export_health(
            traces_enabled=True, metrics_enabled=True, now_epoch=now
        )
        assert live["metrics"]["state"] == "failing"
        assert live["metrics"]["last_error"] == "connection refused"

    def test_metrics_stalled_but_traces_idle_when_old_success_no_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake = _FakeRedis()
        monkeypatch.setattr(export_health, "_client", lambda: fake)
        now = 1000.0
        # Last success beyond the healthy window but still a LIVE record (within the
        # staleness TTL, refreshed by that last export). Metrics export on a fixed
        # cadence, so an overdue success is authoritative → stalled; traces are
        # volume-driven, so a quiet system is neutral → idle (never a red alarm).
        old = now - export_health.HEALTHY_WITHIN_SECONDS - 60
        assert now - old < export_health.STALENESS_SECONDS  # still live, not expired
        self._seed(fake, "metrics", "pod-a", score=old, last_success_at=old, items_60s=0)
        self._seed(fake, "traces", "pod-a", score=old, last_success_at=old, items_60s=0)
        live = export_health.read_export_health(
            traces_enabled=True, metrics_enabled=True, now_epoch=now
        )
        assert live["metrics"]["state"] == "stalled"
        assert live["traces"]["state"] == "idle"

    def test_stale_pods_excluded_from_aggregate(self, monkeypatch: pytest.MonkeyPatch) -> None:
        fake = _FakeRedis()
        monkeypatch.setattr(export_health, "_client", lambda: fake)
        now = 1000.0
        # A pod whose last update is older than the staleness window is trimmed and
        # does not contribute — a dead pod stops inflating the cluster figure.
        stale = now - export_health.STALENESS_SECONDS - 10
        self._seed(fake, "traces", "dead", score=stale, last_success_at=stale, items_60s=999)
        self._seed(fake, "traces", "live", score=now - 3, last_success_at=now - 3, items_60s=5)
        live = export_health.read_export_health(
            traces_enabled=True, metrics_enabled=True, now_epoch=now
        )
        assert live["traces"]["items_per_window"] == 5
        assert live["traces"]["pods_reporting"] == 1

    def test_redis_error_degrades_to_unavailable(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def _boom() -> object:
            raise export_health.redis.ConnectionError("down")

        monkeypatch.setattr(export_health, "_client", _boom)
        live = export_health.read_export_health(
            traces_enabled=True, metrics_enabled=True, now_epoch=1000.0
        )
        assert live == {"available": False}

    @override_settings(TRUEPPM_OTEL_EXPORT_HEALTH_ENABLED=False)
    def test_feature_flag_off_is_unavailable(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Must not even touch redis when the recorder is switched off.
        def _boom() -> object:
            raise AssertionError("_client should not be called when the feature is off")

        monkeypatch.setattr(export_health, "_client", _boom)
        live = export_health.read_export_health(
            traces_enabled=True, metrics_enabled=True, now_epoch=1000.0
        )
        assert live == {"available": False}
