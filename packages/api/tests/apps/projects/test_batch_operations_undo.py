"""⌘Z undo for paste-many, cascade classification, and CSV import (ADR-0810, #2756).

The assertions that matter most mirror ``test_project_templates.py``'s undo
coverage, extended to the touched-since check this ADR changed: paste-many and
CSV import create rows via a write path that stamps ``edited_at`` at creation
(paste-many) or never at all (import, bulk_create) — ``server_version``
comparison, not ``edited_at IS NOT NULL``, is what has to distinguish "nobody
touched this since the batch wrote it" from "someone touched it a second
later" in both cases.
"""

from __future__ import annotations

import base64
from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.csvimport.models import CsvImportRequest, CsvImportStatus
from trueppm_api.apps.csvimport.parser import parse_spreadsheet
from trueppm_api.apps.msproject.importer import import_project
from trueppm_api.apps.projects.models import (
    Calendar,
    CascadeClassificationOperation,
    DeliveryMode,
    GovernanceClass,
    PasteManyOperation,
    Project,
    SyncBatchOperationStatus,
    Task,
)
from trueppm_api.apps.projects.task_batch_services import (
    finalize_import_fix_operation,
    undo_import_fix_operation,
)

from ..csvimport.fixtures import REFERENCE_CSV

User = get_user_model()

BULK_URL = "/api/v1/projects/{pk}/tasks/bulk/"
CLASSIFY_URL = "/api/v1/projects/{pk}/tasks/classification/"


def bulk_url(project: Project) -> str:
    return BULK_URL.format(pk=project.pk)


def classify_url(project: Project) -> str:
    return CLASSIFY_URL.format(pk=project.pk)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Undo", start_date=date(2026, 1, 1), calendar=calendar)


def _member(project: Project, username: str, role: int) -> APIClient:
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def owner_client(project: Project) -> APIClient:
    return _member(project, "owner", Role.OWNER)


@pytest.fixture
def member_client(project: Project) -> APIClient:
    return _member(project, "member", Role.MEMBER)


# ---------------------------------------------------------------------------
# Paste-many
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_paste_many_operation_recorded_from_a_real_bulk_create(
    owner_client: APIClient, project: Project
) -> None:
    """The endpoint, not just the service — this is the wiring's own regression test."""
    ops = [{"op": "create", "data": {"name": f"Row {i}", "duration": 1}} for i in range(3)]
    r = owner_client.post(bulk_url(project), {"operations": ops}, format="json")
    assert r.status_code == 207, r.data

    operation = PasteManyOperation.objects.get(project=project)
    assert len(operation.created_task_versions) == 3
    assert operation.status == SyncBatchOperationStatus.ACTIVE


@pytest.mark.django_db
def test_paste_many_undo_removes_exactly_what_it_created(
    owner_client: APIClient, project: Project
) -> None:
    pre_existing = Task.objects.create(project=project, name="Ours", duration=3)
    ops = [{"op": "create", "data": {"name": f"Row {i}", "duration": 1}} for i in range(3)]
    owner_client.post(bulk_url(project), {"operations": ops}, format="json")
    operation_id = PasteManyOperation.objects.get(project=project).pk

    undo_resp = owner_client.post(
        f"/api/v1/paste-many-operations/{operation_id}/undo/", {}, format="json"
    )
    assert undo_resp.status_code == 200, undo_resp.data
    assert undo_resp.data["undo"] == {"deleted": 3, "kept": 0}

    pre_existing.refresh_from_db()
    assert pre_existing.is_deleted is False
    assert Task.objects.filter(project=project, is_deleted=False).count() == 1


@pytest.mark.django_db
def test_paste_many_undo_keeps_a_row_touched_after_the_paste(
    owner_client: APIClient, project: Project
) -> None:
    """The precise reason for the server_version check over edited_at.

    Paste-many creates through the normal serializer path, which stamps
    ``edited_at`` at creation itself — an ``edited_at IS NOT NULL`` check would
    call every freshly pasted row "touched" and undo nothing. This test would
    pass with `deleted: 0` under that bug and only the version-snapshot check
    catches it.
    """
    ops = [{"op": "create", "data": {"name": f"Row {i}", "duration": 1}} for i in range(2)]
    r = owner_client.post(bulk_url(project), {"operations": ops}, format="json")
    created_id = r.data["applied"][0]["id"]
    operation_id = PasteManyOperation.objects.get(project=project).pk

    # A person edits one of the pasted rows before anyone undoes the paste.
    touched = Task.objects.get(pk=created_id)
    touched.name = "Renamed by a person"
    touched.save()

    undo_resp = owner_client.post(
        f"/api/v1/paste-many-operations/{operation_id}/undo/", {}, format="json"
    )
    assert undo_resp.data["undo"] == {"deleted": 1, "kept": 1}
    touched.refresh_from_db()
    assert touched.is_deleted is False
    assert touched.name == "Renamed by a person"


@pytest.mark.django_db
def test_paste_many_undo_requires_admin(
    owner_client: APIClient, member_client: APIClient, project: Project
) -> None:
    owner_client.post(
        bulk_url(project),
        {"operations": [{"op": "create", "data": {"name": "Solo", "duration": 1}}]},
        format="json",
    )
    operation_id = PasteManyOperation.objects.get(project=project).pk

    resp = member_client.post(
        f"/api/v1/paste-many-operations/{operation_id}/undo/", {}, format="json"
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_paste_many_undo_twice_is_refused(owner_client: APIClient, project: Project) -> None:
    owner_client.post(
        bulk_url(project),
        {"operations": [{"op": "create", "data": {"name": "Solo", "duration": 1}}]},
        format="json",
    )
    operation_id = PasteManyOperation.objects.get(project=project).pk
    url = f"/api/v1/paste-many-operations/{operation_id}/undo/"

    first = owner_client.post(url, {}, format="json")
    assert first.status_code == 200
    second = owner_client.post(url, {}, format="json")
    assert second.status_code == 400


@pytest.mark.django_db
def test_bulk_batch_with_no_creates_records_no_paste_many_operation(
    owner_client: APIClient, project: Project
) -> None:
    task = Task.objects.create(project=project, name="Existing", duration=2)
    owner_client.post(
        bulk_url(project),
        {"operations": [{"op": "update", "id": str(task.pk), "data": {"duration": 3}}]},
        format="json",
    )
    assert PasteManyOperation.objects.filter(project=project).count() == 0


# ---------------------------------------------------------------------------
# Cascade classification
# ---------------------------------------------------------------------------


def _no_recalc() -> Any:
    from unittest.mock import patch

    return patch("trueppm_api.apps.projects.views._enqueue_recalculate")


@pytest.mark.django_db
def test_cascade_undo_restores_prior_classification(
    owner_client: APIClient, project: Project
) -> None:
    root = Task.objects.create(
        project=project,
        name="Phase",
        wbs_path="1",
        duration=5,
        governance_class=GovernanceClass.FLOW,
    )
    with _no_recalc():
        r = owner_client.patch(
            classify_url(project),
            {"subtree": str(root.pk), "cascade": False, "governance_class": "gated"},
            format="json",
        )
    assert r.status_code == 200, r.data
    operation = CascadeClassificationOperation.objects.get(project=project)
    assert operation.task_snapshots[str(root.pk)]["before"]["governance_class"] == "flow"

    undo_resp = owner_client.post(
        f"/api/v1/cascade-classification-operations/{operation.pk}/undo/", {}, format="json"
    )
    assert undo_resp.status_code == 200, undo_resp.data
    assert undo_resp.data["undo"] == {"reverted": 1, "kept": 0}
    root.refresh_from_db()
    assert root.governance_class == "flow"


@pytest.mark.django_db
def test_cascade_undo_skips_a_row_reclassified_since(
    owner_client: APIClient, project: Project
) -> None:
    root = Task.objects.create(
        project=project,
        name="Phase",
        wbs_path="1",
        duration=5,
        delivery_mode=DeliveryMode.WATERFALL,
    )
    with _no_recalc():
        owner_client.patch(
            classify_url(project),
            {"subtree": str(root.pk), "cascade": False, "delivery_mode": "scrum"},
            format="json",
        )
    operation = CascadeClassificationOperation.objects.get(project=project)

    # A person (or a second cascade) changes it again before anyone undoes the first.
    root.refresh_from_db()
    root.delivery_mode = DeliveryMode.KANBAN
    root.save()

    undo_resp = owner_client.post(
        f"/api/v1/cascade-classification-operations/{operation.pk}/undo/", {}, format="json"
    )
    assert undo_resp.data["undo"] == {"reverted": 0, "kept": 1}
    root.refresh_from_db()
    assert root.delivery_mode == "kanban"


@pytest.mark.django_db
def test_cascade_undo_requires_admin(
    owner_client: APIClient, member_client: APIClient, project: Project
) -> None:
    root = Task.objects.create(
        project=project, name="Phase", wbs_path="1", duration=5, governance_class="flow"
    )
    with _no_recalc():
        owner_client.patch(
            classify_url(project),
            {"subtree": str(root.pk), "cascade": False, "governance_class": "gated"},
            format="json",
        )
    operation = CascadeClassificationOperation.objects.get(project=project)

    resp = member_client.post(
        f"/api/v1/cascade-classification-operations/{operation.pk}/undo/", {}, format="json"
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Import-fix (CSV import) — service-level, mirroring test_import.py's own
# direct-``import_project`` pattern rather than the full upload/Celery path.
# ---------------------------------------------------------------------------


def _make_request(project: Project, **kwargs: object) -> CsvImportRequest:
    defaults: dict[str, object] = {
        "project": project,
        "filename": "plan.csv",
        "file_content_b64": base64.b64encode(REFERENCE_CSV).decode("ascii"),
    }
    defaults.update(kwargs)
    return CsvImportRequest.objects.create(**defaults)


@pytest.mark.django_db
def test_import_project_reports_created_task_ids(project: Project) -> None:
    parsed = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
    summary = import_project(str(project.pk), parsed.project_data)
    assert len(summary["created_task_ids"]) == summary["tasks_created"] == 7


@pytest.mark.django_db
def test_import_fix_undo_removes_exactly_what_it_created(project: Project) -> None:
    pre_existing = Task.objects.create(project=project, name="Ours", duration=3)
    parsed = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
    summary = import_project(str(project.pk), parsed.project_data)
    req = _make_request(project, status=CsvImportStatus.DONE)
    finalize_import_fix_operation(str(req.pk), summary["created_task_ids"])
    req.refresh_from_db()
    assert len(req.created_task_versions) == 7

    result = undo_import_fix_operation(req)
    assert result == {"deleted": 7, "kept": 0}
    pre_existing.refresh_from_db()
    assert pre_existing.is_deleted is False
    assert Task.objects.filter(project=project, is_deleted=False).count() == 1


@pytest.mark.django_db
def test_import_fix_undo_keeps_a_row_a_person_has_touched(project: Project) -> None:
    parsed = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
    summary = import_project(str(project.pk), parsed.project_data)
    req = _make_request(project, status=CsvImportStatus.DONE)
    finalize_import_fix_operation(str(req.pk), summary["created_task_ids"])
    req.refresh_from_db()

    touched = Task.objects.get(pk=summary["created_task_ids"][0])
    touched.name = "Renamed after import"
    touched.save()

    result = undo_import_fix_operation(req)
    assert result == {"deleted": 6, "kept": 1}
    touched.refresh_from_db()
    assert touched.is_deleted is False
    assert touched.name == "Renamed after import"


@pytest.mark.django_db
def test_import_fix_undo_is_idempotent(project: Project) -> None:
    parsed = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
    summary = import_project(str(project.pk), parsed.project_data)
    req = _make_request(project, status=CsvImportStatus.DONE)
    finalize_import_fix_operation(str(req.pk), summary["created_task_ids"])
    req.refresh_from_db()

    first = undo_import_fix_operation(req)
    req.refresh_from_db()
    second = undo_import_fix_operation(req)
    assert first == second == {"deleted": 7, "kept": 0}
    assert Task.objects.filter(project=project, is_deleted=False).count() == 0


@pytest.mark.django_db
def test_import_fix_undo_endpoint_refuses_a_not_yet_done_import(
    owner_client: APIClient, project: Project
) -> None:
    req = _make_request(project, status=CsvImportStatus.DISPATCHED)
    resp = owner_client.post(
        f"/api/v1/projects/{project.pk}/import/csv/{req.pk}/undo/", {}, format="json"
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_import_fix_undo_endpoint_requires_admin(
    owner_client: APIClient, member_client: APIClient, project: Project
) -> None:
    parsed = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
    summary = import_project(str(project.pk), parsed.project_data)
    req = _make_request(project, status=CsvImportStatus.DONE)
    finalize_import_fix_operation(str(req.pk), summary["created_task_ids"])

    resp = member_client.post(
        f"/api/v1/projects/{project.pk}/import/csv/{req.pk}/undo/", {}, format="json"
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_import_fix_undo_endpoint_happy_path(owner_client: APIClient, project: Project) -> None:
    parsed = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
    summary = import_project(str(project.pk), parsed.project_data)
    req = _make_request(project, status=CsvImportStatus.DONE)
    finalize_import_fix_operation(str(req.pk), summary["created_task_ids"])

    resp = owner_client.post(
        f"/api/v1/projects/{project.pk}/import/csv/{req.pk}/undo/", {}, format="json"
    )
    assert resp.status_code == 200, resp.data
    assert resp.data["undo"] == {"deleted": 7, "kept": 0}
    assert resp.data["status"] == CsvImportStatus.UNDONE


# ---------------------------------------------------------------------------
# Purge (ADR-0810 §Durable Execution 6)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_purge_deletes_only_rows_past_retention(project: Project, settings: Any) -> None:
    from trueppm_api.apps.projects.tasks import _do_purge_expired_batch_operations

    settings.TRUEPPM_BATCH_OPERATION_RETENTION_DAYS = 30
    old = PasteManyOperation.objects.create(project=project, created_task_versions={})
    PasteManyOperation.objects.filter(pk=old.pk).update(
        created_at=old.created_at.replace(year=old.created_at.year - 1)
    )
    recent = PasteManyOperation.objects.create(project=project, created_task_versions={})

    _do_purge_expired_batch_operations()

    assert not PasteManyOperation.objects.filter(pk=old.pk).exists()
    assert PasteManyOperation.objects.filter(pk=recent.pk).exists()


@pytest.mark.django_db
def test_purge_disabled_when_retention_is_none(project: Project, settings: Any) -> None:
    from trueppm_api.apps.projects.tasks import _do_purge_expired_batch_operations

    settings.TRUEPPM_BATCH_OPERATION_RETENTION_DAYS = None
    old = PasteManyOperation.objects.create(project=project, created_task_versions={})
    PasteManyOperation.objects.filter(pk=old.pk).update(
        created_at=old.created_at.replace(year=old.created_at.year - 1)
    )

    _do_purge_expired_batch_operations()

    assert PasteManyOperation.objects.filter(pk=old.pk).exists()
