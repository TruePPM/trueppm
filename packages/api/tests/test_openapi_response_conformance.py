"""What an endpoint DECLARES must match what it RETURNS (#2583).

``api:schema-drift`` proves the committed ``docs/api/openapi.json`` matches what
drf-spectacular generates from the current code. It cannot prove either one
matches a real response body — when the annotation is missing or a heuristic
misfires, the generator faithfully emits the wrong schema and both sides agree
perfectly. That blind spot shipped two contract-breaking endpoints (#2583) and had
already been recorded once (#2515). The nightly ``api:fuzz`` job does compare
declaration against body, but it is schedule-only and non-gating, so a break
reaches ``main`` and sits there until someone reads the JUnit artifact.

This module closes the loop at MR time, from both ends:

* **Statically**, across the whole surface: an ``@action`` must not publish its
  viewset's default serializer as its response unless the handler actually
  produces it. That is the exact fingerprint of "no ``@extend_schema``, so
  drf-spectacular fell back to ``serializer_class``" — how
  ``GET /sprints/{id}/duration-events/`` came to promise a ``Sprint`` for a
  ``{events: [...]}`` body. It needs no allowlist: the codebase has zero
  offenders once #2583 is fixed.

* **At runtime**, per endpoint: issue the request and validate the body against
  the operation's declared schema with ``jsonschema``. This is the only check
  that catches a declaration which is present, explicit, and still wrong — the
  audit-events case, where ``responses={200: AuditEventSerializer(many=True)}``
  was hand-written and published a ``type: array`` for a cursor envelope. Any
  test in the suite can adopt :func:`assert_response_matches_schema`.

The static rule alone would have missed instance 1; the runtime rule alone only
covers endpoints someone remembered to cover. Together they bracket the class.
"""

from __future__ import annotations

import inspect
import json
import re
from datetime import date
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from drf_spectacular.generators import SchemaGenerator
from jsonschema import Draft202012Validator
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    DurationChangePercentPolicy,
    Project,
    Sprint,
    SprintState,
    Task,
)
from trueppm_api.apps.workspace.models import (
    AuditEventType,
    Workspace,
    WorkspaceMembership,
    WorkspaceRole,
)
from trueppm_api.apps.workspace.services import record_audit_event

User = get_user_model()

_HTTP_METHODS = frozenset({"get", "post", "put", "patch", "delete"})


# ---------------------------------------------------------------------------
# Reading the committed contract
# ---------------------------------------------------------------------------


def load_committed_schema() -> dict[str, Any]:
    """Parse ``docs/api/openapi.json`` — the artifact integrators generate SDKs from.

    Deliberately the committed file rather than a fresh generation: it is what a
    client actually holds, and ``api:schema-drift`` separately proves it matches
    the code. Validating against the file means this test is asserting on the
    published contract, not on an in-process reconstruction of it.

    Public so a feature's own test module can adopt this check next to the
    behavior it covers, rather than every endpoint's conformance test having to
    live here (#2649).
    """
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "docs" / "api" / "openapi.json"
        if candidate.exists():
            return json.loads(candidate.read_text())
    raise AssertionError("Could not locate docs/api/openapi.json above the test file.")


@pytest.fixture(scope="module")
def committed_schema() -> dict[str, Any]:
    return load_committed_schema()


def as_json_schema(node: Any) -> Any:
    """Rewrite OpenAPI 3.0 dialect into JSON Schema so a validator can read it.

    drf-spectacular emits OpenAPI 3.0.3, which is *not* a JSON Schema dialect. Two
    of its divergences matter here and both would otherwise produce false failures
    that a reader would misread as real contract breaks:

    * ``nullable: true`` is OpenAPI-only. JSON Schema spells it as a union with
      ``"null"``. Left untranslated, every legitimately-null field (``next``,
      ``previous``, ``actor_id``, …) reports "None is not of type 'string'".
    * ``exclusiveMinimum``/``exclusiveMaximum`` are booleans modifying
      ``minimum``/``maximum`` in 3.0, but numbers in their own right in JSON Schema.

    A ``nullable`` sibling of ``$ref`` cannot become a type union (the ``$ref``
    would be ignored), so it becomes an explicit ``anyOf`` instead.
    """
    if isinstance(node, list):
        return [as_json_schema(item) for item in node]
    if not isinstance(node, dict):
        return node

    converted = {key: as_json_schema(value) for key, value in node.items() if key != "nullable"}

    for bound, keyword in (("minimum", "exclusiveMinimum"), ("maximum", "exclusiveMaximum")):
        if not isinstance(converted.get(keyword), bool):
            continue
        # OpenAPI 3.0 spells it as a boolean flag on the sibling bound; JSON Schema
        # spells it as the bound itself, and drops the plain one.
        if converted.pop(keyword) and bound in converted:
            converted[keyword] = converted.pop(bound)

    if not node.get("nullable"):
        return converted
    if isinstance(converted.get("type"), str):
        converted["type"] = [converted["type"], "null"]
        return converted
    return {"anyOf": [converted, {"type": "null"}]}


def declared_response_schema(
    schema: dict[str, Any], path: str, method: str, status_code: str = "200"
) -> dict[str, Any]:
    """The JSON response schema an operation declares, with ``components`` attached.

    ``components`` rides along on the returned schema so the document's
    ``#/components/schemas/...`` pointers resolve against it — the validator then
    needs no external resolver and cannot reach the network.
    """
    operation = schema["paths"][path][method.lower()]
    body = (
        operation.get("responses", {})
        .get(status_code, {})
        .get("content", {})
        .get("application/json", {})
        .get("schema")
    )
    assert body is not None, (
        f"{method.upper()} {path} declares no {status_code} JSON schema at all — "
        "a generated client gets an untyped body (#2583)."
    )
    return as_json_schema({**body, "components": schema["components"]})


def assert_response_matches_schema(
    schema: dict[str, Any],
    response: Any,
    path: str,
    method: str = "get",
    status_code: str = "200",
) -> None:
    """Validate a live response body against the contract the schema publishes.

    ``path`` is the *templated* OpenAPI path (``/api/v1/sprints/{id}/duration-events/``),
    not the concrete URL — that is the key the document is indexed by.
    """
    assert str(response.status_code) == status_code, (
        f"expected {status_code} from {method.upper()} {path}, got {response.status_code}"
    )
    validator = Draft202012Validator(declared_response_schema(schema, path, method, status_code))
    errors = sorted(validator.iter_errors(response.json()), key=lambda e: list(e.absolute_path))
    assert not errors, (
        f"{method.upper()} {path} returned a body its own OpenAPI schema rejects — "
        "a generated SDK breaks on this call (#2583):\n  "
        + "\n  ".join(f"at {list(e.absolute_path) or '<root>'}: {e.message}" for e in errors)
    )


# ---------------------------------------------------------------------------
# Static rule: an @action must not inherit a serializer it never produces
# ---------------------------------------------------------------------------

# Either call proves the handler builds its response from *a* serializer, so
# inheriting the viewset's ``serializer_class`` into the schema is truthful. The
# third witness — naming the serializer class outright — is checked separately
# because it depends on which component the operation declares.
_PRODUCES_SERIALIZER = ("get_serializer", "serializer_class")


def _component_for_default_serializer(view: Any) -> str | None:
    """The component name drf-spectacular mints for a viewset's ``serializer_class``."""
    serializer_class = getattr(view, "serializer_class", None)
    if serializer_class is None:
        return None
    name = serializer_class.__name__
    return name[: -len("Serializer")] if name.endswith("Serializer") else name


def _handler_and_helpers_source(view: Any, handler: Any) -> str:
    """The handler's source plus that of any ``self._helper()`` it delegates to.

    One level deep on purpose. Several actions are a single delegating line
    (``return self._mutate_membership(request, add=True)``) whose serializer use
    lives in the helper; without following that hop the rule would fire on a dozen
    correct endpoints and be neutered by an allowlist. Two levels has no caller in
    this codebase, so the extra reach would be untested code.
    """
    try:
        sources = [inspect.getsource(handler)]
    except (OSError, TypeError):  # pragma: no cover - handler without source
        return ""
    for helper_name in set(re.findall(r"self\.(_\w+)\(", sources[0])):
        helper = getattr(type(view), helper_name, None)
        if helper is None:
            continue
        try:
            sources.append(inspect.getsource(helper))
        except (OSError, TypeError):  # pragma: no cover - builtin//C helper
            continue
    return "\n".join(sources)


def action_inherits_a_serializer_it_never_produces(
    declared_component: str | None, default_component: str | None, source: str
) -> bool:
    """Is this the "no ``@extend_schema``, fell back to ``serializer_class``" fingerprint?

    True only when both hold: the operation declares exactly the viewset's default
    serializer component, and the handler's own code never produces it. An action
    that legitimately returns that serializer passes — whether it goes through
    ``get_serializer`` (``restore``, ``accept``, ``dismiss``) or instantiates the
    class by name (``Response(ProgramSerializer(fresh).data)`` in ``close`` /
    ``reopen`` / ``activate``). Both spellings are common here and neither is a
    defect, so recognizing only one would force an allowlist of correct endpoints
    — and an allowlist is how a gate stops being read.

    Known blind spot, characterized rather than unknown (#2595): naming the
    serializer is a substring test, so a handler that nests it inside a composite
    body (``{"task": …, "backlog_item": BacklogItemSerializer(item).data}``)
    satisfies the escape hatch while still not returning the declared type.
    Tightening this predicate would re-flag the correct endpoints above; the
    orthogonal lever tracked in #2595 is a status-code rule, since that shape is
    also documented under the wrong status code.
    """
    if declared_component is None or default_component is None:
        return False
    if declared_component != default_component:
        return False
    if f"{declared_component}Serializer" in source:
        return False
    return not any(call in source for call in _PRODUCES_SERIALIZER)


def test_no_action_publishes_a_serializer_its_handler_never_returns() -> None:
    """An ``@action`` with no ``responses=`` silently publishes the wrong type.

    drf-spectacular has to guess a response for an unannotated action, and its
    guess is the viewset's ``serializer_class``. When the handler returns a service
    payload instead, the schema does not merely under-describe the endpoint — it
    names a different type. ``GET /sprints/{id}/duration-events/`` advertised
    ``Sprint`` while returning ``{events: [...]}``, so a typed client was actively
    misled rather than left guessing (#2583). Its sibling
    ``GET /tasks/{id}/duration-events/`` was annotated from the start; the same
    feature, one path guarded and the other not.

    This also backstops the #2455 decorator-drift trap from the other side: when a
    stacked ``@extend_schema`` slides onto the action below it, the action it was
    written for is left bare and falls back here.
    """
    schema = SchemaGenerator().get_schema(request=None, public=True)
    generator = SchemaGenerator()
    generator.parse(None, public=True)
    views = {
        (path, method.upper()): view
        for path, _regex, method, view in generator._get_paths_and_endpoints()
    }

    offenders = []
    for path, operations in schema.get("paths", {}).items():
        for method, operation in operations.items():
            if method.lower() not in _HTTP_METHODS:
                continue
            view = views.get((path, method.upper()))
            if view is None:
                continue
            action = getattr(view, "action", None)
            handler = getattr(type(view), action, None) if action else None
            # ``mapping`` is the router attribute only a custom ``@action`` carries;
            # stock CRUD handlers genuinely do return the default serializer.
            if handler is None or not hasattr(handler, "mapping"):
                continue

            declared = (
                (
                    operation.get("responses", {})
                    .get("200", {})
                    .get("content", {})
                    .get("application/json", {})
                    .get("schema", {})
                    .get("$ref", "")
                    .rsplit("/", 1)[-1]
                )
                or None
            )

            if action_inherits_a_serializer_it_never_produces(
                declared,
                _component_for_default_serializer(view),
                _handler_and_helpers_source(view, handler),
            ):
                offenders.append(
                    f"{method.upper()} {path} -> {declared} "
                    f"({type(view).__name__}.{action} never builds a {declared})"
                )

    assert not offenders, (
        "These actions publish their viewset's default serializer but never return "
        "one — the schema names a type the endpoint does not produce. Add an "
        "explicit @extend_schema(responses=...) describing the real payload:\n  "
        + "\n  ".join(sorted(offenders))
    )


def test_the_static_rule_fires_on_the_shape_it_guards() -> None:
    """The gate must bite — a guard that cannot fail guards nothing.

    Reproduces #2583 instance 2 exactly (declared ``Sprint``, handler returns a
    service payload) and pins the three shapes that must keep passing, so the rule
    cannot be widened into a no-op by a later "simplification".
    """
    payload_handler = "return Response(sprint_duration_change_payload(sprint))"
    serializer_handler = "return Response(self.get_serializer(suggestion).data)"

    # The defect: declared component IS the viewset default, handler never builds it.
    assert action_inherits_a_serializer_it_never_produces("Sprint", "Sprint", payload_handler)

    # Must keep passing.
    assert not action_inherits_a_serializer_it_never_produces(
        "Sprint", "Sprint", serializer_handler
    ), "an action that calls get_serializer legitimately returns the default serializer"
    assert not action_inherits_a_serializer_it_never_produces(
        "SprintDurationChangeEventList", "Sprint", payload_handler
    ), "an explicitly declared response is the fix, not a finding"
    assert not action_inherits_a_serializer_it_never_produces(None, "Sprint", payload_handler), (
        "an action declaring a non-$ref response (array, inline object) is not this defect"
    )


# ---------------------------------------------------------------------------
# Runtime conformance fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def admin_client(project: Project) -> APIClient:
    user = User.objects.create_user(username="pm", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def owner_client(db: object) -> APIClient:
    """A workspace Owner — the only role ``IsWorkspaceAuditViewer`` admits."""
    user = User.objects.create_user(username="ws_owner", password="pw", email="owner@x.io")
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=user, role=WorkspaceRole.OWNER
    )
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _sprint_with_a_duration_change(client: APIClient, project: Project) -> Sprint:
    """An ACTIVE sprint carrying one recorded duration change.

    PRORATE so ``percent_complete_after`` is non-null — the nullable field a
    keep/confirm policy would leave unexercised.
    """
    workspace = Workspace.load()
    workspace.task_duration_change_percent_policy = DurationChangePercentPolicy.PRORATE
    workspace.save()

    sprint = Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.ACTIVE,
    )
    task = Task.objects.create(
        project=project, name="Design", duration=10, percent_complete=50.0, sprint=sprint
    )
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        response = client.patch(f"/api/v1/tasks/{task.pk}/", {"duration": 20}, format="json")
    assert response.status_code == 200
    return sprint


# ---------------------------------------------------------------------------
# Runtime conformance: the two #2583 instances and the sibling that was correct
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_sprint_duration_events_body_matches_its_declared_schema(
    committed_schema: dict[str, Any], admin_client: APIClient, project: Project
) -> None:
    """#2583 instance 2: the body is ``{events: [...]}``, and the schema now says so.

    Before the fix this endpoint declared ``$ref: Sprint``; a ``{events: [...]}``
    body has none of ``Sprint``'s required fields, so this validation would fail on
    the first required-property error.
    """
    sprint = _sprint_with_a_duration_change(admin_client, project)

    response = admin_client.get(f"/api/v1/sprints/{sprint.pk}/duration-events/")

    assert list(response.json()) == ["events"], "the payload is a single `events` key"
    assert len(response.json()["events"]) == 1
    assert_response_matches_schema(
        committed_schema, response, "/api/v1/sprints/{id}/duration-events/"
    )


@pytest.mark.django_db
def test_sprint_duration_events_empty_feed_matches_its_declared_schema(
    committed_schema: dict[str, Any], admin_client: APIClient, project: Project
) -> None:
    """The empty feed is still an object with ``events``, never a bare ``[]``."""
    sprint = Sprint.objects.create(
        project=project,
        name="S2",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.ACTIVE,
    )

    response = admin_client.get(f"/api/v1/sprints/{sprint.pk}/duration-events/")

    assert response.json() == {"events": []}
    assert_response_matches_schema(
        committed_schema, response, "/api/v1/sprints/{id}/duration-events/"
    )


@pytest.mark.django_db
def test_audit_events_body_matches_its_declared_schema(
    committed_schema: dict[str, Any], owner_client: APIClient
) -> None:
    """#2583 instance 1: a cursor envelope, not the bare array the schema promised.

    The pre-fix declaration was ``type: array``; an object body fails that
    immediately, which is precisely what broke SDK callers iterating the response.
    """
    record_audit_event(event_type=AuditEventType.SETTINGS_CHANGED, actor=None)

    response = owner_client.get("/api/v1/workspace/audit-events/")

    body = response.json()
    assert set(body) == {"next", "previous", "results"}, (
        "cursor pagination emits next/previous/results and deliberately no count"
    )
    assert len(body["results"]) == 1
    assert_response_matches_schema(committed_schema, response, "/api/v1/workspace/audit-events/")


@pytest.mark.django_db
def test_task_duration_events_body_matches_its_declared_schema(
    committed_schema: dict[str, Any], admin_client: APIClient, project: Project
) -> None:
    """The sibling that was always correct — the control for the two above.

    ``GET /tasks/{id}/duration-events/`` declared ``PaginatedTaskDurationChangeEventList``
    from the start. If this fails, the validator is broken rather than the API.
    """
    sprint = _sprint_with_a_duration_change(admin_client, project)
    task = Task.objects.get(sprint=sprint)

    response = admin_client.get(f"/api/v1/tasks/{task.pk}/duration-events/")

    assert_response_matches_schema(
        committed_schema, response, "/api/v1/tasks/{id}/duration-events/"
    )


@pytest.mark.django_db
def test_the_runtime_check_rejects_the_pre_fix_body(
    committed_schema: dict[str, Any], owner_client: APIClient
) -> None:
    """The runtime gate must bite: the #2583 mismatch has to fail validation.

    Validates the real cursor envelope against the *array* schema the endpoint used
    to declare. A passing assertion here proves the helper is not vacuously green —
    which is the only thing that makes the four tests above meaningful.
    """
    record_audit_event(event_type=AuditEventType.SETTINGS_CHANGED, actor=None)
    body = owner_client.get("/api/v1/workspace/audit-events/").json()

    pre_fix_declaration = as_json_schema(
        {
            "type": "array",
            "items": {"$ref": "#/components/schemas/AuditEvent"},
            "components": committed_schema["components"],
        }
    )
    errors = list(Draft202012Validator(pre_fix_declaration).iter_errors(body))

    assert errors, "the cursor envelope must NOT validate against the old `type: array`"
    assert "is not of type 'array'" in errors[0].message
