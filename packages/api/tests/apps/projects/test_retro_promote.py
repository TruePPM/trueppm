"""Tests for the retro action item promote / pull-to-sprint flow (ADR-0071).

Endpoints:
  POST /api/v1/sprints/{pk}/retrospective/action-items/{item_pk}/promote/
  POST /api/v1/sprints/{pk}/retrospective/action-items/{item_pk}/pull-to-sprint/
  GET  /api/v1/projects/{pk}/retrospective/carryover/

Plus the soft-delete rollback signal that resets ``promoted_task_id`` when
the originating Task is soft-deleted.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    RetroActionItem,
    Sprint,
    SprintRetro,
    SprintState,
    SuggestionState,
    Task,
    TaskStatus,
    TaskSuggestedAssignee,
)

User = get_user_model()


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def member(project: Project) -> object:
    u = User.objects.create_user(username="member", password="pw")
    ProjectMembership.objects.create(project=project, user=u, role=Role.MEMBER)
    return u


@pytest.fixture
def member_other(project: Project) -> object:
    u = User.objects.create_user(username="other_member", password="pw")
    ProjectMembership.objects.create(project=project, user=u, role=Role.MEMBER)
    return u


@pytest.fixture
def viewer(project: Project) -> object:
    u = User.objects.create_user(username="viewer", password="pw")
    ProjectMembership.objects.create(project=project, user=u, role=Role.VIEWER)
    return u


@pytest.fixture
def scheduler_user(project: Project) -> object:
    u = User.objects.create_user(username="scheduler", password="pw")
    ProjectMembership.objects.create(project=project, user=u, role=Role.SCHEDULER)
    return u


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _retro_with_item(
    project: Project,
    text: str = "Add staging health probe",
    assignee: object | None = None,
    closed: bool = True,
) -> tuple[Sprint, SprintRetro, RetroActionItem]:
    state = SprintState.COMPLETED if closed else SprintState.PLANNED
    sprint = Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=state,
    )
    retro = SprintRetro.objects.create(sprint=sprint, notes="r")
    item = RetroActionItem.objects.create(retro=retro, text=text, assignee=assignee)
    return sprint, retro, item


# ---------------------------------------------------------------------------
# Promote — golden path + idempotency + sovereignty
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_promote_creates_backlog_task_with_sprint_null(project: Project, member: object) -> None:
    sprint, _retro, item = _retro_with_item(project)
    resp = _client(member).post(
        f"/api/v1/sprints/{sprint.pk}/retrospective/action-items/{item.pk}/promote/",
        {},
        format="json",
    )
    assert resp.status_code == 201
    task = Task.objects.get(pk=resp.data["task"]["id"])
    assert task.status == TaskStatus.BACKLOG
    assert task.sprint_id is None
    assert 'source: "retrospective"' in task.notes

    item.refresh_from_db()
    assert item.promoted_task_id == task.pk


@pytest.mark.django_db
def test_promote_sprint_id_in_body_is_silently_ignored(project: Project, member: object) -> None:
    """ADR-0071 §7: sprint sovereignty enforced structurally.

    Even if a client sends ``sprint_id`` in the body, the resulting Task has
    ``sprint=None``. The serializer does not accept the field; it's structurally
    impossible to express "auto-assign to sprint" via this endpoint.
    """
    sprint, _, item = _retro_with_item(project)
    next_planned = Sprint.objects.create(
        project=project,
        name="Next",
        start_date=date(2026, 4, 15),
        finish_date=date(2026, 4, 28),
        state=SprintState.PLANNED,
    )
    resp = _client(member).post(
        f"/api/v1/sprints/{sprint.pk}/retrospective/action-items/{item.pk}/promote/",
        {"sprint_id": str(next_planned.pk), "target_sprint_id": str(next_planned.pk)},
        format="json",
    )
    assert resp.status_code == 201
    task = Task.objects.get(pk=resp.data["task"]["id"])
    assert task.sprint_id is None  # silently ignored — sovereignty preserved


@pytest.mark.django_db
def test_promote_twice_returns_409_with_existing_task_id(project: Project, member: object) -> None:
    sprint, _, item = _retro_with_item(project)
    first = _client(member).post(
        f"/api/v1/sprints/{sprint.pk}/retrospective/action-items/{item.pk}/promote/",
        {},
        format="json",
    )
    assert first.status_code == 201
    first_task_id = first.data["task"]["id"]

    second = _client(member).post(
        f"/api/v1/sprints/{sprint.pk}/retrospective/action-items/{item.pk}/promote/",
        {},
        format="json",
    )
    assert second.status_code == 409
    assert second.data["task_id"] == first_task_id


@pytest.mark.django_db
def test_promote_self_claim_binds_assignee(project: Project, member: object) -> None:
    sprint, _, item = _retro_with_item(project, assignee=member)
    resp = _client(member).post(
        f"/api/v1/sprints/{sprint.pk}/retrospective/action-items/{item.pk}/promote/",
        {},
        format="json",
    )
    assert resp.status_code == 201
    task = Task.objects.get(pk=resp.data["task"]["id"])
    assert task.assignee_id == member.pk
    # No suggestion created for a self-claim.
    assert TaskSuggestedAssignee.objects.filter(task=task).count() == 0


@pytest.mark.django_db
def test_promote_assign_other_creates_pending_suggestion(
    project: Project, member: object, member_other: object
) -> None:
    sprint, _, item = _retro_with_item(project, assignee=member_other)
    resp = _client(member).post(
        f"/api/v1/sprints/{sprint.pk}/retrospective/action-items/{item.pk}/promote/",
        {},
        format="json",
    )
    assert resp.status_code == 201
    task = Task.objects.get(pk=resp.data["task"]["id"])
    assert task.assignee_id is None  # NOT silently assigned
    suggestion = TaskSuggestedAssignee.objects.get(task=task)
    assert suggestion.suggested_user_id == member_other.pk
    assert suggestion.suggested_by_id == member.pk
    assert suggestion.state == SuggestionState.PENDING


@pytest.mark.django_db
def test_promote_requires_member_role(project: Project, viewer: object) -> None:
    sprint, _, item = _retro_with_item(project)
    resp = _client(viewer).post(
        f"/api/v1/sprints/{sprint.pk}/retrospective/action-items/{item.pk}/promote/",
        {},
        format="json",
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Rollback signal
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_soft_delete_promoted_task_resets_promoted_task_id(
    project: Project, member: object
) -> None:
    """ADR-0071 §2 rollback: deleting the promoted Task frees the action item."""
    sprint, _, item = _retro_with_item(project)
    _client(member).post(
        f"/api/v1/sprints/{sprint.pk}/retrospective/action-items/{item.pk}/promote/",
        {},
        format="json",
    )
    item.refresh_from_db()
    task = Task.objects.get(pk=item.promoted_task_id)

    task.soft_delete()

    item.refresh_from_db()
    assert item.promoted_task_id is None


# ---------------------------------------------------------------------------
# Pull-to-sprint — SCHEDULER+ only
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_pull_to_sprint_atomically_promotes_and_assigns(
    project: Project, scheduler_user: object
) -> None:
    sprint, _, item = _retro_with_item(project)
    planned = Sprint.objects.create(
        project=project,
        name="Next",
        start_date=date(2026, 4, 15),
        finish_date=date(2026, 4, 28),
        state=SprintState.PLANNED,
    )
    resp = _client(scheduler_user).post(
        f"/api/v1/sprints/{sprint.pk}/retrospective/action-items/{item.pk}/pull-to-sprint/",
        {"target_sprint_id": str(planned.pk)},
        format="json",
    )
    assert resp.status_code == 200
    task = Task.objects.get(pk=resp.data["task"]["id"])
    assert task.sprint_id == planned.pk
    assert task.status == TaskStatus.BACKLOG


@pytest.mark.django_db
def test_pull_to_sprint_forbidden_for_member(project: Project, member: object) -> None:
    sprint, _, item = _retro_with_item(project)
    planned = Sprint.objects.create(
        project=project,
        name="Next",
        start_date=date(2026, 4, 15),
        finish_date=date(2026, 4, 28),
        state=SprintState.PLANNED,
    )
    resp = _client(member).post(
        f"/api/v1/sprints/{sprint.pk}/retrospective/action-items/{item.pk}/pull-to-sprint/",
        {"target_sprint_id": str(planned.pk)},
        format="json",
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_pull_to_sprint_rejects_non_planned_target(
    project: Project, scheduler_user: object
) -> None:
    sprint, _, item = _retro_with_item(project)
    active = Sprint.objects.create(
        project=project,
        name="Active",
        start_date=date(2026, 4, 15),
        finish_date=date(2026, 4, 28),
        state=SprintState.ACTIVE,
    )
    resp = _client(scheduler_user).post(
        f"/api/v1/sprints/{sprint.pk}/retrospective/action-items/{item.pk}/pull-to-sprint/",
        {"target_sprint_id": str(active.pk)},
        format="json",
    )
    assert resp.status_code == 400
    assert "PLANNED" in resp.data["detail"]


@pytest.mark.django_db
def test_pull_to_sprint_rejects_cross_project(
    project: Project,
    calendar: Calendar,
    scheduler_user: object,
) -> None:
    sprint, _, item = _retro_with_item(project)
    other = Project.objects.create(name="Other", start_date=date(2026, 4, 1), calendar=calendar)
    ProjectMembership.objects.create(project=other, user=scheduler_user, role=Role.SCHEDULER)
    foreign = Sprint.objects.create(
        project=other,
        name="Foreign",
        start_date=date(2026, 4, 15),
        finish_date=date(2026, 4, 28),
        state=SprintState.PLANNED,
    )
    resp = _client(scheduler_user).post(
        f"/api/v1/sprints/{sprint.pk}/retrospective/action-items/{item.pk}/pull-to-sprint/",
        {"target_sprint_id": str(foreign.pk)},
        format="json",
    )
    assert resp.status_code == 404  # cross-project lookup returns 404, not 400


# ---------------------------------------------------------------------------
# Carryover endpoint
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_carryover_returns_unpromoted_items(project: Project, member: object) -> None:
    _retro_with_item(project, text="open item")
    resp = _client(member).get(f"/api/v1/projects/{project.pk}/retrospective/carryover/")
    assert resp.status_code == 200
    assert len(resp.data["items"]) == 1
    assert resp.data["items"][0]["text"] == "open item"
    assert resp.data["items"][0]["promoted_task_id"] is None


@pytest.mark.django_db
def test_carryover_excludes_completed_items(project: Project, member: object) -> None:
    _sprint, _retro, item = _retro_with_item(project)
    task = Task.objects.create(
        project=project,
        name="done",
        duration=1,
        status=TaskStatus.COMPLETE,
    )
    item.promoted_task_id = task.pk
    item.save()
    resp = _client(member).get(f"/api/v1/projects/{project.pk}/retrospective/carryover/")
    assert resp.status_code == 200
    assert resp.data["items"] == []


@pytest.mark.django_db
def test_carryover_includes_promoted_but_not_complete(project: Project, member: object) -> None:
    _sprint, _retro, item = _retro_with_item(project)
    task = Task.objects.create(
        project=project,
        name="open in progress",
        duration=1,
        status=TaskStatus.IN_PROGRESS,
    )
    item.promoted_task_id = task.pk
    item.save()
    resp = _client(member).get(f"/api/v1/projects/{project.pk}/retrospective/carryover/")
    assert resp.status_code == 200
    assert len(resp.data["items"]) == 1
    assert resp.data["items"][0]["promoted_task_id"] == task.pk
    assert resp.data["items"][0]["promoted_task_status"] == TaskStatus.IN_PROGRESS


# ---------------------------------------------------------------------------
# TaskSuggestedAssignee accept / decline / revoke
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_accept_suggestion_binds_assignee(
    project: Project, member: object, member_other: object
) -> None:
    sprint, _, item = _retro_with_item(project, assignee=member_other)
    promote_resp = _client(member).post(
        f"/api/v1/sprints/{sprint.pk}/retrospective/action-items/{item.pk}/promote/",
        {},
        format="json",
    )
    task_id = promote_resp.data["task"]["id"]
    suggestion = TaskSuggestedAssignee.objects.get(task_id=task_id)

    resp = _client(member_other).post(
        f"/api/v1/tasks/{task_id}/suggestions/{suggestion.pk}/accept/",
        {},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data["state"] == SuggestionState.ACCEPTED
    task = Task.objects.get(pk=task_id)
    assert task.assignee_id == member_other.pk


@pytest.mark.django_db
def test_accept_suggestion_forbidden_for_non_target(
    project: Project, member: object, member_other: object
) -> None:
    sprint, _, item = _retro_with_item(project, assignee=member_other)
    promote_resp = _client(member).post(
        f"/api/v1/sprints/{sprint.pk}/retrospective/action-items/{item.pk}/promote/",
        {},
        format="json",
    )
    task_id = promote_resp.data["task"]["id"]
    suggestion = TaskSuggestedAssignee.objects.get(task_id=task_id)

    # member (the suggesting user) tries to accept on behalf of member_other.
    resp = _client(member).post(
        f"/api/v1/tasks/{task_id}/suggestions/{suggestion.pk}/accept/",
        {},
        format="json",
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_decline_suggestion(
    project: Project,
    member: object,
    member_other: object,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    sprint, _, item = _retro_with_item(project, assignee=member_other)
    promote_resp = _client(member).post(
        f"/api/v1/sprints/{sprint.pk}/retrospective/action-items/{item.pk}/promote/",
        {},
        format="json",
    )
    task_id = promote_resp.data["task"]["id"]
    suggestion = TaskSuggestedAssignee.objects.get(task_id=task_id)

    events: list[tuple[str, dict]] = []
    with (
        patch(
            "trueppm_api.apps.sync.broadcast.broadcast_board_event",
            side_effect=lambda pid, et, payload: events.append((et, payload)),
        ),
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = _client(member_other).post(
            f"/api/v1/tasks/{task_id}/suggestions/{suggestion.pk}/decline/",
            {},
            format="json",
        )
    assert resp.status_code == 200
    suggestion.refresh_from_db()
    assert suggestion.state == SuggestionState.DECLINED
    task = Task.objects.get(pk=task_id)
    assert task.assignee_id is None  # no binding on decline
    # A silent state-reconciliation broadcast clears peers' stale "Pending" without
    # exposing the decliner — the psych-safety contract (#1323).
    assert ("suggestion_declined", {"id": str(suggestion.pk), "task_id": str(task_id)}) in events


@pytest.mark.django_db
def test_revoke_suggestion_by_originator(
    project: Project,
    member: object,
    member_other: object,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    sprint, _, item = _retro_with_item(project, assignee=member_other)
    promote_resp = _client(member).post(
        f"/api/v1/sprints/{sprint.pk}/retrospective/action-items/{item.pk}/promote/",
        {},
        format="json",
    )
    task_id = promote_resp.data["task"]["id"]
    suggestion = TaskSuggestedAssignee.objects.get(task_id=task_id)

    events: list[tuple[str, dict]] = []
    with (
        patch(
            "trueppm_api.apps.sync.broadcast.broadcast_board_event",
            side_effect=lambda pid, et, payload: events.append((et, payload)),
        ),
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = _client(member).post(
            f"/api/v1/tasks/{task_id}/suggestions/{suggestion.pk}/revoke/",
            {},
            format="json",
        )
    assert resp.status_code == 200
    suggestion.refresh_from_db()
    assert suggestion.state == SuggestionState.REVOKED
    assert ("suggestion_revoked", {"id": str(suggestion.pk), "task_id": str(task_id)}) in events


@pytest.mark.django_db
def test_revoke_suggestion_forbidden_for_unrelated_member(
    project: Project,
    member: object,
    member_other: object,
) -> None:
    sprint, _, item = _retro_with_item(project, assignee=member_other)
    promote_resp = _client(member).post(
        f"/api/v1/sprints/{sprint.pk}/retrospective/action-items/{item.pk}/promote/",
        {},
        format="json",
    )
    task_id = promote_resp.data["task"]["id"]
    suggestion = TaskSuggestedAssignee.objects.get(task_id=task_id)

    third = User.objects.create_user(username="third", password="pw")
    ProjectMembership.objects.create(project=project, user=third, role=Role.MEMBER)
    resp = _client(third).post(
        f"/api/v1/tasks/{task_id}/suggestions/{suggestion.pk}/revoke/",
        {},
        format="json",
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# #1373 — suggestion actions re-check actor membership at call time. A user
# named as suggested_user / suggested_by who has since lost project membership
# (soft-deleted ProjectMembership) must get 403, not be authorized by the row's
# FK alone.
# ---------------------------------------------------------------------------


def _promote_suggestion(
    project: Project, member: object, member_other: object
) -> tuple[str, TaskSuggestedAssignee]:
    """Promote a retro action item assigned to ``member_other`` and return the
    resulting (task_id, pending suggestion) — suggested_by=member,
    suggested_user=member_other."""
    sprint, _, item = _retro_with_item(project, assignee=member_other)
    promote_resp = _client(member).post(
        f"/api/v1/sprints/{sprint.pk}/retrospective/action-items/{item.pk}/promote/",
        {},
        format="json",
    )
    task_id = promote_resp.data["task"]["id"]
    return task_id, TaskSuggestedAssignee.objects.get(task_id=task_id)


@pytest.mark.django_db
def test_accept_suggestion_forbidden_for_ex_member(
    project: Project, member: object, member_other: object
) -> None:
    task_id, suggestion = _promote_suggestion(project, member, member_other)
    # member_other loses project membership after being named suggested_user.
    ProjectMembership.objects.filter(project=project, user=member_other).update(is_deleted=True)

    resp = _client(member_other).post(
        f"/api/v1/tasks/{task_id}/suggestions/{suggestion.pk}/accept/",
        {},
        format="json",
    )
    assert resp.status_code == 403
    suggestion.refresh_from_db()
    assert suggestion.state == SuggestionState.PENDING  # no state mutation
    assert Task.objects.get(pk=task_id).assignee_id is None  # no assignee binding


@pytest.mark.django_db
def test_decline_suggestion_forbidden_for_ex_member(
    project: Project, member: object, member_other: object
) -> None:
    task_id, suggestion = _promote_suggestion(project, member, member_other)
    ProjectMembership.objects.filter(project=project, user=member_other).update(is_deleted=True)

    resp = _client(member_other).post(
        f"/api/v1/tasks/{task_id}/suggestions/{suggestion.pk}/decline/",
        {},
        format="json",
    )
    assert resp.status_code == 403
    suggestion.refresh_from_db()
    assert suggestion.state == SuggestionState.PENDING


@pytest.mark.django_db
def test_revoke_suggestion_forbidden_for_ex_originator(
    project: Project, member: object, member_other: object
) -> None:
    task_id, suggestion = _promote_suggestion(project, member, member_other)
    # The originator (member, suggested_by) loses membership — losing membership
    # revokes the ability to revoke even a suggestion they created.
    ProjectMembership.objects.filter(project=project, user=member).update(is_deleted=True)

    resp = _client(member).post(
        f"/api/v1/tasks/{task_id}/suggestions/{suggestion.pk}/revoke/",
        {},
        format="json",
    )
    assert resp.status_code == 403
    suggestion.refresh_from_db()
    assert suggestion.state == SuggestionState.PENDING


@pytest.mark.django_db
def test_revoke_suggestion_allowed_for_viewer_originator(
    project: Project, member_other: object
) -> None:
    """Regression guard for the #1373 ``_membership_role`` refactor: a Viewer
    (role ordinal 0, falsy) who originated a suggestion must still be allowed to
    revoke it. The previous ``... or -1`` sentinel collapsed role 0 to a
    non-member and would have 403'd this legitimate originator."""
    # Build a suggestion whose suggested_by is a Viewer, bypassing the view-layer
    # SCHEDULER+ promote gate (we are testing revoke authz, not promote authz).
    viewer_originator = User.objects.create_user(username="viewer_orig", password="pw")
    ProjectMembership.objects.create(project=project, user=viewer_originator, role=Role.VIEWER)
    task = Task.objects.create(project=project, name="T", duration=1, wbs_path="1")
    suggestion = TaskSuggestedAssignee.objects.create(
        task=task,
        suggested_user=member_other,
        suggested_by=viewer_originator,
        state=SuggestionState.PENDING,
    )

    resp = _client(viewer_originator).post(
        f"/api/v1/tasks/{task.pk}/suggestions/{suggestion.pk}/revoke/",
        {},
        format="json",
    )
    assert resp.status_code == 200
    suggestion.refresh_from_db()
    assert suggestion.state == SuggestionState.REVOKED


# ---------------------------------------------------------------------------
# Me/work retro_action_items
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_me_work_includes_pending_suggestions(
    project: Project, member: object, member_other: object
) -> None:
    sprint, _, item = _retro_with_item(project, assignee=member_other)
    _client(member).post(
        f"/api/v1/sprints/{sprint.pk}/retrospective/action-items/{item.pk}/promote/",
        {},
        format="json",
    )
    # member_other is suggested but hasn't accepted yet.
    resp = _client(member_other).get("/api/v1/me/work/")
    assert resp.status_code == 200
    retro_items = resp.data["retro_action_items"]
    suggested = [r for r in retro_items if r["suggestion_state"] == "suggested"]
    assert len(suggested) == 1
    assert suggested[0]["text"] == "Add staging health probe"
    assert suggested[0]["suggested_by_username"] == "member"
