"""API tests for the program import/export endpoints (issues #615, #616).

Covers authentication, the multipart and JSON-body import paths, validation
rejection, the create-users-off safety rule, and member-gated export.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIClient

from trueppm_api.apps.projects.models import Program, Task
from trueppm_api.apps.projects.seed import import_seed

from .test_importer import _seed

pytestmark = pytest.mark.django_db

User = get_user_model()

IMPORT_URL = "/api/v1/programs/import/"


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def user() -> Any:
    return User.objects.create_user(username="importer", password="pw")


# --- import ----------------------------------------------------------------


def test_import_requires_auth() -> None:
    resp = APIClient().post(IMPORT_URL, data=_seed(), format="json")
    assert resp.status_code in (401, 403)


def test_import_json_body_creates_program(user: Any) -> None:
    resp = _client(user).post(IMPORT_URL, data=_seed(), format="json")
    assert resp.status_code == 201, resp.content
    assert resp.data["code"] == "atlas"
    program = Program.objects.get(code="atlas", is_deleted=False)
    assert program.projects.count() == 2
    # caller became OWNER
    assert program.created_by == user


def test_import_multipart_file_creates_program(user: Any) -> None:
    upload = SimpleUploadedFile(
        "atlas.json", json.dumps(_seed()).encode("utf-8"), content_type="application/json"
    )
    resp = _client(user).post(IMPORT_URL, data={"file": upload}, format="multipart")
    assert resp.status_code == 201, resp.content
    assert Program.objects.filter(code="atlas").exists()


def test_import_rejects_invalid_seed(user: Any) -> None:
    seed = _seed()
    seed["projects"][0]["tasks"][0]["assignee"] = "ghost"
    resp = _client(user).post(IMPORT_URL, data=seed, format="json")
    assert resp.status_code == 400
    # Line-level validation report: `detail` is the list of messages (#1325).
    assert any("ghost" in e for e in resp.data["detail"])
    assert not Program.objects.filter(code="atlas").exists()


def test_import_rejects_malformed_file(user: Any) -> None:
    upload = SimpleUploadedFile("bad.json", b"{not json", content_type="application/json")
    resp = _client(user).post(IMPORT_URL, data={"file": upload}, format="multipart")
    assert resp.status_code == 400


def test_import_rejects_oversized_file(user: Any, settings: Any) -> None:
    settings.SEED_MAX_UPLOAD_MB = 0  # any non-empty upload now exceeds the cap
    upload = SimpleUploadedFile(
        "big.json", json.dumps(_seed()).encode("utf-8"), content_type="application/json"
    )
    resp = _client(user).post(IMPORT_URL, data={"file": upload}, format="multipart")
    assert resp.status_code == 400
    # Single-message failure: `detail` is a plain string (#1325).
    assert "too large" in resp.data["detail"]
    assert not Program.objects.filter(code="atlas").exists()


def test_import_does_not_mint_users(user: Any) -> None:
    # create_users is forced off on the endpoint — assignees stay unresolved.
    _client(user).post(IMPORT_URL, data=_seed(), format="json")
    assert not User.objects.filter(username="seed-alex").exists()
    assert Task.objects.get(name="Build auth").assignee is None


def test_project_export_round_trips_through_program_import(user: Any) -> None:
    """A #967 project seed export re-imports through POST /programs/import/ (#1611).

    This is the exact contract the create-from-import "TruePPM" format tile relies
    on (ADR-0220): a project exported as canonical JSON re-materializes as a fresh
    program (the #967 single-project wrapper) with freshly-minted ids, never
    clobbering the source. Uploaded as multipart, mirroring the web flow.
    """
    program = import_seed(_seed(), owner=user, create_users=False)
    source_project = program.projects.order_by("name").first()
    assert source_project is not None
    source_task_ids = set(Task.objects.filter(project=source_project).values_list("id", flat=True))
    programs_before = Program.objects.filter(is_deleted=False).count()

    client = _client(user)
    export_resp = client.get(f"/api/v1/projects/{source_project.pk}/export/")
    assert export_resp.status_code == 200, export_resp.content
    body = b"".join(export_resp.streaming_content) if export_resp.streaming else export_resp.content

    upload = SimpleUploadedFile("project.json", body, content_type="application/json")
    import_resp = client.post(IMPORT_URL, data={"file": upload}, format="multipart")
    assert import_resp.status_code == 201, import_resp.content

    # A brand-new program was created (the synthesized single-project wrapper),
    # distinct from the source — not an in-place overwrite of it.
    assert Program.objects.filter(is_deleted=False).count() == programs_before + 1
    new_program = Program.objects.get(pk=import_resp.data["id"])
    assert new_program.pk != program.pk
    assert new_program.projects.count() == 1

    new_project = new_program.projects.get()
    assert new_project.name == source_project.name
    assert new_project.pk != source_project.pk
    # id remapping: the re-imported tasks are fresh rows, not the source ids.
    new_task_ids = set(Task.objects.filter(project=new_project).values_list("id", flat=True))
    assert new_task_ids
    assert new_task_ids.isdisjoint(source_task_ids)


# --- export ----------------------------------------------------------------


@pytest.fixture
def imported_program(user: Any) -> Program:
    return import_seed(_seed(), owner=user, create_users=True)


def _export_url(program: Program) -> str:
    return f"/api/v1/programs/{program.pk}/export/"


def test_export_requires_auth(imported_program: Program) -> None:
    resp = APIClient().get(_export_url(imported_program))
    assert resp.status_code in (401, 403)


def test_export_member_downloads_json(user: Any, imported_program: Program) -> None:
    resp = _client(user).get(_export_url(imported_program))
    assert resp.status_code == 200
    assert resp["Content-Type"] == "application/json"
    assert "attachment" in resp["Content-Disposition"]
    body = json.loads(b"".join(resp.streaming_content).decode() if resp.streaming else resp.content)
    assert body["program"]["slug"] == "atlas"


def test_export_non_member_denied(imported_program: Program) -> None:
    stranger = User.objects.create_user(username="stranger", password="pw")
    resp = _client(stranger).get(_export_url(imported_program))
    assert resp.status_code in (403, 404)
