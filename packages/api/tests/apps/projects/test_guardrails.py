"""Tests for Sprint/Phase/WBS guardrails (ADR-0101).

Covers the pure evaluator, the warn path (warnings on a successful PATCH), the
block path (Owner-escalated composition rule -> guardrail_blocked), the
sprint-sovereignty gate on the policy endpoint (only Owner may escalate a
composition rule to block; an unacknowledged EXTERNAL block is inert), and the
generalized SprintScopeChange payload (goal_impact + item_name).
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    GuardrailLevel,
    GuardrailPolicySource,
    Project,
    ProjectGuardrailPolicy,
    Sprint,
    SprintScopeChange,
    SprintState,
    Task,
)
from trueppm_api.apps.projects.serializers import evaluate_sprint_guardrails

User = get_user_model()


# --------------------------------------------------------------------------- #
# Pure evaluator — no DB, runs identically to the offline client.
# --------------------------------------------------------------------------- #


def test_evaluator_clean_leaf_in_window() -> None:
    assert (
        evaluate_sprint_guardrails(
            has_children=False,
            is_phase=False,
            is_recurring=False,
            task_start=date(2026, 1, 6),
            task_finish=date(2026, 1, 10),
            sprint_start=date(2026, 1, 5),
            sprint_finish=date(2026, 1, 16),
        )
        == []
    )


def test_evaluator_summary_in_sprint() -> None:
    assert evaluate_sprint_guardrails(
        has_children=True,
        is_phase=False,
        is_recurring=False,
        task_start=None,
        task_finish=None,
        sprint_start=None,
        sprint_finish=None,
    ) == ["summary_in_sprint"]


def test_evaluator_phase_supersedes_summary() -> None:
    # A phase is also a summary (it has children); we report only the more
    # specific phase_in_sprint so the user sees one precise notice.
    assert evaluate_sprint_guardrails(
        has_children=True,
        is_phase=True,
        is_recurring=False,
        task_start=None,
        task_finish=None,
        sprint_start=None,
        sprint_finish=None,
    ) == ["phase_in_sprint"]


def test_evaluator_recurring_and_outside_window() -> None:
    rules = evaluate_sprint_guardrails(
        has_children=False,
        is_phase=False,
        is_recurring=True,
        task_start=date(2026, 3, 1),
        task_finish=date(2026, 3, 5),
        sprint_start=date(2026, 1, 5),
        sprint_finish=date(2026, 1, 16),
    )
    assert "recurring_in_sprint" in rules
    assert "task_outside_sprint_window" in rules


def test_evaluator_window_needs_all_four_dates() -> None:
    # Missing a date means the window rule cannot fire.
    assert (
        evaluate_sprint_guardrails(
            has_children=False,
            is_phase=False,
            is_recurring=False,
            task_start=None,
            task_finish=date(2026, 3, 5),
            sprint_start=date(2026, 1, 5),
            sprint_finish=date(2026, 1, 16),
        )
        == []
    )


# --------------------------------------------------------------------------- #
# Fixtures for the API-level tests.
# --------------------------------------------------------------------------- #


@pytest.fixture
def owner(db: object) -> object:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def scheduler_user(db: object) -> object:
    return User.objects.create_user(username="sched", password="pw")


@pytest.fixture
def project(owner: object) -> Project:
    p = Project.objects.create(name="P", start_date=date(2026, 1, 1))
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    return p


@pytest.fixture
def owner_client(owner: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=owner)
    return c


@pytest.fixture
def scheduler_client(project: Project, scheduler_user: object) -> APIClient:
    ProjectMembership.objects.create(project=project, user=scheduler_user, role=Role.SCHEDULER)
    c = APIClient()
    c.force_authenticate(user=scheduler_user)
    return c


@pytest.fixture
def member_client(project: Project) -> APIClient:
    """A non-owner Team Member (role=MEMBER) — may make WARN-tier policy edits."""
    member = User.objects.create_user(username="member", password="pw")
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=member)
    return c


@pytest.fixture
def viewer_client(project: Project) -> APIClient:
    """A read-only Viewer (role=VIEWER) — may GET but must not PATCH the policy."""
    viewer = User.objects.create_user(username="viewer", password="pw")
    ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)
    c = APIClient()
    c.force_authenticate(user=viewer)
    return c


@pytest.fixture
def sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="Sprint 1",
        start_date=date(2026, 1, 5),
        finish_date=date(2026, 1, 16),
        state=SprintState.ACTIVE,
    )


@pytest.fixture
def summary_with_child(project: Project) -> Task:
    """A WBS L1 root ('1') with a child ('1.1') — the root is a summary phase."""
    parent = Task.objects.create(project=project, name="Phase 1", wbs_path="1", duration=1)
    Task.objects.create(project=project, name="Child", wbs_path="1.1", duration=1)
    return parent


# --------------------------------------------------------------------------- #
# Warn path — assignment succeeds with a `warnings` payload.
# --------------------------------------------------------------------------- #


def test_phase_to_sprint_warns_but_succeeds(
    owner_client: APIClient, project: Project, sprint: Sprint, summary_with_child: Task
) -> None:
    resp = owner_client.patch(
        f"/api/v1/tasks/{summary_with_child.id}/",
        {"sprint": str(sprint.id)},
        format="json",
    )
    assert resp.status_code == 200
    summary_with_child.refresh_from_db()
    assert str(summary_with_child.sprint_id) == str(sprint.id)
    rules = {w["rule"] for w in resp.data.get("warnings", [])}
    assert "phase_in_sprint" in rules
    # Outcome-language copy, no WBS jargon.
    detail = next(w["detail"] for w in resp.data["warnings"] if w["rule"] == "phase_in_sprint")
    assert "velocity" in detail or "Phases group work" in detail


def test_clean_leaf_to_sprint_no_warnings(
    owner_client: APIClient, project: Project, sprint: Sprint
) -> None:
    # A non-root leaf ("2.1") — single-digit paths are phases and would trip
    # phase_in_sprint, which is exactly what this clean-path test must avoid.
    Task.objects.create(project=project, name="Phase 2", wbs_path="2", duration=1)
    leaf = Task.objects.create(
        project=project,
        name="Leaf",
        wbs_path="2.1",
        duration=1,
        planned_start=date(2026, 1, 6),
        early_finish=date(2026, 1, 8),
    )
    resp = owner_client.patch(
        f"/api/v1/tasks/{leaf.id}/", {"sprint": str(sprint.id)}, format="json"
    )
    assert resp.status_code == 200
    assert resp.data.get("warnings", []) == []


# --------------------------------------------------------------------------- #
# Block path — Owner escalates, assignment is rejected with guardrail_blocked.
# --------------------------------------------------------------------------- #


def test_owner_escalated_block_rejects(
    owner_client: APIClient, project: Project, sprint: Sprint, summary_with_child: Task
) -> None:
    ProjectGuardrailPolicy.objects.create(
        project=project,
        levels={"phase_in_sprint": GuardrailLevel.BLOCK},
        source=GuardrailPolicySource.OWNER,
    )
    resp = owner_client.patch(
        f"/api/v1/tasks/{summary_with_child.id}/",
        {"sprint": str(sprint.id)},
        format="json",
    )
    assert resp.status_code == 400
    assert resp.data["code"] == "guardrail_blocked"
    assert resp.data["rule"] == "phase_in_sprint"
    summary_with_child.refresh_from_db()
    assert summary_with_child.sprint_id is None


def test_unacknowledged_external_block_is_inert(
    owner_client: APIClient, project: Project, sprint: Sprint, summary_with_child: Task
) -> None:
    # EXTERNAL composition block, not yet acknowledged -> downgraded to warn.
    ProjectGuardrailPolicy.objects.create(
        project=project,
        levels={"phase_in_sprint": GuardrailLevel.BLOCK},
        source=GuardrailPolicySource.EXTERNAL,
        source_label="Org Policy",
        acknowledged_by_team=False,
    )
    resp = owner_client.patch(
        f"/api/v1/tasks/{summary_with_child.id}/",
        {"sprint": str(sprint.id)},
        format="json",
    )
    # Inert block -> assignment succeeds, surfaced only as a warning.
    assert resp.status_code == 200
    summary_with_child.refresh_from_db()
    assert str(summary_with_child.sprint_id) == str(sprint.id)


# --------------------------------------------------------------------------- #
# Policy endpoint — sprint-sovereignty gate.
# --------------------------------------------------------------------------- #


def test_get_policy_lazy_creates_all_warn(owner_client: APIClient, project: Project) -> None:
    resp = owner_client.get(f"/api/v1/projects/{project.id}/guardrail-policy/")
    assert resp.status_code == 200
    assert resp.data["effective_levels"]["phase_in_sprint"] == "warn"


def test_owner_can_escalate_composition_block(owner_client: APIClient, project: Project) -> None:
    resp = owner_client.patch(
        f"/api/v1/projects/{project.id}/guardrail-policy/",
        {"levels": {"phase_in_sprint": "block"}},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data["effective_levels"]["phase_in_sprint"] == "block"


def test_scheduler_cannot_escalate_composition_block(
    scheduler_client: APIClient, project: Project
) -> None:
    resp = scheduler_client.patch(
        f"/api/v1/projects/{project.id}/guardrail-policy/",
        {"levels": {"phase_in_sprint": "block"}},
        format="json",
    )
    assert resp.status_code == 403


def test_viewer_cannot_patch_policy(viewer_client: APIClient, project: Project) -> None:
    # Regression for #1549: a Viewer must not be able to weaken a guardrail by
    # downgrading an existing BLOCK to WARN via PATCH — write requires Member+.
    ProjectGuardrailPolicy.objects.create(
        project=project,
        levels={"phase_in_sprint": GuardrailLevel.BLOCK},
        source=GuardrailPolicySource.OWNER,
    )
    resp = viewer_client.patch(
        f"/api/v1/projects/{project.id}/guardrail-policy/",
        {"levels": {"phase_in_sprint": "warn"}},
        format="json",
    )
    assert resp.status_code == 403
    # The BLOCK is untouched.
    policy = ProjectGuardrailPolicy.objects.get(project=project)
    assert policy.levels["phase_in_sprint"] == GuardrailLevel.BLOCK


def test_viewer_can_still_get_policy(viewer_client: APIClient, project: Project) -> None:
    # GET stays Viewer+ after the #1549 write-gate split.
    resp = viewer_client.get(f"/api/v1/projects/{project.id}/guardrail-policy/")
    assert resp.status_code == 200
    assert resp.data["effective_levels"]["phase_in_sprint"] == "warn"


def test_member_can_make_warn_tier_change(member_client: APIClient, project: Project) -> None:
    # A non-owner Team Member may make a WARN-tier edit (does not escalate a
    # composition rule to BLOCK), so the sovereignty gate does not fire.
    ProjectGuardrailPolicy.objects.create(
        project=project,
        levels={"phase_in_sprint": GuardrailLevel.WARN},
        source=GuardrailPolicySource.OWNER,
    )
    resp = member_client.patch(
        f"/api/v1/projects/{project.id}/guardrail-policy/",
        {"acknowledged_by_team": True},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data["acknowledged_by_team"] is True


def test_member_cannot_escalate_composition_block(
    member_client: APIClient, project: Project
) -> None:
    # The sovereignty gate still holds for Member+: only Owner may escalate a
    # composition rule to BLOCK.
    resp = member_client.patch(
        f"/api/v1/projects/{project.id}/guardrail-policy/",
        {"levels": {"phase_in_sprint": "block"}},
        format="json",
    )
    assert resp.status_code == 403


def test_owner_can_deescalate_composition_block(owner_client: APIClient, project: Project) -> None:
    # Owner may de-escalate an existing BLOCK back to WARN.
    ProjectGuardrailPolicy.objects.create(
        project=project,
        levels={"phase_in_sprint": GuardrailLevel.BLOCK},
        source=GuardrailPolicySource.OWNER,
    )
    resp = owner_client.patch(
        f"/api/v1/projects/{project.id}/guardrail-policy/",
        {"levels": {"phase_in_sprint": "warn"}},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data["effective_levels"]["phase_in_sprint"] == "warn"


def test_unknown_rule_rejected(owner_client: APIClient, project: Project) -> None:
    resp = owner_client.patch(
        f"/api/v1/projects/{project.id}/guardrail-policy/",
        {"levels": {"not_a_rule": "block"}},
        format="json",
    )
    assert resp.status_code == 400


# --------------------------------------------------------------------------- #
# Generalized SprintScopeChange payload.
# --------------------------------------------------------------------------- #


def test_scope_change_payload_has_goal_impact_and_item_name(
    project: Project, sprint: Sprint
) -> None:
    # Exercise the serializer method directly: it is the unit under test (the
    # goal_impact + item_name additions), independent of which serializer the
    # retrieve route binds.
    from trueppm_api.apps.projects.serializers import TaskSerializer

    task = Task.objects.create(
        project=project, name="Parent", wbs_path="3", duration=1, sprint=sprint
    )
    SprintScopeChange.objects.create(
        task=task, sprint=sprint, subtask_name="Late add", goal_impact=True
    )
    changes = TaskSerializer().get_sprint_scope_changes(task)
    assert len(changes) == 1
    assert changes[0]["item_name"] == "Late add"
    assert changes[0]["subtask_name"] == "Late add"  # deprecated alias retained
    assert changes[0]["goal_impact"] is True
