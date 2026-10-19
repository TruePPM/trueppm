"""Cross-project dependency events reach BOTH projects, and a task/project cascade
recalculates and notifies the far side (#4592).

Before the fix ``dependency_created/updated/deleted`` went only to the predecessor's
group, so the successor team's open Schedule and pending-acceptance panel never
updated; and deleting the predecessor task (which cascades to its accepted
cross-project edge) left the successor project's CPM dates constrained by an edge
that no longer exists, with no event.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Dependency, Program, Project, Task
from trueppm_api.apps.projects.tasks import cascade_project_soft_delete
from trueppm_api.apps.scheduling.models import ScheduleRequestReason
from trueppm_api.apps.scheduling.tasks import _run_program_schedule, _run_schedule

# Far-future Monday: the data-date floor must not mask the unconstrained start.
START = date(2030, 3, 4)

CommitCapture = Callable[..., Any]


@pytest.fixture
def owner(db: object) -> Any:
    return get_user_model().objects.create_user(username="owner4592", password="pw")


@pytest.fixture
def client(owner: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=owner)
    return c


@pytest.fixture
def world(owner: Any) -> dict[str, Any]:
    """Program with projects A and B; owner holds OWNER on both; tasks A1 and B1."""
    cal = Calendar.objects.create(name="Standard")
    program = Program.objects.create(name="GA Launch")
    a = Project.objects.create(name="A", start_date=START, calendar=cal, program=program)
    b = Project.objects.create(name="B", start_date=START, calendar=cal, program=program)
    for p in (a, b):
        ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    a1 = Task.objects.create(project=a, name="A1", duration=5)
    b1 = Task.objects.create(project=b, name="B1", duration=2)
    return {"program": program, "a": a, "b": b, "a1": a1, "b1": b1}


def _edge(world: dict[str, Any], *, accepted: bool = True) -> Dependency:
    return Dependency.objects.create(
        predecessor=world["a1"],
        successor=world["b1"],
        dep_type="FS",
        lag=0,
        pending_acceptance=not accepted,
        accepted_at=timezone.now() if accepted else None,
    )


def _events(bcast: Any, event: str) -> list[str]:
    """Project ids a given event type was broadcast to."""
    out = []
    for call in bcast.call_args_list:
        args = call.args
        if len(args) > 1 and args[1] == event:
            out.append(str(args[0]))
    return out


@pytest.mark.django_db
class TestDirectDependencyEndpoints:
    @pytest.mark.parametrize("accepted", [True, False])
    def test_create_update_delete_reach_both_projects(
        self,
        client: APIClient,
        world: dict[str, Any],
        django_capture_on_commit_callbacks: CommitCapture,
        accepted: bool,
    ) -> None:
        a, b = str(world["a"].pk), str(world["b"].pk)
        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as bcast,
            patch("trueppm_api.apps.projects.views._enqueue_recalculate"),
            django_capture_on_commit_callbacks(execute=True),
        ):
            r = client.post(
                "/api/v1/dependencies/",
                {
                    "predecessor": str(world["a1"].pk),
                    "successor": str(world["b1"].pk),
                    "dep_type": "FS",
                },
            )
        assert r.status_code == 201, r.data
        dep_id = r.data["id"]
        if not accepted:
            Dependency.objects.filter(pk=dep_id).update(pending_acceptance=True)
        assert sorted(_events(bcast, "dependency_created")) == sorted([a, b])

        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as bcast,
            patch("trueppm_api.apps.projects.views._enqueue_recalculate"),
            django_capture_on_commit_callbacks(execute=True),
        ):
            r = client.patch(f"/api/v1/dependencies/{dep_id}/", {"lag": 1})
        assert r.status_code == 200, r.data
        assert sorted(_events(bcast, "dependency_updated")) == sorted([a, b])

        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as bcast,
            patch("trueppm_api.apps.projects.views._enqueue_recalculate"),
            django_capture_on_commit_callbacks(execute=True),
        ):
            r = client.delete(f"/api/v1/dependencies/{dep_id}/")
        assert r.status_code == 204
        assert sorted(_events(bcast, "dependency_deleted")) == sorted([a, b])

    def test_same_project_edge_emits_once(
        self,
        client: APIClient,
        world: dict[str, Any],
        django_capture_on_commit_callbacks: CommitCapture,
    ) -> None:
        a2 = Task.objects.create(project=world["a"], name="A2", duration=1)
        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as bcast,
            patch("trueppm_api.apps.projects.views._enqueue_recalculate"),
            django_capture_on_commit_callbacks(execute=True),
        ):
            r = client.post(
                "/api/v1/dependencies/",
                {
                    "predecessor": str(world["a1"].pk),
                    "successor": str(a2.pk),
                    "dep_type": "FS",
                },
            )
            assert r.status_code == 201, r.data
            dep_id = r.data["id"]
            client.patch(f"/api/v1/dependencies/{dep_id}/", {"lag": 1})
            client.delete(f"/api/v1/dependencies/{dep_id}/")
        pid = str(world["a"].pk)
        assert _events(bcast, "dependency_created") == [pid]
        assert _events(bcast, "dependency_updated") == [pid]
        assert _events(bcast, "dependency_deleted") == [pid]

    def test_update_of_accepted_cross_edge_recalcs_both_projects(
        self,
        client: APIClient,
        world: dict[str, Any],
        django_capture_on_commit_callbacks: CommitCapture,
    ) -> None:
        dep = _edge(world)
        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
            patch("trueppm_api.apps.projects.views._enqueue_recalculate") as recalc,
            django_capture_on_commit_callbacks(execute=True),
        ):
            r = client.patch(f"/api/v1/dependencies/{dep.pk}/", {"lag": 1})
        assert r.status_code == 200, r.data
        assert {c.args[0] for c in recalc.call_args_list} == {
            str(world["a"].pk),
            str(world["b"].pk),
        }
        assert all(
            c.kwargs["reason"] == ScheduleRequestReason.CROSS_PROJECT_DEPENDENCY
            for c in recalc.call_args_list
        )


@pytest.mark.django_db
class TestCascadeReachesFarSide:
    def test_task_delete_unconstrains_successor_project(
        self,
        client: APIClient,
        world: dict[str, Any],
        django_capture_on_commit_callbacks: CommitCapture,
    ) -> None:
        """The program's ONLY accepted cross edge is cascaded away by deleting A1:
        escalation no longer fires, so without a B recalc B1 keeps A1's constraint."""
        dep = _edge(world)
        _run_program_schedule(str(world["program"].pk))
        b1 = world["b1"]
        b1.refresh_from_db()
        constrained_start = b1.early_start
        assert constrained_start is not None

        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as bcast,
            patch("trueppm_api.apps.projects.views._enqueue_recalculate"),
            patch("trueppm_api.apps.scheduling.services.enqueue_recalculate") as recalc,
            django_capture_on_commit_callbacks(execute=True),
        ):
            r = client.delete(f"/api/v1/tasks/{world['a1'].pk}/")
        assert r.status_code == 204
        assert Dependency.objects.get(pk=dep.pk).is_deleted
        assert str(world["b"].pk) in {c.args[0] for c in recalc.call_args_list}
        assert _events(bcast, "dependency_deleted") == [str(world["b"].pk)]

        # Run what the enqueued recalc runs: B1 is no longer pushed past A1.
        _run_schedule(str(world["b"].pk))
        b1.refresh_from_db()
        assert b1.early_start is not None
        assert b1.early_start < constrained_start
        assert b1.early_start == START

    def test_pending_edge_cascade_notifies_but_does_not_recalc(
        self,
        client: APIClient,
        world: dict[str, Any],
        django_capture_on_commit_callbacks: CommitCapture,
    ) -> None:
        _edge(world, accepted=False)
        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as bcast,
            patch("trueppm_api.apps.projects.views._enqueue_recalculate"),
            patch("trueppm_api.apps.scheduling.services.enqueue_recalculate") as recalc,
            django_capture_on_commit_callbacks(execute=True),
        ):
            client.delete(f"/api/v1/tasks/{world['a1'].pk}/")
        assert _events(bcast, "dependency_deleted") == [str(world["b"].pk)]
        recalc.assert_not_called()

    def test_summary_delete_reaches_children_cross_edges(
        self,
        client: APIClient,
        world: dict[str, Any],
        django_capture_on_commit_callbacks: CommitCapture,
    ) -> None:
        child = Task.objects.create(
            project=world["a"], name="A1.1", duration=1, wbs_path=f"{world['a1'].wbs_path}.1"
        )
        Dependency.objects.create(
            predecessor=child,
            successor=world["b1"],
            dep_type="FS",
            lag=0,
            pending_acceptance=False,
            accepted_at=timezone.now(),
        )
        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as bcast,
            patch("trueppm_api.apps.projects.views._enqueue_recalculate"),
            patch("trueppm_api.apps.scheduling.services.enqueue_recalculate") as recalc,
            django_capture_on_commit_callbacks(execute=True),
        ):
            client.delete(f"/api/v1/tasks/{world['a1'].pk}/")
        assert _events(bcast, "dependency_deleted") == [str(world["b"].pk)]
        assert {c.args[0] for c in recalc.call_args_list} == {str(world["b"].pk)}

    def test_task_restore_recalcs_and_notifies_far_side(
        self,
        client: APIClient,
        world: dict[str, Any],
        django_capture_on_commit_callbacks: CommitCapture,
    ) -> None:
        dep = _edge(world)
        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
            patch("trueppm_api.apps.projects.views._enqueue_recalculate"),
            patch("trueppm_api.apps.scheduling.services.enqueue_recalculate"),
            django_capture_on_commit_callbacks(execute=True),
        ):
            client.delete(f"/api/v1/tasks/{world['a1'].pk}/")
        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as bcast,
            patch("trueppm_api.apps.projects.views._enqueue_recalculate"),
            patch("trueppm_api.apps.scheduling.services.enqueue_recalculate") as recalc,
            django_capture_on_commit_callbacks(execute=True),
        ):
            r = client.post(f"/api/v1/tasks/{world['a1'].pk}/restore/")
        assert r.status_code == 200, r.data
        assert not Dependency.objects.get(pk=dep.pk).is_deleted
        assert _events(bcast, "dependency_created") == [str(world["b"].pk)]
        assert {c.args[0] for c in recalc.call_args_list} == {str(world["b"].pk)}

    def test_project_trash_cascade_recalcs_surviving_project(
        self,
        world: dict[str, Any],
        django_capture_on_commit_callbacks: CommitCapture,
    ) -> None:
        _edge(world)
        world["a"].soft_delete()
        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as bcast,
            patch("trueppm_api.apps.scheduling.services.enqueue_recalculate") as recalc,
            django_capture_on_commit_callbacks(execute=True),
        ):
            cascade_project_soft_delete(str(world["a"].pk))
        assert _events(bcast, "dependency_deleted") == [str(world["b"].pk)]
        assert {c.args[0] for c in recalc.call_args_list} == {str(world["b"].pk)}


def _patched() -> Any:
    """Patch the broadcast + both recalc seams; yields (bcast, recalc)."""
    from contextlib import ExitStack, contextmanager

    @contextmanager
    def cm() -> Any:
        with ExitStack() as st:
            bcast = st.enter_context(patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"))
            st.enter_context(patch("trueppm_api.apps.projects.views._enqueue_recalculate"))
            recalc = st.enter_context(
                patch("trueppm_api.apps.scheduling.services.enqueue_recalculate")
            )
            yield bcast, recalc

    return cm()


@pytest.mark.django_db
class TestOtherDeleteSurfaces:
    def test_bulk_delete_reaches_far_side(
        self,
        client: APIClient,
        world: dict[str, Any],
        django_capture_on_commit_callbacks: CommitCapture,
    ) -> None:
        dep = _edge(world)
        with _patched() as (bcast, recalc), django_capture_on_commit_callbacks(execute=True):
            r = client.post(
                f"/api/v1/projects/{world['a'].pk}/tasks/bulk/",
                {"operations": [{"op": "delete", "id": str(world["a1"].pk)}]},
                format="json",
            )
        assert r.status_code in (200, 207), r.data
        assert Dependency.objects.get(pk=dep.pk).is_deleted
        assert _events(bcast, "dependency_deleted") == [str(world["b"].pk)]
        assert str(world["b"].pk) in {c.args[0] for c in recalc.call_args_list}

    def test_bulk_rejected_delete_announces_nothing(
        self,
        world: dict[str, Any],
        django_capture_on_commit_callbacks: CommitCapture,
    ) -> None:
        """A delete the caller may not perform must not announce its (live) edge."""
        _edge(world)
        member = get_user_model().objects.create_user(username="m4592", password="pw")
        ProjectMembership.objects.create(project=world["a"], user=member, role=Role.MEMBER)
        c = APIClient()
        c.force_authenticate(user=member)
        with _patched() as (bcast, _recalc), django_capture_on_commit_callbacks(execute=True):
            c.post(
                f"/api/v1/projects/{world['a'].pk}/tasks/bulk/",
                {"operations": [{"op": "delete", "id": str(world["a1"].pk)}]},
                format="json",
            )
        assert _events(bcast, "dependency_deleted") == []

    def test_sync_upload_delete_reaches_far_side(
        self,
        client: APIClient,
        world: dict[str, Any],
        django_capture_on_commit_callbacks: CommitCapture,
    ) -> None:
        import uuid

        dep = _edge(world)
        with _patched() as (bcast, recalc), django_capture_on_commit_callbacks(execute=True):
            r = client.post(
                f"/api/v1/projects/{world['a'].pk}/sync/",
                {
                    "client_batch_id": str(uuid.uuid4()),
                    "changes": {
                        "tasks": {"created": [], "updated": [], "deleted": [str(world["a1"].pk)]}
                    },
                },
                format="json",
            )
        assert r.status_code == 200, r.content
        assert Dependency.objects.get(pk=dep.pk).is_deleted
        assert _events(bcast, "dependency_deleted") == [str(world["b"].pk)]
        assert str(world["b"].pk) in {c.args[0] for c in recalc.call_args_list}

    def test_hard_delete_project_reaches_surviving_project(
        self,
        client: APIClient,
        world: dict[str, Any],
        django_capture_on_commit_callbacks: CommitCapture,
    ) -> None:
        _edge(world)
        Project.objects.filter(pk=world["a"].pk).update(is_archived=True)
        with _patched() as (bcast, recalc), django_capture_on_commit_callbacks(execute=True):
            r = client.delete(f"/api/v1/projects/{world['a'].pk}/?force=true")
        assert r.status_code == 204, r.content
        assert not Project.objects.filter(pk=world["a"].pk).exists()
        assert _events(bcast, "dependency_deleted") == [str(world["b"].pk)]
        assert {c.args[0] for c in recalc.call_args_list} == {str(world["b"].pk)}

    def test_project_cascade_retry_is_idempotent(
        self,
        world: dict[str, Any],
        django_capture_on_commit_callbacks: CommitCapture,
    ) -> None:
        _edge(world)
        world["a"].soft_delete()
        with _patched() as (bcast, recalc), django_capture_on_commit_callbacks(execute=True):
            cascade_project_soft_delete(str(world["a"].pk))
            cascade_project_soft_delete(str(world["a"].pk))
        assert _events(bcast, "dependency_deleted") == [str(world["b"].pk)]
        assert len(recalc.call_args_list) == 1
