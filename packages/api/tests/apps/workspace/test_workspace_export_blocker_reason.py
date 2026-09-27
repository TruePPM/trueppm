"""Workspace archive omits ADR-0124's private blocker reason (#4082).

The full-workspace ``.tar.gz`` is a workspace-admin backup. ADR-0124 makes a
task's ``blocked_reason`` readable only by its assignee or a user mentioned on
it — never by an admin on role alone — so the column is dropped from
``projects/tasks.json`` and from every row of ``history/tasks.json``. The
ungated triage fields still mark the task as blocked.
"""

from __future__ import annotations

import io
import json
import tarfile
from datetime import date
from typing import Any

import pytest
from django.core.files.storage import default_storage

from trueppm_api.apps.projects.models import Project, Task
from trueppm_api.apps.workspace.export import build_and_store_archive

SECRET = "waiting on legal re: the Hendricks settlement"

pytestmark = pytest.mark.django_db


def _archive_members() -> dict[str, bytes]:
    path, _size = build_and_store_archive("blocker-reason-test")
    try:
        with default_storage.open(path, "rb") as fh:
            raw = fh.read()
    finally:
        default_storage.delete(path)
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as tar:
        return {
            m.name: tar.extractfile(m).read()  # type: ignore[union-attr]
            for m in tar.getmembers()
            if m.isfile()
        }


@pytest.fixture
def blocked_task() -> Task:
    project = Project.objects.create(name="Apollo", start_date=date(2026, 1, 1))
    task = Task.objects.create(project=project, name="Contract review", duration=1)
    # Flag it via a save so history holds both the pre- and post-flag rows.
    task.blocked_reason = SECRET
    task.blocker_type = "vendor"
    task.save()
    return task


def test_reason_text_appears_nowhere_in_the_archive(blocked_task: Task) -> None:
    members = _archive_members()
    leaks = [name for name, body in members.items() if SECRET.encode() in body]
    assert leaks == []


def test_tasks_and_task_history_drop_the_reason_column(blocked_task: Task) -> None:
    members = _archive_members()
    tasks: list[dict[str, Any]] = json.loads(members["projects/tasks.json"])
    history: list[dict[str, Any]] = json.loads(members["history/tasks.json"])
    assert tasks and history
    assert all("blocked_reason" not in row for row in tasks)
    assert all("blocked_reason" not in row for row in history)
    # The ungated half of the blocker still records that the task was blocked.
    (row,) = [r for r in tasks if r["id"] == str(blocked_task.pk)]
    assert row["blocked_since"] is not None
    assert row["blocker_type"] == "vendor"


def test_other_history_tables_keep_their_columns(blocked_task: Task) -> None:
    """The exclusion is scoped to Task — project history is emitted whole."""
    members = _archive_members()
    projects: list[dict[str, Any]] = json.loads(members["history/projects.json"])
    assert projects and "name" in projects[0]
