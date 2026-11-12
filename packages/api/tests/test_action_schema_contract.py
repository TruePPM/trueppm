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
  ``{"user": <integer pk>}`` body. Before the fix the operations declared **no
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
def operator_user(db: Any) -> Any:
    """A workspace operator — the install superuser (ADR-0213 C1).

    Distinct from ``admin_user`` on purpose. #3569 raised the resource-catalog
    deactivation lifecycle off the project-membership-derived ``IsOrgAdmin``, which
    any account self-grants by creating a project, onto ``IsWorkspaceOperator``.
    A contract test for one of those actions needs this principal; ``admin_user``
    holds OWNER on a project and is no longer sufficient.
    """
    return User.objects.create_superuser(username="contract_operator", password="pw")


@pytest.fixture
def teammate(project: Project, program: Program) -> Any:
    user = User.objects.create_user(username="contract_mate", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    ProgramMembership.objects.create(program=program, user=user, role=Role.MEMBER)
    return user


# ---------------------------------------------------------------------------
# 1. Mention-group roster: a required {"user": <integer pk>} body
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
    # User PKs are integers (#4293): the handler runs ``User.objects.get(pk=...)``,
    # so ``format: uuid`` made the body unsendable for a schema-validating SDK.
    assert body["properties"]["user"]["type"] == "integer"
    assert "format" not in body["properties"]["user"]
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


@pytest.mark.django_db
@pytest.mark.parametrize("as_string", [False, True], ids=["integer", "stringified-integer"])
def test_add_and_remove_member_accept_integer_and_stringified_integer_user(
    project: Project, admin_user: Any, teammate: Any, as_string: bool
) -> None:
    """The declared integer body works, and so does the web client's stringified one (#4293)."""
    group = UserDefinedMentionGroup.objects.create(project=project, name="devs")
    base = f"/api/v1/projects/{project.id}/mention-groups/{group.id}"
    value: Any = str(teammate.pk) if as_string else teammate.pk

    added = _client(admin_user).post(f"{base}/add-member/", {"user": value}, format="json")
    assert added.status_code == 200, added.data
    assert group.members.filter(pk=teammate.pk).exists()

    removed = _client(admin_user).post(f"{base}/remove-member/", {"user": value}, format="json")
    assert removed.status_code == 200, removed.data
    assert not group.members.filter(pk=teammate.pk).exists()


@pytest.mark.django_db
@pytest.mark.parametrize("as_string", [False, True], ids=["integer", "stringified-integer"])
def test_program_add_and_remove_member_accept_integer_and_stringified_user(
    program: Program, project: Project, admin_user: Any, teammate: Any, as_string: bool
) -> None:
    group = ProgramUserDefinedMentionGroup.objects.create(program=program, name="leads")
    base = f"/api/v1/programs/{program.id}/mention-groups/{group.id}"
    value: Any = str(teammate.pk) if as_string else teammate.pk

    added = _client(admin_user).post(f"{base}/add-member/", {"user": value}, format="json")
    assert added.status_code == 200, added.data
    assert group.members.filter(pk=teammate.pk).exists()

    removed = _client(admin_user).post(f"{base}/remove-member/", {"user": value}, format="json")
    assert removed.status_code == 200, removed.data
    assert not group.members.filter(pk=teammate.pk).exists()


_USER_PK_EXACT_NAMES = frozenset(
    {"user", "actor", "owner", "assignee", "author", "reviewer", "approver", "requester"}
)

# Known non-user uuid ids that the name patterns below would otherwise flag.
_NON_USER_UUID_ALLOWLIST = frozenset(
    {
        "SprintCapacityMember.member_id",  # a Resource id
        "AuditEvent.target_id",  # the audited object, any model
        "ApiTokenAuditEntry.token",  # a token row id
    }
)


def _looks_like_user_ref(prop: str) -> bool:
    return (
        prop in _USER_PK_EXACT_NAMES
        or prop.endswith("_by")
        or prop.endswith("_by_id")
        or any(prop == f"{n}_id" or prop == f"{n}_ids" for n in _USER_PK_EXACT_NAMES)
        or prop in {"user_ids", "member_ids"}
    )


def _declares_uuid(node: dict[str, Any]) -> bool:
    """True when the node, its ``items`` or any ``allOf``/``oneOf``/``anyOf`` arm is a uuid."""
    if node.get("format") == "uuid":
        return True
    if isinstance(node.get("items"), dict) and _declares_uuid(node["items"]):
        return True
    return any(
        _declares_uuid(arm)
        for key in ("allOf", "oneOf", "anyOf")
        for arm in node.get(key, [])
        if isinstance(arm, dict)
    )


def _user_pk_uuid_offenders(schema: dict[str, Any]) -> list[str]:
    return [
        f"{comp}.{prop}"
        for comp, body in schema["components"]["schemas"].items()
        for prop, node in (body.get("properties") or {}).items()
        if _looks_like_user_ref(prop)
        and _declares_uuid(node)
        and f"{comp}.{prop}" not in _NON_USER_UUID_ALLOWLIST
    ]


def test_no_user_pk_property_is_declared_uuid(schema: dict[str, Any]) -> None:
    """No component property named like a user reference may declare ``format: uuid``.

    This is a NAME heuristic, not a proof: a user id under an unrelated name
    (``lead``, ``who``) is not seen, and a match is judged by name alone, hence
    the small explicit allowlist of known non-user ids. User PKs are integers, so
    a uuid claim on one is a claim no value can satisfy (#4293, same class as #2633).
    """
    offenders = _user_pk_uuid_offenders(schema)
    assert not offenders, f"User PKs are integers, not UUIDs: {offenders}"


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
    # Annotated actions that carried a responses= but no request=, so the viewset's
    # write serializer was published as a required body.
    "/api/v1/me/notifications/mark-all-read/",
    "/api/v1/programs/{id}/close/",
    "/api/v1/programs/{id}/reopen/",
    "/api/v1/programs/{id}/remove-sample/",
    "/api/v1/projects/{id}/archive/",
    "/api/v1/projects/{id}/unarchive/",
    "/api/v1/projects/{id}/product-backlog/auto-rank/",
    "/api/v1/projects/{project_pk}/tasks/{task_pk}/comments/{id}/acknowledge/",
    "/api/v1/sprints/{id}/activate/",
    "/api/v1/sprints/{id}/cancel/",
    "/api/v1/sprints/{id}/unbind-milestone/",
    "/api/v1/sprints/{id}/retrospective/action-items/{item_pk}/promote/",
    "/api/v1/scope-changes/{id}/accept/",
    "/api/v1/scope-changes/{id}/reject/",
    "/api/v1/tasks/{id}/approve-estimates/",
    "/api/v1/projects/{project_pk}/task-runs/{id}/cancel/",
    "/api/v1/projects/{project_pk}/webhooks/{id}/test/",
    "/api/v1/programs/{program_pk}/webhooks/{id}/test/",
    "/api/v1/tasks/{id}/suggestions/{suggestion_pk}/accept/",
    "/api/v1/tasks/{id}/suggestions/{suggestion_pk}/decline/",
    "/api/v1/tasks/{id}/suggestions/{suggestion_pk}/revoke/",
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
def test_resource_restore_succeeds_with_an_empty_body(operator_user: Any) -> None:
    # `restore` requires IsWorkspaceOperator since #3569 — the whole deactivation
    # lifecycle sits on the install superuser, because it reaches every project
    # holding an assignment. This test pins the empty-body contract, not the gate,
    # so it takes the principal that can reach the action; `admin_user` (OWNER on a
    # project) is deliberately no longer enough. The gate itself is covered in
    # tests/apps/resources/test_org_resources.py.
    resource = Resource.objects.create(name="Dana", is_deleted=True)

    response = _client(operator_user).post(f"/api/v1/resources/{resource.id}/restore/")

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


def test_documented_roster_body_example_matches_the_declared_type(schema: dict[str, Any]) -> None:
    """The published ``add-member`` JSON example must satisfy the declared body type (#4293)."""
    doc = (
        Path(__file__).resolve().parents[3]
        / "packages/website/src/content/docs/api/reference/collaboration.md"
    ).read_text()
    marker = "**`add-member` and `remove-member` take a body**"
    assert marker in doc
    block = doc.split(marker, 1)[1].split("```json", 1)[1].split("```", 1)[0]
    example = json.loads(block)
    declared = _request_schema(schema, _operation(schema, PROJECT_ADD))["properties"]["user"]
    assert declared["type"] == "integer"
    assert isinstance(example["user"], int), example


# ---------------------------------------------------------------------------
# Actions that DO read a body: the declared shape must be the one they validate
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("path", "expected_properties"),
    [
        ("/api/v1/sprints/{id}/close/", {"carry_over_to", "pending_disposition"}),
        ("/api/v1/sprints/{id}/scope-changes/accept/", {"ids"}),
        ("/api/v1/sprints/{id}/scope-changes/reject/", {"ids"}),
        ("/api/v1/tasks/{id}/split/", {"name"}),
    ],
)
def test_body_reading_actions_declare_the_body_they_validate(
    schema: dict[str, Any], path: str, expected_properties: set[str]
) -> None:
    """These fell back to a whole-object write serializer (``SprintRequest`` etc.)."""
    declared = _request_schema(schema, _operation(schema, path))
    assert set(declared["properties"]) == expected_properties
    # Every field has a default or is optional, so none of the old whole-object
    # required fields (name, start_date, ...) may leak back in.
    assert not set(declared.get("required", [])) - expected_properties


@pytest.mark.django_db
def test_archive_and_unarchive_succeed_with_an_empty_body(
    project: Project, admin_user: Any
) -> None:
    client = _client(admin_user)

    archived = client.post(f"/api/v1/projects/{project.id}/archive/")
    assert archived.status_code == 200, archived.data
    unarchived = client.post(f"/api/v1/projects/{project.id}/unarchive/")
    assert unarchived.status_code == 200, unarchived.data


@pytest.mark.django_db
def test_mark_all_read_succeeds_with_an_empty_body(admin_user: Any) -> None:
    response = _client(admin_user).post("/api/v1/me/notifications/mark-all-read/")

    assert response.status_code == 200, response.data
    assert response.data == {"updated": 0}


# Empty-body smoke over the remaining corrected no-body endpoints. Each case builds the
# cheapest real object so the request reaches the handler; "not rejected for the body"
# means no 415 and no 400 that names a missing field. A 400/409 for a refused *state*
# (a sprint with nothing to activate) is a handler decision, not a body rejection.
def _fake_id_urls(project: Project) -> list[str]:
    fake = "00000000-0000-0000-0000-000000000001"
    return [
        f"/api/v1/projects/{project.id}/tasks/{fake}/comments/{fake}/acknowledge/",
        f"/api/v1/sprints/{fake}/retrospective/action-items/{fake}/promote/",
        f"/api/v1/projects/{project.id}/task-runs/{fake}/cancel/",
        f"/api/v1/projects/{project.id}/webhooks/{fake}/test/",
    ]


def _sprint(project: Project, state: str) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 1, 1),
        finish_date=date(2026, 1, 14),
        state=state,
    )


def _live_empty_body_urls(project: Project, program: Program) -> dict[str, str]:
    from trueppm_api.apps.projects.models import TaskSuggestedAssignee

    suggested = User.objects.create_user(username="contract_suggested", password="pw")
    ProjectMembership.objects.create(project=project, user=suggested, role=Role.MEMBER)
    task = Task.objects.create(project=project, name="T", duration=1)
    urls: dict[str, str] = {}
    for verb in ("accept", "decline", "revoke"):
        # One task per suggestion: a PENDING (task, user) pair is unique.
        sug_task = Task.objects.create(project=project, name=f"S-{verb}", duration=1)
        sug = TaskSuggestedAssignee.objects.create(task=sug_task, suggested_user=suggested)
        urls[f"suggestion-{verb}"] = f"/api/v1/tasks/{sug_task.id}/suggestions/{sug.id}/{verb}/"
    urls["sprint-activate"] = (
        f"/api/v1/sprints/{_sprint(project, SprintState.PLANNED).id}/activate/"
    )
    urls["sprint-cancel"] = f"/api/v1/sprints/{_sprint(project, SprintState.PLANNED).id}/cancel/"
    urls["sprint-unbind-milestone"] = (
        f"/api/v1/sprints/{_sprint(project, SprintState.PLANNED).id}/unbind-milestone/"
    )
    urls["program-close"] = f"/api/v1/programs/{program.id}/close/"
    urls["program-reopen"] = f"/api/v1/programs/{program.id}/reopen/"
    urls["program-remove-sample"] = f"/api/v1/programs/{program.id}/remove-sample/"
    urls["auto-rank"] = f"/api/v1/projects/{project.id}/product-backlog/auto-rank/"
    urls["approve-estimates"] = f"/api/v1/tasks/{task.id}/approve-estimates/"
    return urls


def _assert_not_body_rejected(response: Any, url: str) -> None:
    assert response.status_code != 415, f"{url} rejected the empty body's media type"
    if response.status_code == 400:
        assert "required" not in json.dumps(response.data).lower(), (
            f"{url} 400 names a missing field for an empty body: {response.data}"
        )


@pytest.mark.django_db
@pytest.mark.parametrize(
    "key",
    [
        "suggestion-accept",
        "suggestion-decline",
        "suggestion-revoke",
        "sprint-activate",
        "sprint-cancel",
        "sprint-unbind-milestone",
        "program-close",
        "program-reopen",
        "program-remove-sample",
        "auto-rank",
        "approve-estimates",
    ],
)
def test_no_body_endpoints_are_not_rejected_for_an_empty_body(
    key: str, project: Project, program: Program, admin_user: Any
) -> None:
    """Live setup, real object: the empty-body POST reaches the handler."""
    url = _live_empty_body_urls(project, program)[key]
    response = _client(admin_user).post(url)

    _assert_not_body_rejected(response, url)
    # A body rejection would be a 400; these all have a happy path or a state refusal.
    assert response.status_code < 500, response.data


@pytest.mark.django_db
def test_suggestion_routes_return_2xx_with_an_empty_body(
    project: Project, program: Program, admin_user: Any
) -> None:
    """Accept, decline and revoke each succeed live (not merely 'not 400')."""
    urls = _live_empty_body_urls(project, program)
    # Accept and decline are the suggested user's alone; revoke is the manager's.
    suggested = User.objects.get(username="contract_suggested")
    for verb, actor in (("accept", suggested), ("decline", suggested), ("revoke", admin_user)):
        response = _client(actor).post(urls[f"suggestion-{verb}"])
        assert response.status_code == 200, (verb, response.data)


@pytest.mark.django_db
def test_remaining_no_body_routes_resolve_and_are_not_body_rejected(
    project: Project, admin_user: Any
) -> None:
    """Heavy-setup endpoints (comment acknowledge, retro promote, task-run cancel,
    webhook test ping): an unknown id answers 404, which proves routing and the
    absence of a 415 only — body validation is not exercised there. The schema half
    (``NO_BODY_PATHS``) is what pins those four."""
    client = _client(admin_user)
    for url in _fake_id_urls(project):
        response = client.post(url)
        assert response.status_code in (404, 403), (url, response.status_code)
        assert response.status_code != 415


# ---------------------------------------------------------------------------
# estimate_status: '' is not a value the published contract admits
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_blank_estimate_status_is_rejected_by_the_model(project: Project) -> None:
    """The model no longer allows ``''``; the read-only field has no path that writes it."""
    from django.core.exceptions import ValidationError

    task = Task.objects.create(project=project, name="T", duration=1)
    task.estimate_status = ""
    with pytest.raises(ValidationError) as excinfo:
        task.full_clean(exclude=["project", "wbs_path"])
    assert "estimate_status" in excinfo.value.message_dict


def test_estimate_status_is_not_client_writable() -> None:
    """No serializer path can store ``''``: the field is read-only on the task serializer.

    The other writers (MS Project/Jira import, the seed importer and replay, the
    approve-estimates action) assign ``ACCEPTED``/``None`` literals, never client input.
    """
    from trueppm_api.apps.projects.serializers import TaskSerializer

    assert TaskSerializer().fields["estimate_status"].read_only


@pytest.mark.django_db
def test_repair_normalizes_blank_estimate_status_without_touching_versions(
    project: Project,
) -> None:
    """The #2600 data repair clears ``''`` on Task and HistoricalTask rows.

    It must not bump ``server_version`` or write a history row: the column is derived
    governance state, so a repair that looked like a user edit would re-sync every
    repaired task to offline clients.
    """
    from trueppm_api.apps.projects.estimate_status_repair import normalize_blank_estimate_status
    from trueppm_api.apps.projects.models import HistoricalTask

    task = Task.objects.create(project=project, name="T", duration=1)
    untouched = Task.objects.create(
        project=project, name="Pending", duration=1, estimate_status="pending"
    )
    # queryset.update() bypasses validation, which is how legacy rows got here.
    Task.objects.filter(pk=task.pk).update(estimate_status="")
    HistoricalTask.objects.filter(id=task.pk).update(estimate_status="")
    version_before = Task.objects.get(pk=task.pk).server_version
    history_before = HistoricalTask.objects.filter(id=task.pk).count()

    repaired = normalize_blank_estimate_status(Task, HistoricalTask)

    assert repaired >= 2
    task.refresh_from_db()
    assert task.estimate_status is None
    assert not HistoricalTask.objects.filter(estimate_status="").exists()
    assert task.server_version == version_before
    assert HistoricalTask.objects.filter(id=task.pk).count() == history_before
    untouched.refresh_from_db()
    assert untouched.estimate_status == "pending"


@pytest.mark.django_db
def test_full_clean_accepts_null_estimate_status_and_rejects_blank(project: Project) -> None:
    """NULL ("not tracked") must stay valid while ``''`` is refused (#2600).

    Dropping ``blank=True`` alone also rejects NULL, because Django's blank check fires
    for every value in ``empty_values`` and NULL is the normal state of the column.
    """
    from django.core.exceptions import ValidationError

    task = Task.objects.create(project=project, name="T", duration=1)
    assert task.estimate_status is None
    task.full_clean()

    task.estimate_status = "accepted"
    task.full_clean()

    task.estimate_status = ""
    with pytest.raises(ValidationError) as exc:
        task.full_clean()
    assert "estimate_status" in exc.value.message_dict


# ---------------------------------------------------------------------------
# Body-reading actions declare the body they read, not the viewset's whole object
# ---------------------------------------------------------------------------

# (method, path, body component, required fields, a property that must be present)
DECLARED_BODIES = [
    (
        "post",
        "/api/v1/sprints/{id}/retrospective/action-items/{item_pk}/pull-to-sprint/",
        "PullActionItemToSprintBodyRequest",
        {"target_sprint_id"},
        "target_sprint_id",
    ),
    (
        "post",
        "/api/v1/sprints/{id}/retro-board/",
        "RetroBoardItemCreateBodyRequest",
        {"text"},
        "column",
    ),
    ("put", "/api/v1/sprints/{id}/pulse/", "PulseBodyRequest", {"mood", "energy"}, "confidence"),
    (
        "post",
        "/api/v1/sprints/{id}/promote-to-milestone/",
        "PromoteToMilestoneRequestRequest",
        set(),
        "milestone_id",
    ),
    ("post", "/api/v1/programs/load-sample/", "LoadSampleBodyRequest", set(), "sample"),
    ("post", "/api/v1/programs/{id}/split/", "ProgramSplitBodyRequest", {"splits"}, "splits"),
    (
        "post",
        "/api/v1/programs/{id}/transfer-sponsorship/",
        "SponsorshipTransferBodyRequest",
        {"new_owner_user_id"},
        "new_lead_user_id",
    ),
    (
        "post",
        "/api/v1/projects/{id}/transfer/",
        "OwnershipTransferBodyRequest",
        {"new_owner_user_id"},
        "new_owner_user_id",
    ),
    (
        "post",
        "/api/v1/projects/{id}/product-backlog/reorder/",
        "ProductBacklogReorderBodyRequest",
        {"stories"},
        "stories",
    ),
    ("post", "/api/v1/projects/{id}/queue/reorder/", "QueueReorderBodyRequest", {"tasks"}, "tasks"),
    (
        "patch",
        "/api/v1/programs/{id}/risk-policy/",
        "PatchedProgramRiskPolicyRequest",
        set(),
        None,
    ),
    (
        "patch",
        "/api/v1/programs/{id}/rollup-config/",
        "PatchedProgramRollupConfigRequest",
        set(),
        None,
    ),
]


@pytest.mark.parametrize(
    ("method", "path", "component", "required", "prop"),
    DECLARED_BODIES,
    ids=[f"{m}:{p}" for m, p, *_ in DECLARED_BODIES],
)
def test_body_reading_actions_declare_the_body_they_read(
    schema: dict[str, Any],
    method: str,
    path: str,
    component: str,
    required: set[str],
    prop: str | None,
) -> None:
    """Each fell back to ``SprintRequest``/``ProgramRequest``/``ProjectRequest``.

    That published a whole-object payload (name, start_date, ...) for an endpoint that
    reads one or two fields, so a generated SDK demanded fields the handler ignores and
    never mentioned the one it needs.
    """
    op = _operation(schema, path, method)
    ref = op["requestBody"]["content"]["application/json"]["schema"]["$ref"]
    assert ref.rsplit("/", 1)[-1] == component
    body = schema["components"]["schemas"][component]
    assert set(body.get("required", [])) == required
    if prop is not None:
        assert prop in body["properties"]
    assert "name" not in body["properties"] or component.startswith("PromoteToMilestone")


@pytest.mark.django_db
def test_pulse_put_accepts_the_declared_body(project: Project, teammate: Any) -> None:
    sprint = Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 1, 1),
        finish_date=date(2026, 1, 14),
        state=SprintState.ACTIVE,
    )

    response = _client(teammate).put(
        f"/api/v1/sprints/{sprint.id}/pulse/", {"mood": 4, "energy": 3}, format="json"
    )

    assert response.status_code == 200, response.data
    assert response.data["mood"] == 4


@pytest.mark.django_db
def test_pull_to_sprint_requires_the_declared_target_sprint_id(
    project: Project, admin_user: Any
) -> None:
    from trueppm_api.apps.projects.models import RetroActionItem, SprintRetro

    sprint = Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 1, 1),
        finish_date=date(2026, 1, 14),
        state=SprintState.COMPLETED,
    )
    retro = SprintRetro.objects.create(sprint=sprint)
    item = RetroActionItem.objects.create(retro=retro, text="Fix CI")

    response = _client(admin_user).post(
        f"/api/v1/sprints/{sprint.id}/retrospective/action-items/{item.id}/pull-to-sprint/",
        {},
        format="json",
    )

    assert response.status_code == 400, response.data
    assert "target_sprint_id" in response.data
