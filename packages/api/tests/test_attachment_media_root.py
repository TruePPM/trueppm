"""MEDIA_ROOT actually receives an attachment upload (#3184).

``test_attachment_storage_check.py`` covers the boot guard — whether the
deployment is *allowed* to use local storage. It never writes a file, which is
why the deployment it was guarding could pass every check and then fail at the
first upload: ``MEDIA_ROOT`` was set nowhere, so Django resolved upload paths
against the process working directory (``/app`` in the image), whose filesystem
is read-only on both supported production paths.

These tests exercise the write itself, end to end through the real
``FileField``/``default_storage`` path, under the opted-in local-storage
configuration.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest
from django.core.files.storage import default_storage
from django.core.files.uploadedfile import SimpleUploadedFile

from trueppm_api.apps.projects.models import Calendar, Project, Task, TaskAttachment

pytestmark = pytest.mark.django_db


@pytest.fixture
def task() -> Task:
    calendar = Calendar.objects.create(name="Std")
    project = Project.objects.create(name="P", start_date=date(2026, 3, 1), calendar=calendar)
    return Task.objects.create(project=project, name="T", duration=1)


def test_media_root_is_an_absolute_path(settings: pytest.FixtureRequest) -> None:
    """The root cause of #3184, asserted directly.

    Django's default is ``""``, which makes every upload path relative to the
    process working directory — so the storage location follows whoever started
    the process rather than the deployment's own configuration.
    """
    raw = settings.MEDIA_ROOT  # type: ignore[attr-defined]
    assert str(raw) != "", "MEDIA_ROOT is Django's empty default — uploads follow the CWD"
    assert Path(raw).is_absolute()


def test_attachment_writes_under_media_root_and_reads_back(
    settings: pytest.FixtureRequest, tmp_path: Path, task: Task
) -> None:
    settings.MEDIA_ROOT = str(tmp_path)  # type: ignore[attr-defined]

    attachment = TaskAttachment.objects.create(
        task=task,
        file=SimpleUploadedFile("plan.txt", b"critical path", content_type="text/plain"),
        file_name="plan.txt",
        file_size=13,
        file_mime="text/plain",
    )

    # On disk, under MEDIA_ROOT — not under the process working directory.
    on_disk = tmp_path / attachment.file.name
    assert on_disk.is_file(), f"{attachment.file.name} did not land under MEDIA_ROOT"
    assert on_disk.read_bytes() == b"critical path"

    # And back out through the storage API a download would use.
    attachment.refresh_from_db()
    with attachment.file.open("rb") as handle:
        assert handle.read() == b"critical path"


def test_attachment_key_is_partitioned_by_task_and_row(
    settings: pytest.FixtureRequest, tmp_path: Path, task: Task
) -> None:
    """Two uploads of the same filename coexist — the row UUID prefixes the key.

    Worth asserting against a real filesystem rather than the storage key alone:
    a collision here would silently overwrite one operator's attachment with
    another's, and only a real write can prove the two paths differ on disk.
    """
    settings.MEDIA_ROOT = str(tmp_path)  # type: ignore[attr-defined]

    first = TaskAttachment.objects.create(
        task=task,
        file=SimpleUploadedFile("plan.txt", b"one", content_type="text/plain"),
        file_name="plan.txt",
    )
    second = TaskAttachment.objects.create(
        task=task,
        file=SimpleUploadedFile("plan.txt", b"two", content_type="text/plain"),
        file_name="plan.txt",
    )

    assert first.file.name != second.file.name
    assert (tmp_path / first.file.name).read_bytes() == b"one"
    assert (tmp_path / second.file.name).read_bytes() == b"two"
    assert str(task.id) in first.file.name


def test_default_storage_location_follows_media_root(
    settings: pytest.FixtureRequest, tmp_path: Path
) -> None:
    """``default_storage`` must track a MEDIA_ROOT change, not a cached value.

    The seed-import path writes through ``default_storage`` directly rather than
    through a FileField, so it has to resolve the same root the attachment
    upload does.
    """
    settings.MEDIA_ROOT = str(tmp_path)  # type: ignore[attr-defined]
    key = default_storage.save("seed-imports/probe.json", SimpleUploadedFile("p.json", b"{}"))
    try:
        assert (tmp_path / key).is_file()
    finally:
        default_storage.delete(key)
