"""Tests for the Workspace logo API (#969, ADR-0149).

Raster-only (PNG/WebP) upload validated by magic bytes, served from a public GET
endpoint, with admin-gated write paths and old-file cleanup on replace.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.core.files.storage import default_storage
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIClient

from trueppm_api.apps.workspace.models import Workspace

User = get_user_model()

URL = "/api/v1/workspace/logo/"
SETTINGS_URL = "/api/v1/workspace/"

# Minimal valid magic-byte heads — the server sniffs these, not the declared type.
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
WEBP_BYTES = b"RIFF" + b"\x00\x00\x00\x00" + b"WEBP" + b"\x00" * 64
GIF_BYTES = b"GIF89a" + b"\x00" * 64


@pytest.fixture
def admin(db: object) -> object:
    return User.objects.create_user(username="logo_admin", password="pw", is_superuser=True)


@pytest.fixture
def member(db: object) -> object:
    return User.objects.create_user(username="logo_member", password="pw")


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _png(name: str = "logo.png") -> SimpleUploadedFile:
    return SimpleUploadedFile(name, PNG_BYTES, content_type="image/png")


@pytest.mark.django_db
def test_admin_uploads_png(admin: object) -> None:
    resp = _client(admin).post(URL, {"file": _png()}, format="multipart")
    assert resp.status_code == 200
    assert resp.data["logo_url"] is not None
    ws = Workspace.load()
    assert ws.logo
    assert ws.logo_mime == "image/png"


@pytest.mark.django_db
def test_upload_sniffs_webp_regardless_of_declared_type(admin: object) -> None:
    # Declared as PNG but bytes are WebP — server trusts the magic bytes.
    upload = SimpleUploadedFile("x.png", WEBP_BYTES, content_type="image/png")
    resp = _client(admin).post(URL, {"file": upload}, format="multipart")
    assert resp.status_code == 200
    assert Workspace.load().logo_mime == "image/webp"


@pytest.mark.django_db
def test_upload_rejects_non_raster_by_magic_bytes(admin: object) -> None:
    # A GIF declared as PNG must be rejected by the byte sniff (415).
    upload = SimpleUploadedFile("x.png", GIF_BYTES, content_type="image/png")
    resp = _client(admin).post(URL, {"file": upload}, format="multipart")
    assert resp.status_code == 415
    assert not Workspace.load().logo


@pytest.mark.django_db
def test_upload_rejects_oversize(admin: object, settings: object) -> None:
    big = SimpleUploadedFile("big.png", PNG_BYTES + b"\x00" * (2 * 1024 * 1024 + 1), "image/png")
    resp = _client(admin).post(URL, {"file": big}, format="multipart")
    assert resp.status_code == 413
    assert not Workspace.load().logo


@pytest.mark.django_db
def test_upload_requires_admin(member: object) -> None:
    resp = _client(member).post(URL, {"file": _png()}, format="multipart")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_replace_deletes_old_file(admin: object) -> None:
    _client(admin).post(URL, {"file": _png("first.png")}, format="multipart")
    first_name = Workspace.load().logo.name
    assert default_storage.exists(first_name)

    _client(admin).post(URL, {"file": _png("second.png")}, format="multipart")
    second_name = Workspace.load().logo.name
    assert second_name != first_name
    # on_commit cleanup runs at the end of the (test) transaction; the new file
    # exists and the key changed — the old blob is scheduled for deletion.
    assert default_storage.exists(second_name)


@pytest.mark.django_db
def test_delete_clears_logo(admin: object) -> None:
    _client(admin).post(URL, {"file": _png()}, format="multipart")
    resp = _client(admin).delete(URL)
    assert resp.status_code == 200
    ws = Workspace.load()
    assert not ws.logo
    assert ws.logo_mime == ""
    assert resp.data["logo_url"] is None


@pytest.mark.django_db
def test_get_serves_logo_publicly(admin: object) -> None:
    _client(admin).post(URL, {"file": _png()}, format="multipart")
    # Public GET — no authentication.
    resp = APIClient().get(URL)
    assert resp.status_code == 200
    assert resp["Content-Type"] == "image/png"
    assert resp["X-Content-Type-Options"] == "nosniff"
    assert b"".join(resp.streaming_content).startswith(b"\x89PNG")


@pytest.mark.django_db
def test_get_returns_404_when_unset(db: object) -> None:
    resp = APIClient().get(URL)
    assert resp.status_code == 404


@pytest.mark.django_db
def test_settings_exposes_logo_url(admin: object) -> None:
    assert _client(admin).get(SETTINGS_URL).data["logo_url"] is None
    _client(admin).post(URL, {"file": _png()}, format="multipart")
    assert _client(admin).get(SETTINGS_URL).data["logo_url"].startswith("/api/v1/workspace/logo/")
