"""Async project export bundle builder (ADR-0219, #1266).

Produces a single ``.tar.gz`` for one project containing:

- ``manifest.json``   — archive version + project identity + generated_at
- ``seed.json``       — the canonical JSON seed (ADR-0109, round-trips through the importer)
- ``msproject.xml``   — MS Project XML (MSPDI); opens natively in MS Project. The
  binary ``.mpp`` format is **not** produced — the in-tree MPXJ integration reads
  ``.mpp`` but cannot write it, so we ship the round-trippable XML interchange
  format instead (ADR-0219; honest degradation, no fabrication).
- ``attachments/<id>/<name>`` + ``attachments/index.json`` — task attachment binaries
- ``time_entries.json`` — logged effort against the project's tasks
- ``history/*.json``    — django-simple-history audit rows for the project's schedule
- ``counts.json``       — per-member row counts

The ``run_project_export`` Celery task calls :func:`build_and_store_project_archive`;
this module holds no Celery or HTTP concerns so it stays unit-testable in isolation.

Memory: each table streams row-by-row (``.iterator()``) into a per-table spooled temp
file, so peak memory is one row plus the gzip window, never a whole table (the history
tables in particular are unbounded). Attachment blobs stream straight from storage into
the tar. Mirrors ``workspace/export.py`` (ADR-0174).
"""

from __future__ import annotations

import io
import json
import logging
import tarfile
import tempfile
from typing import Any

from django.core.files import File
from django.core.files.storage import default_storage
from django.core.serializers.json import DjangoJSONEncoder
from django.db.models import QuerySet
from django.utils import timezone

logger = logging.getLogger(__name__)

ARCHIVE_VERSION = 1
EXPORT_DIR = "project-exports"
# Spooled buffers keep small tables in RAM and spill larger ones to disk.
_SPOOL_MAX_BYTES = 8 * 1024 * 1024


def _add_json(tar: tarfile.TarFile, name: str, payload: Any) -> None:
    """Add a small in-memory ``payload`` as a JSON member (manifest/counts/index)."""
    data = json.dumps(payload, cls=DjangoJSONEncoder, indent=2).encode("utf-8")
    info = tarfile.TarInfo(name=name)
    info.size = len(data)
    info.mtime = int(timezone.now().timestamp())
    tar.addfile(info, io.BytesIO(data))


def _add_bytes(tar: tarfile.TarFile, name: str, payload: bytes) -> None:
    """Add a raw byte payload (e.g. the MS Project XML) as a tar member."""
    info = tarfile.TarInfo(name=name)
    info.size = len(payload)
    info.mtime = int(timezone.now().timestamp())
    tar.addfile(info, io.BytesIO(payload))


def _add_table(tar: tarfile.TarFile, name: str, qs: QuerySet[Any]) -> int:
    """Stream a queryset into the tar as a JSON array; return the row count.

    Rows are pulled with ``.iterator()`` and written one at a time into a spooled
    temp file, so an arbitrarily large table (e.g. task history) never lands in
    memory all at once. The tar member size is taken from the finished buffer.
    """
    count = 0
    with tempfile.SpooledTemporaryFile(max_size=_SPOOL_MAX_BYTES, mode="w+b") as buf:
        buf.write(b"[")
        first = True
        for row in qs.values().iterator(chunk_size=2000):
            if not first:
                buf.write(b",")
            buf.write(json.dumps(row, cls=DjangoJSONEncoder).encode("utf-8"))
            first = False
            count += 1
        buf.write(b"]")
        size = buf.tell()
        buf.seek(0)
        info = tarfile.TarInfo(name=name)
        info.size = size
        info.mtime = int(timezone.now().timestamp())
        tar.addfile(info, buf)
    return count


def _add_history(
    tar: tarfile.TarFile, project_id: str, task_ids: list[Any], counts: dict[str, int]
) -> None:
    """Stream django-simple-history rows scoped to one project.

    Task/Project/Risk/Sprint historical rows carry the project id directly.
    Dependency has no project FK (it links two tasks), so its history is scoped by
    the predecessor task belonging to this project.
    """
    from trueppm_api.apps.projects.models import Dependency, Project, Risk, Sprint, Task

    counts["history.tasks"] = _add_table(
        tar, "history/tasks.json", Task.history.filter(project_id=project_id)
    )
    counts["history.project"] = _add_table(
        tar, "history/project.json", Project.history.filter(id=project_id)
    )
    counts["history.dependencies"] = _add_table(
        tar, "history/dependencies.json", Dependency.history.filter(predecessor_id__in=task_ids)
    )
    counts["history.risks"] = _add_table(
        tar, "history/risks.json", Risk.history.filter(project_id=project_id)
    )
    counts["history.sprints"] = _add_table(
        tar, "history/sprints.json", Sprint.history.filter(project_id=project_id)
    )


def _add_attachments(tar: tarfile.TarFile, project_id: str, counts: dict[str, int]) -> None:
    """Copy the project's task attachment binaries into the archive."""
    from trueppm_api.apps.projects.models import TaskAttachment

    metadata: list[dict[str, Any]] = []
    copied = 0
    qs = TaskAttachment.objects.filter(task__project_id=project_id, is_deleted=False)
    for att in qs.iterator():
        # External-link attachments have no binary — record the link, no tar member.
        if not att.file:
            metadata.append(
                {
                    "id": str(att.id),
                    "task_id": str(att.task_id),
                    "external_url": att.external_url,
                    "external_title": att.external_title,
                }
            )
            continue
        stored_name = att.file.name or ""
        base_name = stored_name.rsplit("/", 1)[-1] or f"{att.id}.bin"
        archive_path = f"attachments/{att.id}/{base_name}"
        entry: dict[str, Any] = {
            "id": str(att.id),
            "task_id": str(att.task_id),
            "filename": att.file_name or base_name,
            "file_mime": att.file_mime,
            "archive_path": archive_path,
        }
        metadata.append(entry)
        try:
            with att.file.open("rb") as fh:
                info = tarfile.TarInfo(name=archive_path)
                info.size = att.file.size
                info.mtime = int(timezone.now().timestamp())
                tar.addfile(info, fh)
            copied += 1
        except (FileNotFoundError, OSError, ValueError):
            # A missing blob (storage drift) must not abort the whole export;
            # the metadata row still records that the attachment existed.
            logger.warning("project export: attachment %s file unavailable, metadata only", att.id)
            entry["missing"] = True
    _add_json(tar, "attachments/index.json", metadata)
    counts["attachments"] = copied


def build_and_store_project_archive(job_id: str) -> tuple[str, int]:
    """Build the project ``.tar.gz`` and store it; return (storage path, bytes).

    The archive is assembled on local disk (the tar streams to a temp file and each
    table streams into the tar) then handed to ``default_storage`` so S3/MinIO and
    FileSystemStorage are both supported. Mirrors
    ``workspace.export.build_and_store_archive`` (ADR-0174).
    """
    from trueppm_api.apps.msproject.exporter import export_project_xml
    from trueppm_api.apps.projects.models import ProjectExportJob, Task
    from trueppm_api.apps.projects.seed.exporter import dump_seed, export_project
    from trueppm_api.apps.timetracking.models import TimeEntry

    job = ProjectExportJob.objects.select_related("project").get(pk=job_id)
    project = job.project
    project_id = str(project.id)
    task_ids = list(Task.objects.filter(project_id=project_id).values_list("id", flat=True))

    counts: dict[str, int] = {}
    with tempfile.NamedTemporaryFile(suffix=".tar.gz") as tmp:
        with tarfile.open(fileobj=tmp, mode="w:gz") as tar:
            _add_json(
                tar,
                "manifest.json",
                {
                    "archive_version": ARCHIVE_VERSION,
                    "generated_at": timezone.now(),
                    "project_id": project_id,
                    "project_code": project.code or "",
                    "project_name": project.name,
                    # Documented degradation: the MS Project artifact is XML (MSPDI),
                    # not binary .mpp — the reader-only MPXJ integration cannot write
                    # .mpp (ADR-0219).
                    "msproject_format": "msdpi-xml",
                },
            )
            # Canonical JSON seed (round-trips through the importer, ADR-0109).
            _add_bytes(tar, "seed.json", dump_seed(export_project(project)).encode("utf-8"))
            # MS Project XML (MSPDI). Degrade gracefully if generation fails so the
            # rest of the bundle still ships.
            try:
                _add_bytes(tar, "msproject.xml", export_project_xml(project_id))
                counts["msproject_xml"] = 1
            except Exception:
                logger.warning(
                    "project export: MS Project XML generation failed for %s",
                    project_id,
                    exc_info=True,
                )
                counts["msproject_xml"] = 0
            counts["time_entries"] = _add_table(
                tar, "time_entries.json", TimeEntry.objects.filter(task__project_id=project_id)
            )
            _add_history(tar, project_id, task_ids, counts)
            _add_attachments(tar, project_id, counts)
            _add_json(tar, "counts.json", counts)
        tmp.flush()
        size = tmp.tell()
        tmp.seek(0)
        storage_path = default_storage.save(f"{EXPORT_DIR}/{job_id}.tar.gz", File(tmp))
    logger.info("project export %s stored at %s (%d bytes)", job_id, storage_path, size)
    return storage_path, size
