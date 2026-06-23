"""Full-workspace archive builder (ADR-0174, #641).

Produces a single ``.tar.gz`` containing the entire workspace as JSON plus the
binary attachment files, and stores it via the configured default storage. The
``run_workspace_export`` task calls :func:`build_and_store_archive`; this module
holds no Celery or HTTP concerns so it stays unit-testable in isolation.

Memory: each table is streamed row-by-row (``.iterator()``) into a per-table
spooled temp file, which is then added to the tar — so peak memory is one row
plus the gzip window, never a whole table (the history tables in particular are
unbounded). Attachment blobs are streamed straight from storage into the tar.

Security: credential-bearing rows (API tokens, integration credentials, webhook
secrets) and the invite secret columns (``token_hash``/``email_token``) are
deliberately excluded — an export is a data backup, not a secrets dump.
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
EXPORT_DIR = "workspace-exports"
# Spooled buffers keep small tables in RAM and spill larger ones to disk.
_SPOOL_MAX_BYTES = 8 * 1024 * 1024


def _add_json(tar: tarfile.TarFile, name: str, payload: Any) -> None:
    """Add a small in-memory ``payload`` as a JSON member (manifest/counts/index)."""
    data = json.dumps(payload, cls=DjangoJSONEncoder, indent=2).encode("utf-8")
    info = tarfile.TarInfo(name=name)
    info.size = len(data)
    info.mtime = int(timezone.now().timestamp())
    tar.addfile(info, io.BytesIO(data))


def _add_table(
    tar: tarfile.TarFile, name: str, qs: QuerySet[Any], *, exclude: tuple[str, ...] = ()
) -> int:
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
            if exclude:
                for field in exclude:
                    row.pop(field, None)
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


def _table_specs() -> list[tuple[str, QuerySet[Any], tuple[str, ...]]]:
    """The (filename, queryset, excluded-fields) set serialized into the archive.

    Built lazily so model imports happen only when an export actually runs (this
    module is imported by the Celery task, never at app load).
    """
    from trueppm_api.apps.projects.models import (
        BacklogItem,
        Baseline,
        BaselineTask,
        Dependency,
        Program,
        Project,
        ProjectCustomField,
        Risk,
        RiskComment,
        RiskTask,
        Sprint,
        SprintRetro,
        Task,
        TaskComment,
    )
    from trueppm_api.apps.resources.models import (
        ProjectResource,
        Resource,
        ResourceSkill,
        Skill,
        TaskResource,
        TaskSkillRequirement,
    )
    from trueppm_api.apps.taskruns.models import TaskRun
    from trueppm_api.apps.workspace.models import (
        Group,
        GroupMembership,
        GroupProject,
        WorkspaceInvite,
        WorkspaceMembership,
    )

    return [
        # Workspace organisation
        ("workspace/members.json", WorkspaceMembership.objects.all(), ()),
        # Invite secrets are excluded — a backup must not leak live invite tokens.
        ("workspace/invites.json", WorkspaceInvite.objects.all(), ("token_hash", "email_token")),
        ("workspace/groups.json", Group.objects.all(), ()),
        ("workspace/group_memberships.json", GroupMembership.objects.all(), ()),
        ("workspace/group_projects.json", GroupProject.objects.all(), ()),
        # Resources (workspace-global flat tables)
        ("resources/resources.json", Resource.objects.all(), ()),
        ("resources/skills.json", Skill.objects.all(), ()),
        ("resources/resource_skills.json", ResourceSkill.objects.all(), ()),
        ("resources/project_resources.json", ProjectResource.objects.all(), ()),
        ("resources/task_resources.json", TaskResource.objects.all(), ()),
        ("resources/task_skill_requirements.json", TaskSkillRequirement.objects.all(), ()),
        # Programs
        ("programs/programs.json", Program.objects.all(), ()),
        ("programs/backlog_items.json", BacklogItem.objects.all(), ()),
        # Projects and the schedule
        ("projects/projects.json", Project.objects.all(), ()),
        ("projects/tasks.json", Task.objects.all(), ()),
        ("projects/dependencies.json", Dependency.objects.all(), ()),
        ("projects/baselines.json", Baseline.objects.all(), ()),
        ("projects/baseline_tasks.json", BaselineTask.objects.all(), ()),
        ("projects/sprints.json", Sprint.objects.all(), ()),
        ("projects/sprint_retros.json", SprintRetro.objects.all(), ()),
        ("projects/risks.json", Risk.objects.all(), ()),
        ("projects/risk_tasks.json", RiskTask.objects.all(), ()),
        ("projects/risk_comments.json", RiskComment.objects.all(), ()),
        ("projects/task_comments.json", TaskComment.objects.all(), ()),
        ("projects/custom_fields.json", ProjectCustomField.objects.all(), ()),
        ("projects/task_runs.json", TaskRun.objects.all(), ()),
    ]


def _add_history(tar: tarfile.TarFile, counts: dict[str, int]) -> None:
    """Stream django-simple-history audit rows for the tracked models."""
    from trueppm_api.apps.projects.models import Dependency, Project, Risk, Sprint, Task

    for label, model in (
        ("tasks", Task),
        ("projects", Project),
        ("dependencies", Dependency),
        ("risks", Risk),
        ("sprints", Sprint),
    ):
        history_mgr = getattr(model, "history", None)
        if history_mgr is None:  # pragma: no cover - all five are tracked today
            continue
        counts[f"history.{label}"] = _add_table(tar, f"history/{label}.json", history_mgr.all())


def _add_attachments(tar: tarfile.TarFile, counts: dict[str, int]) -> None:
    """Copy task attachment binaries into the archive under ``attachments/``."""
    from trueppm_api.apps.projects.models import TaskAttachment

    metadata: list[dict[str, Any]] = []
    copied = 0
    for att in TaskAttachment.objects.all().iterator():
        stored_name = att.file.name or ""
        base_name = stored_name.rsplit("/", 1)[-1] or f"{att.id}.bin"
        archive_path = f"attachments/{att.id}/{base_name}"
        entry: dict[str, Any] = {
            "id": str(att.id),
            "task_id": str(att.task_id),
            "filename": getattr(att, "file_name", "") or base_name,
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
            logger.warning("export: attachment %s file unavailable, metadata only", att.id)
            entry["missing"] = True
    _add_json(tar, "attachments/index.json", metadata)
    counts["attachments"] = copied


def build_and_store_archive(job_id: str) -> tuple[str, int]:
    """Build the full-workspace ``.tar.gz`` and store it; return (storage path, bytes).

    The archive is assembled on local disk (the tar streams to a temp file and
    each table streams into the tar) then handed to ``default_storage`` so S3/MinIO
    and FileSystemStorage are both supported.
    """
    from trueppm_api.apps.workspace.models import Workspace

    counts: dict[str, int] = {}
    with tempfile.NamedTemporaryFile(suffix=".tar.gz") as tmp:
        with tarfile.open(fileobj=tmp, mode="w:gz") as tar:
            workspace = Workspace.load()
            _add_json(
                tar,
                "manifest.json",
                {
                    "archive_version": ARCHIVE_VERSION,
                    "generated_at": timezone.now(),
                    "workspace_name": workspace.name,
                },
            )
            counts["workspace/workspace.json"] = _add_table(
                tar, "workspace/workspace.json", Workspace.objects.all()
            )
            for name, qs, exclude in _table_specs():
                counts[name] = _add_table(tar, name, qs, exclude=exclude)
            _add_history(tar, counts)
            _add_attachments(tar, counts)
            # Re-stamp the manifest counts at the end (everything is enumerated).
            _add_json(tar, "counts.json", counts)
        tmp.flush()
        size = tmp.tell()
        tmp.seek(0)
        storage_path = default_storage.save(f"{EXPORT_DIR}/{job_id}.tar.gz", File(tmp))
    logger.info("workspace export %s stored at %s (%d bytes)", job_id, storage_path, size)
    return storage_path, size
