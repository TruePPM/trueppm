"""Every ``task_updated`` emit goes through ``broadcast_task_updated`` (#4600).

A bare ``task_updated {"id"}`` carries no ``version`` / ``actor_id``, so the editor's
own client cannot suppress its self-echo (ADR-0152) and refetches over an optimistic
edit. These tests pin the previously-bare write paths to the enriched payload and ban a
literal ``"task_updated"`` emit anywhere but the helper.
"""

from __future__ import annotations

import ast
from datetime import date
from pathlib import Path
from typing import Any
from unittest import mock

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    AcceptanceCriterion,
    Calendar,
    DorState,
    EstimateStatus,
    EstimationMode,
    Project,
    Task,
    TaskStatus,
    TaskType,
)
from trueppm_api.apps.projects.product_backlog_services import mark_ready

User = get_user_model()
SRC = Path(__file__).resolve().parents[3] / "src" / "trueppm_api"

# retro_services carries extra keys (sprint_id, source) the helper has no slot for;
# it already sends a string ``id`` and is tracked separately from #4600's site list.
ALLOWED_LITERAL_EMITTERS = {"apps/sync/broadcast.py", "apps/projects/retro_services.py"}


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="sched", password="pw")


@pytest.fixture
def project(user: object) -> Project:
    p = Project.objects.create(
        name="P",
        start_date=date(2026, 1, 1),
        calendar=Calendar.objects.create(name="Std"),
        estimation_mode=EstimationMode.SUGGEST_APPROVE,
    )
    ProjectMembership.objects.create(project=p, user=user, role=Role.OWNER)
    return p


@pytest.fixture
def client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _frames(m: mock.MagicMock) -> list[dict[str, Any]]:
    return [c.args[2] for c in m.call_args_list if c.args[1] == "task_updated"]


def test_approve_estimates_emits_versioned_actor_frame(
    client: APIClient, project: Project, user: object, django_capture_on_commit_callbacks: Any
) -> None:
    task = Task.objects.create(project=project, name="T", estimate_status=EstimateStatus.PENDING)
    with (
        mock.patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as m,
        django_capture_on_commit_callbacks(execute=True),
    ):
        r = client.post(f"/api/v1/tasks/{task.pk}/approve-estimates/")
    assert r.status_code == 200
    task.refresh_from_db()
    (frame,) = _frames(m)
    assert frame["id"] == str(task.pk)
    assert frame["changed_fields"] == ["estimate_status"]
    assert frame["version"] == task.server_version
    assert frame["actor_id"] == str(user.pk)


def test_acceptance_criterion_edit_emits_actor_frame_without_stale_version(
    client: APIClient, project: Project, user: object, django_capture_on_commit_callbacks: Any
) -> None:
    """The criterion row changes, not the Task row, so ``version`` is None — a task
    version the client already holds would be dropped as a replay."""
    task = Task.objects.create(project=project, name="S", type=TaskType.STORY)
    c = AcceptanceCriterion.objects.create(task=task, text="AC", met=False, position=0)
    with (
        mock.patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as m,
        django_capture_on_commit_callbacks(execute=True),
    ):
        r = client.patch(f"/api/v1/acceptance-criteria/{c.pk}/", {"met": True}, format="json")
    assert r.status_code == 200
    (frame,) = _frames(m)
    assert frame["id"] == str(task.pk)
    assert frame["changed_fields"] == ["acceptance_criteria"]
    assert frame["version"] is None
    assert frame["actor_id"] == str(user.pk)


def test_mark_ready_emits_versioned_actor_frame(
    project: Project, user: object, django_capture_on_commit_callbacks: Any
) -> None:
    task = Task.objects.create(
        project=project,
        name="S",
        type=TaskType.STORY,
        status=TaskStatus.BACKLOG,
        story_points=3,
        dor=DorState.REFINE,
    )
    AcceptanceCriterion.objects.create(task=task, text="AC", met=True, position=0)
    with (
        mock.patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as m,
        django_capture_on_commit_callbacks(execute=True),
    ):
        mark_ready(task, user)
    task.refresh_from_db()
    (frame,) = _frames(m)
    assert frame["changed_fields"] == ["dor"]
    assert frame["version"] == task.server_version
    assert frame["actor_id"] == str(user.pk)


def test_no_literal_task_updated_emit_outside_the_helper() -> None:
    """AST gate: a call passing the literal ``"task_updated"`` (``broadcast_board_event``,
    ``functools.partial`` ...) is a bare emit that bypasses ADR-0152. Go through
    ``broadcast_task_updated`` / ``defer_task_updated`` in ``sync/broadcast.py``."""
    offenders: list[str] = []
    for path in SRC.rglob("*.py"):
        rel = path.relative_to(SRC).as_posix()
        if rel in ALLOWED_LITERAL_EMITTERS:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and any(
                isinstance(a, ast.Constant) and a.value == "task_updated" for a in node.args
            ):
                offenders.append(f"{rel}:{node.lineno}")
    assert not offenders, f"bare task_updated emits: {offenders}"
