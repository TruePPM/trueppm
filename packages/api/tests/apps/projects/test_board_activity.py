"""Tests for the board-level activity feed (ADR-0160, #325).

Covers the aggregator over the three sources (HistoricalTask field diffs, sprint
transitions, TaskComment creates), server-side filtering (type / actor / since),
keyset pagination via ``until``, and the RBAC boundary (Viewer+ reads; non-member
403). Cost-field gating is structurally present but has no fields to hide yet (#73).
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    ScopeChangeStatus,
    Sprint,
    SprintScopeChange,
    Task,
    TaskComment,
    TaskStatus,
)

User = get_user_model()
pytestmark = pytest.mark.django_db


# --------------------------------------------------------------------------- #
# Fixtures / helpers
# --------------------------------------------------------------------------- #


@pytest.fixture
def project(db: object) -> Project:
    calendar = Calendar.objects.create(name="Std")
    return Project.objects.create(name="Proj", start_date=date(2026, 1, 1), calendar=calendar)


def _member(project: Project, username: str, role: int) -> Any:
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    return user


@pytest.fixture
def pm(project: Project) -> Any:
    return _member(project, "pm", Role.ADMIN)


@pytest.fixture
def dev(project: Project) -> Any:
    return _member(project, "dev", Role.MEMBER)


@pytest.fixture
def viewer(project: Project) -> Any:
    return _member(project, "viewer", Role.VIEWER)


@pytest.fixture
def outsider(db: object) -> Any:
    return User.objects.create_user(username="outsider", password="pw")


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/board/activity/"


def _save(task: Task, actor: Any) -> None:
    """Save a task attributing the HistoricalTask row to ``actor`` (simple-history)."""
    task._history_user = actor  # type: ignore[attr-defined]
    task.save()


def _types(results: list[dict[str, Any]]) -> list[str]:
    return [e["event_type"] for e in results]


# --------------------------------------------------------------------------- #
# Event sources
# --------------------------------------------------------------------------- #


def test_field_change_surfaces_task_updated_event(project: Project, dev: Any) -> None:
    task = Task.objects.create(project=project, name="Card", duration=5)
    task.status = TaskStatus.IN_PROGRESS
    _save(task, dev)

    body = _client(dev).get(_url(project)).data
    updated = next(e for e in body["results"] if e["event_type"] == "task_updated")
    assert updated["actor"] == "dev"
    assert updated["task_id"] == str(task.pk)
    status_change = next(c for c in updated["changes"] if c["field"] == "status")
    assert status_change["old"] == TaskStatus.NOT_STARTED
    assert status_change["new"] == TaskStatus.IN_PROGRESS


def test_task_creation_surfaces_task_created_event(project: Project, dev: Any) -> None:
    task = Task.objects.create(project=project, name="Card", duration=5)
    body = _client(dev).get(_url(project)).data
    created = next(e for e in body["results"] if e["event_type"] == "task_created")
    assert created["task_id"] == str(task.pk)
    assert created["changes"] == []


def test_comment_surfaces_comment_added_event(project: Project, dev: Any) -> None:
    task = Task.objects.create(project=project, name="Card", duration=5)
    comment = TaskComment.objects.create(task=task, author=dev, body="looks good")

    body = _client(dev).get(_url(project)).data
    added = next(e for e in body["results"] if e["event_type"] == "comment_added")
    assert added["actor"] == "dev"
    assert added["task_id"] == str(task.pk)
    assert added["id"] == f"comment:{comment.pk}"


def test_sprint_assignment_surfaces_entered_sprint_event(project: Project, dev: Any) -> None:
    sprint = Sprint.objects.create(
        project=project, name="S1", start_date=date(2026, 2, 1), finish_date=date(2026, 2, 14)
    )
    task = Task.objects.create(project=project, name="Card", duration=5)
    task.sprint = sprint
    _save(task, dev)

    body = _client(dev).get(_url(project)).data
    entered = next(e for e in body["results"] if e["event_type"] == "entered_sprint")
    assert entered["sprint_id"] == str(sprint.pk)
    sprint_change = entered["changes"][0]
    assert sprint_change["field"] == "sprint"
    assert sprint_change["old"] is None
    assert sprint_change["new"] == "S1"
    # No SprintScopeChange row (pre-activation entry) → status is null, not absent
    # (ADR-0160 Amendment B3, #1264).
    assert entered["scope_change_status"] is None


def _enter_sprint(project: Project, actor: Any) -> tuple[Task, Sprint]:
    sprint = Sprint.objects.create(
        project=project, name="S1", start_date=date(2026, 2, 1), finish_date=date(2026, 2, 14)
    )
    task = Task.objects.create(project=project, name="Card", duration=5)
    task.sprint = sprint
    _save(task, actor)
    return task, sprint


@pytest.mark.parametrize(
    "scope_status",
    [ScopeChangeStatus.PENDING, ScopeChangeStatus.ACCEPTED, ScopeChangeStatus.REJECTED],
)
def test_entered_sprint_surfaces_scope_change_status(
    project: Project, dev: Any, scope_status: str
) -> None:
    """A post-activation injection's accept-gate status rides the entered_sprint event."""
    task, sprint = _enter_sprint(project, dev)
    SprintScopeChange.objects.create(
        task=task, sprint=sprint, subtask_name=task.name, status=scope_status
    )

    body = _client(dev).get(_url(project)).data
    entered = next(e for e in body["results"] if e["event_type"] == "entered_sprint")
    assert entered["scope_change_status"] == scope_status


def test_scope_change_status_latest_row_wins(project: Project, dev: Any) -> None:
    """Re-injection of one task into the same sprint surfaces the latest decision."""
    task, sprint = _enter_sprint(project, dev)
    # Rows created in sequence → auto_now_add added_at is monotonic; the enrichment
    # orders by added_at so the later (accepted) row wins over the earlier (pending) one.
    SprintScopeChange.objects.create(
        task=task, sprint=sprint, subtask_name=task.name, status=ScopeChangeStatus.PENDING
    )
    SprintScopeChange.objects.create(
        task=task, sprint=sprint, subtask_name=task.name, status=ScopeChangeStatus.ACCEPTED
    )

    body = _client(dev).get(_url(project)).data
    entered = next(e for e in body["results"] if e["event_type"] == "entered_sprint")
    assert entered["scope_change_status"] == ScopeChangeStatus.ACCEPTED


def test_scope_change_status_present_and_null_on_non_sprint_events(
    project: Project, dev: Any
) -> None:
    """Every event row carries scope_change_status (null off entered_sprint) — uniform shape."""
    task = Task.objects.create(project=project, name="Card", duration=5)
    task.status = TaskStatus.IN_PROGRESS
    _save(task, dev)

    body = _client(dev).get(_url(project)).data
    updated = next(e for e in body["results"] if e["event_type"] == "task_updated")
    assert "scope_change_status" in updated
    assert updated["scope_change_status"] is None


def test_assignee_change_resolves_to_username(project: Project, pm: Any, dev: Any) -> None:
    task = Task.objects.create(project=project, name="Card", duration=5)
    task.assignee = dev
    _save(task, pm)

    body = _client(pm).get(_url(project)).data
    updated = next(e for e in body["results"] if e["event_type"] == "task_updated")
    change = next(c for c in updated["changes"] if c["field"] == "assignee")
    assert change["old"] is None
    assert change["new"] == "dev"


# --------------------------------------------------------------------------- #
# Filtering (server-side, ADR-0160)
# --------------------------------------------------------------------------- #


def test_filter_by_type(project: Project, dev: Any) -> None:
    task = Task.objects.create(project=project, name="Card", duration=5)
    task.status = TaskStatus.IN_PROGRESS
    _save(task, dev)
    TaskComment.objects.create(task=task, author=dev, body="note")

    body = _client(dev).get(_url(project), {"type": "comment_added"}).data
    assert set(_types(body["results"])) == {"comment_added"}


def test_filter_by_actor(project: Project, pm: Any, dev: Any) -> None:
    task = Task.objects.create(project=project, name="Card", duration=5)
    task.status = TaskStatus.IN_PROGRESS
    _save(task, dev)  # dev's change
    task.status = TaskStatus.REVIEW
    _save(task, pm)  # pm's change

    body = _client(pm).get(_url(project), {"actor": str(dev.pk)}).data
    actors = {e["actor"] for e in body["results"]}
    assert actors == {"dev"}


def test_unknown_type_is_400(project: Project, dev: Any) -> None:
    resp = _client(dev).get(_url(project), {"type": "nonsense"})
    assert resp.status_code == 400


def test_invalid_until_is_400(project: Project, dev: Any) -> None:
    resp = _client(dev).get(_url(project), {"until": "not-a-date"})
    assert resp.status_code == 400


def test_unknown_actor_returns_empty(project: Project, dev: Any) -> None:
    Task.objects.create(project=project, name="Card", duration=5)
    resp = _client(dev).get(_url(project), {"actor": "999999"})
    assert resp.status_code == 200
    assert resp.data["results"] == []


# --------------------------------------------------------------------------- #
# Keyset pagination
# --------------------------------------------------------------------------- #


def test_keyset_pagination_walks_without_overlap(project: Project, dev: Any) -> None:
    task = Task.objects.create(project=project, name="Card", duration=5)
    for s in (TaskStatus.IN_PROGRESS, TaskStatus.REVIEW, TaskStatus.COMPLETE):
        task.status = s
        _save(task, dev)

    first = _client(dev).get(_url(project), {"limit": 2}).data
    assert len(first["results"]) == 2
    assert first["next_until"] is not None

    second = _client(dev).get(_url(project), {"limit": 2, "until": first["next_until"]}).data
    first_ids = {e["id"] for e in first["results"]}
    second_ids = {e["id"] for e in second["results"]}
    assert first_ids.isdisjoint(second_ids)  # no overlap across pages


# --------------------------------------------------------------------------- #
# RBAC boundary
# --------------------------------------------------------------------------- #


def test_viewer_can_read_feed(project: Project, viewer: Any, dev: Any) -> None:
    task = Task.objects.create(project=project, name="Card", duration=5)
    task.status = TaskStatus.IN_PROGRESS
    _save(task, dev)
    resp = _client(viewer).get(_url(project))
    assert resp.status_code == 200
    assert any(e["event_type"] == "task_updated" for e in resp.data["results"])


def test_non_member_is_forbidden(project: Project, outsider: Any) -> None:
    resp = _client(outsider).get(_url(project))
    assert resp.status_code in (403, 404)


def test_member_can_read_feed_on_archived_project(project: Project, dev: Any) -> None:
    """The activity feed stays readable after archiving (#1890) —
    IsProjectNotArchived is deliberately omitted: history/activity is a read-only
    audit surface that must stay accessible after a project is archived."""
    task = Task.objects.create(project=project, name="Card", duration=5)
    task.status = TaskStatus.IN_PROGRESS
    _save(task, dev)
    project.is_archived = True
    project.save(update_fields=["is_archived"])
    resp = _client(dev).get(_url(project))
    assert resp.status_code == 200
    assert any(e["event_type"] == "task_updated" for e in resp.data["results"])


# --------------------------------------------------------------------------- #
# Sprint scope (?sprint=, ADR-0412 #1946)
# --------------------------------------------------------------------------- #


def _sprint(project: Project, name: str = "S1") -> Sprint:
    return Sprint.objects.create(
        project=project, name=name, start_date=date(2026, 2, 1), finish_date=date(2026, 2, 14)
    )


def test_sprint_scope_narrows_to_that_sprints_tasks(project: Project, dev: Any) -> None:
    """?sprint= keeps events for tasks currently in the sprint, drops the rest."""
    sprint = _sprint(project)
    in_sprint = Task.objects.create(project=project, name="In sprint", duration=5, sprint=sprint)
    in_sprint.status = TaskStatus.IN_PROGRESS
    _save(in_sprint, dev)

    out_sprint = Task.objects.create(project=project, name="Not in sprint", duration=5)
    out_sprint.status = TaskStatus.IN_PROGRESS
    _save(out_sprint, dev)

    body = _client(dev).get(_url(project), {"sprint": str(sprint.pk)}).data
    task_ids = {e["task_id"] for e in body["results"]}
    assert task_ids == {str(in_sprint.pk)}


def test_sprint_scope_keeps_removal_visible_in_the_sprint_it_left(
    project: Project, dev: Any
) -> None:
    """An exited_sprint stays visible in the sprint it left even after the task moves on."""
    sprint = _sprint(project)
    task = Task.objects.create(project=project, name="Card", duration=5)
    task.sprint = sprint
    _save(task, dev)  # entered_sprint
    task.sprint = None
    _save(task, dev)  # exited_sprint — task's CURRENT sprint is now None

    body = _client(dev).get(_url(project), {"sprint": str(sprint.pk)}).data
    types = _types(body["results"])
    # Both the entry and the exit reference this sprint (old/new id) — both survive
    # the scope filter even though the task's live sprint_id is now null.
    assert "entered_sprint" in types
    assert "exited_sprint" in types


def test_sprint_scope_composes_with_type_filter(project: Project, dev: Any) -> None:
    sprint = _sprint(project)
    task = Task.objects.create(project=project, name="Card", duration=5, sprint=sprint)
    task.status = TaskStatus.IN_PROGRESS
    _save(task, dev)
    TaskComment.objects.create(task=task, author=dev, body="note")

    body = _client(dev).get(_url(project), {"sprint": str(sprint.pk), "type": "comment_added"}).data
    assert set(_types(body["results"])) == {"comment_added"}


def test_sprint_scope_composes_with_actor_filter(project: Project, pm: Any, dev: Any) -> None:
    sprint = _sprint(project)
    task = Task.objects.create(project=project, name="Card", duration=5, sprint=sprint)
    task.status = TaskStatus.IN_PROGRESS
    _save(task, dev)  # dev
    task.status = TaskStatus.REVIEW
    _save(task, pm)  # pm

    body = _client(pm).get(_url(project), {"sprint": str(sprint.pk), "actor": str(dev.pk)}).data
    assert {e["actor"] for e in body["results"]} == {"dev"}


def test_sprint_scope_paginates_without_overlap(project: Project, dev: Any) -> None:
    sprint = _sprint(project)
    task = Task.objects.create(project=project, name="Card", duration=5, sprint=sprint)
    for s in (TaskStatus.IN_PROGRESS, TaskStatus.REVIEW, TaskStatus.COMPLETE):
        task.status = s
        _save(task, dev)

    first = _client(dev).get(_url(project), {"sprint": str(sprint.pk), "limit": 2}).data
    assert len(first["results"]) == 2
    assert first["next_until"] is not None
    second = (
        _client(dev)
        .get(_url(project), {"sprint": str(sprint.pk), "limit": 2, "until": first["next_until"]})
        .data
    )
    assert {e["id"] for e in first["results"]}.isdisjoint({e["id"] for e in second["results"]})


def test_sprint_scope_never_leaks_internal_keys(project: Project, dev: Any) -> None:
    """The internal _old/_new sprint ids used by the scope filter must not surface."""
    sprint = _sprint(project)
    task = Task.objects.create(project=project, name="Card", duration=5)
    task.sprint = sprint
    _save(task, dev)
    body = _client(dev).get(_url(project), {"sprint": str(sprint.pk)}).data
    for e in body["results"]:
        assert not any(k.startswith("_") for k in e), e


def test_sprint_scope_cross_project_id_is_404(project: Project, dev: Any) -> None:
    other = Project.objects.create(
        name="Other", start_date=date(2026, 1, 1), calendar=project.calendar
    )
    foreign_sprint = _sprint(other, name="Foreign")
    resp = _client(dev).get(_url(project), {"sprint": str(foreign_sprint.pk)})
    assert resp.status_code == 404


def test_sprint_scope_unknown_id_is_404(project: Project, dev: Any) -> None:
    import uuid

    resp = _client(dev).get(_url(project), {"sprint": str(uuid.uuid4())})
    assert resp.status_code == 404


def test_sprint_scope_malformed_id_is_400(project: Project, dev: Any) -> None:
    resp = _client(dev).get(_url(project), {"sprint": "not-a-uuid"})
    assert resp.status_code == 400
