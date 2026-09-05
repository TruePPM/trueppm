"""The live-``ProjectMembership`` floor under the facet axis (#3386).

The ADR-0078 §F mirror (``ensure_team_membership``) is **create-only** — there is no
``post_delete`` receiver and no FK a cascade could travel over — so soft-deleting a
``ProjectMembership`` leaves the mirrored ``TeamMembership`` alive with its facet flags
intact. Every gate below short-circuits to the facet on the branch where the role lookup
returned ``None``, which is exactly what a revoked membership produces: without a floor,
revoking someone's project access *promotes* their residual facet from a tiebreak into
their only credential.

These tests call the gates **directly**, not through their viewsets. That is deliberate
and is the acceptance criterion of #3386: every HTTP path to these gates is backstopped
today by a member-scoped queryset that 404s first, so a viewset-level test would pass on
the unfixed code and prove nothing about the gate itself. The gates' docstrings promise
the boundary holds "even if a view forgets this class" and that both axes resolve to "a
real, explicitly-assigned membership row" — these tests are what makes those sentences
true rather than aspirational.

**Five** consumers, not the four the issue enumerated: `_is_facilitator_or_admin`
(signal privacy) reads the same seam and is tightened by the same change. The issue set
it aside because its permission class 403s first — which is the same "backstopped, so it
doesn't count" reasoning the issue rejects for the other four, so it is swept here too.

Each gate is asserted twice: refused for the revoked holder, and still granted for the
live holder. The positive half is the control — a floor that denied everyone would pass
the negative half alone. The structural-backlog gate is additionally swept across the
whole role ladder, because it has a second arm the facet floor does not reach.
"""

from __future__ import annotations

import ast
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.exceptions import PermissionDenied

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.permissions import (
    can_manage_backlog_with_facet,
    can_manage_scope_with_facet,
    can_user_edit_task,
)
from trueppm_api.apps.projects.models import Project, Task, TaskType
from trueppm_api.apps.projects.serializers import ProjectDetailSerializer, TaskSerializer
from trueppm_api.apps.projects.services import ScopeAcceptForbidden, assert_scope_gate_for_project
from trueppm_api.apps.projects.signal_privacy_views import _is_facilitator_or_admin
from trueppm_api.apps.teams.models import Team, TeamMembership, TeamRole
from trueppm_api.apps.teams.services import has_team_facet, user_facets

User = get_user_model()
pytestmark = pytest.mark.django_db


@pytest.fixture
def project(db: object) -> Project:
    return Project.objects.create(name="Floor", start_date=date(2026, 1, 1))


@pytest.fixture
def default_team(project: Project) -> Team:
    return Team.objects.create(
        project=project, name="Default Team", short_id="T01", is_default=True, server_version=1
    )


def _live_holder(
    project: Project,
    team: Team,
    username: str,
    *,
    is_scrum_master: bool = False,
    is_product_owner: bool = False,
    role: int = Role.MEMBER,
) -> Any:
    """A project member who holds a facet and still has live project access.

    ``role`` is parametrized rather than fixed at MEMBER because a revoked *Admin* is
    the combination that hides a defect: their role arm alone satisfies the coarse
    role gates, so a facet-only test at MEMBER passes for the wrong reason.
    """
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    TeamMembership.objects.create(
        team=team,
        user=user,
        role=TeamRole.MEMBER,
        is_scrum_master=is_scrum_master,
        is_product_owner=is_product_owner,
    )
    return user


def _revoked_holder(
    project: Project,
    team: Team,
    username: str,
    *,
    is_scrum_master: bool = False,
    is_product_owner: bool = False,
    role: int = Role.MEMBER,
) -> Any:
    """A facet holder whose ``ProjectMembership`` has been revoked.

    Reproduces the exact production state the create-only mirror leaves behind: the
    ``ProjectMembership`` is soft-deleted, the ``TeamMembership`` is untouched. Building
    it as a soft delete of a row that really existed — rather than simply omitting the
    membership — matters, because the omitted-row shape is also what an org/PMO
    principal looks like, and the two are different defects.

    Revocation lives in its own named constructor rather than behind a ``revoked=False``
    default because a forgotten keyword there silently produces a *live* member and the
    whole suite passes on unfixed code — which is exactly what happened while writing it.
    The post-condition below is the second guard on the same mistake.
    """
    user = _live_holder(
        project,
        team,
        username,
        is_scrum_master=is_scrum_master,
        is_product_owner=is_product_owner,
        role=role,
    )
    membership = ProjectMembership.objects.get(project=project, user=user)
    membership.is_deleted = True
    membership.save(update_fields=["is_deleted"])

    assert not ProjectMembership.objects.filter(
        project=project, user=user, is_deleted=False
    ).exists(), "fixture did not actually revoke project access"
    assert TeamMembership.objects.filter(team=team, user=user, is_deleted=False).exists(), (
        "the mirrored team row must survive the revocation — that is the defect"
    )
    return user


class _Req:
    """Minimal request stand-in — the gates read only ``.user``."""

    def __init__(self, user: Any) -> None:
        self.user = user


# ---------------------------------------------------------------------------
# The seam itself
# ---------------------------------------------------------------------------


def test_revoked_member_resolves_no_facets(project: Project, default_team: Team) -> None:
    """The residual team row is live and flagged, yet the seam reports no facets."""
    revoked = _revoked_holder(
        project, default_team, "revoked", is_scrum_master=True, is_product_owner=True
    )

    # Precondition: the mirror really did leave the flagged row behind. Without this
    # the test could pass because the fixture never created a facet at all.
    assert TeamMembership.objects.filter(
        team=default_team, user=revoked, is_deleted=False, is_product_owner=True
    ).exists()

    assert user_facets(revoked, project.pk) == {"is_scrum_master": False, "is_product_owner": False}
    assert has_team_facet(revoked, project.pk, "is_product_owner") is False
    assert has_team_facet(revoked, project.pk, "is_scrum_master") is False


def test_live_member_still_resolves_the_facet(project: Project, default_team: Team) -> None:
    """The control: the floor must not deny the people the facet exists for."""
    live = _live_holder(project, default_team, "live", is_product_owner=True)

    assert user_facets(live, project.pk) == {"is_scrum_master": False, "is_product_owner": True}
    assert has_team_facet(live, project.pk, "is_product_owner") is True


def test_floor_opt_out_returns_the_raw_team_answer(project: Project, default_team: Team) -> None:
    """``live_project_members_only=False`` asks the un-floored question, for callers
    that have already read live membership and intersect themselves."""
    revoked = _revoked_holder(project, default_team, "raw", is_product_owner=True)

    assert user_facets(revoked, project.pk, live_project_members_only=False) == {
        "is_scrum_master": False,
        "is_product_owner": True,
    }
    assert (
        has_team_facet(revoked, project.pk, "is_product_owner", live_project_members_only=False)
        is True
    )


def test_floor_is_correlated_to_the_right_project(project: Project, default_team: Team) -> None:
    """Live membership on *another* project must not satisfy the floor here.

    This is the assertion that makes ``_live_project_membership_exists``'s
    ``project_id=OuterRef("team__project_id")`` load-bearing. Every other test in this
    module builds a single project, so the revoked user has no live membership
    anywhere — delete the project correlation entirely and they all still pass, because
    an *uncorrelated* subquery is equally empty. Only a user who is live somewhere else
    can tell a correctly-scoped floor from a merely-nonempty one.
    """
    revoked_here = _revoked_holder(project, default_team, "elsewhere", is_product_owner=True)
    other = Project.objects.create(name="Other", start_date=date(2026, 1, 1))
    ProjectMembership.objects.create(project=other, user=revoked_here, role=Role.ADMIN)

    assert user_facets(revoked_here, project.pk)["is_product_owner"] is False
    assert can_manage_backlog_with_facet(revoked_here, project.pk, None) is False


def test_floor_does_not_resurrect_a_soft_deleted_team_row(
    project: Project, default_team: Team
) -> None:
    """The inverse state: live project membership, dead team row → still no facets.

    ``facet_holder_user_ids`` has covered this for the set shape since it was written;
    ``user_facets`` had no equivalent. The two seams drifting is the #2897 defect, and
    asymmetric *test* coverage is how that drift goes unnoticed.
    """
    user = User.objects.create_user(username="dead-team-row", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    TeamMembership.objects.create(
        team=default_team, user=user, is_product_owner=True, is_deleted=True
    )

    assert user_facets(user, project.pk) == {"is_scrum_master": False, "is_product_owner": False}


def test_facet_on_a_non_default_team_is_not_read(project: Project, default_team: Team) -> None:
    """A second team's Product Owner holds no facet on the project's default team."""
    user = User.objects.create_user(username="off-team-live", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    other_team = Team.objects.create(
        project=project, name="Squad B", short_id="T02", is_default=False, server_version=1
    )
    TeamMembership.objects.create(team=other_team, user=user, is_product_owner=True)

    assert user_facets(user, project.pk) == {"is_scrum_master": False, "is_product_owner": False}


def test_live_member_with_no_team_row_resolves_no_facets(
    project: Project, default_team: Team
) -> None:
    """Passing the floor is not the same as holding a facet — this is the state that
    distinguishes "floor blocked" from "no facet row", which every all-False assertion
    in this module otherwise conflates."""
    user = User.objects.create_user(username="no-team-row", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)

    assert user_facets(user, project.pk) == {"is_scrum_master": False, "is_product_owner": False}


def test_no_facets_result_is_not_the_shared_constant(project: Project) -> None:
    """Each all-False answer is a fresh dict.

    ``_NO_FACETS`` is a module-level mutable; returning it directly would let any
    caller that mutates its result corrupt the constant for the life of the process.
    Nothing else would catch that.
    """
    first = user_facets(User.objects.create_user(username="fresh", password="pw"), project.pk)
    first["is_product_owner"] = True
    second = user_facets(User.objects.create_user(username="fresh2", password="pw"), project.pk)

    assert second == {"is_scrum_master": False, "is_product_owner": False}


def test_floor_costs_no_extra_query(
    project: Project, default_team: Team, django_assert_num_queries: Any
) -> None:
    """One query, floored or not: the liveness check is a correlated ``Exists``
    composed into the same statement, not a second round trip. ``_is_product_owner``
    request-caches this call, but ``get_my_facets`` and the service-layer gates do not,
    so a second query here would land on every scope accept and every project detail."""
    live = _live_holder(project, default_team, "cheap", is_product_owner=True)
    with django_assert_num_queries(1):
        user_facets(live, project.pk)


# ---------------------------------------------------------------------------
# The five write gates, called directly
# ---------------------------------------------------------------------------


def test_backlog_gate_refuses_revoked_product_owner(project: Project, default_team: Team) -> None:
    revoked = _revoked_holder(project, default_team, "po-revoked", is_product_owner=True)
    live = _live_holder(project, default_team, "po-live", is_product_owner=True)

    # role=None is what the caller passes for a revoked member: `_membership_role`
    # filters `is_deleted=False`, so the role arm has already found nothing and the
    # facet arm is the only thing left standing.
    assert can_manage_backlog_with_facet(revoked, project.pk, None) is False
    assert can_manage_backlog_with_facet(live, project.pk, Role.MEMBER) is True


@pytest.mark.parametrize("facet", ["is_scrum_master", "is_product_owner"])
def test_scope_gate_refuses_revoked_ceremony_facet(
    project: Project, default_team: Team, facet: str
) -> None:
    revoked = _revoked_holder(project, default_team, f"{facet}-revoked", **{facet: True})
    live = _live_holder(project, default_team, f"{facet}-live", **{facet: True})

    assert can_manage_scope_with_facet(revoked, project.pk, None) is False
    assert can_manage_scope_with_facet(live, project.pk, Role.MEMBER) is True


@pytest.mark.parametrize("facet", ["is_scrum_master", "is_product_owner"])
def test_service_scope_gate_refuses_revoked_ceremony_facet(
    project: Project, default_team: Team, facet: str
) -> None:
    """``assert_scope_gate_for_project`` reads membership itself, so this is the gate
    the ``IsProjectScopeManager`` docstring promises holds "even if a view forgets"."""
    revoked = _revoked_holder(project, default_team, f"svc-{facet}-revoked", **{facet: True})
    live = _live_holder(project, default_team, f"svc-{facet}-live", **{facet: True})

    with pytest.raises(ScopeAcceptForbidden):
        assert_scope_gate_for_project(project.pk, revoked)

    assert_scope_gate_for_project(project.pk, live)  # does not raise


def _run_structural_gate(project: Project, task: Task, who: Any) -> None:
    """Invoke ``TaskSerializer._enforce_backlog_structural_gate`` for ``who``.

    A scoring input is a structural field per ADR-0105 §6, so the gate engages.
    """
    serializer = TaskSerializer(instance=task, context={"request": _Req(who)})
    serializer._enforce_backlog_structural_gate({"business_value": 5})


@pytest.mark.parametrize("role", [Role.VIEWER, Role.MEMBER, Role.SCHEDULER, Role.ADMIN, Role.OWNER])
def test_backlog_structural_gate_refuses_every_revoked_role(
    project: Project, default_team: Team, role: int
) -> None:
    """``TaskSerializer._enforce_backlog_structural_gate`` — the serializer-side half
    of the backlog gate, reached inside ``validate`` on the ``tasks`` write path.

    Swept across the whole role ladder because this gate has **two** arms and the
    facet floor only closes one. `allowed = can_manage_backlog(role) or has_facet(...)`
    — so at MEMBER the role arm refuses on its own and a facet-only test passes for
    the wrong reason, while at ADMIN the role arm short-circuits to True and the facet
    floor is never consulted. That second case is what `_get_caller_role` filtering
    `is_deleted` is for; without it this parametrization goes red at ADMIN and OWNER.
    """
    revoked = _revoked_holder(
        project, default_team, f"ser-revoked-{role}", is_product_owner=True, role=role
    )
    task = Task.objects.create(project=project, name="Story", type=TaskType.STORY, duration=1)

    with pytest.raises(PermissionDenied):
        _run_structural_gate(project, task, revoked)


@pytest.mark.parametrize("role", [Role.MEMBER, Role.ADMIN])
def test_backlog_structural_gate_still_admits_live_holders(
    project: Project, default_team: Team, role: int
) -> None:
    """The control for both arms: a live PO passes on the facet, a live Admin on the role."""
    live = _live_holder(project, default_team, f"ser-live-{role}", is_product_owner=True, role=role)
    task = Task.objects.create(project=project, name="Story", type=TaskType.STORY, duration=1)

    _run_structural_gate(project, task, live)  # does not raise


def test_signal_privacy_facilitator_gate_refuses_revoked_scrum_master(
    project: Project, default_team: Team
) -> None:
    """The fifth consumer: ``_is_facilitator_or_admin`` (signal-privacy propose /
    set-audience / cancel).

    Listed separately from the four in the issue because it is the one whose
    permission class (``IsProjectMember`` on ``_SignalPrivacyBase``) 403s a revoked
    member before the gate is consulted — so it was never reachable. It reads the same
    seam and is tightened by the same change, and an untested "it's fine" is how the
    other four came to be documented as standing alone when they did not.
    """
    revoked = _revoked_holder(project, default_team, "sm-revoked-sig", is_scrum_master=True)
    live = _live_holder(project, default_team, "sm-live-sig", is_scrum_master=True)

    assert _is_facilitator_or_admin(_Req(revoked), project.pk) is False
    assert _is_facilitator_or_admin(_Req(live), project.pk) is True


def test_scheduler_gate_membership_excludes_a_revoked_scheduler(project: Project) -> None:
    """``SprintSerializer._resolve_scheduler_gate_membership`` — the *role* axis again.

    Swept here rather than left for later because it is the same one-line defect as
    ``_get_caller_role``, in the same file, backing another write gate: the caller at
    ``_validate_scheduler_owned_fields`` treats a returned row as proof of Scheduler+
    access, so a residual soft-deleted row was proof of nothing.
    """
    from trueppm_api.apps.projects.serializers import SprintSerializer

    user = User.objects.create_user(username="sched-revoked", password="pw")
    membership = ProjectMembership.objects.create(project=project, user=user, role=Role.SCHEDULER)

    view = SimpleNamespace(kwargs={"project_pk": project.pk})
    serializer = SprintSerializer(context={"request": _Req(user), "view": view})
    assert serializer._resolve_scheduler_gate_membership(user) is not None  # control

    membership.is_deleted = True
    membership.save(update_fields=["is_deleted"])

    assert serializer._resolve_scheduler_gate_membership(user) is None


# ---------------------------------------------------------------------------
# The read surfaces that must agree with the gates
# ---------------------------------------------------------------------------


def test_can_user_edit_task_refuses_revoked_product_owner(
    project: Project, default_team: Team
) -> None:
    """``can_user_edit_task`` is ADR-0133's "one rule, called twice" — it must refuse
    the revoked PO on the branch the PO facet would otherwise widen."""
    revoked = _revoked_holder(project, default_team, "edit-revoked", is_product_owner=True)
    live = _live_holder(project, default_team, "edit-live", is_product_owner=True)
    story = Task.objects.create(project=project, name="S", type=TaskType.STORY, duration=1)

    assert can_user_edit_task(_Req(revoked), story) is False
    assert can_user_edit_task(_Req(live), story) is True


def test_my_facets_field_matches_the_gates(project: Project, default_team: Team) -> None:
    """``ProjectDetailSerializer.my_facets`` render-gates the PO/SM controls in the web.

    It must report what the write gates will actually allow — otherwise the client
    offers an affordance the server refuses, which is the drift ADR-0133 exists to
    prevent. Unreachable in practice (a revoked member cannot fetch project detail),
    but the field and the gate now read one seam, and this pins that.
    """
    revoked = _revoked_holder(project, default_team, "facets-revoked", is_product_owner=True)
    live = _live_holder(project, default_team, "facets-live", is_product_owner=True)

    def _my_facets(who: Any) -> dict[str, bool]:
        return ProjectDetailSerializer(context={"request": _Req(who)}).get_my_facets(project)

    assert _my_facets(revoked) == {"is_scrum_master": False, "is_product_owner": False}
    assert _my_facets(live) == {"is_scrum_master": False, "is_product_owner": True}


def test_no_production_caller_opts_out_of_the_floor() -> None:
    """No shipped code may *call* a facet resolver with the liveness floor disabled.

    The rule "never from an authorization gate" lives in a docstring, and
    ``has_team_facet`` forwards the flag verbatim — so a gate could opt out in one
    keyword, at a call site that reads as an ordinary facet check and that no
    behavioral test would catch. This is the only thing standing between that
    docstring and a silent regression.

    Matched by **AST**, on an actual keyword argument whose value is literal ``False``
    — not by grepping lines. The tree legitimately discusses this flag in prose:
    ``config_notice`` explains in a docstring why its cohort passes ``False``, and the
    resolvers' own docstrings name it. A line grep would fail on that prose, which is
    the trap CLAUDE.md already records for ``enterprise-boundary-check`` ("a plain grep
    is not the check; the tree carries prose that names the thing"). It would also make
    this test and #3334 unmergeable in either order while each stayed green alone.
    """
    src = Path(__file__).resolve().parents[3] / "src" / "trueppm_api"
    offenders: list[str] = []
    for path in src.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if not isinstance(node, ast.Call):
                continue
            for kw in node.keywords:
                if (
                    kw.arg == "live_project_members_only"
                    and isinstance(kw.value, ast.Constant)
                    and kw.value.value is False
                ):
                    offenders.append(f"{path.relative_to(src)}:{kw.value.lineno}")

    # `config_notice.surface_recipient_ids` is the one legitimate opt-out: it has
    # already read live membership and intersects in Python, so the subquery would be
    # redundant work rather than extra safety. It arrives with #3334; allow it by name
    # rather than by relaxing the rule, so any *other* opt-out still fails here.
    allowed = {"apps/projects/config_notice.py"}
    unexpected = [o for o in offenders if o.rsplit(":", 1)[0] not in allowed]
    assert unexpected == [], f"authorization seam opted out of the liveness floor: {unexpected}"
