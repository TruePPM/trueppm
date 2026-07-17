"""Tests for project-scoped task labels (ADR-0400, closes #1089).

Covers the catalog CRUD RBAC matrix (member-create, admin-curate), the soft cap,
case-insensitive uniqueness, idempotent attach/detach with the cross-project IDOR
guard, the Task.server_version bump on assignment, the nested pills on TaskSerializer,
and the sync-delta wiring (labels collection + label_ids on the task payload).
"""

from __future__ import annotations

from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Label,
    LabelColor,
    Project,
    Task,
    TaskLabel,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def owner_user(db: object) -> object:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def admin_user(db: object) -> object:
    return User.objects.create_user(username="admin", password="pw")


@pytest.fixture
def member_user(db: object) -> object:
    return User.objects.create_user(username="member", password="pw")


@pytest.fixture
def viewer_user(db: object) -> object:
    return User.objects.create_user(username="viewer", password="pw")


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def owner_client(owner_user: object) -> APIClient:
    return _client(owner_user)


@pytest.fixture
def admin_client(admin_user: object) -> APIClient:
    return _client(admin_user)


@pytest.fixture
def member_client(member_user: object) -> APIClient:
    return _client(member_user)


@pytest.fixture
def viewer_client(viewer_user: object) -> APIClient:
    return _client(viewer_user)


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def memberships(
    project: Project,
    owner_user: object,
    admin_user: object,
    member_user: object,
    viewer_user: object,
) -> None:
    ProjectMembership.objects.create(project=project, user=owner_user, role=Role.OWNER)
    ProjectMembership.objects.create(project=project, user=admin_user, role=Role.ADMIN)
    ProjectMembership.objects.create(project=project, user=member_user, role=Role.MEMBER)
    ProjectMembership.objects.create(project=project, user=viewer_user, role=Role.VIEWER)


@pytest.fixture
def label(project: Project, owner_user: object) -> Label:
    return Label.objects.create(
        project=project, name="tech-debt", color=LabelColor.AMBER, created_by=owner_user
    )


@pytest.fixture
def member_task(project: Project, member_user: object) -> Task:
    # Assigned to the member so IsProjectMemberWriteOrOwn lets them label it.
    return Task.objects.create(
        project=project, name="Refactor auth", duration=5, assignee=member_user
    )


def _no_broadcast() -> object:
    # Label writes broadcast board/task events; patch the emitter so tests don't
    # need a live channel layer (best-effort, ADR-0152 — self-heals via sync).
    return patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")


# ---------------------------------------------------------------------------
# Catalog CRUD RBAC matrix
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestLabelCatalogCrud:
    def test_member_can_create_label(
        self, member_client: APIClient, project: Project, memberships: None
    ) -> None:
        with _no_broadcast():
            r = member_client.post(
                f"/api/v1/projects/{project.pk}/labels/",
                {"name": "needs-design", "color": "purple"},
                format="json",
            )
        assert r.status_code == 201, r.data
        assert r.data["name"] == "needs-design"
        assert r.data["color"] == "purple"
        # Auto-assigned to the end of the palette order.
        assert r.data["position"] == 1

    def test_viewer_cannot_create_label(
        self, viewer_client: APIClient, project: Project, memberships: None
    ) -> None:
        r = viewer_client.post(
            f"/api/v1/projects/{project.pk}/labels/",
            {"name": "blocked", "color": "rose"},
            format="json",
        )
        assert r.status_code == 403

    def test_member_cannot_edit_label(
        self, member_client: APIClient, project: Project, label: Label, memberships: None
    ) -> None:
        # Renaming a shared label changes everyone's board — admin-gated.
        r = member_client.patch(
            f"/api/v1/projects/{project.pk}/labels/{label.pk}/",
            {"name": "renamed"},
            format="json",
        )
        assert r.status_code == 403

    def test_admin_can_edit_label(
        self, admin_client: APIClient, project: Project, label: Label, memberships: None
    ) -> None:
        with _no_broadcast():
            r = admin_client.patch(
                f"/api/v1/projects/{project.pk}/labels/{label.pk}/",
                {"name": "debt", "color": "slate"},
                format="json",
            )
        assert r.status_code == 200, r.data
        label.refresh_from_db()
        assert label.name == "debt"
        assert label.color == LabelColor.SLATE

    def test_member_cannot_delete_label(
        self, member_client: APIClient, project: Project, label: Label, memberships: None
    ) -> None:
        r = member_client.delete(f"/api/v1/projects/{project.pk}/labels/{label.pk}/")
        assert r.status_code == 403

    def test_admin_delete_soft_deletes_and_detaches(
        self,
        admin_client: APIClient,
        project: Project,
        label: Label,
        member_task: Task,
        memberships: None,
    ) -> None:
        TaskLabel.objects.create(task=member_task, label=label)
        with _no_broadcast():
            r = admin_client.delete(f"/api/v1/projects/{project.pk}/labels/{label.pk}/")
        assert r.status_code == 204
        label.refresh_from_db()
        assert label.is_deleted is True
        # The through-rows are hard-deleted so the label stops rendering as a pill.
        assert not TaskLabel.objects.filter(label=label).exists()

    def test_duplicate_name_case_insensitive_rejected(
        self, member_client: APIClient, project: Project, label: Label, memberships: None
    ) -> None:
        with _no_broadcast():
            r = member_client.post(
                f"/api/v1/projects/{project.pk}/labels/",
                {"name": "TECH-DEBT", "color": "blue"},
                format="json",
            )
        assert r.status_code == 400
        assert "name" in r.data

    def test_invalid_color_rejected(
        self, member_client: APIClient, project: Project, memberships: None
    ) -> None:
        r = member_client.post(
            f"/api/v1/projects/{project.pk}/labels/",
            {"name": "weird", "color": "#ff00ff"},
            format="json",
        )
        assert r.status_code == 400
        assert "color" in r.data

    def test_soft_cap_enforced(
        self,
        member_client: APIClient,
        project: Project,
        memberships: None,
        settings: object,
    ) -> None:
        settings.TRUEPPM_LABEL_SOFT_CAP = 1
        Label.objects.create(project=project, name="first", color=LabelColor.TEAL)
        with _no_broadcast():
            r = member_client.post(
                f"/api/v1/projects/{project.pk}/labels/",
                {"name": "second", "color": "green"},
                format="json",
            )
        assert r.status_code == 400
        assert "limit" in str(r.data).lower()

    def test_list_ordered_by_position(
        self, member_client: APIClient, project: Project, memberships: None
    ) -> None:
        Label.objects.create(project=project, name="b", color=LabelColor.BLUE, position=2)
        Label.objects.create(project=project, name="a", color=LabelColor.CYAN, position=1)
        r = member_client.get(f"/api/v1/projects/{project.pk}/labels/")
        assert r.status_code == 200
        names = [row["name"] for row in r.data["results"]]
        assert names == ["a", "b"]

    def test_list_annotates_task_count_excluding_deleted(
        self,
        member_client: APIClient,
        project: Project,
        label: Label,
        member_user: object,
        memberships: None,
    ) -> None:
        # Three tasks carry the label; one is soft-deleted and must not be counted.
        for i in range(3):
            t = Task.objects.create(project=project, name=f"t{i}", duration=1)
            TaskLabel.objects.create(task=t, label=label)
        deleted = Task.objects.create(project=project, name="gone", duration=1, is_deleted=True)
        TaskLabel.objects.create(task=deleted, label=label)
        # A second, unused label reports zero.
        empty = Label.objects.create(project=project, name="unused", color=LabelColor.BLUE)

        r = member_client.get(f"/api/v1/projects/{project.pk}/labels/")
        assert r.status_code == 200
        counts = {row["id"]: row["task_count"] for row in r.data["results"]}
        assert counts[str(label.pk)] == 3
        assert counts[str(empty.pk)] == 0

    def test_task_count_is_read_only_on_create(
        self, member_client: APIClient, project: Project, memberships: None
    ) -> None:
        # A client-supplied task_count is ignored; the response reflects the (zero) annotation.
        with _no_broadcast():
            r = member_client.post(
                f"/api/v1/projects/{project.pk}/labels/",
                {"name": "fresh", "color": LabelColor.BLUE, "task_count": 99},
                format="json",
            )
        assert r.status_code == 201
        assert r.data["task_count"] == 0


# ---------------------------------------------------------------------------
# Assignment: idempotent attach / detach
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestLabelAssignment:
    def _attach_url(self, project: Project, task: Task) -> str:
        return f"/api/v1/projects/{project.pk}/tasks/{task.pk}/labels/"

    def test_member_attach_own_task_bumps_version(
        self,
        member_client: APIClient,
        project: Project,
        member_task: Task,
        label: Label,
        memberships: None,
    ) -> None:
        before = member_task.server_version
        with _no_broadcast():
            r = member_client.post(
                self._attach_url(project, member_task),
                {"label_id": str(label.pk)},
                format="json",
            )
        assert r.status_code == 200, r.data
        assert [row["id"] for row in r.data] == [str(label.pk)]
        assert TaskLabel.objects.filter(task=member_task, label=label).exists()
        member_task.refresh_from_db()
        assert member_task.server_version > before

    def test_attach_is_idempotent(
        self,
        member_client: APIClient,
        project: Project,
        member_task: Task,
        label: Label,
        memberships: None,
    ) -> None:
        url = self._attach_url(project, member_task)
        with _no_broadcast():
            member_client.post(url, {"label_id": str(label.pk)}, format="json")
            member_task.refresh_from_db()
            after_first = member_task.server_version
            r2 = member_client.post(url, {"label_id": str(label.pk)}, format="json")
        assert r2.status_code == 200
        # Exactly one through-row; a re-attach is a no-op that does not churn version.
        assert TaskLabel.objects.filter(task=member_task, label=label).count() == 1
        member_task.refresh_from_db()
        assert member_task.server_version == after_first

    def test_detach_is_idempotent(
        self,
        member_client: APIClient,
        project: Project,
        member_task: Task,
        label: Label,
        memberships: None,
    ) -> None:
        TaskLabel.objects.create(task=member_task, label=label)
        url = f"/api/v1/projects/{project.pk}/tasks/{member_task.pk}/labels/{label.pk}/"
        with _no_broadcast():
            r1 = member_client.delete(url)
            r2 = member_client.delete(url)  # already gone
        assert r1.status_code == 204
        assert r2.status_code == 204
        assert not TaskLabel.objects.filter(task=member_task, label=label).exists()

    def test_cross_project_label_is_idor_guarded(
        self,
        member_client: APIClient,
        project: Project,
        member_task: Task,
        memberships: None,
        calendar: Calendar,
    ) -> None:
        other = Project.objects.create(name="Beta", start_date=date(2026, 4, 1), calendar=calendar)
        foreign_label = Label.objects.create(project=other, name="x", color=LabelColor.ROSE)
        with _no_broadcast():
            r = member_client.post(
                self._attach_url(project, member_task),
                {"label_id": str(foreign_label.pk)},
                format="json",
            )
        assert r.status_code == 404
        assert not TaskLabel.objects.filter(task=member_task, label=foreign_label).exists()

    def test_viewer_cannot_attach(
        self,
        viewer_client: APIClient,
        project: Project,
        member_task: Task,
        label: Label,
        memberships: None,
    ) -> None:
        r = viewer_client.post(
            self._attach_url(project, member_task),
            {"label_id": str(label.pk)},
            format="json",
        )
        assert r.status_code == 403

    def test_member_cannot_attach_to_unassigned_task(
        self,
        member_client: APIClient,
        project: Project,
        label: Label,
        memberships: None,
    ) -> None:
        # Not assigned to the member → can_user_edit_task is False → 403.
        foreign_task = Task.objects.create(project=project, name="Someone else's", duration=3)
        r = member_client.post(
            self._attach_url(project, foreign_task),
            {"label_id": str(label.pk)},
            format="json",
        )
        assert r.status_code == 403

    def test_attach_broadcasts_task_updated_labels(
        self,
        member_client: APIClient,
        project: Project,
        member_task: Task,
        label: Label,
        memberships: None,
        django_capture_on_commit_callbacks: Any,
    ) -> None:
        # The broadcast is deferred to transaction.on_commit (ADR-0152); capture and
        # run the callbacks (the inner cm exits first, so the patch is still active)
        # so the assertion sees the emit under the test transaction.
        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_task_updated") as mock_broadcast,
            django_capture_on_commit_callbacks(execute=True),
        ):
            member_client.post(
                self._attach_url(project, member_task),
                {"label_id": str(label.pk)},
                format="json",
            )
        assert mock_broadcast.called
        _, kwargs = mock_broadcast.call_args
        assert kwargs["changed_fields"] == ["labels"]
        assert kwargs["task_id"] == str(member_task.pk)


# ---------------------------------------------------------------------------
# Nested pills on the task read + sync-delta wiring
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestLabelReadSurfaces:
    def test_task_serializer_includes_nested_labels(
        self,
        owner_client: APIClient,
        project: Project,
        member_task: Task,
        label: Label,
        memberships: None,
    ) -> None:
        TaskLabel.objects.create(task=member_task, label=label)
        r = owner_client.get(f"/api/v1/tasks/{member_task.pk}/")
        assert r.status_code == 200
        assert [pill["name"] for pill in r.data["labels"]] == ["tech-debt"]
        assert r.data["labels"][0]["color"] == "amber"

    def test_sync_delta_includes_labels_and_label_ids(
        self,
        owner_client: APIClient,
        project: Project,
        member_task: Task,
        label: Label,
        memberships: None,
    ) -> None:
        # Attach so the task's server_version bumps and the join is reflected.
        member_task.labels.add(label)
        member_task.save(known_exists=True, update_fields=["server_version"])
        r = owner_client.get(f"/api/v1/projects/{project.pk}/sync/?since=0")
        assert r.status_code == 200
        changes = r.data["changes"]
        # The label catalog syncs as its own collection. With since=0 the rows land
        # in the "updated" bucket (WatermelonDB merges created + updated identically).
        assert "labels" in changes
        label_rows = changes["labels"]["created"] + changes["labels"]["updated"]
        label_ids = {row["id"] for row in label_rows}
        assert str(label.pk) in label_ids
        # The assignment rides the task payload's label_ids array.
        task_rows = changes["tasks"]["created"] + changes["tasks"].get("updated", [])
        target = next(row for row in task_rows if row["id"] == str(member_task.pk))
        assert str(label.pk) in target["label_ids"]
