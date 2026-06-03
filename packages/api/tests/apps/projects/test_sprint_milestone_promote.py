"""Sprint↔milestone promote/unbind endpoints + binding provenance (ADR-0106 §1/§2).

Covers the agile/waterfall bridge backend the DA-02 promote dialog (#860) calls:
create-and-bind, bind-existing, idempotency, the no-silent-repoint 409, unbind,
the SCHEDULER+ schedule-authoring gate, cross-project IDOR rejection, and the
derived ``binding_drifted`` flag.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Sprint,
    SprintState,
    Task,
    TaskStatus,
)
from trueppm_api.apps.projects.services import compute_milestone_rollup_payload

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
    # SCHEDULER (200) is the lowest role the promote/unbind gate admits.
    return ProjectMembership.objects.create(
        project=project, user=scheduler_user, role=Role.SCHEDULER
    )


@pytest.fixture
def client(scheduler_user: object, scheduler_membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=scheduler_user)
    return c


def _milestone(project: Project, name: str = "Phase 1 Gate") -> Task:
    return Task.objects.create(
        project=project, name=name, duration=0, is_milestone=True, wbs_path="9"
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


# ---------------------------------------------------------------------------
# promote-to-milestone — create + bind
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_promote_empty_body_creates_and_binds_milestone(
    client: APIClient, project: Project, scheduler_user: object
) -> None:
    sprint = _sprint(project, goal="Deliver MVP")
    resp = client.post(f"/api/v1/sprints/{sprint.id}/promote-to-milestone/", {}, format="json")

    assert resp.status_code == 201
    sprint.refresh_from_db()
    assert sprint.target_milestone_id is not None
    milestone = Task.objects.get(pk=sprint.target_milestone_id)
    assert milestone.is_milestone is True
    # Named from the sprint goal, dated at the sprint finish.
    assert milestone.name == "Deliver MVP"
    assert milestone.planned_start == date(2026, 4, 14)
    # Provenance is populated (ADR-0106 §1).
    assert sprint.milestone_bound_by_id == scheduler_user.pk
    assert sprint.milestone_bound_at is not None
    assert sprint.binding_committed_snapshot is not None
    assert resp.data["milestone_bound_by"] == scheduler_user.pk


@pytest.mark.django_db
def test_promote_empty_body_falls_back_to_sprint_name_when_no_goal(
    client: APIClient, project: Project
) -> None:
    sprint = _sprint(project, goal="")
    resp = client.post(f"/api/v1/sprints/{sprint.id}/promote-to-milestone/", {}, format="json")

    assert resp.status_code == 201
    milestone = Task.objects.get(pk=resp.data["target_milestone"])
    assert milestone.name == "Sprint 1 milestone"


# ---------------------------------------------------------------------------
# promote-to-milestone — bind existing
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_promote_with_milestone_id_binds_existing(client: APIClient, project: Project) -> None:
    sprint = _sprint(project)
    milestone = _milestone(project)
    resp = client.post(
        f"/api/v1/sprints/{sprint.id}/promote-to-milestone/",
        {"milestone_id": str(milestone.id)},
        format="json",
    )

    assert resp.status_code == 200
    sprint.refresh_from_db()
    assert sprint.target_milestone_id == milestone.id
    # No second milestone task was minted.
    assert Task.objects.filter(project=project, is_milestone=True).count() == 1


@pytest.mark.django_db
def test_promote_same_milestone_is_idempotent_noop(client: APIClient, project: Project) -> None:
    sprint = _sprint(project)
    milestone = _milestone(project)
    first = client.post(
        f"/api/v1/sprints/{sprint.id}/promote-to-milestone/",
        {"milestone_id": str(milestone.id)},
        format="json",
    )
    assert first.status_code == 200
    # Re-promoting the same milestone returns 200 and does not error or re-point.
    again = client.post(
        f"/api/v1/sprints/{sprint.id}/promote-to-milestone/",
        {"milestone_id": str(milestone.id)},
        format="json",
    )
    assert again.status_code == 200
    sprint.refresh_from_db()
    assert sprint.target_milestone_id == milestone.id


@pytest.mark.django_db
def test_promote_to_different_milestone_while_bound_is_409(
    client: APIClient, project: Project
) -> None:
    sprint = _sprint(project)
    m1 = _milestone(project, name="Gate A")
    m2 = _milestone(project, name="Gate B")
    m2.wbs_path = "10"
    m2.save(update_fields=["wbs_path"])

    client.post(
        f"/api/v1/sprints/{sprint.id}/promote-to-milestone/",
        {"milestone_id": str(m1.id)},
        format="json",
    )
    resp = client.post(
        f"/api/v1/sprints/{sprint.id}/promote-to-milestone/",
        {"milestone_id": str(m2.id)},
        format="json",
    )

    assert resp.status_code == 409
    assert resp.data["code"] == "sprint_already_bound"
    # The binding never silently re-points.
    sprint.refresh_from_db()
    assert sprint.target_milestone_id == m1.id


@pytest.mark.django_db
def test_promote_with_foreign_project_milestone_is_rejected(
    client: APIClient, project: Project, calendar: Calendar
) -> None:
    """Cross-project milestone_id must not bind (IDOR guard)."""
    other = Project.objects.create(name="Beta", start_date=date(2026, 4, 1), calendar=calendar)
    foreign_milestone = _milestone(other, name="Other gate")
    sprint = _sprint(project)

    resp = client.post(
        f"/api/v1/sprints/{sprint.id}/promote-to-milestone/",
        {"milestone_id": str(foreign_milestone.id)},
        format="json",
    )

    assert resp.status_code == 400
    sprint.refresh_from_db()
    assert sprint.target_milestone_id is None


# ---------------------------------------------------------------------------
# unbind-milestone
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_unbind_clears_fk_and_provenance(client: APIClient, project: Project) -> None:
    sprint = _sprint(project)
    milestone = _milestone(project)
    client.post(
        f"/api/v1/sprints/{sprint.id}/promote-to-milestone/",
        {"milestone_id": str(milestone.id)},
        format="json",
    )

    resp = client.post(f"/api/v1/sprints/{sprint.id}/unbind-milestone/", {}, format="json")

    assert resp.status_code == 200
    sprint.refresh_from_db()
    assert sprint.target_milestone_id is None
    assert sprint.milestone_bound_by_id is None
    assert sprint.milestone_bound_at is None
    assert sprint.binding_committed_snapshot is None


@pytest.mark.django_db
def test_unbind_when_not_bound_is_noop_200(client: APIClient, project: Project) -> None:
    sprint = _sprint(project)
    resp = client.post(f"/api/v1/sprints/{sprint.id}/unbind-milestone/", {}, format="json")
    assert resp.status_code == 200
    sprint.refresh_from_db()
    assert sprint.target_milestone_id is None


# ---------------------------------------------------------------------------
# RBAC — schedule-authoring gate (>= SCHEDULER), ADR-0106 §2
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_promote_forbidden_for_member_below_scheduler(project: Project) -> None:
    member = User.objects.create_user(username="member", password="pw")
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=member)
    sprint = _sprint(project)
    milestone = _milestone(project)

    resp = c.post(
        f"/api/v1/sprints/{sprint.id}/promote-to-milestone/",
        {"milestone_id": str(milestone.id)},
        format="json",
    )

    assert resp.status_code == 403
    sprint.refresh_from_db()
    assert sprint.target_milestone_id is None


@pytest.mark.django_db
def test_unbind_forbidden_for_non_member(project: Project) -> None:
    outsider = User.objects.create_user(username="outsider", password="pw")
    c = APIClient()
    c.force_authenticate(user=outsider)
    sprint = _sprint(project)

    resp = c.post(f"/api/v1/sprints/{sprint.id}/unbind-milestone/", {}, format="json")
    assert resp.status_code in (403, 404)


# ---------------------------------------------------------------------------
# binding_drifted — derived, visible-not-silent (ADR-0106 §1)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_binding_drifted_flips_when_committed_scope_changes(
    client: APIClient, project: Project
) -> None:
    sprint = _sprint(project)
    milestone = _milestone(project)
    Task.objects.create(
        project=project,
        name="Story A",
        sprint=sprint,
        story_points=5,
        status=TaskStatus.NOT_STARTED,
        wbs_path="1",
    )

    client.post(
        f"/api/v1/sprints/{sprint.id}/promote-to-milestone/",
        {"milestone_id": str(milestone.id)},
        format="json",
    )
    sprint.refresh_from_db()
    assert sprint.binding_committed_snapshot == 5

    # No drift immediately after promote.
    assert compute_milestone_rollup_payload(milestone)["binding_drifted"] is False

    # Scope grows after the binding baseline was captured → drift lights.
    Task.objects.create(
        project=project,
        name="Story B",
        sprint=sprint,
        story_points=3,
        status=TaskStatus.NOT_STARTED,
        wbs_path="2",
    )
    assert compute_milestone_rollup_payload(milestone)["binding_drifted"] is True
