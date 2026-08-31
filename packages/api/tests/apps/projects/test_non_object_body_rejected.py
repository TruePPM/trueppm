"""A JSON body that is a list must 400, never 500 (#3278, the #2795 class).

``Request.data`` is ``dict | list`` — a top-level JSON array is a legal body, and
``request.data.get(...)`` on one raises ``AttributeError``, which DRF renders as
a **500**. Every endpoint below used to do exactly that; each now narrows the
container before the first field read.

Two of these are worth calling out because a plausible-looking guard did *not*
protect them:

* ``field-values`` tested ``"value" not in request.data`` first — but ``in`` also
  tests membership of a *list's elements*, so ``["value"]`` sailed past it and
  died on the subscript one line later;
* ``set-presenter`` and ``set-note`` already carried ``isinstance(..., str)``
  value guards, which is the trait that defines this bug class: the value guard
  sits downstream of the container access that has already blown up.

The assertion is deliberately ``== 400`` and never ``!= 500``: a guard that
returned 404 or 403 would pass the weaker form while telling the caller the wrong
thing about their request.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    CustomFieldType,
    Label,
    LabelColor,
    Project,
    ProjectCustomField,
    RetroBoardItem,
    Sprint,
    SprintRetro,
    SprintState,
    SprintTaskDisposition,
    SprintTaskOutcome,
    Task,
    TaskStatus,
)

User = get_user_model()
pytestmark = pytest.mark.django_db

#: The default body under test. Non-empty on purpose — an empty list is falsy, so
#: it survives the `(request.data or {})` idiom that a populated one defeats.
LIST_BODY: list[Any] = [{"nice": "try"}]

#: `field-values` needs a *different* list. Its handler starts with
#: `if "value" not in <body>`, and `in` tests a list's **elements** — so
#: `[{"nice": "try"}]` takes the "field is required" branch and 400s for a reason
#: that has nothing to do with the container, which would make this case vacuous
#: (it passed against the unguarded handler). `["value"]` is the body that gets
#: past the membership test and reaches the subscript that actually breaks.
VALUE_MEMBER_BODY: list[Any] = ["value"]


@pytest.fixture
def project() -> Project:
    return Project.objects.create(
        name="P", start_date=date(2026, 4, 1), calendar=Calendar.objects.create(name="Std")
    )


@pytest.fixture
def admin(project: Project) -> Any:
    user = User.objects.create_user(username="admin", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    return user


@pytest.fixture
def client(admin: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=admin)
    return c


@pytest.fixture
def sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.ACTIVE,
    )


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="T", duration=1)


@pytest.fixture
def outcome(sprint: Sprint, task: Task) -> SprintTaskOutcome:
    return SprintTaskOutcome.objects.create(
        sprint=sprint,
        task=task,
        task_short_id="0000000B",
        task_title="T",
        final_status=TaskStatus.COMPLETE,
        disposition=SprintTaskDisposition.COMPLETED,
    )


def _cases(
    project: Project,
    sprint: Sprint,
    task: Task,
    outcome: SprintTaskOutcome,
    sticky: RetroBoardItem,
    label: Label,
    field: ProjectCustomField,
) -> dict[str, tuple[str, str, list[Any]]]:
    """``{case name: (http method, url, body)}`` — one entry per narrowed handler."""
    return {
        "toggle-demo": (
            "post",
            f"/api/v1/sprint-task-outcomes/{outcome.pk}/toggle-demo/",
            LIST_BODY,
        ),
        "set-presenter": (
            "post",
            f"/api/v1/sprint-task-outcomes/{outcome.pk}/set-presenter/",
            LIST_BODY,
        ),
        "set-note": (
            "post",
            f"/api/v1/sprint-task-outcomes/{outcome.pk}/set-note/",
            LIST_BODY,
        ),
        "retro-item-patch": ("patch", f"/api/v1/retro-items/{sticky.pk}/", LIST_BODY),
        "retro-post": ("post", f"/api/v1/sprints/{sprint.pk}/retro/", LIST_BODY),
        "retro-patch": ("patch", f"/api/v1/sprints/{sprint.pk}/retro/", LIST_BODY),
        "retro-board-post": ("post", f"/api/v1/sprints/{sprint.pk}/retro-board/", LIST_BODY),
        "pulse-put": ("put", f"/api/v1/sprints/{sprint.pk}/pulse/", LIST_BODY),
        "demo-reorder": ("post", f"/api/v1/sprints/{sprint.pk}/demo-list/reorder/", LIST_BODY),
        "label-attach": (
            "post",
            f"/api/v1/projects/{project.pk}/tasks/{task.pk}/labels/",
            LIST_BODY,
        ),
        "field-value-put": (
            "put",
            f"/api/v1/projects/{project.pk}/tasks/{task.pk}/field-values/{field.pk}/",
            VALUE_MEMBER_BODY,
        ),
    }


@pytest.fixture
def sticky(sprint: Sprint, admin: Any) -> RetroBoardItem:
    return RetroBoardItem.objects.create(
        retro=SprintRetro.objects.create(sprint=sprint, created_by=admin),
        column="went_well",
        text="orig",
        position=1.0,
    )


@pytest.fixture
def label(project: Project, admin: Any) -> Label:
    return Label.objects.create(
        project=project, name="tech-debt", color=LabelColor.AMBER, created_by=admin
    )


@pytest.fixture
def field(project: Project) -> ProjectCustomField:
    return ProjectCustomField.objects.create(
        project=project, name="Team", field_type=CustomFieldType.TEXT
    )


@pytest.mark.parametrize(
    "case",
    [
        "toggle-demo",
        "set-presenter",
        "set-note",
        "retro-item-patch",
        "retro-post",
        "retro-patch",
        "retro-board-post",
        "pulse-put",
        "demo-reorder",
        "label-attach",
        "field-value-put",
    ],
)
def test_list_body_is_rejected_with_400(
    case: str,
    client: APIClient,
    project: Project,
    sprint: Sprint,
    task: Task,
    outcome: SprintTaskOutcome,
    sticky: RetroBoardItem,
    label: Label,
    field: ProjectCustomField,
) -> None:
    method, url, body = _cases(project, sprint, task, outcome, sticky, label, field)[case]
    resp = getattr(client, method)(url, body, format="json")
    assert resp.status_code == 400, (case, resp.status_code, getattr(resp, "data", None))


def test_the_rejection_names_the_envelope_not_a_field(
    client: APIClient, outcome: SprintTaskOutcome
) -> None:
    """The caller has to be able to tell "wrong shape" from "bad value"."""
    resp = client.post(
        f"/api/v1/sprint-task-outcomes/{outcome.pk}/toggle-demo/", LIST_BODY, format="json"
    )
    assert resp.data == {"detail": "Request body must be a JSON object."}


def test_an_object_body_still_works(client: APIClient, outcome: SprintTaskOutcome) -> None:
    """The negative control: the guard rejects the container, not the request."""
    resp = client.post(
        f"/api/v1/sprint-task-outcomes/{outcome.pk}/toggle-demo/",
        {"demo_ready": True},
        format="json",
    )
    assert resp.status_code == 200, resp.data
    assert resp.data["demo_ready"] is True
