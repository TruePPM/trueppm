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
- **PROTECT-ed delete** (#2364): deleting a ``Calendar`` still applied by a
  project, program, workspace, resource, or overlay layer raised an uncaught
  ``ProtectedError`` (500) → now a 409 naming what still references it.

The last group grew past the one endpoint the fuzzer found. Reviewing it surfaced
the same defect at three more sites, because the bug is not about calendars — it
is a delete path written against the ``PROTECT`` FKs that existed at the time,
silently rotting as new ones land:

- ``DELETE /skills/{id}/`` — both FKs into ``Skill`` PROTECT → 409 naming the
  resources tagged with it and the tasks requiring it.
- ``DELETE /projects/{id}/?force=true`` and ``POST /programs/{id}/remove-sample/``
  — these are *confirmed* irreversible deletes, so the right answer is to purge
  the PROTECT-ing children, not to refuse; both listed memberships but not mention
  groups. A 409 would be unactionable (the user cannot detach a mention group from
  a delete dialog).
- ``purge_soft_deleted_projects`` carries the same stale assumption and aborts a
  whole retention batch — tracked separately as #2372 since it is a background
  job, not a status code.

``test_protect_relations_snapshot`` is the guard that generalizes: it pins the
resolved ``PROTECT`` set per model so the *next* such FK fails a test rather than
a nightly.

**Format-suffix pk on projects/programs/tasks (#3044).** The 2026-08-21 nightly
also reported 12 ``not_a_server_error`` failures — GET/PUT/PATCH/DELETE 500ing on
``/api/v1/projects/0.5/``, ``/api/v1/programs/0.5/``, and ``/api/v1/tasks/0.5/``.
All twelve were one defect, already fixed the same morning by #2989 (merged
09:57, before the fuzz run's failures were triaged): ``/projects/0.5/`` parses as
pk="0", format="5"; DRF's content negotiation rejects the unknown format inside
``initial()`` — *before* ``perform_authentication()`` runs; ``exception_handler``
calls ``set_rollback()`` for that ``NotAcceptable`` under ``ATOMIC_REQUESTS``; and
``McpReadableViewMixin.finalize_response`` (which all three viewsets use) used to
read the lazy ``request.successful_authenticator`` property, triggering
authentication for the first time against an already-poisoned transaction and
raising ``TransactionManagementError`` instead of letting the 406 through. #2989
fixed the guard and added one regression test (a PAT-authenticated GET on
``/projects/{id}.xyz/``). The tests below close #3044 by pinning the exact
fuzzer-reported surface — all three resources, all four methods, real JWT auth
(matching how ``api:fuzz`` authenticates, not ``force_authenticate``) — so a
regression on any one of the twelve is caught here rather than waiting for
another nightly to draw the same example.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.db.models import ProtectedError
from rest_framework import status
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from trueppm_api.apps.access.models import (
    ProgramMembership,
    ProgramUserDefinedMentionGroup,
    ProjectMembership,
    Role,
    UserDefinedMentionGroup,
)
from trueppm_api.apps.access.services import _protecting_relations
from trueppm_api.apps.projects.models import (
    Calendar,
    CalendarRole,
    Program,
    Project,
    ProjectCalendarLayer,
    Sprint,
    SprintState,
    SprintTaskOutcome,
    Task,
    TaskStatus,
)
from trueppm_api.apps.resources.models import (
    Resource,
    ResourceSkill,
    Skill,
    TaskSkillRequirement,
)
from trueppm_api.core.exception_handlers import trueppm_exception_handler

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
def owner_jwt_client(owner: object) -> APIClient:
    """A client carrying a real ``Authorization: Bearer`` JWT, not ``force_authenticate``.

    ``force_authenticate`` bypasses ``perform_authentication()`` entirely and so
    never exercises the lazy-authenticate path #3044/#2989 describe. ``api:fuzz``
    authenticates by minting a JWT (``POST /api/v1/auth/token/``) and sending it as
    a bearer header on every request — this fixture matches that exactly.
    """
    c = APIClient()
    token = str(RefreshToken.for_user(owner).access_token)
    c.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
    return c


@pytest.fixture
def program(owner: object) -> Program:
    p = Program.objects.create(name="Fuzz program")
    ProgramMembership.objects.create(program=p, user=owner, role=Role.OWNER)
    return p


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="Fuzz task", duration=1)


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


@pytest.mark.parametrize("body", [["not", "an", "object"], "scalar", 42])
def test_project_transfer_non_object_body_400(
    owner_client: APIClient, project: Project, body: object
) -> None:
    """transfer read new_owner_user_id off request.data — a fuzzed list body
    raised AttributeError (job 15511740650). Now the required-field guard 400s."""
    resp = owner_client.post(f"/api/v1/projects/{project.pk}/transfer/", data=body, format="json")
    assert resp.status_code == status.HTTP_400_BAD_REQUEST


@pytest.mark.parametrize("body", [["not", "an", "object"], "scalar", 42])
def test_program_transfer_sponsorship_non_object_body_400(
    owner_client: APIClient, program: Program, body: object
) -> None:
    resp = owner_client.post(
        f"/api/v1/programs/{program.pk}/transfer-sponsorship/", data=body, format="json"
    )
    assert resp.status_code == status.HTTP_400_BAD_REQUEST


@pytest.mark.parametrize("body", [["not", "an", "object"], "scalar", 42])
def test_phases_reorder_non_object_body_400(
    owner_client: APIClient, project: Project, body: object
) -> None:
    resp = owner_client.patch(
        f"/api/v1/projects/{project.pk}/phases/reorder/", data=body, format="json"
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


# --------------------------------------------------------------------------- #
# DELETE /calendars/{id}/ must 409 on a PROTECT-ed calendar, not 500 (#2364)
# --------------------------------------------------------------------------- #


def test_delete_calendar_in_use_by_project_409(owner_client: APIClient, project: Project) -> None:
    """A calendar applied as a project's base is PROTECT-ed — refuse with 409, not 500."""
    resp = owner_client.delete(f"/api/v1/calendars/{project.calendar_id}/")

    assert resp.status_code == status.HTTP_409_CONFLICT
    body = resp.json()
    assert body["code"] == "calendar_in_use"
    assert body["reference_count"] == 1
    assert body["references"] == [{"type": "project", "id": str(project.id), "name": project.name}]
    assert Calendar.objects.filter(pk=project.calendar_id).exists()


def test_delete_calendar_in_use_as_overlay_409(owner_client: APIClient, project: Project) -> None:
    """An overlay layer PROTECTs too, and reports the *project*, not the join row.

    The ``ProjectCalendarLayer`` id is meaningless to a user; what they can act on
    is the project whose overlay set still applies the calendar.
    """
    overlay = Calendar.objects.create(name="Public holidays")
    ProjectCalendarLayer.objects.create(
        project=project, calendar=overlay, role=CalendarRole.HOLIDAYS, sort_order=0
    )

    resp = owner_client.delete(f"/api/v1/calendars/{overlay.pk}/")

    assert resp.status_code == status.HTTP_409_CONFLICT
    assert resp.json()["references"] == [
        {"type": "project", "id": str(project.id), "name": project.name}
    ]


def test_delete_calendar_in_use_by_program_409(
    owner_client: APIClient, project: Project, program: Program
) -> None:
    """``Program.calendar`` (ADR-0441) PROTECTs as well."""
    cal = Calendar.objects.create(name="Program default")
    program.calendar = cal
    program.save(update_fields=["calendar"])

    resp = owner_client.delete(f"/api/v1/calendars/{cal.pk}/")

    assert resp.status_code == status.HTTP_409_CONFLICT
    assert resp.json()["references"] == [
        {"type": "program", "id": str(program.id), "name": program.name}
    ]


def test_delete_calendar_in_use_by_resource_409(owner_client: APIClient, project: Project) -> None:
    """``Resource.calendar`` is the fifth PROTECT-ing FK and was missed in review.

    It is not special-cased by ``_describe_calendar_reference``; this pins that the
    generic branch names it usefully rather than falling through to a 500.
    """
    cal = Calendar.objects.create(name="Contractor hours")
    res = Resource.objects.create(name="Priya", calendar=cal)

    resp = owner_client.delete(f"/api/v1/calendars/{cal.pk}/")

    assert resp.status_code == status.HTTP_409_CONFLICT
    assert resp.json()["references"] == [{"type": "resource", "id": str(res.pk), "name": "Priya"}]


def test_delete_unused_calendar_still_204(owner_client: APIClient, project: Project) -> None:
    """The refusal must not have broken the ordinary delete path."""
    cal = Calendar.objects.create(name="Unused")

    resp = owner_client.delete(f"/api/v1/calendars/{cal.pk}/")

    assert resp.status_code == status.HTTP_204_NO_CONTENT
    assert not Calendar.objects.filter(pk=cal.pk).exists()


# --------------------------------------------------------------------------- #
# DELETE /skills/{id}/ must 409 on a PROTECT-ed skill, not 500 (#2364)
# --------------------------------------------------------------------------- #


def test_delete_skill_in_use_by_resource_409(owner_client: APIClient, project: Project) -> None:
    """``ResourceSkill.skill`` PROTECTs — report the resource, not the join row."""
    skill = Skill.objects.create(name="React", normalized_name="react")
    res = Resource.objects.create(name="Ada")
    ResourceSkill.objects.create(resource=res, skill=skill)

    resp = owner_client.delete(f"/api/v1/skills/{skill.pk}/")

    assert resp.status_code == status.HTTP_409_CONFLICT
    body = resp.json()
    assert body["code"] == "skill_in_use"
    assert body["reference_count"] == 1
    assert body["references"] == [{"type": "resource", "id": str(res.pk), "name": "Ada"}]
    assert Skill.objects.filter(pk=skill.pk).exists()


def test_delete_skill_required_by_task_409(owner_client: APIClient, project: Project) -> None:
    """``TaskSkillRequirement.skill`` PROTECTs — report the task, not the join row."""
    skill = Skill.objects.create(name="Rust", normalized_name="rust")
    task = Task.objects.create(project=project, name="Port the engine", duration=1)
    TaskSkillRequirement.objects.create(task=task, skill=skill)

    resp = owner_client.delete(f"/api/v1/skills/{skill.pk}/")

    assert resp.status_code == status.HTTP_409_CONFLICT
    assert resp.json()["references"] == [
        {"type": "task", "id": str(task.pk), "name": "Port the engine"}
    ]


def test_delete_skill_withholds_task_names_from_non_members(
    owner_client: APIClient, project: Project
) -> None:
    """A task in a project the caller cannot see is reported without its name.

    ``IsOrgScheduler`` gates this endpoint on holding SCHEDULER+ on *any* project, so
    without this filter a user with one project could turn repeated delete attempts
    into an oracle for task names across the whole install. ``reference_count`` still
    counts the hidden row — the refusal stays honest about how much blocks it.
    """
    skill = Skill.objects.create(name="Rust", normalized_name="rust")
    stranger_project = Project.objects.create(name="Not mine", start_date=date(2026, 1, 1))
    secret = Task.objects.create(project=stranger_project, name="Acquire NewCo", duration=1)
    TaskSkillRequirement.objects.create(task=secret, skill=skill)

    resp = owner_client.delete(f"/api/v1/skills/{skill.pk}/")

    assert resp.status_code == status.HTTP_409_CONFLICT
    body = resp.json()
    assert body["reference_count"] == 1
    assert body["references"] == [{"type": "task", "id": str(secret.pk)}]
    assert "Acquire NewCo" not in resp.content.decode()


def test_delete_unused_skill_still_204(owner_client: APIClient, project: Project) -> None:
    """The refusal must not have broken the ordinary delete path."""
    skill = Skill.objects.create(name="COBOL", normalized_name="cobol")

    resp = owner_client.delete(f"/api/v1/skills/{skill.pk}/")

    assert resp.status_code == status.HTTP_204_NO_CONTENT
    assert not Skill.objects.filter(pk=skill.pk).exists()


# --------------------------------------------------------------------------- #
# Confirmed hard deletes must purge PROTECT-ing children, not 500 (#2364)
# --------------------------------------------------------------------------- #


def test_project_force_delete_with_mention_group_succeeds(
    owner_client: APIClient, project: Project, owner: object
) -> None:
    """``UserDefinedMentionGroup.project`` PROTECTs the force-delete path.

    The hand-written pre-delete listed memberships only, so an archived project with
    a mention group 500'd instead of deleting. A 409 would be the wrong answer here —
    the Owner has already confirmed an irreversible delete through the two-step
    dialog, and mention groups are not something they can detach first.
    """
    UserDefinedMentionGroup.objects.create(project=project, name="subs", created_by=owner)
    project.is_archived = True
    project.save(update_fields=["is_archived"])

    resp = owner_client.delete(f"/api/v1/projects/{project.pk}/?force=true")

    assert resp.status_code == status.HTTP_204_NO_CONTENT
    assert not Project.objects.filter(pk=project.pk).exists()
    assert not UserDefinedMentionGroup.objects.filter(project_id=project.pk).exists()


def test_remove_sample_with_mention_groups_succeeds(
    owner_client: APIClient, owner: object, program: Program
) -> None:
    """Sample teardown must purge both project- and program-scoped mention groups."""
    proj = Project.objects.create(
        name="Sample", start_date=date(2026, 1, 1), program=program, is_sample=True
    )
    ProjectMembership.objects.create(project=proj, user=owner, role=Role.OWNER)
    UserDefinedMentionGroup.objects.create(project=proj, name="subs", created_by=owner)
    ProgramUserDefinedMentionGroup.objects.create(program=program, name="leads", created_by=owner)

    resp = owner_client.post(f"/api/v1/programs/{program.pk}/remove-sample/")

    assert resp.status_code == status.HTTP_204_NO_CONTENT
    assert not Program.objects.filter(pk=program.pk).exists()
    assert not Project.objects.filter(pk=proj.pk).exists()
    assert not UserDefinedMentionGroup.objects.filter(project_id=proj.pk).exists()
    assert not ProgramUserDefinedMentionGroup.objects.filter(program_id=program.pk).exists()


# --------------------------------------------------------------------------- #
# Format-suffix pk on projects/programs/tasks must never 500 (#3044)
# --------------------------------------------------------------------------- #

#: Verbatim from the nightly's own repro lines: a numeric-looking pk with a
#: fractional part parses as pk="0", format="5" against DRF's default router
#: regex, tripping content negotiation before authentication ever runs.
_MALFORMED_PK = "0.5"


@pytest.mark.parametrize("method", ["get", "put", "patch", "delete"])
@pytest.mark.parametrize(
    "resource_url",
    ["/api/v1/projects/{pk}/", "/api/v1/programs/{pk}/", "/api/v1/tasks/{pk}/"],
)
def test_format_suffix_pk_never_500s(
    owner_jwt_client: APIClient,
    project: Project,
    program: Program,
    task: Task,
    resource_url: str,
    method: str,
) -> None:
    """Pins all twelve fuzzer failures at once: a malformed/format-suffix pk on
    the three core detail routes must be a clean 4xx, never a 500, for a real
    JWT-authenticated caller (not ``force_authenticate``, which never exercises
    the lazy-authenticate crash this class of bug is about)."""
    url = resource_url.format(pk=_MALFORMED_PK)
    body = {"name": "x"} if method in ("put", "patch") else None
    resp = getattr(owner_jwt_client, method)(url, data=body, format="json")

    assert resp.status_code != status.HTTP_500_INTERNAL_SERVER_ERROR, resp.content
    assert resp.status_code < 500


def test_project_force_delete_format_suffix_pk_never_500s(
    owner_jwt_client: APIClient, project: Project
) -> None:
    """The exact fourth curl from the issue: ``DELETE .../?force=true`` on a
    malformed pk must not 500 either — the query string doesn't change which
    exception fires first inside ``initial()``."""
    resp = owner_jwt_client.delete(f"/api/v1/projects/{_MALFORMED_PK}/?force=true")

    assert resp.status_code != status.HTTP_500_INTERNAL_SERVER_ERROR, resp.content
    assert resp.status_code < 500


# --------------------------------------------------------------------------- #
# Drift guards (#2364)
# --------------------------------------------------------------------------- #

#: The ``PROTECT``-ing reverse relations on each model a delete path touches, as
#: ``model_name.field_name``. Pinned because the *entire* bug class here is a delete
#: path written against the FKs that existed at the time and silently rotting as new
#: ones land — it happened four separate times before it was caught.
#:
#: **When this test fails, a new ``PROTECT`` FK was added. Decide deliberately:**
#: should the confirmed hard-delete paths purge that child (add it and update the
#: snapshot), or should the delete be refused with a 409 naming it (extend the
#: relevant ``destroy`` and its ``describe`` callable)? Do not just update the
#: snapshot to make the test pass.
#:
#: Note ``workspace.calendar``: it is declared ``related_name="+"``, so it is absent
#: from ``_meta.related_objects`` yet Django's deletion collector still enforces its
#: ``PROTECT``. That is why ``_protecting_relations`` resolves with
#: ``include_hidden=True``, and why this test calls that helper rather than
#: reimplementing the lookup — a parallel copy here would not have caught it.
_EXPECTED_PROTECT_RELATIONS = {
    "Project": {"projectmembership.project", "userdefinedmentiongroup.project"},
    "Program": {"programmembership.program", "programuserdefinedmentiongroup.program"},
    "Calendar": {
        "program.calendar",
        "project.calendar",
        "projectcalendarlayer.calendar",
        "resource.calendar",
        "workspace.calendar",
    },
    "Skill": {"resourceskill.skill", "taskskillrequirement.skill"},
}


@pytest.mark.parametrize("model_name", sorted(_EXPECTED_PROTECT_RELATIONS))
def test_protect_relations_snapshot(model_name: str) -> None:
    """Pin the PROTECT-ing FK set so a new one forces a deliberate decision."""
    model = {
        "Project": Project,
        "Program": Program,
        "Calendar": Calendar,
        "Skill": Skill,
    }[model_name]

    actual = {
        f"{rel.related_model._meta.model_name}.{rel.field.name}"
        for rel in _protecting_relations(model)
    }

    assert actual == _EXPECTED_PROTECT_RELATIONS[model_name]


def test_unclaimed_protected_error_is_409_not_500() -> None:
    """The handler net catches any PROTECT-ed delete no view claimed.

    Belt to the per-view braces above: even if a future delete path forgets to catch
    ``ProtectedError``, it must degrade to a generic 409 rather than a 500.
    """
    cal = Calendar(name="Blocker")
    exc = ProtectedError("blocked", {cal})

    resp = trueppm_exception_handler(exc, {})

    assert resp is not None
    assert resp.status_code == status.HTTP_409_CONFLICT
    assert resp.data["code"] == "protected_reference"
    assert resp.data["reference_count"] == 1


def test_unclaimed_protected_error_never_names_rows() -> None:
    """The net must not disclose what blocked the delete.

    It fires on paths that have not reasoned about their permission gate at all, so
    it cannot know whether the caller may see the blocking rows. Naming them here
    would turn every unclaimed PROTECT into a cross-tenant read primitive. Endpoints
    that *have* done that reasoning opt in via ``describe``.
    """
    exc = ProtectedError("blocked", {Calendar(name="Secret Project Calendar")})

    resp = trueppm_exception_handler(exc, {})

    assert resp is not None
    assert "references" not in resp.data
    assert "Secret Project Calendar" not in str(resp.data)
