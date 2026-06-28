"""Tests for the program backlog (ADR-0069 Erratum, #733 / #737 / #739).

Covers:
- #733 model: defaults, server_version bump, soft-delete tombstone, FK cascade,
  enum validation, sync-readiness (VersionedModel contract).
- #737 endpoints: program-scoped list + item_type/status/tags filters; CRUD
  permission matrix; archive PATCH vs the rejected direct-PULLED PATCH; the
  pull action (happy path, never-a-sprint, RBAC on program + target project,
  cross-program rejection, double-pull idempotency); project-backlog read via
  the existing Task filters; post-delete rollback to PROPOSED; the task.created
  webhook fired on pull and suppressed on a rolled-back pull (#752).
- #739 trigram search: fuzzy match, similarity ordering, combines with filters,
  empty-q no-op, program scoping (no cross-program leakage).
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    BacklogItem,
    BacklogItemStatus,
    BacklogItemType,
    Calendar,
    Program,
    Project,
    Task,
    TaskStatus,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def owner(db: object) -> object:
    """Program OWNER who is deliberately NOT a member of the target project."""
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def member(db: object) -> object:
    """Program MEMBER who is also a MEMBER on the target project (can pull)."""
    return User.objects.create_user(username="member", password="pw")


@pytest.fixture
def viewer(db: object) -> object:
    return User.objects.create_user(username="viewer", password="pw")


@pytest.fixture
def stranger(db: object) -> object:
    return User.objects.create_user(username="stranger", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def program(owner: object, member: object, viewer: object) -> Program:
    program = Program.objects.create(name="Phase 2")
    ProgramMembership.objects.create(program=program, user=owner, role=Role.OWNER)
    ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    ProgramMembership.objects.create(program=program, user=viewer, role=Role.VIEWER)
    return program


@pytest.fixture
def project(program: Program, calendar: Calendar, member: object) -> Project:
    project = Project.objects.create(
        name="Build", start_date=date(2026, 4, 1), calendar=calendar, program=program
    )
    # `member` is project MEMBER (can be a pull target); `owner` is intentionally not.
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    return project


def _item(program: Program, **overrides: object) -> BacklogItem:
    kwargs: dict[str, object] = {
        "program": program,
        "title": "Single sign-on",
        "description": "Allow SSO login",
        "item_type": BacklogItemType.FEATURE,
    }
    kwargs.update(overrides)
    return BacklogItem.objects.create(**kwargs)


def _list_payload(resp: object) -> list:
    data = resp.data  # type: ignore[attr-defined]
    return data["results"] if isinstance(data, dict) and "results" in data else data


# ---------------------------------------------------------------------------
# #733 — model
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_model_defaults(program: Program) -> None:
    item = _item(program, item_type=BacklogItemType.TASK)
    assert item.status == BacklogItemStatus.PROPOSED
    assert item.item_type == BacklogItemType.TASK
    assert item.tags == []
    assert item.pulled_task is None
    # INSERT starts server_version at 1 so the sync delta can find it (since=0).
    assert item.server_version == 1


@pytest.mark.django_db
def test_server_version_bumps_on_save(program: Program) -> None:
    item = _item(program)
    first = item.server_version
    item.title = "SSO (revised)"
    item.save()
    item.refresh_from_db()
    assert item.server_version > first


@pytest.mark.django_db
def test_soft_delete_sets_tombstone(program: Program) -> None:
    item = _item(program)
    item.soft_delete()
    item.refresh_from_db()
    assert item.is_deleted is True
    assert item.deleted_version == item.server_version


@pytest.mark.django_db
def test_program_delete_cascades_backlog_items(program: Program) -> None:
    item = _item(program)
    # Memberships PROTECT the program; remove them, then a hard delete cascades
    # the program-owned backlog items (ADR-0070 cascade summary).
    ProgramMembership.objects.filter(program=program).delete()
    program.delete()
    assert not BacklogItem.objects.filter(pk=item.pk).exists()


# ---------------------------------------------------------------------------
# #737 — list + filters
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_list_empty_for_new_program(owner: object, program: Program) -> None:
    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/backlog-items/")
    assert resp.status_code == 200
    assert _list_payload(resp) == []


@pytest.mark.django_db
def test_list_defaults_to_proposed_only(owner: object, program: Program) -> None:
    _item(program, title="Proposed one")
    _item(program, title="Archived one", status=BacklogItemStatus.ARCHIVED)
    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/backlog-items/")
    titles = [i["title"] for i in _list_payload(resp)]
    assert titles == ["Proposed one"]


@pytest.mark.django_db
def test_list_filter_by_item_type_and_status_and_tags(owner: object, program: Program) -> None:
    _item(program, title="Epic A", item_type=BacklogItemType.EPIC, tags=["auth"])
    _item(program, title="Story B", item_type=BacklogItemType.STORY, tags=["ui"])
    base = f"/api/v1/programs/{program.pk}/backlog-items/"

    by_type = _client(owner).get(base, {"item_type": "epic"})
    assert [i["title"] for i in _list_payload(by_type)] == ["Epic A"]

    by_tag = _client(owner).get(base, {"tags": "ui"})
    assert [i["title"] for i in _list_payload(by_tag)] == ["Story B"]

    _item(program, title="Archived", status=BacklogItemStatus.ARCHIVED)
    by_status = _client(owner).get(base, {"status": "archived"})
    assert [i["title"] for i in _list_payload(by_status)] == ["Archived"]


@pytest.mark.django_db
def test_list_scoped_to_program(owner: object, program: Program, calendar: Calendar) -> None:
    other = Program.objects.create(name="Other")
    ProgramMembership.objects.create(program=other, user=owner, role=Role.OWNER)
    _item(program, title="Mine")
    _item(other, title="Theirs")
    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/backlog-items/")
    assert [i["title"] for i in _list_payload(resp)] == ["Mine"]


@pytest.mark.django_db
def test_list_blocks_non_member(stranger: object, program: Program) -> None:
    resp = _client(stranger).get(f"/api/v1/programs/{program.pk}/backlog-items/")
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# #737 — create / update / delete permission matrix
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_member_can_create_sets_created_by_and_proposed(member: object, program: Program) -> None:
    resp = _client(member).post(
        f"/api/v1/programs/{program.pk}/backlog-items/",
        {"title": "New feature", "item_type": "feature", "status": "archived"},
        format="json",
    )
    assert resp.status_code == 201
    item = BacklogItem.objects.get(pk=resp.data["id"])
    # status is forced to PROPOSED on create regardless of payload.
    assert item.status == BacklogItemStatus.PROPOSED
    assert item.created_by_id == member.pk  # type: ignore[attr-defined]


@pytest.mark.django_db
def test_viewer_cannot_create(viewer: object, program: Program) -> None:
    resp = _client(viewer).post(
        f"/api/v1/programs/{program.pk}/backlog-items/",
        {"title": "Nope"},
        format="json",
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_patch_to_archived_allowed_but_pulled_rejected(member: object, program: Program) -> None:
    item = _item(program)
    url = f"/api/v1/programs/{program.pk}/backlog-items/{item.pk}/"

    ok = _client(member).patch(url, {"status": "archived"}, format="json")
    assert ok.status_code == 200
    item.refresh_from_db()
    assert item.status == BacklogItemStatus.ARCHIVED

    bad = _client(member).patch(url, {"status": "pulled"}, format="json")
    assert bad.status_code == 400


@pytest.mark.django_db
def test_destroy_soft_deletes(member: object, program: Program) -> None:
    item = _item(program)
    resp = _client(member).delete(f"/api/v1/programs/{program.pk}/backlog-items/{item.pk}/")
    assert resp.status_code == 204
    item.refresh_from_db()
    assert item.is_deleted is True


# ---------------------------------------------------------------------------
# #737 — pull action
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_pull_happy_path_creates_backlog_task(
    member: object, program: Program, project: Project
) -> None:
    item = _item(program, story_points=5)
    resp = _client(member).post(
        f"/api/v1/programs/{program.pk}/backlog-items/{item.pk}/pull/",
        {"project_id": str(project.pk)},
        format="json",
    )
    assert resp.status_code == 201

    task = Task.objects.get(pk=resp.data["task"]["id"])
    assert task.project_id == project.pk
    assert task.status == TaskStatus.BACKLOG
    assert task.sprint_id is None  # never lands in a sprint
    assert task.name == item.title
    assert task.notes == item.description
    assert task.story_points == 5

    item.refresh_from_db()
    assert item.status == BacklogItemStatus.PULLED
    assert item.pulled_task_id == task.pk
    assert item.pulled_by_id == member.pk  # type: ignore[attr-defined]
    assert item.pulled_at is not None


@pytest.mark.django_db
def test_pull_fires_task_created_webhook(
    member: object,
    program: Program,
    project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """A pull is a real Task-create, so it fires the task.created webhook (#752).

    The service imports ``dispatch_webhooks`` at call time, so patch it on its
    source module; ``django_capture_on_commit_callbacks(execute=True)`` runs the
    deferred ``transaction.on_commit`` dispatch so the mock records the call.
    """
    item = _item(program)
    with (
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = _client(member).post(
            f"/api/v1/programs/{program.pk}/backlog-items/{item.pk}/pull/",
            {"project_id": str(project.pk)},
            format="json",
        )
    assert resp.status_code == 201
    task_id = resp.data["task"]["id"]

    fired = {c.args[1]: c.args[2] for c in mock_dispatch.call_args_list}
    assert "task.created" in fired, mock_dispatch.call_args_list
    payload = fired["task.created"]
    assert payload["id"] == str(task_id)
    assert payload["project"] == str(project.pk)
    assert payload["status"] == TaskStatus.BACKLOG
    # source distinguishes a pull from a board/schedule/sync create (ADR-0065).
    assert payload["source"] == "backlog_pull"


@pytest.mark.django_db
def test_pull_service_broadcasts_task_created_on_commit(
    member: object,
    program: Program,
    project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """The pull service defers a board broadcast so watchers see the item appear.

    The HTTP test above covers the webhook; this pins the service contract
    itself: ``pull_to_project_backlog`` enqueues a
    ``broadcast_board_event(project_id, "task_created", {"id": <task>})`` via
    ``transaction.on_commit`` (the #1359 broadcast-gap guarantee), it fires once,
    and — because it is on_commit — only after the transaction lands. The service
    imports ``broadcast_board_event`` at call time, so patch it on its source
    module.
    """
    from trueppm_api.apps.projects.backlog_services import pull_to_project_backlog

    item = _item(program)
    events: list[tuple[str, dict[str, object]]] = []
    with (
        patch(
            "trueppm_api.apps.sync.broadcast.broadcast_board_event",
            side_effect=lambda _pid, et, payload: events.append((et, payload)),
        ),
        django_capture_on_commit_callbacks(execute=True) as callbacks,
    ):
        task = pull_to_project_backlog(item_id=str(item.pk), project=project, actor=member)
        # Deferred to on_commit: nothing has broadcast yet inside the block.
        assert events == []

    assert callbacks, "expected at least one on_commit callback to be captured"
    assert ("task_created", {"id": str(task.pk)}) in events
    assert [et for et, _ in events].count("task_created") == 1


@pytest.mark.django_db
def test_rejected_pull_fires_no_webhook(
    member: object,
    program: Program,
    calendar: Calendar,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """A cross-program pull rolls back before commit, so no webhook is delivered."""
    other = Program.objects.create(name="Other")
    ProgramMembership.objects.create(program=other, user=member, role=Role.OWNER)
    other_project = Project.objects.create(
        name="Other build", start_date=date(2026, 4, 1), calendar=calendar, program=other
    )
    ProjectMembership.objects.create(project=other_project, user=member, role=Role.MEMBER)
    item = _item(program)

    with (
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = _client(member).post(
            f"/api/v1/programs/{program.pk}/backlog-items/{item.pk}/pull/",
            {"project_id": str(other_project.pk)},
            format="json",
        )
    assert resp.status_code == 400
    mock_dispatch.assert_not_called()


@pytest.mark.django_db
def test_pulled_task_is_in_project_backlog_read(
    member: object, program: Program, project: Project
) -> None:
    """The pull target's backlog is the existing Task list (status=BACKLOG, sprint=none)."""
    item = _item(program)
    _client(member).post(
        f"/api/v1/programs/{program.pk}/backlog-items/{item.pk}/pull/",
        {"project_id": str(project.pk)},
        format="json",
    )
    resp = _client(member).get(
        "/api/v1/tasks/",
        {"project": str(project.pk), "status": "BACKLOG", "sprint": "none"},
    )
    assert resp.status_code == 200
    names = [t["name"] for t in _list_payload(resp)]
    assert item.title in names


@pytest.mark.django_db
def test_pull_requires_project_membership(
    owner: object, program: Program, project: Project
) -> None:
    # owner has program-write (OWNER) but is NOT a member of the target project.
    item = _item(program)
    resp = _client(owner).post(
        f"/api/v1/programs/{program.pk}/backlog-items/{item.pk}/pull/",
        {"project_id": str(project.pk)},
        format="json",
    )
    assert resp.status_code == 403
    item.refresh_from_db()
    assert item.status == BacklogItemStatus.PROPOSED


@pytest.mark.django_db
def test_pull_viewer_denied(viewer: object, program: Program, project: Project) -> None:
    item = _item(program)
    resp = _client(viewer).post(
        f"/api/v1/programs/{program.pk}/backlog-items/{item.pk}/pull/",
        {"project_id": str(project.pk)},
        format="json",
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_pull_cross_program_project_rejected(
    member: object, program: Program, calendar: Calendar
) -> None:
    # A project that belongs to a different program must not be a valid target.
    other = Program.objects.create(name="Other")
    ProgramMembership.objects.create(program=other, user=member, role=Role.OWNER)
    other_project = Project.objects.create(
        name="Other build", start_date=date(2026, 4, 1), calendar=calendar, program=other
    )
    ProjectMembership.objects.create(project=other_project, user=member, role=Role.MEMBER)
    item = _item(program)

    resp = _client(member).post(
        f"/api/v1/programs/{program.pk}/backlog-items/{item.pk}/pull/",
        {"project_id": str(other_project.pk)},
        format="json",
    )
    assert resp.status_code == 400
    item.refresh_from_db()
    assert item.status == BacklogItemStatus.PROPOSED


@pytest.mark.django_db
def test_pull_missing_project_id(member: object, program: Program) -> None:
    item = _item(program)
    resp = _client(member).post(
        f"/api/v1/programs/{program.pk}/backlog-items/{item.pk}/pull/",
        {},
        format="json",
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_double_pull_is_conflict(member: object, program: Program, project: Project) -> None:
    item = _item(program)
    url = f"/api/v1/programs/{program.pk}/backlog-items/{item.pk}/pull/"
    first = _client(member).post(url, {"project_id": str(project.pk)}, format="json")
    assert first.status_code == 201
    second = _client(member).post(url, {"project_id": str(project.pk)}, format="json")
    assert second.status_code == 409
    # Only one Task was created.
    assert Task.objects.filter(project=project, name=item.title).count() == 1


@pytest.mark.django_db
def test_rollback_resets_item_when_pulled_task_deleted(
    member: object, program: Program, project: Project
) -> None:
    item = _item(program)
    resp = _client(member).post(
        f"/api/v1/programs/{program.pk}/backlog-items/{item.pk}/pull/",
        {"project_id": str(project.pk)},
        format="json",
    )
    task = Task.objects.get(pk=resp.data["task"]["id"])

    # Tasks soft-delete; the post_save receiver restores the item to PROPOSED.
    task.soft_delete()

    item.refresh_from_db()
    assert item.status == BacklogItemStatus.PROPOSED
    assert item.pulled_task_id is None
    assert item.pulled_at is None


# ---------------------------------------------------------------------------
# #739 — trigram fuzzy search
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_search_finds_near_spelling(owner: object, program: Program) -> None:
    # Single-word titles so the whole-string ``%`` similarity clears pg_trgm's
    # 0.3 threshold for a one-character typo ("authentcation" → "Authentication").
    _item(program, title="Authentication")
    _item(program, title="Reporting")
    resp = _client(owner).get(
        f"/api/v1/programs/{program.pk}/backlog-items/", {"q": "authentcation"}
    )
    assert resp.status_code == 200
    titles = [i["title"] for i in _list_payload(resp)]
    assert "Authentication" in titles
    assert "Reporting" not in titles


@pytest.mark.django_db
def test_search_orders_by_similarity(owner: object, program: Program) -> None:
    _item(program, title="Login")
    _item(program, title="Login flow redesign")
    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/backlog-items/", {"q": "Login"})
    titles = [i["title"] for i in _list_payload(resp)]
    # Exact match ranks ahead of the longer, lower-similarity title.
    assert titles[0] == "Login"


@pytest.mark.django_db
def test_search_combines_with_item_type(owner: object, program: Program) -> None:
    _item(program, title="Billing epic", item_type=BacklogItemType.EPIC)
    _item(program, title="Billing story", item_type=BacklogItemType.STORY)
    resp = _client(owner).get(
        f"/api/v1/programs/{program.pk}/backlog-items/",
        {"q": "Billing", "item_type": "epic"},
    )
    titles = [i["title"] for i in _list_payload(resp)]
    assert titles == ["Billing epic"]


@pytest.mark.django_db
def test_empty_q_is_noop(owner: object, program: Program) -> None:
    _item(program, title="Alpha")
    _item(program, title="Beta")
    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/backlog-items/", {"q": ""})
    assert len(_list_payload(resp)) == 2


@pytest.mark.django_db
def test_search_is_program_scoped(owner: object, program: Program) -> None:
    other = Program.objects.create(name="Other")
    ProgramMembership.objects.create(program=other, user=owner, role=Role.OWNER)
    _item(program, title="Shared widget")
    _item(other, title="Shared widget")
    resp = _client(owner).get(
        f"/api/v1/programs/{program.pk}/backlog-items/", {"q": "Shared widget"}
    )
    assert len(_list_payload(resp)) == 1
