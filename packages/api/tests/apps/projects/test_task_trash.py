"""Tests for the task Trash list (#2494, ADR-0689).

Covers GET /tasks/trash/?project=<id> — the durable counterpart to the "Deleted —
Undo" toast:
- `project` is required and must be a UUID (400 otherwise);
- membership scoping: another project's tombstones never leak, mirroring the guard
  `_trashed_task_queryset` already carries for restore;
- restore-root collapsing: a tombstoned is_subtask descendant is folded into its
  tombstoned ancestor's row and reported as `subtree_count`;
- the retention window is TRUEPPM_TOMBSTONE_RETENTION_DAYS (the setting the ADR-0197
  reaper enforces), and `days_remaining` counts down against it;
- `can_restore` is delete-parity (Admin+ or the assignee), matching the POST gate;
- live tasks never appear; the list is capped with an explicit `truncated` flag.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task

User = get_user_model()

TRASH_URL = "/api/v1/tasks/trash/"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(username="trash-owner", password="pw")


@pytest.fixture
def member(db: object) -> Any:
    return User.objects.create_user(username="trash-member", password="pw")


@pytest.fixture
def viewer(db: object) -> Any:
    return User.objects.create_user(username="trash-viewer", password="pw")


@pytest.fixture
def stranger(db: object) -> Any:
    return User.objects.create_user(username="trash-stranger", password="pw")


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def project(owner: Any, member: Any, viewer: Any, calendar: Calendar) -> Project:
    p = Project.objects.create(
        name="Apollo", code="APL", start_date=date(2026, 4, 1), calendar=calendar
    )
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    ProjectMembership.objects.create(project=p, user=member, role=Role.MEMBER)
    ProjectMembership.objects.create(project=p, user=viewer, role=Role.VIEWER)
    return p


def _trash(task: Task, *, when: Any = None) -> Task:
    """Tombstone a task the way perform_destroy does, optionally back-dating it."""
    task.soft_delete()
    if when is not None:
        Task.objects.filter(pk=task.pk).update(deleted_at=when)
        task.refresh_from_db()
    return task


# ---------------------------------------------------------------------------
# Request validation
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_project_param_is_required(owner: Any) -> None:
    res = _client(owner).get(TRASH_URL)
    assert res.status_code == 400
    assert "project" in res.json()["detail"]


@pytest.mark.django_db
def test_project_param_must_be_a_uuid(owner: Any) -> None:
    res = _client(owner).get(TRASH_URL, {"project": "not-a-uuid"})
    assert res.status_code == 400


@pytest.mark.django_db
def test_anonymous_is_rejected(project: Project) -> None:
    res = APIClient().get(TRASH_URL, {"project": str(project.pk)})
    assert res.status_code in (401, 403)


# ---------------------------------------------------------------------------
# Membership scoping — the guard that must not regress
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_does_not_leak_another_projects_tombstones(
    owner: Any, stranger: Any, calendar: Calendar, project: Project
) -> None:
    """A non-member gets an empty list, not the project's trash and not a 403.

    Empty-not-403 is deliberate: the queryset is membership-scoped, so a foreign
    project id matches nothing and never confirms the project exists.
    """
    _trash(Task.objects.create(project=project, name="Secret", duration=1, wbs_path="1"))

    res = _client(stranger).get(TRASH_URL, {"project": str(project.pk)})
    assert res.status_code == 200
    assert res.json()["results"] == []


@pytest.mark.django_db
def test_scoped_to_the_requested_project_only(
    owner: Any, calendar: Calendar, project: Project
) -> None:
    """A member of two projects sees only the one they asked for."""
    other = Project.objects.create(
        name="Zeus", code="ZEU", start_date=date(2026, 4, 1), calendar=calendar
    )
    ProjectMembership.objects.create(project=other, user=owner, role=Role.OWNER)
    _trash(Task.objects.create(project=project, name="Mine", duration=1, wbs_path="1"))
    _trash(Task.objects.create(project=other, name="Theirs", duration=1, wbs_path="1"))

    res = _client(owner).get(TRASH_URL, {"project": str(project.pk)})
    assert [r["name"] for r in res.json()["results"]] == ["Mine"]


# ---------------------------------------------------------------------------
# What is listed
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_live_tasks_are_never_listed(owner: Any, project: Project) -> None:
    Task.objects.create(project=project, name="Alive", duration=1, wbs_path="1")
    res = _client(owner).get(TRASH_URL, {"project": str(project.pk)})
    assert res.json()["results"] == []


@pytest.mark.django_db
def test_lists_a_tombstoned_task_with_its_metadata(owner: Any, project: Project) -> None:
    task = _trash(Task.objects.create(project=project, name="Gone", duration=1, wbs_path="1"))

    res = _client(owner).get(TRASH_URL, {"project": str(project.pk)})
    assert res.status_code == 200
    body = res.json()
    assert body["truncated"] is False
    (row,) = body["results"]
    assert row["id"] == str(task.pk)
    assert row["name"] == "Gone"
    assert row["wbs_path"] == "1"
    assert row["deleted_at"] is not None
    assert row["retention_days"] == 90
    assert row["days_remaining"] == 90
    assert row["subtree_count"] == 0
    assert row["can_restore"] is True


@pytest.mark.django_db
def test_newest_deletion_first(owner: Any, project: Project) -> None:
    now = timezone.now()
    _trash(
        Task.objects.create(project=project, name="Older", duration=1, wbs_path="1"),
        when=now - timedelta(days=5),
    )
    _trash(
        Task.objects.create(project=project, name="Newer", duration=1, wbs_path="2"),
        when=now - timedelta(days=1),
    )

    res = _client(owner).get(TRASH_URL, {"project": str(project.pk)})
    assert [r["name"] for r in res.json()["results"]] == ["Newer", "Older"]


# ---------------------------------------------------------------------------
# Restore-root collapsing
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_tombstoned_subtree_collapses_to_one_restorable_root(owner: Any, project: Project) -> None:
    """One delete reads as one row — restoring the parent brings the subtree back."""
    parent = Task.objects.create(project=project, name="Parent", duration=2, wbs_path="1")
    sub = Task.objects.create(
        project=project, name="Sub", duration=1, wbs_path="1.1", is_subtask=True
    )
    grandsub = Task.objects.create(
        project=project, name="Grandsub", duration=1, wbs_path="1.1.1", is_subtask=True
    )
    for t in (parent, sub, grandsub):
        _trash(t)

    res = _client(owner).get(TRASH_URL, {"project": str(project.pk)})
    (row,) = res.json()["results"]
    assert row["name"] == "Parent"
    assert row["subtree_count"] == 2


@pytest.mark.django_db
def test_a_wbs_child_under_a_tombstoned_parent_folds_into_it(owner: Any, project: Project) -> None:
    """The full subtree rides the restore cascade, so Trash shows one row (#3173).

    Inverted from the ``is_subtask``-only era: a structural child under a tombstoned
    parent *will* come back with it, so listing it separately would offer a Restore
    that does nothing the parent's has not already done.
    """
    parent = Task.objects.create(project=project, name="Parent", duration=2, wbs_path="1")
    wbs_child = Task.objects.create(
        project=project, name="WbsChild", duration=1, wbs_path="1.1", is_subtask=False
    )
    for t in (parent, wbs_child):
        _trash(t)

    res = _client(owner).get(TRASH_URL, {"project": str(project.pk)})
    (row,) = res.json()["results"]
    assert row["name"] == "Parent"
    assert row["subtree_count"] == 1


@pytest.mark.django_db
def test_a_subtask_whose_parent_is_live_is_its_own_root(owner: Any, project: Project) -> None:
    Task.objects.create(project=project, name="Parent", duration=2, wbs_path="1")
    _trash(
        Task.objects.create(
            project=project, name="Sub", duration=1, wbs_path="1.1", is_subtask=True
        )
    )

    res = _client(owner).get(TRASH_URL, {"project": str(project.pk)})
    (row,) = res.json()["results"]
    assert row["name"] == "Sub"


# ---------------------------------------------------------------------------
# Retention window
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_days_remaining_counts_down_against_the_reaper_window(owner: Any, project: Project) -> None:
    _trash(
        Task.objects.create(project=project, name="Aging", duration=1, wbs_path="1"),
        when=timezone.now() - timedelta(days=80),
    )
    res = _client(owner).get(TRASH_URL, {"project": str(project.pk)})
    (row,) = res.json()["results"]
    assert row["days_remaining"] == 10


@pytest.mark.django_db
def test_tombstones_past_the_window_are_omitted(
    owner: Any, project: Project, settings: Any
) -> None:
    """Rows the nightly reaper is already eligible to hard-delete are not offered."""
    settings.TRUEPPM_TOMBSTONE_RETENTION_DAYS = 30
    _trash(
        Task.objects.create(project=project, name="Expired", duration=1, wbs_path="1"),
        when=timezone.now() - timedelta(days=31),
    )
    _trash(
        Task.objects.create(project=project, name="Fresh", duration=1, wbs_path="2"),
        when=timezone.now() - timedelta(days=2),
    )

    res = _client(owner).get(TRASH_URL, {"project": str(project.pk)})
    assert [r["name"] for r in res.json()["results"]] == ["Fresh"]


@pytest.mark.django_db
def test_a_legacy_null_deleted_at_is_retained_indefinitely(owner: Any, project: Project) -> None:
    """The reaper's ``deleted_at__lte`` cutoff can never match NULL — report that."""
    task = Task.objects.create(project=project, name="Legacy", duration=1, wbs_path="1")
    task.soft_delete()
    Task.objects.filter(pk=task.pk).update(deleted_at=None)

    res = _client(owner).get(TRASH_URL, {"project": str(project.pk)})
    (row,) = res.json()["results"]
    assert row["deleted_at"] is None
    assert row["days_remaining"] is None


# ---------------------------------------------------------------------------
# can_restore — delete-parity, not a separate rule
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_viewer_sees_the_list_but_cannot_restore(viewer: Any, project: Project) -> None:
    _trash(Task.objects.create(project=project, name="Gone", duration=1, wbs_path="1"))
    res = _client(viewer).get(TRASH_URL, {"project": str(project.pk)})
    (row,) = res.json()["results"]
    assert row["can_restore"] is False


@pytest.mark.django_db
def test_member_may_restore_only_their_own_assigned_task(member: Any, project: Project) -> None:
    """Exactly the ``IsProjectMemberWriteOrOwn`` DELETE rule — Admin+ or the assignee."""
    mine = Task.objects.create(
        project=project, name="Mine", duration=1, wbs_path="1", assignee=member
    )
    theirs = Task.objects.create(project=project, name="Theirs", duration=1, wbs_path="2")
    for t in (mine, theirs):
        _trash(t)

    res = _client(member).get(TRASH_URL, {"project": str(project.pk)})
    by_name = {r["name"]: r["can_restore"] for r in res.json()["results"]}
    assert by_name == {"Mine": True, "Theirs": False}


@pytest.mark.django_db
def test_can_restore_true_means_the_post_actually_succeeds(owner: Any, project: Project) -> None:
    """The list's promise is enforceable — it and the POST share one predicate."""
    task = _trash(Task.objects.create(project=project, name="Gone", duration=1, wbs_path="1"))
    client = _client(owner)

    (row,) = client.get(TRASH_URL, {"project": str(project.pk)}).json()["results"]
    assert row["can_restore"] is True

    assert client.post(f"/api/v1/tasks/{task.pk}/restore/").status_code == 200
    assert client.get(TRASH_URL, {"project": str(project.pk)}).json()["results"] == []


# ---------------------------------------------------------------------------
# Cap
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_the_cap_is_reported_rather_than_silent(
    owner: Any, project: Project, monkeypatch: pytest.MonkeyPatch
) -> None:
    from trueppm_api.apps.projects import views as project_views

    monkeypatch.setattr(project_views, "_TASK_TRASH_LIMIT", 2)
    now = timezone.now()
    for i in range(3):
        _trash(
            Task.objects.create(project=project, name=f"T{i}", duration=1, wbs_path=str(i + 1)),
            when=now - timedelta(days=i),
        )

    body = _client(owner).get(TRASH_URL, {"project": str(project.pk)}).json()
    assert len(body["results"]) == 2
    assert body["truncated"] is True
