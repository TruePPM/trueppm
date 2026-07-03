"""Board queue promote/demote tests (issue 1610).

Covers the ``reorder_queue_priority`` service and the ``queue/reorder`` endpoint:
- dense ``priority_rank = position * 10`` renumber over the sent group order;
- per-row optimistic lock (409) with nothing written on stale;
- the status gate (only NOT_STARTED / IN_PROGRESS / REVIEW are reorderable → 400);
- no set-completeness check (a filtered subset is a valid reorder), unlike the
  product-backlog reorder;
- server_version bump + history write; idempotent re-apply;
- the IsProjectBacklogManager permission gate (Admin+ / PO facet).
"""

from __future__ import annotations

from datetime import date
from unittest import mock

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Task,
    TaskStatus,
    TaskType,
)
from trueppm_api.apps.projects.services import (
    QueueReorderConflict,
    QueueReorderValidation,
    reorder_queue_priority,
)

User = get_user_model()

QUEUE_REORDER_URL = "/api/v1/projects/{pk}/queue/reorder/"


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


@pytest.fixture
def owner(db: object) -> object:
    return User.objects.create_user(username="po", password="pw")


@pytest.fixture
def member_user(db: object) -> object:
    return User.objects.create_user(username="dev", password="pw")


@pytest.fixture
def project(owner: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    p = Project.objects.create(name="Artemis", start_date=date(2026, 1, 1), calendar=cal)
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    return p


@pytest.fixture
def member(project: Project, member_user: object) -> object:
    ProjectMembership.objects.create(project=project, user=member_user, role=Role.MEMBER)
    return member_user


@pytest.fixture
def owner_client(owner: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=owner)
    return c


def _task(project: Project, **kw: object) -> Task:
    defaults: dict[str, object] = {
        "name": "Task",
        "type": TaskType.TASK,
        "status": TaskStatus.NOT_STARTED,
    }
    defaults.update(kw)
    return Task.objects.create(project=project, **defaults)


def _entry(task: Task) -> dict[str, object]:
    return {"id": str(task.pk), "server_version": task.server_version}


# --------------------------------------------------------------------------- #
# Service
# --------------------------------------------------------------------------- #


def test_service_renumbers_dense_by_tens(project: Project) -> None:
    a = _task(project, name="a", priority_rank=10)
    b = _task(project, name="b", priority_rank=20)
    c = _task(project, name="c", priority_rank=30)
    # Promote c above a → new order c, a, b.
    changed = reorder_queue_priority(
        project,
        [
            (str(c.pk), c.server_version),
            (str(a.pk), a.server_version),
            (str(b.pk), b.server_version),
        ],
        None,
    )
    for t in (a, b, c):
        t.refresh_from_db()
    assert (c.priority_rank, a.priority_rank, b.priority_rank) == (10, 20, 30)
    assert changed == 3  # every row shifted


def test_service_is_idempotent(project: Project) -> None:
    a = _task(project, name="a", priority_rank=10)
    b = _task(project, name="b", priority_rank=20)
    order = [(str(a.pk), a.server_version), (str(b.pk), b.server_version)]
    assert reorder_queue_priority(project, order, None) == 0


def test_service_bumps_server_version_and_writes_history(project: Project) -> None:
    a = _task(project, name="a", priority_rank=10)
    b = _task(project, name="b", priority_rank=20)
    v0, h0 = a.server_version, a.history.count()
    # Demote a below b.
    reorder_queue_priority(
        project, [(str(b.pk), b.server_version), (str(a.pk), a.server_version)], None
    )
    a.refresh_from_db()
    assert a.priority_rank == 20  # moved to the back
    assert a.server_version > v0
    assert a.history.count() > h0


def test_service_reorders_a_partial_subset_no_completeness_check(project: Project) -> None:
    # Unlike the product-backlog reorder, the queue accepts a subset (the client may be
    # filtered by "My tasks"). Supplying two of three tasks reorders just those two.
    a = _task(project, name="a", priority_rank=10)
    b = _task(project, name="b", priority_rank=20)
    _task(project, name="c", priority_rank=30)  # omitted — must not be a conflict
    changed = reorder_queue_priority(
        project, [(str(b.pk), b.server_version), (str(a.pk), a.server_version)], None
    )
    assert changed == 2


def test_service_in_flight_statuses_are_reorderable(project: Project) -> None:
    a = _task(project, name="a", status=TaskStatus.IN_PROGRESS, priority_rank=10)
    b = _task(project, name="b", status=TaskStatus.REVIEW, priority_rank=20)
    changed = reorder_queue_priority(
        project, [(str(b.pk), b.server_version), (str(a.pk), a.server_version)], None
    )
    a.refresh_from_db()
    b.refresh_from_db()
    assert (b.priority_rank, a.priority_rank) == (10, 20)
    assert changed == 2


def test_service_stale_version_conflicts_and_writes_nothing(project: Project) -> None:
    a = _task(project, name="a", priority_rank=10)
    b = _task(project, name="b", priority_rank=20)
    with pytest.raises(QueueReorderConflict) as exc:
        reorder_queue_priority(
            project,
            [(str(b.pk), b.server_version), (str(a.pk), a.server_version + 99)],
            None,
        )
    assert str(a.pk) in exc.value.ids
    a.refresh_from_db()
    b.refresh_from_db()
    assert (a.priority_rank, b.priority_rank) == (10, 20)  # nothing written


def test_service_backlog_status_is_not_reorderable(project: Project) -> None:
    # BACKLOG rank is owned by product_backlog_reorder — the queue endpoint rejects it.
    a = _task(project, name="a", status=TaskStatus.BACKLOG, priority_rank=10)
    with pytest.raises(QueueReorderValidation) as exc:
        reorder_queue_priority(project, [(str(a.pk), a.server_version)], None)
    assert str(a.pk) in exc.value.ids


def test_service_complete_status_is_not_reorderable(project: Project) -> None:
    a = _task(project, name="a", status=TaskStatus.COMPLETE, priority_rank=10)
    with pytest.raises(QueueReorderValidation):
        reorder_queue_priority(project, [(str(a.pk), a.server_version)], None)


def test_service_summary_task_is_not_reorderable(project: Project) -> None:
    # A summary is a WBS parent — a task whose wbs_path prefixes a descendant's. Its
    # priority_rank doubles as the phase-column order, so the queue must not touch it.
    parent = _task(project, name="phase", status=TaskStatus.NOT_STARTED, wbs_path="1")
    _task(project, name="child", status=TaskStatus.NOT_STARTED, wbs_path="1.1")
    with pytest.raises(QueueReorderValidation) as exc:
        reorder_queue_priority(project, [(str(parent.pk), parent.server_version)], None)
    assert str(parent.pk) in exc.value.ids


def test_service_leaf_under_a_phase_is_reorderable(project: Project) -> None:
    # The child leaf (wbs 1.1) has no descendants → reorderable, unlike its parent phase.
    _task(project, name="phase", status=TaskStatus.NOT_STARTED, wbs_path="1")
    child = _task(
        project, name="child", status=TaskStatus.NOT_STARTED, wbs_path="1.1", priority_rank=10
    )
    changed = reorder_queue_priority(project, [(str(child.pk), child.server_version)], None)
    child.refresh_from_db()
    assert child.priority_rank == 10
    assert changed == 0  # already position 1 → rank 10, no change


def test_service_unknown_id_is_validation_error(project: Project) -> None:
    import uuid as _uuid

    a = _task(project, name="a", priority_rank=10)
    with pytest.raises(QueueReorderValidation):
        reorder_queue_priority(
            project,
            [(str(a.pk), a.server_version), (str(_uuid.uuid4()), 1)],
            None,
        )


def test_service_broadcasts_queue_reordered_on_change(
    project: Project, django_capture_on_commit_callbacks: object
) -> None:
    a = _task(project, name="a", priority_rank=10)
    b = _task(project, name="b", priority_rank=20)
    # The service imports broadcast_board_event at call time, so patch it on its source
    # module; the capture fixture runs the deferred on_commit dispatch so the mock records.
    with (
        mock.patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as bcast,
        django_capture_on_commit_callbacks(execute=True),  # type: ignore[operator]
    ):
        reorder_queue_priority(
            project, [(str(b.pk), b.server_version), (str(a.pk), a.server_version)], None
        )
    assert bcast.called
    assert bcast.call_args.args[1] == "queue_reordered"


# --------------------------------------------------------------------------- #
# Endpoint
# --------------------------------------------------------------------------- #


def test_endpoint_happy_path(owner_client: APIClient, project: Project) -> None:
    a = _task(project, name="a", priority_rank=10)
    b = _task(project, name="b", priority_rank=20)
    resp = owner_client.post(
        QUEUE_REORDER_URL.format(pk=project.pk),
        {"tasks": [_entry(b), _entry(a)]},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data["updated"] == 2
    a.refresh_from_db()
    b.refresh_from_db()
    assert (b.priority_rank, a.priority_rank) == (10, 20)


def test_endpoint_409_on_stale(owner_client: APIClient, project: Project) -> None:
    a = _task(project, name="a", priority_rank=10)
    b = _task(project, name="b", priority_rank=20)
    resp = owner_client.post(
        QUEUE_REORDER_URL.format(pk=project.pk),
        {"tasks": [{"id": str(b.pk), "server_version": b.server_version + 5}, _entry(a)]},
        format="json",
    )
    assert resp.status_code == 409
    assert str(b.pk) in resp.data["conflicts"]


def test_endpoint_400_on_wrong_status(owner_client: APIClient, project: Project) -> None:
    a = _task(project, name="a", status=TaskStatus.BACKLOG, priority_rank=10)
    resp = owner_client.post(
        QUEUE_REORDER_URL.format(pk=project.pk),
        {"tasks": [_entry(a)]},
        format="json",
    )
    assert resp.status_code == 400


def test_endpoint_400_on_malformed(owner_client: APIClient, project: Project) -> None:
    pk = project.pk
    assert owner_client.post(QUEUE_REORDER_URL.format(pk=pk), {}, format="json").status_code == 400
    assert (
        owner_client.post(QUEUE_REORDER_URL.format(pk=pk), {"tasks": []}, format="json").status_code
        == 400
    )
    assert (
        owner_client.post(
            QUEUE_REORDER_URL.format(pk=pk), {"tasks": [{"id": "not-a-uuid"}]}, format="json"
        ).status_code
        == 400
    )


def test_endpoint_400_on_oversized_list(owner_client: APIClient, project: Project) -> None:
    import uuid as _uuid

    payload = [{"id": str(_uuid.uuid4()), "server_version": 1} for _ in range(2001)]
    resp = owner_client.post(
        QUEUE_REORDER_URL.format(pk=project.pk), {"tasks": payload}, format="json"
    )
    assert resp.status_code == 400


def test_endpoint_400_on_duplicate_ids(owner_client: APIClient, project: Project) -> None:
    a = _task(project, name="a", priority_rank=10)
    resp = owner_client.post(
        QUEUE_REORDER_URL.format(pk=project.pk),
        {"tasks": [_entry(a), _entry(a)]},
        format="json",
    )
    assert resp.status_code == 400


def test_endpoint_requires_backlog_manager(project: Project, member: object) -> None:
    a = _task(project, name="a", priority_rank=10)
    client = APIClient()
    client.force_authenticate(user=member)
    resp = client.post(
        QUEUE_REORDER_URL.format(pk=project.pk),
        {"tasks": [_entry(a)]},
        format="json",
    )
    assert resp.status_code == 403


def test_endpoint_requires_authentication(project: Project) -> None:
    a = _task(project, name="a", priority_rank=10)
    resp = APIClient().post(
        QUEUE_REORDER_URL.format(pk=project.pk),
        {"tasks": [_entry(a)]},
        format="json",
    )
    assert resp.status_code in (401, 403)
