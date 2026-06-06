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
    assert any("ghost" in e for e in resp.data["errors"])
    assert not Program.objects.filter(code="atlas").exists()


def test_import_rejects_malformed_file(user: Any) -> None:
    upload = SimpleUploadedFile("bad.json", b"{not json", content_type="application/json")
    resp = _client(user).post(IMPORT_URL, data={"file": upload}, format="multipart")
    assert resp.status_code == 400


def test_import_does_not_mint_users(user: Any) -> None:
    # create_users is forced off on the endpoint — assignees stay unresolved.
    _client(user).post(IMPORT_URL, data=_seed(), format="json")
    assert not User.objects.filter(username="seed-alex").exists()
    assert Task.objects.get(name="Build auth").assignee is None


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
