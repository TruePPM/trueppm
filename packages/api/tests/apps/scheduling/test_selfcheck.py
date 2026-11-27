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

    def test_a_100_percent_task_without_actual_finish_is_complete(self) -> None:
        # The engine counts percent_complete >= 100 as complete and never marks such
        # a task critical, even at zero float. A real schedule of one must not read
        # as a critical_float_mismatch (or any other violation).
        project = _project()
        tasks = [
            dataclasses.replace(t, percent_complete=100.0, actual_start=date(2026, 3, 2))
            if t.id == "A"
            else t
            for t in project.tasks
        ]
        project = dataclasses.replace(project, tasks=tasks, status_date=date(2026, 3, 4))
        result = schedule(project)
        done = next(t for t in result.tasks if t.id == "A")
        assert done.actual_finish is None
        assert done.total_float == timedelta(0)
        assert not done.is_critical
        verdict = selfcheck.evaluate(project, result, run_sampled=_all)
        assert verdict["violations"] == []

    def test_a_completed_task_may_set_the_project_finish(self) -> None:
        # The engine's project finish spans every task, but a completed task is never
        # critical, so the critical path can end before a completed task does.
        result = schedule(_project())
        late = result.project_finish + D
        doctored = _with_task(result, "C", early_finish=late, percent_complete=100.0)
        doctored = dataclasses.replace(doctored, project_finish=late)
        assert selfcheck.check_finish_is_critical_max(doctored)
        live = _with_task(result, "C", early_finish=late)
        assert not selfcheck.check_finish_is_critical_max(
            dataclasses.replace(live, project_finish=late)
        )

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
        # One pass deposits 0.25 s, 0.125 s per expensive check; each is first
        # predicted at one CPM pass (1 s), so neither fits yet, but the cheap checks
        # always run.
        assert first["checks"]["recompute_not_idempotent"] == "skipped"
        assert first["checks"]["zero_variance_mc_mismatch"] == "skipped"
        assert first["checks"]["negative_float"] == "pass"
        outcomes = [
            selfcheck.run_post_recompute_selfcheck("p", project, result, cpm_seconds=1.0)
            for _ in range(7)
        ]
        assert outcomes[-2] is not None
        assert outcomes[-2]["checks"]["recompute_not_idempotent"] == "skipped"
        assert outcomes[-1] is not None
        # The eighth pass has banked one CPM pass for each check.
        assert outcomes[-1]["checks"]["recompute_not_idempotent"] == "pass"
        assert outcomes[-1]["checks"]["zero_variance_mc_mismatch"] == "pass"

    def test_an_expensive_check_does_not_starve_a_cheap_one(self) -> None:
        # Small project: CPM is sub-millisecond. A slow zero-variance MC overruns
        # once it is learned, but idempotence (one cheap CPM pass) still runs on
        # every pass, and the overrun leaves no debt behind.
        project = _project()
        result = schedule(project)
        # A virtual clock that only the slow check advances: measured costs, and so
        # the sampling decisions, do not depend on how fast this host is.
        clock = [0.0]

        def slow_mc(_project: Any, _result: Any) -> bool:
            clock[0] += 0.01
            return True

        with (
            mock.patch.object(selfcheck, "time", mock.Mock(perf_counter=lambda: clock[0])),
            mock.patch.object(selfcheck, "check_zero_variance_mc", side_effect=slow_mc),
        ):
            verdicts = [
                selfcheck.run_post_recompute_selfcheck("p", project, result, cpm_seconds=0.0002)
                for _ in range(12)
            ]
        checks = [v["checks"] for v in verdicts if v is not None]
        assert len(checks) == 12
        assert all(c["recompute_not_idempotent"] == "pass" for c in checks)
        # Free on the first two passes (the first is warm-up, not learned from),
        # then predicted at ~10 ms and left to wait for credit.
        mc_runs = sum(c["zero_variance_mc_mismatch"] != "skipped" for c in checks)
        assert mc_runs == 2
        assert all(v >= 0.0 for v in selfcheck._budget.credit.values())

    def test_an_overrun_floors_the_credit_at_zero(self) -> None:
        budget = selfcheck._Budget()
        budget.deposit(0.2)
        check = selfcheck.RECOMPUTE_NOT_IDEMPOTENT
        reserved = budget.try_spend(check, 0.1)
        assert reserved == pytest.approx(0.1)
        budget.settle(check, 0.1, reserved or 0.0, actual=50.0)
        assert budget.credit[check] == 0.0
        # The other check's credit is untouched.
        assert budget.credit[selfcheck.ZERO_VARIANCE_MC_MISMATCH] == pytest.approx(0.1)

    def test_on_large_passes_the_budget_bounds_the_run_rate(self) -> None:
        # A 1 s CPM pass with a check costing one pass: at a 0.25 share split over
        # two checks it can run at most one pass in eight, not on every pass.
        budget = selfcheck._Budget()
        check = selfcheck.RECOMPUTE_NOT_IDEMPOTENT
        runs = 0
        for _ in range(80):
            budget.deposit(0.25 * 1.0)
            reserved = budget.try_spend(check, 1.0)
            if reserved is not None:
                runs += 1
                budget.settle(check, 1.0, reserved, actual=1.0)
        assert runs == 10

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
def test_the_persisted_program_pass_runs_the_selfcheck_and_on_read_does_not() -> None:
    from django.utils import timezone

    from trueppm_api.apps.projects.models import Calendar, Dependency, Program
    from trueppm_api.apps.projects.models import Project as DbProject
    from trueppm_api.apps.projects.models import Task as DbTask
    from trueppm_api.apps.projects.program_schedule import gather_program_schedule
    from trueppm_api.apps.scheduling.tasks import _run_program_schedule

    calendar = Calendar.objects.create(name="Standard")
    program = Program.objects.create(name="Launch")
    proj_a, proj_b = (
        DbProject.objects.create(
            name=name, start_date=date(2026, 3, 2), calendar=calendar, program=program
        )
        for name in ("Security", "Marketing")
    )
    a1 = DbTask.objects.create(project=proj_a, name="Sign-off", duration=5)
    b1 = DbTask.objects.create(project=proj_b, name="Go-live", duration=2)
    Dependency.objects.create(
        predecessor=a1, successor=b1, dep_type="FS", lag=0, accepted_at=timezone.now()
    )
    with mock.patch("trueppm_api.apps.scheduling.selfcheck.run_post_recompute_selfcheck") as spy:
        gather_program_schedule(program)
        spy.assert_not_called()
        _run_program_schedule(str(program.pk))
    spy.assert_called_once()
    args, kwargs = spy.call_args
    assert args[0] == str(program.pk)
    assert {t.id for t in args[2].tasks} == {str(a1.pk), str(b1.pk)}
    assert kwargs["scope"] == "program"
    assert kwargs["cpm_seconds"] >= 0


@pytest.mark.django_db
def test_a_program_pass_violation_is_logged_against_the_program(
    caplog: pytest.LogCaptureFixture,
) -> None:
    project = _project()
    result = _with_task(schedule(project), "C", total_float=-D)
    with caplog.at_level("WARNING", logger=selfcheck.__name__):
        selfcheck.run_post_recompute_selfcheck(
            "prog-1", project, result, cpm_seconds=0.0001, scope="program"
        )
    record = next(r for r in caplog.records if "violation" in r.getMessage())
    assert "on program prog-1" in record.getMessage()
    assert record.program_id == "prog-1"  # type: ignore[attr-defined]


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
