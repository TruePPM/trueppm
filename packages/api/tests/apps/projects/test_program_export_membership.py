"""Program export honours project membership of the requester (#4310, ADR-0161 amendment).

A Program Admin's grant is program-side. It must not reach the content of a member
project the caller holds no live ``ProjectMembership`` on, on either the synchronous
seed (``export_program``) or the async ``.tar.gz`` bundle
(``build_and_store_program_archive``). Program-level blocks stay in the export.
"""

from __future__ import annotations

import datetime
import io
import json
import tarfile
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.core.files.storage import default_storage
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.access.services import create_program
from trueppm_api.apps.projects.export_bundle import build_and_store_program_archive
from trueppm_api.apps.projects.models import (
    Calendar,
    ExportJobStatus,
    Methodology,
    Program,
    ProgramExportJob,
    Project,
    Task,
)
from trueppm_api.apps.projects.seed.exporter import export_program
from trueppm_api.apps.projects.tasks import run_program_export

pytestmark = pytest.mark.django_db

User = get_user_model()

# Distinctive strings so a leak is unambiguous in a raw body or archive member.
P_NAME = "Apollo-4310-secret"
TASK_NAME = "Foundation-pour-4310-secret"
PROGRAM_NAME = "Atlas-4310"


@pytest.fixture
def calendar() -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(username="owner_4310", password="pw")


@pytest.fixture
def admin_user() -> Any:
    """Program Admin with no ProjectMembership on any member project (Mallory)."""
    return User.objects.create_user(username="admin_4310", password="pw")


@pytest.fixture
def program(owner: Any, admin_user: Any) -> Program:
    prog = create_program(
        name=PROGRAM_NAME, description="", methodology=Methodology.HYBRID, created_by=owner
    )
    prog.code = "atlas-4310"
    prog.save(update_fields=["code"])
    ProgramMembership.objects.create(program=prog, user=admin_user, role=Role.ADMIN)
    return prog


@pytest.fixture
def project_p(program: Program, calendar: Calendar) -> Project:
    project = Project.objects.create(
        name=P_NAME,
        code="apollo-4310",
        start_date=datetime.date(2026, 4, 1),
        calendar=calendar,
        program=program,
    )
    # wbs_path is required for a task to appear in the seed (tasks without one are dropped).
    Task.objects.create(project=project, name=TASK_NAME, duration=3, wbs_path="1")
    return project


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _grant_membership(project: Project, user: Any) -> None:
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)


def _run_export(job: ProgramExportJob) -> None:
    run_program_export.apply(args=[str(job.id)], throw=True)


def _archive_members(job: ProgramExportJob) -> tuple[set[str], dict[str, bytes]]:
    job.refresh_from_db()
    assert job.status == ExportJobStatus.SUCCESS
    with default_storage.open(job.file_path, "rb") as fh:
        raw = fh.read()
    members: dict[str, bytes] = {}
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as tar:
        for member in tar.getmembers():
            if member.isfile():
                fobj = tar.extractfile(member)
                assert fobj is not None
                members[member.name] = fobj.read()
    return set(members), members


# ---------------------------------------------------------------------------
# Synchronous seed: export_program / GET .../export/
# ---------------------------------------------------------------------------


def test_sync_export_omits_member_project_admin_cannot_read(
    admin_user: Any, program: Program, project_p: Project
) -> None:
    resp = _client(admin_user).get(f"/api/v1/programs/{program.pk}/export/")

    assert resp.status_code == 200
    body = resp.content.decode()
    assert P_NAME not in body
    assert TASK_NAME not in body
    # Program-level content is still exported.
    assert PROGRAM_NAME in body


def test_sync_export_includes_member_project_when_admin_is_member(
    admin_user: Any, program: Program, project_p: Project
) -> None:
    _grant_membership(project_p, admin_user)

    resp = _client(admin_user).get(f"/api/v1/programs/{program.pk}/export/")

    assert resp.status_code == 200
    body = resp.content.decode()
    assert P_NAME in body
    assert TASK_NAME in body


def test_export_program_trusted_operator_sentinel_includes_every_project(
    program: Program, project_p: Project
) -> None:
    """The management command passes no requester: the operator path stays unrestricted."""
    doc = export_program(program)

    assert [p["name"] for p in doc["projects"]] == [P_NAME]


def test_export_program_none_requester_fails_closed(
    program: Program, project_p: Project, admin_user: Any
) -> None:
    """A deleted requester (job.requested_by is None) is not trusted."""
    _grant_membership(project_p, admin_user)

    doc = export_program(program, requesting_user=None)

    assert doc["projects"] == []


def test_export_program_deactivated_requester_fails_closed(
    program: Program, project_p: Project, admin_user: Any
) -> None:
    _grant_membership(project_p, admin_user)
    admin_user.is_active = False
    admin_user.save(update_fields=["is_active"])

    doc = export_program(program, requesting_user=admin_user)

    assert doc["projects"] == []


# ---------------------------------------------------------------------------
# Async bundle: build_and_store_program_archive
# ---------------------------------------------------------------------------


def test_async_bundle_omits_member_project_admin_cannot_read(
    admin_user: Any, program: Program, project_p: Project
) -> None:
    job = ProgramExportJob.objects.create(program=program, requested_by=admin_user)

    _run_export(job)

    names, members = _archive_members(job)
    manifest = json.loads(members["manifest.json"])
    assert manifest["project_ids"] == []
    assert not any(n.startswith(f"projects/{project_p.pk}/") for n in names)
    seed = members["seed.json"].decode()
    assert P_NAME not in seed
    assert TASK_NAME not in seed
    assert PROGRAM_NAME in seed


def test_async_bundle_includes_member_project_when_requester_is_member(
    admin_user: Any, program: Program, project_p: Project
) -> None:
    _grant_membership(project_p, admin_user)
    job = ProgramExportJob.objects.create(program=program, requested_by=admin_user)

    _run_export(job)

    names, members = _archive_members(job)
    assert json.loads(members["manifest.json"])["project_ids"] == [str(project_p.pk)]
    assert f"projects/{project_p.pk}/time_entries.json" in names
    assert P_NAME in members["seed.json"].decode()


def test_async_bundle_membership_is_evaluated_at_build_time(
    admin_user: Any, program: Program, project_p: Project
) -> None:
    """Captured requester, live check: a membership revoked while queued is not used."""
    membership = ProjectMembership.objects.create(
        project=project_p, user=admin_user, role=Role.MEMBER
    )
    job = ProgramExportJob.objects.create(program=program, requested_by=admin_user)
    membership.is_deleted = True
    membership.save(update_fields=["is_deleted"])

    _run_export(job)

    _names, members = _archive_members(job)
    assert json.loads(members["manifest.json"])["project_ids"] == []
    assert P_NAME not in members["seed.json"].decode()


def test_async_bundle_with_deleted_requester_fails_closed(
    program: Program, project_p: Project, admin_user: Any
) -> None:
    _grant_membership(project_p, admin_user)
    job = ProgramExportJob.objects.create(program=program, requested_by=None)

    storage_path, _size = build_and_store_program_archive(str(job.id))

    assert storage_path
    with default_storage.open(storage_path, "rb") as fh:
        raw = fh.read()
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as tar:
        manifest = json.loads(tar.extractfile("manifest.json").read())  # type: ignore[union-attr]
    assert manifest["project_ids"] == []


# ---------------------------------------------------------------------------
# Another admin's bundle: download and de-dupe (#4310, B1)
# ---------------------------------------------------------------------------


def test_admin_without_membership_cannot_download_another_members_job(
    admin_user: Any, owner: Any, program: Program, project_p: Project
) -> None:
    """The bundle holds P's content; only the requester may download it."""
    _grant_membership(project_p, owner)
    job = ProgramExportJob.objects.create(program=program, requested_by=owner)
    _run_export(job)

    resp = _client(admin_user).get(f"/api/v1/programs/{program.pk}/export/jobs/{job.pk}/download/")

    assert resp.status_code == 404


def test_admin_without_membership_cannot_receive_another_members_in_flight_job(
    admin_user: Any, owner: Any, program: Program, project_p: Project
) -> None:
    _grant_membership(project_p, owner)
    in_flight = ProgramExportJob.objects.create(program=program, requested_by=owner)

    resp = _client(admin_user).post(f"/api/v1/programs/{program.pk}/export/")

    assert resp.status_code == 202
    assert resp.data["id"] != str(in_flight.pk)
    assert ProgramExportJob.objects.get(pk=resp.data["id"]).requested_by_id == admin_user.pk


# ---------------------------------------------------------------------------
# Download link visibility (#4310, GAP 3)
# ---------------------------------------------------------------------------


def test_download_url_is_shown_only_to_the_requester(
    admin_user: Any, owner: Any, program: Program, project_p: Project
) -> None:
    """A link to another admin's bundle would be a dead end (404), so it is withheld."""
    job = ProgramExportJob.objects.create(
        program=program,
        requested_by=owner,
        status=ExportJobStatus.SUCCESS,
        file_path="program-exports/x.tar.gz",
        expires_at=timezone.now() + datetime.timedelta(days=1),
    )
    detail = f"/api/v1/programs/{program.pk}/export/jobs/{job.pk}/"

    assert _client(owner).get(detail).data["download_url"] is not None
    assert _client(admin_user).get(detail).data["download_url"] is None

    listing = _client(admin_user).get(f"/api/v1/programs/{program.pk}/export/jobs/")
    assert listing.status_code == 200
    rows = listing.data["results"] if isinstance(listing.data, dict) else listing.data
    assert [row["download_url"] for row in rows] == [None]
