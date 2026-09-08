"""Archived projects refuse the write routes that used to slip past the gate (#3414).

The route-table invariant in ``test_route_table_invariants.py`` proves an enforcement
path *exists* for every project-scoped write route. It cannot prove the path returns the
right answer, and it deliberately does not try — a structural scan that also had to
execute each route would be a second test suite pretending to be an assertion.

This is that second suite, and every case is a **pair**: the archived project must be
refused, and an otherwise identical live project must still succeed. The live half is
not ceremony. Three of these fixes gate a route that had no lifecycle check at all, and
the cheapest way to "pass" such a fix is to refuse everyone — which a one-sided test
would certify. Where the fix is an exemption rather than a gate, the pair inverts: the
archived project must still succeed.

Refusals are asserted on **inertness** (the row did not change, the flag did not flip)
rather than on a non-2xx alone, because several of these paths answer a soft status by
design — the Git receiver's uniform 404 among them.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import uuid
from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.urls import reverse
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.integrations.models import BoardAutomation
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import (
    AcceptanceCriterion,
    Calendar,
    CrossProjectSlipConflict,
    Project,
    ProjectApiToken,
    SlipConflictResolution,
    Sprint,
    SprintState,
    Task,
)
from trueppm_api.apps.resources.models import (
    ProjectResource,
    Resource,
    Skill,
    TaskResource,
    TaskSkillRequirement,
)
from trueppm_api.apps.webhooks.models import Webhook

User = get_user_model()

pytestmark = pytest.mark.django_db

ARCHIVED_DETAIL = "This project is archived and cannot be modified. Unarchive it first."


@pytest.fixture(autouse=True)
def _mute_broadcasts() -> Any:
    """Nothing here asserts on real-time fanout; the archived question is REST-side."""
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
        yield


@pytest.fixture
def calendar() -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def live(calendar: Calendar) -> Project:
    return Project.objects.create(name="Live", start_date=date(2026, 3, 1), calendar=calendar)


@pytest.fixture
def archived(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="Archived", start_date=date(2026, 3, 1), calendar=calendar, is_archived=True
    )


@pytest.fixture
def owner() -> Any:
    """Every refusal below is asserted as OWNER on purpose.

    Archived is project state, not caller authority — so the top of the role ladder must
    be refused too. A test that used a Viewer would pass against a role check and prove
    nothing about the lifecycle gate.
    """
    return User.objects.create_user(username="arch_owner", password="pw")


@pytest.fixture
def client(owner: Any, live: Project, archived: Project) -> APIClient:
    for project in (live, archived):
        ProjectMembership.objects.create(project=project, user=owner, role=Role.OWNER)
    api = APIClient()
    api.force_authenticate(user=owner)
    return api


def _task(project: Project, name: str = "T", **kw: Any) -> Task:
    return Task.objects.create(project=project, name=name, duration=1, **kw)


# ---------------------------------------------------------------------------
# The archive bypass: `destroy` / `restore` on every project-scoped viewset
# ---------------------------------------------------------------------------
#
# The widest hole this issue closed, and the one nothing in the tracker named.
# `_ARCHIVE_BYPASS_ACTIONS` matched the ACTION NAME only, and `destroy` is router-minted
# on every ModelViewSet — so a DELETE on any project-scoped row returned 204 on an
# archived project, on twenty viewsets. `TaskViewSet` stands in for the class here; the
# structural half is asserted directly against `_bypasses_archive_check` in
# `test_route_table_invariants.py`, which is what covers the other nineteen.


def test_deleting_a_task_in_an_archived_project_is_refused(
    client: APIClient, archived: Project
) -> None:
    task = _task(archived, "doomed")
    resp = client.delete(f"/api/v1/tasks/{task.pk}/")
    assert resp.status_code == 403, resp.data
    task.refresh_from_db()
    assert task.is_deleted is False, "the row was deleted despite the 403"


def test_deleting_a_task_in_a_live_project_still_works(client: APIClient, live: Project) -> None:
    task = _task(live, "doomed")
    resp = client.delete(f"/api/v1/tasks/{task.pk}/")
    assert resp.status_code == 204, resp.data
    task.refresh_from_db()
    assert task.is_deleted is True


def test_restoring_a_task_in_an_archived_project_is_refused(
    client: APIClient, archived: Project
) -> None:
    task = _task(archived, "gone")
    task.is_deleted = True
    task.save(update_fields=["is_deleted"])
    resp = client.post(f"/api/v1/tasks/{task.pk}/restore/")
    assert resp.status_code in (403, 404), resp.data
    task.refresh_from_db()
    assert task.is_deleted is True


def test_an_owner_can_still_unarchive_and_delete_the_project_itself(
    client: APIClient, archived: Project
) -> None:
    """The bypass still exists where it was meant to — scoping it must not re-create
    the catch-22 it was written to avoid."""
    resp = client.post(f"/api/v1/projects/{archived.pk}/unarchive/")
    assert resp.status_code == 200, resp.data
    archived.refresh_from_db()
    assert archived.is_archived is False


# ---------------------------------------------------------------------------
# The object hop: rows one FK removed from their project
# ---------------------------------------------------------------------------


def test_patching_a_task_assignment_in_an_archived_project_is_refused(
    client: APIClient, archived: Project
) -> None:
    """Regression coverage, not a fix — and the distinction is the point.

    A `task`-hop was briefly added to `_get_project_id_from_obj` on the theory that this
    route was fail-open. It was not: `TaskResource` (like every other task-scoped model
    the resolver meets) exposes a `project_id` **property** that walks the relation
    itself, so the existing branch resolves it and `has_object_permission` has always
    fired here. The hop was removed; this pair stays, because nothing else asserted the
    property is what the gate depends on, and replacing it with a plain column would
    silently unhook the check.
    """
    task = _task(archived)
    resource = Resource.objects.create(name="Dana", email="d@example.com", max_units=1.0)
    assignment = TaskResource.objects.create(task=task, resource=resource, units="1.0")
    resp = client.patch(f"/api/v1/task-resources/{assignment.pk}/", {"units": "0.5"}, format="json")
    assert resp.status_code == 403, resp.data
    assignment.refresh_from_db()
    assert float(assignment.units) == 1.0


def test_patching_a_task_assignment_in_a_live_project_still_works(
    client: APIClient, live: Project
) -> None:
    task = _task(live)
    resource = Resource.objects.create(name="Dana", email="d2@example.com", max_units=1.0)
    assignment = TaskResource.objects.create(task=task, resource=resource, units="1.0")
    resp = client.patch(f"/api/v1/task-resources/{assignment.pk}/", {"units": "0.5"}, format="json")
    assert resp.status_code == 200, resp.data
    assignment.refresh_from_db()
    assert float(assignment.units) == 0.5


# ---------------------------------------------------------------------------
# Body-resolved creates: the project is named only in the request body
# ---------------------------------------------------------------------------


def test_adding_to_the_roster_of_an_archived_project_is_refused(
    client: APIClient, archived: Project
) -> None:
    resource = Resource.objects.create(name="Ivy", email="ivy@example.com", max_units=1.0)
    resp = client.post(
        "/api/v1/project-resources/",
        {"project": str(archived.pk), "resource": str(resource.pk)},
        format="json",
    )
    assert resp.status_code == 403, resp.data
    assert ProjectResource.objects.filter(project=archived).count() == 0


def test_adding_to_the_roster_of_a_live_project_still_works(
    client: APIClient, live: Project
) -> None:
    resource = Resource.objects.create(name="Ivy", email="ivy2@example.com", max_units=1.0)
    resp = client.post(
        "/api/v1/project-resources/",
        {"project": str(live.pk), "resource": str(resource.pk)},
        format="json",
    )
    assert resp.status_code == 201, resp.data
    assert ProjectResource.objects.filter(project=live).count() == 1


def test_assigning_a_resource_in_an_archived_project_is_refused(
    client: APIClient, archived: Project
) -> None:
    task = _task(archived)
    resource = Resource.objects.create(name="Kai", email="kai@example.com", max_units=1.0)
    resp = client.post(
        "/api/v1/task-resources/",
        {"task": str(task.pk), "resource": str(resource.pk), "units": "1.0"},
        format="json",
    )
    assert resp.status_code == 403, resp.data
    assert TaskResource.objects.filter(task=task).count() == 0


def test_assigning_a_resource_in_a_live_project_still_works(
    client: APIClient, live: Project
) -> None:
    task = _task(live)
    resource = Resource.objects.create(name="Kai", email="kai2@example.com", max_units=1.0)
    resp = client.post(
        "/api/v1/task-resources/",
        {"task": str(task.pk), "resource": str(resource.pk), "units": "1.0"},
        format="json",
    )
    assert resp.status_code == 201, resp.data
    assert TaskResource.objects.filter(task=task).count() == 1


# ---------------------------------------------------------------------------
# The roster DELETE cells: enforced by `_bypasses_archive_check`, pinned by nothing
# ---------------------------------------------------------------------------
#
# #3414 made `destroy` stop bypassing the archived check on every viewset that is not
# `ProjectViewSet`, and #3414's own pairs above cover PATCH and POST on these two
# routes — but not DELETE, which is the action the bypass actually governed. The
# `?force=true` cell matters most: it severs live assignments and enqueues a CPM
# recalculation on a plan that is supposed to be frozen, so its refusal is asserted on
# the assignments surviving and on no recalculation being enqueued, not on the status
# alone (#3570).


def test_deleting_a_task_assignment_in_an_archived_project_is_refused(
    client: APIClient, archived: Project
) -> None:
    task = _task(archived)
    resource = Resource.objects.create(name="Lee", email="lee@example.com", max_units=1.0)
    assignment = TaskResource.objects.create(task=task, resource=resource, units="1.0")
    resp = client.delete(f"/api/v1/task-resources/{assignment.pk}/")
    assert resp.status_code == 403, resp.data
    assert TaskResource.objects.filter(pk=assignment.pk).exists(), (
        "the assignment was deleted despite the 403"
    )


def test_deleting_a_task_assignment_in_a_live_project_still_works(
    client: APIClient, live: Project
) -> None:
    task = _task(live)
    resource = Resource.objects.create(name="Lee", email="lee2@example.com", max_units=1.0)
    assignment = TaskResource.objects.create(task=task, resource=resource, units="1.0")
    resp = client.delete(f"/api/v1/task-resources/{assignment.pk}/")
    assert resp.status_code == 204, resp.data
    assert not TaskResource.objects.filter(pk=assignment.pk).exists()


def test_force_removing_a_roster_member_in_an_archived_project_is_refused(
    client: APIClient, archived: Project
) -> None:
    task = _task(archived)
    resource = Resource.objects.create(name="Mo", email="mo@example.com", max_units=1.0)
    roster_row = ProjectResource.objects.create(project=archived, resource=resource)
    assignment = TaskResource.objects.create(task=task, resource=resource, units="1.0")

    with patch("trueppm_api.apps.resources.views._enqueue_recalculate") as recalc:
        resp = client.delete(f"/api/v1/project-resources/{roster_row.pk}/?force=true")

    assert resp.status_code == 403, resp.data
    roster_row.refresh_from_db()
    assert roster_row.is_deleted is False, "the roster row was removed despite the 403"
    assert TaskResource.objects.filter(pk=assignment.pk).exists(), (
        "force=true severed a live assignment on an archived project"
    )
    recalc.assert_not_called()


def test_force_removing_a_roster_member_in_a_live_project_still_works(
    client: APIClient, live: Project
) -> None:
    task = _task(live)
    resource = Resource.objects.create(name="Mo", email="mo2@example.com", max_units=1.0)
    roster_row = ProjectResource.objects.create(project=live, resource=resource)
    assignment = TaskResource.objects.create(task=task, resource=resource, units="1.0")

    resp = client.delete(f"/api/v1/project-resources/{roster_row.pk}/?force=true")

    assert resp.status_code == 200, resp.data
    assert resp.data["cascaded_assignment_count"] == 1
    assert not ProjectResource.objects.filter(pk=roster_row.pk).exists()
    assert not TaskResource.objects.filter(pk=assignment.pk).exists()


# ---------------------------------------------------------------------------
# Task skill requirements: the viewset that declared no lifecycle gate at all
# ---------------------------------------------------------------------------
#
# `TaskSkillRequirementViewSet` fell outside #3414's denominator twice over: it applied
# no project-scoped permission class, so the route-table invariant never enumerated it,
# and `TaskSkillRequirement` reaches its project only through `task`, so adding the
# class alone would have resolved `None` and returned "permitted". Both halves are fixed
# together in #3570 — a `project_id` property on the model, the class on the viewset,
# and `assert_project_not_archived` in `_require_scheduler_on_task` for create.


@pytest.fixture
def skill() -> Skill:
    return Skill.objects.create(name="React")


def test_adding_a_skill_requirement_in_an_archived_project_is_refused(
    client: APIClient, archived: Project, skill: Skill
) -> None:
    task = _task(archived)
    resp = client.post(
        "/api/v1/task-skill-requirements/",
        {"task": str(task.pk), "skill": str(skill.pk), "min_proficiency": 1},
        format="json",
    )
    assert resp.status_code == 403, resp.data
    assert TaskSkillRequirement.objects.filter(task=task).count() == 0


def test_adding_a_skill_requirement_in_a_live_project_still_works(
    client: APIClient, live: Project, skill: Skill
) -> None:
    task = _task(live)
    resp = client.post(
        "/api/v1/task-skill-requirements/",
        {"task": str(task.pk), "skill": str(skill.pk), "min_proficiency": 1},
        format="json",
    )
    assert resp.status_code == 201, resp.data
    assert TaskSkillRequirement.objects.filter(task=task).count() == 1


def test_patching_a_skill_requirement_in_an_archived_project_is_refused(
    client: APIClient, archived: Project, skill: Skill
) -> None:
    task = _task(archived)
    requirement = TaskSkillRequirement.objects.create(task=task, skill=skill, min_proficiency=1)
    resp = client.patch(
        f"/api/v1/task-skill-requirements/{requirement.pk}/",
        {"min_proficiency": 3},
        format="json",
    )
    assert resp.status_code == 403, resp.data
    requirement.refresh_from_db()
    assert requirement.min_proficiency == 1, "the requirement was updated despite the 403"


def test_patching_a_skill_requirement_in_a_live_project_still_works(
    client: APIClient, live: Project, skill: Skill
) -> None:
    task = _task(live)
    requirement = TaskSkillRequirement.objects.create(task=task, skill=skill, min_proficiency=1)
    resp = client.patch(
        f"/api/v1/task-skill-requirements/{requirement.pk}/",
        {"min_proficiency": 3},
        format="json",
    )
    assert resp.status_code == 200, resp.data
    requirement.refresh_from_db()
    assert requirement.min_proficiency == 3


def test_repointing_a_skill_requirement_onto_an_archived_project_is_refused(
    client: APIClient, live: Project, archived: Project, skill: Skill
) -> None:
    """The object DRF checks on an update is the OLD row — here, a live one.

    ``has_object_permission`` runs against the requirement as it exists, so a PATCH that
    moves it onto a task in an archived project passes the class check and is refused
    only by the body-level ``assert_project_not_archived`` on the destination task. This
    is the cell a class-only fix leaves open.
    """
    requirement = TaskSkillRequirement.objects.create(
        task=_task(live), skill=skill, min_proficiency=1
    )
    destination = _task(archived, "frozen")
    resp = client.patch(
        f"/api/v1/task-skill-requirements/{requirement.pk}/",
        {"task": str(destination.pk)},
        format="json",
    )
    assert resp.status_code == 403, resp.data
    requirement.refresh_from_db()
    assert requirement.task_id != destination.pk, "the requirement was moved despite the 403"


def test_deleting_a_skill_requirement_in_an_archived_project_is_refused(
    client: APIClient, archived: Project, skill: Skill
) -> None:
    task = _task(archived)
    requirement = TaskSkillRequirement.objects.create(task=task, skill=skill, min_proficiency=1)
    resp = client.delete(f"/api/v1/task-skill-requirements/{requirement.pk}/")
    assert resp.status_code == 403, resp.data
    requirement.refresh_from_db()
    assert requirement.is_deleted is False, "the requirement was deleted despite the 403"


def test_deleting_a_skill_requirement_in_a_live_project_still_works(
    client: APIClient, live: Project, skill: Skill
) -> None:
    task = _task(live)
    requirement = TaskSkillRequirement.objects.create(task=task, skill=skill, min_proficiency=1)
    resp = client.delete(f"/api/v1/task-skill-requirements/{requirement.pk}/")
    assert resp.status_code == 204, resp.data
    assert not TaskSkillRequirement.objects.filter(pk=requirement.pk, is_deleted=False).exists()


def test_the_skill_requirement_project_hop_is_what_the_gate_depends_on() -> None:
    """``IsProjectNotArchived`` on the detail routes is only real because of the property.

    ``_get_project_id_from_obj`` walks ``project_id`` / ``project`` / ``predecessor`` and
    returns ``None`` for anything else — and ``has_object_permission`` reads ``None`` as
    permitted. Replacing the property with nothing would unhook every detail-route
    refusal above while leaving the permission class in place and the diff looking inert.
    """
    from trueppm_api.apps.access.permissions import _get_project_id_from_obj

    assert hasattr(TaskSkillRequirement, "project_id")
    calendar = Calendar.objects.create(name="Hop")
    project = Project.objects.create(name="Hop", start_date=date(2026, 3, 1), calendar=calendar)
    requirement = TaskSkillRequirement.objects.create(
        task=Task.objects.create(project=project, name="T", duration=1),
        skill=Skill.objects.create(name="Rust"),
    )
    assert _get_project_id_from_obj(requirement) == project.pk


# ---------------------------------------------------------------------------
# `@api_view` function views: the declaration could never fire
# ---------------------------------------------------------------------------


def test_triggering_a_recalculation_on_an_archived_project_is_refused(
    client: APIClient, archived: Project
) -> None:
    """`trigger_schedule` DECLARED `IsProjectNotArchived` the whole time (#2745 shape).

    The route spells the project ``pk`` and the generated ``WrappedAPIView`` declares no
    ``project_url_kwarg``, so ``has_permission`` resolved nothing and returned True — and
    DRF never calls ``has_object_permission`` on a function view.
    """
    _task(archived)
    resp = client.post(f"/api/v1/projects/{archived.pk}/schedule/")
    assert resp.status_code == 403, resp.data
    assert resp.json()["detail"] == ARCHIVED_DETAIL


def test_triggering_a_recalculation_on_a_live_project_still_works(
    client: APIClient, live: Project
) -> None:
    _task(live)
    resp = client.post(f"/api/v1/projects/{live.pk}/schedule/")
    assert resp.status_code == 202, resp.data
    assert resp.json()["queued"] is True


def test_running_monte_carlo_on_an_archived_project_is_refused(
    client: APIClient, archived: Project
) -> None:
    _task(archived)
    resp = client.post(f"/api/v1/projects/{archived.pk}/monte-carlo/", {}, format="json")
    assert resp.status_code == 403, resp.data
    assert resp.json()["detail"] == ARCHIVED_DETAIL


def test_running_monte_carlo_on_a_live_project_still_works(
    client: APIClient, live: Project
) -> None:
    _task(live)
    resp = client.post(f"/api/v1/projects/{live.pk}/monte-carlo/", {}, format="json")
    assert resp.status_code == 200, resp.data


# ---------------------------------------------------------------------------
# Project webhooks — no lifecycle gate at all before this
# ---------------------------------------------------------------------------


def _webhook(project: Project, user: Any) -> Webhook:
    return Webhook.objects.create(
        project=project,
        url="https://example.com/hook",
        secret="s" * 16,
        events=["task.created"],
        created_by=user,
    )


def test_creating_a_webhook_on_an_archived_project_is_refused(
    client: APIClient, archived: Project
) -> None:
    resp = client.post(
        f"/api/v1/projects/{archived.pk}/webhooks/",
        {"url": "https://example.com/h", "events": ["task.created"]},
        format="json",
    )
    assert resp.status_code == 403, resp.data
    assert Webhook.objects.filter(project=archived).count() == 0


def test_creating_a_webhook_on_a_live_project_still_works(client: APIClient, live: Project) -> None:
    resp = client.post(
        f"/api/v1/projects/{live.pk}/webhooks/",
        {"url": "https://example.com/h", "events": ["task.created"]},
        format="json",
    )
    assert resp.status_code == 201, resp.data
    assert Webhook.objects.filter(project=live).count() == 1


def test_deleting_a_webhook_on_an_archived_project_is_refused(
    client: APIClient, archived: Project, owner: Any
) -> None:
    """Doubly interesting: `destroy` is the action name the old bypass matched."""
    hook = _webhook(archived, owner)
    resp = client.delete(f"/api/v1/projects/{archived.pk}/webhooks/{hook.pk}/")
    assert resp.status_code == 403, resp.data
    assert Webhook.objects.filter(pk=hook.pk).exists()


def test_deleting_a_webhook_on_a_live_project_still_works(
    client: APIClient, live: Project, owner: Any
) -> None:
    hook = _webhook(live, owner)
    resp = client.delete(f"/api/v1/projects/{live.pk}/webhooks/{hook.pk}/")
    assert resp.status_code == 204, resp.data
    assert not Webhook.objects.filter(pk=hook.pk).exists()


def test_reading_a_webhook_on_an_archived_project_still_works(
    client: APIClient, archived: Project, owner: Any
) -> None:
    """Archived is read-only, not unreadable — the classic over-gating failure."""
    hook = _webhook(archived, owner)
    resp = client.get(f"/api/v1/projects/{archived.pk}/webhooks/{hook.pk}/")
    assert resp.status_code == 200, resp.data


# ---------------------------------------------------------------------------
# Git automation config + the unauthenticated receiver
# ---------------------------------------------------------------------------


def test_toggling_git_automation_on_an_archived_project_is_refused(
    client: APIClient, archived: Project
) -> None:
    url = reverse("git-automation-config", kwargs={"project_pk": str(archived.pk)})
    resp = client.put(url, {"enabled": True}, format="json")
    assert resp.status_code == 403, resp.data
    assert not BoardAutomation.objects.filter(project=archived, enabled=True).exists()


def test_toggling_git_automation_on_a_live_project_still_works(
    client: APIClient, live: Project
) -> None:
    url = reverse("git-automation-config", kwargs={"project_pk": str(live.pk)})
    resp = client.put(url, {"enabled": True}, format="json")
    assert resp.status_code == 200, resp.data
    assert BoardAutomation.objects.get(project=live).enabled is True


def test_reading_git_automation_config_on_an_archived_project_still_works(
    client: APIClient, archived: Project
) -> None:
    url = reverse("git-automation-config", kwargs={"project_pk": str(archived.pk)})
    assert client.get(url).status_code == 200


def test_rotating_the_webhook_secret_on_an_archived_project_is_refused(
    client: APIClient, archived: Project
) -> None:
    url = reverse("git-automation-rotate-secret", kwargs={"project_pk": str(archived.pk)})
    resp = client.post(url)
    assert resp.status_code == 403, resp.data


def test_rotating_the_webhook_secret_on_a_live_project_still_works(
    client: APIClient, live: Project
) -> None:
    url = reverse("git-automation-rotate-secret", kwargs={"project_pk": str(live.pk)})
    resp = client.post(url)
    assert resp.status_code == 201, resp.data
    assert resp.json()["secret"]


def _signed_github_post(project: Project, secret: str) -> Any:
    body = json.dumps(
        {"action": "opened", "pull_request": {"html_url": "https://github.com/a/b/pull/1"}}
    ).encode()
    sig = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    url = reverse("git-webhook", kwargs={"project_pk": str(project.pk)})
    return APIClient().post(
        url,
        data=body,
        content_type="application/json",
        HTTP_X_GITHUB_EVENT="pull_request",
        HTTP_X_HUB_SIGNATURE_256=sig,
        HTTP_X_GITHUB_DELIVERY=str(uuid.uuid4()),
    )


def test_the_git_receiver_refuses_an_archived_project_as_a_bare_404(
    archived: Project, owner: Any
) -> None:
    """The refusal must be indistinguishable from every other pre-verification refusal.

    A permission class here would answer 403, which publishes admin-only state (this
    project exists, has automation, and is archived) to an unauthenticated caller holding
    only the project UUID — re-opening the disclosure #2881 closed. The reason is still
    recorded where an Owner/Admin can read it.
    """
    secret = "top-secret-token"
    automation = BoardAutomation.objects.create(project=archived, enabled=True)
    automation.set_secret(secret)
    automation.configured_by = owner
    automation.save()

    resp = _signed_github_post(archived, secret)
    assert resp.status_code == 404
    assert resp.json() == {"detail": "Not found."}

    automation.refresh_from_db()
    assert automation.last_refusal_outcome == "project_archived"
    assert automation.last_delivery_outcome == "", "an archived refusal is not a delivery"


def test_the_git_receiver_still_delivers_for_a_live_project(live: Project, owner: Any) -> None:
    secret = "top-secret-token"
    automation = BoardAutomation.objects.create(project=live, enabled=True)
    automation.set_secret(secret)
    automation.configured_by = owner
    automation.save()

    resp = _signed_github_post(live, secret)
    assert resp.status_code == 200, resp.content
    automation.refresh_from_db()
    assert automation.last_refusal_outcome != "project_archived"


# ---------------------------------------------------------------------------
# Token-authenticated CI ingest
# ---------------------------------------------------------------------------


def _ci_client(project: Project, minter: Any) -> APIClient:
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    ProjectApiToken.objects.create(
        project=project,
        name="ci",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=minter,
    )
    api = APIClient()
    api.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return api


def test_ci_acceptance_ingest_into_an_archived_project_is_refused(
    archived: Project, owner: Any, client: APIClient
) -> None:
    task = _task(archived, "Story")
    criterion = AcceptanceCriterion.objects.create(task=task, text="AC", met=False, position=0)
    resp = _ci_client(archived, owner).post(
        f"/api/v1/projects/{archived.pk}/acceptance-results/",
        {"results": [{"criterion_id": str(criterion.pk), "passed": True}]},
        format="json",
    )
    assert resp.status_code == 403, resp.data
    criterion.refresh_from_db()
    assert criterion.met is False, "the verdict was applied despite the refusal"


def test_ci_acceptance_ingest_into_a_live_project_still_works(
    live: Project, owner: Any, client: APIClient
) -> None:
    task = _task(live, "Story")
    criterion = AcceptanceCriterion.objects.create(task=task, text="AC", met=False, position=0)
    resp = _ci_client(live, owner).post(
        f"/api/v1/projects/{live.pk}/acceptance-results/",
        {"results": [{"criterion_id": str(criterion.pk), "passed": True}]},
        format="json",
    )
    assert resp.status_code == 200, resp.data
    criterion.refresh_from_db()
    assert criterion.met is True


# ---------------------------------------------------------------------------
# Cross-project slip conflict — the object carries no project FK
# ---------------------------------------------------------------------------


def _conflict(project: Project) -> CrossProjectSlipConflict:
    task = _task(project, "Downstream", wbs_path="1")
    sprint = Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 3, 2),
        finish_date=date(2026, 3, 13),
        state=SprintState.ACTIVE,
    )
    return CrossProjectSlipConflict.objects.create(
        sprint=sprint,
        task=task,
        pushed_to=date(2026, 3, 20),
        resolution=SlipConflictResolution.UNRESOLVED,
    )


def test_acknowledging_a_slip_conflict_in_an_archived_project_is_refused(
    client: APIClient, archived: Project
) -> None:
    conflict = _conflict(archived)
    resp = client.post(f"/api/v1/slip-conflicts/{conflict.pk}/acknowledge/")
    assert resp.status_code == 403, resp.data
    conflict.refresh_from_db()
    assert conflict.acknowledged_at is None


def test_acknowledging_a_slip_conflict_in_a_live_project_still_works(
    client: APIClient, live: Project
) -> None:
    conflict = _conflict(live)
    resp = client.post(f"/api/v1/slip-conflicts/{conflict.pk}/acknowledge/")
    assert resp.status_code == 200, resp.data
    conflict.refresh_from_db()
    assert conflict.acknowledged_at is not None


# ---------------------------------------------------------------------------
# The exemptions — the pair inverts: archived must still SUCCEED
# ---------------------------------------------------------------------------


def test_a_member_can_still_change_notification_preferences_on_an_archived_project(
    client: APIClient, archived: Project
) -> None:
    """Exempt by design: this writes the caller's own routing row, not project state.

    An archived project still emits notifications, so freezing this would leave every
    member stuck with whatever settings they had at the moment it was archived.
    """
    resp = client.patch(
        f"/api/v1/projects/{archived.pk}/notification-preferences/",
        {"matrix": {}},
        format="json",
    )
    assert resp.status_code == 200, resp.data


def test_an_admin_can_still_revoke_a_share_link_on_an_archived_project(
    client: APIClient, archived: Project, owner: Any
) -> None:
    """Exempt by design: an archived project's share links keep serving.

    ``_serve_public_share`` 410s a link whose project is in Trash, not one whose project
    is archived — so gating revoke would leave an Admin watching a live public link on a
    frozen plan with no way to kill it. Minting one IS gated.
    """
    from trueppm_api.apps.projects.models import ShareLink

    link = ShareLink.objects.create(project=archived, created_by=owner)
    resp = client.post(f"/api/v1/projects/{archived.pk}/share-links/{link.pk}/revoke/")
    assert resp.status_code == 200, resp.data
    link.refresh_from_db()
    assert link.revoked_at is not None


# ---------------------------------------------------------------------------
# Revocation must survive archiving — the over-gate the gates caught
# ---------------------------------------------------------------------------
#
# Scoping the `destroy` bypass to ProjectViewSet closed every project-scoped DELETE at
# once, which is right for a task and wrong for a credential. These three routes take
# access AWAY, and an archived project keeps serving what they revoke: its share links
# still resolve, its API tokens still read, its members still have a seat. Closing them
# would leave an admin holding a live grant on a frozen plan with no way to pull it —
# and revoking is Admin-level while unarchiving is Owner-only, so a non-Owner Admin
# could not even work around it.


def test_revoking_a_project_api_token_on_an_archived_project_still_works(
    client: APIClient, archived: Project, owner: Any
) -> None:
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    token = ProjectApiToken.objects.create(
        project=archived,
        name="leaked",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=owner,
    )
    resp = client.delete(f"/api/v1/projects/{archived.pk}/api-tokens/{token.pk}/")
    assert resp.status_code == 204, resp.data
    token.refresh_from_db()
    assert token.revoked_at is not None, "the 204 was returned but the token still works"


def test_minting_a_project_api_token_on_an_archived_project_is_refused(
    client: APIClient, archived: Project
) -> None:
    """The other half of the same class — issuing a credential IS a write."""
    resp = client.post(
        f"/api/v1/projects/{archived.pk}/api-tokens/", {"name": "new"}, format="json"
    )
    assert resp.status_code == 403, resp.data
    assert not ProjectApiToken.objects.filter(project=archived, is_deleted=False).exists()


def test_a_member_can_still_remove_themselves_from_an_archived_project(
    archived: Project, client: APIClient
) -> None:
    """`IsProjectNotArchived` fires in `has_permission`, before `is_self` is known.

    Leaving it on the `destroy` chain therefore closed the "any member may self-remove"
    path the viewset documents — an over-gate the archived contract never intended.
    """
    leaver = User.objects.create_user(username="arch_leaver", password="pw")
    membership = ProjectMembership.objects.create(project=archived, user=leaver, role=Role.MEMBER)
    api = APIClient()
    api.force_authenticate(user=leaver)
    resp = api.delete(f"/api/v1/projects/{archived.pk}/members/{membership.pk}/")
    assert resp.status_code == 204, resp.data
    membership.refresh_from_db()
    assert membership.is_deleted is True


def test_removing_another_member_from_an_archived_project_is_still_refused(
    client: APIClient, archived: Project
) -> None:
    """The exemption is scoped to self-removal; roster edits stay frozen."""
    other = User.objects.create_user(username="arch_other", password="pw")
    membership = ProjectMembership.objects.create(project=archived, user=other, role=Role.MEMBER)
    resp = client.delete(f"/api/v1/projects/{archived.pk}/members/{membership.pk}/")
    assert resp.status_code == 403, resp.data
    membership.refresh_from_db()
    assert membership.is_deleted is False


def test_removing_another_member_from_a_live_project_still_works(
    client: APIClient, live: Project
) -> None:
    other = User.objects.create_user(username="live_other", password="pw")
    membership = ProjectMembership.objects.create(project=live, user=other, role=Role.MEMBER)
    resp = client.delete(f"/api/v1/projects/{live.pk}/members/{membership.pk}/")
    assert resp.status_code == 204, resp.data
    membership.refresh_from_db()
    assert membership.is_deleted is True


# ---------------------------------------------------------------------------
# One more body-resolved create the per-action pass surfaced
# ---------------------------------------------------------------------------


def test_adding_an_acceptance_criterion_in_an_archived_project_is_refused(
    client: APIClient, archived: Project
) -> None:
    task = _task(archived, "Story")
    resp = client.post(
        "/api/v1/acceptance-criteria/",
        {"task": str(task.pk), "text": "AC", "position": 0},
        format="json",
    )
    assert resp.status_code == 403, resp.data
    assert AcceptanceCriterion.objects.filter(task=task).count() == 0


def test_adding_an_acceptance_criterion_in_a_live_project_still_works(
    client: APIClient, live: Project
) -> None:
    task = _task(live, "Story")
    resp = client.post(
        "/api/v1/acceptance-criteria/",
        {"task": str(task.pk), "text": "AC", "position": 0},
        format="json",
    )
    assert resp.status_code == 201, resp.data
    assert AcceptanceCriterion.objects.filter(task=task).count() == 1
