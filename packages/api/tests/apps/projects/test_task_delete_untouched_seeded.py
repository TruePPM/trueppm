"""'Delete untouched rows (N)' — the seed banner's bulk sweep (#2731, ADR-0799 §3).

The server computes the set (ADR-0773 §4 forbids a client-supplied id list), so
these tests exercise: the predicate really is `untouched_seeded()` (a touched row
survives, an untouched one does not), the RBAC floor is Admin+ (not just any
project member, and not derived from a permission class that would silently no-op
on this top-level, non-project-nested route), and idempotency (a second sweep is a
no-op, never an error).
"""

from __future__ import annotations

import itertools
from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task, TaskSource

User = get_user_model()

DELETE_URL = "/api/v1/tasks/delete-untouched-seeded/"


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar, owner: Any) -> Project:
    p = Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    return p


def _client_as(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


_short_id_seq = itertools.count(1)


def _seed_rows(project: Project, count: int) -> list[Task]:
    """Mirrors the real seeding path — bulk_create, never save(), so edited_at stays null."""
    rows = [
        Task(
            project=project,
            name=f"Seeded {i}",
            duration=1,
            short_id=f"S{next(_short_id_seq):05X}",
            server_version=1,
            source_kind=TaskSource.TEMPLATE,
            seeded_at=timezone.now(),
        )
        for i in range(count)
    ]
    Task.objects.bulk_create(rows)
    return rows


@pytest.mark.django_db
def test_admin_sweep_deletes_only_untouched_seeded_rows(project: Project, owner: Any) -> None:
    seeded = _seed_rows(project, 3)
    touched = seeded[0]
    touched.refresh_from_db()
    touched.name = "Renamed by a person"
    touched.save()  # stamps edited_at — this row must survive the sweep
    hand = Task.objects.create(project=project, name="Typed", duration=1)

    resp = _client_as(owner).post(DELETE_URL, {"project": str(project.pk)}, format="json")

    assert resp.status_code == 200
    assert resp.json() == {"deleted": 2}
    assert Task.objects.filter(pk__in=[t.pk for t in seeded[1:]], is_deleted=False).count() == 0
    touched.refresh_from_db()
    assert touched.is_deleted is False
    hand.refresh_from_db()
    assert hand.is_deleted is False


@pytest.mark.django_db
def test_sweep_with_nothing_untouched_is_a_no_op_not_an_error(project: Project, owner: Any) -> None:
    Task.objects.create(project=project, name="Typed", duration=1)

    resp = _client_as(owner).post(DELETE_URL, {"project": str(project.pk)}, format="json")

    assert resp.status_code == 200
    assert resp.json() == {"deleted": 0}


@pytest.mark.django_db
def test_sweep_is_idempotent(project: Project, owner: Any) -> None:
    _seed_rows(project, 2)
    client = _client_as(owner)

    first = client.post(DELETE_URL, {"project": str(project.pk)}, format="json")
    second = client.post(DELETE_URL, {"project": str(project.pk)}, format="json")

    assert first.json() == {"deleted": 2}
    assert second.json() == {"deleted": 0}


@pytest.mark.django_db
def test_member_below_admin_is_refused(project: Project) -> None:
    _seed_rows(project, 1)
    member = User.objects.create_user(username="member", password="pw")
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)

    resp = _client_as(member).post(DELETE_URL, {"project": str(project.pk)}, format="json")

    assert resp.status_code == 403
    assert Task.objects.filter(project=project, is_deleted=False).count() == 1


@pytest.mark.django_db
def test_scheduler_role_is_still_refused(project: Project) -> None:
    """Admin+ per ADR-0773 §4 — Scheduler is a rung below and must not pass."""
    _seed_rows(project, 1)
    scheduler = User.objects.create_user(username="sched", password="pw")
    ProjectMembership.objects.create(project=project, user=scheduler, role=Role.SCHEDULER)

    resp = _client_as(scheduler).post(DELETE_URL, {"project": str(project.pk)}, format="json")

    assert resp.status_code == 403


@pytest.mark.django_db
def test_non_member_is_refused(project: Project) -> None:
    _seed_rows(project, 1)
    outsider = User.objects.create_user(username="outsider", password="pw")

    resp = _client_as(outsider).post(DELETE_URL, {"project": str(project.pk)}, format="json")

    assert resp.status_code == 403


@pytest.mark.django_db
def test_missing_project_is_a_400(owner: Any) -> None:
    resp = _client_as(owner).post(DELETE_URL, {}, format="json")
    assert resp.status_code == 400


@pytest.mark.django_db
def test_malformed_project_id_is_a_400(owner: Any) -> None:
    resp = _client_as(owner).post(DELETE_URL, {"project": "not-a-uuid"}, format="json")
    assert resp.status_code == 400


@pytest.mark.django_db
@pytest.mark.parametrize(
    "value",
    [
        pytest.param([None, None], id="list"),
        pytest.param({"id": "x"}, id="dict"),
        pytest.param(7, id="int"),
        pytest.param(1.5, id="float"),
        pytest.param(True, id="bool"),
    ],
)
def test_non_string_project_is_a_400_not_a_500(owner: Any, value: Any) -> None:
    """A non-string `project` must fail closed at the same 400 as a bad string (#2785).

    The two existing malformed-input tests both send strings, so nothing here
    exercised the branch where the value is truthy but has no `.strip()` — which
    was an unhandled AttributeError, i.e. a 500 on input the endpoint's own
    contract calls a 400.
    """
    resp = _client_as(owner).post(DELETE_URL, {"project": value}, format="json")
    assert resp.status_code == 400, resp.data


@pytest.mark.django_db
@pytest.mark.parametrize(
    "value", [pytest.param([], id="empty-list"), pytest.param({}, id="empty-dict")]
)
def test_falsy_non_string_project_is_a_400(owner: Any, value: Any) -> None:
    """The falsy half of the same class — it already 400'd, and must keep doing so."""
    resp = _client_as(owner).post(DELETE_URL, {"project": value}, format="json")
    assert resp.status_code == 400, resp.data


@pytest.mark.django_db
def test_unknown_project_is_a_404(owner: Any) -> None:
    resp = _client_as(owner).post(
        DELETE_URL, {"project": "00000000-0000-0000-0000-000000000000"}, format="json"
    )
    assert resp.status_code == 404


@pytest.mark.django_db
def test_archived_project_is_refused(project: Project, owner: Any) -> None:
    """IsProjectNotArchived also no-ops for this top-level, detail=False route
    (same reason IsProjectAdmin does), so the archived check is explicit."""
    _seed_rows(project, 1)
    project.is_archived = True
    project.save(update_fields=["is_archived"])

    resp = _client_as(owner).post(DELETE_URL, {"project": str(project.pk)}, format="json")

    assert resp.status_code == 403
    assert Task.objects.filter(project=project, is_deleted=False).count() == 1


@pytest.mark.django_db
def test_unauthenticated_is_refused(project: Project) -> None:
    resp = APIClient().post(DELETE_URL, {"project": str(project.pk)}, format="json")
    assert resp.status_code in (401, 403)


@pytest.mark.django_db
def test_ignores_untouched_seeded_rows_outside_the_named_project(
    project: Project, owner: Any, calendar: Calendar
) -> None:
    other_project = Project.objects.create(
        name="Other", start_date=date(2026, 4, 1), calendar=calendar
    )
    ProjectMembership.objects.create(project=other_project, user=owner, role=Role.OWNER)
    _seed_rows(project, 1)
    other_seeded = _seed_rows(other_project, 1)

    resp = _client_as(owner).post(DELETE_URL, {"project": str(project.pk)}, format="json")

    assert resp.json() == {"deleted": 1}
    other_seeded[0].refresh_from_db()
    assert other_seeded[0].is_deleted is False
