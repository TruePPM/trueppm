"""Post-recompute invariant self-check (#4689): checks, budget, counters, call site."""

from __future__ import annotations

import dataclasses
from datetime import date, timedelta
from typing import Any
from unittest import mock

import pytest
from trueppm_scheduler import Dependency, Project, Task, schedule

from trueppm_api.apps.scheduling import selfcheck

D = timedelta(days=1)


def _project(*, three_point: bool = False) -> Project:
    """A→B→D and A→C→D on a Monday, so C carries float and A/B/D are critical."""
    tp: dict[str, Any] = (
        {"optimistic_duration": 2 * D, "most_likely_duration": 3 * D, "pessimistic_duration": 9 * D}
        if three_point
        else {}
    )
    tasks = [
        Task(id="A", name="Alpha", duration=2 * D, **tp),
        Task(id="B", name="Bravo", duration=3 * D, **tp),
        Task(id="C", name="Charlie", duration=1 * D, **tp),
        Task(id="D", name="Delta", duration=2 * D, **tp),
    ]
    deps = [Dependency(p, s) for p, s in (("A", "B"), ("A", "C"), ("B", "D"), ("C", "D"))]
    return Project(id="p", name="P", start_date=date(2026, 3, 2), tasks=tasks, dependencies=deps)


def _with_task(result: Any, task_id: str, **changes: Any) -> Any:
    tasks = [dataclasses.replace(t, **changes) if t.id == task_id else t for t in result.tasks]
    return dataclasses.replace(result, tasks=tasks)


def _all(_name: str) -> bool:
    return True


@pytest.fixture(autouse=True)
def _fresh_budget() -> Any:
    selfcheck.reset_for_testing()
    yield
    selfcheck.reset_for_testing()


class TestChecks:
    def test_a_clean_schedule_passes_every_check(self) -> None:
        project = _project()
        verdict = selfcheck.evaluate(project, schedule(project), run_sampled=_all)
        assert verdict["checks"] == dict.fromkeys(selfcheck.ALL_CHECKS, "pass")
        assert verdict["violations"] == []
        assert verdict["task_count"] == 4
        assert verdict["engine_version"] == selfcheck.engine_version()

    def test_zero_variance_strips_three_point_estimates(self) -> None:
        # With PERT estimates a real Monte Carlo would land later than CPM; the check
        # removes them, so the invariant still holds.
        project = _project(three_point=True)
        assert selfcheck.check_zero_variance_mc(project, schedule(project))
        zv = selfcheck.zero_variance_project(project)
        assert all(t.optimistic_duration is None for t in zv.tasks)
        assert zv.velocity_samples is None

    def test_negative_float_is_caught(self) -> None:
        result = _with_task(schedule(_project()), "C", total_float=-D)
        assert (
            "negative_float"
            in selfcheck.evaluate(_project(), result, run_sampled=_all)["violations"]
        )

    def test_a_finished_task_is_not_held_to_float_invariants(self) -> None:
        result = _with_task(
            schedule(_project()), "C", total_float=-D, actual_finish=date(2026, 3, 3)
        )
        assert selfcheck.check_negative_float(result)
        assert selfcheck.check_critical_float(result)

    def test_critical_flag_disagreeing_with_float_is_caught(self) -> None:
        result = _with_task(schedule(_project()), "C", is_critical=True)
        assert not selfcheck.check_critical_float(result)

    def test_finish_not_on_the_critical_path_is_caught(self) -> None:
        result = schedule(_project())
        moved = dataclasses.replace(result, project_finish=result.project_finish + D)
        assert not selfcheck.check_finish_is_critical_max(moved)

    def test_non_idempotent_recompute_is_caught(self) -> None:
        project = _project()
        result = schedule(project)
        drifted = _with_task(result, "B", early_finish=result.project_finish + D)
        with mock.patch("trueppm_scheduler.schedule", return_value=drifted):
            assert not selfcheck.check_idempotent(project, result)

    def test_zero_variance_disagreement_is_caught(self) -> None:
        project = _project()
        result = schedule(project)
        late = mock.Mock()
        late.percentiles = {p: mock.Mock(date=result.project_finish + D) for p in (50, 80, 95)}
        with mock.patch("trueppm_scheduler.monte_carlo", return_value=late):
            assert not selfcheck.check_zero_variance_mc(project, result)

    def test_a_check_that_raises_is_counted_not_propagated(self) -> None:
        with mock.patch.object(selfcheck, "check_negative_float", side_effect=RuntimeError):
            verdict = selfcheck.evaluate(_project(), schedule(_project()), run_sampled=_all)
        assert verdict["checks"]["negative_float"] == "error"
        assert verdict["violations"] == ["selfcheck_error"]


class TestRunPostRecompute:
    def test_disabled_runs_nothing(self, settings: Any) -> None:
        settings.SCHEDULER_SELFCHECK_ENABLED = False
        project = _project()
        assert (
            selfcheck.run_post_recompute_selfcheck("p", project, schedule(project), cpm_seconds=1)
            is None
        )

    def test_above_the_envelope_runs_nothing(self, settings: Any) -> None:
        settings.SCHEDULER_SELFCHECK_MAX_TASKS = 3
        project = _project()
        assert (
            selfcheck.run_post_recompute_selfcheck("p", project, schedule(project), cpm_seconds=1)
            is None
        )
        assert selfcheck.full_verdict(project, schedule(project))["skipped_reason"] == (
            "above_envelope"
        )

    def test_expensive_checks_wait_for_budget(self, settings: Any) -> None:
        settings.SCHEDULER_SELFCHECK_BUDGET_SHARE = 0.25
        project = _project()
        result = schedule(project)
        first = selfcheck.run_post_recompute_selfcheck("p", project, result, cpm_seconds=1.0)
        assert first is not None
        # One pass deposits 0.25 s; each expensive check is first predicted at one
        # CPM pass (1 s), so neither fits yet, but the cheap checks always run.
        assert first["checks"]["recompute_not_idempotent"] == "skipped"
        assert first["checks"]["zero_variance_mc_mismatch"] == "skipped"
        assert first["checks"]["negative_float"] == "pass"
        outcomes = [
            selfcheck.run_post_recompute_selfcheck("p", project, result, cpm_seconds=1.0)
            for _ in range(3)
        ]
        assert outcomes[-1] is not None
        assert outcomes[-1]["checks"]["recompute_not_idempotent"] == "pass"

    def test_never_raises(self) -> None:
        assert (
            selfcheck.run_post_recompute_selfcheck("p", object(), object(), cpm_seconds=1) is None
        )

    @pytest.mark.django_db
    def test_violations_reach_the_otel_counter_and_the_log(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import InMemoryMetricReader

        from trueppm_api.apps.observability import otel
        from trueppm_api.apps.observability.otel import attributes, metrics
        from trueppm_api.apps.observability.otel.provider import OTelBootstrapContext

        metrics.reset_for_testing()
        reader = InMemoryMetricReader()
        provider = MeterProvider(metric_readers=[reader])
        ctx = OTelBootstrapContext(
            schema_version=1,
            enabled=True,
            edition="community",
            resource=None,
            tracer_provider=None,
            meter_provider=provider,
        )
        otel.install_metrics(ctx, meter_provider=provider)
        try:
            project = _project()
            result = _with_task(schedule(project), "C", total_float=-D)
            selfcheck._budget.deposit(30.0)  # enough credit for both expensive checks
            with caplog.at_level("WARNING", logger=selfcheck.__name__):
                selfcheck.run_post_recompute_selfcheck("proj-1", project, result, cpm_seconds=0.001)
            points: dict[str, dict[str, int]] = {}
            data = reader.get_metrics_data()
            assert data is not None
            for rm in data.resource_metrics:
                for sm in rm.scope_metrics:
                    for m in sm.metrics:
                        if m.name.startswith("trueppm.scheduler.selfcheck."):
                            points[m.name] = {
                                str(p.attributes[attributes.SCHEDULER_SELFCHECK_CHECK]): p.value
                                for p in m.data.data_points
                            }
        finally:
            metrics.reset_for_testing()
        # The doctored result also disagrees with a real re-schedule of its input.
        assert points[metrics.SCHEDULER_SELFCHECK_VIOLATIONS] == {
            "negative_float": 1,
            "recompute_not_idempotent": 1,
        }
        # With the credit seeded, all five checks were evaluated.
        assert points[metrics.SCHEDULER_SELFCHECK_RUNS] == dict.fromkeys(selfcheck.ALL_CHECKS, 1)
        record = next(r for r in caplog.records if "violation" in r.getMessage())
        assert record.selfcheck_check == "negative_float"  # type: ignore[attr-defined]
        assert record.project_id == "proj-1"  # type: ignore[attr-defined]
        assert record.task_count == 4  # type: ignore[attr-defined]
        assert record.engine_version == selfcheck.engine_version()  # type: ignore[attr-defined]


@pytest.mark.django_db
def test_the_authoritative_recompute_runs_the_selfcheck() -> None:
    from trueppm_api.apps.projects.models import Calendar
    from trueppm_api.apps.projects.models import Project as DbProject
    from trueppm_api.apps.projects.models import Task as DbTask
    from trueppm_api.apps.scheduling.tasks import _run_schedule

    db_project = DbProject.objects.create(
        name="Selfcheck",
        start_date=date(2026, 3, 2),
        status_date=date(2026, 3, 2),
        calendar=Calendar.objects.create(name="Standard"),
    )
    DbTask.objects.create(project=db_project, name="Only", duration=2)
    with mock.patch("trueppm_api.apps.scheduling.selfcheck.run_post_recompute_selfcheck") as spy:
        _run_schedule(str(db_project.pk))
    spy.assert_called_once()
    args, kwargs = spy.call_args
    assert args[0] == str(db_project.pk)
    assert len(args[2].tasks) == 1
    assert kwargs["cpm_seconds"] >= 0
