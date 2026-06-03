"""ADR-0106 §E1 contract additions for the promote dialog (#928).

Three additions layered on the §1/§2 binding backend:
  * the dry-run ``GET /sprints/{id}/reforecast-preview/`` (velocity-band fallback,
    p50/p80/p95, the unmodeled-dependency heuristic, velocity-privacy, member read);
  * optional ``{name, target_date}`` create overrides on promote-to-milestone;
  * the slim ``GET /projects/{id}/milestones/`` list for the bind-existing picker.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Dependency,
    Project,
    Sprint,
    SprintState,
    Task,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def scheduler_user(db: object) -> object:
    return User.objects.create_user(username="sched", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def scheduler_membership(scheduler_user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(
        project=project, user=scheduler_user, role=Role.SCHEDULER
    )


@pytest.fixture
def client(scheduler_user: object, scheduler_membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=scheduler_user)
    return c


def _milestone(
    project: Project, *, name: str = "Phase 1 Gate", early_finish: date | None = None
) -> Task:
    return Task.objects.create(
        project=project,
        name=name,
        duration=0,
        is_milestone=True,
        early_finish=early_finish,
        wbs_path="9",
    )


def _sprint(project: Project, *, goal: str = "Ship the thing") -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="Sprint 1",
        goal=goal,
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.PLANNED,
    )


def _closed_sprint(project: Project, *, name: str, completed_points: int, days_ago: int) -> Sprint:
    """A COMPLETED sprint that feeds ``velocity_summary`` (needs completed_points + closed_at)."""
    return Sprint.objects.create(
        project=project,
        name=name,
        start_date=date(2026, 1, 1),
        finish_date=date(2026, 1, 14),
        state=SprintState.COMPLETED,
        completed_points=completed_points,
        completed_task_count=completed_points,
        closed_at=timezone.now() - timedelta(days=days_ago),
    )


def _seed_velocity(project: Project) -> None:
    """Two closed sprints with differing throughput → a non-degenerate band.

    completed_points 20 & 30 → avg 25, stdev ≈ 7.07 → forecast_range_low 18,
    forecast_range_high 32 (both non-null, so the preview produces a real spread).
    """
    _closed_sprint(project, name="Past A", completed_points=20, days_ago=30)
    _closed_sprint(project, name="Past B", completed_points=30, days_ago=15)


# ---------------------------------------------------------------------------
# reforecast-preview — shape, basis, create-mode spine
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_preview_create_mode_no_history_collapses_to_cpm_finish(
    client: APIClient, project: Project
) -> None:
    """No closed sprints → no defensible band: percentiles all equal cpm_finish."""
    sprint = _sprint(project)
    resp = client.get(f"/api/v1/sprints/{sprint.id}/reforecast-preview/")

    assert resp.status_code == 200
    body = resp.data
    assert body["basis"] == "velocity_band"
    # Create-mode spine is the sprint finish (the date the milestone will take).
    assert body["cpm_finish"] == "2026-04-14"
    assert body["p50"] == body["p80"] == body["p95"] == "2026-04-14"
    assert body["velocity_low"] is None
    assert body["velocity_high"] is None
    assert body["unmodeled_dependency"] is False
    assert body["unmodeled_predecessor_ids"] == []


@pytest.mark.django_db
def test_preview_with_velocity_band_widens_percentiles(client: APIClient, project: Project) -> None:
    _seed_velocity(project)
    sprint = _sprint(project)
    # Remaining committed backlog drives the slow-pace day penalty.
    Task.objects.create(project=project, name="A", sprint=sprint, story_points=21, wbs_path="1")
    Task.objects.create(project=project, name="B", sprint=sprint, story_points=19, wbs_path="2")

    resp = client.get(f"/api/v1/sprints/{sprint.id}/reforecast-preview/")

    assert resp.status_code == 200
    body = resp.data
    assert body["velocity_low"] == 18
    assert body["velocity_high"] == 32
    # Anchored on cpm_finish and monotonic; the slow tail pushes p95 latest.
    assert body["cpm_finish"] == "2026-04-14"
    assert body["p50"] <= body["p80"] <= body["p95"]
    assert body["p95"] > body["p50"]


@pytest.mark.django_db
def test_preview_milestone_id_uses_milestone_early_finish_as_spine(
    client: APIClient, project: Project
) -> None:
    sprint = _sprint(project)
    milestone = _milestone(project, early_finish=date(2026, 5, 20))
    resp = client.get(
        f"/api/v1/sprints/{sprint.id}/reforecast-preview/?milestone_id={milestone.id}"
    )

    assert resp.status_code == 200
    assert resp.data["cpm_finish"] == "2026-05-20"


@pytest.mark.django_db
def test_preview_foreign_project_milestone_is_404(
    client: APIClient, project: Project, calendar: Calendar
) -> None:
    other = Project.objects.create(name="Beta", start_date=date(2026, 4, 1), calendar=calendar)
    foreign = _milestone(other, name="Other gate")
    sprint = _sprint(project)

    resp = client.get(f"/api/v1/sprints/{sprint.id}/reforecast-preview/?milestone_id={foreign.id}")
    assert resp.status_code == 404


@pytest.mark.django_db
def test_preview_unmodeled_dependency_flag_fires_for_out_of_sprint_predecessor(
    client: APIClient, project: Project
) -> None:
    sprint = _sprint(project)
    milestone = _milestone(project, early_finish=date(2026, 5, 1))
    # A predecessor task with NO sprint → the velocity reforecast can't see it.
    upstream = Task.objects.create(project=project, name="Upstream", wbs_path="3")
    Dependency.objects.create(predecessor=upstream, successor=milestone)

    resp = client.get(
        f"/api/v1/sprints/{sprint.id}/reforecast-preview/?milestone_id={milestone.id}"
    )

    assert resp.status_code == 200
    assert resp.data["unmodeled_dependency"] is True
    assert str(upstream.id) in resp.data["unmodeled_predecessor_ids"]


@pytest.mark.django_db
def test_preview_predecessor_in_a_targeting_sprint_is_not_unmodeled(
    client: APIClient, project: Project
) -> None:
    sprint = _sprint(project)
    milestone = _milestone(project, early_finish=date(2026, 5, 1))
    # Predecessor belongs to the very sprint targeting this milestone → modeled.
    sprint.target_milestone = milestone
    sprint.save(update_fields=["target_milestone"])
    upstream = Task.objects.create(project=project, name="Upstream", sprint=sprint, wbs_path="3")
    Dependency.objects.create(predecessor=upstream, successor=milestone)

    resp = client.get(
        f"/api/v1/sprints/{sprint.id}/reforecast-preview/?milestone_id={milestone.id}"
    )

    assert resp.status_code == 200
    assert resp.data["unmodeled_dependency"] is False


# ---------------------------------------------------------------------------
# reforecast-preview — privacy + RBAC
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_preview_emits_band_only_never_velocity_series(client: APIClient, project: Project) -> None:
    """ADR-0106 §3 privacy: the band crosses, never the per-sprint series."""
    _seed_velocity(project)
    sprint = _sprint(project)
    resp = client.get(f"/api/v1/sprints/{sprint.id}/reforecast-preview/")

    assert resp.status_code == 200
    assert "sprints" not in resp.data
    assert "completed_points" not in resp.data
    assert set(resp.data.keys()) == {
        "basis",
        "cpm_finish",
        "p50",
        "p80",
        "p95",
        "velocity_low",
        "velocity_high",
        "unmodeled_dependency",
        "unmodeled_predecessor_ids",
    }


@pytest.mark.django_db
def test_preview_readable_by_viewer(project: Project) -> None:
    """Read-only dry run → any project member, no schedule-authoring role needed."""
    viewer = User.objects.create_user(username="viewer", password="pw")
    ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)
    c = APIClient()
    c.force_authenticate(user=viewer)
    sprint = _sprint(project)

    resp = c.get(f"/api/v1/sprints/{sprint.id}/reforecast-preview/")
    assert resp.status_code == 200


@pytest.mark.django_db
def test_preview_forbidden_for_non_member(project: Project) -> None:
    outsider = User.objects.create_user(username="outsider", password="pw")
    c = APIClient()
    c.force_authenticate(user=outsider)
    sprint = _sprint(project)

    resp = c.get(f"/api/v1/sprints/{sprint.id}/reforecast-preview/")
    assert resp.status_code in (403, 404)


# ---------------------------------------------------------------------------
# promote-to-milestone — create overrides (§E1.2)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_override_name_and_target_date(client: APIClient, project: Project) -> None:
    sprint = _sprint(project, goal="Deliver MVP")
    resp = client.post(
        f"/api/v1/sprints/{sprint.id}/promote-to-milestone/",
        {"name": "Customer Beta Gate", "target_date": "2026-05-30"},
        format="json",
    )

    assert resp.status_code == 201
    milestone = Task.objects.get(pk=resp.data["target_milestone"])
    assert milestone.name == "Customer Beta Gate"
    # target_date overrides the finish-date default as the milestone's SNET floor.
    assert milestone.planned_start == date(2026, 5, 30)


@pytest.mark.django_db
def test_create_blank_name_falls_back_to_goal(client: APIClient, project: Project) -> None:
    sprint = _sprint(project, goal="Deliver MVP")
    resp = client.post(
        f"/api/v1/sprints/{sprint.id}/promote-to-milestone/",
        {"name": "   ", "target_date": None},
        format="json",
    )

    assert resp.status_code == 201
    milestone = Task.objects.get(pk=resp.data["target_milestone"])
    assert milestone.name == "Deliver MVP"
    assert milestone.planned_start == date(2026, 4, 14)


@pytest.mark.django_db
def test_create_override_name_too_long_is_400(client: APIClient, project: Project) -> None:
    sprint = _sprint(project)
    resp = client.post(
        f"/api/v1/sprints/{sprint.id}/promote-to-milestone/",
        {"name": "x" * 256},
        format="json",
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_overrides_ignored_when_binding_existing_milestone(
    client: APIClient, project: Project
) -> None:
    sprint = _sprint(project)
    milestone = _milestone(project, name="Existing Gate")
    resp = client.post(
        f"/api/v1/sprints/{sprint.id}/promote-to-milestone/",
        {"milestone_id": str(milestone.id), "name": "Should Be Ignored"},
        format="json",
    )

    assert resp.status_code == 200
    milestone.refresh_from_db()
    # The existing milestone keeps its name — overrides only apply to create mode.
    assert milestone.name == "Existing Gate"


# ---------------------------------------------------------------------------
# project milestones list (§E1.3)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_milestones_list_returns_slim_rows_with_is_bound(
    client: APIClient, project: Project
) -> None:
    bound_ms = _milestone(project, name="Bound Gate", early_finish=date(2026, 5, 1))
    _milestone(project, name="Free Gate", early_finish=date(2026, 6, 1))
    sprint = _sprint(project)
    sprint.target_milestone = bound_ms
    sprint.save(update_fields=["target_milestone"])

    resp = client.get(f"/api/v1/projects/{project.id}/milestones/")

    assert resp.status_code == 200
    assert len(resp.data) == 2
    rows = {r["name"]: r for r in resp.data}
    assert rows["Bound Gate"]["is_bound"] is True
    assert rows["Free Gate"]["is_bound"] is False
    # Slim shape only — no full Task serialization.
    assert set(rows["Free Gate"].keys()) == {
        "id",
        "name",
        "wbs_path",
        "early_finish",
        "is_bound",
    }


@pytest.mark.django_db
def test_milestones_list_unbound_filter_excludes_bound(client: APIClient, project: Project) -> None:
    bound_ms = _milestone(project, name="Bound Gate")
    _milestone(project, name="Free Gate")
    sprint = _sprint(project)
    sprint.target_milestone = bound_ms
    sprint.save(update_fields=["target_milestone"])

    resp = client.get(f"/api/v1/projects/{project.id}/milestones/?unbound=true")

    assert resp.status_code == 200
    names = [r["name"] for r in resp.data]
    assert names == ["Free Gate"]


@pytest.mark.django_db
def test_milestones_list_excludes_non_milestone_tasks(client: APIClient, project: Project) -> None:
    _milestone(project, name="Gate")
    Task.objects.create(project=project, name="Regular task", wbs_path="1")

    resp = client.get(f"/api/v1/projects/{project.id}/milestones/")

    assert resp.status_code == 200
    assert [r["name"] for r in resp.data] == ["Gate"]


@pytest.mark.django_db
def test_milestones_list_readable_by_viewer(project: Project) -> None:
    viewer = User.objects.create_user(username="viewer", password="pw")
    ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)
    _milestone(project, name="Gate")
    c = APIClient()
    c.force_authenticate(user=viewer)

    resp = c.get(f"/api/v1/projects/{project.id}/milestones/")
    assert resp.status_code == 200
    assert len(resp.data) == 1
