"""API + task tests for the async program export bundle (#1958, ADR-0219).

The program-grain sibling of ``test_project_export_async.py``. Exercises the
enqueue → job-state → authenticated download lifecycle, the Admin+ RBAC step-up
on both the sync seed (#1957) and the async bundle, cross-program IDOR, and the
drain/purge Celery maintenance tasks.
"""

from __future__ import annotations

import datetime
import io
import tarfile
from datetime import timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, Role
from trueppm_api.apps.access.services import create_program
from trueppm_api.apps.projects.models import (
    Calendar,
    ExportJobStatus,
    Methodology,
    Program,
    ProgramExportJob,
    Project,
    Task,
    TaskAttachment,
)
from trueppm_api.apps.timetracking.models import TimeEntry

pytestmark = pytest.mark.django_db

User = get_user_model()


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
def viewer_user() -> Any:
    return User.objects.create_user(username="viewer", password="pw")


@pytest.fixture
def stranger() -> Any:
    return User.objects.create_user(username="stranger", password="pw")


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def program(owner: Any, admin_user: Any, member_user: Any, viewer_user: Any) -> Program:
    prog = create_program(
        name="Atlas", description="", methodology=Methodology.HYBRID, created_by=owner
    )
    prog.code = "atlas"
    prog.save(update_fields=["code"])
    ProgramMembership.objects.create(program=prog, user=admin_user, role=Role.ADMIN)
    ProgramMembership.objects.create(program=prog, user=member_user, role=Role.MEMBER)
    ProgramMembership.objects.create(program=prog, user=viewer_user, role=Role.VIEWER)
    return prog


@pytest.fixture
def populated_program(program: Program, owner: Any, calendar: Calendar) -> Program:
    """A program whose member project has a task, time entry, and attachments."""
    project = Project.objects.create(
        name="Apollo",
        code="apollo",
        start_date=datetime.date(2026, 4, 1),
        calendar=calendar,
        program=program,
    )
    task = Task.objects.create(project=project, name="Foundation pour", duration=3)
    TimeEntry.objects.create(task=task, user=owner, minutes=90, note="poured")
    TaskAttachment.objects.create(
        task=task,
        file=SimpleUploadedFile("plan.txt", b"blueprint bytes", content_type="text/plain"),
        file_name="plan.txt",
        file_mime="text/plain",
    )
    TaskAttachment.objects.create(task=task, external_url="https://example.com/spec")
    return program


def _export_url(program: Program) -> str:
    return f"/api/v1/programs/{program.pk}/export/"


def _run_export(job: ProgramExportJob) -> None:
    from trueppm_api.apps.projects.tasks import run_program_export

    run_program_export.apply(args=[str(job.id)], throw=True)


# ---------------------------------------------------------------------------
# Sync GET seed export — Admin+ gate (#1957)
# ---------------------------------------------------------------------------


def test_sync_seed_export_works_for_admin(admin_user: Any, program: Program) -> None:
    resp = _client(admin_user).get(_export_url(program))
    assert resp.status_code == 200
    assert resp["Content-Type"] == "application/json"


def test_sync_seed_export_works_for_owner(owner: Any, program: Program) -> None:
    assert _client(owner).get(_export_url(program)).status_code == 200


def test_sync_seed_export_forbidden_for_member(member_user: Any, program: Program) -> None:
    assert _client(member_user).get(_export_url(program)).status_code == 403


def test_sync_seed_export_forbidden_for_viewer(viewer_user: Any, program: Program) -> None:
    assert _client(viewer_user).get(_export_url(program)).status_code == 403


# ---------------------------------------------------------------------------
# Enqueue + RBAC
# ---------------------------------------------------------------------------


def test_enqueue_requires_auth(program: Program) -> None:
    resp = APIClient().post(_export_url(program))
    assert resp.status_code in (401, 403)


def test_admin_can_enqueue(admin_user: Any, program: Program) -> None:
    resp = _client(admin_user).post(_export_url(program))
    assert resp.status_code == 202, resp.content
    assert resp.data["status"] == ExportJobStatus.PENDING
    assert ProgramExportJob.objects.filter(id=resp.data["id"], program=program).exists()


def test_owner_can_enqueue(owner: Any, program: Program) -> None:
    assert _client(owner).post(_export_url(program)).status_code == 202


def test_member_cannot_enqueue(member_user: Any, program: Program) -> None:
    assert _client(member_user).post(_export_url(program)).status_code == 403


def test_stranger_cannot_enqueue(stranger: Any, program: Program) -> None:
    assert _client(stranger).post(_export_url(program)).status_code in (403, 404)


def test_enqueue_dedupes_in_flight(admin_user: Any, program: Program) -> None:
    first = _client(admin_user).post(_export_url(program))
    second = _client(admin_user).post(_export_url(program))
    assert first.data["id"] == second.data["id"]
    assert ProgramExportJob.objects.filter(program=program).count() == 1


# ---------------------------------------------------------------------------
# Build task
# ---------------------------------------------------------------------------


def test_run_export_builds_and_stores_archive(populated_program: Program, owner: Any) -> None:
    job = ProgramExportJob.objects.create(program=populated_program, requested_by=owner)
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
    assert "manifest.json" in names
    assert "seed.json" in names
    assert "counts.json" in names
    # Per-project members are namespaced under projects/<id>/.
    project = populated_program.projects.get()
    pfx = f"projects/{project.id}/"
    for suffix in (
        "msproject.xml",
        "time_entries.json",
        "history/tasks.json",
        "attachments/index.json",
    ):
        assert f"{pfx}{suffix}" in names, f"{pfx}{suffix} missing from {names}"
    # The file attachment binary is packed under the project namespace.
    assert any(n.startswith(f"{pfx}attachments/") and n.endswith("plan.txt") for n in names)


def test_run_export_unknown_job_is_noop() -> None:
    from trueppm_api.apps.projects.tasks import run_program_export

    run_program_export.run("00000000-0000-0000-0000-000000000000")  # no raise


def test_run_export_terminal_job_is_noop(program: Program, owner: Any) -> None:
    job = ProgramExportJob.objects.create(
        program=program, requested_by=owner, status=ExportJobStatus.FAILED
    )
    _run_export(job)
    job.refresh_from_db()
    assert job.status == ExportJobStatus.FAILED  # not rebuilt


# ---------------------------------------------------------------------------
# Poll + download
# ---------------------------------------------------------------------------


def test_poll_exposes_download_url_when_ready(program: Program, admin_user: Any) -> None:
    job = ProgramExportJob.objects.create(program=program, requested_by=admin_user)
    _run_export(job)
    resp = _client(admin_user).get(f"{_export_url(program)}jobs/{job.id}/")
    assert resp.status_code == 200
    assert resp.data["status"] == ExportJobStatus.SUCCESS
    assert (
        resp.data["download_url"] == f"/api/v1/programs/{program.id}/export/jobs/{job.id}/download/"
    )


def test_member_cannot_poll(program: Program, admin_user: Any, member_user: Any) -> None:
    job = ProgramExportJob.objects.create(program=program, requested_by=admin_user)
    assert _client(member_user).get(f"{_export_url(program)}jobs/{job.id}/").status_code == 403


def test_download_ready_archive(program: Program, admin_user: Any) -> None:
    job = ProgramExportJob.objects.create(program=program, requested_by=admin_user)
    _run_export(job)
    resp = _client(admin_user).get(f"{_export_url(program)}jobs/{job.id}/download/")
    assert resp.status_code == 200
    assert resp["Content-Type"] == "application/gzip"
    assert b"".join(resp.streaming_content)[:2] == b"\x1f\x8b"  # gzip magic


def test_download_before_ready_is_409(program: Program, admin_user: Any) -> None:
    job = ProgramExportJob.objects.create(program=program, requested_by=admin_user)
    resp = _client(admin_user).get(f"{_export_url(program)}jobs/{job.id}/download/")
    assert resp.status_code == 409


def test_download_after_expiry_is_410(program: Program, admin_user: Any) -> None:
    job = ProgramExportJob.objects.create(
        program=program,
        requested_by=admin_user,
        status=ExportJobStatus.SUCCESS,
        file_path="program-exports/x.tar.gz",
        expires_at=timezone.now() - timedelta(days=1),
    )
    resp = _client(admin_user).get(f"{_export_url(program)}jobs/{job.id}/download/")
    assert resp.status_code == 410


def test_job_from_other_program_is_404(program: Program, admin_user: Any, owner: Any) -> None:
    other = create_program(
        name="Other", description="", methodology=Methodology.HYBRID, created_by=owner
    )
    ProgramMembership.objects.create(program=other, user=admin_user, role=Role.ADMIN)
    foreign_job = ProgramExportJob.objects.create(program=other, requested_by=admin_user)
    # Ask under `program`'s URL for a job that belongs to `other` → IDOR guard 404.
    resp = _client(admin_user).get(f"{_export_url(program)}jobs/{foreign_job.id}/")
    assert resp.status_code == 404


def test_jobs_list_is_program_scoped(program: Program, admin_user: Any, owner: Any) -> None:
    ProgramExportJob.objects.create(program=program, requested_by=admin_user)
    other = create_program(
        name="Other", description="", methodology=Methodology.HYBRID, created_by=owner
    )
    ProgramExportJob.objects.create(program=other, requested_by=owner)
    resp = _client(admin_user).get(f"{_export_url(program)}jobs/")
    assert resp.status_code == 200
    assert resp.data["count"] == 1


# ---------------------------------------------------------------------------
# Drain + purge maintenance tasks
# ---------------------------------------------------------------------------


def test_drain_redispatches_orphaned_pending(
    program: Program, owner: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    job = ProgramExportJob.objects.create(program=program, requested_by=owner)
    ProgramExportJob.objects.filter(pk=job.pk).update(
        created_at=timezone.now() - timedelta(minutes=10)
    )
    from trueppm_api.apps.projects import tasks as project_tasks

    dispatched: list[str] = []
    monkeypatch.setattr(
        project_tasks.run_program_export, "delay", lambda jid: dispatched.append(jid)
    )
    project_tasks._do_drain_program_exports()
    assert dispatched == [str(job.id)]


def test_drain_skips_fresh_pending(
    program: Program, owner: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    ProgramExportJob.objects.create(program=program, requested_by=owner)
    from trueppm_api.apps.projects import tasks as project_tasks

    dispatched: list[str] = []
    monkeypatch.setattr(
        project_tasks.run_program_export, "delay", lambda jid: dispatched.append(jid)
    )
    project_tasks._do_drain_program_exports()
    assert dispatched == []


def test_purge_deletes_expired_job_and_file(program: Program, owner: Any) -> None:
    from django.core.files.base import ContentFile
    from django.core.files.storage import default_storage

    path = default_storage.save("program-exports/expired.tar.gz", ContentFile(b"x"))
    job = ProgramExportJob.objects.create(
        program=program,
        requested_by=owner,
        status=ExportJobStatus.SUCCESS,
        file_path=path,
        expires_at=timezone.now() - timedelta(days=1),
    )
    from trueppm_api.apps.projects import tasks as project_tasks

    project_tasks._do_purge_expired_program_exports()
    assert not ProgramExportJob.objects.filter(pk=job.pk).exists()
    assert not default_storage.exists(path)
