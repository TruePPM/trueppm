"""Opt-in encryption of export bundles at rest (#2400, ADR-0634 §5).

Covers the age v1 writer and reader, what the job row may retain (public values
only, never the passphrase), the in-flight de-dupe against differing encryption,
the encrypted download's name and headers, and import with a passphrase.
"""

from __future__ import annotations

import hashlib
import io
import json
import tarfile
from datetime import date
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from django.contrib.auth import get_user_model
from django.core.files.storage import default_storage
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects import export_crypto
from trueppm_api.apps.projects.export_crypto import (
    ExportCryptoError,
    bech32_encode,
    decrypt_stream,
    encrypt_stream,
    parse_recipient,
    passphrase_encryption,
    recipient_encryption,
)
from trueppm_api.apps.projects.models import (
    Calendar,
    ExportJobStatus,
    Project,
    ProjectExportJob,
    Task,
)
from trueppm_api.apps.projects.tasks import run_project_export

from .seed.test_importer import _seed

User = get_user_model()
PASSPHRASE = "correct horse battery staple"


@pytest.fixture(autouse=True)
def _cheap_scrypt(monkeypatch: pytest.MonkeyPatch) -> None:
    # The production work factor (2**17) costs ~128 MiB per derivation; the format
    # carries log_n, so a small one exercises exactly the same code path.
    monkeypatch.setattr(export_crypto, "SCRYPT_LOG_N", 10)


def _recipient() -> tuple[X25519PrivateKey, str]:
    key = X25519PrivateKey.generate()
    return key, bech32_encode("age", key.public_key().public_bytes_raw())


def _encrypt(data: bytes, encryption: Any) -> bytes:
    out = io.BytesIO()
    encrypt_stream(io.BytesIO(data), out, encryption)
    return out.getvalue()


def _decrypt(blob: bytes, passphrase: str = PASSPHRASE) -> bytes:
    out = io.BytesIO()
    decrypt_stream(io.BytesIO(blob), out, passphrase)
    return out.getvalue()


# ---- format ---------------------------------------------------------------------


@pytest.mark.parametrize("size", [0, 1, 64 * 1024, 64 * 1024 * 2 + 3])
def test_passphrase_round_trip_across_chunk_boundaries(size: int) -> None:
    data = bytes(range(256)) * (size // 256) + b"x" * (size % 256)
    blob = _encrypt(data, passphrase_encryption(PASSPHRASE))
    assert blob.startswith(export_crypto.AGE_MAGIC)
    assert _decrypt(blob) == data


def test_wrong_passphrase_and_damage_read_the_same() -> None:
    blob = _encrypt(b"payload" * 1000, passphrase_encryption(PASSPHRASE))
    with pytest.raises(ExportCryptoError, match="Wrong passphrase"):
        _decrypt(blob, "not the passphrase at all")
    # Flipping a byte of the salt is caught by the header MAC, not silently accepted.
    salt_at = blob.index(b"trueppm-scrypt ") + len(b"trueppm-scrypt ")
    flipped = blob[:salt_at] + (b"B" if blob[salt_at : salt_at + 1] != b"B" else b"C")
    flipped += blob[salt_at + 1 :]
    with pytest.raises(ExportCryptoError):
        _decrypt(flipped)


def test_truncated_payload_is_refused() -> None:
    blob = _encrypt(b"z" * (64 * 1024 + 10), passphrase_encryption(PASSPHRASE))
    with pytest.raises(ExportCryptoError, match="truncated"):
        _decrypt(blob[:-30])


def test_header_work_factor_is_capped_on_read() -> None:
    blob = _encrypt(b"data", passphrase_encryption(PASSPHRASE))
    crafted = blob.replace(b" 10\n", b" 30\n", 1)
    with pytest.raises(ExportCryptoError, match="damaged"):
        _decrypt(crafted)


def test_recipient_mode_decrypts_with_the_private_key_only() -> None:
    key, recipient = _recipient()
    encryption = recipient_encryption(recipient)
    blob = _encrypt(b"offsite archive", encryption)
    assert b"trueppm-scrypt" not in blob
    # A recipient file is opened with the age identity, never a server passphrase.
    with pytest.raises(ExportCryptoError, match="age public key"):
        _decrypt(blob)
    assert parse_recipient(recipient) == key.public_key().public_bytes_raw()


def test_passphrase_encryption_retains_only_public_values() -> None:
    encryption = passphrase_encryption(PASSPHRASE)
    assert encryption.mode == "passphrase"
    assert set(encryption.params) == {"recipient", "salt", "log_n"}
    assert PASSPHRASE not in json.dumps(encryption.params)
    assert encryption.params["recipient"].startswith("age1")
    # Fresh salt per export: two exports under one passphrase share no key.
    assert passphrase_encryption(PASSPHRASE).params != encryption.params


@pytest.mark.parametrize(
    ("value", "message"),
    [
        ("age1notakey", "Not a valid age public key"),
        ("AGE-SECRET-KEY-1QQQQ", "secret key"),
        (bech32_encode("xyz", b"\x00" * 32), "Not a valid age public key"),
    ],
)
def test_recipient_validation(value: str, message: str) -> None:
    with pytest.raises(ExportCryptoError, match=message):
        parse_recipient(value)


def test_short_passphrase_is_refused() -> None:
    with pytest.raises(ExportCryptoError, match="at least 12"):
        passphrase_encryption("short")


# ---- API ------------------------------------------------------------------------


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(username="enc-owner", password="x", email="e@example.com")


@pytest.fixture
def project(owner: Any) -> Project:
    cal = Calendar.objects.create(name="Std")
    p = Project.objects.create(
        name="Sealed", code="SEAL", start_date=date(2026, 4, 1), calendar=cal
    )
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    Task.objects.create(project=p, name="One", duration=2)
    return p


def _client(user: Any) -> APIClient:
    client = APIClient()
    client.force_authenticate(user)
    return client


def _start(user: Any, project: Project, body: dict[str, Any] | None = None) -> Any:
    return _client(user).post(f"/api/v1/projects/{project.pk}/export/", body or {}, format="json")


@pytest.mark.django_db
def test_post_without_body_stays_plaintext(owner: Any, project: Project) -> None:
    resp = _start(owner, project)
    assert resp.status_code == 202
    assert resp.json()["encryption_mode"] == "none"


@pytest.mark.django_db
def test_passphrase_is_never_stored_and_bundle_decrypts(owner: Any, project: Project) -> None:
    resp = _start(owner, project, {"encryption": {"mode": "passphrase", "passphrase": PASSPHRASE}})
    assert resp.status_code == 202, resp.content
    body = resp.json()
    assert body["encryption_mode"] == "passphrase"
    assert PASSPHRASE not in json.dumps(body)

    job = ProjectExportJob.objects.get(pk=body["id"])
    assert PASSPHRASE not in json.dumps(job.encryption_params)
    run_project_export.apply(args=[str(job.id)], throw=True)
    job.refresh_from_db()
    assert job.status == ExportJobStatus.SUCCESS
    assert job.file_path.endswith(".tar.gz.age")
    with default_storage.open(job.file_path, "rb") as fh:
        stored = fh.read()
    # Only ciphertext reaches storage; the digest is of the decrypted .tar.gz.
    assert stored.startswith(export_crypto.AGE_MAGIC)
    assert job.file_size == len(stored)
    plain = _decrypt(stored)
    assert hashlib.sha256(plain).hexdigest() == job.file_sha256
    with tarfile.open(fileobj=io.BytesIO(plain), mode="r:gz") as tar:
        manifest = json.loads(tar.extractfile("manifest.json").read())  # type: ignore[union-attr]
    assert manifest["encryption"] == "passphrase"

    dl = _client(owner).get(f"/api/v1/projects/{project.pk}/export/jobs/{job.id}/download/")
    assert dl.status_code == 200
    assert 'filename="project-SEAL.tar.gz.age"' in dl["Content-Disposition"]
    assert dl["Content-Type"] == "application/octet-stream"
    assert dl["X-Export-Encryption"] == "passphrase"
    assert dl["X-Export-SHA256"] == job.file_sha256


@pytest.mark.django_db
def test_recipient_export_and_dedupe_rules(owner: Any, project: Project) -> None:
    _, recipient = _recipient()
    first = _start(owner, project, {"encryption": {"mode": "recipient", "recipient": recipient}})
    assert first.status_code == 202, first.content
    job = ProjectExportJob.objects.get(pk=first.json()["id"])
    assert job.encryption_params == {"recipient": recipient}

    # The same recipient reuses the in-flight build.
    again = _start(owner, project, {"encryption": {"mode": "recipient", "recipient": recipient}})
    assert again.status_code == 202 and again.json()["id"] == first.json()["id"]
    # A plaintext or passphrase request is never answered with that build.
    assert _start(owner, project).status_code == 409
    assert (
        _start(
            owner, project, {"encryption": {"mode": "passphrase", "passphrase": PASSPHRASE}}
        ).status_code
        == 409
    )


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("encryption", "field"),
    [
        ({"mode": "passphrase", "passphrase": "short"}, "passphrase"),
        ({"mode": "passphrase"}, "passphrase"),
        ({"mode": "recipient", "recipient": "nope"}, "recipient"),
        ({"mode": "recipient"}, "recipient"),
    ],
)
def test_invalid_encryption_options_are_400(
    owner: Any, project: Project, encryption: dict[str, Any], field: str
) -> None:
    resp = _start(owner, project, {"encryption": encryption})
    assert resp.status_code == 400
    assert field in json.dumps(resp.json())
    assert not ProjectExportJob.objects.exists()


@pytest.mark.django_db
def test_member_below_admin_cannot_queue_an_encrypted_export(project: Project) -> None:
    member = User.objects.create_user(username="enc-member", password="x")
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    resp = _start(member, project, {"encryption": {"mode": "passphrase", "passphrase": PASSPHRASE}})
    assert resp.status_code == 403


# ---- import -----------------------------------------------------------------------


def _encrypted_bundle(passphrase: str = PASSPHRASE) -> bytes:
    seed = json.dumps(_seed()).encode()
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w:gz") as tar:
        info = tarfile.TarInfo("seed.json")
        info.size = len(seed)
        tar.addfile(info, io.BytesIO(seed))
    return _encrypt(out.getvalue(), passphrase_encryption(passphrase))


def _import(user: Any, payload: bytes, passphrase: str | None) -> Any:
    data: dict[str, Any] = {
        "file": SimpleUploadedFile("bundle.tar.gz.age", payload, "application/octet-stream")
    }
    if passphrase is not None:
        data["passphrase"] = passphrase
    return _client(user).post("/api/v1/programs/import/", data, format="multipart")


@pytest.mark.django_db
def test_import_decrypts_with_the_passphrase(owner: Any) -> None:
    resp = _import(owner, _encrypted_bundle(), PASSPHRASE)
    assert resp.status_code == 202, resp.content


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("passphrase", "message"),
    [(None, "Enter its passphrase"), ("wrong passphrase here", "Wrong passphrase")],
)
def test_import_refuses_missing_or_wrong_passphrase(
    owner: Any, passphrase: str | None, message: str
) -> None:
    from trueppm_api.apps.projects.models import Program

    resp = _import(owner, _encrypted_bundle(), passphrase)
    assert resp.status_code == 400
    assert message in json.dumps(resp.json())
    assert not Program.objects.filter(code="atlas").exists()
