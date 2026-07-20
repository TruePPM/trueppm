"""Regression tests for the nightly ``api:fuzz`` 500s (#2213).

Each test pins an endpoint that Schemathesis crashed with adversarial input and
asserts it now returns a clean 4xx instead of an unhandled 500. Grouped here (one
file) because a single batch fix spans several views:

- **Renderer** (#2213 group A): a serializer-less ``GenericViewSet`` under the
  DRF default renderer set built an HTML form for ``Accept: text/html`` and hit
  ``assert serializer_class is not None`` (500). Restricting to ``JSONRenderer``
  makes those requests a clean 406.
- **Non-object body**: ``request.data.get(...)`` on a fuzzed list/scalar body
  raised ``AttributeError`` (500) → now a 400.
- **Date query params**: unvalidated ``?start__gte=`` / ``?finish__lte=`` on
  ``DateField`` columns raised a Django ``ValidationError`` the UUID-only handler
  did not map (500) → now a 400.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Sprint,
    SprintState,
    SprintTaskOutcome,
    Task,
    TaskStatus,
)

User = get_user_model()


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


@pytest.fixture
def owner(db: object) -> object:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def project(owner: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    p = Project.objects.create(name="Fuzz", start_date=date(2026, 1, 1), calendar=cal)
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    return p


@pytest.fixture
def owner_client(owner: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=owner)
    return c


@pytest.fixture
def outcome(project: Project) -> SprintTaskOutcome:
    sprint = Sprint.objects.create(
        project=project,
        name="S1",
        state=SprintState.COMPLETED,
        start_date=date(2026, 1, 1),
        finish_date=date(2026, 1, 14),
    )
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


# --------------------------------------------------------------------------- #
# Group A — serializer-less viewset must not 500 on Accept: text/html
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "action",
    ["flag-for-backlog", "set-note", "set-presenter", "toggle-demo"],
)
def test_sprint_task_outcome_action_html_accept_not_500(
    owner_client: APIClient, outcome: SprintTaskOutcome, action: str
) -> None:
    """A fuzzed ``Accept: text/html`` used to select BrowsableAPIRenderer, whose
    form build fired ``assert serializer_class is not None`` on this serializer-less
    viewset → 500. JSON-only rendering now short-circuits to 406."""
    resp = owner_client.post(
        f"/api/v1/sprint-task-outcomes/{outcome.pk}/{action}/",
        data={},
        format="json",
        HTTP_ACCEPT="text/html",
    )
    assert resp.status_code != status.HTTP_500_INTERNAL_SERVER_ERROR
    assert resp.status_code == status.HTTP_406_NOT_ACCEPTABLE


# --------------------------------------------------------------------------- #
# Non-object request body must 400, not 500 (AttributeError on .get)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("body", [["not", "an", "object"], "scalar", 42])
def test_product_backlog_reorder_non_object_body_400(
    owner_client: APIClient, project: Project, body: object
) -> None:
    resp = owner_client.post(
        f"/api/v1/projects/{project.pk}/product-backlog/reorder/", data=body, format="json"
    )
    assert resp.status_code == status.HTTP_400_BAD_REQUEST


@pytest.mark.parametrize("body", [["not", "an", "object"], "scalar", 42])
def test_queue_reorder_non_object_body_400(
    owner_client: APIClient, project: Project, body: object
) -> None:
    resp = owner_client.post(
        f"/api/v1/projects/{project.pk}/queue/reorder/", data=body, format="json"
    )
    assert resp.status_code == status.HTTP_400_BAD_REQUEST


def test_reparent_non_object_body_400(owner_client: APIClient, project: Project) -> None:
    """reparent maps new_parent_id=None to 'move to root', so a malformed body must
    be an explicit 400 rather than degrading to None and silently rooting the task."""
    task = Task.objects.create(project=project, name="t", duration=1)
    resp = owner_client.post(
        f"/api/v1/projects/{project.pk}/tasks/{task.pk}/reparent/",
        data=["garbage"],
        format="json",
    )
    assert resp.status_code == status.HTTP_400_BAD_REQUEST


# --------------------------------------------------------------------------- #
# GET /tasks/ date-range params must 400 on a malformed date, not 500
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("param", ["start__gte", "finish__lte"])
def test_tasks_list_bad_date_param_400(
    owner_client: APIClient, project: Project, param: str
) -> None:
    resp = owner_client.get(f"/api/v1/tasks/?{param}=not-a-date")
    assert resp.status_code == status.HTTP_400_BAD_REQUEST


@pytest.mark.parametrize("param", ["start__gte", "finish__lte"])
def test_tasks_list_valid_date_param_ok(
    owner_client: APIClient, project: Project, param: str
) -> None:
    resp = owner_client.get(f"/api/v1/tasks/?{param}=2026-01-01")
    assert resp.status_code == status.HTTP_200_OK
