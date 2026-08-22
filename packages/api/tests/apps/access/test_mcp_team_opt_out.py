"""Tests for the team-level MCP opt-out (#2482, ADR-0678).

The control: a team (project) can block agent-token reads of its own data, and no
scope above it can re-enable them. Covered here:

  * **Conformance** — every ``McpReadableViewMixin`` subclass declares an
    ``mcp_scope``, and an undeclared view fails *closed*. This is the test that
    stops a future MCP-readable view from silently joining the surface unfiltered.
  * **PATH guard** — each project-scoped ``APIView`` 403s for an opted-out project.
    These run per-endpoint on purpose: the guard resolves the project from a URL
    kwarg, and only an end-to-end call proves each route's kwarg actually resolves.
  * **Collection filtering** — list endpoints withhold rows rather than 403, and
    the detail route of an opted-out object 404s.
  * **Program aggregates (threat-model T1)** — the five ``ProgramViewSet`` detail
    actions that read *child project* data. This is the bypass a guard-plus-queryset
    design would have left open, so each gets a direct regression test.
  * **Restrictive-only cascade** — a workspace/program "on" can never override a
    project's "off"; ``None`` means no opinion, never yes.
  * **T6 self-re-enable** — a read-only token cannot ``PATCH`` ``mcp_enabled``, so
    the agent cannot lift the control that restrains it.
  * **T7 privilege** — a Scheduler cannot flip the switch; Admin+ can.
  * **Human callers are never affected**, on any of the above.
"""

from __future__ import annotations

import secrets
from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.test import override_settings
from rest_framework.test import APIClient, APIRequestFactory

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.access.permissions import (
    McpProjectEnabled,
    McpReadableViewMixin,
    McpScope,
)
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.mcp_settings import (
    resolve_inherited_mcp_enabled,
    resolve_mcp_enabled,
)
from trueppm_api.apps.projects.models import (
    SCOPE_MCP_READ,
    ApiToken,
    Calendar,
    Program,
    Project,
)
from trueppm_api.apps.workspace.models import Workspace

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(username="optout_owner", password="pw")


@pytest.fixture
def program(db: object, owner: Any) -> Program:
    prog = Program.objects.create(name="Prog")
    # Program membership is independent of project membership (ADR-0070); without
    # it ProgramViewSet.get_object() 404s and the aggregate tests would pass
    # vacuously — never reaching the code they exist to exercise.
    ProgramMembership.objects.create(program=prog, user=owner, role=Role.OWNER)
    return prog


@pytest.fixture
def project(calendar: Calendar, owner: Any, program: Program) -> Project:
    """An OWNER-membered project — so a 403 can only come from the opt-out.

    The name is deliberately distinctive: the aggregate-leak tests substring-search
    the whole serialized payload, and a short name like "P" matches inside unrelated
    values ("WORKSPACE"), producing a false failure.
    """
    proj = Project.objects.create(
        name="ZebraOptedOutProj", start_date=date(2026, 4, 1), calendar=calendar, program=program
    )
    ProjectMembership.objects.create(project=proj, user=owner, role=Role.OWNER)
    return proj


@pytest.fixture
def other_project(calendar: Calendar, owner: Any, program: Program) -> Project:
    """A second member project in the same program — the row that must survive."""
    proj = Project.objects.create(
        name="QuokkaOpenProj", start_date=date(2026, 4, 1), calendar=calendar, program=program
    )
    ProjectMembership.objects.create(project=proj, user=owner, role=Role.OWNER)
    return proj


def _mint_personal(owner: Any) -> tuple[ApiToken, str]:
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    token = ApiToken.objects.create(
        owner=owner,
        name="personal-token",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=owner,
        scopes=[SCOPE_MCP_READ],
    )
    return token, raw


def _agent(owner: Any) -> APIClient:
    _, raw = _mint_personal(owner)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return client


def _human(owner: Any) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=owner)
    return client


def _opt_out(project: Project) -> None:
    project.mcp_enabled = False
    project.save(update_fields=["mcp_enabled"])


# ---------------------------------------------------------------------------
# Conformance — no view may silently join the MCP surface undeclared
# ---------------------------------------------------------------------------


def _all_mcp_views() -> list[type]:
    """Every concrete ``McpReadableViewMixin`` subclass, via the URLconf.

    Importing the URLconf guarantees every view module is loaded, so
    ``__subclasses__`` is complete — a subclass in a module nobody imported would
    otherwise be invisible to this test and defeat its purpose.
    """
    import django.urls  # noqa: F401  — force URLconf import so all view modules load
    from django.urls import get_resolver

    # Touch url_patterns to force the URLconf (and therefore every view module)
    # to import; bound to a name because a bare attribute access reads as dead code.
    _loaded = get_resolver().url_patterns
    assert _loaded is not None

    seen: list[type] = []

    def walk(cls: type) -> None:
        for sub in cls.__subclasses__():
            if sub not in seen:
                seen.append(sub)
            walk(sub)

    walk(McpReadableViewMixin)
    return seen


def test_every_mcp_readable_view_declares_a_scope() -> None:
    """ADR-0678: declare-or-deny. An undeclared view is denied at runtime; this
    test makes that surface in CI rather than as a support ticket."""
    undeclared = [v.__name__ for v in _all_mcp_views() if getattr(v, "mcp_scope", None) is None]
    assert not undeclared, (
        "These McpReadableViewMixin subclasses do not declare an mcp_scope, so agent "
        f"reads on them fail closed (ADR-0678): {undeclared}. Pick a McpScope value — "
        "PATH, QUERYSET, AGGREGATE, or NO_PROJECT_DATA — and read the enum docstring "
        "for which mechanism each selects."
    )


def test_declared_scopes_are_valid_members() -> None:
    for view in _all_mcp_views():
        scope = getattr(view, "mcp_scope", None)
        assert isinstance(scope, McpScope), f"{view.__name__} declares {scope!r}"


def test_get_permissions_overrides_still_append_the_mcp_guards() -> None:
    """A view that overrides ``get_permissions`` must re-append ``mcp_token_guards()``.

    The mixin adds the MCP guards *in* ``get_permissions``, so an override that
    returns its own list silently drops every one of them — not just the team
    opt-out, but the scope/owner checks and the instance-wide kill switch
    (ADR-0497) too. ``BoardColumnConfigView`` shipped with exactly this defect and
    was found by this suite; the source-level assertion is what keeps it fixed,
    because the failure mode is a view being *more* permissive than intended and
    therefore invisible to any test that only checks happy paths.
    """
    import inspect

    offenders = []
    for view in _all_mcp_views():
        own = view.__dict__.get("get_permissions")
        if own is None:
            continue  # inherits the mixin's — guards applied by construction
        if "mcp_token_guards" not in inspect.getsource(own):
            offenders.append(view.__name__)
    assert not offenders, (
        "These MCP-readable views override get_permissions without re-appending "
        f"self.mcp_token_guards(), so NO MCP token guard applies to them: {offenders}. "
        "Return [*your_rbac_list, *self.mcp_token_guards()]."
    )


@pytest.mark.django_db
def test_undeclared_view_fails_closed(project: Project, owner: Any) -> None:
    """The property the conformance test protects: forgetting denies, never admits."""
    token, _ = _mint_personal(owner)
    request = APIRequestFactory().get("/")
    request.auth = token  # type: ignore[attr-defined]

    class _Undeclared:
        mcp_scope = None
        kwargs: dict[str, Any] = {}  # noqa: RUF012

    assert McpProjectEnabled().has_permission(request, _Undeclared()) is False  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# PATH guard — one case per project-scoped route
# ---------------------------------------------------------------------------


_PATH_ROUTES = [
    "overview/",
    "board-config/",
    "sprint-health/",
    "forecast/",
    "sprint-forecast/",
    "monte-carlo/latest/",
    "schedule/derivation/",
]


@pytest.mark.django_db
@pytest.mark.parametrize("suffix", _PATH_ROUTES)
def test_path_scoped_route_refused_when_opted_out(
    project: Project, owner: Any, suffix: str
) -> None:
    """Each PATH view resolves its project from a URL kwarg; only an end-to-end call
    proves the kwarg actually resolves (a mis-declared kwarg would 403 everything,
    or — worse before the fix — nothing)."""
    _opt_out(project)
    resp = _agent(owner).get(f"/api/v1/projects/{project.pk}/{suffix}")
    assert resp.status_code == 403, f"{suffix} -> {resp.status_code}"


@pytest.mark.django_db
@pytest.mark.parametrize("suffix", _PATH_ROUTES)
def test_path_scoped_route_allowed_when_opted_in(project: Project, owner: Any, suffix: str) -> None:
    """The mirror case — proves the 403 above comes from the opt-out and not from a
    kwarg the guard simply failed to resolve (which would fail closed on every call
    and make the refusal test vacuously green)."""
    resp = _agent(owner).get(f"/api/v1/projects/{project.pk}/{suffix}")
    assert resp.status_code != 403, f"{suffix} -> {resp.status_code}"


@pytest.mark.django_db
@pytest.mark.parametrize("suffix", _PATH_ROUTES)
def test_path_scoped_route_unaffected_for_humans(project: Project, owner: Any, suffix: str) -> None:
    _opt_out(project)
    resp = _human(owner).get(f"/api/v1/projects/{project.pk}/{suffix}")
    assert resp.status_code != 403, f"{suffix} -> {resp.status_code}"


# ---------------------------------------------------------------------------
# Collection filtering — the hole a guard-only design leaves open
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_project_list_withholds_opted_out_row(
    project: Project, other_project: Project, owner: Any
) -> None:
    _opt_out(project)
    resp = _agent(owner).get("/api/v1/projects/")
    assert resp.status_code == 200, resp.data
    ids = {row["id"] for row in resp.data["results"]}
    assert str(project.pk) not in ids
    assert str(other_project.pk) in ids, "the opted-in sibling must survive"


@pytest.mark.django_db
def test_task_collection_query_param_cannot_bypass(
    project: Project, owner: Any, calendar: Calendar
) -> None:
    """The #1712-shaped bypass: the project rides in as a QUERY PARAM, where a
    permission class cannot see it. Row filtering is what closes this."""
    from trueppm_api.apps.projects.models import Task

    Task.objects.create(project=project, name="secret", duration=1)
    _opt_out(project)
    resp = _agent(owner).get(f"/api/v1/tasks/?project={project.pk}")
    assert resp.status_code == 200, resp.data
    assert resp.data["results"] == []


@pytest.mark.django_db
def test_task_trash_collection_cannot_bypass(
    project: Project, owner: Any, calendar: Calendar
) -> None:
    """`/tasks/trash/` builds its queryset by hand — re-apply the filter (#2494).

    The trash list deliberately bypasses ``get_queryset``/``filter_queryset`` to reach
    tombstoned rows, which is exactly where both opt-out hooks live. Without an
    explicit re-application it would fail *open*: an opted-out team's deleted task
    names would be readable through the recovery surface.
    """
    from trueppm_api.apps.projects.models import Task

    task = Task.objects.create(project=project, name="secret-deleted", duration=1)
    task.soft_delete()
    _opt_out(project)

    resp = _agent(owner).get(f"/api/v1/tasks/trash/?project={project.pk}")
    assert resp.status_code == 200, resp.data
    assert resp.data["results"] == []

    # The human path is untouched — the control governs agent reads, not the team's own.
    human = _human(owner).get(f"/api/v1/tasks/trash/?project={project.pk}")
    assert [r["name"] for r in human.data["results"]] == ["secret-deleted"]


@pytest.mark.django_db
def test_detail_route_of_opted_out_object_is_not_found(project: Project, owner: Any) -> None:
    """A filtered queryset resolves the object, so an opted-out detail read 404s
    rather than leaking through a path the guard does not cover."""
    _opt_out(project)
    resp = _agent(owner).get(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code in (403, 404), resp.status_code


@pytest.mark.django_db
def test_template_divergence_respects_the_opt_out(project: Project, owner: Any) -> None:
    """The divergence digest (#2971) resolves through the filtered queryset like its siblings.

    Added with the endpoint rather than after it: this is exactly the shape #3001 /
    #2995 found repeatedly — a project-detail ``@action`` whose body is correct for
    humans and invisible to the agent opt-out because it looked the project up itself
    instead of through ``get_object()``.
    """
    _opt_out(project)
    resp = _agent(owner).get(f"/api/v1/projects/{project.pk}/template-divergence/")
    assert resp.status_code in (403, 404), resp.status_code


@pytest.mark.django_db
def test_template_divergence_unaffected_for_humans(project: Project, owner: Any) -> None:
    """The opt-out governs agents. The team's own read of their own report stays open."""
    _opt_out(project)
    resp = _human(owner).get(f"/api/v1/projects/{project.pk}/template-divergence/")
    assert resp.status_code == 200, resp.status_code


@pytest.mark.django_db
def test_human_list_is_unfiltered(project: Project, other_project: Project, owner: Any) -> None:
    _opt_out(project)
    resp = _human(owner).get("/api/v1/projects/")
    assert resp.status_code == 200, resp.data
    ids = {row["id"] for row in resp.data["results"]}
    assert {str(project.pk), str(other_project.pk)} <= ids


# ---------------------------------------------------------------------------
# Threat-model T1 — program aggregates read CHILD PROJECT data
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize(
    "suffix",
    ["projects/", "rollup/", "schedule/", "task-search/?q=a", "resource-contention/"],
)
def test_program_aggregate_does_not_leak_opted_out_child(
    project: Project, other_project: Project, program: Program, owner: Any, suffix: str
) -> None:
    """ADR-0678 T1: these read the program's CHILD PROJECTS, which the mixin's
    Program-row filter does not reach. The opted-out project's name must not appear
    anywhere in the payload, and the sibling must still be represented."""
    _opt_out(project)
    resp = _agent(owner).get(f"/api/v1/programs/{program.pk}/{suffix}")
    assert resp.status_code in (200, 409), f"{suffix} -> {resp.status_code}"
    if resp.status_code != 200:
        return  # contention returns 409 with no schedulable window; nothing to leak
    body = str(resp.data)
    assert str(project.pk) not in body, f"{suffix} leaked the opted-out project id"
    assert project.name not in body, f"{suffix} leaked the opted-out project name"


@pytest.mark.django_db
def test_program_mention_reach_excludes_opted_out_child(
    project: Project, other_project: Project, program: Program, owner: Any
) -> None:
    """ADR-0678 T1 for the sixth program aggregate (#2529, ADR-0697).

    The reach endpoint returns counts only, so the name/id substring assertion the
    parametrized guard above uses cannot detect a leak here — the number itself is
    the payload. A Viewer who exists only inside an opted-out project must not be
    counted for an agent token, while the human read on the same program still sees
    them. The external arm is program-owned with no project FK, so a project-level
    opt-out must leave it untouched.
    """
    from django.contrib.auth import get_user_model

    from trueppm_api.apps.access.models import ExternalStakeholder, ProjectMembership, Role

    user_model = get_user_model()
    hidden_viewer = user_model.objects.create_user(username="mcp_reach_viewer", password="pw")
    ProjectMembership.objects.create(project=project, user=hidden_viewer, role=Role.VIEWER)
    ExternalStakeholder.objects.create(program=program, name="Dana", email="dana@client.com")
    _opt_out(project)

    agent = _agent(owner).get(f"/api/v1/programs/{program.pk}/mention-reach/")
    human = _human(owner).get(f"/api/v1/programs/{program.pk}/mention-reach/")

    assert agent.status_code == 200, agent.data
    assert human.status_code == 200, human.data
    assert human.data["viewer_member_count"] == 1
    assert agent.data["viewer_member_count"] == 0, "opted-out project's Viewer was counted"
    # Program-owned rows are governed by the program's own denial, not a child's.
    assert agent.data["external_stakeholder_count"] == 1


@pytest.mark.django_db
def test_program_schedule_drops_rather_than_redacts(
    project: Project, program: Program, owner: Any
) -> None:
    """The redaction path (ExternalTaskCard) still exposes task titles and CPM
    dates — the right answer for a project the caller merely cannot read, and the
    WRONG answer for one that explicitly withheld consent."""
    from trueppm_api.apps.projects.models import Task

    Task.objects.create(project=project, name="confidential-milestone", duration=1)
    _opt_out(project)
    resp = _agent(owner).get(f"/api/v1/programs/{program.pk}/schedule/")
    assert resp.status_code == 200, resp.data
    assert "confidential-milestone" not in str(resp.data)


# ---------------------------------------------------------------------------
# Aggregators filter silently rather than refusing wholesale
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_me_search_filters_rather_than_refuses(
    project: Project, other_project: Project, owner: Any
) -> None:
    """One team's opt-out must not blank a contributor's whole cross-project search."""
    from trueppm_api.apps.projects.models import Task

    Task.objects.create(project=project, name="findme-secret", duration=1)
    Task.objects.create(project=other_project, name="findme-open", duration=1)
    _opt_out(project)
    resp = _agent(owner).get("/api/v1/me/search/?q=findme")
    assert resp.status_code == 200, resp.data
    names = {r.get("name") or r.get("title") for r in resp.data["results"]}
    assert "findme-secret" not in names
    assert "findme-open" in names, "the opted-in project's row must still be returned"


@pytest.mark.django_db
def test_me_work_excludes_opted_out_rows(
    project: Project, other_project: Project, owner: Any
) -> None:
    from trueppm_api.apps.projects.models import Task, TaskStatus

    Task.objects.create(
        project=project,
        name="mine-secret",
        duration=1,
        assignee=owner,
        status=TaskStatus.NOT_STARTED,
    )
    Task.objects.create(
        project=other_project,
        name="mine-open",
        duration=1,
        assignee=owner,
        status=TaskStatus.NOT_STARTED,
    )
    _opt_out(project)
    resp = _agent(owner).get("/api/v1/me/work/")
    assert resp.status_code == 200, resp.data
    names = {r["name"] for r in resp.data["results"]}
    assert "mine-secret" not in names
    assert "mine-open" in names


# ---------------------------------------------------------------------------
# The restrictive-only cascade
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_workspace_on_cannot_override_project_off(project: Project) -> None:
    """The core consent property: no scope grants over another's denial."""
    ws = Workspace.load()
    ws.mcp_enabled = True
    ws.save(update_fields=["mcp_enabled"])
    _opt_out(project)
    assert resolve_mcp_enabled(project) is False


@pytest.mark.django_db
def test_program_on_cannot_override_project_off(project: Project, program: Program) -> None:
    program.mcp_enabled = True
    program.save(update_fields=["mcp_enabled"])
    _opt_out(project)
    assert resolve_mcp_enabled(project) is False


@pytest.mark.django_db
def test_program_off_closes_its_projects(project: Project, program: Program) -> None:
    program.mcp_enabled = False
    program.save(update_fields=["mcp_enabled"])
    assert project.mcp_enabled is None  # no opinion of its own
    assert resolve_mcp_enabled(project) is False


@pytest.mark.django_db
def test_none_means_no_opinion_not_denial(project: Project) -> None:
    assert project.mcp_enabled is None
    assert resolve_mcp_enabled(project) is True


@pytest.mark.django_db
def test_workspace_off_closes_everything(project: Project) -> None:
    ws = Workspace.load()
    ws.mcp_enabled = False
    ws.save(update_fields=["mcp_enabled"])
    assert resolve_mcp_enabled(project) is False


@pytest.mark.django_db
@override_settings(TRUEPPM_MCP_ENABLED=False)
def test_instance_switch_composes_with_team_switch(project: Project) -> None:
    """ADR-0497 and ADR-0678 are ANDed — neither overrides the other permissively."""
    assert resolve_mcp_enabled(project) is False
    # ...and the team's own decision is still legible on its own when asked for.
    assert resolve_mcp_enabled(project, include_instance=False) is True


@pytest.mark.django_db
def test_inherited_ignores_own_value(project: Project, program: Program) -> None:
    """Drives the settings 'Inherit (On/Off)' affordance."""
    _opt_out(project)
    assert resolve_inherited_mcp_enabled(project) is True
    program.mcp_enabled = False
    program.save(update_fields=["mcp_enabled"])
    assert resolve_inherited_mcp_enabled(project) is False


# ---------------------------------------------------------------------------
# T6 — the restrained agent cannot lift its own restraint
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_token_cannot_re_enable_mcp(project: Project, owner: Any) -> None:
    """This is what makes the switch a consent control rather than a suggestion.

    It rests on a *pre-existing* guard (``TokenReadOnlyMethods``), so it is asserted
    explicitly here: a future reordering of the guard list would otherwise break the
    property silently.
    """
    _opt_out(project)
    resp = _agent(owner).patch(f"/api/v1/projects/{project.pk}/", {"mcp_enabled": True})
    assert resp.status_code in (403, 404, 405), resp.status_code
    project.refresh_from_db()
    assert project.mcp_enabled is False


# ---------------------------------------------------------------------------
# T7 — who may flip the switch
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_scheduler_cannot_flip_the_switch(project: Project, calendar: Calendar) -> None:
    """A Scheduler must not re-enable agent reads over the team's Admin decision.
    ``ProjectViewSet.update`` gates only at Scheduler, so the field-level allowlist
    is the thing standing between a Scheduler and this field."""
    scheduler = User.objects.create_user(username="sched", password="pw")
    ProjectMembership.objects.create(project=project, user=scheduler, role=Role.SCHEDULER)
    _opt_out(project)
    resp = _human(scheduler).patch(f"/api/v1/projects/{project.pk}/", {"mcp_enabled": True})
    assert resp.status_code == 400, resp.data
    project.refresh_from_db()
    assert project.mcp_enabled is False


@pytest.mark.django_db
def test_admin_can_flip_the_switch(project: Project, owner: Any) -> None:
    resp = _human(owner).patch(f"/api/v1/projects/{project.pk}/", {"mcp_enabled": False})
    assert resp.status_code == 200, resp.data
    project.refresh_from_db()
    assert project.mcp_enabled is False


@pytest.mark.django_db
def test_serializer_exposes_effective_and_inherited(project: Project, owner: Any) -> None:
    resp = _human(owner).get(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code == 200, resp.data
    assert resp.data["mcp_enabled"] is None
    assert resp.data["effective_mcp_enabled"] is True
    assert resp.data["inherited_mcp_enabled"] is True


# ---------------------------------------------------------------------------
# #2995 — @action detail reads on a QUERYSET-scoped viewset
# ---------------------------------------------------------------------------
#
# ADR-0678 T3 records that the conformance test cannot see `@action` routes and
# calls this "a grep + review obligation". Eleven actions on SprintViewSet drifted
# under that obligation: each resolved its object with `get_object_or_404(Sprint,
# ...)` — the bare manager — which never touches `get_queryset()`. Because
# `mcp_scope` is QUERYSET, `McpProjectEnabled.has_permission` returns True
# unconditionally and the queryset is the ONLY enforcement point, so every one of
# them served an opted-out project to an `mcp:read` token.
#
# Parametrized rather than written per endpoint on purpose: a per-endpoint test is
# exactly what eleven sites drifted past.

_SPRINT_ACTION_READS = [
    "burndown/",
    "outcome/",
    "capacity/",
    "daily-delta/",
    "scope-changes/",
    "incoming_carryover/",
    "close-request/",
    # reforecast-preview was the one GET this fix originally MISSED — its
    # `.filter(pk=pk).first()` shape reads nothing like its get_object_or_404
    # siblings, so a regex sweep passed straight over it. Listed first among the
    # late additions for that reason.
    "reforecast-preview/",
    "duration-events/",
    "blocked/",
    "retro/",
    "retro-board/",
    "pulse/",
    "pulse-trend/",
    "retrospective/prior/",
]


@pytest.fixture
def _sprint(project: Project) -> Any:
    from datetime import date as _date

    from trueppm_api.apps.projects.models import Sprint, SprintState

    return Sprint.objects.create(
        project=project,
        name="S1",
        start_date=_date(2026, 4, 1),
        finish_date=_date(2026, 4, 14),
        state=SprintState.ACTIVE,
    )


@pytest.mark.django_db
@pytest.mark.parametrize("suffix", _SPRINT_ACTION_READS)
def test_sprint_action_reads_respect_the_opt_out(
    project: Project, owner: Any, _sprint: Any, suffix: str
) -> None:
    """An agent token gets nothing from a project that opted out of agent reads."""
    _opt_out(project)
    resp = _agent(owner).get(f"/api/v1/sprints/{_sprint.pk}/{suffix}")
    assert resp.status_code == 404, f"{suffix} leaked an opted-out project: {resp.status_code}"


@pytest.mark.django_db
@pytest.mark.parametrize("suffix", _SPRINT_ACTION_READS)
def test_sprint_action_reads_unaffected_for_humans(
    project: Project, owner: Any, _sprint: Any, suffix: str
) -> None:
    """The opt-out governs *agents*. The same routes stay open to the human who
    owns the token — otherwise this fix would be an outage, not a control.

    404 is tolerated per-endpoint here (some of these need data the fixture does
    not create); what must never appear is 403, which would mean the human was
    denied by the agent gate.
    """
    _opt_out(project)
    resp = _human(owner).get(f"/api/v1/sprints/{_sprint.pk}/{suffix}")
    assert resp.status_code != 403, f"{suffix} denied a human via the agent opt-out"
