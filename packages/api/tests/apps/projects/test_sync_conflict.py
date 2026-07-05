"""Field-level merge + server-side reorder tests (ADR-0217, #322).

Covers the two-PMs-editing-at-once durability contract: disjoint field edits on a
stale ``server_version`` merge (200) instead of last-writer-wins clobbering the
loser; overlapping edits return a structured 409; and single-item reorder computes
a deterministic dense rank under a row lock.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Risk, RiskStatus, Task, TaskStatus


@pytest.fixture
def user(db: object) -> object:
    User = get_user_model()
    return User.objects.create_user(username="pm1", password="pw")


@pytest.fixture
def client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Std")
    return Project.objects.create(name="Alpha", start_date=date(2026, 3, 2), calendar=cal)


@pytest.fixture
def membership(user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="Design", duration=5, story_points=3)


@pytest.mark.django_db
class TestFieldLevelMerge:
    def _simulate_concurrent_write(self, task: Task, **fields: object) -> int:
        """Apply a server-side write (another writer) and return the new server_version."""
        for k, v in fields.items():
            setattr(task, k, v)
        task.save()
        task.refresh_from_db()
        return task.server_version

    def test_disjoint_edit_merges_200(
        self, client: APIClient, task: Task, membership: ProjectMembership
    ) -> None:
        base = task.server_version
        # Another writer changes `status` (disjoint from our `name` edit).
        self._simulate_concurrent_write(task, status=TaskStatus.IN_PROGRESS)

        r = client.patch(
            f"/api/v1/tasks/{task.pk}/",
            {"name": "Design v2"},
            HTTP_X_BASE_VERSION=str(base),
        )
        assert r.status_code == 200, r.data
        # Both change sets survive: our name AND the concurrent status.
        task.refresh_from_db()
        assert task.name == "Design v2"
        assert task.status == TaskStatus.IN_PROGRESS
        # The header names what the other writer changed so the client reconciles.
        assert "status" in r["X-Merged-Concurrent-Fields"]

    def test_overlapping_edit_conflicts_409(
        self, client: APIClient, task: Task, membership: ProjectMembership
    ) -> None:
        base = task.server_version
        # Another writer changes `name` — the same field we are about to edit.
        self._simulate_concurrent_write(task, name="Their name")

        r = client.patch(
            f"/api/v1/tasks/{task.pk}/",
            {"name": "My name"},
            HTTP_X_BASE_VERSION=str(base),
        )
        assert r.status_code == 409, r.data
        assert r.data["code"] == "sync_conflict"
        assert r.data["conflict_fields"] == ["name"]
        assert r.data["server_value"]["name"] == "Their name"
        assert r.data["client_value"]["name"] == "My name"
        assert r.data["server_version"] == task.server_version
        # The stale write did NOT land — no silent loss of the server value.
        task.refresh_from_db()
        assert task.name == "Their name"

    def test_current_base_version_writes_normally(
        self, client: APIClient, task: Task, membership: ProjectMembership
    ) -> None:
        # base == current server_version → no conflict path, plain write.
        r = client.patch(
            f"/api/v1/tasks/{task.pk}/",
            {"name": "Fresh"},
            HTTP_X_BASE_VERSION=str(task.server_version),
        )
        assert r.status_code == 200
        task.refresh_from_db()
        assert task.name == "Fresh"

    def test_no_base_version_is_lww_backward_compatible(
        self, client: APIClient, task: Task, membership: ProjectMembership
    ) -> None:
        # Without the header, behavior is unchanged (last-writer-wins).
        self._simulate_concurrent_write(task, name="Their name")
        r = client.patch(f"/api/v1/tasks/{task.pk}/", {"name": "My name"})
        assert r.status_code == 200
        task.refresh_from_db()
        assert task.name == "My name"

    def test_merge_applies_on_risk(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        risk = Risk.objects.create(project=project, title="Vendor slip", probability=3, impact=3)
        base = risk.server_version
        # Concurrent writer changes status; we change probability → disjoint.
        risk.status = RiskStatus.CLOSED
        risk.save()
        r = client.patch(
            f"/api/v1/projects/{project.pk}/risks/{risk.pk}/",
            {"probability": 5},
            HTTP_X_BASE_VERSION=str(base),
        )
        assert r.status_code == 200, r.data
        risk.refresh_from_db()
        assert risk.probability == 5
        assert risk.status == RiskStatus.CLOSED


@pytest.mark.django_db
class TestReorderEndpoint:
    def _mk(self, project: Project, name: str, rank: int) -> Task:
        return Task.objects.create(
            project=project,
            name=name,
            duration=1,
            status=TaskStatus.NOT_STARTED,
            priority_rank=rank,
        )

    def test_reorder_before_anchor(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        self._mk(project, "A", 10)
        b = self._mk(project, "B", 20)
        c = self._mk(project, "C", 30)
        # Move C before B → order A, C, B.
        r = client.post(f"/api/v1/tasks/{c.pk}/reorder/", {"before_id": str(b.pk)}, format="json")
        assert r.status_code == 200, r.data
        ranks = {
            t.name: t.priority_rank
            for t in Task.objects.filter(project=project).order_by("priority_rank")
        }
        order = [
            t.name for t in Task.objects.filter(project=project).order_by("priority_rank", "id")
        ]
        assert order == ["A", "C", "B"]
        assert ranks["A"] < ranks["C"] < ranks["B"]

    def test_reorder_to_end(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        a = self._mk(project, "A", 10)
        self._mk(project, "B", 20)
        self._mk(project, "C", 30)
        r = client.post(f"/api/v1/tasks/{a.pk}/reorder/", {"to_end": True}, format="json")
        assert r.status_code == 200, r.data
        order = [
            t.name for t in Task.objects.filter(project=project).order_by("priority_rank", "id")
        ]
        assert order == ["B", "C", "A"]

    def test_sequential_reorders_are_deterministic(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """Two reorders in sequence (the serialized outcome of contention) converge.

        The endpoint locks the sibling group FOR UPDATE, so concurrent drags serialize
        into some sequential order; whatever that order, the final ranks are dense and
        strictly increasing with no duplicate — no crisscross.
        """
        a = self._mk(project, "A", 10)
        b = self._mk(project, "B", 20)
        c = self._mk(project, "C", 30)
        client.post(f"/api/v1/tasks/{c.pk}/reorder/", {"before_id": str(a.pk)}, format="json")
        client.post(f"/api/v1/tasks/{b.pk}/reorder/", {"after_id": str(c.pk)}, format="json")
        ranks = list(
            Task.objects.filter(project=project)
            .order_by("priority_rank")
            .values_list("priority_rank", flat=True)
        )
        assert ranks == sorted(ranks)
        assert len(set(ranks)) == len(ranks)  # strictly dense, no collision

    def test_bad_anchor_400(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        a = self._mk(project, "A", 10)
        # No anchor selector at all.
        r = client.post(f"/api/v1/tasks/{a.pk}/reorder/", {}, format="json")
        assert r.status_code == 400

    def test_viewer_cannot_reorder(self, project: Project) -> None:
        # ADR-0217 §2 RBAC: reorder writes priority_rank, so a Viewer is forbidden.
        User = get_user_model()
        viewer = User.objects.create_user(username="viewer", password="pw")
        ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)
        a = self._mk(project, "A", 10)
        b = self._mk(project, "B", 20)
        vc = APIClient()
        vc.force_authenticate(user=viewer)
        r = vc.post(f"/api/v1/tasks/{a.pk}/reorder/", {"after_id": str(b.pk)}, format="json")
        assert r.status_code == 403
