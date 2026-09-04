"""The declared 400 is checked against the body the endpoint actually returns (#3319).

#3286 mechanized the half of this that a predicate can reach: `requestBody`
present ⇔ DRF can raise `ValidationError`, so every body-bearing write got a 400.
The residue was two different problems, and both are the kind that only a live
request can settle.

**Part A** — two operations declared ``request=None`` while requiring a body. That
is worse than a missing error branch: the published contract said the endpoint
accepts nothing, so a generated client could not send the required field at all,
and ``apply`` answered ``{"project": "This field is required."}`` naming a field
the schema had never mentioned.

**Part B** — bodyless writes that refuse on the *state* of the thing they act on.
There is no signal to key that off, so each declaration was read out of the
handler by hand. The acceptance criterion is therefore not "a 400 is declared" but
"the declared body is the body that arrives", which is what every test here
asserts: each one drives the real refusal and validates the response against the
schema **as committed in `docs/api/openapi.json`**. A declaration that drifts from
the handler fails here rather than in an integrator's generated client.

The three wire shapes are not interchangeable, and the array one is the trap:
``ValidationError("a bare string")`` is wrapped by DRF into a list, so the body is
a top-level JSON array with no key to read the message under. A client typed
against an object throws while parsing. Those sites are asserted explicitly.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any

import jsonschema
import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    ProjectTemplate,
    Sprint,
    SprintState,
    Task,
    TemplateApplication,
    TemplateApplicationStatus,
    TemplateSource,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Contract harness — assert against the committed schema, not a restated copy
# ---------------------------------------------------------------------------


def _load_schema() -> dict[str, Any]:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "docs" / "api" / "openapi.json"
        if candidate.exists():
            return json.loads(candidate.read_text())  # type: ignore[no-any-return]
    raise AssertionError("Could not locate docs/api/openapi.json above the test file.")


@pytest.fixture(scope="module")
def schema() -> dict[str, Any]:
    return _load_schema()


def assert_matches_declared_400(
    schema: dict[str, Any], method: str, path_template: str, body: Any
) -> None:
    """Validate a real 400 body against the schema the contract publishes for it.

    Reads the committed artifact rather than a copy restated in the test, because
    a copy would keep passing while the published contract drifted — and the
    published contract is the thing an integrator generates a client from.

    Args:
        schema: The parsed ``docs/api/openapi.json``.
        method: Lowercase HTTP method.
        path_template: The templated path as it appears in the schema, e.g.
            ``/api/v1/sprints/{id}/``.
        body: The parsed response body the endpoint actually returned.
    """
    operation = schema["paths"][path_template][method]
    assert "400" in operation["responses"], (
        f"{method.upper()} {path_template} returned a 400 that the schema does not declare (#3319)."
    )
    declared = operation["responses"]["400"]["content"]["application/json"]["schema"]
    # ``ValidationErrorDetail`` is recursive and referenced as
    # ``#/components/schemas/...``, so ``components`` has to travel with the
    # fragment for the pointer to resolve against this schema's own root.
    jsonschema.validate(
        instance=body,
        schema={**declared, "components": schema["components"]},
    )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(username="owner", password="pw", email="owner@example.com")


@pytest.fixture
def client(owner: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=owner)
    return c


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar, owner: Any) -> Project:
    project = Project.objects.create(name="Alpha", start_date=date(2026, 3, 2), calendar=calendar)
    ProjectMembership.objects.create(project=project, user=owner, role=Role.OWNER)
    return project


# ---------------------------------------------------------------------------
# Part A — the two endpoints that declared `request=None` while requiring a body
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTemplateWriteBodiesAreDeclared:
    """``publish`` and ``apply`` require a body the schema said they did not take."""

    def test_publish_accepts_the_body_the_schema_now_declares(
        self, client: APIClient, project: Project, schema: dict[str, Any]
    ) -> None:
        """The declared fields are the fields the handler reads — golden path.

        Asserted before the refusals because a declaration that names fields the
        endpoint ignores is the same defect as one that omits fields it requires;
        only a successful round-trip through the declared shape rules that out.
        """
        Task.objects.create(project=project, name="Kickoff", duration=2, wbs_path="1")
        component = schema["components"]["schemas"]["ProjectTemplatePublishRequest"]
        payload = {
            "project": str(project.id),
            "name": "House shape",
            "description": "Standard delivery skeleton.",
            "source_kind": TemplateSource.WORKSPACE,
        }
        assert set(payload) <= set(component["properties"]), (
            "the golden-path payload must be expressible in the declared schema."
        )

        response = client.post("/api/v1/project-templates/publish/", payload, format="json")

        assert response.status_code == 201, response.data
        assert response.data["name"] == "House shape"

    def test_publish_refuses_a_missing_required_field_in_the_declared_shape(
        self, client: APIClient, project: Project, schema: dict[str, Any]
    ) -> None:
        """``name`` is required, and the refusal must match the published 400."""
        response = client.post(
            "/api/v1/project-templates/publish/", {"project": str(project.id)}, format="json"
        )

        assert response.status_code == 400
        assert_matches_declared_400(
            schema, "post", "/api/v1/project-templates/publish/", response.json()
        )

    def test_apply_names_a_field_the_schema_now_declares(
        self, client: APIClient, project: Project, schema: dict[str, Any]
    ) -> None:
        """The exact defect from the issue: a 400 naming a field the schema omitted.

        ``{"project": "This field is required."}`` was unactionable — the contract
        said the endpoint took no body, so there was no ``project`` for a client to
        send. The assertion is that the field named in the refusal is now present
        in the declared request schema.
        """
        template = ProjectTemplate.objects.create(
            name="Skeleton", is_published=True, structure={}, owner=None
        )

        response = client.post(f"/api/v1/project-templates/{template.id}/apply/", {}, format="json")

        assert response.status_code == 400
        body = response.json()
        assert "project" in body, body
        request_component = schema["components"]["schemas"]["ProjectTemplateApplyRequest"]
        assert "project" in request_component["properties"], (
            "apply refuses on `project`, so `project` has to be sendable per the schema."
        )
        assert_matches_declared_400(schema, "post", "/api/v1/project-templates/{id}/apply/", body)


# ---------------------------------------------------------------------------
# Part B — refusals on the state of the thing being acted on
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestUndoRefusalsOnState:
    """The three undo actions refuse a batch that is not in an undoable state."""

    def test_template_application_undo_refuses_a_non_success_application(
        self, client: APIClient, project: Project, owner: Any, schema: dict[str, Any]
    ) -> None:
        template = ProjectTemplate.objects.create(
            name="Skeleton", is_published=True, structure={}, owner=owner
        )
        application = TemplateApplication.objects.create(
            template=template,
            project=project,
            applied_by=owner,
            status=TemplateApplicationStatus.FAILED,
        )

        response = client.post(f"/api/v1/template-applications/{application.id}/undo/")

        assert response.status_code == 400
        assert_matches_declared_400(
            schema, "post", "/api/v1/template-applications/{id}/undo/", response.json()
        )


@pytest.mark.django_db
class TestArrayShapedRefusals:
    """``ValidationError("string")`` reaches the wire as a top-level JSON **array**.

    This is the shape a copy-pasted ``{"detail"}`` declaration gets wrong, and the
    failure it produces in a generated client is a parse error rather than a
    readable message — so it is asserted on the body itself, not just the schema.
    """

    def test_slip_conflict_acknowledge_returns_a_bare_array(
        self, client: APIClient, project: Project, owner: Any, schema: dict[str, Any]
    ) -> None:
        from trueppm_api.apps.projects.models import (
            CrossProjectSlipConflict,
            SlipConflictResolution,
        )

        task = Task.objects.create(project=project, name="Downstream", duration=3, wbs_path="1")
        sprint = Sprint.objects.create(
            project=project,
            name="Sprint 1",
            start_date=date(2026, 3, 2),
            finish_date=date(2026, 3, 13),
            state=SprintState.ACTIVE,
        )
        conflict = CrossProjectSlipConflict.objects.create(
            sprint=sprint,
            task=task,
            pushed_to=date(2026, 3, 20),
            resolution=SlipConflictResolution.AUTO_RESOLVED,
        )

        response = client.post(f"/api/v1/slip-conflicts/{conflict.id}/acknowledge/")

        assert response.status_code == 400
        body = response.json()
        assert isinstance(body, list), (
            "a bare-string ValidationError is wrapped by DRF into a list; the body "
            f"is an array, not an object (#3319). Got: {body!r}"
        )
        assert all(isinstance(item, str) for item in body)
        assert_matches_declared_400(
            schema, "post", "/api/v1/slip-conflicts/{id}/acknowledge/", body
        )

    def test_dependency_accept_on_a_settled_edge_returns_a_bare_array(
        self,
        client: APIClient,
        project: Project,
        calendar: Calendar,
        owner: Any,
        schema: dict[str, Any],
    ) -> None:
        """The same array shape, reached through a helper two calls down.

        Asserted separately from the slip-conflict site rather than assumed to
        match it: this refusal is raised inside ``_resolve_pending``, not in the
        handler DRF routes to, which is the shape of site a handler-local sweep
        cannot see. Proving the wire shape at a second, differently-reached site
        is what makes the declaration a finding rather than a copy.
        """
        from trueppm_api.apps.projects.models import Dependency, Program

        program = Program.objects.create(name="P1")
        project.program = program
        project.save(update_fields=["program"])
        downstream = Project.objects.create(
            name="Downstream", start_date=date(2026, 3, 2), calendar=calendar, program=program
        )
        ProjectMembership.objects.create(project=downstream, user=owner, role=Role.OWNER)
        predecessor = Task.objects.create(project=project, name="Up", duration=1)
        successor = Task.objects.create(project=downstream, name="Down", duration=1)
        # Already settled — `pending_acceptance` defaults to False, which is the
        # exact state the guard refuses on.
        dependency = Dependency.objects.create(predecessor=predecessor, successor=successor)

        response = client.post(f"/api/v1/dependencies/{dependency.id}/accept/")

        assert response.status_code == 400, response.content
        body = response.json()
        assert isinstance(body, list), (
            f"a refusal raised on a bare string is an array, not an object. Got: {body!r}"
        )
        assert_matches_declared_400(schema, "post", "/api/v1/dependencies/{id}/accept/", body)


@pytest.mark.django_db
class TestRestructureRefusals:
    """Indent and outdent refuse on the task's position, not on any request body."""

    def test_indent_refuses_the_first_task_at_its_level(
        self, client: APIClient, project: Project, schema: dict[str, Any]
    ) -> None:
        task = Task.objects.create(project=project, name="First", duration=2, wbs_path="1")

        response = client.post(f"/api/v1/projects/{project.id}/tasks/{task.id}/indent/")

        assert response.status_code == 400
        assert_matches_declared_400(
            schema,
            "post",
            "/api/v1/projects/{id}/tasks/{task_id}/indent/",
            response.json(),
        )

    def test_indent_under_a_milestone_carries_the_declared_code(
        self, client: APIClient, project: Project, schema: dict[str, Any]
    ) -> None:
        """The one site whose refusal really puts a ``code`` on the wire.

        Declared as an enum rather than as prose because the handler writes it into
        a literal response dict. A ``ValidationError(..., code=...)`` keyword never
        reaches the client (#2550), so declaring a code there would have inverted
        this fix — this asserts the difference is real and not assumed.
        """
        Task.objects.create(
            project=project, name="Gate", duration=0, wbs_path="1", is_milestone=True
        )
        task = Task.objects.create(project=project, name="Work", duration=2, wbs_path="2")

        response = client.post(f"/api/v1/projects/{project.id}/tasks/{task.id}/indent/")

        assert response.status_code == 400
        body = response.json()
        assert body["code"] == "child_of_milestone", body
        declared = schema["paths"]["/api/v1/projects/{id}/tasks/{task_id}/indent/"]["post"][
            "responses"
        ]["400"]["content"]["application/json"]["schema"]
        assert body["code"] in declared["properties"]["code"]["enum"], (
            "the declared code enum must contain the code the endpoint emits."
        )
        assert_matches_declared_400(
            schema, "post", "/api/v1/projects/{id}/tasks/{task_id}/indent/", body
        )

    def test_outdent_refuses_a_root_level_task(
        self, client: APIClient, project: Project, schema: dict[str, Any]
    ) -> None:
        task = Task.objects.create(project=project, name="Root", duration=2, wbs_path="1")

        response = client.post(f"/api/v1/projects/{project.id}/tasks/{task.id}/outdent/")

        assert response.status_code == 400
        assert_matches_declared_400(
            schema,
            "post",
            "/api/v1/projects/{id}/tasks/{task_id}/outdent/",
            response.json(),
        )


@pytest.mark.django_db
class TestDestroyRefusalsOnState:
    """DELETE handlers whose refusal lives in ``perform_destroy``.

    These were invisible to the issue's original sweep, which matched ``@action``
    handlers only — the refusal is not in the handler DRF routes to but in the
    hook that handler calls.
    """

    def test_deleting_a_phase_with_descendants_is_refused(
        self, client: APIClient, project: Project, schema: dict[str, Any]
    ) -> None:
        Task.objects.create(project=project, name="Phase 1", duration=0, wbs_path="1")
        Task.objects.create(project=project, name="Child", duration=3, wbs_path="1.1")
        phase = Task.objects.get(project=project, wbs_path="1")

        response = client.delete(f"/api/v1/projects/{project.id}/phases/{phase.id}/")

        assert response.status_code == 400
        assert_matches_declared_400(
            schema, "delete", "/api/v1/projects/{project_pk}/phases/{id}/", response.json()
        )

    def test_deleting_an_active_sprint_is_refused(
        self, client: APIClient, project: Project, schema: dict[str, Any]
    ) -> None:
        sprint = Sprint.objects.create(
            project=project,
            name="Sprint 1",
            start_date=date(2026, 3, 2),
            finish_date=date(2026, 3, 13),
            state=SprintState.ACTIVE,
        )

        response = client.delete(f"/api/v1/sprints/{sprint.id}/")

        assert response.status_code == 400
        assert_matches_declared_400(schema, "delete", "/api/v1/sprints/{id}/", response.json())

    def test_force_deleting_an_unarchived_project_is_refused(
        self, client: APIClient, project: Project, schema: dict[str, Any]
    ) -> None:
        """Reachable only with ``?force=true`` — a plain DELETE always soft-deletes.

        The declaration says so, and this pins the pairing: the same request
        without the flag must not 400, or the declaration would be describing a
        refusal on the wrong condition.
        """
        response = client.delete(f"/api/v1/projects/{project.id}/?force=true")

        assert response.status_code == 400
        assert_matches_declared_400(schema, "delete", "/api/v1/projects/{id}/", response.json())

    def test_a_plain_delete_of_the_same_project_is_not_refused(
        self, client: APIClient, project: Project
    ) -> None:
        """The negative control for the assertion above."""
        response = client.delete(f"/api/v1/projects/{project.id}/")

        assert response.status_code == 204


@pytest.mark.django_db
class TestUnknownPathSegmentRefusals:
    """``{source}`` / ``{provider}`` are free text, so an unregistered value 400s.

    Not a 404: the *route* matched, and the endpoint is telling the caller the
    identifier is not one it knows. Both directions matter — a client that expects
    404 here retries the wrong recovery.
    """

    @pytest.mark.parametrize(
        ("method", "url", "path_template"),
        [
            (
                "delete",
                "/api/v1/me/connections/not-a-source/",
                "/api/v1/me/connections/{source}/",
            ),
            (
                "post",
                "/api/v1/me/connections/not-a-source/sync/",
                "/api/v1/me/connections/{source}/sync/",
            ),
            (
                "delete",
                "/api/v1/me/credentials/not-a-provider/",
                "/api/v1/me/credentials/{provider}/",
            ),
        ],
    )
    def test_an_unregistered_identifier_is_refused(
        self,
        client: APIClient,
        schema: dict[str, Any],
        method: str,
        url: str,
        path_template: str,
    ) -> None:
        response = getattr(client, method)(url)

        assert response.status_code == 400, response.content
        assert_matches_declared_400(schema, method, path_template, response.json())


@pytest.mark.django_db
class TestFieldKeyedRefusals:
    """Refusals whose body is DRF's field-keyed object rather than a flat detail."""

    @pytest.mark.parametrize("method", ["post", "delete"])
    def test_a_malformed_week_start_is_refused_under_its_field_key(
        self, client: APIClient, schema: dict[str, Any], method: str
    ) -> None:
        """``week_start`` is a path segment, so a malformed value reaches the handler.

        The body is keyed by ``week_start``, not a flat ``detail`` — declaring the
        detail shape here would mis-type the refusal for every client.
        """
        response = getattr(client, method)("/api/v1/me/timesheets/not-a-date/submit")

        assert response.status_code == 400, response.content
        body = response.json()
        assert "week_start" in body, body
        assert_matches_declared_400(
            schema, method, "/api/v1/me/timesheets/{week_start}/submit", body
        )

    def test_personal_token_cap_refusal_fits_the_declared_shape(
        self, client: APIClient, owner: Any, schema: dict[str, Any], settings: Any
    ) -> None:
        """The cap is a refusal on the caller's *state*, not on the body.

        This operation publishes no ``requestBody`` — its ``serializer_class`` is
        the all-read-only read serializer while ``create`` reaches for the write
        serializer itself — so #3286's injection could not see it and the 400 is
        declared by hand.
        """
        settings.TRUEPPM_MAX_PERSONAL_ACCESS_TOKENS = 1
        first = client.post("/api/v1/me/api-tokens/", {"name": "one"}, format="json")
        assert first.status_code == 201, first.data

        response = client.post("/api/v1/me/api-tokens/", {"name": "two"}, format="json")

        assert response.status_code == 400, response.content
        assert_matches_declared_400(schema, "post", "/api/v1/me/api-tokens/", response.json())


@pytest.mark.django_db
class TestMembershipRefusals:
    """Removing a member can be refused by the roster's own state."""

    def test_removing_the_last_owner_is_refused(
        self, client: APIClient, project: Project, owner: Any, schema: dict[str, Any]
    ) -> None:
        membership = ProjectMembership.objects.get(project=project, user=owner)

        response = client.delete(f"/api/v1/projects/{project.id}/members/{membership.id}/")

        assert response.status_code == 400, response.content
        assert_matches_declared_400(
            schema, "delete", "/api/v1/projects/{project_pk}/members/{id}/", response.json()
        )


@pytest.mark.django_db
class TestWorkspaceRefusals:
    """The workspace danger surface refuses on its typed-confirmation state."""

    def test_deleting_the_workspace_without_the_confirmation_header_is_refused(
        self, schema: dict[str, Any]
    ) -> None:
        superuser = User.objects.create_superuser(
            username="root", password="pw", email="root@example.com"
        )
        client = APIClient()
        client.force_authenticate(user=superuser)

        response = client.delete("/api/v1/workspace/")

        assert response.status_code == 400, response.content
        assert_matches_declared_400(schema, "delete", "/api/v1/workspace/", response.json())

    def test_send_test_without_an_operator_email_answers_its_own_envelope(
        self, schema: dict[str, Any]
    ) -> None:
        """Declared as ``{sent, error}`` because that is what it returns.

        Not the house ``{"detail"}`` refusal shape — this endpoint answers with the
        same pair on its 400 and its 502 so a client renders one banner for either.
        Declaring the house shape would have been the comfortable copy-paste and
        would have mis-typed every failure of this endpoint.
        """
        operator = User.objects.create_superuser(username="ops", password="pw", email="")
        client = APIClient()
        client.force_authenticate(user=operator)

        response = client.post("/api/v1/workspace/email-settings/send-test/")

        assert response.status_code == 400, response.content
        body = response.json()
        assert body["sent"] is False
        assert "error" in body
        assert "detail" not in body, (
            "this endpoint does not use the house refusal envelope; the declaration "
            "must follow the body, not the convention (#3319)."
        )
        assert_matches_declared_400(
            schema, "post", "/api/v1/workspace/email-settings/send-test/", body
        )


@pytest.mark.django_db
def test_no_bodyless_write_declares_the_injected_400_description(schema: dict[str, Any]) -> None:
    """#3286's injection must still not reach a bodyless operation (#3319).

    Part A moved two operations *into* the injected set by giving them the body
    they always required. This asserts the move was that and not a widening of the
    predicate — a bodyless write carrying the injected description would mean the
    mechanism had started inventing refusals, which is the failure #3286 was
    written to avoid.
    """
    injected = "The request was rejected. Either a field failed validation"
    invented = [
        f"{method.upper()} {path}"
        for path, ops in schema["paths"].items()
        for method, op in ops.items()
        if method in ("post", "put", "patch", "delete")
        and "requestBody" not in op
        and injected in (op.get("responses", {}).get("400", {}).get("description") or "")
    ]
    assert not invented, f"the 400 injection reached a bodyless operation: {invented}"
