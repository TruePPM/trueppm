"""Unit tests for the capacity harness's token-refresh and reporting logic (#3828).

`packages/api/perf/capacity/run_capacity.py` produced a fabricated "16,000-task
ceiling": the harness cached its JWT for the life of the process with no refresh,
`ACCESS_TOKEN_LIFETIME` is 15 minutes, and the `tasks` sweep ran 17m51s — so its
final step measured a wall of 401s at auth-rejection speed (~4.8 ms), not database
latency. The host-noise control of the time (`/api/v1/health/`) is unauthenticated
and could not see the 401s either.

This module has no live stack: it is not a fixture module for the harness, it is
the harness *script* itself, imported by file path (it lives under `perf/`, not
`src/`, so it is not an installed part of `trueppm_api` — same idiom as
`tests/apps/observability/test_helm_metric_name_sync.py`). The three things tested
here are pure and do not touch the network or a database:

* the time-aware token cache refreshes after `TOKEN_REFRESH_AFTER` and not before;
* a step's `status_histogram` is built correctly from its samples, so a wall of
  401s is now distinguishable from a wall of 500s or timeouts;
* the host-noise control now samples an authenticated, constant-cost endpoint
  (`CONTROL_PATH`) instead of the unauthenticated `/api/v1/health/`.

Deliberately does NOT bring up `docker-compose.capacity.yml` or perform a real
HTTP call — `requests.post` is monkeypatched in every test that exercises
`Client`/`_login`.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
MODULE_PATH = REPO_ROOT / "packages" / "api" / "perf" / "capacity" / "run_capacity.py"


def _load_module() -> ModuleType:
    """Import the harness script by path — it is a script, not an installed module."""
    spec = importlib.util.spec_from_file_location("run_capacity", MODULE_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def capacity() -> ModuleType:
    if not MODULE_PATH.is_file():
        pytest.fail(f"{MODULE_PATH} is missing — the #3828 harness tests have no target")
    return _load_module()


@pytest.fixture(autouse=True)
def _clear_token_cache(capacity: ModuleType) -> None:
    """The module-level `_TOKEN_CACHE` persists across tests in this session; reset it."""
    capacity._TOKEN_CACHE.clear()


class _FakeResponse:
    """Stand-in for `requests.Response` — no network, no `pytest-socket` trip."""

    def __init__(self, status_code: int, payload: dict[str, Any] | None = None) -> None:
        self.status_code = status_code
        self._payload = payload or {}

    def json(self) -> dict[str, Any]:
        return self._payload

    def raise_for_status(self) -> None:
        raise RuntimeError(f"HTTP {self.status_code}")


# ──────────────────────────────────────────────────────────────────────────
# Token refresh
# ──────────────────────────────────────────────────────────────────────────


def test_token_is_fresh_within_margin(capacity: ModuleType) -> None:
    cached = capacity._CachedToken(token="tok", minted_at=0.0)
    margin = capacity.TOKEN_REFRESH_AFTER.total_seconds()
    assert capacity._token_is_fresh(cached, now=margin - 1) is True


def test_token_is_stale_past_margin(capacity: ModuleType) -> None:
    cached = capacity._CachedToken(token="tok", minted_at=0.0)
    margin = capacity.TOKEN_REFRESH_AFTER.total_seconds()
    assert capacity._token_is_fresh(cached, now=margin + 1) is False


def test_login_reuses_cached_token_within_margin(
    capacity: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A second `_login()` inside the refresh margin must not re-authenticate.

    This is the throttle-safety property the original (pre-#3828) code had —
    the fix must not regress it back into re-authenticating per request.
    """
    monkeypatch.setattr(capacity, "owner_password", lambda: "throwaway")
    clock = {"t": 0.0}
    monkeypatch.setattr(capacity.time, "monotonic", lambda: clock["t"])

    calls = 0

    def fake_post(url: str, json: dict[str, Any], timeout: int) -> _FakeResponse:
        nonlocal calls
        calls += 1
        return _FakeResponse(200, {"access": f"token-{calls}"})

    monkeypatch.setattr(capacity.requests, "post", fake_post)

    client = capacity.Client()
    assert client.token == "token-1"
    assert calls == 1

    # Still inside the refresh margin.
    clock["t"] = capacity.TOKEN_REFRESH_AFTER.total_seconds() - 1
    client.ensure_fresh_token()
    assert client.token == "token-1"
    assert calls == 1


def test_ensure_fresh_token_remints_past_margin(
    capacity: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    """This is the #3828 fix itself: a token older than the margin gets replaced.

    Simulates a sweep step that starts after the cached token has aged past
    `TOKEN_REFRESH_AFTER` (e.g. a long-running earlier step) — exactly the
    condition the 16,000-task step hit at minute 17 against a 15-minute
    lifetime with no refresh at all.
    """
    monkeypatch.setattr(capacity, "owner_password", lambda: "throwaway")
    clock = {"t": 0.0}
    monkeypatch.setattr(capacity.time, "monotonic", lambda: clock["t"])

    calls = 0

    def fake_post(url: str, json: dict[str, Any], timeout: int) -> _FakeResponse:
        nonlocal calls
        calls += 1
        return _FakeResponse(200, {"access": f"token-{calls}"})

    monkeypatch.setattr(capacity.requests, "post", fake_post)

    client = capacity.Client()
    assert client.token == "token-1"

    clock["t"] = capacity.TOKEN_REFRESH_AFTER.total_seconds() + 1
    client.ensure_fresh_token()
    assert client.token == "token-2"
    assert calls == 2


def test_login_backs_off_through_throttle_then_succeeds(
    capacity: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The pre-existing 429 backoff must survive the refresh-margin change."""
    monkeypatch.setattr(capacity, "owner_password", lambda: "throwaway")
    monkeypatch.setattr(capacity.time, "monotonic", lambda: 0.0)
    monkeypatch.setattr(capacity.time, "sleep", lambda _seconds: None)

    responses = [_FakeResponse(429), _FakeResponse(200, {"access": "token-after-throttle"})]

    def fake_post(url: str, json: dict[str, Any], timeout: int) -> _FakeResponse:
        return responses.pop(0)

    monkeypatch.setattr(capacity.requests, "post", fake_post)

    client = capacity.Client()
    assert client.token == "token-after-throttle"


def test_password_never_lands_in_cached_token_or_results(capacity: ModuleType) -> None:
    """The token cache stores the bearer token only — never the password."""
    cached = capacity._CachedToken(token="tok", minted_at=0.0)
    assert "throwaway" not in vars(cached).values()
    assert set(vars(cached)) == {"token", "minted_at"}


# ──────────────────────────────────────────────────────────────────────────
# Status-code histogram
# ──────────────────────────────────────────────────────────────────────────


def test_status_histogram_distinguishes_error_classes(capacity: ModuleType) -> None:
    """A wall of 401s must be distinguishable from a wall of 500s in the results.

    This is the exact blind spot #3828 exploited: `error_rate=0.9667` alone was
    consistent with a database problem, a 500-storm, or (the actual cause) an
    expired token — the histogram is what makes the distinction visible in the
    committed JSON without re-running anything.
    """
    Sample = capacity.Sample
    samples = [Sample(ms=4.8, status=401, ok=False) for _ in range(29)] + [
        Sample(ms=5.1, status=200, ok=True)
    ]
    result = capacity.summarize(16000, "16000 tasks — first page", samples)
    assert result.status_histogram == {"401": 29, "200": 1}
    # error_rate is rounded to 4 places by summarize(), same as production.
    assert result.error_rate == round(29 / 30, 4)


def test_status_histogram_all_success(capacity: ModuleType) -> None:
    Sample = capacity.Sample
    samples = [Sample(ms=10.0, status=200, ok=True) for _ in range(5)]
    result = capacity.summarize(500, "500 tasks", samples)
    assert result.status_histogram == {"200": 5}


def test_status_histogram_empty_samples(capacity: ModuleType) -> None:
    result = capacity.summarize(500, "500 tasks", [])
    assert result.status_histogram == {}


# ──────────────────────────────────────────────────────────────────────────
# Authenticated control probe
# ──────────────────────────────────────────────────────────────────────────


def test_control_sample_uses_authenticated_constant_cost_endpoint(
    capacity: ModuleType,
) -> None:
    """The control must hit `CONTROL_PATH`, not the unauthenticated health probe.

    `/api/v1/health/` cannot see a 401 — it needs no token — which is why the
    #3828 sweep's control sample stayed green (6.7 ms) throughout a step that
    was 96.67% auth failures. The control must now be able to see that class of
    failure.
    """
    calls: list[str] = []

    class _FakeClient:
        def timed(self, path: str) -> capacity.Sample:  # type: ignore[name-defined]
            calls.append(path)
            return capacity.Sample(ms=1.0, status=200, ok=True)

    capacity.control_sample(_FakeClient(), n=3)

    assert calls == [capacity.CONTROL_PATH] * 3
    assert capacity.CONTROL_PATH != "/api/v1/health/"
    assert "auth" in capacity.CONTROL_PATH


# ──────────────────────────────────────────────────────────────────────────
# Instrument-fault abort
# ──────────────────────────────────────────────────────────────────────────


def _samples(capacity: ModuleType, statuses: list[int]) -> list[Any]:
    return [capacity.Sample(ms=5.0, status=s, ok=s < 400) for s in statuses]


def test_all_auth_failures_abort_as_instrument_fault(capacity: ModuleType) -> None:
    samples = _samples(capacity, [200] * 3 + [401] * 27)
    with pytest.raises(capacity.InstrumentFault, match="auth rejection"):
        capacity.assert_no_auth_fault("16000 tasks", samples, source="measured")


def test_mixed_401_and_403_still_abort(capacity: ModuleType) -> None:
    samples = _samples(capacity, [401, 403, 200])
    with pytest.raises(capacity.InstrumentFault):
        capacity.assert_no_auth_fault("step", samples, source="measured")


def test_server_errors_are_a_capacity_result_not_a_fault(capacity: ModuleType) -> None:
    capacity.assert_no_auth_fault("step", _samples(capacity, [200, 500, 500]), source="measured")
    # A timeout is status 0 and is also the API's problem.
    capacity.assert_no_auth_fault("step", _samples(capacity, [0, 0, 200]), source="measured")


def test_a_401_mixed_with_a_5xx_is_not_all_auth(capacity: ModuleType) -> None:
    capacity.assert_no_auth_fault("step", _samples(capacity, [401, 500, 200]), source="measured")


def test_clean_samples_and_empty_samples_do_not_abort(capacity: ModuleType) -> None:
    capacity.assert_no_auth_fault("step", _samples(capacity, [200] * 5), source="measured")
    capacity.assert_no_auth_fault("step", [], source="measured")


def test_measure_step_raises_before_recording_a_ceiling(
    capacity: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An all-401 step must raise out of `measure_step`, so no caller can set a ceiling."""

    class _Client:
        def ensure_fresh_token(self) -> None:
            return None

        def timed(self, path: str) -> Any:
            return capacity.Sample(ms=4.8, status=200, ok=True)

    monkeypatch.setattr(capacity.time, "sleep", lambda _s: None)
    with pytest.raises(capacity.InstrumentFault):
        capacity.measure_step(
            _Client(),
            step=16000,
            label="16000 tasks",
            take=lambda: _samples(capacity, [401] * 30),
        )


def test_measure_step_raises_when_the_control_is_rejected(
    capacity: ModuleType,
) -> None:
    class _Client:
        def ensure_fresh_token(self) -> None:
            return None

        def timed(self, path: str) -> Any:
            return capacity.Sample(ms=4.8, status=401, ok=False)

    with pytest.raises(capacity.InstrumentFault, match="control"):
        capacity.measure_step(
            _Client(), step=500, label="500 tasks", take=lambda: _samples(capacity, [200] * 5)
        )


def test_measure_step_keeps_status_histogram_and_p50(
    capacity: ModuleType,
) -> None:
    class _Client:
        def ensure_fresh_token(self) -> None:
            return None

        def timed(self, path: str) -> Any:
            return capacity.Sample(ms=1.0, status=200, ok=True)

    result = capacity.measure_step(
        _Client(),
        step=500,
        label="500 tasks",
        take=lambda: _samples(capacity, [200] * 9 + [500]),
    )
    assert result.status_histogram == {"200": 9, "500": 1}
    assert result.p50_ms == 5.0


# ──────────────────────────────────────────────────────────────────────────
# Host metadata and ANALYZE
# ──────────────────────────────────────────────────────────────────────────


def test_parse_meminfo_reads_mem_and_swap(capacity: ModuleType) -> None:
    text = "MemTotal:        8146132 kB\nMemFree:         100 kB\nSwapTotal:       1048576 kB\n"
    assert capacity.parse_meminfo(text) == {"mem_total_mib": 7955, "swap_total_mib": 1024}


def test_parse_meminfo_tolerates_garbage(capacity: ModuleType) -> None:
    assert capacity.parse_meminfo("nonsense\nMemTotal: lots kB\n") == {}


def test_host_metadata_degrades_to_none_without_tools(
    capacity: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(capacity, "_run_text", lambda _cmd: None)
    host = capacity.collect_host_metadata()
    assert host["chip_model"] is None
    assert host["docker"] == {"cpus": None, "mem_total_mib": None, "swap_total_mib": None}
    assert host["cpu_count"]


def test_seed_runs_analyze_after_seeding(
    capacity: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    commands: list[list[str]] = []
    monkeypatch.setattr(capacity.subprocess, "run", lambda cmd, **_kw: commands.append(cmd))
    capacity.seed(projects=1, tasks=10)
    assert "seed_capacity" in commands[0]
    assert commands[1][-2:] == ["-c", "ANALYZE"]


# ──────────────────────────────────────────────────────────────────────────
# dimension_full_load wiring
# ──────────────────────────────────────────────────────────────────────────


class _FullLoadHarness:
    """Drive `dimension_full_load` for one size with every network/docker edge stubbed.

    Records how many page requests happened before `measure_step` was entered
    (the warm-up) and how many `take()` issued (the samples), plus the samples.
    """

    def __init__(self, capacity: ModuleType, monkeypatch: pytest.MonkeyPatch, status: int) -> None:
        self.requests_made = 0
        self.refreshes = 0
        self.warmup_requests = -1
        self.sample_requests = -1
        self.samples: list[Any] = []

        harness = self

        class _Response:
            status_code = status

            def json(self) -> dict[str, Any]:
                return {"next": None}

        def fake_get(url: str, headers: dict[str, str], timeout: int) -> _Response:
            harness.requests_made += 1
            return _Response()

        class _Client:
            headers = None

            def ensure_fresh_token(self) -> None:
                harness.refreshes += 1

            def first_project_id(self) -> str:
                return "pid"

        def fake_measure_step(client: Any, *, step: Any, label: str, take: Any, **_kw: Any) -> Any:
            harness.warmup_requests = harness.requests_made
            harness.samples = take()
            harness.sample_requests = harness.requests_made - harness.warmup_requests
            return capacity.summarize(step, label, harness.samples)

        monkeypatch.setattr(capacity, "seed", lambda **_kw: None)
        monkeypatch.setattr(capacity, "Client", _Client)
        monkeypatch.setattr(capacity.requests, "get", fake_get)
        monkeypatch.setattr(capacity, "measure_step", fake_measure_step)
        monkeypatch.setattr(capacity, "report", lambda _step: None)
        self.capacity = capacity

    def run(self) -> Any:
        return self.capacity.dimension_full_load([100])


def test_full_load_warms_up_then_takes_the_configured_samples(
    capacity: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    h = _FullLoadHarness(capacity, monkeypatch, status=200)
    h.run()
    # Literal floors, not just the constants: lowering either constant back to
    # the pre-fix values (no warm-up, 7 samples) must fail here.
    assert h.warmup_requests == capacity.WARMUP_REQUESTS >= 5
    assert h.sample_requests == capacity.FULL_LOAD_SAMPLES >= 21


def test_full_load_reports_the_real_failing_status(
    capacity: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A 401 on a page must surface as status 401, not a hardcoded 200.

    Auth-fault detection and the status histogram both read `Sample.status`, so
    a hardcoded 200 would make an expired token look like a plain error rate.
    """
    h = _FullLoadHarness(capacity, monkeypatch, status=401)
    result = h.run()
    assert {s.status for s in h.samples} == {401}
    assert all(not s.ok for s in h.samples)
    assert result.steps[0].status_histogram == {"401": capacity.FULL_LOAD_SAMPLES}
    with pytest.raises(capacity.InstrumentFault):
        capacity.assert_no_auth_fault("100 tasks", h.samples, source="measured")


def test_full_load_sample_count_keeps_p95_off_the_maximum(capacity: ModuleType) -> None:
    """The stated reason for the sample count: p95 must not be the slowest sample."""
    n = capacity.FULL_LOAD_SAMPLES
    samples = [capacity.Sample(ms=float(i), status=200, ok=True) for i in range(1, n + 1)]
    assert capacity.p95_of(samples) < max(s.ms for s in samples)
    assert capacity.summarize(1, "x", samples).p95_ms < capacity.summarize(1, "x", samples).max_ms


def test_full_load_refreshes_the_token_before_every_walk(
    capacity: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    h = _FullLoadHarness(capacity, monkeypatch, status=200)
    h.run()
    assert h.refreshes == capacity.WARMUP_REQUESTS + capacity.FULL_LOAD_SAMPLES


def test_full_load_timeout_is_status_zero_not_a_crash(
    capacity: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    h = _FullLoadHarness(capacity, monkeypatch, status=200)

    def boom(*_a: Any, **_kw: Any) -> None:
        raise capacity.requests.ConnectionError("timed out")

    monkeypatch.setattr(capacity.requests, "get", boom)
    h.run()
    assert {s.status for s in h.samples} == {0}
    assert all(not s.ok for s in h.samples)


def test_measure_step_refreshes_the_token_on_every_attempt(
    capacity: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    refreshes: list[int] = []

    class _Client:
        def ensure_fresh_token(self) -> None:
            refreshes.append(1)

        def timed(self, path: str) -> Any:
            # Over the control gate, so every attempt is judged contaminated.
            return capacity.Sample(ms=capacity.CONTROL_P95_GATE_MS + 50, status=200, ok=True)

    monkeypatch.setattr(capacity.time, "sleep", lambda _s: None)
    monkeypatch.setattr(capacity.os, "getloadavg", lambda: (0.0, 0.0, 0.0))
    result = capacity.measure_step(
        _Client(), step=1, label="s", take=lambda: _samples(capacity, [200] * 3)
    )
    assert result.contaminated
    assert len(refreshes) == capacity.MAX_STEP_ATTEMPTS


# ── preflight, main(), report ─────────────────────────────────────────────


def _set_secrets(monkeypatch: pytest.MonkeyPatch, **overrides: str | None) -> None:
    values: dict[str, str | None] = {
        "TRUEPPM_CAPACITY_PASSWORD": "pw",
        "CAPACITY_INTEGRATION_KEY": "key",
        "CAPACITY_DB_PASSWORD": "x" * 24,
    }
    values.update(overrides)
    for name, value in values.items():
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)


def test_preflight_passes_with_all_three_secrets(
    capacity: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_secrets(monkeypatch)
    capacity.preflight_secrets()


@pytest.mark.parametrize(
    ("override", "needle"),
    [
        ({"CAPACITY_DB_PASSWORD": None}, "CAPACITY_DB_PASSWORD"),
        ({"CAPACITY_DB_PASSWORD": "short"}, "at least 12"),
        ({"CAPACITY_INTEGRATION_KEY": None}, "CAPACITY_INTEGRATION_KEY"),
        ({"TRUEPPM_CAPACITY_PASSWORD": None}, "TRUEPPM_CAPACITY_PASSWORD"),
    ],
)
def test_preflight_names_each_missing_secret(
    capacity: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    override: dict[str, str | None],
    needle: str,
) -> None:
    _set_secrets(monkeypatch, **override)
    with pytest.raises(SystemExit) as exc:
        capacity.preflight_secrets()
    assert needle in str(exc.value)


def test_main_exits_2_and_writes_nothing_on_instrument_fault(
    capacity: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _set_secrets(monkeypatch)

    def faulty() -> Any:
        raise capacity.InstrumentFault("all 401")

    monkeypatch.setattr(capacity, "DIMENSIONS", {"tasks": faulty})
    monkeypatch.setattr(
        sys, "argv", ["run_capacity.py", "--dimension", "tasks", "--out", str(tmp_path)]
    )
    assert capacity.main() == 2
    assert list(tmp_path.iterdir()) == []


def test_main_writes_host_metadata_into_the_payload(
    capacity: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import json

    _set_secrets(monkeypatch)
    monkeypatch.setattr(
        capacity, "DIMENSIONS", {"tasks": lambda: capacity.DimensionResult("d", "desc")}
    )
    monkeypatch.setattr(
        capacity, "collect_host_metadata", lambda: {"chip_model": "Test Chip", "docker": {}}
    )
    monkeypatch.setattr(
        sys, "argv", ["run_capacity.py", "--dimension", "tasks", "--out", str(tmp_path)]
    )
    assert capacity.main() == 0
    payload = json.loads((tmp_path / "capacity-tasks.json").read_text())
    assert payload["host"]["chip_model"] == "Test Chip"


def test_collect_host_metadata_parses_chip_cores_and_meminfo(
    capacity: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(capacity.sys, "platform", "darwin")
    answers = {
        "machdep.cpu.brand_string": "Apple M5 Pro",
        "hw.perflevel0.logicalcpu": "6",
        "hw.perflevel1.logicalcpu": "12",
        "{{.NCPU}}": "8",
    }

    def fake(cmd: list[str]) -> str | None:
        if cmd[-1] == "/proc/meminfo":
            return "MemTotal: 8388608 kB\nSwapTotal: 1048576 kB\n"
        return answers.get(cmd[-1]) or answers.get(cmd[2] if len(cmd) > 2 else "")

    monkeypatch.setattr(capacity, "_run_text", fake)
    host = capacity.collect_host_metadata()
    assert host["chip_model"] == "Apple M5 Pro"
    assert (host["performance_cores"], host["efficiency_cores"]) == (6, 12)
    assert host["docker"] == {"cpus": 8, "mem_total_mib": 8192, "swap_total_mib": 1024}


def test_report_prints_p50_beside_p95(
    capacity: ModuleType, capsys: pytest.CaptureFixture[str]
) -> None:
    step = capacity.summarize(1, "s", _samples(capacity, [200, 200, 200]))
    capacity.report(step)
    out = capsys.readouterr().out
    assert "p50=5.0ms" in out
    assert "p95=" in out


def test_main_preflights_all_secrets_before_any_stack_work(
    capacity: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_secrets(monkeypatch, CAPACITY_DB_PASSWORD=None)
    monkeypatch.setattr(capacity, "DIMENSIONS", {"tasks": lambda: pytest.fail("ran a dimension")})
    monkeypatch.setattr(sys, "argv", ["run_capacity.py", "--dimension", "tasks"])
    with pytest.raises(SystemExit, match="CAPACITY_DB_PASSWORD"):
        capacity.main()


def test_full_load_token_refresh_failure_is_a_failed_sample_not_a_crash(
    capacity: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    h = _FullLoadHarness(capacity, monkeypatch, status=200)

    def hung(self: Any) -> None:
        raise capacity.requests.ConnectTimeout("token endpoint hung")

    monkeypatch.setattr(capacity.Client, "ensure_fresh_token", hung, raising=False)
    h.run()
    assert {s.status for s in h.samples} == {0}
    assert all(s.ms == 0.0 and not s.ok for s in h.samples)
    assert h.requests_made == 0


def test_measure_step_token_refresh_failure_is_a_contaminated_attempt(
    capacity: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    class _Client:
        def ensure_fresh_token(self) -> None:
            raise capacity.requests.ConnectionError("down")

        def timed(self, path: str) -> Any:
            raise AssertionError("must not measure with no token")

    monkeypatch.setattr(capacity.time, "sleep", lambda _s: None)
    result = capacity.measure_step(
        _Client(), step=1, label="s", take=lambda: pytest.fail("took samples")
    )
    assert result.contaminated
    assert "token refresh failed" in result.notes
    assert result.status_histogram == {"0": 1}
