"""Demo gate test: the Atlas sample actually runs the bridge demo (#620).

Loads the bundled Atlas sample, runs CPM on each project, and runs a Monte Carlo
simulation on the waterfall stream. This is the automated proof of the Wave 2
gate — "a fresh install can load the hybrid-large project and run the demo
cold" — covering the analytics the mocked Playwright spec cannot.
"""

from __future__ import annotations

import functools
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.db import models
from rest_framework.test import APIClient
from trueppm_scheduler import engine as scheduler_engine

from trueppm_api.apps.projects.models import Project, Task
from trueppm_api.apps.projects.seed.samples import load_sample
from trueppm_api.apps.scheduling.tasks import _run_program_schedule

pytestmark = pytest.mark.django_db

User = get_user_model()


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(username="demo-owner", email="o@example.com")


def test_atlas_demo_runs_cpm_and_monte_carlo(
    owner: Any, capsys: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    program = load_sample("atlas-platform-launch", owner=owner, create_users=True)
    projects = list(Project.objects.filter(program=program).order_by("name"))
    assert len(projects) == 3

    print("\n=== Atlas Platform Launch — demo gate verification ===")

    # 1. CPM: schedule the program and confirm every stream gets early dates
    #    (and, for the dependency-bearing streams, a critical path).
    #
    #    ADR-0120 D3: Atlas carries accepted cross-project edges, so a single-project
    #    recompute escalates to the merged program-scoped pass and writes nothing on
    #    its own — the program run is the sole writer while escalation holds. Drive
    #    that pass directly (in production a Celery worker runs it async) so every
    #    member project receives program-true floats and criticality before we assert.
    _run_program_schedule(str(program.id))
    for project in projects:
        tasks = list(Task.objects.filter(project=project, is_deleted=False))
        scheduled = [t for t in tasks if t.early_start is not None and t.early_finish is not None]
        critical = [t for t in tasks if t.is_critical]
        finish = max(
            (t.early_finish for t in scheduled if t.early_finish is not None), default=None
        )
        print(
            f"  CPM  {project.name:<18} {project.methodology:<10} "
            f"tasks={len(tasks):>3} scheduled={len(scheduled):>3} "
            f"critical={len(critical):>2} finish={finish}"
        )
        assert scheduled, f"{project.name}: CPM produced no scheduled tasks"

    # The dependency-bearing streams must yield a critical path — but this is a
    # program-scoped pass (ADR-0120 D3), so only the program's driving chain is
    # critical. A member project off that chain legitimately carries zero critical
    # tasks: here GTM Readiness is the latest-finishing stream and holds the path,
    # while Migration Tooling's live tail runs one working day of float behind it.
    # Assert the invariant at the program level rather than per project.
    program_critical = Task.objects.filter(project__in=projects, is_critical=True, is_deleted=False)
    assert program_critical.exists(), "program-scoped CPM produced no critical path"

    # #1863: a completed task carries zero total float (its late == early after the
    # backward pass) but must never be on the critical path — it has no remaining
    # work and cannot drive the finish. The critical path is live work only.
    completed_on_path = program_critical.filter(
        models.Q(percent_complete__gte=100) | models.Q(actual_finish__isnull=False)
    )
    assert not completed_on_path.exists(), (
        "a completed task must never be on the critical path (#1863): "
        f"{list(completed_on_path.values_list('name', flat=True))}"
    )

    # 2. Monte Carlo on the waterfall stream (three-point estimates throughout).
    waterfall = next(p for p in projects if p.methodology == "WATERFALL")
    client = APIClient()
    client.force_authenticate(user=owner)

    # Pin the Monte Carlo RNG for the demo-gate assertions below. The
    # /monte-carlo/ endpoint runs unseeded in production, so the sampled
    # P50->P95 band drifts run-to-run; near the #1891 floor it occasionally
    # dips below the threshold purely from sampling noise, reddening main on a
    # commit that changed nothing in the engine or the sample. Seeding removes
    # that noise while still exercising the real endpoint, engine, and sample
    # data end-to-end — a genuine regression (the #1891 flat-spike collapse,
    # where the pinned milestone clamps every percentile to one date) still
    # drives the band to 0 and fails the assertion. The view rebinds
    # ``monte_carlo`` from the engine module on every call, so patching the
    # module attribute is picked up.
    monkeypatch.setattr(
        scheduler_engine,
        "monte_carlo",
        functools.partial(scheduler_engine.monte_carlo, seed=1891),
    )

    resp = client.post(f"/api/v1/projects/{waterfall.id}/monte-carlo/", {}, format="json")
    assert resp.status_code == 200, resp.content
    p50, p80, p95 = resp.data["p50"], resp.data["p80"], resp.data["p95"]
    print(f"  MC   {waterfall.name:<18} P50={p50}  P80={p80}  P95={p95}")
    assert p50 and p80 and p95
    # Confidence percentiles are monotonic — a later finish is more certain.
    assert p50 <= p80 <= p95

    # The forecast must show a *real* uncertainty band, not a near-flat spike.
    # Regression guard for #1891: the "Migration complete" milestone used to carry
    # a fixed planned_start (a hard SNET floor) ~2 weeks after the incomplete
    # migrate/cutover work was forecast to finish. That pin clamped the project
    # finish to a constant date and every incomplete task's sampled duration was
    # absorbed by the intervening float, so Monte Carlo collapsed to a flat
    # P50=P80=P95 (0-day band) — the feature demoed as a certainty, not a forecast.
    # The milestone is now driven off its FS predecessor (the last cutover task),
    # so the incomplete critical path's right-skewed three-point variance reaches
    # the finish and the band spans multiple working days.
    #
    # Floor is 2, not the true value: with the RNG pinned above the band is a
    # deterministic ~4 working days for this sample. The guard's job is to catch
    # the #1891 collapse (band -> 0), so the floor sits safely between "flat
    # spike" (0) and the healthy band (~4) — high enough to fail hard on a
    # re-pin, low enough not to re-flake on a benign one-day sampling shift.
    from datetime import date as _date

    band_days = (_date.fromisoformat(p95) - _date.fromisoformat(p50)).days
    sensitivity = resp.data.get("sensitivity") or []
    driver_id = sensitivity[0]["task_id"] if sensitivity else None
    print(f"  MC   band P50->P95 = {band_days}d, top-driver task={driver_id}")
    assert band_days >= 2, (
        f"{waterfall.name}: waterfall MC band collapsed to {band_days}d — the "
        "finish is pinned or the remaining-work variance is absorbed by float (#1891)"
    )
    # The sensitivity tornado must be driven by the incomplete critical path
    # (phases 3-5), not a completed task — otherwise the band, even if wide, is
    # not the *actionable* remaining risk the demo is meant to show.
    assert driver_id is not None, "no MC sensitivity drivers returned"
    driver = Task.objects.get(id=driver_id)
    assert driver.status != "COMPLETE", (
        f"top MC driver {driver.wbs_path} is COMPLETE — variance is not on the "
        "remaining critical path (#1891)"
    )

    # 3. Velocity history: the agile stream has closed sprints with completed points.
    agile = next(p for p in projects if p.methodology == "AGILE")
    closed_with_velocity = agile.sprints.filter(state="COMPLETED", completed_points__isnull=False)
    print(f"  Agile {agile.name:<17} closed sprints with velocity={closed_with_velocity.count()}")
    assert closed_with_velocity.count() >= 1

    captured = capsys.readouterr()
    print(captured.out)  # surface the table even when the suite captures stdout
