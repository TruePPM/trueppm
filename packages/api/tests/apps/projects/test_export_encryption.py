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

from . import age_reference
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
    # Flipping a byte of the salt derives a different key, so the X25519 stanza no
    # longer unwraps (the MAC is never reached; the MAC-only case is tested below).
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


def _with_line(blob: bytes, prefix: bytes, replacement: bytes) -> bytes:
    lines = blob.split(b"\n")
    at = next(i for i, line in enumerate(lines) if line.startswith(prefix))
    lines[at] = replacement
    return b"\n".join(lines)


def _crafted_headers() -> dict[str, bytes]:
    """Hostile headers an import upload can carry; see the fuzz test below."""
    blob = _encrypt(b"x" * 1000, passphrase_encryption(PASSPHRASE))
    lines = blob.split(b"\n")
    scrypt = next(line for line in lines if line.startswith(b"-> trueppm-scrypt"))
    salt = scrypt.split(b" ")[2]
    cases = {
        # 32 zero bytes: a low-order X25519 point, so exchange() raises ValueError.
        "low_order_share": _with_line(
            blob, b"-> X25519", b"-> X25519 " + export_crypto._b64(b"\0" * 32).encode()
        ),
        # int() refuses a 5,000-digit string with ValueError before any range check.
        "huge_work_factor": _with_line(
            blob, b"-> trueppm-scrypt", b"-> trueppm-scrypt " + salt + b" " + b"1" * 5000
        ),
        "zero_work_factor": _with_line(
            blob, b"-> trueppm-scrypt", b"-> trueppm-scrypt " + salt + b" 0"
        ),
        "empty_salt": _with_line(blob, b"-> trueppm-scrypt", b"-> trueppm-scrypt  10"),
        "bad_base64_share": _with_line(blob, b"-> X25519", b"-> X25519 !!!!"),
        "non_ascii_share": _with_line(blob, b"-> X25519", b"-> X25519 \xff\xfe"),
        "empty_stanza": _with_line(blob, b"-> X25519", b"-> "),
        "short_wrapped_key": blob.replace(lines[2], b"AAAA", 1),
        "empty_mac": blob.split(b"\n--- ")[0] + b"\n--- \n",
        "header_only": blob[: blob.index(b"\n", blob.index(b"\n--- ") + 1) + 1],
        "magic_only": export_crypto.AGE_MAGIC,
        "empty": b"",
    }
    # Deterministic byte flips across the whole file, header and payload alike.
    for n in range(60):
        flipped = bytearray(blob)
        at = (n * 7919) % len(flipped)
        flipped[at] ^= 1 << (n % 8)
        cases[f"flip_{n}"] = bytes(flipped)
    return cases


_CRAFTED = _crafted_headers()


@pytest.mark.parametrize("name", sorted(_CRAFTED))
def test_only_export_crypto_error_escapes_a_crafted_file(name: str) -> None:
    # The import endpoint maps ExportCryptoError to a 400; anything else is a 500
    # any authenticated account could trigger with a crafted upload.
    with pytest.raises(ExportCryptoError):
        _decrypt(_CRAFTED[name])


# Exactly three full chunks, so a cut between chunks lands on a chunk boundary.
_THREE_CHUNKS = b"A" * (64 * 1024 * 3)
_SEALED_CHUNK = 64 * 1024 + 16


def _split(blob: bytes) -> tuple[bytes, bytes, list[bytes]]:
    """Return (header incl. MAC line, payload nonce, sealed chunks)."""
    mac_end = blob.index(b"\n", blob.index(b"\n--- ") + 1) + 1
    nonce, rest = blob[mac_end : mac_end + 16], blob[mac_end + 16 :]
    chunks = [rest[i : i + _SEALED_CHUNK] for i in range(0, len(rest), _SEALED_CHUNK)]
    return blob[:mac_end], nonce, chunks


def test_header_mac_alone_catches_an_added_stanza() -> None:
    # An extra stanza leaves both real stanzas intact, so the file key still
    # unwraps: only the header MAC can notice the header changed.
    blob = _encrypt(b"payload", passphrase_encryption(PASSPHRASE))
    at = blob.index(b"\n---") + 1
    tampered = blob[:at] + b"-> grease x\n\n" + blob[at:]
    with pytest.raises(ExportCryptoError, match="Wrong passphrase, or the file is damaged"):
        _decrypt(tampered)


def test_truncation_exactly_at_a_chunk_boundary_is_refused() -> None:
    header, nonce, chunks = _split(_encrypt(_THREE_CHUNKS, passphrase_encryption(PASSPHRASE)))
    assert len(chunks) == 3
    # Chunk 2 was sealed as "not last", so it cannot pass for the final chunk.
    with pytest.raises(ExportCryptoError, match="truncated"):
        _decrypt(header + nonce + chunks[0] + chunks[1])


def test_reordered_chunks_are_refused() -> None:
    header, nonce, chunks = _split(_encrypt(_THREE_CHUNKS, passphrase_encryption(PASSPHRASE)))
    with pytest.raises(ExportCryptoError, match="damaged"):
        _decrypt(header + nonce + chunks[1] + chunks[0] + chunks[2])


@pytest.mark.parametrize("size", [10, 64 * 1024])
def test_trailing_bytes_are_refused(size: int) -> None:
    blob = _encrypt(b"t" * size, passphrase_encryption(PASSPHRASE))
    with pytest.raises(ExportCryptoError, match="damaged"):
        _decrypt(blob + b"\x00")


def test_payload_bit_flip_is_refused() -> None:
    blob = _encrypt(_THREE_CHUNKS, passphrase_encryption(PASSPHRASE))
    flipped = blob[:-5] + bytes([blob[-5] ^ 1]) + blob[-4:]
    with pytest.raises(ExportCryptoError, match="damaged"):
        _decrypt(flipped)


@pytest.mark.parametrize("log_n", [18, 19])
def test_work_factor_above_what_we_write_is_refused_before_scrypt(
    monkeypatch: pytest.MonkeyPatch, log_n: int
) -> None:
    blob = _encrypt(b"data", passphrase_encryption(PASSPHRASE))
    crafted = blob.replace(b" 10\n", f" {log_n}\n".encode(), 1)

    def _no_scrypt(*args: object, **kwargs: object) -> None:
        raise AssertionError("scrypt ran for a header work factor above the cap")

    monkeypatch.setattr(export_crypto, "_derive_private_key", _no_scrypt)
    with pytest.raises(ExportCryptoError, match="damaged"):
        _decrypt(crafted)


@pytest.mark.parametrize("size", [0, 5, 64 * 1024, 64 * 1024 * 2 + 3])
def test_recipient_mode_opens_with_an_independent_age_decryptor(size: int) -> None:
    key, recipient = _recipient()
    data = bytes(range(256)) * (size // 256) + b"r" * (size % 256)
    blob = _encrypt(data, recipient_encryption(recipient))
    assert age_reference.decrypt(blob, key) == data


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
    from trueppm_api.apps.projects.models import Program
    from trueppm_api.apps.projects.tasks import run_program_import

    resp = _import(owner, _encrypted_bundle(), PASSPHRASE)
    assert resp.status_code == 202, resp.content
    # The 202 only says a job was queued: run it, as the worker would, and check
    # that the decrypted seed is what landed.
    run_program_import.apply(args=[str(resp.data["import_request_id"])])
    program = Program.objects.get(code="atlas", is_deleted=False)
    assert program.name == _seed()["program"]["name"]
    assert program.projects.count() == len(_seed()["projects"])
    from trueppm_api.apps.projects.models import Risk

    assert Risk.objects.filter(project__program=program, title="Vendor lock-in").exists()


@pytest.mark.django_db
@pytest.mark.parametrize("url", ["/api/v1/programs/import/", "/api/v1/programs/import/validate/"])
def test_crafted_low_order_share_is_a_400_not_a_500(owner: Any, url: str) -> None:
    payload = _with_line(
        _encrypted_bundle(), b"-> X25519", b"-> X25519 " + export_crypto._b64(b"\0" * 32).encode()
    )
    upload = SimpleUploadedFile("bundle.tar.gz.age", payload, "application/octet-stream")
    resp = _client(owner).post(url, {"file": upload, "passphrase": PASSPHRASE}, format="multipart")
    assert resp.status_code == 400, resp.content
    # The same message a wrong passphrase gets, so the response is not an oracle.
    assert "Wrong passphrase" in json.dumps(resp.json())


def _age(model: Any, job: Any, **fields: Any) -> None:
    model.objects.filter(pk=job.pk).update(**fields)
    job.refresh_from_db()


@pytest.mark.django_db
def test_drain_fails_an_abandoned_job_and_unblocks_a_new_request(
    owner: Any, project: Project, monkeypatch: pytest.MonkeyPatch
) -> None:
    from datetime import timedelta

    from django.utils import timezone

    from trueppm_api.apps.projects import tasks as project_tasks

    monkeypatch.setattr(project_tasks.run_project_export, "delay", lambda _jid: None)
    resp = _start(owner, project, {"encryption": {"mode": "passphrase", "passphrase": PASSPHRASE}})
    job = ProjectExportJob.objects.get(pk=resp.json()["id"])
    # A worker claimed it, then was lost: RUNNING forever, params still on the row.
    stale = timezone.now() - timedelta(minutes=project_tasks.EXPORT_STALE_JOB_MINUTES + 1)
    _age(ProjectExportJob, job, status=ExportJobStatus.RUNNING, started_at=stale)
    assert job.encryption_params
    assert _start(owner, project).status_code == 409

    project_tasks._do_drain_project_exports()
    job.refresh_from_db()
    assert job.status == ExportJobStatus.FAILED
    assert job.encryption_params == {}
    assert job.encryption_mode == "passphrase"
    assert _start(owner, project).status_code == 202


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("status", "age_field", "minutes", "reaped"),
    [
        (ExportJobStatus.PENDING, "created_at", 121, True),
        (ExportJobStatus.PENDING, "created_at", 60, False),
        (ExportJobStatus.RUNNING, "started_at", 121, True),
        # Created long ago but its latest attempt started recently: still live.
        (ExportJobStatus.RUNNING, "started_at", 5, False),
        (ExportJobStatus.SUCCESS, "created_at", 600, False),
    ],
)
def test_stale_bound_applies_to_both_export_grains(
    owner: Any,
    project: Project,
    monkeypatch: pytest.MonkeyPatch,
    status: str,
    age_field: str,
    minutes: int,
    reaped: bool,
) -> None:
    from datetime import timedelta

    from django.utils import timezone

    from trueppm_api.apps.projects import tasks as project_tasks
    from trueppm_api.apps.projects.models import Program, ProgramExportJob

    assert project_tasks.EXPORT_STALE_JOB_MINUTES == 120
    monkeypatch.setattr(project_tasks.run_project_export, "delay", lambda _jid: None)
    monkeypatch.setattr(project_tasks.run_program_export, "delay", lambda _jid: None)
    program = Program.objects.create(name="Sealed program", code="sealp")
    params = {"recipient": "age1x", "salt": "s", "log_n": 10}
    old = timezone.now() - timedelta(minutes=600)
    when = timezone.now() - timedelta(minutes=minutes)
    jobs = [
        (ProjectExportJob, ProjectExportJob.objects.create(project=project, requested_by=owner)),
        (ProgramExportJob, ProgramExportJob.objects.create(program=program, requested_by=owner)),
    ]
    for model, job in jobs:
        fields: dict[str, Any] = {"status": status, "encryption_params": params}
        fields["created_at"] = old if age_field == "started_at" else when
        if age_field == "started_at":
            fields["started_at"] = when
        _age(model, job, **fields)

    project_tasks._do_drain_project_exports()
    project_tasks._do_drain_program_exports()
    for _model, job in jobs:
        job.refresh_from_db()
        assert (job.status == ExportJobStatus.FAILED) is reaped
        assert (job.encryption_params == {}) is reaped


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


# ---- what is retained (passphrase never reaches a stored digest) ------------------


def _key_row(user: Any, key: str) -> Any:
    from trueppm_api.apps.idempotency.models import IdempotencyKey

    return IdempotencyKey.objects.get(user=user, key=key)


@pytest.mark.django_db
@pytest.mark.parametrize("grain", ["project", "program"])
def test_no_stored_digest_depends_on_the_passphrase(
    owner: Any, project: Project, grain: str, caplog: pytest.LogCaptureFixture
) -> None:
    """Vary only the passphrase: every stored digest and row must come out the same."""
    from trueppm_api.apps.access.models import ProgramMembership
    from trueppm_api.apps.projects.models import Program, ProgramExportJob

    if grain == "program":
        program = Program.objects.create(name="Sealed P", code="SEALP")
        ProgramMembership.objects.create(program=program, user=owner, role=Role.OWNER)
        url, jobs = f"/api/v1/programs/{program.pk}/export/", ProgramExportJob.objects
    else:
        url, jobs = f"/api/v1/projects/{project.pk}/export/", ProjectExportJob.objects
    client = _client(owner)
    other = "a different passphrase entirely"
    for key, phrase in (("k-one", PASSPHRASE), ("k-two", other)):
        resp = client.post(
            url,
            {"encryption": {"mode": "passphrase", "passphrase": phrase}},
            format="json",
            HTTP_IDEMPOTENCY_KEY=key,
        )
        assert resp.status_code == 202, resp.content
        # Finish the build so the second request is not refused as in-flight.
        jobs.filter(pk=resp.json()["id"]).update(status=ExportJobStatus.SUCCESS)

    first, second = _key_row(owner, "k-one"), _key_row(owner, "k-two")
    assert first.request_hash == second.request_hash
    for row in (first, second):
        dumped = json.dumps(
            [row.request_hash, row.response_body, row.response_headers], default=str
        )
        assert PASSPHRASE not in dumped and other not in dumped
    assert PASSPHRASE not in caplog.text and other not in caplog.text


def _multipart_request(passphrase: str) -> Any:
    from rest_framework.request import Request
    from rest_framework.test import APIRequestFactory

    upload = SimpleUploadedFile("b.tar.gz.age", b"age-encryption.org/v1\nsame bytes")
    raw = APIRequestFactory().post(
        "/api/v1/programs/import/", {"file": upload, "passphrase": passphrase}
    )
    return Request(raw)


def _json_request(body: dict[str, Any]) -> Any:
    from rest_framework.request import Request
    from rest_framework.test import APIRequestFactory

    return Request(APIRequestFactory().post("/api/v1/projects/x/export/", body, format="json"))


@pytest.mark.parametrize("build", ["json", "multipart"])
def test_request_digests_ignore_the_passphrase(build: str) -> None:
    """The idempotency hash and the agent-chain payload hash both drop the passphrase."""
    from trueppm_api.apps.agents.services import hash_request_payload
    from trueppm_api.apps.idempotency.mixins import IdempotencyMixin

    def make(phrase: str) -> Any:
        if build == "json":
            return _json_request({"encryption": {"mode": "passphrase", "passphrase": phrase}})
        return _multipart_request(phrase)

    for digest in (IdempotencyMixin._compute_request_hash, hash_request_payload):
        assert digest(make(PASSPHRASE)) == digest(make("another passphrase here"))
    # The rest of the body still counts: a different mode is a different request.
    if build == "json":
        assert IdempotencyMixin._compute_request_hash(
            _json_request({"encryption": {"mode": "recipient", "recipient": "age1x"}})
        ) != IdempotencyMixin._compute_request_hash(make(PASSPHRASE))


def test_a_body_without_a_secret_is_hashed_byte_for_byte() -> None:
    from trueppm_api.core.request_secrets import redact_secret_fields

    body = b'{"b": 1,  "a": [2]}'
    assert redact_secret_fields(body, "application/json") is body
    assert redact_secret_fields(b"a=1&b=2", "application/x-www-form-urlencoded") == b"a=1&b=2"
    assert (
        redact_secret_fields(b"a=1&passphrase=hunter2", "application/x-www-form-urlencoded")
        == b"a=1"
    )


@pytest.mark.django_db
def test_finished_job_drops_its_encryption_params(owner: Any, project: Project) -> None:
    resp = _start(owner, project, {"encryption": {"mode": "passphrase", "passphrase": PASSPHRASE}})
    job = ProjectExportJob.objects.get(pk=resp.json()["id"])
    assert set(job.encryption_params) == {"recipient", "salt", "log_n"}
    run_project_export.apply(args=[str(job.id)], throw=True)
    job.refresh_from_db()
    assert job.status == ExportJobStatus.SUCCESS
    assert job.encryption_mode == "passphrase"
    assert job.encryption_params == {}


@pytest.mark.django_db
def test_in_flight_conflict_is_refused_before_any_scrypt(
    owner: Any, project: Project, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert _start(owner, project).status_code == 202  # a plaintext build is now in flight

    def _no_scrypt(*args: object, **kwargs: object) -> None:
        raise AssertionError("scrypt ran for a request the in-flight check refuses")

    monkeypatch.setattr(export_crypto, "_derive_private_key", _no_scrypt)
    resp = _start(owner, project, {"encryption": {"mode": "passphrase", "passphrase": PASSPHRASE}})
    assert resp.status_code == 409
