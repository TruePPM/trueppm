"""MCP read-surface expansion: project history + dependencies/baselines/phases/
calendars/custom fields/acceptance criteria (#5006, #1812).

For each newly agent-readable view an ``mcp:read`` token must (a) read what its owner
can read, (b) be refused on every write method, (c) be refused/empty for a project
that is not the owner's, and (d) honor the team opt-out (ADR-0678) the same way the
existing surface does. Nothing here widens a *human* caller.
"""

from __future__ import annotations

import secrets
from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import (
    SCOPE_MCP_READ,
    AcceptanceCriterion,
    ApiToken,
    Baseline,
    Calendar,
    Dependency,
    Health,
    Project,
    ProjectCustomField,
    Task,
)

User = get_user_model()
pytestmark = pytest.mark.django_db


def _agent(owner: Any) -> APIClient:
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    ApiToken.objects.create(
        owner=owner,
        name="agent",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=owner,
        scopes=[SCOPE_MCP_READ],
    )
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return client


def _human(user: Any) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def calendar() -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(username="exp_owner", password="pw")


@pytest.fixture
def stranger() -> Any:
    return User.objects.create_user(username="exp_stranger", password="pw")


def _project(name: str, calendar: Calendar, owner: Any, role: int = Role.OWNER) -> Project:
    proj = Project.objects.create(name=name, start_date=date(2026, 4, 1), calendar=calendar)
    ProjectMembership.objects.create(project=proj, user=owner, role=role)
    return proj


@pytest.fixture
def project(calendar: Calendar, owner: Any) -> Project:
    return _project("ExpansionProj", calendar, owner)


@pytest.fixture
def world(project: Project) -> dict[str, Any]:
    """One row of every newly-readable kind, all in ``project``."""
    pred = Task.objects.create(project=project, name="Pred", duration=2, wbs_path="1")
    succ = Task.objects.create(project=project, name="Succ", duration=2, wbs_path="2")
    return {
        "pred": pred,
        "succ": succ,
        "dep": Dependency.objects.create(predecessor=pred, successor=succ, dep_type="FS"),
        "baseline": Baseline.objects.create(project=project, name="B1"),
        "field": ProjectCustomField.objects.create(project=project, name="Reviewer"),
        "criterion": AcceptanceCriterion.objects.create(
            task=pred, text="AC", met=False, position=0
        ),
    }


def _urls(project: Project, world: dict[str, Any]) -> dict[str, str]:
    return {
        "history": f"/api/v1/projects/{project.pk}/history/",
        "dependencies": f"/api/v1/dependencies/?project={project.pk}",
        "baselines": f"/api/v1/projects/{project.pk}/baselines/",
        "phases": f"/api/v1/projects/{project.pk}/phases/",
        "fields": f"/api/v1/projects/{project.pk}/fields/",
        "criteria": f"/api/v1/acceptance-criteria/?task={world['pred'].pk}",
        "calendars": "/api/v1/calendars/",
        "calendar_exceptions": f"/api/v1/calendars/{project.calendar_id}/exceptions/",
    }


def _rows(resp: Any) -> list[Any]:
    data = resp.data
    return list(data["results"]) if isinstance(data, dict) and "results" in data else list(data)


# --- (a) an mcp:read token reads what its owner reads -----------------------------


@pytest.mark.parametrize(
    "key",
    [
        "history",
        "dependencies",
        "baselines",
        "phases",
        "fields",
        "criteria",
        "calendars",
        "calendar_exceptions",
    ],
)
def test_mcp_read_token_reads_each_new_surface(
    project: Project, world: dict[str, Any], owner: Any, key: str
) -> None:
    resp = _agent(owner).get(_urls(project, world)[key])
    assert resp.status_code == 200, resp.data
    if key in ("dependencies", "baselines", "phases", "fields", "criteria", "calendars"):
        assert _rows(resp), f"{key} returned no rows to an authorized token"


def test_history_answers_who_reported_it_for_an_admin_owner(project: Project, owner: Any) -> None:
    """The #5006 question: the actor rides through when the owner is Owner/Admin."""
    # ``health_band`` is computed; the stored, history-tracked column behind
    # ``health_band_source: reported`` is ``Project.health``. ``_history_user`` is
    # what the request middleware sets.
    project.health = Health.CRITICAL
    project._history_user = owner  # type: ignore[attr-defined]
    project.save()
    resp = _agent(owner).get(f"/api/v1/projects/{project.pk}/history/")
    assert resp.status_code == 200
    rows = _rows(resp)
    assert rows, resp.data
    hit = [
        r
        for r in rows
        if any(c.get("field") == "health" and c.get("new") == "CRITICAL" for c in r["diff"])
    ]
    assert hit, rows
    assert hit[0]["history_user"] is not None
    assert str(hit[0]["history_user"]["id"]) == str(owner.pk)


def test_history_user_stays_redacted_for_a_viewer_owner_token(
    calendar: Calendar, owner: Any
) -> None:
    """The token inherits its owner's redaction — an agent never sees more than its owner."""
    proj = _project("ViewerProj", calendar, owner, role=Role.VIEWER)
    proj.name = "ViewerProj2"
    proj.save()
    resp = _agent(owner).get(f"/api/v1/projects/{proj.pk}/history/")
    assert resp.status_code == 200
    rows = _rows(resp)
    assert rows, resp.data
    for row in rows:
        assert row.get("history_user") in (None, {}), row


# --- (b) writes stay refused ---------------------------------------------------------


def test_mcp_read_token_cannot_write_any_new_surface(
    project: Project, world: dict[str, Any], owner: Any
) -> None:
    agent = _agent(owner)
    dep, base, fld, crit = world["dep"], world["baseline"], world["field"], world["criterion"]
    attempts = [
        ("post", f"/api/v1/projects/{project.pk}/baselines/", {"name": "x"}),
        ("delete", f"/api/v1/projects/{project.pk}/baselines/{base.pk}/", None),
        ("post", f"/api/v1/projects/{project.pk}/phases/", {"name": "x"}),
        ("post", f"/api/v1/projects/{project.pk}/fields/", {"name": "x", "field_type": "text"}),
        ("patch", f"/api/v1/projects/{project.pk}/fields/{fld.pk}/", {"name": "y"}),
        ("patch", f"/api/v1/dependencies/{dep.pk}/", {"lag": 3}),
        ("delete", f"/api/v1/dependencies/{dep.pk}/", None),
        ("patch", f"/api/v1/acceptance-criteria/{crit.pk}/", {"met": True}),
        ("post", "/api/v1/calendars/", {"name": "x"}),
        ("post", f"/api/v1/calendars/{project.calendar_id}/exceptions/", {"name": "x"}),
    ]
    for method, url, body in attempts:
        resp = getattr(agent, method)(url, body, format="json")
        assert resp.status_code == 403, f"{method.upper()} {url}: {resp.status_code} {resp.data}"
    assert Baseline.objects.filter(project=project).count() == 1
    assert Dependency.objects.filter(pk=dep.pk, is_deleted=False, lag=0).exists()
    crit.refresh_from_db()
    assert crit.met is False


# --- (c) a token never reads beyond its owner -----------------------------------------


def test_token_of_a_non_member_reads_nothing_of_the_project(
    project: Project, world: dict[str, Any], stranger: Any
) -> None:
    agent = _agent(stranger)
    for key, url in _urls(project, world).items():
        if key in ("calendars", "calendar_exceptions"):
            continue  # workspace library: readable by every authenticated user
        resp = agent.get(url)
        if resp.status_code == 200:
            assert _rows(resp) == [], f"{key} leaked rows to a non-member: {resp.data}"
        else:
            assert resp.status_code in (403, 404), f"{key}: {resp.status_code}"


# --- (d) the team opt-out (ADR-0678) applies identically ----------------------------------


def _opt_out(project: Project) -> None:
    project.mcp_enabled = False
    project.save(update_fields=["mcp_enabled"])


def test_opted_out_project_is_closed_to_the_agent_on_every_project_scoped_view(
    project: Project, world: dict[str, Any], owner: Any
) -> None:
    _opt_out(project)
    agent = _agent(owner)
    urls = _urls(project, world)
    assert agent.get(urls["history"]).status_code == 403  # PATH scope: refused outright
    # Project-nested views declare PATH scope, so the opt-out is a 403, not an empty 200.
    for key in ("baselines", "phases", "fields"):
        assert agent.get(urls[key]).status_code == 403, key
    for key in ("dependencies", "criteria"):
        resp = agent.get(urls[key])
        # QUERYSET scope (no project in the URL): the row filter empties the collection.
        assert resp.status_code in (200, 403, 404), f"{key}: {resp.status_code}"
        if resp.status_code == 200:
            assert _rows(resp) == [], f"{key} leaked an opted-out project: {resp.data}"
    # Detail routes of an opted-out object 404 rather than leak.
    assert agent.get(
        f"/api/v1/projects/{project.pk}/baselines/{world['baseline'].pk}/"
    ).status_code in (
        403,
        404,
    )
    assert agent.get(f"/api/v1/dependencies/{world['dep'].pk}/").status_code == 404
    assert agent.get(f"/api/v1/acceptance-criteria/{world['criterion'].pk}/").status_code == 404


def test_opted_out_project_is_unchanged_for_the_human_owner(
    project: Project, world: dict[str, Any], owner: Any
) -> None:
    _opt_out(project)
    human = _human(owner)
    urls = _urls(project, world)
    for key in ("history", "dependencies", "baselines", "phases", "fields", "criteria"):
        assert human.get(urls[key]).status_code == 200, key


def test_calendar_library_is_not_closed_by_a_project_opting_out(
    project: Project, world: dict[str, Any], owner: Any
) -> None:
    """NO_PROJECT_DATA: the library has no project row, so an opt-out elsewhere must
    neither hide it (fail-closed ``none()``) nor be required to read it."""
    _opt_out(project)
    resp = _agent(owner).get("/api/v1/calendars/")
    assert resp.status_code == 200
    assert _rows(resp)


def test_cross_project_dependency_honors_an_opt_out_on_either_end(
    calendar: Calendar, project: Project, owner: Any
) -> None:
    """``get_queryset`` widens membership to both ends of a cross-project edge, so the
    opt-out must too: a successor in an opted-out project must not be served via the
    visible predecessor's project."""
    other = _project("OptedOutSuccessor", calendar, owner)
    pred = Task.objects.create(project=project, name="Pred", duration=1)
    succ = Task.objects.create(project=other, name="Succ", duration=1)
    dep = Dependency.objects.create(predecessor=pred, successor=succ, dep_type="FS")
    agent = _agent(owner)

    before = _rows(agent.get(f"/api/v1/dependencies/?project={project.pk}"))
    assert str(dep.pk) in {str(r["id"]) for r in before}

    _opt_out(other)
    after = _rows(agent.get(f"/api/v1/dependencies/?project={project.pk}"))
    assert str(dep.pk) not in {str(r["id"]) for r in after}
    assert agent.get(f"/api/v1/dependencies/{dep.pk}/").status_code == 404
    # A human owner still sees the edge.
    assert _human(owner).get(f"/api/v1/dependencies/{dep.pk}/").status_code == 200


def test_dependencies_project_filter_returns_outgoing_edges_only(
    calendar: Calendar, project: Project, owner: Any
) -> None:
    """Pins CURRENT behavior: ``?project=`` matches the predecessor's project only, so an
    incoming cross-project edge (successor here, predecessor elsewhere) is not returned.
    The tool docs say "outgoing"; widening the filter is #5051 — flip this assertion then."""
    other = _project("IncomingPredecessor", calendar, owner)
    pred = Task.objects.create(project=other, name="Pred", duration=1)
    succ = Task.objects.create(project=project, name="Succ", duration=1)
    dep = Dependency.objects.create(predecessor=pred, successor=succ, dep_type="FS")
    rows = _rows(_agent(owner).get(f"/api/v1/dependencies/?project={project.pk}"))
    assert str(dep.pk) not in {str(r["id"]) for r in rows}
    # It is returned from the predecessor's side.
    rows = _rows(_agent(owner).get(f"/api/v1/dependencies/?project={other.pk}"))
    assert str(dep.pk) in {str(r["id"]) for r in rows}


@pytest.mark.parametrize("scope_kind", ["project", "program"])
@pytest.mark.parametrize(
    ("url", "expected"),
    [
        # Measured: calendars' own RBAC list (admin-only writes) refuses an ownerless
        # token 403 before the appended guards run; dependencies reaches TokenIsOwnerScoped
        # and answers 401. Either way the write is refused.
        ("/api/v1/calendars/", 403),
        ("/api/v1/dependencies/", 401),
    ],
)
def test_project_or_program_scoped_token_cannot_post_calendars_or_dependencies(
    project: Project, owner: Any, url: str, expected: int, scope_kind: str
) -> None:
    """A project/program-scoped token cannot write the newly MCP-readable views."""
    from trueppm_api.apps.projects.models import Program

    kwargs: dict[str, Any] = {}
    if scope_kind == "project":
        kwargs["project"] = project
    else:
        kwargs["program"] = Program.objects.create(name="ScopedProg")
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    ApiToken.objects.create(
        name="scoped",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=owner,
        **kwargs,  # exactly one of project/program; owner stays null (api_token_scope_xor)
    )
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    assert client.post(url, {"name": "x"}, format="json").status_code == expected


def test_changelog_stays_outside_the_mcp_surface(project: Project, owner: Any) -> None:
    """The aggregated changelog was deliberately NOT opened (#5006): it carries
    per-person task/sprint rows. Pin the decision so widening it is an explicit act."""
    resp = _agent(owner).get(f"/api/v1/projects/{project.pk}/changelog/")
    assert resp.status_code in (401, 403)
