"""Bundled-fixture catalog and download endpoint (#2490).

The feature's promise is that a user can read exactly what "Load demo data"
will write before it writes it. These tests hold that promise to its two literal
claims: the bytes you download are the bytes on disk, and the digest advertised
beside them describes those same bytes.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from trueppm_api.apps.projects.seed.samples import SAMPLES, sample_metadata

pytestmark = pytest.mark.django_db

User = get_user_model()

CATALOG_URL = "/api/v1/programs/samples/"


def download_url(key: str) -> str:
    return reverse("program-download-sample", kwargs={"key": key})


@pytest.fixture(autouse=True)
def _clear_throttle_cache() -> Any:
    """Throttle history lives in the LocMem cache; clear it around each test so a
    drained bucket never leaves a later test pre-throttled."""
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def api(db: Any) -> APIClient:
    user = User.objects.create_user(username="auditor", email="auditor@example.com")
    client = APIClient()
    client.force_authenticate(user=user)
    return client


# ── Permissions ───────────────────────────────────────────────────────────────
# Asserted per-route rather than once, so a future change to one action's
# permission list cannot silently flip the other.


def test_catalog_requires_authentication() -> None:
    assert APIClient().get(CATALOG_URL).status_code in {
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
    }


def test_download_requires_authentication() -> None:
    response = APIClient().get(download_url("atlas-platform-launch"))
    assert response.status_code in {
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
    }


def test_catalog_lists_every_registered_sample(api: APIClient) -> None:
    response = api.get(CATALOG_URL)
    assert response.status_code == status.HTTP_200_OK
    assert {entry["key"] for entry in response.json()} == set(SAMPLES)


def test_catalog_advertises_provenance(api: APIClient) -> None:
    """Each entry carries the size, digest and counts an auditor needs."""
    entries = {entry["key"]: entry for entry in api.get(CATALOG_URL).json()}

    for key, sample in SAMPLES.items():
        entry = entries[key]
        raw = sample.path.read_bytes()
        assert entry["available"] is True
        assert entry["filename"] == sample.filename
        assert entry["size_bytes"] == len(raw)
        assert entry["sha256"] == hashlib.sha256(raw).hexdigest()
        assert entry["download_url"] == download_url(key)
        # Bundled fixtures are valid documents, so every count is a real number.
        assert entry["project_count"] >= 1
        assert entry["task_count"] >= 1
        assert entry["schema_version"] is not None


# ── The security surface: the key never becomes a path ────────────────────────


@pytest.mark.parametrize(
    "key",
    [
        "nope",
        "..",
        "../settings",
        "..%2F..%2Fsettings",
        "atlas-platform-launch%00",
        "/etc/passwd",
        "atlas-platform-launch.json",
    ],
)
def test_unknown_or_traversal_shaped_key_is_404(api: APIClient, key: str) -> None:
    assert api.get(f"/api/v1/programs/samples/{key}/download/").status_code == (
        status.HTTP_404_NOT_FOUND
    )


def test_unknown_key_touches_no_filesystem(api: APIClient) -> None:
    """The 404 is a dict miss, not a failed file open.

    This asserts the *construction*, not the status code: a view that built a
    path from the key and let the open fail would also return 404 while being
    one bug away from serving an arbitrary file.
    """
    with patch.object(Path, "open") as opened, patch.object(Path, "read_bytes") as read:
        response = api.get("/api/v1/programs/samples/nope/download/")

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert not opened.called
    assert not read.called


def test_registry_paths_resolve_inside_the_fixtures_directory() -> None:
    """Guards the registry itself — a bad entry, not bad input (A3)."""
    seeds_dir = (
        Path(__file__).resolve().parents[4]
        / "src"
        / "trueppm_api"
        / "apps"
        / "projects"
        / "fixtures"
        / "seeds"
    ).resolve()

    for sample in SAMPLES.values():
        resolved = sample.path.resolve()
        assert resolved.parent == seeds_dir
        assert resolved.is_file()


# ── Fidelity ──────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("key", sorted(SAMPLES))
def test_download_is_byte_for_byte_the_committed_fixture(api: APIClient, key: str) -> None:
    """Bytes, not JSON-equality: a re-serialized document would break the digest."""
    response = api.get(download_url(key))
    assert response.status_code == status.HTTP_200_OK

    body = b"".join(response.streaming_content)
    assert body == SAMPLES[key].path.read_bytes()


@pytest.mark.parametrize("key", sorted(SAMPLES))
def test_download_headers(api: APIClient, key: str) -> None:
    response = api.get(download_url(key))

    # Filename comes from the registry entry, never interpolated from the key —
    # parametrized so a key/filename mismatch would fail here.
    assert SAMPLES[key].filename in response.headers["Content-Disposition"]
    assert "attachment" in response.headers["Content-Disposition"]
    assert response.headers["Content-Type"] == "application/json"
    assert response.headers["X-Content-Type-Options"] == "nosniff"


def test_etag_matches_the_advertised_digest(api: APIClient) -> None:
    """If these can differ, a client's verification is theatre."""
    key = "atlas-platform-launch"
    advertised = next(e for e in api.get(CATALOG_URL).json() if e["key"] == key)["sha256"]
    response = api.get(download_url(key))

    computed = hashlib.sha256(b"".join(response.streaming_content)).hexdigest()
    assert response.headers["ETag"] == f'"{advertised}"'
    assert computed == advertised


def test_conditional_request_returns_304(api: APIClient) -> None:
    key = "atlas-platform-launch"
    etag = api.get(download_url(key)).headers["ETag"]

    response = api.get(download_url(key), HTTP_IF_NONE_MATCH=etag)
    assert response.status_code == status.HTTP_304_NOT_MODIFIED

    # Weak validators and wildcards are honored too.
    assert (
        api.get(download_url(key), HTTP_IF_NONE_MATCH=f"W/{etag}").status_code
        == status.HTTP_304_NOT_MODIFIED
    )
    assert (
        api.get(download_url(key), HTTP_IF_NONE_MATCH="*").status_code
        == status.HTTP_304_NOT_MODIFIED
    )
    assert (
        api.get(download_url(key), HTTP_IF_NONE_MATCH='"stale"').status_code == status.HTTP_200_OK
    )


# ── The round trip: the listing is a promise, not a label ─────────────────────


def test_downloaded_bytes_validate_and_import_with_the_advertised_counts(
    api: APIClient,
) -> None:
    """Download → dry-run → import, and the result matches what was advertised.

    The last assertion is the one that makes the catalog trustworthy: the counts
    shown next to the download describe what importing that download actually
    produces.
    """
    key = "helios-crm-replacement"
    advertised = next(e for e in api.get(CATALOG_URL).json() if e["key"] == key)
    body = b"".join(api.get(download_url(key)).streaming_content)

    report = api.post(
        "/api/v1/programs/import/validate/",
        data=json.loads(body),
        format="json",
    )
    assert report.status_code == status.HTTP_200_OK
    assert report.json()["valid"] is True
    assert report.json()["project_count"] == advertised["project_count"]
    assert report.json()["task_count"] == advertised["task_count"]

    created = api.post("/api/v1/programs/import/", data=json.loads(body), format="json")
    assert created.status_code == status.HTTP_202_ACCEPTED

    # Import is async now (ADR-0726), so run the queued job rather than dropping
    # the end-to-end assertion: the point of this test is that the *downloaded
    # bytes* really materialize the counts the catalog advertised.
    from trueppm_api.apps.projects.models import Project, Task
    from trueppm_api.apps.projects.tasks import run_program_import

    run_program_import.apply(args=[str(created.json()["import_request_id"])])

    program_id = created.json()["program_id"]
    assert (
        Project.objects.filter(program_id=program_id, is_deleted=False).count()
        == advertised["project_count"]
    )
    assert (
        Task.objects.filter(project__program_id=program_id, is_deleted=False).count()
        == advertised["task_count"]
    )


# ── Degraded states ───────────────────────────────────────────────────────────


def test_missing_file_is_listed_as_unavailable_not_hidden(api: APIClient, tmp_path: Path) -> None:
    """A broken install is reported, not silently omitted from the catalog."""
    ghost = tmp_path / "not-there.json"
    with patch(
        "trueppm_api.apps.projects.seed.samples.Sample.path",
        new_callable=lambda: property(lambda self: ghost),
    ):
        entries = api.get(CATALOG_URL).json()
        assert entries, "the catalog still lists its registered samples"
        assert all(entry["available"] is False for entry in entries)
        assert all(entry["sha256"] is None for entry in entries)

        assert api.get(download_url("atlas-platform-launch")).status_code == (
            status.HTTP_404_NOT_FOUND
        )


def test_unparseable_fixture_keeps_its_bytes_downloadable(tmp_path: Path) -> None:
    """State 3: failing to summarize a file is no reason to withhold it.

    The bytes are what an auditor came for; the counts are the convenience.
    """
    broken = tmp_path / "broken.json"
    broken.write_bytes(b"{ not json at all")

    with patch(
        "trueppm_api.apps.projects.seed.samples.Sample.path",
        new_callable=lambda: property(lambda self: broken),
    ):
        meta = sample_metadata(SAMPLES["atlas-platform-launch"])

    assert meta.available is True
    assert meta.size_bytes == len(b"{ not json at all")
    assert meta.sha256 == hashlib.sha256(b"{ not json at all").hexdigest()
    assert meta.project_count is None
    assert meta.schema_version is None


# ── Memoization ───────────────────────────────────────────────────────────────


def test_metadata_is_memoized_but_notices_an_edited_fixture(tmp_path: Path) -> None:
    """One parse per (path, mtime, size); a fixture edit invalidates it."""
    fixture = tmp_path / "sample.json"
    payload = {"schema_version": "2.0", "program": {"slug": "x", "name": "X"}, "projects": []}
    fixture.write_text(json.dumps(payload), encoding="utf-8")

    with patch(
        "trueppm_api.apps.projects.seed.samples.Sample.path",
        new_callable=lambda: property(lambda self: fixture),
    ):
        sample = SAMPLES["atlas-platform-launch"]
        first = sample_metadata(sample)

        with patch.object(Path, "read_bytes", wraps=fixture.read_bytes) as read:
            second = sample_metadata(sample)
        assert not read.called, "second call is served from the memo"
        assert second == first

        # Editing the file changes size and mtime, so the memo key misses.
        fixture.write_text(json.dumps({**payload, "projects": []} | {"pad": "x" * 50}))
        assert sample_metadata(sample).size_bytes != first.size_bytes
