"""Server-side placement immutability and PM_ONLY estimate authority (ADR-0743).

Two defects of one class — the intent was written down and enforced on only some of
the paths that reach it:

* #2585 — ``wbs_path`` / ``is_subtask`` / ``parent_governance_inherited`` were in
  ``TaskSerializer.Meta.fields`` and absent from ``read_only_fields``, so a Member
  who may PATCH their own assigned task could relocate it anywhere in the WBS tree,
  bypassing every create-time placement guard.
* #2596 — ``EstimationMode.PM_ONLY`` was enforced only by a disabled input in the
  browser, so a Member assignee could write the estimates the mode exists to forbid,
  and Monte Carlo then treated them as trusted.

The regression guards matter as much as the new refusals: ``pm_only`` must stay
usable for a Project Manager, and ``open`` must not be over-tightened.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    EstimationMode,
    Project,
    Task,
)

User = get_user_model()

PERT = {
    "optimistic_duration": 2,
    "most_likely_duration": 4,
    "pessimistic_duration": 9,
}


@pytest.fixture
def owner(db: object) -> object:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def member(db: object) -> object:
    return User.objects.create_user(username="member", password="pw")


@pytest.fixture
def project(owner: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    p = Project.objects.create(name="Apollo", start_date=date(2026, 1, 1), calendar=cal)
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    return p


@pytest.fixture
def member_client(project: Project, member: object) -> APIClient:
    """A Team Member (Role.MEMBER) — may edit only their own assigned tasks."""
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=member)
    return c


@pytest.fixture
def owner_client(owner: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=owner)
    return c


def _own_task(project: Project, member: object, **kwargs: object) -> Task:
    """A task assigned to the Member, so IsProjectMemberWriteOrOwn admits the PATCH.

    Without the assignment the request would 403 at the permission layer and the
    serializer guard under test would never run.
    """
    return Task.objects.create(
        project=project, name="T", wbs_path="1.1", duration=3, assignee=member, **kwargs
    )


# ---------------------------------------------------------------------------
# #2585 — placement fields are server-managed
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_member_cannot_relocate_task_in_wbs_tree(
    member_client: APIClient, project: Project, member: object
) -> None:
    """The core #2585 exploit: PATCH {"wbs_path": "1"} to reparent at will."""
    t = _own_task(project, member)

    resp = member_client.patch(f"/api/v1/tasks/{t.pk}/", {"wbs_path": "1"}, format="json")

    assert resp.status_code == 200
    t.refresh_from_db()
    assert str(t.wbs_path) == "1.1"


@pytest.mark.django_db
def test_member_cannot_defeat_placement_guards_with_a_combined_patch(
    member_client: APIClient, project: Project, member: object
) -> None:
    """wbs_path + is_subtask together was the real exploit — both must be inert.

    Sending both at once is what defeated all three ``_resolve_create_parent``
    guards simultaneously (milestone-has-no-children, depth-1, phase-vs-subtask),
    none of which is reachable from a PATCH.
    """
    t = _own_task(project, member)

    resp = member_client.patch(
        f"/api/v1/tasks/{t.pk}/",
        {"wbs_path": "1", "is_subtask": True},
        format="json",
    )

    assert resp.status_code == 200
    t.refresh_from_db()
    assert str(t.wbs_path) == "1.1"
    assert t.is_subtask is False


@pytest.mark.django_db
def test_create_derives_wbs_path_and_ignores_a_client_supplied_one(
    owner_client: APIClient, project: Project
) -> None:
    """ADR-0743 decision (a): the server always derives the path.

    Regression guard for the branch deleted from ``perform_create`` — a supplied
    path must not survive, and creation must still succeed and be placed sanely.
    """
    resp = owner_client.post(
        "/api/v1/tasks/",
        {"project": str(project.pk), "name": "Forged", "duration": 1, "wbs_path": "9.9.9"},
        format="json",
    )

    assert resp.status_code == 201
    created = Task.objects.get(pk=resp.data["id"])
    assert str(created.wbs_path) == "1"


@pytest.mark.django_db
def test_create_under_a_parent_still_derives_a_child_path(
    owner_client: APIClient, project: Project
) -> None:
    """The legitimate parent_id placement path is untouched by the fix."""
    parent = Task.objects.create(project=project, name="Phase", wbs_path="1", duration=1)

    resp = owner_client.post(
        "/api/v1/tasks/",
        {
            "project": str(project.pk),
            "name": "Child",
            "duration": 1,
            "parent_id": str(parent.pk),
        },
        format="json",
    )

    assert resp.status_code == 201
    assert str(Task.objects.get(pk=resp.data["id"]).wbs_path) == "1.1"


# ---------------------------------------------------------------------------
# #2682 follow-up — Schedule's Enter-to-add-row must send a non-blank name
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_blank_name_is_rejected_on_create() -> None:
    """Documents the contract the client must honor: ``Task.name`` has no
    ``blank=True``, so DRF derives ``allow_blank=False``. A client that POSTs an
    empty name (as Schedule's Enter-to-add-row / ``insertBelow`` briefly did)
    gets a 400 with no task created — silently, if the caller has no
    ``onError`` handler. This is the exact bug #2682's follow-up fixed on the
    frontend; this test guards the server-side half of that contract so a
    future client regression fails loudly in CI instead of shipping a
    "pressing Enter creates nothing" defect again.
    """
    calendar = Calendar.objects.create(name="Std")
    project = Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)
    user = User.objects.create_user(username="member2682", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    client = APIClient()
    client.force_authenticate(user=user)

    resp = client.post(
        "/api/v1/tasks/",
        {"project": str(project.pk), "name": "", "duration": 1},
        format="json",
    )

    assert resp.status_code == 400
    assert "name" in resp.data
    assert not Task.objects.filter(project=project).exists()


@pytest.mark.django_db
def test_create_with_the_exact_payload_shape_insertbelow_sends(
    owner_client: APIClient, project: Project
) -> None:
    """Enter-to-add-row (`ScheduleView.tsx`'s `insertBelow`) sends exactly
    ``{project, name: 'New task', duration: 1, parent_id}`` (or no
    ``parent_id`` for a root-level sibling). Pin the contract so a future
    server-side change to ``name``'s constraints or required fields can't
    silently break the Schedule Enter flow again without a failing test.
    """
    parent = Task.objects.create(project=project, name="Phase", wbs_path="1", duration=1)

    resp = owner_client.post(
        "/api/v1/tasks/",
        {
            "project": str(project.pk),
            "name": "New task",
            "duration": 1,
            "parent_id": str(parent.pk),
        },
        format="json",
    )

    assert resp.status_code == 201, resp.content
    assert resp.data["name"] == "New task"


# ---------------------------------------------------------------------------
# #2596 — PM_ONLY estimate authority is enforced on the server
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_member_cannot_write_estimates_in_pm_only(
    member_client: APIClient, project: Project, member: object
) -> None:
    """The core #2596 exploit — a disabled input was the only control."""
    project.estimation_mode = EstimationMode.PM_ONLY
    project.save(update_fields=["estimation_mode"])
    t = _own_task(project, member)

    resp = member_client.patch(f"/api/v1/tasks/{t.pk}/", PERT, format="json")

    assert resp.status_code == 403
    t.refresh_from_db()
    assert t.optimistic_duration is None
    assert t.most_likely_duration is None
    assert t.pessimistic_duration is None


@pytest.mark.django_db
def test_member_cannot_smuggle_an_estimate_in_on_create_in_pm_only(
    project: Project, member: object
) -> None:
    """The guard runs on create too — otherwise the fix repeats the defect class.

    Surfaced by the ``ai-review`` gate: guarding only ``update`` would leave POST
    open, and ``_apply_estimate_governance`` would then stamp the unauthorized
    estimate ``estimate_status = None``, i.e. trusted.
    """
    project.estimation_mode = EstimationMode.PM_ONLY
    project.save(update_fields=["estimation_mode"])
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=member)

    resp = c.post(
        "/api/v1/tasks/",
        {"project": str(project.pk), "name": "Smuggled", "duration": 4, **PERT},
        format="json",
    )

    assert resp.status_code == 403
    assert not Task.objects.filter(name="Smuggled").exists()


@pytest.mark.django_db
def test_project_manager_can_still_write_estimates_in_pm_only(
    owner_client: APIClient, project: Project, member: object
) -> None:
    """Regression guard — pm_only must remain usable, or the fix is a lockout."""
    project.estimation_mode = EstimationMode.PM_ONLY
    project.save(update_fields=["estimation_mode"])
    t = _own_task(project, member)

    resp = owner_client.patch(f"/api/v1/tasks/{t.pk}/", PERT, format="json")

    assert resp.status_code == 200
    t.refresh_from_db()
    assert t.optimistic_duration == 2
    assert t.most_likely_duration == 4
    assert t.pessimistic_duration == 9


@pytest.mark.django_db
def test_member_can_still_write_estimates_in_open_mode(
    member_client: APIClient, project: Project, member: object
) -> None:
    """Regression guard against over-tightening — OPEN is the default mode."""
    assert project.estimation_mode == EstimationMode.OPEN
    t = _own_task(project, member)

    resp = member_client.patch(f"/api/v1/tasks/{t.pk}/", PERT, format="json")

    assert resp.status_code == 200
    t.refresh_from_db()
    assert t.most_likely_duration == 4


@pytest.mark.django_db
def test_non_estimate_patch_still_succeeds_in_pm_only(
    member_client: APIClient, project: Project, member: object
) -> None:
    """The guard narrows a field group; it does not block the whole request."""
    project.estimation_mode = EstimationMode.PM_ONLY
    project.save(update_fields=["estimation_mode"])
    t = _own_task(project, member)

    resp = member_client.patch(
        f"/api/v1/tasks/{t.pk}/", {"percent_complete": 0.0, "name": "Renamed"}, format="json"
    )

    assert resp.status_code == 200
    t.refresh_from_db()
    assert t.name == "Renamed"


# ---------------------------------------------------------------------------
# can_edit_estimates — the declarative half of the same rule (ADR-0133)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_can_edit_estimates_reports_false_for_a_member_in_pm_only(
    member_client: APIClient, project: Project, member: object
) -> None:
    """The client must gate off the same predicate the server enforces.

    ``can_edit`` is True here — the Member may edit the task — so this is exactly
    the distinction a plain ``can_edit`` cannot express.
    """
    project.estimation_mode = EstimationMode.PM_ONLY
    project.save(update_fields=["estimation_mode"])
    t = _own_task(project, member)

    resp = member_client.get(f"/api/v1/tasks/{t.pk}/")

    assert resp.status_code == 200
    assert resp.data["can_edit"] is True
    assert resp.data["can_edit_estimates"] is False


@pytest.mark.django_db
def test_can_edit_estimates_reports_true_in_open_mode(
    member_client: APIClient, project: Project, member: object
) -> None:
    t = _own_task(project, member)

    resp = member_client.get(f"/api/v1/tasks/{t.pk}/")

    assert resp.status_code == 200
    assert resp.data["can_edit_estimates"] is True


@pytest.mark.django_db
def test_can_edit_estimates_reports_true_for_the_pm_in_pm_only(
    owner_client: APIClient, project: Project, member: object
) -> None:
    project.estimation_mode = EstimationMode.PM_ONLY
    project.save(update_fields=["estimation_mode"])
    t = _own_task(project, member)

    resp = owner_client.get(f"/api/v1/tasks/{t.pk}/")

    assert resp.status_code == 200
    assert resp.data["can_edit_estimates"] is True
