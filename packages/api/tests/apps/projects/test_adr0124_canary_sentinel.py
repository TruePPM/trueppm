"""Canary sentinel: ADR-0124's private ``blocked_reason`` must reach no unauthorized reader (#4124).

Per-surface tests already exist (``test_blocker_privacy``, ``test_export_blocker_reason``,
``test_workspace_export_blocker_reason``, the history and standup suites). Each of them
covers the reader its author remembered; #4082 was the reader nobody had listed. This
file closes the *class* two ways:

1. **One sentinel, every reader.** A unique string is stored as ``blocked_reason`` (and
   edited, so the history table holds a second copy) and the raw bytes of every surface
   that can carry it are searched for the string — not a field name, which a rename or a
   nested payload would sidestep. The requester is a project Owner who is neither the
   assignee nor mentioned: the exact profile ADR-0124 says role alone must not read.
   A control run as the assignee proves the sentinel *can* appear on the surfaces that
   are meant to serve it, so a surface that is merely broken (empty) cannot pass.
2. **Reader enumeration.** The set of source files that mention the field is pinned. A
   new file touching ``blocked_reason`` fails here until someone decides whether it is a
   reader and adds a sentinel check above — the step #4082 skipped.
"""

from __future__ import annotations

import io
import json
import tarfile
from datetime import date
from pathlib import Path
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.core.files.storage import default_storage
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, ProjectExportJob, Task
from trueppm_api.apps.projects.seed import export_project
from trueppm_api.apps.workspace.export import build_and_store_archive

pytestmark = pytest.mark.django_db

User = get_user_model()

CANARY = "CANARY-7f3a91-adr0124-do-not-leak"


@pytest.fixture
def assignee() -> Any:
    return User.objects.create_user(username="canary-assignee", password="pw")


@pytest.fixture
def owner() -> Any:
    """Owner of the project, neither assignee nor @-mentioned: reads nothing private."""
    return User.objects.create_user(username="canary-owner", password="pw")


@pytest.fixture
def project(owner: Any, assignee: Any) -> Project:
    p = Project.objects.create(
        name="Canary",
        code="canary",
        start_date=date(2026, 4, 1),
        calendar=Calendar.objects.create(name="Canary Std"),
    )
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    ProjectMembership.objects.create(project=p, user=assignee, role=Role.MEMBER)
    return p


@pytest.fixture
def blocked_task(project: Project, assignee: Any) -> Task:
    task = Task.objects.create(
        project=project,
        name="Canary task",
        wbs_path="1",
        duration=1,
        assignee=assignee,
        blocked_reason=CANARY,
        blocker_type="vendor",
    )
    # A second write puts a changed row into history beside the first.
    task.blocked_reason = CANARY + " (edited)"
    task.name = "Canary task renamed"
    task.save()
    return task


def _get(user: Any, path: str) -> str:
    client = APIClient()
    client.force_authenticate(user=user)
    resp = client.get(path)
    assert resp.status_code == 200, (path, resp.status_code, resp.content[:200])
    return resp.content.decode()


def _http_surfaces(project: Project, task: Task) -> dict[str, str]:
    base = f"/api/v1/projects/{project.pk}"
    return {
        "task list": f"/api/v1/tasks/?project={project.pk}",
        "task detail": f"/api/v1/tasks/{task.pk}/",
        "task history": f"{base}/tasks/{task.pk}/history/",
        "project history": f"{base}/history/",
        "changelog": f"{base}/changelog/",
        "standup": f"{base}/standup/",
        "project export": f"{base}/export/",
        "project blocked roll-up": f"{base}/blocked/",
    }


def _write_surfaces(project: Project, task: Task, requester: Any) -> dict[str, str]:
    """Raw bodies of the WRITE responses that echo a task back to a non-reader.

    A write returns the full task representation, so it is a reader too: a PATCH of an
    unrelated field and a bulk update row must not carry the private text back to a
    requester who is neither assignee nor mentioned.
    """
    client = APIClient()
    client.force_authenticate(user=requester)
    patch_resp = client.patch(
        f"/api/v1/tasks/{task.pk}/", {"name": "Renamed by owner"}, format="json"
    )
    assert patch_resp.status_code == 200, patch_resp.content[:300]
    bulk_resp = client.post(
        f"/api/v1/projects/{project.pk}/tasks/bulk/",
        {"operations": [{"op": "update", "id": str(task.pk), "data": {"name": "Bulk renamed"}}]},
        format="json",
    )
    assert bulk_resp.status_code == 207, bulk_resp.content[:300]
    assert len(bulk_resp.json()["applied"]) == 1, "bulk row not applied — vacuous"
    return {
        "task PATCH response": patch_resp.content.decode(),
        "task bulk response": bulk_resp.content.decode(),
    }


def _tar_members(raw: bytes) -> dict[str, bytes]:
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as tar:
        return {m.name: f.read() for m in tar.getmembers() if (f := tar.extractfile(m)) is not None}


def _project_bundle(project: Project, requester: Any) -> dict[str, bytes]:
    from trueppm_api.apps.projects.tasks import run_project_export

    job = ProjectExportJob.objects.create(project=project, requested_by=requester)
    run_project_export.apply(args=[str(job.id)], throw=True)
    job.refresh_from_db()
    with default_storage.open(job.file_path, "rb") as fh:
        return _tar_members(fh.read())


def _workspace_archive() -> dict[str, bytes]:
    path, _size = build_and_store_archive("canary")
    try:
        with default_storage.open(path, "rb") as fh:
            return _tar_members(fh.read())
    finally:
        default_storage.delete(path)


def test_no_http_surface_serves_the_canary_to_a_non_reader(
    project: Project, blocked_task: Task, owner: Any
) -> None:
    leaks = [
        name
        for name, path in _http_surfaces(project, blocked_task).items()
        if CANARY in _get(owner, path)
    ]
    assert leaks == []


def test_no_write_response_serves_the_canary_to_a_non_reader(
    project: Project, blocked_task: Task, owner: Any
) -> None:
    surfaces = _write_surfaces(project, blocked_task, owner)
    assert [name for name, body in surfaces.items() if CANARY in body] == []


def test_sprint_blocked_rollup_serves_no_canary_to_a_non_reader(
    project: Project, blocked_task: Task, owner: Any
) -> None:
    from trueppm_api.apps.projects.models import Sprint

    sprint = Sprint.objects.create(
        project=project,
        name="Canary sprint",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
    )
    Task.objects.filter(pk=blocked_task.pk).update(sprint=sprint)
    body = _get(owner, f"/api/v1/sprints/{sprint.pk}/blocked/")
    assert len(json.loads(body)["blocked"]) == 1, "roll-up empty — vacuous"
    assert CANARY not in body


def test_the_canary_is_live_for_its_legitimate_reader(
    project: Project, blocked_task: Task, assignee: Any
) -> None:
    """Control: the assignee sees it on the task read, so the sweep above is not vacuous."""
    assert CANARY in _get(assignee, f"/api/v1/tasks/{blocked_task.pk}/")


def test_seed_exporter_omits_the_canary_for_a_non_reader(
    project: Project, blocked_task: Task, owner: Any, assignee: Any
) -> None:
    assert CANARY not in json.dumps(export_project(project, requesting_user=owner))
    assert CANARY in json.dumps(export_project(project, requesting_user=assignee))


def test_async_bundle_carries_no_canary_for_a_non_reader(
    project: Project, blocked_task: Task, owner: Any, assignee: Any
) -> None:
    leaks = [n for n, body in _project_bundle(project, owner).items() if CANARY.encode() in body]
    assert leaks == []
    # Control: the history table itself holds the canary, and the assignee's bundle shows it.
    assert any(CANARY.encode() in b for b in _project_bundle(project, assignee).values())


def test_bundle_for_a_null_requester_carries_no_canary(
    project: Project, blocked_task: Task
) -> None:
    members = _project_bundle(project, None)
    assert [n for n, body in members.items() if CANARY.encode() in body] == []


def test_workspace_archive_carries_no_canary(project: Project, blocked_task: Task) -> None:
    members = _workspace_archive()
    assert members, "archive is empty — the sweep proves nothing"
    assert [n for n, body in members.items() if CANARY.encode() in body] == []


def test_sync_task_serializer_does_not_declare_the_private_field() -> None:
    """The pull serializer has no read gate, so the field must not be on it at all (#4124)."""
    from trueppm_api.apps.sync.serializers import SyncTaskSerializer

    assert "blocked_reason" not in SyncTaskSerializer.Meta.fields


def test_sync_pull_payload_carries_no_canary(
    project: Project, blocked_task: Task, owner: Any, assignee: Any
) -> None:
    """A real pull, as a non-reader AND as the assignee: sync is not a reader of the text."""
    for user in (owner, assignee):
        body = _get(user, f"/api/v1/projects/{project.pk}/sync/?since=0")
        assert str(blocked_task.pk) in body, "pull returned no task — the sweep is vacuous"
        assert CANARY not in body


def test_sync_conflict_body_does_not_echo_the_canary_to_a_non_reader(
    project: Project, blocked_task: Task, owner: Any
) -> None:
    """``conflict.py`` builds ``server_value`` from the requester-gated TaskSerializer.

    The non-reader's own conflicting ``blocked_reason`` edit is echoed as ``client_value``
    (their own input, not the stored text); the stored canary must never appear.
    """
    base = blocked_task.server_version
    blocked_task.blocked_reason = "another writer's text"
    blocked_task.save()
    client = APIClient()
    client.force_authenticate(user=owner)
    resp = client.post(
        f"/api/v1/projects/{project.pk}/sync/",
        {
            "client_batch_id": "00000000-0000-4000-8000-000000000124",
            "last_pulled_at": base,
            "changes": {
                "tasks": {
                    "created": [],
                    "updated": [{"id": str(blocked_task.pk), "blocked_reason": "owner edit"}],
                    "deleted": [],
                }
            },
        },
        format="json",
    )
    assert resp.status_code == 200, resp.content[:300]
    raw = resp.content.decode()
    assert len(resp.json()["conflicts"]["tasks"]) == 1, "no conflict produced — vacuous"
    assert CANARY not in raw
    assert "another writer" not in raw  # the stored text, not just the canary prefix


# Every non-migration source file that mentions ``blocked_reason``, each judged once.
# A new entry means a new reader or writer of the private field: add a sentinel check
# above (or state why none applies) *before* extending this set.
_REVIEWED_FIELD_TOUCHPOINTS: dict[str, str] = {
    "apps/history/changelog.py": "diff feed — field dropped (sentinel: changelog, task history)",
    "apps/history/diff_policy.py": "HISTORY_DIFF_PRIVACY_GATED — the gate list itself",
    "apps/integrations/http.py": "unrelated: egress-blocked helper named blocked_reason()",
    "apps/projects/blocker_services.py": "roll-up reads emptiness only; can_read gate lives here",
    "apps/projects/export_bundle.py": "history rows gated per requester (sentinel: bundle)",
    "apps/projects/models.py": "the field + derived-stamp logic; never serialized here",
    "apps/projects/refusal_codes.py": "unrelated: undo_blocked_reason refusal code",
    "apps/projects/seed/exporter.py": "seed exporter gated per task (sentinel: seed export)",
    "apps/projects/seed/importer.py": "write path (seed import)",
    "apps/projects/seed/replay.py": "write path (seed replay)",
    "apps/projects/serializers.py": "TaskSerializer read gate (sentinel: task list/detail)",
    "apps/projects/services.py": "standup/new-blocker delta reads emptiness only",
    "apps/projects/standup.py": "standup payload never serializes the text (sentinel: standup)",
    "apps/projects/standup_views.py": "standup view (sentinel: standup)",
    "apps/projects/structural_operation_services.py": "unrelated: undo_blocked_reason() helper",
    "apps/projects/structural_operation_views.py": "undo refusal wiring",
    "apps/projects/views.py": "task write/rollup views",
    "apps/workspace/export.py": "BLOCKER_REASON_EXCLUDE — column dropped from archive",
}


def test_the_set_of_files_touching_the_private_field_is_pinned() -> None:
    src = Path(__file__).resolve().parents[3] / "src" / "trueppm_api"
    found = {
        str(p.relative_to(src))
        for p in src.rglob("*.py")
        if "migrations" not in p.parts and "blocked_reason" in p.read_text(encoding="utf-8")
    }
    assert found == set(_REVIEWED_FIELD_TOUCHPOINTS), (
        "blocked_reason (ADR-0124) is now mentioned in a different set of files. "
        f"New: {sorted(found - set(_REVIEWED_FIELD_TOUCHPOINTS))}; "
        f"gone: {sorted(set(_REVIEWED_FIELD_TOUCHPOINTS) - found)}. "
        "A new reader needs a canary check in this file."
    )
