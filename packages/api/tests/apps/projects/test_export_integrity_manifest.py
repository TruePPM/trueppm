"""Export integrity manifest (#2399, ADR-0634 §5).

Per-member SHA-256 digests + ``manifest_sha256`` in the bundle, the whole-artifact
digest on the job payload and download header, and verify-on-import.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import tarfile
from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.core.files.storage import default_storage
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.export_integrity import (
    ArchiveIntegrityError,
    canonical_manifest_bytes,
    verify_archive,
)
from trueppm_api.apps.projects.models import Calendar, Project, ProjectExportJob, Task
from trueppm_api.apps.projects.tasks import run_project_export

from .seed.test_importer import _seed

User = get_user_model()
pytestmark = pytest.mark.django_db


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(username="integ-owner", password="x", email="o@example.com")


@pytest.fixture
def project(owner: Any) -> Project:
    cal = Calendar.objects.create(name="Std")
    p = Project.objects.create(
        name="Integrity", code="INT", start_date=date(2026, 4, 1), calendar=cal
    )
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    Task.objects.create(project=p, name="One", duration=2)
    return p


def _build(project: Project, owner: Any) -> tuple[ProjectExportJob, bytes]:
    job = ProjectExportJob.objects.create(project=project, requested_by=owner)
    run_project_export.apply(args=[str(job.id)], throw=True)
    job.refresh_from_db()
    with default_storage.open(job.file_path, "rb") as fh:
        return job, fh.read()


def _members(raw: bytes) -> dict[str, bytes]:
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as tar:
        return {m.name: tar.extractfile(m).read() for m in tar if m.isfile()}  # type: ignore[union-attr]


def _repack(members: dict[str, bytes]) -> bytes:
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w:gz") as tar:
        for name, data in members.items():
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return out.getvalue()


def test_manifest_records_member_digests_and_manifest_digest(project: Project, owner: Any) -> None:
    _, raw = _build(project, owner)
    members = _members(raw)
    manifest = json.loads(members["manifest.json"])
    others = {n: d for n, d in members.items() if n != "manifest.json"}

    assert manifest["digest_algorithm"] == "sha256"
    assert set(manifest["members"]) == set(others)
    for name, data in others.items():
        assert manifest["members"][name] == hashlib.sha256(data).hexdigest()
    # Canonical form: digest field excluded, sorted keys, compact separators.
    canon = canonical_manifest_bytes(manifest)
    assert b"manifest_sha256" not in canon
    assert (
        canon
        == json.dumps(
            {k: v for k, v in manifest.items() if k != "manifest_sha256"},
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    )
    assert manifest["manifest_sha256"] == hashlib.sha256(canon).hexdigest()
    assert verify_archive(io.BytesIO(raw)).verified is True


def test_member_digests_stable_across_two_builds(project: Project, owner: Any) -> None:
    _, raw1 = _build(project, owner)
    _, raw2 = _build(project, owner)
    m1 = json.loads(_members(raw1)["manifest.json"])["members"]
    m2 = json.loads(_members(raw2)["manifest.json"])["members"]
    assert m1 == m2


def test_job_payload_and_download_header_expose_artifact_digest(
    project: Project, owner: Any
) -> None:
    job, raw = _build(project, owner)
    expected = hashlib.sha256(raw).hexdigest()
    assert job.file_sha256 == expected

    client = APIClient()
    client.force_authenticate(owner)
    base = f"/api/v1/projects/{project.pk}/export/jobs/{job.id}/"
    assert client.get(base).json()["file_sha256"] == expected
    resp = client.get(base + "download/")
    assert resp["X-Export-SHA256"] == expected
    assert hashlib.sha256(b"".join(resp.streaming_content)).hexdigest() == expected


def test_download_without_recorded_digest_omits_header(project: Project, owner: Any) -> None:
    job, _ = _build(project, owner)
    ProjectExportJob.objects.filter(pk=job.pk).update(file_sha256="")
    client = APIClient()
    client.force_authenticate(owner)
    resp = client.get(f"/api/v1/projects/{project.pk}/export/jobs/{job.id}/download/")
    assert resp.status_code == 200
    assert "X-Export-SHA256" not in resp


def test_flipped_member_byte_is_detected(project: Project, owner: Any) -> None:
    _, raw = _build(project, owner)
    members = _members(raw)
    seed = bytearray(members["seed.json"])
    seed[len(seed) // 2] ^= 0x01
    members["seed.json"] = bytes(seed)
    with pytest.raises(ArchiveIntegrityError, match=r"seed\.json"):
        verify_archive(io.BytesIO(_repack(members)))


def test_edited_manifest_is_detected(project: Project, owner: Any) -> None:
    _, raw = _build(project, owner)
    members = _members(raw)
    manifest = json.loads(members["manifest.json"])
    manifest["project_name"] = "Tampered"
    members["manifest.json"] = json.dumps(manifest).encode()
    with pytest.raises(ArchiveIntegrityError, match="manifest_sha256"):
        verify_archive(io.BytesIO(_repack(members)))


def test_injected_and_missing_members_are_detected(project: Project, owner: Any) -> None:
    _, raw = _build(project, owner)
    members = _members(raw)
    with pytest.raises(ArchiveIntegrityError, match="not listed"):
        verify_archive(io.BytesIO(_repack({**members, "evil.json": b"{}"})))
    without = {n: d for n, d in members.items() if n != "time_entries.json"}
    with pytest.raises(ArchiveIntegrityError, match="missing"):
        verify_archive(io.BytesIO(_repack(without)))


def test_truncated_archive_is_detected(project: Project, owner: Any) -> None:
    _, raw = _build(project, owner)
    with pytest.raises(ArchiveIntegrityError):
        verify_archive(io.BytesIO(raw[: len(raw) // 2]))


def test_legacy_archive_without_digests_still_verifies_as_unverified(
    project: Project, owner: Any
) -> None:
    _, raw = _build(project, owner)
    members = _members(raw)
    legacy = {n: d for n, d in members.items() if n != "manifest.json"}
    result = verify_archive(io.BytesIO(_repack(legacy)), seed_max_bytes=10**7)
    assert result.verified is False
    assert result.seed_bytes == members["seed.json"]
    # A manifest present but with no digest fields (pre-#2399 shape) is also legacy.
    old_manifest = {"archive_version": 1, "project_name": "x"}
    legacy["manifest.json"] = json.dumps(old_manifest).encode()
    assert verify_archive(io.BytesIO(_repack(legacy))).verified is False


# ---- verify-on-import: POST /programs/import/ with a bundle upload ----------------


def _program_seed() -> dict[str, Any]:
    return _seed()


def _bundle(seed: dict[str, Any], *, digest: bool, tamper: bool = False) -> bytes:
    from trueppm_api.apps.projects.export_integrity import seal_manifest

    seed_bytes = json.dumps(seed).encode()
    manifest = seal_manifest(
        {"archive_version": 1}, {"seed.json": hashlib.sha256(seed_bytes).hexdigest()}
    )
    if not digest:
        manifest = {"archive_version": 1}
    if tamper:
        seed_bytes = seed_bytes.replace(b"Atlas Platform Launch", b"Atlas Platform Launcg")
    return _repack({"seed.json": seed_bytes, "manifest.json": json.dumps(manifest).encode()})


def _post(user: Any, payload: bytes) -> Any:
    client = APIClient()
    client.force_authenticate(user)
    return client.post(
        "/api/v1/programs/import/",
        {"file": SimpleUploadedFile("bundle.tar.gz", payload, content_type="application/gzip")},
        format="multipart",
    )


def test_import_rejects_tampered_bundle_and_persists_nothing(owner: Any) -> None:
    from trueppm_api.apps.projects.models import Program

    resp = _post(owner, _bundle(_program_seed(), digest=True, tamper=True))
    assert resp.status_code == 400
    assert "integrity" in json.dumps(resp.json()).lower()
    assert not Program.objects.filter(code="atlas").exists()


def test_import_accepts_intact_bundle(owner: Any) -> None:
    resp = _post(owner, _bundle(_program_seed(), digest=True))
    assert resp.status_code == 202, resp.content


def test_import_accepts_legacy_bundle_without_digest(owner: Any) -> None:
    resp = _post(owner, _bundle(_program_seed(), digest=False))
    assert resp.status_code == 202, resp.content


def test_import_rejects_truncated_gzip(owner: Any) -> None:
    resp = _post(owner, gzip.compress(b"not a tar")[:20])
    assert resp.status_code == 400


def test_import_rejects_bundle_without_seed_json(owner: Any) -> None:
    manifest = {"archive_version": 1}
    resp = _post(owner, _repack({"manifest.json": json.dumps(manifest).encode()}))
    assert resp.status_code == 400
    assert "seed.json" in json.dumps(resp.json())


def test_import_rejects_seed_json_over_the_upload_cap(owner: Any, settings: Any) -> None:
    from trueppm_api.apps.projects.models import Program

    settings.SEED_MAX_UPLOAD_MB = 1
    big = {**_program_seed(), "padding": "x" * (2 * 1024 * 1024)}
    resp = _post(owner, _bundle(big, digest=True))
    assert resp.status_code == 400
    assert "too large" in json.dumps(resp.json()).lower()
    assert not Program.objects.filter(code="atlas").exists()


def test_dry_run_rejects_tampered_bundle(owner: Any) -> None:
    client = APIClient()
    client.force_authenticate(owner)
    payload = _bundle(_program_seed(), digest=True, tamper=True)
    resp = client.post(
        "/api/v1/programs/import/validate/",
        {"file": SimpleUploadedFile("b.tar.gz", payload, content_type="application/gzip")},
        format="multipart",
    )
    assert resp.status_code == 400
    assert "integrity" in json.dumps(resp.json()).lower()


# ---- decompression-bomb bounds ----------------------------------------------------


def _bomb(size: int) -> bytes:
    """A tiny gzip whose single member inflates to ``size`` zero bytes."""
    return _repack({"seed.json": b"\0" * size})


def test_decompression_bomb_is_refused() -> None:
    raw = _bomb(8 * 1024 * 1024)
    assert len(raw) < 64 * 1024  # the point: tiny on the wire
    with pytest.raises(ArchiveIntegrityError, match="decompressed size"):
        verify_archive(io.BytesIO(raw), max_decompressed_bytes=1024 * 1024)


def test_member_count_over_the_cap_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    from trueppm_api.apps.projects import export_integrity

    monkeypatch.setattr(export_integrity, "_MAX_MEMBERS", 5)
    raw = _repack({f"m{i}.json": b"{}" for i in range(6)})
    with pytest.raises(ArchiveIntegrityError, match="more than 5 members"):
        verify_archive(io.BytesIO(raw))


def test_import_rejects_decompression_bomb_over_http(
    owner: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from trueppm_api.apps.projects import export_integrity
    from trueppm_api.apps.projects.models import Program

    monkeypatch.setattr(export_integrity, "_DECOMPRESSED_FACTOR", 1)
    monkeypatch.setattr(export_integrity, "_MIN_DECOMPRESSED_BYTES", 1024 * 1024)
    # 5 MiB default upload cap -> cap of 5 MiB inflated; this inflates to 12 MiB.
    # seed.json over the seed cap would trip first, so spread it across members.
    raw = _repack({f"pad{i}.bin": b"\0" * (3 * 1024 * 1024) for i in range(4)})
    resp = _post(owner, raw)
    assert resp.status_code == 400
    assert "decompressed" in json.dumps(resp.json()).lower()
    assert not Program.objects.exists()


def _skipped_entry_archive(typeflag: bytes, size: int) -> bytes:
    """gzip(tar) holding ONE entry of ``typeflag`` declaring ``size`` bytes of zeros.

    Built by streaming zero chunks so the construction itself stays cheap; tar
    skips (or, for ``x``/``L``, buffers) the data of such an entry without ever
    handing it to the per-member hashing loop.
    """
    info = tarfile.TarInfo("skipped")
    info.type = typeflag
    info.size = size
    out = io.BytesIO()
    with gzip.GzipFile(fileobj=out, mode="wb") as gz:
        gz.write(info.tobuf(tarfile.GNU_FORMAT))
        chunk = b"\0" * (1024 * 1024)
        left = size
        while left > 0:
            gz.write(chunk[: min(left, len(chunk))])
            left -= len(chunk)
        gz.write(b"\0" * (-size % 512))
        gz.write(b"\0" * 1024)
    return out.getvalue()


@pytest.mark.parametrize("typeflag", [b"Z", b"x", b"L"])
def test_skipped_or_extended_header_entries_are_charged_to_the_cap(typeflag: bytes) -> None:
    raw = _skipped_entry_archive(typeflag, 40 * 1024 * 1024)
    assert len(raw) < 256 * 1024
    with pytest.raises(ArchiveIntegrityError, match="decompressed size"):
        verify_archive(io.BytesIO(raw), max_decompressed_bytes=4 * 1024 * 1024)


def test_import_rejects_unknown_typeflag_bomb_over_http(
    owner: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from trueppm_api.apps.projects import export_integrity
    from trueppm_api.apps.projects.models import Program

    monkeypatch.setattr(export_integrity, "_DECOMPRESSED_FACTOR", 1)
    monkeypatch.setattr(export_integrity, "_MIN_DECOMPRESSED_BYTES", 1024 * 1024)
    resp = _post(owner, _skipped_entry_archive(b"Z", 40 * 1024 * 1024))
    assert resp.status_code == 400
    assert "decompressed" in json.dumps(resp.json()).lower()
    assert not Program.objects.exists()


def test_legit_bundle_passes_under_default_caps(project: Project, owner: Any) -> None:
    _, raw = _build(project, owner)
    assert verify_archive(io.BytesIO(raw), seed_max_bytes=5 * 1024 * 1024).verified is True
