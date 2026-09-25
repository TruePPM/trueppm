"""Export surfaces must honor the ADR-0124 blocker-reason gate (#4082).

``blocked_reason`` is readable only by the task's assignee or an @-mentioned
user — not by a project Admin. The export endpoints are Admin+, so role-gating
the endpoint does not cover the field; the exporter and the async bundle must
gate it per task. Structured triage signals (type/since/by) stay exported.
"""

from __future__ import annotations

import io
import json
import tarfile
from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.notifications.models import Mention
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    ProjectExportJob,
    Task,
    TaskComment,
)
from trueppm_api.apps.projects.seed import export_project, import_seed

pytestmark = pytest.mark.django_db

User = get_user_model()
REASON = "SECRET: vendor escalation, blocked on legal sign-off"


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def assignee() -> Any:
    return User.objects.create_user(username="assignee", password="pw")


@pytest.fixture
def pm() -> Any:
    return User.objects.create_user(username="pm", password="pw")


@pytest.fixture
def mentioned() -> Any:
    return User.objects.create_user(username="mentioned", password="pw")


@pytest.fixture
def project(assignee: Any, pm: Any, mentioned: Any) -> Project:
    p = Project.objects.create(
        name="Alpha",
        code="alpha",
        start_date=date(2026, 4, 1),
        calendar=Calendar.objects.create(name="Std"),
    )
    ProjectMembership.objects.create(project=p, user=pm, role=Role.OWNER)
    ProjectMembership.objects.create(project=p, user=assignee, role=Role.ADMIN)
    ProjectMembership.objects.create(project=p, user=mentioned, role=Role.ADMIN)
    return p


@pytest.fixture
def blocked_task(project: Project, assignee: Any, mentioned: Any) -> Task:
    task = Task.objects.create(
        project=project,
        name="Foundation pour",
        wbs_path="1",
        duration=1,
        assignee=assignee,
        blocked_reason=REASON,
        blocker_type="vendor",
    )
    comment = TaskComment.objects.create(task=task, author=assignee, body="ping")
    Mention.objects.create(
        mentioner=assignee, mentioned_user=mentioned, task_comment=comment, project=project
    )
    return task


def _blocked(doc: dict[str, Any]) -> dict[str, Any]:
    for proj in doc["projects"]:
        for t in proj["tasks"]:
            if t["name"] == "Foundation pour":
                return t["blocked"]
    raise AssertionError("blocked task missing from export")


# -- exporter ---------------------------------------------------------------


def test_admin_who_is_not_assignee_gets_no_reason(blocked_task: Task, project: Project, pm: Any):
    doc = export_project(project, requesting_user=pm)
    blocked = _blocked(doc)
    assert "reason" not in blocked
    assert blocked["type"] == "vendor"
    assert "since" in blocked
    assert "SECRET" not in json.dumps(doc)


def test_assignee_admin_gets_reason(blocked_task: Task, project: Project, assignee: Any):
    assert _blocked(export_project(project, requesting_user=assignee))["reason"] == REASON


def test_mentioned_admin_gets_reason(blocked_task: Task, project: Project, mentioned: Any):
    assert _blocked(export_project(project, requesting_user=mentioned))["reason"] == REASON


def test_none_requester_gets_no_reason(blocked_task: Task, project: Project):
    assert "reason" not in _blocked(export_project(project, requesting_user=None))


def test_no_http_caller_is_trusted(blocked_task: Task, project: Project):
    assert _blocked(export_project(project))["reason"] == REASON


def test_gate_costs_one_mention_query_regardless_of_blocked_count(
    blocked_task: Task, project: Project, pm: Any
):
    def mention_queries() -> int:
        with CaptureQueriesContext(connection) as ctx:
            export_project(project, requesting_user=pm)
        return sum(1 for q in ctx.captured_queries if "notifications_mention" in q["sql"])

    baseline = mention_queries()
    for i in range(5):
        Task.objects.create(
            project=project,
            name=f"Extra {i}",
            wbs_path=str(i + 2),
            duration=1,
            assignee=blocked_task.assignee,
            blocked_reason="another private reason",
        )
    assert mention_queries() == baseline == 1


# -- endpoints --------------------------------------------------------------


def test_project_export_endpoint_withholds_reason_from_admin(
    blocked_task: Task, project: Project, pm: Any
):
    resp = _client(pm).get(f"/api/v1/projects/{project.pk}/export/")
    assert resp.status_code == 200
    assert "SECRET" not in resp.content.decode()


def test_project_export_endpoint_gives_assignee_admin_the_reason(
    blocked_task: Task, project: Project, assignee: Any
):
    resp = _client(assignee).get(f"/api/v1/projects/{project.pk}/export/")
    assert REASON in resp.content.decode()


def test_program_export_endpoint_withholds_reason_from_admin(
    blocked_task: Task, project: Project, pm: Any
):
    from trueppm_api.apps.projects.models import Program

    program = Program.objects.create(name="Prog", code="prog")
    project.program = program
    project.save()
    from trueppm_api.apps.access.models import ProgramMembership

    ProgramMembership.objects.create(program=program, user=pm, role=Role.ADMIN)
    resp = _client(pm).get(f"/api/v1/programs/{program.pk}/export/")
    assert resp.status_code == 200, resp.content
    assert "SECRET" not in resp.content.decode()


# -- async bundle -----------------------------------------------------------


def _bundle_members(job: ProjectExportJob) -> dict[str, bytes]:
    from django.core.files.storage import default_storage

    from trueppm_api.apps.projects.tasks import run_project_export

    run_project_export.apply(args=[str(job.id)], throw=True)
    job.refresh_from_db()
    with default_storage.open(job.file_path, "rb") as fh:
        raw = fh.read()
    members: dict[str, bytes] = {}
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as tar:
        for m in tar.getmembers():
            f = tar.extractfile(m)
            if f is not None:
                members[m.name] = f.read()
    return members


def test_bundle_history_and_seed_carry_no_reason_for_non_reader(
    blocked_task: Task, project: Project, pm: Any
):
    blocked_task.blocked_reason = REASON + " (updated)"
    blocked_task.save()
    job = ProjectExportJob.objects.create(project=project, requested_by=pm)
    members = _bundle_members(job)
    for name in ("seed.json", "history/tasks.json"):
        assert b"SECRET" not in members[name], name
    rows = json.loads(members["history/tasks.json"])
    assert rows and all(r["blocked_reason"] == "" for r in rows)
    assert any(r["blocker_type"] == "vendor" for r in rows)


def test_bundle_history_keeps_reason_for_assignee(
    blocked_task: Task, project: Project, assignee: Any
):
    job = ProjectExportJob.objects.create(project=project, requested_by=assignee)
    rows = json.loads(_bundle_members(job)["history/tasks.json"])
    assert any(r["blocked_reason"] == REASON for r in rows)


def test_bundle_with_null_requester_redacts(blocked_task: Task, project: Project):
    job = ProjectExportJob.objects.create(project=project, requested_by=None)
    members = _bundle_members(job)
    assert b"SECRET" not in members["seed.json"]
    assert b"SECRET" not in members["history/tasks.json"]


# -- round trip -------------------------------------------------------------


def test_gated_blocker_round_trips_as_blocked(blocked_task: Task, project: Project, pm: Any):
    doc = export_project(project, requesting_user=pm)
    program = import_seed(doc, owner=pm, create_users=True)
    task = Task.objects.get(project__program=program, name="Foundation pour")
    assert task.blocked_reason == "(private)"
    assert task.blocker_type == "vendor"
    assert task.blocked_since is not None
