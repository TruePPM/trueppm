"""Demo gate test: the Atlas sample actually runs the bridge demo (#620).

Loads the bundled Atlas sample, runs CPM on each project, and runs a Monte Carlo
simulation on the waterfall stream. This is the automated proof of the Wave 2
gate — "a fresh install can load the hybrid-large project and run the demo
cold" — covering the analytics the mocked Playwright spec cannot.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.projects.models import Project, Task
from trueppm_api.apps.projects.seed.samples import load_sample
from trueppm_api.apps.scheduling.tasks import _run_program_schedule

pytestmark = pytest.mark.django_db

User = get_user_model()


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(username="demo-owner", email="o@example.com")


def test_atlas_demo_runs_cpm_and_monte_carlo(owner: Any, capsys: Any) -> None:
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

    # The waterfall + hybrid streams carry dependencies → must yield a critical path.
    for methodology in ("WATERFALL", "HYBRID"):
        proj = next(p for p in projects if p.methodology == methodology)
        assert Task.objects.filter(project=proj, is_critical=True).exists(), (
            f"{proj.name}: expected a critical path"
        )

    # 2. Monte Carlo on the waterfall stream (three-point estimates throughout).
    waterfall = next(p for p in projects if p.methodology == "WATERFALL")
    client = APIClient()
    client.force_authenticate(user=owner)
    resp = client.post(f"/api/v1/projects/{waterfall.id}/monte-carlo/", {}, format="json")
    assert resp.status_code == 200, resp.content
    p50, p80, p95 = resp.data["p50"], resp.data["p80"], resp.data["p95"]
    print(f"  MC   {waterfall.name:<18} P50={p50}  P80={p80}  P95={p95}")
    assert p50 and p80 and p95
    # Confidence percentiles are monotonic — a later finish is more certain.
    assert p50 <= p80 <= p95

    # 3. Velocity history: the agile stream has closed sprints with completed points.
    agile = next(p for p in projects if p.methodology == "AGILE")
    closed_with_velocity = agile.sprints.filter(state="COMPLETED", completed_points__isnull=False)
    print(f"  Agile {agile.name:<17} closed sprints with velocity={closed_with_velocity.count()}")
    assert closed_with_velocity.count() >= 1

    captured = capsys.readouterr()
    print(captured.out)  # surface the table even when the suite captures stdout
