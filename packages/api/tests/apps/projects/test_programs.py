"""Tests for the Program viewset (ADR-0070, #502).

Covers:
- Creation auto-assigns the creator as OWNER (atomic).
- List filters to programs the user is a member of.
- Permission gates (Member → retrieve, Admin → update, Owner → delete).
- Delete cascade removes all memberships in one transaction.
- The /programs/{id}/projects/ nested endpoint.
- Project.program FK cross-permission gates (ADR-0070 §RBAC).
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Health,
    Methodology,
    Program,
    Project,
    Task,
    TaskStatus,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def owner(db: object) -> object:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def other_user(db: object) -> object:
    return User.objects.create_user(username="other", password="pw")


@pytest.fixture
def stranger(db: object) -> object:
    return User.objects.create_user(username="stranger", password="pw")


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _create_program(client: APIClient, name: str = "Phase 2") -> Program:
    resp = client.post(
        "/api/v1/programs/",
        {"name": name, "description": "", "methodology": "HYBRID"},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    return Program.objects.get(pk=resp.data["id"])


# ---------------------------------------------------------------------------
# Create — auto-OWNER membership
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_program_auto_assigns_creator_as_owner(owner: object) -> None:
    resp = _client(owner).post(
        "/api/v1/programs/",
        {"name": "Phase 2", "methodology": "HYBRID"},
        format="json",
    )
    assert resp.status_code == 201
    program_id = resp.data["id"]
    membership = ProgramMembership.objects.get(program_id=program_id, user=owner)
    assert membership.role == Role.OWNER
    # Response includes the annotated my_role.
    assert resp.data["my_role"] == Role.OWNER
    # Program context: OWNER reads "Program Admin", not the project-scoped
    # "Project Admin" label (#1794).
    assert resp.data["my_role_label"] == "Program Admin"


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("role", "expected_label"),
    [
        (Role.VIEWER, "Viewer"),
        (Role.MEMBER, "Team Member"),
        (Role.SCHEDULER, "Resource Manager"),
        (Role.ADMIN, "Program Manager"),
        (Role.OWNER, "Program Admin"),
    ],
)
def test_my_role_label_uses_program_context_labels(
    owner: object, other_user: object, role: int, expected_label: str
) -> None:
    """my_role_label reads in program context for every role (#1794).

    OWNER/ADMIN must not leak the project-scoped "Project Admin"/"Project
    Manager" labels onto a program card; the neutral roles keep their wording.
    """
    program = _create_program(_client(owner))
    ProgramMembership.objects.create(program=program, user=other_user, role=role)

    resp = _client(other_user).get(f"/api/v1/programs/{program.id}/")

    assert resp.status_code == 200, resp.content
    assert resp.data["my_role"] == role
    assert resp.data["my_role_label"] == expected_label


@pytest.mark.django_db
def test_create_program_requires_authentication(owner: object) -> None:
    resp = APIClient().post("/api/v1/programs/", {"name": "X"}, format="json")
    assert resp.status_code == 401


@pytest.mark.django_db
def test_create_program_default_methodology_is_hybrid(owner: object) -> None:
    resp = _client(owner).post("/api/v1/programs/", {"name": "X"}, format="json")
    assert resp.status_code == 201
    assert resp.data["methodology"] == Methodology.HYBRID


# ---------------------------------------------------------------------------
# List — filtered to user's memberships
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_list_returns_only_users_programs(owner: object, other_user: object) -> None:
    _create_program(_client(owner), name="Mine")
    _create_program(_client(other_user), name="Theirs")
    resp = _client(owner).get("/api/v1/programs/")
    assert resp.status_code == 200
    names = [p["name"] for p in resp.data["results"]]
    assert names == ["Mine"]


@pytest.mark.django_db
def test_list_annotates_project_count(owner: object, calendar: Calendar) -> None:
    program = _create_program(_client(owner))
    Project.objects.create(
        name="A",
        start_date=date(2026, 4, 1),
        calendar=calendar,
        program=program,
    )
    Project.objects.create(
        name="B",
        start_date=date(2026, 4, 1),
        calendar=calendar,
        program=program,
    )
    resp = _client(owner).get("/api/v1/programs/")
    assert resp.data["results"][0]["project_count"] == 2


# ---------------------------------------------------------------------------
# Retrieve — membership gate
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_retrieve_blocks_non_member(owner: object, stranger: object) -> None:
    program = _create_program(_client(owner))
    resp = _client(stranger).get(f"/api/v1/programs/{program.pk}/")
    assert resp.status_code in (403, 404)


@pytest.mark.django_db
def test_retrieve_returns_my_role(owner: object) -> None:
    program = _create_program(_client(owner))
    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/")
    assert resp.status_code == 200
    assert resp.data["my_role"] == Role.OWNER


# ---------------------------------------------------------------------------
# Update — ADMIN+ gate
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_update_requires_admin(owner: object, other_user: object) -> None:
    program = _create_program(_client(owner))
    # Add other_user as MEMBER (insufficient for update).
    ProgramMembership.objects.create(program=program, user=other_user, role=Role.MEMBER)
    resp = _client(other_user).patch(
        f"/api/v1/programs/{program.pk}/", {"name": "Renamed"}, format="json"
    )
    assert resp.status_code == 403

    # Owner can patch.
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/", {"name": "Renamed"}, format="json"
    )
    assert resp.status_code == 200
    program.refresh_from_db()
    assert program.name == "Renamed"


# ---------------------------------------------------------------------------
# Accent color (#698) — serializer validation + round-trip
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_program_color_defaults_to_null(owner: object) -> None:
    program = _create_program(_client(owner))
    assert program.color is None


@pytest.mark.django_db
def test_update_accepts_valid_hex_color(owner: object) -> None:
    program = _create_program(_client(owner))
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/", {"color": "#1C6B3A"}, format="json"
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["color"] == "#1C6B3A"
    program.refresh_from_db()
    assert program.color == "#1C6B3A"


@pytest.mark.django_db
@pytest.mark.parametrize("bad", ["red", "1C6B3A", "#FFF", "#12345", "#1234567", "#12345G"])
def test_update_rejects_malformed_color(owner: object, bad: str) -> None:
    program = _create_program(_client(owner))
    resp = _client(owner).patch(f"/api/v1/programs/{program.pk}/", {"color": bad}, format="json")
    assert resp.status_code == 400, resp.content
    assert "color" in resp.data


@pytest.mark.django_db
def test_update_accepts_null_color(owner: object) -> None:
    program = _create_program(_client(owner))
    program.color = "#DC2626"
    program.save(update_fields=["color"])
    resp = _client(owner).patch(f"/api/v1/programs/{program.pk}/", {"color": None}, format="json")
    assert resp.status_code == 200, resp.content
    assert resp.data["color"] is None
    program.refresh_from_db()
    assert program.color is None


@pytest.mark.django_db
def test_update_empty_color_normalizes_to_null(owner: object) -> None:
    """Empty string collapses to null so "unset" semantics hold (#698)."""
    program = _create_program(_client(owner))
    program.color = "#0EA5E9"
    program.save(update_fields=["color"])
    resp = _client(owner).patch(f"/api/v1/programs/{program.pk}/", {"color": ""}, format="json")
    assert resp.status_code == 200, resp.content
    assert resp.data["color"] is None


# ---------------------------------------------------------------------------
# Delete — OWNER + cascade
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_delete_requires_owner(owner: object, other_user: object) -> None:
    program = _create_program(_client(owner))
    ProgramMembership.objects.create(program=program, user=other_user, role=Role.ADMIN)
    resp = _client(other_user).delete(f"/api/v1/programs/{program.pk}/")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_delete_cascades_memberships_and_soft_deletes_program(
    owner: object,
    other_user: object,
    calendar: Calendar,
) -> None:
    program = _create_program(_client(owner))
    ProgramMembership.objects.create(program=program, user=other_user, role=Role.MEMBER)
    project = Project.objects.create(
        name="Survivor",
        start_date=date(2026, 4, 1),
        calendar=calendar,
        program=program,
    )

    resp = _client(owner).delete(f"/api/v1/programs/{program.pk}/")
    assert resp.status_code == 204

    # Program soft-deleted.
    program.refresh_from_db()
    assert program.is_deleted is True

    # All memberships soft-deleted in the same transaction (PROTECT honored).
    assert ProgramMembership.objects.filter(program=program, is_deleted=False).count() == 0

    # Project survives with program=NULL (SET_NULL).
    project.refresh_from_db()
    assert project.program_id is None
    assert project.is_deleted is False


# ---------------------------------------------------------------------------
# /programs/{id}/projects/ nested list endpoint
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_projects_endpoint_lists_program_projects(
    owner: object,
    calendar: Calendar,
) -> None:
    program = _create_program(_client(owner))
    Project.objects.create(
        name="A",
        start_date=date(2026, 4, 1),
        calendar=calendar,
        program=program,
    )
    Project.objects.create(
        name="Standalone",
        start_date=date(2026, 4, 1),
        calendar=calendar,
    )
    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/projects/")
    assert resp.status_code == 200
    names = [p["name"] for p in resp.data]
    assert names == ["A"]


@pytest.mark.django_db
def test_projects_endpoint_resolves_the_callers_own_role_on_each_child_row(
    owner: object,
    calendar: Calendar,
) -> None:
    """The four caller-scoped fields on this route, which used to be uniformly wrong.

    This action builds its own queryset instead of going through
    ``ProjectViewSet.get_queryset``, and serializes without ``context``. Every
    ``ProjectSerializer`` field derived from the ``_my_role`` annotation —
    ``my_role``, ``my_role_label``, ``can_author`` and (since #3357)
    ``can_undo_batch_operations`` — reads the attribute defensively and then falls back
    to a request-scoped lookup that finds no request, so all four failed closed on
    every row for every caller. Not a degrade anyone would notice: a project Owner saw
    ``my_role: null`` and ``can_author: false`` on a route whose ``@extend_schema``
    publishes ``ProjectSerializer`` as its response shape.

    Asserted here rather than on the field that surfaced it because the annotation is
    the fix and all four ride it. Note the negative half: the second project carries no
    membership for this caller, so ``null``/``false`` there is the CORRECT answer and
    distinguishes "the annotation landed" from "the fallback still runs".
    """
    program = _create_program(_client(owner))
    mine = Project.objects.create(
        name="Mine", start_date=date(2026, 4, 1), calendar=calendar, program=program
    )
    Project.objects.create(
        name="Theirs", start_date=date(2026, 4, 1), calendar=calendar, program=program
    )
    ProjectMembership.objects.create(project=mine, user=owner, role=Role.ADMIN)

    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/projects/")
    assert resp.status_code == 200
    rows = {p["name"]: p for p in resp.data}

    assert rows["Mine"]["my_role"] == Role.ADMIN
    assert rows["Mine"]["my_role_label"] == "Project Manager"
    assert rows["Mine"]["can_author"] is True
    assert rows["Mine"]["can_undo_batch_operations"] is True

    assert rows["Theirs"]["my_role"] is None
    assert rows["Theirs"]["can_author"] is False
    assert rows["Theirs"]["can_undo_batch_operations"] is False


@pytest.mark.django_db
def test_projects_endpoint_resolves_roles_without_a_query_per_row(
    owner: object,
    calendar: Calendar,
) -> None:
    """The role annotation is a Subquery, so row count must not move the query count.

    The alternative containment — passing ``context={"request": request}`` and letting
    each field fall back to ``_membership_role`` — is correct and an N+1, which on a
    program with fifty projects is fifty membership queries per list. This pins the
    shape rather than the fix, so a future revert to the context-only form fails here
    instead of only in production.

    **Half the rows deliberately carry NO project membership**, and that is the half
    that would catch the likelier regression. This action lists every project in the
    program, not only the ones the caller belongs to, so a non-member row annotates
    ``_my_role`` as SQL ``NULL`` — which the serializer cannot distinguish from "not
    annotated at all" and would take as its cue to fall through to the request-scoped
    lookup. That path costs nothing today only because the action serializes without
    context. Add the context and every non-member row starts paying a query; an
    all-member fixture would stay green through it.
    """
    program = _create_program(_client(owner))
    for i in range(2):
        p = Project.objects.create(
            name=f"P{i}", start_date=date(2026, 4, 1), calendar=calendar, program=program
        )
        # Every other row: no ProjectMembership, so `_my_role` annotates to NULL.
        if i % 2 == 0:
            ProjectMembership.objects.create(project=p, user=owner, role=Role.ADMIN)
    url = f"/api/v1/programs/{program.pk}/projects/"
    client = _client(owner)
    client.get(url)  # warm any per-process caches so the counts compare like for like

    with CaptureQueriesContext(connection) as two_rows:
        assert client.get(url).status_code == 200
    for i in range(2, 6):
        p = Project.objects.create(
            name=f"P{i}", start_date=date(2026, 4, 1), calendar=calendar, program=program
        )
        if i % 2 == 0:
            ProjectMembership.objects.create(project=p, user=owner, role=Role.ADMIN)
    with CaptureQueriesContext(connection) as six_rows:
        assert client.get(url).status_code == 200

    assert len(six_rows) == len(two_rows), (
        f"{len(two_rows)} queries for 2 rows, {len(six_rows)} for 6 — "
        "the role resolution is running per row"
    )


# ---------------------------------------------------------------------------
# Response shape — the disclosure boundary (#3439)
# ---------------------------------------------------------------------------

# The exact read surface of ProgramProjectRowSerializer. Asserted as an equality, not a
# subset: a superset assertion would pass while a future author widened the row back
# toward ProjectSerializer, which is precisely the regression #3439 is about. If you are
# here because this failed, do not append the new field — read the serializer's
# docstring and decide whether it answers "what is in this program" or "how is this
# project governed". Only the first belongs on this route.
_EXPECTED_ROW_FIELDS = {
    "id",
    "name",
    "code",
    "program",
    "start_date",
    "methodology",
    "effective_methodology",
    "inherited_methodology",
    "iteration_label",
    "effective_iteration_label",
    "health",
    "lifecycle",
    "is_archived",
    "overdue_count",
    "at_risk_count",
    "is_pinned",
    "my_role",
    "my_role_label",
    "can_author",
    "can_undo_batch_operations",
}

# A named sample of what the full ProjectSerializer used to emit here, kept so the test
# states the concrete defect: the lead's email, the agent-read consent decision, the
# sharing and guest posture, the attachment policy, the MC attribution audience, the
# surface-visibility map, the archiver's identity.
#
# It is only a *sample*. The binding assertion is derived from ProjectSerializer itself
# (see _forbidden_fields below), so a sensitive field added to the parent tomorrow is
# forbidden here automatically rather than waiting for someone to remember this list.
_MUST_NOT_LEAK_SAMPLE = [
    "lead",
    "lead_detail",
    "visibility",
    "mcp_enabled",
    "effective_mcp_enabled",
    "inherited_mcp_enabled",
    "public_sharing",
    "allow_guests",
    "effective_public_sharing",
    "effective_allow_guests",
    "attachments_enabled",
    "allowed_attachment_types",
    "mc_history_enabled",
    "mc_history_attribution_audience",
    "show_reporting",
    "show_time_tracking",
    "show_baselines",
    "show_monte_carlo",
    "effective_surface_visibility",
    "default_member_role",
    "estimation_mode",
    "prioritization_model",
    "archived_by",
]


def _forbidden_fields() -> set[str]:
    """Every readable ProjectSerializer field the roster row must NOT carry.

    Derived from the parent serializer rather than hand-listed, so this widens by itself
    when ProjectSerializer grows. That is the point: #3439 was not "these 23 fields
    leaked", it was "this route reaches for the only tier available", and a hand-copied
    denial list would silently stop covering the class on the next field added upstream.
    """
    from trueppm_api.apps.projects.serializers import ProjectSerializer

    readable = {name for name, f in ProjectSerializer().fields.items() if not f.write_only}
    forbidden = readable - _EXPECTED_ROW_FIELDS
    # Non-zero denominator: if the two sets ever coincide, every assertion below passes
    # while testing nothing, which is exactly how this route regressed in the first place.
    assert len(forbidden) > 50, (
        f"only {len(forbidden)} fields separate the roster row from the full project "
        "serializer — the row has been widened back toward it"
    )
    assert set(_MUST_NOT_LEAK_SAMPLE) <= forbidden, (
        "the named sample has drifted out of ProjectSerializer; update it or the "
        "documentation value of this test is gone"
    )
    return forbidden


@pytest.mark.django_db
def test_program_viewer_gets_no_governance_fields_for_a_project_they_cannot_open(
    owner: object,
    stranger: object,
    calendar: Calendar,
) -> None:
    """A program VIEWER with no ProjectMembership must not read a project's settings.

    The security half of #3439. ``IsProgramMember`` tests membership *existence* — it
    has no ordinal comparison, unlike ``IsProgramScheduler`` — so ``Role.VIEWER`` passes
    it, and the action lists every non-draft project in the program rather than the
    caller's own. That combination is deliberate. What was not deliberate is that the
    action then served ``ProjectSerializer``: 86 fields per row, including the project
    lead's email address and the live governance decisions asserted absent below, for a
    project the caller cannot open.

    The fixture is the load-bearing part. ``stranger`` is given a program membership at
    the **lowest** role and **no** ``ProjectMembership`` on either project — the default
    state, not a granted one. A fixture that quietly handed them project membership
    would make every assertion here pass against the unfixed code.
    """
    program = _create_program(_client(owner))
    lead = User.objects.create_user(username="lead", password="pw", email="lead@example.com")
    for name in ("Alpha", "Beta"):
        Project.objects.create(
            name=name,
            start_date=date(2026, 4, 1),
            calendar=calendar,
            program=program,
            lead=lead,
        )
    ProgramMembership.objects.create(program=program, user=stranger, role=Role.VIEWER)

    resp = _client(stranger).get(f"/api/v1/programs/{program.pk}/projects/")

    assert resp.status_code == 200, resp.content
    assert len(resp.data) == 2, "the row set is program-scoped; only the shape narrowed"

    forbidden = _forbidden_fields()
    for row in resp.data:
        assert set(row) == _EXPECTED_ROW_FIELDS, (
            f"{row.get('name')} carries {sorted(set(row) - _EXPECTED_ROW_FIELDS)} beyond "
            "the roster row"
        )
        leaked = sorted(forbidden & set(row))
        assert not leaked, f"disclosed to a program Viewer: {leaked}"

    # The lead's email is the concrete personal datum the old shape handed over, via
    # lead_detail's _UserSummarySerializer. Assert on the serialized bytes as well as
    # the key, so a future field that embeds it under another name also fails here.
    assert "lead@example.com" not in str(resp.data)


@pytest.mark.django_db
def test_program_projects_row_is_narrow_for_a_project_member_too(
    owner: object,
    calendar: Calendar,
) -> None:
    """The narrowing is uniform — membership does not unlock the full serializer here.

    Deliberately NOT per-row. A heterogeneous array (full shape for member rows, narrow
    for the rest) would make the response body depend on the caller's project
    memberships, which no single OpenAPI response schema can honestly describe and which
    this repo has no polymorphic-serializer precedent for. The membership-gated full
    project shape already has a route — ``GET /projects/{id}/`` — and that is where the
    web reads every field omitted here.

    The caller below is the program Owner AND holds ``Role.ADMIN`` on the project, i.e.
    the most privileged caller this route can have. If any path still widened the row,
    this is the caller it would widen for.
    """
    program = _create_program(_client(owner))
    project = Project.objects.create(
        name="Mine", start_date=date(2026, 4, 1), calendar=calendar, program=program
    )
    ProjectMembership.objects.create(project=project, user=owner, role=Role.ADMIN)

    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/projects/")

    assert resp.status_code == 200, resp.content
    (row,) = resp.data
    assert set(row) == _EXPECTED_ROW_FIELDS
    # The caller-scoped fields survive the narrowing — dropping them would silently
    # revert #2553 (is_pinned) and #3357 (my_role / can_author).
    assert row["my_role"] == Role.ADMIN
    assert row["can_author"] is True
    assert row["is_pinned"] is False


# ---------------------------------------------------------------------------
# search / ordering — declared, and now honored (#3420)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_program_projects_honors_the_search_parameter(
    owner: object,
    calendar: Calendar,
) -> None:
    """``?search=`` filters on name and code instead of being silently dropped.

    ProgramViewSet declares SearchFilter with ``search_fields = ["name", "code"]``, so
    drf-spectacular published ``search`` on this operation — but the action built its own
    queryset and never called ``filter_queryset()``. The parameter was accepted,
    documented, and ignored: a 200 with the full list, which is worse than a 400 because
    nothing tells the caller it did nothing.
    """
    program = _create_program(_client(owner))
    for name, code in (("Payments", "PAY"), ("Billing", "BIL"), ("Payroll", "PYR")):
        Project.objects.create(
            name=name,
            code=code,
            start_date=date(2026, 4, 1),
            calendar=calendar,
            program=program,
        )
    client = _client(owner)
    url = f"/api/v1/programs/{program.pk}/projects/"

    assert len(client.get(url).data) == 3, "no param — the whole roster, as before"

    by_name = client.get(url, {"search": "Pay"})
    assert by_name.status_code == 200
    assert {r["name"] for r in by_name.data} == {"Payments", "Payroll"}

    # `code` is the second search field, and the one that proves the backend ran rather
    # than a name-substring coincidence: "BIL" appears in no project name.
    by_code = client.get(url, {"search": "BIL"})
    assert {r["name"] for r in by_code.data} == {"Billing"}

    assert client.get(url, {"search": "nothing-matches-this"}).data == []


@pytest.mark.django_db
def test_program_projects_ordering_overrides_the_default_start_date_order(
    owner: object,
    calendar: Calendar,
) -> None:
    """``?ordering=name`` replaces the roster's default order; absent, the default holds.

    Pins the placement of ``filter_queryset()`` relative to the action's hardcoded
    ``.order_by("start_date", "name")``, which is the subtle half of #3420. Run the
    filter *before* the ``order_by`` — the obvious reading — and the hardcoded order
    clobbers the caller's ordering on the very next line, reinstating the silent drop
    this fixes. The names below are deliberately in the opposite order to the start
    dates, so the two orderings cannot agree by accident.
    """
    program = _create_program(_client(owner))
    for name, start in (("Zulu", date(2026, 1, 1)), ("Alpha", date(2026, 6, 1))):
        Project.objects.create(name=name, start_date=start, calendar=calendar, program=program)
    client = _client(owner)
    url = f"/api/v1/programs/{program.pk}/projects/"

    assert [r["name"] for r in client.get(url).data] == ["Zulu", "Alpha"]
    assert [r["name"] for r in client.get(url, {"ordering": "name"}).data] == [
        "Alpha",
        "Zulu",
    ]
    assert [r["name"] for r in client.get(url, {"ordering": "-name"}).data] == [
        "Zulu",
        "Alpha",
    ]


@pytest.mark.django_db
def test_program_detail_routes_survive_a_search_param(
    owner: object,
    calendar: Calendar,
) -> None:
    """A ``?search=`` that matches no program must not 404 the program's own detail route.

    ``GenericAPIView.get_object()`` resolves through ``filter_queryset()``, so the
    SearchFilter configured for the ``list`` route also ran against the parent lookup on
    every detail route. The program below is named "Phase 2"; searching for "payments"
    filtered it out of its own lookup and returned 404 — not the silent no-op #3420
    describes, but a hard failure, and the reason the ``projects`` action could not
    simply start calling ``filter_queryset()``.

    Covers ``retrieve`` as well as the nested action, because the defect was in the
    shared object resolution rather than in any one action.

    **Scope, stated honestly.** ``ProgramViewSet`` is one of eight viewsets that set
    ``search_fields`` on top of the project-wide ``DEFAULT_FILTER_BACKENDS``; the other
    seven — ``ProjectViewSet``, ``TaskViewSet``, ``CalendarViewSet``, ``RiskViewSet``,
    ``LabelViewSet``, ``SkillViewSet``, ``ResourceViewSet`` — still 404 their own detail
    routes on an unrelated ``?search=``. Only this one is fixed here, and this test only
    proves this one. The class fix is #3451.
    """
    program = _create_program(_client(owner))
    Project.objects.create(
        name="Payments", start_date=date(2026, 4, 1), calendar=calendar, program=program
    )
    client = _client(owner)
    unrelated = {"search": "payments"}

    assert client.get(f"/api/v1/programs/{program.pk}/", unrelated).status_code == 200
    nested = client.get(f"/api/v1/programs/{program.pk}/projects/", unrelated)
    assert nested.status_code == 200, nested.content
    # …and the term is applied to the PROJECT rows, which is what it was always meant
    # to filter.
    assert [r["name"] for r in nested.data] == ["Payments"]


def test_program_action_filter_params_are_declared_only_where_they_are_honored() -> None:
    """ProgramViewSet's own sweep (#3420): declare the params, or honor them — never neither.

    **Scope, stated honestly.** This sweeps ``ProgramViewSet`` only — the sweep #3420
    asked for. It is NOT the whole class. ``SearchFilter`` and ``OrderingFilter`` are in
    ``DEFAULT_FILTER_BACKENDS``, so every viewset that sets ``search_fields`` publishes
    the same two parameters on its custom actions, and ~71 operations across the API
    declare them; ``ProjectViewSet.export_jobs`` is a structural twin of the
    ``export_jobs`` undeclared here and is untouched. That wider sweep is #3452 —
    do not read a green run of this test as covering it.

    ProgramViewSet's filter backends make drf-spectacular publish ``search`` and
    ``ordering`` on every list-shaped operation, including custom ``@action``s that build
    their own querysets. ``projects`` now honors them. ``export_jobs`` and ``samples``
    cannot — ``ProgramExportJob`` has neither a ``name`` nor a ``code`` column, so
    ``filter_queryset()`` there would turn a silently-ignored parameter into a FieldError
    500, and ``samples`` returns a hand-built list of dicts rather than a queryset — so
    both undeclare instead.

    Asserted against the generated schema rather than the source, because the failure
    mode is a *published* parameter.

    Swept over the generated schema rather than the three paths this branch touched, so
    an @action added to ProgramViewSet later is covered without anyone remembering to
    come back here. The allowlist below is the whole maintenance burden: a new route that
    genuinely runs ``filter_queryset()`` gets added to it, and one that does not fails
    until it either honors the parameters or undeclares them.

    It also pins the mechanism: ``parameters=[]`` reads to drf-spectacular as "no
    overrides" and emits the backends' parameters anyway, so only the ``exclude=True``
    form actually removes them.
    """
    from drf_spectacular.generators import SchemaGenerator

    schema = SchemaGenerator().get_schema(request=None, public=True)

    # Routes that DO run the filter backends and may therefore declare them:
    # `list` (via DRF's ListModelMixin) and the `projects` roster (explicitly, #3420).
    honors_them = {"/api/v1/programs/", "/api/v1/programs/{id}/projects/"}

    # ProgramViewSet's own routes. Paths carrying `{program_pk}` belong to the separate
    # nested viewsets (members, webhooks, backlog-items, …), which are ordinary
    # ModelViewSets whose `list` honors the backends through DRF — not this viewset's
    # actions, and not this test's subject.
    own_routes = [
        path
        for path in schema["paths"]
        if path.startswith("/api/v1/programs/")
        and "{program_pk}" not in path
        and "get" in schema["paths"][path]
    ]
    # Non-zero denominator: a path-matching bug here would otherwise sweep nothing and
    # pass silently, which is the vacuous-guard failure this whole issue is an instance of.
    assert len(own_routes) >= 10, f"swept only {len(own_routes)} ProgramViewSet GET routes"

    def query_params(path: str) -> set[str]:
        return {
            p["name"]
            for p in schema["paths"][path]["get"].get("parameters", [])
            if p.get("in") == "query"
        }

    offenders = sorted(
        path
        for path in own_routes
        if path not in honors_them and ({"search", "ordering"} & query_params(path))
    )
    assert not offenders, (
        f"{offenders} declare `search`/`ordering` but never call filter_queryset() — "
        "either honor them, or undeclare with OpenApiParameter(..., exclude=True)"
    )

    # The other direction: the two routes that DO honor them must keep declaring them,
    # so an over-broad exclusion cannot pass this test by hiding a working parameter.
    for path in sorted(honors_them):
        assert {"search", "ordering"} <= query_params(path), (
            f"{path} honors the filter backends but no longer declares them"
        )


# ---------------------------------------------------------------------------
# Project.program FK cross-permission (ADR-0070 §RBAC)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_assign_project_to_program_requires_admin_on_both(
    owner: object,
    other_user: object,
    calendar: Calendar,
) -> None:
    program = _create_program(_client(owner))
    project = Project.objects.create(
        name="P",
        start_date=date(2026, 4, 1),
        calendar=calendar,
    )
    # other_user is OWNER on the project but NOT a member of the program.
    ProjectMembership.objects.create(project=project, user=other_user, role=Role.OWNER)
    resp = _client(other_user).patch(
        f"/api/v1/projects/{project.pk}/",
        {"program": str(program.pk)},
        format="json",
    )
    assert resp.status_code == 400, resp.content
    # Error message names the program (helpful for the UI's toast surface).
    assert "Project Manager" in str(resp.content) or "permission" in str(resp.content)


@pytest.mark.django_db
def test_assign_project_to_program_succeeds_with_admin_on_both(
    owner: object,
    calendar: Calendar,
) -> None:
    # owner is OWNER on program (via create) AND will be added as OWNER on project.
    program = _create_program(_client(owner))
    project = Project.objects.create(
        name="P",
        start_date=date(2026, 4, 1),
        calendar=calendar,
    )
    ProjectMembership.objects.create(project=project, user=owner, role=Role.OWNER)
    resp = _client(owner).patch(
        f"/api/v1/projects/{project.pk}/",
        {"program": str(program.pk)},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    project.refresh_from_db()
    assert project.program_id == program.pk


@pytest.mark.django_db
def test_unassign_project_requires_admin_on_source_program(
    owner: object,
    other_user: object,
    calendar: Calendar,
) -> None:
    program = _create_program(_client(owner))
    project = Project.objects.create(
        name="P",
        start_date=date(2026, 4, 1),
        calendar=calendar,
        program=program,
    )
    # other_user is OWNER on project but only a MEMBER on the source program.
    ProjectMembership.objects.create(project=project, user=other_user, role=Role.OWNER)
    ProgramMembership.objects.create(program=program, user=other_user, role=Role.MEMBER)
    resp = _client(other_user).patch(
        f"/api/v1/projects/{project.pk}/",
        {"program": None},
        format="json",
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Create-with-program — POST /projects/ with ``program`` set up-front (ADR-0070).
#
# The web "New project" button inside a Program shell sends ``program`` in the
# create payload (no second PATCH). Cross-permission rules for create:
#  - instance does not yet exist → no project-side ADMIN check applies
#  - old_program is None → no source-program check
#  - new_program is set → caller must hold ADMIN on the target program
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_project_with_program_succeeds_when_admin_on_program(
    owner: object,
    calendar: Calendar,
) -> None:
    program = _create_program(_client(owner))
    resp = _client(owner).post(
        "/api/v1/projects/",
        {
            "name": "Tower A Buildout",
            "start_date": "2026-05-18",
            "calendar": str(calendar.pk),
            "methodology": "HYBRID",
            "program": str(program.pk),
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    assert resp.data["program"] == program.pk
    project = Project.objects.get(pk=resp.data["id"])
    assert project.program_id == program.pk
    # The creator is auto-assigned OWNER on the new project (perform_create).
    assert ProjectMembership.objects.filter(project=project, user=owner, role=Role.OWNER).exists()


@pytest.mark.django_db
def test_create_project_with_program_rejected_when_not_admin_on_program(
    owner: object,
    other_user: object,
    calendar: Calendar,
) -> None:
    program = _create_program(_client(owner))
    # other_user is only a MEMBER on the program — not ADMIN.
    ProgramMembership.objects.create(program=program, user=other_user, role=Role.MEMBER)
    resp = _client(other_user).post(
        "/api/v1/projects/",
        {
            "name": "Sneaky Project",
            "start_date": "2026-05-18",
            "calendar": str(calendar.pk),
            "program": str(program.pk),
        },
        format="json",
    )
    assert resp.status_code == 400, resp.content
    # No project row was created — the validate_program guard fires before save().
    assert not Project.objects.filter(name="Sneaky Project").exists()


@pytest.mark.django_db
def test_create_standalone_project_omits_program(
    owner: object,
    calendar: Calendar,
) -> None:
    # No ``program`` key in the payload — the project is created standalone.
    resp = _client(owner).post(
        "/api/v1/projects/",
        {
            "name": "Standalone",
            "start_date": "2026-05-18",
            "calendar": str(calendar.pk),
            "methodology": "HYBRID",
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    project = Project.objects.get(pk=resp.data["id"])
    assert project.program_id is None


# ---------------------------------------------------------------------------
# General settings fields — code / health / visibility / lead (#523)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_retrieve_includes_new_general_fields_with_safe_defaults(owner: object) -> None:
    program = _create_program(_client(owner))
    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/")
    assert resp.status_code == 200
    # New fields are present and carry the migration defaults so an
    # un-migrated UI can still bind to them without checking for undefined.
    assert resp.data["code"] == ""
    assert resp.data["health"] == "AUTO"
    assert resp.data["visibility"] == "WORKSPACE"
    assert resp.data["lead"] is None
    assert resp.data["lead_detail"] is None


@pytest.mark.django_db
def test_serializer_exposes_risk_policy_fields(owner: object) -> None:
    """The list/detail serializer surfaces the risk policy so the Workspace → Programs
    bulk matrix (#1283) can display and diff each program's current value."""
    program = _create_program(_client(owner))
    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/")
    assert resp.status_code == 200
    # Static migration defaults (#529): no methodology-aware seeding.
    assert resp.data["risk_slip_propagation"] == "warn"
    assert resp.data["risk_escalation_days"] == 3


@pytest.mark.django_db
def test_risk_policy_fields_read_only_on_program_serializer(owner: object) -> None:
    """Risk policy is display-only on the main serializer — writes go through the
    dedicated risk_policy action and the workspace bulk-fields endpoint (#1283), so a
    plain PATCH must NOT mutate them even for an admin."""
    program = _create_program(_client(owner))
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/",
        {"risk_slip_propagation": "block", "risk_escalation_days": 21},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    program.refresh_from_db()
    # read_only_fields swallow the write silently — defaults are unchanged.
    assert program.risk_slip_propagation == "warn"
    assert program.risk_escalation_days == 3


@pytest.mark.django_db
def test_patch_persists_general_settings_fields(owner: object) -> None:
    program = _create_program(_client(owner))
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/",
        {
            "code": "PH2",
            "health": "AT_RISK",
            "visibility": "PRIVATE",
        },
        format="json",
    )
    assert resp.status_code == 200, resp.content
    program.refresh_from_db()
    assert program.code == "PH2"
    assert program.health == "AT_RISK"
    assert program.visibility == "PRIVATE"


@pytest.mark.django_db
def test_patch_lead_returns_lead_detail_nested(owner: object, other_user: object) -> None:
    program = _create_program(_client(owner))
    # Add other_user as a member so they're an eligible lead.  Lead is a UI
    # affordance and not membership-gated at the serializer level, but in
    # production callers will pick from existing members.
    ProgramMembership.objects.create(program=program, user=other_user, role=Role.MEMBER)
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/",
        {"lead": str(other_user.pk)},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    program.refresh_from_db()
    assert program.lead_id == other_user.pk
    # Nested lead_detail mirrors the user_detail pattern from membership rows.
    assert resp.data["lead_detail"] is not None
    assert resp.data["lead_detail"]["id"] == other_user.pk
    assert resp.data["lead_detail"]["username"] == "other"


@pytest.mark.django_db
def test_patch_lead_rejects_non_member(owner: object, stranger: object) -> None:
    program = _create_program(_client(owner))
    # ``stranger`` has no ProgramMembership on this program, so the lead
    # validation must reject the assignment.
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/",
        {"lead": str(stranger.pk)},
        format="json",
    )
    assert resp.status_code == 400, resp.content
    assert "lead" in resp.data
    program.refresh_from_db()
    assert program.lead_id is None


@pytest.mark.django_db
def test_patch_lead_to_null_is_always_allowed(owner: object, other_user: object) -> None:
    program = _create_program(_client(owner))
    ProgramMembership.objects.create(program=program, user=other_user, role=Role.MEMBER)
    program.lead = other_user
    program.save(update_fields=["lead"])
    # Unsetting the lead should succeed regardless of membership state.
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/",
        {"lead": None},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    program.refresh_from_db()
    assert program.lead_id is None


@pytest.mark.django_db
def test_create_program_sets_lead_to_creator_in_one_save(owner: object) -> None:
    """A PM can start a program with themselves as lead in a single create (#2025).

    The creator becomes OWNER in the same atomic transaction, so the "lead must be a
    member" invariant holds without a second save.
    """
    resp = _client(owner).post(
        "/api/v1/programs/",
        {"name": "Phase 2", "methodology": "HYBRID", "lead": str(owner.pk)},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    program = Program.objects.get(pk=resp.data["id"])
    assert program.lead_id == owner.pk
    assert resp.data["lead"] == owner.pk
    assert resp.data["lead_detail"]["id"] == owner.pk


@pytest.mark.django_db
def test_create_program_rejects_non_creator_lead(owner: object, other_user: object) -> None:
    """At create the only member-to-be is the creator, so any other lead is a
    non-member and must be rejected (#2025) — even though the user exists."""
    resp = _client(owner).post(
        "/api/v1/programs/",
        {"name": "Phase 2", "methodology": "HYBRID", "lead": str(other_user.pk)},
        format="json",
    )
    assert resp.status_code == 400, resp.content
    assert "lead" in resp.data
    assert not Program.objects.filter(name="Phase 2").exists()


# ---------------------------------------------------------------------------
# Rollup config visibility on the program serializer (#2025)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_serializer_exposes_rollup_config_fields(owner: object) -> None:
    """Rollup config is visible on generic GET so program-list / MCP readers see
    which KPIs a program surfaces and how it aggregates health, without a second
    call to /rollup-config/ (#2025)."""
    program = _create_program(_client(owner))
    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/")
    assert resp.status_code == 200, resp.content
    assert "rollup_enabled_kpis" in resp.data
    assert "rollup_aggregation_policy" in resp.data
    program.refresh_from_db()
    assert resp.data["rollup_enabled_kpis"] == program.rollup_enabled_kpis
    assert resp.data["rollup_aggregation_policy"] == program.rollup_aggregation_policy


@pytest.mark.django_db
def test_rollup_config_fields_read_only_on_program_serializer(owner: object) -> None:
    """Rollup config is display-only on the main serializer — writes stay on the
    dedicated /rollup-config/ action, so a plain PATCH must not mutate them (#2025)."""
    program = _create_program(_client(owner))
    before_policy = program.rollup_aggregation_policy
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/",
        {"rollup_enabled_kpis": ["schedule"], "rollup_aggregation_policy": "AVERAGE"},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    program.refresh_from_db()
    # read_only_fields swallow the write silently — stored values are unchanged.
    assert program.rollup_aggregation_policy == before_policy


@pytest.mark.django_db
def test_patch_health_rejects_invalid_choice(owner: object) -> None:
    program = _create_program(_client(owner))
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/",
        {"health": "PURPLE"},
        format="json",
    )
    assert resp.status_code == 400
    assert "health" in resp.data


@pytest.mark.django_db
def test_patch_visibility_rejects_invalid_choice(owner: object) -> None:
    program = _create_program(_client(owner))
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/",
        {"visibility": "EVERYWHERE"},
        format="json",
    )
    assert resp.status_code == 400
    assert "visibility" in resp.data


@pytest.mark.django_db
def test_patch_code_rejects_overlong_value(owner: object) -> None:
    program = _create_program(_client(owner))
    # Field is CharField(max_length=40) — anything longer must 400.
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/",
        {"code": "X" * 41},
        format="json",
    )
    assert resp.status_code == 400
    assert "code" in resp.data


@pytest.mark.django_db
def test_general_field_patch_requires_admin(owner: object, other_user: object) -> None:
    program = _create_program(_client(owner))
    ProgramMembership.objects.create(program=program, user=other_user, role=Role.MEMBER)
    resp = _client(other_user).patch(
        f"/api/v1/programs/{program.pk}/",
        {"health": "CRITICAL"},
        format="json",
    )
    assert resp.status_code == 403
    program.refresh_from_db()
    assert program.health == "AUTO"


# ---------------------------------------------------------------------------
# Ungrouped projects filter — GET /projects/?program__isnull=true (ADR-0171, #697)
# ---------------------------------------------------------------------------


def _make_project(owner_user: object, calendar: Calendar, **kwargs: object) -> Project:
    """Create a project the owner_user can see (active OWNER membership)."""
    defaults: dict[str, object] = {"name": "P", "start_date": date(2026, 4, 1)}
    defaults.update(kwargs)
    project = Project.objects.create(calendar=calendar, **defaults)
    ProjectMembership.objects.create(project=project, user=owner_user, role=Role.OWNER)
    return project


@pytest.mark.django_db
def test_ungrouped_filter_returns_only_standalone_projects(
    owner: object, calendar: Calendar
) -> None:
    program = _create_program(_client(owner))
    standalone = _make_project(owner, calendar, name="Standalone")
    _make_project(owner, calendar, name="Grouped", program=program)

    resp = _client(owner).get("/api/v1/projects/?program__isnull=true")

    assert resp.status_code == 200, resp.content
    ids = {row["id"] for row in resp.data["results"]}
    assert ids == {str(standalone.pk)}


@pytest.mark.django_db
def test_ungrouped_filter_is_rbac_scoped(
    owner: object, stranger: object, calendar: Calendar
) -> None:
    # The stranger has a standalone project; the owner has none of their own.
    _make_project(stranger, calendar, name="Stranger's standalone")

    resp = _client(owner).get("/api/v1/projects/?program__isnull=true")

    assert resp.status_code == 200, resp.content
    assert resp.data["results"] == []


@pytest.mark.django_db
def test_ungrouped_filter_annotates_member_count_and_percent_complete(
    owner: object, other_user: object, calendar: Calendar
) -> None:
    project = _make_project(owner, calendar, name="Has members and tasks")
    ProjectMembership.objects.create(project=project, user=other_user, role=Role.MEMBER)
    # Deliberately unequal member (2) and task (3) counts: the two aggregates
    # share one .annotate() and fan out (2 × 3 = 6 joined rows). member_count
    # must stay 2 — if distinct=True were dropped it would inflate to 6.
    Task.objects.create(project=project, name="A", percent_complete=100.0)
    Task.objects.create(project=project, name="B", percent_complete=50.0)
    Task.objects.create(project=project, name="C", percent_complete=0.0)

    resp = _client(owner).get("/api/v1/projects/?program__isnull=true")

    assert resp.status_code == 200, resp.content
    row = next(r for r in resp.data["results"] if r["id"] == str(project.pk))
    assert row["member_count"] == 2  # owner + other_user, not 6 (fan-out)
    assert row["percent_complete"] == 50.0  # mean of 100, 50, 0


@pytest.mark.django_db
def test_ungrouped_filter_excludes_archived_projects(owner: object, calendar: Calendar) -> None:
    _make_project(owner, calendar, name="Archived", is_archived=True)

    resp = _client(owner).get("/api/v1/projects/?program__isnull=true")

    assert resp.status_code == 200, resp.content
    assert resp.data["results"] == []


@pytest.mark.django_db
def test_default_project_list_does_not_annotate_aggregates(
    owner: object, calendar: Calendar
) -> None:
    # The hot /projects/ list stays lightweight — the aggregates are null unless
    # the ungrouped branch is requested (ADR-0171).
    project = _make_project(owner, calendar, name="Plain")
    Task.objects.create(project=project, name="A", percent_complete=100.0)

    resp = _client(owner).get("/api/v1/projects/")

    assert resp.status_code == 200, resp.content
    row = next(r for r in resp.data["results"] if r["id"] == str(project.pk))
    assert row["member_count"] is None
    assert row["percent_complete"] is None


# ---------------------------------------------------------------------------
# Per-project open-task count — GET /projects/ list annotation (#960)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_project_list_annotates_open_task_count(owner: object, calendar: Calendar) -> None:
    # open_task_count = non-deleted, not-yet-COMPLETE tasks. The COMPLETE and
    # soft-deleted tasks must NOT be counted; the two open tasks must be.
    project = _make_project(owner, calendar, name="Counts")
    Task.objects.create(project=project, name="Open 1", status=TaskStatus.NOT_STARTED)
    Task.objects.create(project=project, name="Open 2", status=TaskStatus.IN_PROGRESS)
    Task.objects.create(project=project, name="Done", status=TaskStatus.COMPLETE)
    Task.objects.create(project=project, name="Deleted", is_deleted=True)

    resp = _client(owner).get("/api/v1/projects/")

    assert resp.status_code == 200, resp.content
    row = next(r for r in resp.data["results"] if r["id"] == str(project.pk))
    assert row["open_task_count"] == 2


@pytest.mark.django_db
def test_project_list_open_task_count_zero_when_no_open_tasks(
    owner: object, calendar: Calendar
) -> None:
    project = _make_project(owner, calendar, name="All done")
    Task.objects.create(project=project, name="Done", status=TaskStatus.COMPLETE)

    resp = _client(owner).get("/api/v1/projects/")

    assert resp.status_code == 200, resp.content
    row = next(r for r in resp.data["results"] if r["id"] == str(project.pk))
    assert row["open_task_count"] == 0


@pytest.mark.django_db
def test_project_list_open_task_count_has_no_n_plus_one(owner: object, calendar: Calendar) -> None:
    """The open_task_count Subquery annotation must not add a query per project —
    listing 1 vs N projects costs the same number of queries (#960, perf-check)."""

    def seed(name: str, n_projects: int) -> None:
        for i in range(n_projects):
            p = _make_project(owner, calendar, name=f"{name}-{i}")
            Task.objects.create(project=p, name="t", status=TaskStatus.IN_PROGRESS)

    seed("one", 1)

    def list_query_count() -> int:
        with CaptureQueriesContext(connection) as ctx:
            r = _client(owner).get("/api/v1/projects/")
            assert r.status_code == 200, r.content
        return len(ctx.captured_queries)

    # Prime per-process caches (content types, permission lookups) so the
    # baseline reflects steady-state query count, not first-request overhead.
    list_query_count()
    baseline = list_query_count()
    seed("many", 5)
    assert list_query_count() == baseline


@pytest.mark.django_db
def test_serializer_exposes_real_health(owner: object, calendar: Calendar) -> None:
    # The list row carries the project's health enum so the sidebar dot can color
    # from server data rather than hardcoding 'unknown'.
    project = _make_project(owner, calendar, name="At risk", health=Health.AT_RISK)

    resp = _client(owner).get("/api/v1/projects/")

    assert resp.status_code == 200, resp.content
    row = next(r for r in resp.data["results"] if r["id"] == str(project.pk))
    assert row["health"] == Health.AT_RISK


# ---------------------------------------------------------------------------
# #560 — Program.target_date + per-project overdue / at-risk rollup
# ---------------------------------------------------------------------------


def _task(
    project: Project,
    name: str,
    *,
    status: str = TaskStatus.IN_PROGRESS,
    total_float: int | None = None,
    early_finish: date | None = None,
    is_deleted: bool = False,
) -> Task:
    return Task.objects.create(
        project=project,
        name=name,
        wbs_path=name,
        duration=1,
        status=status,
        total_float=total_float,
        early_finish=early_finish,
        is_deleted=is_deleted,
    )


@pytest.mark.django_db
def test_program_target_date_defaults_to_null(owner: object) -> None:
    program = _create_program(_client(owner))
    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/")
    assert resp.status_code == 200
    assert resp.data["target_date"] is None


@pytest.mark.django_db
def test_program_admin_can_set_and_clear_target_date(owner: object) -> None:
    program = _create_program(_client(owner))  # creator is OWNER (>= ADMIN)
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/",
        {"target_date": "2026-12-31"},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["target_date"] == "2026-12-31"
    program.refresh_from_db()
    assert program.target_date == date(2026, 12, 31)

    # Clearing back to null is honored (open-ended program).
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/",
        {"target_date": None},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["target_date"] is None


@pytest.mark.django_db
def test_program_member_cannot_set_target_date(owner: object, other_user: object) -> None:
    # A plain Member is below the IsProgramAdmin gate on update — write blocked.
    program = _create_program(_client(owner))
    ProgramMembership.objects.create(program=program, user=other_user, role=Role.MEMBER)
    resp = _client(other_user).patch(
        f"/api/v1/programs/{program.pk}/",
        {"target_date": "2026-12-31"},
        format="json",
    )
    assert resp.status_code == 403
    program.refresh_from_db()
    assert program.target_date is None


@pytest.mark.django_db
def test_projects_endpoint_annotates_overdue_and_at_risk_counts(
    owner: object, calendar: Calendar
) -> None:
    program = _create_program(_client(owner))
    project = Project.objects.create(
        name="A", start_date=date(2026, 4, 1), calendar=calendar, program=program
    )
    past = date(2020, 1, 1)
    future = date(2099, 1, 1)
    # overdue only (past finish, ample float)
    _task(project, "overdue", total_float=20, early_finish=past)
    # at-risk only (tight float, future finish)
    _task(project, "atrisk", total_float=2, early_finish=future)
    # both overdue AND at-risk (already late = negative float)
    _task(project, "both", total_float=-1, early_finish=past)
    # excluded: COMPLETE despite past finish
    _task(project, "done", status=TaskStatus.COMPLETE, total_float=-5, early_finish=past)
    # excluded: soft-deleted despite past finish + tight float
    _task(project, "gone", total_float=0, early_finish=past, is_deleted=True)
    # neither (healthy)
    _task(project, "healthy", total_float=30, early_finish=future)

    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/projects/")
    assert resp.status_code == 200, resp.content
    row = next(r for r in resp.data if r["id"] == str(project.pk))
    assert row["overdue_count"] == 2  # overdue + both
    assert row["at_risk_count"] == 2  # atrisk + both


@pytest.mark.django_db
def test_projects_endpoint_counts_zero_with_no_qualifying_tasks(
    owner: object, calendar: Calendar
) -> None:
    program = _create_program(_client(owner))
    project = Project.objects.create(
        name="Empty", start_date=date(2026, 4, 1), calendar=calendar, program=program
    )
    _task(project, "healthy", total_float=30, early_finish=date(2099, 1, 1))

    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/projects/")
    row = next(r for r in resp.data if r["id"] == str(project.pk))
    assert row["overdue_count"] == 0
    assert row["at_risk_count"] == 0


@pytest.mark.django_db
def test_projects_endpoint_count_annotations_are_not_n_plus_one(
    owner: object, calendar: Calendar
) -> None:
    # The two conditional COUNTs must ride the single list query, not a per-row
    # follow-up — adding more projects must not add queries.
    program = _create_program(_client(owner))
    for i in range(4):
        p = Project.objects.create(
            name=f"P{i}",
            start_date=date(2026, 4, 1),
            calendar=calendar,
            program=program,
        )
        _task(p, f"od{i}", total_float=1, early_finish=date(2020, 1, 1))

    client = _client(owner)
    with CaptureQueriesContext(connection) as ctx:
        resp = client.get(f"/api/v1/programs/{program.pk}/projects/")
    assert resp.status_code == 200
    assert len(resp.data) == 4
    # Bounded: the list query + permission/object lookups, constant regardless of
    # project count. Generous ceiling guards against a regression to per-row counts.
    assert len(ctx.captured_queries) <= 12, len(ctx.captured_queries)
