"""The sync upload delete must revert an accidental container, like REST does (#4463).

Root cause: ``TaskViewSet.perform_destroy`` (REST) always resynced the deleted
task's structural parent (#2950) — an accidental container that just lost its
last live child reverts to its own ``status``/``duration``; a DECLARED container
stays declared. The mobile sync upload's ``_apply_deleted_row`` never ran that
repair, so a client deleting a task through ``/sync/`` left the parent's
``auto_container``/rolled-up ``duration`` in place. The next CPM write-back then
read the row as still having children and never fixed it — the #4371
lost-update class, reached through a sibling delete path.

These tests exercise the real ``POST /api/v1/projects/{id}/sync/`` endpoint (the
issue's own test plan), mirroring the fixture shapes in ``test_sync_upload.py``
and the shadow-value assertions in ``test_structure_role.py``.
"""

from __future__ import annotations

import uuid
from contextlib import nullcontext
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
    StructureRole,
    Task,
    TaskStatus,
    sync_structure_shadow_values,
)
from trueppm_api.apps.scheduling import tasks as sched_tasks

User = get_user_model()


@pytest.fixture(autouse=True)
def _bypass_upload_throttle() -> Any:
    """See ``test_sync_upload.py`` — both guards hit Redis; pin them to a passthrough."""
    with (
        patch(
            "trueppm_api.apps.sync.throttles.SyncUploadThrottle.allow_request",
            return_value=True,
        ),
        patch(
            "trueppm_api.apps.sync.throttles.sync_batch_concurrency_slot",
            return_value=nullcontext(),
        ),
    ):
        yield


@pytest.fixture
def user(db: object) -> Any:
    return User.objects.create_user(username="resync_user", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="ResyncProj", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def admin_client(project: Project, user: Any) -> APIClient:
    """A Project Manager (ADMIN) — may delete any task."""
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/sync/"


def _delete_payload(*task_ids: str) -> dict[str, Any]:
    return {
        "client_batch_id": str(uuid.uuid4()),
        "changes": {"tasks": {"created": [], "updated": [], "deleted": list(task_ids)}},
    }


def _promote(parent: Task) -> Task:
    """Park the parent's own values and mark it an accidental container.

    Mirrors the REST ``perform_create``/restructure call sites: nothing on the
    plain ``Task.objects.create()`` path promotes a parent automatically, so
    every fixture that needs an already-promoted container (to then exercise
    the DEMOTE-on-delete path this issue is about) must do this explicitly,
    the same way ``test_structure_role.py`` does.
    """
    assert sync_structure_shadow_values(parent) is True, "fixture premise: it must promote"
    parent.save()
    parent.refresh_from_db()
    return parent


@pytest.mark.django_db
def test_delete_last_child_via_sync_reverts_accidental_container(
    admin_client: APIClient, project: Project
) -> None:
    """Deleting a container's only child through /sync/ restores its own estimate."""
    parent = Task.objects.create(
        project=project,
        name="Cable trays",
        duration=5,
        wbs_path="1",
        status=TaskStatus.NOT_STARTED,
    )
    child = Task.objects.create(project=project, name="Pull", duration=2, wbs_path="1.1")
    _promote(parent)
    assert parent.auto_container is True
    assert parent.own_estimate == 5

    resp = admin_client.post(_url(project), _delete_payload(str(child.pk)), format="json")
    assert resp.status_code == 200

    parent.refresh_from_db()
    assert parent.auto_container is False
    assert parent.structure_role == StructureRole.WORK
    assert parent.duration == 5, "its own estimate is back"
    assert parent.own_estimate is None
    assert parent.own_status is None

    child.refresh_from_db()
    assert child.is_deleted is True


@pytest.mark.django_db
def test_declared_container_losing_last_child_via_sync_stays_declared(
    admin_client: APIClient, project: Project
) -> None:
    """A DECLARED container is never silently un-declared — same rule, sync path."""
    parent = Task.objects.create(
        project=project,
        name="Commissioning",
        duration=1,
        wbs_path="1",
        structure_role=StructureRole.CONTAINER,
    )
    child = Task.objects.create(project=project, name="SIT", duration=3, wbs_path="1.1")
    assert sync_structure_shadow_values(parent) is True, "gaining a child still parks own values"
    parent.save()
    parent.refresh_from_db()
    assert parent.auto_container is False, "it was declared, not promoted"

    resp = admin_client.post(_url(project), _delete_payload(str(child.pk)), format="json")
    assert resp.status_code == 200

    parent.refresh_from_db()
    assert parent.structure_role == StructureRole.CONTAINER, "stays declared"
    assert parent.auto_container is False


@pytest.mark.django_db
def test_sync_delete_bumps_parent_server_version(admin_client: APIClient, project: Project) -> None:
    """The parent's repair is a synced write — an offline peer must see it on its
    next delta pull, which filters on `sync_seq`, not on the push response body."""
    parent = Task.objects.create(
        project=project, name="Trenching", duration=4, wbs_path="2", status=TaskStatus.NOT_STARTED
    )
    child = Task.objects.create(project=project, name="Dig", duration=1, wbs_path="2.1")
    _promote(parent)
    start_version = parent.server_version
    start_seq = parent.sync_seq

    resp = admin_client.post(_url(project), _delete_payload(str(child.pk)), format="json")
    assert resp.status_code == 200

    parent.refresh_from_db()
    assert parent.server_version > start_version
    assert parent.sync_seq > start_seq


@pytest.mark.django_db
def test_sync_delete_of_every_child_in_one_batch_reverts_parent_once(
    admin_client: APIClient, project: Project
) -> None:
    """Deleting several siblings of the same container in one batch still converges.

    Each deleted row re-derives the parent's container-ness from the then-current
    DB state, so an intermediate call (the parent still has a live sibling) is a
    harmless no-op and only the call that removes the LAST live child fires the
    revert — the end state is correct regardless of in-batch ordering.
    """
    parent = Task.objects.create(
        project=project, name="Phase", duration=9, wbs_path="3", status=TaskStatus.NOT_STARTED
    )
    child_a = Task.objects.create(project=project, name="A", duration=2, wbs_path="3.1")
    child_b = Task.objects.create(project=project, name="B", duration=3, wbs_path="3.2")
    _promote(parent)
    assert parent.auto_container is True
    assert parent.own_estimate == 9

    resp = admin_client.post(
        _url(project),
        _delete_payload(str(child_a.pk), str(child_b.pk)),
        format="json",
    )
    assert resp.status_code == 200

    parent.refresh_from_db()
    assert parent.auto_container is False
    assert parent.duration == 9
    assert parent.own_estimate is None

    child_a.refresh_from_db()
    child_b.refresh_from_db()
    assert child_a.is_deleted is True
    assert child_b.is_deleted is True


@pytest.mark.django_db(transaction=True)
def test_subsequent_recalc_preserves_restored_duration(
    admin_client: APIClient, project: Project
) -> None:
    """A CPM recalc after the sync delete must not clobber the restored duration.

    The CPM write-back's summary-duration step only overwrites rows that STILL
    have a live child at write-back time (#4371) — without #4463's fix, the
    parent would still look like a container (``auto_container`` never
    cleared), so the write-back would skip repairing it and the next recalc
    would silently re-roll-up a duration that should now read as the parent's
    own estimate.
    """
    parent = Task.objects.create(
        project=project, name="Phase", duration=6, wbs_path="4", status=TaskStatus.NOT_STARTED
    )
    child = Task.objects.create(project=project, name="Leaf", duration=1, wbs_path="4.1")
    _promote(parent)
    assert parent.auto_container is True

    resp = admin_client.post(_url(project), _delete_payload(str(child.pk)), format="json")
    assert resp.status_code == 200

    parent.refresh_from_db()
    assert parent.duration == 6
    assert parent.auto_container is False

    sched_tasks._run_schedule(str(project.pk), tracker=None)

    parent.refresh_from_db()
    assert parent.duration == 6, "the recalc must not re-roll-up a leaf's own estimate"
    assert parent.auto_container is False
