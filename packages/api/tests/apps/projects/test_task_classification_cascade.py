"""Subtree classification cascade — PATCH /projects/{pk}/tasks/classification/.

#2735, ADR-0790. The endpoint applies two *orthogonal* axes across a subtree, and
almost every test here exists because collapsing them, or letting one of them reach a
milestone, is the failure mode:

* ``governance_class`` carries an inherit bit, so an explicit override is a real thing
  and ``overrides_kept`` is a real count;
* ``delivery_mode`` carries none, so ``overrides_kept`` must be ``null`` there — not
  ``0``, which would assert something false about the data;
* a milestone's ``delivery_mode`` is never rewritten under any request flag, because
  ``is_milestone ⟺ delivery_mode='milestone' ⟺ duration=0`` is one coupled fact.
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    DeliveryMode,
    Dependency,
    GovernanceClass,
    Project,
    Task,
)
from trueppm_api.apps.projects.task_classification import TASK_CLASSIFY_MAX_SUBTREE

URL = "/api/v1/projects/{pk}/tasks/classification/"


def url(project: Project) -> str:
    return URL.format(pk=project.pk)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Hybrid", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def other_project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Other", start_date=date(2026, 1, 1), calendar=calendar)


def _member(project: Project, username: str, role: int) -> APIClient:
    User = get_user_model()
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def owner_client(project: Project) -> APIClient:
    return _member(project, "owner_c", Role.OWNER)


def _no_side_effects() -> Any:
    """Silence the CPM enqueue unless a test asserts on it."""
    return patch("trueppm_api.apps.projects.views._enqueue_recalculate")


def _task(project: Project, name: str, wbs: str, **kwargs: Any) -> Task:
    kwargs.setdefault("duration", 1)
    return Task.objects.create(project=project, name=name, wbs_path=wbs, **kwargs)


@pytest.fixture
def phase(project: Project) -> Task:
    """A phase with two ordinary children, two milestone gates, and one override.

    ``1``      Phase
    ``1.1``    Design        — ordinary
    ``1.2``    Gate A        — milestone
    ``1.3``    Build         — ordinary, parent_governance_inherited=False (override)
    ``1.4``    Gate B        — milestone
    ``2``      Elsewhere     — a sibling root, must never be touched
    """
    root = _task(project, "Phase", "1")
    _task(project, "Design", "1.1")
    _task(
        project,
        "Gate A",
        "1.2",
        duration=0,
        is_milestone=True,
        delivery_mode=DeliveryMode.MILESTONE,
    )
    _task(
        project,
        "Build",
        "1.3",
        parent_governance_inherited=False,
        governance_class=GovernanceClass.GATED,
    )
    _task(
        project,
        "Gate B",
        "1.4",
        duration=0,
        is_milestone=True,
        delivery_mode=DeliveryMode.MILESTONE,
    )
    _task(project, "Elsewhere", "2")
    return root


def _patch(client: APIClient, project: Project, **body: Any) -> Any:
    with _no_side_effects():
        return client.patch(url(project), body, format="json")


# ---------------------------------------------------------------------------
# The acceptance criterion from #2735
# ---------------------------------------------------------------------------


def test_cascade_preserves_milestones_and_one_governance_override(
    owner_client: APIClient, project: Project, phase: Task
) -> None:
    """The issue's stated acceptance: 2 milestones and 1 override survive intact.

    Reports 1 override kept and 2 skipped, and the milestone invariant holds on every
    row afterwards.
    """
    r = _patch(
        owner_client,
        project,
        subtree=str(phase.pk),
        governance_class=GovernanceClass.FLOW,
        delivery_mode=DeliveryMode.SCRUM,
    )
    assert r.status_code == 200, r.data

    assert r.data["matched"] == 5
    assert r.data["governance"]["overrides_kept"] == 1
    assert len(r.data["skipped"]) == 2
    assert {s["code"] for s in r.data["skipped"]} == {"milestone_gate"}

    override = Task.objects.get(project=project, name="Build")
    assert override.governance_class == GovernanceClass.GATED
    assert override.parent_governance_inherited is False

    for gate in Task.objects.filter(project=project, is_milestone=True):
        # The coupled invariant, asserted on every row rather than on the response.
        assert gate.delivery_mode == DeliveryMode.MILESTONE
        assert gate.duration == 0
        assert gate.is_milestone is True


# ---------------------------------------------------------------------------
# The two axes are independent
# ---------------------------------------------------------------------------


def test_overrides_kept_is_null_on_delivery_mode_not_zero(
    owner_client: APIClient, project: Project, phase: Task
) -> None:
    """#2735 §3 — the response must not imply a count it cannot compute.

    ``0`` would read as "there were no overrides", a claim about the data. ``null``
    says the count is not computable on an axis with no inherit bit, which is the true
    statement and the whole point of the requirement.
    """
    r = _patch(
        owner_client,
        project,
        subtree=str(phase.pk),
        governance_class=GovernanceClass.FLOW,
        delivery_mode=DeliveryMode.KANBAN,
    )
    assert r.data["delivery_mode"]["overrides_kept"] is None
    assert r.data["delivery_mode"]["has_inherit_bit"] is False
    assert r.data["governance"]["has_inherit_bit"] is True


def test_governance_override_still_receives_the_cascaded_delivery_mode(
    owner_client: APIClient, project: Project, phase: Task
) -> None:
    """A preserved *governance* override is not a delivery-mode override.

    The axes are orthogonal; only governance has an inherit bit, so a row that opted
    out of inherited governance never opted out of anything on the delivery axis.
    """
    _patch(
        owner_client,
        project,
        subtree=str(phase.pk),
        governance_class=GovernanceClass.FLOW,
        delivery_mode=DeliveryMode.SCRUM,
    )
    override = Task.objects.get(project=project, name="Build")
    assert override.governance_class == GovernanceClass.GATED  # kept
    assert override.delivery_mode == DeliveryMode.SCRUM  # cascaded anyway


def test_single_axis_request_omits_the_other_axis_from_the_response(
    owner_client: APIClient, project: Project, phase: Task
) -> None:
    r = _patch(owner_client, project, subtree=str(phase.pk), delivery_mode=DeliveryMode.KANBAN)
    assert "delivery_mode" in r.data
    assert "governance" not in r.data
    assert Task.objects.get(project=project, name="Design").governance_class == (
        GovernanceClass.FLOW  # the model default, untouched
    )


def test_neither_axis_is_a_400(owner_client: APIClient, project: Project, phase: Task) -> None:
    r = _patch(owner_client, project, subtree=str(phase.pk))
    assert r.status_code == 400, r.data


def test_cascading_to_milestone_delivery_mode_is_rejected(
    owner_client: APIClient, project: Project, phase: Task
) -> None:
    """A cascade cannot convert tasks into gates — that also has to zero durations."""
    r = _patch(owner_client, project, subtree=str(phase.pk), delivery_mode=DeliveryMode.MILESTONE)
    assert r.status_code == 400, r.data


# ---------------------------------------------------------------------------
# The inherit bit gets its first writer (ADR-0790 §3)
# ---------------------------------------------------------------------------


def test_root_breaks_inheritance_and_descendants_inherit(
    owner_client: APIClient, project: Project, phase: Task
) -> None:
    """Declaring a subtree's governance IS breaking inheritance at its root."""
    _patch(owner_client, project, subtree=str(phase.pk), governance_class=GovernanceClass.GATED)
    phase.refresh_from_db()
    assert phase.parent_governance_inherited is False

    design = Task.objects.get(project=project, name="Design")
    assert design.parent_governance_inherited is True
    assert design.governance_class == GovernanceClass.GATED


def test_preserve_false_overwrites_the_override_and_resets_its_bit(
    owner_client: APIClient, project: Project, phase: Task
) -> None:
    """An overwritten override is no longer an override, so its bit resets to True."""
    r = _patch(
        owner_client,
        project,
        subtree=str(phase.pk),
        governance_class=GovernanceClass.FLOW,
        preserve_governance_overrides=False,
    )
    assert r.data["governance"]["overrides_kept"] == 0
    override = Task.objects.get(project=project, name="Build")
    assert override.governance_class == GovernanceClass.FLOW
    assert override.parent_governance_inherited is True


def test_root_is_classified_even_when_it_carries_an_override(
    owner_client: APIClient, project: Project
) -> None:
    """Override preservation is about *descendants*.

    The root is the row the caller pointed at, so preserving its prior governance
    against the caller's explicit declaration would make the endpoint refuse the one
    thing it was asked to do.
    """
    root = _task(
        project,
        "Standalone",
        "7",
        parent_governance_inherited=False,
        governance_class=GovernanceClass.GATED,
    )
    _patch(owner_client, project, subtree=str(root.pk), governance_class=GovernanceClass.FLOW)
    root.refresh_from_db()
    assert root.governance_class == GovernanceClass.FLOW
    assert root.parent_governance_inherited is False


# ---------------------------------------------------------------------------
# Milestones (ADR-0790 §4)
# ---------------------------------------------------------------------------


def test_skip_milestones_false_applies_governance_but_never_delivery_mode(
    owner_client: APIClient, project: Project, phase: Task
) -> None:
    """The flag governs the governance axis only. The invariant is not waivable."""
    r = _patch(
        owner_client,
        project,
        subtree=str(phase.pk),
        governance_class=GovernanceClass.GATED,
        delivery_mode=DeliveryMode.SCRUM,
        skip_milestones=False,
    )
    assert r.status_code == 200, r.data

    # The skip is axis-specific: delivery withheld, governance not.
    skipped = {s["id"]: s["axes"] for s in r.data["skipped"]}
    assert len(skipped) == 2
    assert all(axes == ["delivery_mode"] for axes in skipped.values())

    for gate in Task.objects.filter(project=project, is_milestone=True):
        assert gate.governance_class == GovernanceClass.GATED
        assert gate.delivery_mode == DeliveryMode.MILESTONE


def test_skip_milestones_true_withholds_both_axes(
    owner_client: APIClient, project: Project, phase: Task
) -> None:
    r = _patch(
        owner_client,
        project,
        subtree=str(phase.pk),
        governance_class=GovernanceClass.GATED,
        delivery_mode=DeliveryMode.SCRUM,
    )
    axes = [s["axes"] for s in r.data["skipped"]]
    assert all(set(a) == {"governance_class", "delivery_mode"} for a in axes)
    for gate in Task.objects.filter(project=project, is_milestone=True):
        assert gate.governance_class == GovernanceClass.FLOW  # untouched default


def test_milestone_governance_alone_is_not_a_skip_when_flag_is_false(
    owner_client: APIClient, project: Project, phase: Task
) -> None:
    """No delivery axis requested → nothing to withhold → nothing to report."""
    r = _patch(
        owner_client,
        project,
        subtree=str(phase.pk),
        governance_class=GovernanceClass.GATED,
        skip_milestones=False,
    )
    assert r.data["skipped"] == []


# ---------------------------------------------------------------------------
# Subtree resolution
# ---------------------------------------------------------------------------


def test_cascade_false_classifies_the_root_alone(
    owner_client: APIClient, project: Project, phase: Task
) -> None:
    r = _patch(
        owner_client,
        project,
        subtree=str(phase.pk),
        cascade=False,
        delivery_mode=DeliveryMode.KANBAN,
    )
    assert r.data["matched"] == 1
    assert Task.objects.get(project=project, name="Design").delivery_mode == (
        DeliveryMode.WATERFALL
    )


def test_sibling_subtree_is_never_touched(
    owner_client: APIClient, project: Project, phase: Task
) -> None:
    """``1`` must not match ``2`` — nor, critically, would ``1`` match ``10``.

    The descendant probe anchors on ``"<path>."``, so a sibling whose path merely
    *starts with* the root's digits is outside the subtree.
    """
    ten = _task(project, "Decoy", "10")
    _patch(owner_client, project, subtree=str(phase.pk), delivery_mode=DeliveryMode.KANBAN)
    ten.refresh_from_db()
    assert ten.delivery_mode == DeliveryMode.WATERFALL
    assert Task.objects.get(project=project, name="Elsewhere").delivery_mode == (
        DeliveryMode.WATERFALL
    )


def test_soft_deleted_descendant_is_not_classified(
    owner_client: APIClient, project: Project, phase: Task
) -> None:
    dead = _task(project, "Dead", "1.9")
    dead.soft_delete()
    r = _patch(owner_client, project, subtree=str(phase.pk), delivery_mode=DeliveryMode.KANBAN)
    assert r.data["matched"] == 5
    dead.refresh_from_db()
    assert dead.delivery_mode == DeliveryMode.WATERFALL


def test_unknown_subtree_is_404(owner_client: APIClient, project: Project) -> None:
    r = _patch(owner_client, project, subtree=str(uuid.uuid4()), delivery_mode=DeliveryMode.KANBAN)
    assert r.status_code == 404, r.data


def test_subtree_in_another_project_is_404_not_403(
    owner_client: APIClient, project: Project, other_project: Project
) -> None:
    """IDOR guard: a foreign root is indistinguishable from a nonexistent one."""
    foreign = _task(other_project, "Theirs", "1")
    r = _patch(owner_client, project, subtree=str(foreign.pk), delivery_mode=DeliveryMode.KANBAN)
    assert r.status_code == 404, r.data
    foreign.refresh_from_db()
    assert foreign.delivery_mode == DeliveryMode.WATERFALL


def test_subtree_above_the_cap_is_rejected_not_truncated(
    owner_client: APIClient, project: Project, phase: Task
) -> None:
    """A silent truncation would report a subtree as classified when its tail is not."""
    with patch("trueppm_api.apps.projects.task_classification.TASK_CLASSIFY_MAX_SUBTREE", 2):
        r = _patch(owner_client, project, subtree=str(phase.pk), delivery_mode=DeliveryMode.KANBAN)
    assert r.status_code == 400, r.data
    assert r.data["code"] == "subtree_too_large"
    assert Task.objects.get(project=project, name="Design").delivery_mode == (
        DeliveryMode.WATERFALL
    )


def test_the_cap_is_not_the_paste_many_cap() -> None:
    """Regression guard on ADR-0790 §7: the two caps bound different things.

    500 (``TASK_BULK_MAX_OPERATIONS``) bounds rows a human typed; this one bounds rows
    the server resolved from one click, and sits above a realistic top-level phase.
    """
    from trueppm_api.apps.projects.task_bulk import TASK_BULK_MAX_OPERATIONS

    assert TASK_CLASSIFY_MAX_SUBTREE > TASK_BULK_MAX_OPERATIONS


# ---------------------------------------------------------------------------
# Permission (ADR-0790 §6)
# ---------------------------------------------------------------------------


def test_viewer_cannot_cascade(project: Project, phase: Task) -> None:
    viewer = _member(project, "viewer_c", Role.VIEWER)
    r = _patch(viewer, project, subtree=str(phase.pk), delivery_mode=DeliveryMode.KANBAN)
    assert r.status_code == 403, r.data


def test_scheduler_cannot_cascade(project: Project, phase: Task) -> None:
    """ADR-0773: the resource-management band is excluded from plan authoring."""
    scheduler = _member(project, "sched_c", Role.SCHEDULER)
    r = _patch(scheduler, project, subtree=str(phase.pk), delivery_mode=DeliveryMode.KANBAN)
    assert r.status_code == 403, r.data


def test_member_who_cannot_edit_every_row_gets_403_not_a_partial_cascade(
    project: Project, phase: Task
) -> None:
    """All-or-nothing: half a declaration is a lie, so nothing is written.

    This is the deliberate divergence from ``tasks/bulk/``, where one bad row out of 38
    must not discard the other 37.
    """
    User = get_user_model()
    user = User.objects.create_user(username="member_c", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    client = APIClient()
    client.force_authenticate(user=user)

    # The Member owns one row of the subtree and none of the others.
    design = Task.objects.get(project=project, name="Design")
    design.assignee = user
    design.save()

    r = _patch(client, project, subtree=str(phase.pk), delivery_mode=DeliveryMode.KANBAN)
    assert r.status_code == 403, r.data
    design.refresh_from_db()
    assert design.delivery_mode == DeliveryMode.WATERFALL


def test_non_member_cannot_cascade(project: Project, phase: Task, other_project: Project) -> None:
    """A member of *some* project is not a member of *this* one."""
    outsider = _member(other_project, "outsider_c", Role.OWNER)
    r = _patch(outsider, project, subtree=str(phase.pk), delivery_mode=DeliveryMode.KANBAN)
    assert r.status_code in (403, 404), r.data
    phase.refresh_from_db()
    assert phase.delivery_mode == DeliveryMode.WATERFALL


def test_archived_project_is_read_only(
    owner_client: APIClient, project: Project, phase: Task
) -> None:
    project.is_archived = True
    project.save(update_fields=["is_archived"])
    r = _patch(owner_client, project, subtree=str(phase.pk), delivery_mode=DeliveryMode.KANBAN)
    assert r.status_code == 403, r.data


def test_unauthenticated_is_rejected(project: Project, phase: Task) -> None:
    r = APIClient().patch(
        url(project), {"subtree": str(phase.pk), "delivery_mode": "kanban"}, format="json"
    )
    assert r.status_code in (401, 403), r.data


# ---------------------------------------------------------------------------
# Sync, idempotency, and side effects (ADR-0790 §7)
# ---------------------------------------------------------------------------


def test_every_written_row_advances_server_version_and_sync_seq(
    owner_client: APIClient, project: Project, phase: Task
) -> None:
    """The cascade must not be a ``QuerySet.update()``.

    ``server_version`` and ``sync_seq`` advance only inside ``VersionedModel.save()``,
    and without them the classification never reaches an offline client — the #2491
    failure class, which is silent.
    """
    design = Task.objects.get(project=project, name="Design")
    before_version = design.server_version
    before_seq = design.sync_seq

    _patch(owner_client, project, subtree=str(phase.pk), delivery_mode=DeliveryMode.SCRUM)

    design.refresh_from_db()
    assert design.server_version > before_version
    assert design.sync_seq > before_seq


def test_repeating_an_identical_cascade_writes_nothing(
    owner_client: APIClient, project: Project, phase: Task
) -> None:
    """Change detection is the idempotency mechanism (ADR-0790 §7)."""
    _patch(owner_client, project, subtree=str(phase.pk), delivery_mode=DeliveryMode.SCRUM)
    design = Task.objects.get(project=project, name="Design")
    settled_version = design.server_version

    r = _patch(owner_client, project, subtree=str(phase.pk), delivery_mode=DeliveryMode.SCRUM)
    assert r.data["delivery_mode"]["applied"] == 0
    assert r.data["delivery_mode"]["unchanged"] == 3  # root + Design + Build

    design.refresh_from_db()
    assert design.server_version == settled_version


def test_a_no_op_cascade_does_not_enqueue_a_recalculation(
    owner_client: APIClient,
    project: Project,
    phase: Task,
    django_capture_on_commit_callbacks: Any,
) -> None:
    """A repeat must not wake every collaborator's client either.

    The capture fixture is what makes this assertion non-vacuous: without it the
    on_commit callback never runs in a test transaction, so ``assert_not_called``
    would hold even if the registration were unconditional.
    """
    _patch(owner_client, project, subtree=str(phase.pk), delivery_mode=DeliveryMode.SCRUM)
    with (
        patch("trueppm_api.apps.projects.views._enqueue_recalculate") as enqueue,
        django_capture_on_commit_callbacks(execute=True),
    ):
        owner_client.patch(
            url(project),
            {"subtree": str(phase.pk), "delivery_mode": DeliveryMode.SCRUM},
            format="json",
        )
    enqueue.assert_not_called()


def test_a_changing_cascade_enqueues_recalculation_and_broadcasts(
    owner_client: APIClient,
    project: Project,
    phase: Task,
    django_capture_on_commit_callbacks: Any,
) -> None:
    """delivery_mode feeds the rollup engine and the agile-aware Monte Carlo, so the
    schedule is invalid even though the cascade moved no dates.

    Both effects are registered with ``transaction.on_commit``, which never fires
    inside pytest-django's rolled-back test transaction — hence the capture fixture.
    Asserting without it would pass vacuously today and keep passing if the
    registrations were deleted.
    """
    with (
        patch("trueppm_api.apps.projects.views._enqueue_recalculate") as enqueue,
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as broadcast,
        django_capture_on_commit_callbacks(execute=True),
    ):
        r = owner_client.patch(
            url(project),
            {"subtree": str(phase.pk), "delivery_mode": DeliveryMode.SCRUM},
            format="json",
        )
    assert r.status_code == 200, r.data
    enqueue.assert_called_once_with(str(project.pk))
    events = [c.args[1] for c in broadcast.call_args_list]
    assert "tasks_bulk_mutated" in events


# ---------------------------------------------------------------------------
# The graph guard (ADR-0790 §8)
# ---------------------------------------------------------------------------


def test_a_cyclic_project_graph_blocks_the_cascade(
    owner_client: APIClient, project: Project, phase: Task
) -> None:
    """The cascade writes no edges, but it enqueues a recalculation.

    A project seeded through the still-unguarded seed importer (#2589) can hold a
    cyclic graph, and a cascade is often the first authoring act after a template
    applies. Surfacing it as a 400 beats a CPM worker crash nobody sees.
    """
    a = Task.objects.get(project=project, name="Design")
    b = Task.objects.get(project=project, name="Build")
    # bulk_create bypasses DependencySerializer's per-edge cycle check, which is
    # exactly how an unguarded importer writes one.
    Dependency.objects.bulk_create(
        [
            Dependency(predecessor=a, successor=b),
            Dependency(predecessor=b, successor=a),
        ]
    )
    r = _patch(owner_client, project, subtree=str(phase.pk), delivery_mode=DeliveryMode.SCRUM)
    assert r.status_code == 400, r.data
    assert r.data["code"] == "cyclic_dependency"
    a.refresh_from_db()
    assert a.delivery_mode == DeliveryMode.WATERFALL


def test_a_no_op_cascade_skips_the_graph_guard_entirely(
    owner_client: APIClient, project: Project, phase: Task
) -> None:
    """The guard reads every task and every edge in the PROJECT, not the subtree.

    Paying that scan to write nothing is the cost the deferral avoids (ADR-0790 §8),
    and a cyclic graph is the observable proxy for whether it ran: a repeat cascade
    that changes nothing enqueues no recalculation, so there is nothing to protect.
    """
    a = Task.objects.get(project=project, name="Design")
    b = Task.objects.get(project=project, name="Build")
    Dependency.objects.bulk_create(
        [Dependency(predecessor=a, successor=b), Dependency(predecessor=b, successor=a)]
    )
    # Already at the requested value, so the classification pass finds nothing to write.
    r = _patch(owner_client, project, subtree=str(phase.pk), delivery_mode=DeliveryMode.WATERFALL)
    assert r.status_code == 200, r.data
    assert r.data["delivery_mode"]["applied"] == 0
