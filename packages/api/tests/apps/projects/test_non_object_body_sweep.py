"""Non-object JSON body sweep (#2796): list/scalar bodies get a 400, never a 500.

DRF's ``JSONParser`` accepts a top-level array or scalar, so ``request.data`` is not
guaranteed to expose ``.get``. Every handler below reads named fields off the raw
body (no serializer ``is_valid()`` ahead of it) and so has to call
``object_body(request)`` first. The second parametrization covers the #2785 class at
the same sites: a body that *is* an object but carries a non-string where a string
is read.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    BacklogItem,
    Program,
    Project,
    RetroBoardItem,
    Sprint,
    SprintRetro,
    SprintState,
    SprintTaskOutcome,
    Task,
    TaskStatus,
)
from trueppm_api.apps.resources.models import Calendar

User = get_user_model()

BAD_BODIES = [["not", "an", "object"], "scalar", 42]


@pytest.fixture
def owner(db: object) -> object:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def client(owner: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=owner)
    return c


@pytest.fixture
def project(owner: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    p = Project.objects.create(name="Sweep", start_date=date(2026, 1, 1), calendar=cal)
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    return p


@pytest.fixture
def program(owner: object) -> Program:
    p = Program.objects.create(name="Sweep program")
    ProgramMembership.objects.create(program=p, user=owner, role=Role.OWNER)
    return p


@pytest.fixture
def sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="S1",
        state=SprintState.ACTIVE,
        start_date=date(2026, 1, 1),
        finish_date=date(2026, 1, 14),
    )


@pytest.fixture
def outcome(project: Project, sprint: Sprint) -> SprintTaskOutcome:
    task = Task.objects.create(
        project=project, name="story", duration=1, sprint=sprint, status=TaskStatus.COMPLETE
    )
    return SprintTaskOutcome.objects.create(
        sprint=sprint,
        task=task,
        task_short_id="T-1",
        task_title="story",
        story_points=3,
        final_status="COMPLETE",
        disposition="completed",
    )


@pytest.fixture
def sticky(sprint: Sprint, owner: object) -> RetroBoardItem:
    retro = SprintRetro.objects.create(sprint=sprint, created_by=owner)
    return RetroBoardItem.objects.create(
        retro=retro, column="went_well", text="hi", position=1.0, author=owner
    )


@pytest.fixture
def backlog_item(program: Program) -> BacklogItem:
    return BacklogItem.objects.create(program=program, title="idea")


def _urls(
    project: Project,
    program: Program,
    sprint: Sprint,
    outcome: SprintTaskOutcome,
    sticky: RetroBoardItem,
    backlog_item: BacklogItem,
) -> list[tuple[str, str]]:
    return [
        ("post", f"/api/v1/sprints/{sprint.pk}/retro/"),
        ("post", f"/api/v1/sprints/{sprint.pk}/retro-board/"),
        ("put", f"/api/v1/sprints/{sprint.pk}/pulse/"),
        ("patch", f"/api/v1/retro-items/{sticky.pk}/"),
        ("post", f"/api/v1/sprint-task-outcomes/{outcome.pk}/toggle-demo/"),
        ("post", f"/api/v1/sprint-task-outcomes/{outcome.pk}/set-presenter/"),
        ("post", f"/api/v1/programs/{program.pk}/load-sample/"),
        ("post", f"/api/v1/programs/{program.pk}/backlog-items/{backlog_item.pk}/pull/"),
        ("post", "/api/v1/project-templates/publish/"),
    ]


@pytest.mark.parametrize("body", BAD_BODIES)
def test_non_object_body_is_400_not_500(
    client: APIClient,
    project: Project,
    program: Program,
    sprint: Sprint,
    outcome: SprintTaskOutcome,
    sticky: RetroBoardItem,
    backlog_item: BacklogItem,
    body: object,
) -> None:
    client.raise_request_exception = False
    for method, url in _urls(project, program, sprint, outcome, sticky, backlog_item):
        resp = getattr(client, method)(url, data=body, format="json")
        assert resp.status_code < 500, (method, url, resp.status_code)
        assert resp.status_code in (400, 404, 405), (method, url, resp.status_code)


@pytest.mark.parametrize("bad", [123, ["x"], {"a": 1}, True])
def test_non_string_values_are_400_not_500(
    client: APIClient,
    sprint: Sprint,
    outcome: SprintTaskOutcome,
    sticky: RetroBoardItem,
    bad: object,
) -> None:
    client.raise_request_exception = False
    cases = [
        ("post", f"/api/v1/sprints/{sprint.pk}/retro-board/", {"text": bad, "color": bad}),
        ("post", f"/api/v1/sprints/{sprint.pk}/retro-board/", {"text": "ok", "column": bad}),
        ("patch", f"/api/v1/retro-items/{sticky.pk}/", {"text": bad}),
        ("patch", f"/api/v1/retro-items/{sticky.pk}/", {"color": bad}),
        ("patch", f"/api/v1/retro-items/{sticky.pk}/", {"column": bad}),
        ("post", f"/api/v1/sprint-task-outcomes/{outcome.pk}/set-presenter/", {"presenter": bad}),
        ("post", f"/api/v1/sprints/{sprint.pk}/retro/", {"notes": bad}),
    ]
    for method, url, payload in cases:
        resp = getattr(client, method)(url, data=payload, format="json")
        assert resp.status_code < 500, (method, url, payload, resp.status_code)
    resp = client.post(f"/api/v1/sprints/{sprint.pk}/retro/", data={"notes": ["x"]}, format="json")
    assert resp.status_code == 400, resp.status_code
