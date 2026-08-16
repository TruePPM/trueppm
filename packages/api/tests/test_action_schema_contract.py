"""The published contract for the #2840 actions must be the contract they honor.

Companion to ``test_action_schema_coverage.py``: that guard asserts an annotation
*exists*, this one asserts the annotation is *true*. Each test reads the shape out
of the committed ``docs/api/openapi.json`` and then calls the live endpoint, so the
declaration and the behavior cannot drift apart independently — which is precisely
what happened here. ``api:schema-drift`` proves only that the committed JSON matches
what the annotations generate; where the annotations were absent it compared a guess
against itself and passed.

Three shapes are pinned:

* ``add-member`` / ``remove-member`` (both mention-group viewsets) — a required
  ``{"user": <uuid>}`` body. Before the fix the operations declared **no
  requestBody at all**, because the custom-action fallback is the *read* serializer
  and a read serializer has no writable fields. A generated SDK method took no
  arguments for an endpoint that 400s without one.
* ``apply-preset`` — ``{"preset": …}`` in, a bare **array** of the whole preference
  matrix out. Both declared shapes were wrong in every field, and the response was
  wrong a second way once ``many=True`` was declared, because drf-spectacular
  re-wrapped it in the sibling list route's pagination envelope.
* the no-body actions (``dependencies/{id}/accept`` and ``reject``,
  ``resources/{id}/restore``, ``velocity-suggestions/{id}/accept`` and ``dismiss``,
  the four mute/unmute routes) — no ``requestBody``, and an empty POST succeeds.
  The three that fell back to a *write* serializer published a required full-object
  body; the rest published none only by accident of the read-serializer fallback.
"""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import (
    ProgramMembership,
    ProgramUserDefinedMentionGroup,
    ProjectMembership,
    Role,
    UserDefinedMentionGroup,
)
from trueppm_api.apps.notifications.models import NotificationPreference
from trueppm_api.apps.projects.models import (
    BacklogItem,
    BacklogItemStatus,
    BacklogItemType,
    Calendar,
    Dependency,
    Program,
    Project,
    Sprint,
    SprintState,
    Task,
)
from trueppm_api.apps.resources.models import Resource
from trueppm_api.apps.scheduling.models import VelocitySuggestion

User = get_user_model()


# ---------------------------------------------------------------------------
# Committed-schema access
# ---------------------------------------------------------------------------


def _load_schema() -> dict[str, Any]:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "docs" / "api" / "openapi.json"
        if candidate.exists():
            return json.loads(candidate.read_text())
    raise AssertionError("Could not locate docs/api/openapi.json above the test file.")


@pytest.fixture(scope="module")
def schema() -> dict[str, Any]:
    return _load_schema()


def _operation(schema: dict[str, Any], path: str, method: str = "post") -> dict[str, Any]:
    assert path in schema["paths"], f"{path} is missing from the committed schema."
    return schema["paths"][path][method]


def _resolve(schema: dict[str, Any], node: dict[str, Any]) -> dict[str, Any]:
    """Follow a single ``$ref`` into ``components/schemas``."""
    ref = node.get("$ref")
    if not ref:
        return node
    return schema["components"]["schemas"][ref.rsplit("/", 1)[-1]]


def _request_schema(schema: dict[str, Any], op: dict[str, Any]) -> dict[str, Any]:
    body = op["requestBody"]
    return _resolve(schema, body["content"]["application/json"]["schema"])


def _response_schema(
    schema: dict[str, Any], op: dict[str, Any], code: str = "200"
) -> dict[str, Any]:
    return op["responses"][code]["content"]["application/json"]["schema"]


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _client(user: object) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def program(db: object) -> Program:
    return Program.objects.create(name="Prog")


@pytest.fixture
def project(calendar: Calendar, program: Program) -> Project:
    return Project.objects.create(
        name="Proj", start_date=date(2026, 1, 1), calendar=calendar, program=program
    )


@pytest.fixture
def admin_user(project: Project, program: Program) -> Any:
    user = User.objects.create_user(username="contract_admin", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)
    ProgramMembership.objects.create(program=program, user=user, role=Role.OWNER)
    return user


@pytest.fixture
def teammate(project: Project, program: Program) -> Any:
    user = User.objects.create_user(username="contract_mate", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    ProgramMembership.objects.create(program=program, user=user, role=Role.MEMBER)
    return user


# ---------------------------------------------------------------------------
# 1. Mention-group roster: a required {"user": uuid} body
# ---------------------------------------------------------------------------


PROJECT_ADD = "/api/v1/projects/{project_pk}/mention-groups/{id}/add-member/"
PROJECT_REMOVE = "/api/v1/projects/{project_pk}/mention-groups/{id}/remove-member/"
PROGRAM_ADD = "/api/v1/programs/{program_pk}/mention-groups/{id}/add-member/"
PROGRAM_REMOVE = "/api/v1/programs/{program_pk}/mention-groups/{id}/remove-member/"


@pytest.mark.parametrize("path", [PROJECT_ADD, PROJECT_REMOVE, PROGRAM_ADD, PROGRAM_REMOVE])
def test_roster_actions_declare_the_required_user_body(schema: dict[str, Any], path: str) -> None:
    """Each roster action must publish the body it 400s without (#2840)."""
    op = _operation(schema, path)
    assert "requestBody" in op, (
        f"{path} publishes no requestBody, so a generated client has no way to send "
        "the `user` the endpoint requires — the original #2840 defect."
    )
    body = _request_schema(schema, op)
    assert body["properties"]["user"]["format"] == "uuid"
    assert body["required"] == ["user"]


@pytest.mark.django_db
def test_project_add_member_accepts_the_documented_body(
    schema: dict[str, Any], project: Project, admin_user: Any, teammate: Any
) -> None:
    """The documented ``{"user": …}`` body is accepted and returns the read shape."""
    group = UserDefinedMentionGroup.objects.create(project=project, name="devs")
    url = f"/api/v1/projects/{project.id}/mention-groups/{group.id}/add-member/"

    response = _client(admin_user).post(url, {"user": str(teammate.pk)}, format="json")

    assert response.status_code == 200, response.data
    declared = _resolve(schema, _response_schema(schema, _operation(schema, PROJECT_ADD)))
    assert set(response.data) >= set(declared["required"])
    assert group.members.filter(pk=teammate.pk).exists()


@pytest.mark.django_db
def test_project_add_member_rejects_the_empty_body_the_old_schema_implied(
    project: Project, admin_user: Any
) -> None:
    """The pre-fix schema's "no arguments" reading is a 400 — the reason this matters."""
    group = UserDefinedMentionGroup.objects.create(project=project, name="devs")
    url = f"/api/v1/projects/{project.id}/mention-groups/{group.id}/add-member/"

    response = _client(admin_user).post(url, {}, format="json")

    assert response.status_code == 400
    assert "user" in response.data


@pytest.mark.django_db
def test_program_add_member_accepts_the_documented_body(
    schema: dict[str, Any], program: Program, project: Project, admin_user: Any, teammate: Any
) -> None:
    """The program-side mirror carries the same contract as the project side."""
    group = ProgramUserDefinedMentionGroup.objects.create(program=program, name="leads")
    url = f"/api/v1/programs/{program.id}/mention-groups/{group.id}/add-member/"

    response = _client(admin_user).post(url, {"user": str(teammate.pk)}, format="json")

    assert response.status_code == 200, response.data
    declared = _resolve(schema, _response_schema(schema, _operation(schema, PROGRAM_ADD)))
    assert set(response.data) >= set(declared["required"])
    assert group.members.filter(pk=teammate.pk).exists()


# ---------------------------------------------------------------------------
# 2. apply-preset: {"preset": …} in, a bare array out
# ---------------------------------------------------------------------------


APPLY_PRESET = "/api/v1/me/notification-preferences/apply-preset/"


def test_apply_preset_declares_the_preset_body_and_an_array_response(
    schema: dict[str, Any],
) -> None:
    """Both sides were wrong in every field before #2840; pin both."""
    op = _operation(schema, APPLY_PRESET)

    body = _request_schema(schema, op)
    assert list(body["properties"]) == ["preset"]
    assert body["required"] == ["preset"]
    preset = _resolve(schema, body["properties"]["preset"])
    assert set(preset["enum"]) == {"signal_only", "everything"}

    response = _response_schema(schema, op)
    assert response["type"] == "array", (
        "apply-preset returns the whole matrix; a single object (the original defect) "
        "and a pagination envelope (the regression the many=True fix reintroduced) "
        "are both wrong."
    )
    assert response["items"]["$ref"].endswith("/NotificationPreference")


@pytest.mark.django_db
def test_apply_preset_returns_a_bare_array_of_preferences(
    schema: dict[str, Any], teammate: Any
) -> None:
    """The live response is a JSON array whose items match the declared component."""
    response = _client(teammate).post(APPLY_PRESET, {"preset": "signal_only"}, format="json")

    assert response.status_code == 200, response.data
    assert isinstance(response.data, list), (
        "The handler serializes get_queryset() with many=True — a list, not the "
        "single object nor the {count, results} envelope the schema used to declare."
    )
    assert response.data, "signal_only writes over the backfilled default matrix."

    declared = _resolve(schema, _response_schema(schema, _operation(schema, APPLY_PRESET))["items"])
    assert set(response.data[0]) >= set(declared["required"])
    assert NotificationPreference.objects.filter(user=teammate).exists()


@pytest.mark.django_db
def test_apply_preset_rejects_the_old_declared_body(teammate: Any) -> None:
    """The body the pre-fix schema declared is not one this endpoint accepts."""
    response = _client(teammate).post(
        APPLY_PRESET,
        {"event_type": "task.blocked", "channel": "in_app", "enabled": True},
        format="json",
    )

    assert response.status_code == 400


# ---------------------------------------------------------------------------
# 3. No-body actions: no requestBody, and an empty POST succeeds
# ---------------------------------------------------------------------------


NO_BODY_PATHS = [
    "/api/v1/dependencies/{id}/accept/",
    "/api/v1/dependencies/{id}/reject/",
    "/api/v1/resources/{id}/restore/",
    "/api/v1/velocity-suggestions/{id}/accept/",
    "/api/v1/velocity-suggestions/{id}/dismiss/",
    "/api/v1/projects/{project_pk}/mention-groups/{id}/mute/",
    "/api/v1/projects/{project_pk}/mention-groups/{id}/unmute/",
    "/api/v1/programs/{program_pk}/mention-groups/{id}/mute/",
    "/api/v1/programs/{program_pk}/mention-groups/{id}/unmute/",
]


@pytest.mark.parametrize("path", NO_BODY_PATHS)
def test_no_body_actions_declare_no_request_body(schema: dict[str, Any], path: str) -> None:
    """An action that never reads ``request.data`` must not publish a body.

    Three of these declared a *required* full write-serializer payload, so a
    generated client demanded a whole Dependency/Resource to act on one by id.
    """
    op = _operation(schema, path)
    assert "requestBody" not in op, (
        f"{path} reads nothing from request.data but publishes a requestBody — the "
        "serializer_class fallback the #2840 fix replaced with request=None."
    )


@pytest.mark.django_db
def test_mute_succeeds_with_an_empty_body(project: Project, teammate: Any) -> None:
    group = UserDefinedMentionGroup.objects.create(project=project, name="devs")
    url = f"/api/v1/projects/{project.id}/mention-groups/{group.id}/mute/"

    response = _client(teammate).post(url, {}, format="json")

    assert response.status_code == 200, response.data
    assert group.muted_by.filter(pk=teammate.pk).exists()


@pytest.mark.django_db
def test_dependency_accept_succeeds_with_an_empty_body(
    calendar: Calendar, program: Program, project: Project, admin_user: Any
) -> None:
    """A cross-project edge is accepted by URL alone — no Dependency payload."""
    downstream = Project.objects.create(
        name="Downstream", start_date=date(2026, 1, 1), calendar=calendar, program=program
    )
    ProjectMembership.objects.create(project=downstream, user=admin_user, role=Role.OWNER)
    predecessor = Task.objects.create(project=project, name="Up", duration=1)
    successor = Task.objects.create(project=downstream, name="Down", duration=1)
    dependency = Dependency.objects.create(
        predecessor=predecessor, successor=successor, pending_acceptance=True
    )

    response = _client(admin_user).post(f"/api/v1/dependencies/{dependency.id}/accept/")

    assert response.status_code == 200, response.data
    dependency.refresh_from_db()
    assert dependency.pending_acceptance is False
    assert response.data["id"] == str(dependency.pk)


@pytest.mark.django_db
def test_velocity_suggestion_accept_succeeds_with_an_empty_body(
    project: Project, admin_user: Any
) -> None:
    sprint = Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 1, 1),
        finish_date=date(2026, 1, 14),
        state=SprintState.COMPLETED,
    )
    task = Task.objects.create(
        project=project, name="Build", duration=2, most_likely_duration=2, sprint=sprint
    )
    suggestion = VelocitySuggestion.objects.create(
        task=task, sprint=sprint, suggested_duration=3, team_velocity_per_day=Decimal("1.5")
    )

    response = _client(admin_user).post(f"/api/v1/velocity-suggestions/{suggestion.id}/accept/")

    assert response.status_code == 200, response.data
    task.refresh_from_db()
    assert task.most_likely_duration == 3


@pytest.mark.django_db
def test_resource_restore_succeeds_with_an_empty_body(admin_user: Any) -> None:
    # IsOrgAdmin resolves off holding Admin+ on at least one project, which the
    # admin_user fixture already carries.
    resource = Resource.objects.create(name="Dana", is_deleted=True)

    response = _client(admin_user).post(f"/api/v1/resources/{resource.id}/restore/")

    assert response.status_code == 200, response.data
    resource.refresh_from_db()
    assert resource.is_deleted is False


# ---------------------------------------------------------------------------
# 4. backlog-items/{id}/pull — surfaced by the coverage guard's wider sweep
# ---------------------------------------------------------------------------


PULL = "/api/v1/programs/{program_pk}/backlog-items/{id}/pull/"


def test_pull_declares_its_own_request_and_envelope_response(schema: dict[str, Any]) -> None:
    """``pull`` takes ``{"project_id": …}`` and returns a 201 two-key envelope."""
    op = _operation(schema, PULL)

    body = _request_schema(schema, op)
    assert list(body["properties"]) == ["project_id"]
    assert body["properties"]["project_id"]["format"] == "uuid"

    assert "200" not in op["responses"], "The handler returns 201, never a bare 200."
    envelope = _resolve(schema, _response_schema(schema, op, "201"))
    assert set(envelope["properties"]) == {"task", "backlog_item"}


@pytest.mark.django_db
def test_pull_returns_the_documented_envelope(
    schema: dict[str, Any], program: Program, project: Project, admin_user: Any
) -> None:
    item = BacklogItem.objects.create(
        program=program,
        title="Idea",
        item_type=BacklogItemType.FEATURE,
        status=BacklogItemStatus.PROPOSED,
        created_by=admin_user,
    )
    url = f"/api/v1/programs/{program.id}/backlog-items/{item.id}/pull/"

    response = _client(admin_user).post(url, {"project_id": str(project.id)}, format="json")

    assert response.status_code == 201, response.data
    envelope = _resolve(schema, _response_schema(schema, _operation(schema, PULL), "201"))
    assert set(response.data) == set(envelope["properties"])
    assert Task.objects.filter(pk=response.data["task"]["id"]).exists()
