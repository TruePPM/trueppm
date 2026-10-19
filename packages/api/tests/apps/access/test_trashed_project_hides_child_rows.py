"""Hand-rolled membership querysets hide a trashed project's rows too (#4577).

``ProjectScopedViewSet.get_queryset`` floors ``project__is_deleted``, but many
viewsets build their own "projects the caller belongs to" set instead of calling it.
Every one of those sets must carry the same floor, or the trashed project's rows keep
serving on the list read — the permission layer admits a safe-method list on a route
that names no project, so the queryset is the only gate there. For the models the
async cascade never tombstones (relations, rosters, ledgers, task runs), the leak
lasted until the purge, not just the cascade window.

Each case builds one row, proves it is visible to the project's Owner while the
project is live (the control — a case that never saw the row proves nothing), trashes
the project row only, and proves the row is gone.
"""

from __future__ import annotations

import datetime
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.request import Request
from rest_framework.test import APIClient, APIRequestFactory

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Sprint, Task

User = get_user_model()

pytestmark = pytest.mark.django_db


@dataclass
class World:
    owner: Any
    project: Project
    t1: Task
    t2: Task
    sprint: Sprint


@pytest.fixture
def world(db: object) -> World:
    owner = User.objects.create_user(username="rows-owner", password="pw")
    calendar = Calendar.objects.create(name="Std")
    project = Project.objects.create(
        name="Rows", code="ROWS", start_date=date(2026, 4, 1), calendar=calendar
    )
    ProjectMembership.objects.create(project=project, user=owner, role=Role.OWNER)
    t1 = Task.objects.create(project=project, name="T1", duration=1)
    t2 = Task.objects.create(project=project, name="T2", duration=1)
    sprint = Sprint.objects.create(
        project=project,
        short_id="S1",
        name="S1",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
    )
    return World(owner, project, t1, t2, sprint)


def _trash(project: Project) -> None:
    """Tombstone the project row only — the children stay live, as before the cascade."""
    Project.objects.filter(pk=project.pk).update(is_deleted=True)


def _queryset_pks(viewset_cls: type, user: Any, params: dict[str, str] | None = None) -> set[Any]:
    """Run a viewset's own ``get_queryset()`` as a list request by ``user``."""
    request = Request(APIRequestFactory().get("/", params or {}))
    request.user = user
    view = viewset_cls()
    view.request = request
    view.action = "list"
    view.args = ()
    view.kwargs = {}
    view.format_kwarg = None
    return set(view.get_queryset().values_list("pk", flat=True))


# ---------------------------------------------------------------------------
# Row factories, one per viewset
# ---------------------------------------------------------------------------


def _dependency(w: World) -> Any:
    return Dependency.objects.create(predecessor=w.t1, successor=w.t2, dep_type="FS")


def _task_relation(w: World) -> Any:
    from trueppm_api.apps.projects.models import TaskRelation

    return TaskRelation.objects.create(source=w.t1, target=w.t2)


def _slip_conflict(w: World) -> Any:
    from trueppm_api.apps.projects.models import CrossProjectSlipConflict

    return CrossProjectSlipConflict.objects.create(
        sprint=w.sprint, task=w.t1, pushed_to=date(2026, 5, 1)
    )


def _recurrence_rule(w: World) -> Any:
    from trueppm_api.apps.projects.models import TaskRecurrenceRule

    return TaskRecurrenceRule.objects.create(task=w.t1)


def _acceptance_criterion(w: World) -> Any:
    from trueppm_api.apps.projects.models import AcceptanceCriterion

    return AcceptanceCriterion.objects.create(task=w.t1, text="works")


def _sprint_task_outcome(w: World) -> Any:
    from trueppm_api.apps.projects.models import SprintTaskOutcome

    return SprintTaskOutcome.objects.create(
        sprint=w.sprint,
        task=w.t1,
        task_short_id="T1",
        task_title="T1",
        final_status="BACKLOG",
        disposition="completed",
    )


def _retro_board_item(w: World) -> Any:
    from trueppm_api.apps.projects.models import RetroBoardItem, SprintRetro

    retro = SprintRetro.objects.create(sprint=w.sprint)
    return RetroBoardItem.objects.create(retro=retro, text="went well")


def _sprint_scope_change(w: World) -> Any:
    from trueppm_api.apps.projects.models import SprintScopeChange

    return SprintScopeChange.objects.create(task=w.t1, sprint=w.sprint, subtask_name="extra")


def _resource(name: str) -> Any:
    from trueppm_api.apps.resources.models import Resource

    return Resource.objects.create(name=name, email=f"{name}@example.com", job_role="Dev")


def _project_resource(w: World) -> Any:
    from trueppm_api.apps.resources.models import ProjectResource

    return ProjectResource.objects.create(project=w.project, resource=_resource("pr"))


def _task_resource(w: World) -> Any:
    from trueppm_api.apps.resources.models import TaskResource

    return TaskResource.objects.create(task=w.t1, resource=_resource("tr"))


def _task_skill_requirement(w: World) -> Any:
    from trueppm_api.apps.resources.models import Skill, TaskSkillRequirement

    skill = Skill.objects.create(name="Go", normalized_name="go", category="tech")
    return TaskSkillRequirement.objects.create(task=w.t1, skill=skill)


def _template_application(w: World) -> Any:
    from trueppm_api.apps.projects.models import TemplateApplication

    return TemplateApplication.objects.create(project=w.project)


def _structural_operation(w: World) -> Any:
    from trueppm_api.apps.projects.models import StructuralOperation

    return StructuralOperation.objects.create(project=w.project, kind="indent")


def _paste_many_operation(w: World) -> Any:
    from trueppm_api.apps.projects.models import PasteManyOperation

    return PasteManyOperation.objects.create(project=w.project)


def _cascade_operation(w: World) -> Any:
    from trueppm_api.apps.projects.models import CascadeClassificationOperation

    return CascadeClassificationOperation.objects.create(project=w.project, subtree_id=uuid.uuid4())


def _velocity_suggestion(w: World) -> Any:
    from trueppm_api.apps.scheduling.models import VelocitySuggestion

    return VelocitySuggestion.objects.create(
        task=w.t1, sprint=w.sprint, suggested_duration=2, team_velocity_per_day=Decimal("1.0")
    )


def _task_run(w: World) -> Any:
    from trueppm_api.apps.taskruns.models import TaskRun

    return TaskRun.objects.create(project=w.project, task_name="recalc", celery_task_id="c-1")


def _agent_action(w: World) -> Any:
    from trueppm_api.apps.agents.services import record_agent_action

    return record_agent_action(
        actor_token=None,
        principal=None,
        action="tasks.list",
        method="GET",
        capability_used="mcp:read",
        verdict="allowed",
        payload_hash="0" * 64,
        project_id=w.project.pk,
    )


def _viewset(dotted: str) -> type:
    module, _, name = dotted.rpartition(".")
    return getattr(__import__(module, fromlist=[name]), name)  # type: ignore[no-any-return]


P = "trueppm_api.apps.projects.views."
CASES: list[tuple[str, Callable[[World], Any], Callable[[World], dict[str, str]]]] = [
    (P + "DependencyViewSet", _dependency, lambda w: {}),
    (P + "TaskRelationViewSet", _task_relation, lambda w: {}),
    (P + "CrossProjectSlipConflictViewSet", _slip_conflict, lambda w: {}),
    (P + "TaskRecurrenceRuleViewSet", _recurrence_rule, lambda w: {}),
    (P + "AcceptanceCriterionViewSet", _acceptance_criterion, lambda w: {"task": str(w.t1.pk)}),
    (P + "SprintTaskOutcomeViewSet", _sprint_task_outcome, lambda w: {}),
    (P + "RetroBoardItemViewSet", _retro_board_item, lambda w: {}),
    (P + "SprintScopeChangeViewSet", _sprint_scope_change, lambda w: {}),
    ("trueppm_api.apps.resources.views.ProjectResourceViewSet", _project_resource, lambda w: {}),
    ("trueppm_api.apps.resources.views.TaskResourceViewSet", _task_resource, lambda w: {}),
    (
        "trueppm_api.apps.resources.views.TaskSkillRequirementViewSet",
        _task_skill_requirement,
        lambda w: {},
    ),
    (
        "trueppm_api.apps.projects.template_views.TemplateApplicationViewSet",
        _template_application,
        lambda w: {},
    ),
    (
        "trueppm_api.apps.projects.structural_operation_views.StructuralOperationViewSet",
        _structural_operation,
        lambda w: {},
    ),
    (
        "trueppm_api.apps.projects.batch_operation_views.PasteManyOperationViewSet",
        _paste_many_operation,
        lambda w: {},
    ),
    (
        "trueppm_api.apps.projects.batch_operation_views.CascadeClassificationOperationViewSet",
        _cascade_operation,
        lambda w: {},
    ),
    (
        "trueppm_api.apps.scheduling.views.VelocitySuggestionViewSet",
        _velocity_suggestion,
        lambda w: {},
    ),
    ("trueppm_api.apps.taskruns.views.GlobalTaskRunViewSet", _task_run, lambda w: {}),
    ("trueppm_api.apps.agents.views.AgentActionViewSet", _agent_action, lambda w: {}),
]


@pytest.mark.parametrize(
    ("viewset_path", "make_row", "params"),
    CASES,
    ids=[c[0].rpartition(".")[2] for c in CASES],
)
def test_the_viewsets_own_queryset_drops_a_trashed_projects_rows(
    viewset_path: str,
    make_row: Callable[[World], Any],
    params: Callable[[World], dict[str, str]],
    world: World,
) -> None:
    viewset_cls = _viewset(viewset_path)
    row = make_row(world)
    assert row.pk in _queryset_pks(viewset_cls, world.owner, params(world)), (
        "control: the row must be visible while the project is live"
    )
    _trash(world.project)
    assert row.pk not in _queryset_pks(viewset_cls, world.owner, params(world))


def test_dependency_list_endpoint_end_to_end(world: World) -> None:
    """The same property through the router, for the issue's named example."""
    dep = _dependency(world)
    client = APIClient()
    client.force_authenticate(user=world.owner)

    def listed() -> set[str]:
        resp = client.get(f"/api/v1/dependencies/?project={world.project.pk}")
        assert resp.status_code == 200, resp.content
        body = resp.json()
        rows = body["results"] if isinstance(body, dict) else body
        return {row["id"] for row in rows}

    assert str(dep.pk) in listed()
    _trash(world.project)
    assert str(dep.pk) not in listed()


def test_my_work_retro_rows_drop_a_trashed_project(world: World) -> None:
    from trueppm_api.apps.projects.models import RetroActionItem, SprintRetro
    from trueppm_api.apps.projects.views import _retro_owned_rows

    promoted = Task.objects.create(
        project=world.project, name="Retro follow-up", duration=1, assignee=world.owner
    )
    retro = SprintRetro.objects.create(sprint=world.sprint)
    RetroActionItem.objects.create(retro=retro, text="fix it", promoted_task_id=promoted.pk)
    today = datetime.date(2026, 4, 2)

    assert _retro_owned_rows(world.owner, today, set()), "control: the row must show while live"
    _trash(world.project)
    assert _retro_owned_rows(world.owner, today, set()) == []


def test_my_weekly_time_entries_drop_a_trashed_project(world: World) -> None:
    from trueppm_api.apps.timetracking.models import TimeEntry

    entry_date = datetime.date(2026, 4, 6)
    TimeEntry.objects.create(
        task=world.t1, user=world.owner, minutes=30, note="", entry_date=entry_date
    )
    client = APIClient()
    client.force_authenticate(user=world.owner)
    url = f"/api/v1/me/time-entries/?from={entry_date}&to={entry_date}"

    resp = client.get(url)
    assert resp.status_code == 200, resp.content
    assert str(world.t1.pk) in resp.content.decode(), "control: the entry must show while live"
    _trash(world.project)
    resp = client.get(url)
    assert resp.status_code == 200, resp.content
    assert str(world.t1.pk) not in resp.content.decode()


def test_bulk_edge_inside_a_trashed_project_is_rejected(world: World) -> None:
    """``POST /tasks/bulk/``'s per-edge role gate reads the edge's own project's role."""
    home = Project.objects.create(name="Home", code="HOME", start_date=date(2026, 4, 1))
    ProjectMembership.objects.create(project=home, user=world.owner, role=Role.OWNER)
    client = APIClient()
    client.force_authenticate(user=world.owner)
    url = f"/api/v1/projects/{home.pk}/tasks/bulk/"

    def body(pred: Task, succ: Task) -> dict[str, Any]:
        return {
            "operations": [{"op": "create", "data": {"name": "Unrelated", "duration": 1}}],
            "dependencies": {"created": [{"predecessor": str(pred.pk), "successor": str(succ.pk)}]},
        }

    # Control: while the project is live, the Owner's role on it admits the edge.
    t3 = Task.objects.create(project=world.project, name="T3", duration=1)
    with patch("trueppm_api.apps.projects.views._enqueue_recalculate"):
        resp = client.post(url, body(world.t2, t3), format="json")
    assert resp.status_code in (200, 207), resp.content
    assert Dependency.objects.filter(predecessor=world.t2, successor=t3).exists()

    _trash(world.project)
    with patch("trueppm_api.apps.projects.views._enqueue_recalculate"):
        resp = client.post(url, body(world.t1, world.t2), format="json")
    assert resp.status_code == 207, resp.content
    assert [e["code"] for e in resp.data["dependencies"]["rejected"]] == ["unresolved_endpoint"]
    assert not Dependency.objects.filter(predecessor=world.t1, successor=world.t2).exists()
