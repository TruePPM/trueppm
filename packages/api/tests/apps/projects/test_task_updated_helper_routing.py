"""Every ``task_updated`` emit goes through ``broadcast_task_updated`` (#4600).

A bare ``task_updated {"id"}`` carries no ``version`` / ``actor_id``, so the editor's
own client cannot suppress its self-echo (ADR-0152) and refetches over an optimistic
edit. These tests pin the previously-bare write paths to the enriched payload, and an
AST gate bans a call that passes the literal ``"task_updated"`` outside the helper.

``actor_id`` is set only where the originating web hook already refreshed its own
``['tasks']`` cache (estimate approval, subtask create); every other site sends
``None`` so the editor's tabs still refetch. ``version`` is ``None`` where the write
did not bump the Task row.
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
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import (
    AcceptanceCriterion,
    Calendar,
    DorState,
    EstimateStatus,
    EstimationMode,
    Project,
    ProjectApiToken,
    SuggestionState,
    Task,
    TaskRecurrenceRule,
    TaskStatus,
    TaskSuggestedAssignee,
    TaskType,
)
from trueppm_api.apps.projects.product_backlog_services import mark_ready, send_to_refine

User = get_user_model()
SRC = Path(__file__).resolve().parents[3] / "src" / "trueppm_api"

# The helper module itself is the only file allowed to pass the literal event type.
ALLOWED_LITERAL_EMITTERS = {"apps/sync/broadcast.py"}


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


def test_acceptance_criterion_edit_emits_unattributed_frame_without_stale_version(
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
    # The backlog AC hook refreshes only backlog keys, so this is not a self-echo.
    assert frame["actor_id"] is None


def test_mark_ready_emits_versioned_unattributed_frame(
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
    assert frame["actor_id"] is None


def test_no_literal_task_updated_emit_outside_the_helper() -> None:
    """AST gate: a call passing the literal ``"task_updated"`` as a positional argument
    (``broadcast_board_event``, ``functools.partial`` ...) is a bare emit that bypasses
    ADR-0152. Go through ``broadcast_task_updated`` / ``defer_task_updated``.

    Intentional exception: ``projects/inbound_sync.py`` emits ``{"id", "source"}``
    with the event type held in a variable (``task_created`` or ``task_updated``). It
    stays bare on purpose — it is a token-authenticated system write with no actor to
    attribute, and an unversioned, unattributed frame makes every client refetch the
    task, which is the behavior that write needs.

    Blind spots — it sees only a string constant passed directly as a positional call
    argument. It does not see the event type held in a variable (the inbound_sync
    exception above), carried in a tuple or list and unpacked later
    (``sync/upload.py``), or passed as a keyword. A green run is therefore not "no bare
    emit exists"; it is "no new emit of the common literal shape"."""
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


def _mock_events() -> Any:
    return mock.patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")


def test_subtask_create_parent_frame_carries_post_bump_version(
    client: APIClient, project: Project, user: object, django_capture_on_commit_callbacks: Any
) -> None:
    """The parent is bumped with a queryset ``.update()``; the frame must carry the
    version the row now holds, not the stale in-memory one (replay-drop on the web)."""
    parent = Task.objects.create(project=project, name="Parent", duration=2, wbs_path="1")
    before = Task.objects.get(pk=parent.pk).server_version
    with _mock_events() as m, django_capture_on_commit_callbacks(execute=True):
        r = client.post(
            "/api/v1/tasks/",
            {
                "project": str(project.pk),
                "name": "Sub",
                "duration": 1,
                "parent_id": str(parent.pk),
                "is_subtask": True,
            },
            format="json",
        )
    assert r.status_code == 201, r.content
    parent.refresh_from_db()
    assert parent.server_version > before
    (frame,) = [f for f in _frames(m) if f["id"] == str(parent.pk)]
    assert frame["changed_fields"] == ["is_summary"]
    assert frame["version"] == parent.server_version
    # useCreateTask invalidates ['tasks'] itself, so the actor's echo is suppressible.
    assert frame["actor_id"] == str(user.pk)


def _suggest(project: Project, user: Any, **task_kw: Any) -> TaskSuggestedAssignee:
    task = Task.objects.create(project=project, name="Retro item", **task_kw)
    return TaskSuggestedAssignee.objects.create(task=task, suggested_user=user)


def test_suggestion_accept_binding_assignee_emits_versioned_frame(
    client: APIClient, project: Project, user: object, django_capture_on_commit_callbacks: Any
) -> None:
    s = _suggest(project, user)
    with _mock_events() as m, django_capture_on_commit_callbacks(execute=True):
        r = client.post(f"/api/v1/tasks/{s.task_id}/suggestions/{s.pk}/accept/")
    assert r.status_code == 200, r.content
    task = Task.objects.get(pk=s.task_id)
    assert task.assignee_id == user.pk  # type: ignore[attr-defined]
    (frame,) = _frames(m)
    assert frame["changed_fields"] == ["assignee"]
    assert frame["version"] == task.server_version
    assert frame["actor_id"] is None


def test_suggestion_accept_conflict_emits_unversioned_frame(
    client: APIClient, project: Project, user: object, django_capture_on_commit_callbacks: Any
) -> None:
    """Only the suggestion row changes, so ``version`` is None and ``changed_fields``
    is empty ("unknown, refetch")."""
    other = User.objects.create_user(username="other", password="pw")
    ProjectMembership.objects.create(project=project, user=other, role=Role.MEMBER)
    s = _suggest(project, user, assignee=other)
    with _mock_events() as m, django_capture_on_commit_callbacks(execute=True):
        r = client.post(f"/api/v1/tasks/{s.task_id}/suggestions/{s.pk}/accept/")
    assert r.status_code == 409, r.content
    s.refresh_from_db()
    assert s.state == SuggestionState.ACCEPTED
    (frame,) = _frames(m)
    assert frame["changed_fields"] == []
    assert frame["version"] is None
    assert frame["actor_id"] is None


def test_recurrence_create_and_destroy_emit_is_recurring_frames(
    client: APIClient, project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    template = Task.objects.create(project=project, name="Standup", duration=1)
    with (
        mock.patch("trueppm_api.apps.projects.views._enqueue_recalculate"),
        _mock_events() as m,
        django_capture_on_commit_callbacks(execute=True),
    ):
        r = client.post(
            "/api/v1/recurrence-rules/",
            {"task": str(template.pk), "frequency": "DAILY", "end_type": "NEVER"},
            format="json",
        )
        assert r.status_code == 201, r.content
        template.refresh_from_db()
        created_version = template.server_version
        rule = TaskRecurrenceRule.objects.get(task=template)
        d = client.delete(f"/api/v1/recurrence-rules/{rule.pk}/")
        assert d.status_code == 204, d.content
    template.refresh_from_db()
    create_frame, destroy_frame = _frames(m)
    assert create_frame["changed_fields"] == ["is_recurring"]
    assert create_frame["version"] == created_version
    assert create_frame["actor_id"] is None
    assert destroy_frame["changed_fields"] == ["is_recurring"]
    assert destroy_frame["version"] == template.server_version
    assert destroy_frame["actor_id"] is None


def test_phase_update_emits_versioned_unattributed_frame(
    client: APIClient, project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    phase = Task.objects.create(project=project, name="Phase 1", duration=0, wbs_path="1")
    with _mock_events() as m, django_capture_on_commit_callbacks(execute=True):
        r = client.patch(
            f"/api/v1/projects/{project.pk}/phases/{phase.pk}/", {"name": "Design"}, format="json"
        )
    assert r.status_code == 200, r.content
    phase.refresh_from_db()
    (frame,) = _frames(m)
    assert frame["changed_fields"] == ["name"]
    assert frame["version"] == phase.server_version
    assert frame["actor_id"] is None


def test_send_to_refine_emits_versioned_unattributed_frame(
    project: Project, user: object, django_capture_on_commit_callbacks: Any
) -> None:
    task = Task.objects.create(
        project=project,
        name="S",
        type=TaskType.STORY,
        status=TaskStatus.BACKLOG,
        dor=DorState.READY,
    )
    with _mock_events() as m, django_capture_on_commit_callbacks(execute=True):
        send_to_refine(task, user)
    task.refresh_from_db()
    (frame,) = _frames(m)
    assert frame["changed_fields"] == ["dor"]
    assert frame["version"] == task.server_version
    assert frame["actor_id"] is None


def test_ci_acceptance_ingest_frame_is_not_attributed_to_token_creator(
    project: Project, user: object, django_capture_on_commit_callbacks: Any
) -> None:
    """The token creator made no optimistic edit; attributing the CI write to them would
    make their browser skip the refetch as a self-echo."""
    import secrets

    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    ProjectApiToken.objects.create(
        project=project,
        name="ci",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=user,
    )
    task = Task.objects.create(project=project, name="S", type=TaskType.STORY)
    c = AcceptanceCriterion.objects.create(task=task, text="AC", met=False, position=0)
    ci = APIClient()
    ci.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    with _mock_events() as m, django_capture_on_commit_callbacks(execute=True):
        r = ci.post(
            f"/api/v1/projects/{project.pk}/acceptance-results/",
            {"results": [{"criterion_id": str(c.pk), "passed": True}]},
            format="json",
        )
    assert r.status_code == 200, r.content
    (frame,) = _frames(m)
    assert frame["id"] == str(task.pk)
    assert frame["changed_fields"] == ["acceptance_criteria"]
    assert frame["version"] is None
    assert frame["actor_id"] is None


def test_retro_carryover_pull_emits_versioned_unattributed_frame_with_context_keys(
    project: Project, user: object, django_capture_on_commit_callbacks: Any
) -> None:
    """Pull-to-sprint goes through the helper: the standard keys plus the context keys
    this site already published. The pull hook does not refresh ``['tasks']``, so the
    frame is unattributed and the actor's own client refetches."""
    from trueppm_api.apps.projects.models import (
        RetroActionItem,
        Sprint,
        SprintRetro,
        SprintState,
    )
    from trueppm_api.apps.projects.retro_services import pull_carryover_item_to_sprint

    done = Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.COMPLETED,
    )
    item = RetroActionItem.objects.create(
        retro=SprintRetro.objects.create(sprint=done, notes="r"), text="Probe"
    )
    target = Sprint.objects.create(
        project=project,
        name="S2",
        start_date=date(2026, 4, 15),
        finish_date=date(2026, 4, 28),
        state=SprintState.PLANNED,
    )
    with _mock_events() as m, django_capture_on_commit_callbacks(execute=True):
        task = pull_carryover_item_to_sprint(item, target, user)
    task.refresh_from_db()
    frame = next(f for f in _frames(m) if f.get("source") == "retro_carryover")
    assert frame["id"] == frame["task_id"] == str(task.pk)
    assert frame["sprint_id"] == str(target.pk)
    assert frame["changed_fields"] == ["sprint"]
    assert frame["version"] == task.server_version
    assert frame["actor_id"] is None


def test_extra_keys_cannot_override_the_standard_keys() -> None:
    """``extra`` is merged under the standard keys: a colliding key never reaches the
    client's dedupe / echo gates."""
    from trueppm_api.apps.sync.broadcast import broadcast_task_updated

    with _mock_events() as m:
        broadcast_task_updated(
            "p",
            task_id="t",
            changed_fields=["sprint"],
            version=7,
            actor_id=None,
            extra={"id": "other", "version": 1, "actor_id": "u", "source": "s"},
        )
    (frame,) = _frames(m)
    assert (frame["id"], frame["version"], frame["actor_id"]) == ("t", 7, None)
    assert frame["source"] == "s"
