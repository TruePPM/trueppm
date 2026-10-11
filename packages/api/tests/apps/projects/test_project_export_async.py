"""API + task tests for the async project export bundle (#1266, ADR-0219).

Mirrors ``tests/apps/workspace/test_lifecycle_api.py`` (the ADR-0174 workspace
export) at the project grain. Exercises the enqueue → job-state → authenticated
download lifecycle, the Admin+ RBAC step-up, cross-project IDOR, the sync-GET
back-compat, and the drain/purge Celery maintenance tasks.
"""

from __future__ import annotations

import io
import tarfile
from datetime import date, timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    ExportJobStatus,
    Project,
    ProjectExportJob,
    Task,
    TaskAttachment,
)
from trueppm_api.apps.timetracking.models import TimeEntry

pytestmark = pytest.mark.django_db

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar() -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def admin_user() -> Any:
    return User.objects.create_user(username="admin", password="pw")


@pytest.fixture
def member_user() -> Any:
    return User.objects.create_user(username="member", password="pw")


@pytest.fixture
def stranger() -> Any:
    return User.objects.create_user(username="stranger", password="pw")


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def project(owner: Any, admin_user: Any, member_user: Any, calendar: Calendar) -> Project:
    p = Project.objects.create(
        name="Apollo", code="apollo", start_date=date(2026, 4, 1), calendar=calendar
    )
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    ProjectMembership.objects.create(project=p, user=admin_user, role=Role.ADMIN)
    ProjectMembership.objects.create(project=p, user=member_user, role=Role.MEMBER)
    return p


@pytest.fixture
def populated_project(project: Project, owner: Any) -> Project:
    """A project with a task, a time entry, and both file + link attachments."""
    task = Task.objects.create(project=project, name="Foundation pour", duration=3)
    TimeEntry.objects.create(task=task, user=owner, minutes=90, note="poured")
    TaskAttachment.objects.create(
        task=task,
        file=SimpleUploadedFile("plan.txt", b"blueprint bytes", content_type="text/plain"),
        file_name="plan.txt",
        file_mime="text/plain",
    )
    TaskAttachment.objects.create(task=task, external_url="https://example.com/spec")
    return project


def _export_url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/export/"


def _run_export(job: ProjectExportJob) -> None:
    from trueppm_api.apps.projects.tasks import run_project_export

    run_project_export.apply(args=[str(job.id)], throw=True)


# ---------------------------------------------------------------------------
# Enqueue + RBAC
# ---------------------------------------------------------------------------


def test_enqueue_requires_auth(project: Project) -> None:
    resp = APIClient().post(_export_url(project))
    assert resp.status_code in (401, 403)


def test_admin_can_enqueue(admin_user: Any, project: Project) -> None:
    resp = _client(admin_user).post(_export_url(project))
    assert resp.status_code == 202, resp.content
    assert resp.data["status"] == ExportJobStatus.PENDING
    assert ProjectExportJob.objects.filter(id=resp.data["id"], project=project).exists()


def test_owner_can_enqueue(owner: Any, project: Project) -> None:
    assert _client(owner).post(_export_url(project)).status_code == 202


def test_member_cannot_enqueue(member_user: Any, project: Project) -> None:
    assert _client(member_user).post(_export_url(project)).status_code == 403


def test_stranger_cannot_enqueue(stranger: Any, project: Project) -> None:
    assert _client(stranger).post(_export_url(project)).status_code in (403, 404)


def test_enqueue_dedupes_in_flight(admin_user: Any, project: Project) -> None:
    first = _client(admin_user).post(_export_url(project))
    second = _client(admin_user).post(_export_url(project))
    assert first.data["id"] == second.data["id"]
    assert ProjectExportJob.objects.filter(project=project).count() == 1


def test_enqueue_does_not_dedupe_onto_another_requesters_job(
    admin_user: Any, owner: Any, project: Project
) -> None:
    """#4370 (mirrors #4310's program-grain fix): an in-flight bundle belongs to its
    requester. A second admin's POST must get a job of their own, never the first
    admin's in-flight job — the #4310 fix never reached this project-grain path."""
    other_job = _client(owner).post(_export_url(project))
    assert other_job.status_code == 202

    mine = _client(admin_user).post(_export_url(project))

    assert mine.status_code == 202
    assert mine.data["id"] != other_job.data["id"]
    assert ProjectExportJob.objects.get(pk=mine.data["id"]).requested_by_id == admin_user.pk


# ---------------------------------------------------------------------------
# Build task
# ---------------------------------------------------------------------------


def test_run_export_builds_and_stores_archive(populated_project: Project, owner: Any) -> None:
    job = ProjectExportJob.objects.create(project=populated_project, requested_by=owner)
    _run_export(job)

    job.refresh_from_db()
    assert job.status == ExportJobStatus.SUCCESS
    assert job.file_path
    assert job.file_size and job.file_size > 0
    assert job.expires_at is not None

    from django.core.files.storage import default_storage

    with default_storage.open(job.file_path, "rb") as fh:
        raw = fh.read()
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as tar:
        names = set(tar.getnames())
    for expected in (
        "manifest.json",
        "seed.json",
        "msproject.xml",
        "time_entries.json",
        "counts.json",
        "history/tasks.json",
        "attachments/index.json",
    ):
        assert expected in names, f"{expected} missing from {names}"
    # The file attachment binary is packed; the external-link one is index-only.
    assert any(n.startswith("attachments/") and n.endswith("plan.txt") for n in names)


def _seed_json_from_archive(job: ProjectExportJob) -> dict[str, Any]:
    import json

    from django.core.files.storage import default_storage

    job.refresh_from_db()
    with default_storage.open(job.file_path, "rb") as fh:
        raw = fh.read()
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as tar:
        return json.loads(tar.extractfile("seed.json").read())  # type: ignore[union-attr]


def test_run_export_withholds_email_for_requester_without_workspace_admin(
    populated_project: Project, owner: Any
) -> None:
    """The async bundle is reachable through the same self-grantable IsProjectAdmin
    gate as the sync GET export (#3627) — it must redact identically."""
    from trueppm_api.apps.resources.models import ProjectResource, Resource

    resource = Resource.objects.create(name="Dana", email="dana@example.com", max_units=1.0)
    ProjectResource.objects.create(project=populated_project, resource=resource)

    job = ProjectExportJob.objects.create(project=populated_project, requested_by=owner)
    _run_export(job)
    job.refresh_from_db()
    assert job.status == ExportJobStatus.SUCCESS

    seed = _seed_json_from_archive(job)
    assert all(r.get("email") is None for r in seed.get("resources", []))


def test_run_export_includes_email_for_workspace_admin_requester(
    populated_project: Project, owner: Any
) -> None:
    from trueppm_api.apps.resources.models import ProjectResource, Resource
    from trueppm_api.apps.workspace.models import Workspace, WorkspaceMembership, WorkspaceRole

    resource = Resource.objects.create(name="Dana", email="dana@example.com", max_units=1.0)
    ProjectResource.objects.create(project=populated_project, resource=resource)
    ws = Workspace.objects.first() or Workspace.objects.create()
    WorkspaceMembership.objects.create(workspace=ws, user=owner, role=WorkspaceRole.ADMIN)

    job = ProjectExportJob.objects.create(project=populated_project, requested_by=owner)
    _run_export(job)
    job.refresh_from_db()
    assert job.status == ExportJobStatus.SUCCESS

    seed = _seed_json_from_archive(job)
    assert "dana@example.com" in [r.get("email") for r in seed.get("resources", [])]


def test_run_export_redacts_when_requester_account_is_gone(
    populated_project: Project, owner: Any
) -> None:
    """``requested_by`` can go NULL (``on_delete=SET_NULL``) if the requesting
    account is deleted between enqueue and build. That must not fall back to
    trusted/unredacted (#3627) — see exporter._NO_HTTP_CALLER."""
    from trueppm_api.apps.resources.models import ProjectResource, Resource

    resource = Resource.objects.create(name="Dana", email="dana@example.com", max_units=1.0)
    ProjectResource.objects.create(project=populated_project, resource=resource)

    job = ProjectExportJob.objects.create(project=populated_project, requested_by=owner)
    owner.delete()  # SET_NULL fires: job.requested_by_id becomes NULL
    _run_export(job)
    job.refresh_from_db()
    assert job.status == ExportJobStatus.SUCCESS
    assert job.requested_by_id is None

    seed = _seed_json_from_archive(job)
    assert all(r.get("email") is None for r in seed.get("resources", []))


def test_run_export_unknown_job_is_noop() -> None:
    from trueppm_api.apps.projects.tasks import run_project_export

    run_project_export.run("00000000-0000-0000-0000-000000000000")  # no raise


def test_run_export_terminal_job_is_noop(project: Project, owner: Any) -> None:
    job = ProjectExportJob.objects.create(
        project=project, requested_by=owner, status=ExportJobStatus.FAILED
    )
    _run_export(job)
    job.refresh_from_db()
    assert job.status == ExportJobStatus.FAILED  # not rebuilt


# ---------------------------------------------------------------------------
# Poll + download
# ---------------------------------------------------------------------------


def test_poll_exposes_download_url_when_ready(project: Project, admin_user: Any) -> None:
    job = ProjectExportJob.objects.create(project=project, requested_by=admin_user)
    _run_export(job)
    resp = _client(admin_user).get(f"{_export_url(project)}jobs/{job.id}/")
    assert resp.status_code == 200
    assert resp.data["status"] == ExportJobStatus.SUCCESS
    assert (
        resp.data["download_url"] == f"/api/v1/projects/{project.id}/export/jobs/{job.id}/download/"
    )


def test_member_cannot_poll(project: Project, admin_user: Any, member_user: Any) -> None:
    job = ProjectExportJob.objects.create(project=project, requested_by=admin_user)
    assert _client(member_user).get(f"{_export_url(project)}jobs/{job.id}/").status_code == 403


def test_download_ready_archive(project: Project, admin_user: Any) -> None:
    job = ProjectExportJob.objects.create(project=project, requested_by=admin_user)
    _run_export(job)
    resp = _client(admin_user).get(f"{_export_url(project)}jobs/{job.id}/download/")
    assert resp.status_code == 200
    assert resp["Content-Type"] == "application/gzip"
    assert b"".join(resp.streaming_content)[:2] == b"\x1f\x8b"  # gzip magic


def test_download_before_ready_is_409(project: Project, admin_user: Any) -> None:
    job = ProjectExportJob.objects.create(project=project, requested_by=admin_user)
    resp = _client(admin_user).get(f"{_export_url(project)}jobs/{job.id}/download/")
    assert resp.status_code == 409


def test_download_after_expiry_is_410(project: Project, admin_user: Any) -> None:
    job = ProjectExportJob.objects.create(
        project=project,
        requested_by=admin_user,
        status=ExportJobStatus.SUCCESS,
        file_path="project-exports/x.tar.gz",
        expires_at=timezone.now() - timedelta(days=1),
    )
    resp = _client(admin_user).get(f"{_export_url(project)}jobs/{job.id}/download/")
    assert resp.status_code == 410


def test_job_from_other_project_is_404(
    project: Project, admin_user: Any, calendar: Calendar
) -> None:
    other = Project.objects.create(name="Other", start_date=date(2026, 5, 1), calendar=calendar)
    ProjectMembership.objects.create(project=other, user=admin_user, role=Role.ADMIN)
    foreign_job = ProjectExportJob.objects.create(project=other, requested_by=admin_user)
    # Ask under `project`'s URL for a job that belongs to `other` → IDOR guard 404.
    resp = _client(admin_user).get(f"{_export_url(project)}jobs/{foreign_job.id}/")
    assert resp.status_code == 404


def test_jobs_list_is_project_scoped(project: Project, admin_user: Any, calendar: Calendar) -> None:
    ProjectExportJob.objects.create(project=project, requested_by=admin_user)
    other = Project.objects.create(name="Other", start_date=date(2026, 5, 1), calendar=calendar)
    ProjectExportJob.objects.create(project=other, requested_by=admin_user)
    resp = _client(admin_user).get(f"{_export_url(project)}jobs/")
    assert resp.status_code == 200
    assert resp.data["count"] == 1


# ---------------------------------------------------------------------------
# Requester scoping (#4370 — the #4310 program fix never reached this path)
# ---------------------------------------------------------------------------


def test_other_admins_job_is_not_in_the_list(project: Project, admin_user: Any, owner: Any) -> None:
    """Both ``admin_user`` and ``owner`` are project Admin+. A's job must not appear
    in B's list — only the admin who requested a job can see it (#4370)."""
    admins_job = ProjectExportJob.objects.create(project=project, requested_by=admin_user)
    owners_job = ProjectExportJob.objects.create(project=project, requested_by=owner)

    resp = _client(owner).get(f"{_export_url(project)}jobs/")
    assert resp.status_code == 200
    ids = {row["id"] for row in resp.data["results"]}
    assert ids == {str(owners_job.id)}
    assert str(admins_job.id) not in ids


def test_other_admin_cannot_poll_job(project: Project, admin_user: Any, owner: Any) -> None:
    """A job requested by one Admin 404s for another Admin polling it — the same
    IDOR-shaped refusal as a cross-project job id, not a 403 (#4370)."""
    job = ProjectExportJob.objects.create(project=project, requested_by=admin_user)
    resp = _client(owner).get(f"{_export_url(project)}jobs/{job.id}/")
    assert resp.status_code == 404


def test_other_admin_cannot_download_job(project: Project, admin_user: Any, owner: Any) -> None:
    """A completed job requested by one Admin 404s for another Admin's download —
    the bundle can carry withheld emails/blocker text scoped to the requester, so a
    sibling Admin must never be handed it (#4370). The archive file genuinely exists
    in storage, so a pass here can only be the requester-scoping guard, never the
    "file not ready"/"no such file" 404 ``stream_export_job_or_error`` also raises."""
    from django.core.files.base import ContentFile
    from django.core.files.storage import default_storage

    path = default_storage.save("project-exports/4370-idor.tar.gz", ContentFile(b"x"))
    job = ProjectExportJob.objects.create(
        project=project,
        requested_by=admin_user,
        status=ExportJobStatus.SUCCESS,
        file_path=path,
        expires_at=timezone.now() + timedelta(days=1),
    )
    resp = _client(owner).get(f"{_export_url(project)}jobs/{job.id}/download/")
    assert resp.status_code == 404
    assert default_storage.exists(path)


# ---------------------------------------------------------------------------
# Sync GET seed export — Admin+ gate (#1957)
# ---------------------------------------------------------------------------


def test_sync_json_export_works_for_admin(admin_user: Any, project: Project) -> None:
    resp = _client(admin_user).get(_export_url(project))
    assert resp.status_code == 200
    assert resp["Content-Type"] == "application/json"
    assert resp["Content-Disposition"].endswith('.json"')


def test_sync_json_export_works_for_owner(owner: Any, project: Project) -> None:
    assert _client(owner).get(_export_url(project)).status_code == 200


def test_sync_json_export_forbidden_for_member(member_user: Any, project: Project) -> None:
    # #1957: the sync seed dumps team-private velocity/points raw with no ADR-0104
    # field-gating, so it is Admin+ like the async bundle — a Member now gets 403.
    assert _client(member_user).get(_export_url(project)).status_code == 403


def test_sync_json_export_forbidden_for_viewer(project: Project, calendar: Calendar) -> None:
    viewer = User.objects.create_user(username="viewer", password="pw")
    ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)
    assert _client(viewer).get(_export_url(project)).status_code == 403


# ---------------------------------------------------------------------------
# Drain + purge maintenance tasks
# ---------------------------------------------------------------------------


def test_drain_redispatches_orphaned_pending(
    project: Project, owner: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    job = ProjectExportJob.objects.create(project=project, requested_by=owner)
    # Age it past the 5-min orphan window with an empty celery_task_id.
    ProjectExportJob.objects.filter(pk=job.pk).update(
        created_at=timezone.now() - timedelta(minutes=10)
    )
    from trueppm_api.apps.projects import tasks as project_tasks

    dispatched: list[str] = []
    monkeypatch.setattr(
        project_tasks.run_project_export, "delay", lambda jid: dispatched.append(jid)
    )
    project_tasks._do_drain_project_exports()
    assert dispatched == [str(job.id)]


def test_drain_skips_fresh_pending(
    project: Project, owner: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A just-created pending row (inside the orphan window) must NOT be re-dispatched —
    # it may still be mid-commit; the on_commit dispatch owns it.
    ProjectExportJob.objects.create(project=project, requested_by=owner)
    from trueppm_api.apps.projects import tasks as project_tasks

    dispatched: list[str] = []
    monkeypatch.setattr(
        project_tasks.run_project_export, "delay", lambda jid: dispatched.append(jid)
    )
    project_tasks._do_drain_project_exports()
    assert dispatched == []


def test_purge_deletes_expired_job_and_file(project: Project, owner: Any) -> None:
    from django.core.files.base import ContentFile
    from django.core.files.storage import default_storage

    path = default_storage.save("project-exports/expired.tar.gz", ContentFile(b"x"))
    job = ProjectExportJob.objects.create(
        project=project,
        requested_by=owner,
        status=ExportJobStatus.SUCCESS,
        file_path=path,
        expires_at=timezone.now() - timedelta(days=1),
    )
    from trueppm_api.apps.projects import tasks as project_tasks

    project_tasks._do_purge_expired_project_exports()
    assert not ProjectExportJob.objects.filter(pk=job.pk).exists()
    assert not default_storage.exists(path)
