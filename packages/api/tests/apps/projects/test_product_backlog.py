"""Product backlog & scoring tests (ADR-0105 merged design, #363/#364/#365/#493/#731/#922).

Covers:
- WSJF / RICE / value-effort score from distinct per-model columns + null guards;
- non-destructive model switch (inputs for the inactive model are preserved);
- the AcceptanceCriterion child model: CRUD endpoint (Member+), met-stamping review trail,
  and the privacy guard (no PMO/aggregation surface);
- the advisory Mark-ready DoR gate (estimated + all criteria met) keyed off the child rows;
- one-shot auto-rank ordering + priority_rank persistence + server_version/history, with the
  epic/sprint exclusions; manual drag always wins (no persistent lock);
- parent_epic membership validation (type=EPIC, same project, no nesting);
- sprint_rank seeding from priority_rank at commit, never writing back to priority_rank;
- epics excluded from the CommittedTaskManager (the CPM/capacity exclusion key).
"""

from __future__ import annotations

from datetime import date
from typing import Any
from unittest import mock

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    AcceptanceCriterion,
    Calendar,
    DorState,
    PrioritizationModel,
    Project,
    Sprint,
    SprintState,
    Task,
    TaskStatus,
    TaskType,
)
from trueppm_api.apps.projects.product_backlog_services import (
    BacklogReorderConflict,
    DorTransitionError,
    SprintReorderConflict,
    auto_rank,
    compute_score,
    dor_blockers,
    mark_ready,
    reorder_backlog,
    reorder_sprint,
    seed_sprint_rank,
    split_story,
)
from trueppm_api.apps.teams.models import Team, TeamMembership, TeamRole

User = get_user_model()


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


@pytest.fixture
def owner(db: object) -> object:
    return User.objects.create_user(username="po", password="pw")


@pytest.fixture
def member_user(db: object) -> object:
    return User.objects.create_user(username="dev", password="pw")


@pytest.fixture
def project(owner: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    p = Project.objects.create(name="Artemis", start_date=date(2026, 1, 1), calendar=cal)
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    return p


@pytest.fixture
def member(project: Project, member_user: object) -> object:
    ProjectMembership.objects.create(project=project, user=member_user, role=Role.MEMBER)
    return member_user


@pytest.fixture
def owner_client(owner: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=owner)
    return c


def _story(project: Project, **kw: object) -> Task:
    defaults: dict[str, object] = {
        "name": "Story",
        "type": TaskType.STORY,
        "status": TaskStatus.BACKLOG,
        "sprint": None,
    }
    defaults.update(kw)
    return Task.objects.create(project=project, **defaults)


def _criterion(
    task: Task, *, met: bool = False, pos: int = 0, text: str = "AC"
) -> AcceptanceCriterion:
    return AcceptanceCriterion.objects.create(task=task, text=text, met=met, position=pos)


# --------------------------------------------------------------------------- #
# Scoring — distinct per-model columns
# --------------------------------------------------------------------------- #


def test_wsjf_score(project: Project) -> None:
    t = _story(project, business_value=9, time_criticality=8, risk_reduction=7, job_size=8)
    assert compute_score(t, PrioritizationModel.WSJF) == pytest.approx((9 + 8 + 7) / 8)


def test_rice_score(project: Project) -> None:
    t = _story(project, reach=500, impact=2.0, confidence=0.8, effort=5.0)
    assert compute_score(t, PrioritizationModel.RICE) == pytest.approx((500 * 2 * 0.8) / 5)


def test_value_effort_score(project: Project) -> None:
    t = _story(project, value=8, effort_estimate=4.0)
    assert compute_score(t, PrioritizationModel.VALUE_EFFORT) == pytest.approx(2.0)


def test_score_null_on_zero_denominator(project: Project) -> None:
    t = _story(project, business_value=9, time_criticality=8, risk_reduction=7, job_size=0)
    assert compute_score(t, PrioritizationModel.WSJF) is None


def test_score_null_on_missing_component(project: Project) -> None:
    t = _story(project, business_value=9, time_criticality=8)  # no rr / size
    assert compute_score(t, PrioritizationModel.WSJF) is None


def test_score_none_model_is_null(project: Project) -> None:
    t = _story(project, business_value=9, time_criticality=8, risk_reduction=7, job_size=8)
    assert compute_score(t, PrioritizationModel.NONE) is None


def test_model_switch_is_non_destructive(project: Project) -> None:
    # WSJF inputs and RICE inputs coexist on distinct columns — switching the active
    # model never clears the other model's inputs (VoC C2=A).
    t = _story(
        project,
        business_value=9,
        time_criticality=8,
        risk_reduction=7,
        job_size=8,
        reach=500,
        impact=2.0,
        confidence=0.8,
        effort=5.0,
    )
    assert compute_score(t, PrioritizationModel.WSJF) == pytest.approx(3.0)
    assert compute_score(t, PrioritizationModel.RICE) == pytest.approx(160.0)


# --------------------------------------------------------------------------- #
# Acceptance criteria + Definition of Ready
# --------------------------------------------------------------------------- #


def test_dor_blockers_lists_unmet_conditions(project: Project) -> None:
    t = _story(project, story_points=None)
    assert set(dor_blockers(t)) == {"unestimated", "no_acceptance_criteria"}


def test_dor_blockers_clear_when_ready(project: Project) -> None:
    t = _story(project, story_points=5)
    _criterion(t, met=True)
    assert dor_blockers(t) == []


def test_mark_ready_service_raises_when_blocked(project: Project) -> None:
    t = _story(project, story_points=None)
    with pytest.raises(DorTransitionError):
        mark_ready(t, None)


def test_patch_dor_ready_blocked_when_criterion_unmet(
    owner_client: APIClient, project: Project
) -> None:
    t = _story(project, story_points=8)
    _criterion(t, met=True, pos=0)
    _criterion(t, met=False, pos=1)
    resp = owner_client.patch(f"/api/v1/tasks/{t.pk}/", {"dor": "ready"}, format="json")
    assert resp.status_code == 400
    assert "dor" in resp.data
    t.refresh_from_db()
    assert t.dor == DorState.IDEA


def test_patch_dor_ready_allowed_when_estimated_and_all_met(
    owner_client: APIClient, project: Project
) -> None:
    t = _story(project, story_points=5)
    _criterion(t, met=True)
    resp = owner_client.patch(f"/api/v1/tasks/{t.pk}/", {"dor": "ready"}, format="json")
    assert resp.status_code == 200
    t.refresh_from_db()
    assert t.dor == DorState.READY


# --------------------------------------------------------------------------- #
# AcceptanceCriterion CRUD endpoint + review trail
# --------------------------------------------------------------------------- #


def test_member_can_create_criterion(project: Project, member: object) -> None:
    story = _story(project, name="s")
    client = APIClient()
    client.force_authenticate(user=member)
    resp = client.post(
        "/api/v1/acceptance-criteria/",
        {"task": str(story.pk), "text": "Cutover preserves frame order"},
        format="json",
    )
    assert resp.status_code == 201
    assert AcceptanceCriterion.objects.filter(task=story).count() == 1


def test_marking_met_stamps_review_trail(project: Project, member: object) -> None:
    story = _story(project, name="s")
    c = _criterion(story, met=False)
    client = APIClient()
    client.force_authenticate(user=member)
    resp = client.patch(f"/api/v1/acceptance-criteria/{c.pk}/", {"met": True}, format="json")
    assert resp.status_code == 200
    c.refresh_from_db()
    assert c.met is True
    assert c.met_by_id == member.pk  # review trail stamped
    assert c.met_at is not None


def test_unmarking_met_clears_review_trail(project: Project, member: object) -> None:
    story = _story(project, name="s")
    c = _criterion(story, met=True)
    c.met_by = member  # type: ignore[assignment]
    c.save(update_fields=["met_by"])
    client = APIClient()
    client.force_authenticate(user=member)
    resp = client.patch(f"/api/v1/acceptance-criteria/{c.pk}/", {"met": False}, format="json")
    assert resp.status_code == 200
    c.refresh_from_db()
    assert c.met_by_id is None
    assert c.met_at is None


def test_criterion_cannot_be_reparented_to_another_task(
    owner_client: APIClient, project: Project
) -> None:
    # Cross-project write-IDOR guard: the writable task FK must not let a criterion move
    # to another task (reparenting is forbidden — split copies criteria, never moves them).
    a = _story(project, name="a")
    b = _story(project, name="b")
    c = _criterion(a)
    resp = owner_client.patch(
        f"/api/v1/acceptance-criteria/{c.pk}/", {"task": str(b.pk)}, format="json"
    )
    assert resp.status_code == 400
    assert "task" in resp.data


def test_criterion_serializer_exposes_no_per_person_column(
    project: Project, member: object
) -> None:
    # Privacy guard: the wire exposes met_by_name (attribution-on-drill-down), never a
    # raw met_by user id that a PMO view could aggregate into per-person throughput.
    story = _story(project, name="s")
    c = _criterion(story, met=True)
    c.met_by = member  # type: ignore[assignment]
    c.save(update_fields=["met_by"])
    client = APIClient()
    client.force_authenticate(user=member)
    resp = client.get(f"/api/v1/acceptance-criteria/{c.pk}/")
    assert resp.status_code == 200
    assert "met_by" not in resp.data  # no raw user id
    assert "met_by_name" in resp.data


# --------------------------------------------------------------------------- #
# Auto-rank (one-shot, manual wins)
# --------------------------------------------------------------------------- #


def _wsjf(project: Project, name: str, rank: int, bv: int, size: int) -> Task:
    return _story(
        project,
        name=name,
        priority_rank=rank,
        business_value=bv,
        time_criticality=bv,
        risk_reduction=bv,
        job_size=size,
    )


def test_auto_rank_orders_by_score_desc(project: Project) -> None:
    project.prioritization_model = PrioritizationModel.WSJF
    project.save(update_fields=["prioritization_model"])
    low = _wsjf(project, "low", 1, bv=1, size=8)
    high = _wsjf(project, "high", 2, bv=9, size=2)
    auto_rank(project, None)
    low.refresh_from_db()
    high.refresh_from_db()
    assert high.priority_rank < low.priority_rank


def test_auto_rank_bumps_server_version_and_writes_history(project: Project) -> None:
    project.prioritization_model = PrioritizationModel.WSJF
    project.save(update_fields=["prioritization_model"])
    t = _wsjf(project, "t", 9, bv=9, size=1)
    v0, h0 = t.server_version, t.history.count()
    auto_rank(project, None)
    t.refresh_from_db()
    assert t.server_version > v0
    assert t.history.count() > h0


def test_auto_rank_excludes_epics_and_sprinted_tasks(project: Project) -> None:
    project.prioritization_model = PrioritizationModel.WSJF
    project.save(update_fields=["prioritization_model"])
    epic = _story(project, name="epic", type=TaskType.EPIC, priority_rank=50)
    sprint = Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 1, 5),
        finish_date=date(2026, 1, 16),
        state=SprintState.PLANNED,
    )
    sprinted = _story(
        project, name="sprinted", status=TaskStatus.NOT_STARTED, sprint=sprint, priority_rank=60
    )
    _wsjf(project, "backlog", 70, bv=9, size=1)
    auto_rank(project, None)
    epic.refresh_from_db()
    sprinted.refresh_from_db()
    assert epic.priority_rank == 50
    assert sprinted.priority_rank == 60


# --------------------------------------------------------------------------- #
# parent_epic validation
# --------------------------------------------------------------------------- #


def test_parent_epic_must_be_epic_type(owner_client: APIClient, project: Project) -> None:
    not_epic = _story(project, name="not an epic", type=TaskType.STORY)
    story = _story(project, name="child")
    resp = owner_client.patch(
        f"/api/v1/tasks/{story.pk}/", {"parent_epic": str(not_epic.pk)}, format="json"
    )
    assert resp.status_code == 400
    assert "parent_epic" in resp.data


def test_parent_epic_link_accepts_epic(owner_client: APIClient, project: Project) -> None:
    epic = _story(project, name="EP", type=TaskType.EPIC)
    story = _story(project, name="child")
    resp = owner_client.patch(
        f"/api/v1/tasks/{story.pk}/", {"parent_epic": str(epic.pk)}, format="json"
    )
    assert resp.status_code == 200
    story.refresh_from_db()
    assert story.parent_epic_id == epic.pk


def test_parent_epic_cross_project_rejected(
    owner_client: APIClient, project: Project, owner: object
) -> None:
    other_cal = Calendar.objects.create(name="Other")
    other = Project.objects.create(name="Other", start_date=date(2026, 1, 1), calendar=other_cal)
    ProjectMembership.objects.create(project=other, user=owner, role=Role.OWNER)
    foreign_epic = Task.objects.create(
        project=other, name="EP", type=TaskType.EPIC, status=TaskStatus.BACKLOG
    )
    story = _story(project, name="child")
    resp = owner_client.patch(
        f"/api/v1/tasks/{story.pk}/", {"parent_epic": str(foreign_epic.pk)}, format="json"
    )
    assert resp.status_code == 400


def test_member_cannot_write_scoring_on_own_task(project: Project, member: object) -> None:
    # Structural backlog fields (ADR-0105 §6) are Admin+, even on a member's OWN task —
    # a Member passes IsProjectMemberWriteOrOwn for their assigned task but the serializer
    # gate still blocks the PO-owned scoring input.
    t = _story(project, name="mine", assignee=member)
    client = APIClient()
    client.force_authenticate(user=member)
    resp = client.patch(f"/api/v1/tasks/{t.pk}/", {"business_value": 9}, format="json")
    assert resp.status_code == 403


def test_member_cannot_link_epic_on_own_task(project: Project, member: object) -> None:
    epic = _story(project, name="EP", type=TaskType.EPIC)
    t = _story(project, name="mine", assignee=member)
    client = APIClient()
    client.force_authenticate(user=member)
    resp = client.patch(f"/api/v1/tasks/{t.pk}/", {"parent_epic": str(epic.pk)}, format="json")
    assert resp.status_code == 403


def test_admin_can_write_scoring(owner_client: APIClient, project: Project) -> None:
    t = _story(project, name="s")
    resp = owner_client.patch(f"/api/v1/tasks/{t.pk}/", {"business_value": 9}, format="json")
    assert resp.status_code == 200


# --------------------------------------------------------------------------- #
# Grooming endpoint + permissions
# --------------------------------------------------------------------------- #


def test_grooming_endpoint_groups_and_health(owner_client: APIClient, project: Project) -> None:
    epic = _story(project, name="EP", type=TaskType.EPIC)
    ready = _story(
        project, name="ready story", parent_epic=epic, story_points=5, dor=DorState.READY
    )
    _criterion(ready, met=True)
    _story(project, name="loose", story_points=None)
    resp = owner_client.get(f"/api/v1/projects/{project.pk}/product-backlog/")
    assert resp.status_code == 200
    body = resp.data
    assert len(body["epics"]) == 1
    assert body["epics"][0]["rollup"]["story_count"] == 1
    assert len(body["ungrouped"]) == 1
    assert body["health"]["story_count"] == 2
    assert body["health"]["ready_count"] == 1
    assert body["health"]["unestimated"] == 1
    assert body["scoring"]["model"] == PrioritizationModel.NONE


def test_auto_rank_endpoint_requires_admin(project: Project, member: object) -> None:
    client = APIClient()
    client.force_authenticate(user=member)
    resp = client.post(
        f"/api/v1/projects/{project.pk}/product-backlog/auto-rank/", {}, format="json"
    )
    assert resp.status_code == 403


# --------------------------------------------------------------------------- #
# Split story
# --------------------------------------------------------------------------- #


def test_split_carries_unmet_criteria_and_same_epic(project: Project) -> None:
    epic = _story(project, name="EP", type=TaskType.EPIC)
    parent = _story(project, name="big story", parent_epic=epic, story_points=8)
    _criterion(parent, met=True, pos=0, text="done bit")
    _criterion(parent, met=False, pos=1, text="remaining bit")
    child = split_story(parent, None)
    assert child.parent_epic_id == epic.pk
    assert child.status == TaskStatus.BACKLOG
    child_criteria = list(child.acceptance_criteria.all())
    assert len(child_criteria) == 1  # only the unmet one carried over
    assert child_criteria[0].text == "remaining bit"
    parent.refresh_from_db()
    assert parent.story_points == 8  # not auto-divided


def test_split_endpoint_requires_admin(project: Project, member: object) -> None:
    parent = _story(project, name="p")
    client = APIClient()
    client.force_authenticate(user=member)
    resp = client.post(f"/api/v1/tasks/{parent.pk}/split/", {}, format="json")
    assert resp.status_code == 403


def test_split_endpoint_ok_for_owner(owner_client: APIClient, project: Project) -> None:
    parent = _story(project, name="p")
    resp = owner_client.post(f"/api/v1/tasks/{parent.pk}/split/", {}, format="json")
    assert resp.status_code == 201
    assert resp.data["id"] != str(parent.pk)


# --------------------------------------------------------------------------- #
# Dual ordering (#365)
# --------------------------------------------------------------------------- #


def test_seed_sprint_rank_from_priority_does_not_touch_priority(project: Project) -> None:
    sprint = Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 1, 5),
        finish_date=date(2026, 1, 16),
        state=SprintState.PLANNED,
    )
    a = _story(project, name="a", status=TaskStatus.NOT_STARTED, sprint=sprint, priority_rank=2)
    b = _story(project, name="b", status=TaskStatus.NOT_STARTED, sprint=sprint, priority_rank=1)
    seed_sprint_rank(sprint)
    a.refresh_from_db()
    b.refresh_from_db()
    # sprint_rank seeded in priority order (b before a); priority_rank unchanged.
    assert b.sprint_rank == 1 and a.sprint_rank == 2
    assert b.priority_rank == 1 and a.priority_rank == 2


# --------------------------------------------------------------------------- #
# Epic CPM/capacity exclusion (regression)
# --------------------------------------------------------------------------- #


def test_epics_excluded_from_committed_manager(project: Project) -> None:
    _story(project, name="real", status=TaskStatus.NOT_STARTED)
    _story(project, name="epic", type=TaskType.EPIC, status=TaskStatus.NOT_STARTED)
    committed_names = set(Task.committed.filter(project=project).values_list("name", flat=True))
    assert "real" in committed_names
    assert "epic" not in committed_names


# --------------------------------------------------------------------------- #
# Manual drag reorder (ADR-0110, #494)
# --------------------------------------------------------------------------- #


def _entry(task: Task) -> dict[str, object]:
    """A {id, server_version} reorder entry from a task's current state."""
    return {"id": str(task.pk), "server_version": task.server_version}


REORDER_URL = "/api/v1/projects/{pk}/product-backlog/reorder/"


def test_reorder_service_renumbers_dense(project: Project) -> None:
    a = _story(project, name="a", priority_rank=1)
    b = _story(project, name="b", priority_rank=2)
    c = _story(project, name="c", priority_rank=3)
    # New order: c, a, b → dense 1..N in that order.
    changed = reorder_backlog(
        project,
        [
            (str(c.pk), c.server_version),
            (str(a.pk), a.server_version),
            (str(b.pk), b.server_version),
        ],
        None,
    )
    for t in (a, b, c):
        t.refresh_from_db()
    assert (c.priority_rank, a.priority_rank, b.priority_rank) == (1, 2, 3)
    assert changed == 3  # c:3→1, a:1→2, b:2→3 — all three shift


def test_reorder_is_idempotent(project: Project) -> None:
    a = _story(project, name="a", priority_rank=1)
    b = _story(project, name="b", priority_rank=2)
    order = [(str(a.pk), a.server_version), (str(b.pk), b.server_version)]
    # Already in this order → no writes, no version bump.
    assert reorder_backlog(project, order, None) == 0
    a.refresh_from_db()
    b.refresh_from_db()
    assert (
        reorder_backlog(
            project, [(str(a.pk), a.server_version), (str(b.pk), b.server_version)], None
        )
        == 0
    )


def test_reorder_bumps_server_version_and_writes_history(project: Project) -> None:
    a = _story(project, name="a", priority_rank=1)
    b = _story(project, name="b", priority_rank=2)
    v0, h0 = a.server_version, a.history.count()
    reorder_backlog(project, [(str(b.pk), b.server_version), (str(a.pk), a.server_version)], None)
    a.refresh_from_db()
    assert a.priority_rank == 2  # moved to the back
    assert a.server_version > v0
    assert a.history.count() > h0


def test_reorder_stale_server_version_conflicts(project: Project) -> None:
    a = _story(project, name="a", priority_rank=1)
    b = _story(project, name="b", priority_rank=2)
    with pytest.raises(BacklogReorderConflict) as exc:
        reorder_backlog(
            project,
            [(str(b.pk), b.server_version), (str(a.pk), a.server_version + 99)],
            None,
        )
    assert str(a.pk) in exc.value.ids
    a.refresh_from_db()
    b.refresh_from_db()
    assert (a.priority_rank, b.priority_rank) == (1, 2)  # nothing written


def test_reorder_incomplete_set_conflicts(project: Project) -> None:
    a = _story(project, name="a", priority_rank=1)
    _story(project, name="b", priority_rank=2)  # omitted from the list → drift
    with pytest.raises(BacklogReorderConflict):
        reorder_backlog(project, [(str(a.pk), a.server_version)], None)


def test_reorder_unknown_id_conflicts(project: Project) -> None:
    a = _story(project, name="a", priority_rank=1)
    import uuid as _uuid

    with pytest.raises(BacklogReorderConflict):
        reorder_backlog(
            project,
            [(str(a.pk), a.server_version), (str(_uuid.uuid4()), 1)],
            None,
        )


def test_reorder_ignores_epics_and_sprinted(project: Project) -> None:
    # Epics and sprinted tasks are not backlog stories — supplying only the real backlog
    # story is a complete set (the epic/sprinted rows are out of scope).
    _story(project, name="epic", type=TaskType.EPIC, priority_rank=9)
    sprint = Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 1, 5),
        finish_date=date(2026, 1, 16),
        state=SprintState.PLANNED,
    )
    _story(project, name="sprinted", status=TaskStatus.NOT_STARTED, sprint=sprint, priority_rank=8)
    story = _story(project, name="real", priority_rank=5)
    changed = reorder_backlog(project, [(str(story.pk), story.server_version)], None)
    story.refresh_from_db()
    assert story.priority_rank == 1
    assert changed == 1


def test_reorder_endpoint_happy_path(owner_client: APIClient, project: Project) -> None:
    a = _story(project, name="a", priority_rank=1)
    b = _story(project, name="b", priority_rank=2)
    resp = owner_client.post(
        REORDER_URL.format(pk=project.pk),
        {"stories": [_entry(b), _entry(a)]},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data["updated"] == 2
    a.refresh_from_db()
    b.refresh_from_db()
    assert (b.priority_rank, a.priority_rank) == (1, 2)


def test_reorder_endpoint_409_on_stale(owner_client: APIClient, project: Project) -> None:
    a = _story(project, name="a", priority_rank=1)
    b = _story(project, name="b", priority_rank=2)
    resp = owner_client.post(
        REORDER_URL.format(pk=project.pk),
        {"stories": [{"id": str(b.pk), "server_version": b.server_version + 5}, _entry(a)]},
        format="json",
    )
    assert resp.status_code == 409
    assert str(b.pk) in resp.data["conflicts"]


def test_reorder_endpoint_400_on_malformed(owner_client: APIClient, project: Project) -> None:
    pk = project.pk
    # missing field
    assert owner_client.post(REORDER_URL.format(pk=pk), {}, format="json").status_code == 400
    # empty list
    assert (
        owner_client.post(REORDER_URL.format(pk=pk), {"stories": []}, format="json").status_code
        == 400
    )
    # bad entry shape
    assert (
        owner_client.post(
            REORDER_URL.format(pk=pk), {"stories": [{"id": "not-a-uuid"}]}, format="json"
        ).status_code
        == 400
    )


def test_reorder_endpoint_400_on_oversized_list(owner_client: APIClient, project: Project) -> None:
    import uuid as _uuid

    # The cap is checked before the parse loop / select_for_update, so the ids need not exist.
    payload = [{"id": str(_uuid.uuid4()), "server_version": 1} for _ in range(2001)]
    resp = owner_client.post(REORDER_URL.format(pk=project.pk), {"stories": payload}, format="json")
    assert resp.status_code == 400


def test_reorder_endpoint_400_on_duplicate_ids(owner_client: APIClient, project: Project) -> None:
    a = _story(project, name="a", priority_rank=1)
    resp = owner_client.post(
        REORDER_URL.format(pk=project.pk),
        {"stories": [_entry(a), _entry(a)]},
        format="json",
    )
    assert resp.status_code == 400


def test_reorder_endpoint_requires_backlog_manager(project: Project, member: object) -> None:
    a = _story(project, name="a", priority_rank=1)
    client = APIClient()
    client.force_authenticate(user=member)
    resp = client.post(
        REORDER_URL.format(pk=project.pk),
        {"stories": [_entry(a)]},
        format="json",
    )
    assert resp.status_code == 403


# --------------------------------------------------------------------------- #
# In-sprint execution-order reorder — writes sprint_rank only (#365, ADR-0105 §5)
# --------------------------------------------------------------------------- #


SPRINT_REORDER_URL = "/api/v1/sprints/{pk}/reorder/"


def _active_sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="S-active",
        start_date=date(2026, 1, 5),
        finish_date=date(2026, 1, 16),
        state=SprintState.ACTIVE,
    )


def test_reorder_sprint_renumbers_dense_and_leaves_priority(project: Project) -> None:
    sprint = _active_sprint(project)
    a = _story(project, name="a", status=TaskStatus.NOT_STARTED, sprint=sprint, priority_rank=1)
    b = _story(project, name="b", status=TaskStatus.NOT_STARTED, sprint=sprint, priority_rank=2)
    c = _story(project, name="c", status=TaskStatus.NOT_STARTED, sprint=sprint, priority_rank=3)
    seed_sprint_rank(sprint)
    for t in (a, b, c):
        t.refresh_from_db()
    # New execution order: c, a, b.
    changed = reorder_sprint(
        sprint,
        [
            (str(c.pk), c.server_version),
            (str(a.pk), a.server_version),
            (str(b.pk), b.server_version),
        ],
        None,
    )
    for t in (a, b, c):
        t.refresh_from_db()
    assert (c.sprint_rank, a.sprint_rank, b.sprint_rank) == (1, 2, 3)
    # priority_rank (the product-backlog ordering) is untouched — the two backlogs are independent.
    assert (a.priority_rank, b.priority_rank, c.priority_rank) == (1, 2, 3)
    assert changed == 3


def test_reorder_sprint_is_idempotent(project: Project) -> None:
    sprint = _active_sprint(project)
    a = _story(project, name="a", status=TaskStatus.NOT_STARTED, sprint=sprint, priority_rank=1)
    b = _story(project, name="b", status=TaskStatus.NOT_STARTED, sprint=sprint, priority_rank=2)
    seed_sprint_rank(sprint)
    a.refresh_from_db()
    b.refresh_from_db()
    order = [(str(a.pk), a.server_version), (str(b.pk), b.server_version)]
    assert reorder_sprint(sprint, order, None) == 0


def test_reorder_sprint_bumps_server_version_and_writes_history(project: Project) -> None:
    sprint = _active_sprint(project)
    a = _story(project, name="a", status=TaskStatus.NOT_STARTED, sprint=sprint, priority_rank=1)
    b = _story(project, name="b", status=TaskStatus.NOT_STARTED, sprint=sprint, priority_rank=2)
    seed_sprint_rank(sprint)
    a.refresh_from_db()
    b.refresh_from_db()
    v0, h0 = a.server_version, a.history.count()
    reorder_sprint(sprint, [(str(b.pk), b.server_version), (str(a.pk), a.server_version)], None)
    a.refresh_from_db()
    assert a.sprint_rank == 2  # moved to the back
    assert a.server_version > v0
    assert a.history.count() > h0


def test_reorder_sprint_stale_server_version_conflicts(project: Project) -> None:
    sprint = _active_sprint(project)
    a = _story(project, name="a", status=TaskStatus.NOT_STARTED, sprint=sprint, priority_rank=1)
    b = _story(project, name="b", status=TaskStatus.NOT_STARTED, sprint=sprint, priority_rank=2)
    seed_sprint_rank(sprint)
    a.refresh_from_db()
    b.refresh_from_db()
    with pytest.raises(SprintReorderConflict) as exc:
        reorder_sprint(
            sprint,
            [(str(b.pk), b.server_version), (str(a.pk), a.server_version + 99)],
            None,
        )
    assert str(a.pk) in exc.value.ids
    a.refresh_from_db()
    b.refresh_from_db()
    assert (a.sprint_rank, b.sprint_rank) == (1, 2)  # nothing written


def test_reorder_sprint_incomplete_set_conflicts(project: Project) -> None:
    sprint = _active_sprint(project)
    a = _story(project, name="a", status=TaskStatus.NOT_STARTED, sprint=sprint, priority_rank=1)
    _story(project, name="b", status=TaskStatus.NOT_STARTED, sprint=sprint, priority_rank=2)
    seed_sprint_rank(sprint)
    a.refresh_from_db()
    with pytest.raises(SprintReorderConflict):
        reorder_sprint(sprint, [(str(a.pk), a.server_version)], None)


def test_reorder_sprint_excludes_epics(project: Project) -> None:
    # An epic that happens to sit in the sprint is not part of the execution order — supplying
    # only the real stories is a complete set (the epic row is out of scope, not drift).
    sprint = _active_sprint(project)
    _story(project, name="epic", type=TaskType.EPIC, status=TaskStatus.NOT_STARTED, sprint=sprint)
    a = _story(project, name="a", status=TaskStatus.NOT_STARTED, sprint=sprint, priority_rank=1)
    b = _story(project, name="b", status=TaskStatus.NOT_STARTED, sprint=sprint, priority_rank=2)
    seed_sprint_rank(sprint)
    a.refresh_from_db()
    b.refresh_from_db()
    # Reverse the two stories; the epic is neither required nor an error.
    changed = reorder_sprint(
        sprint, [(str(b.pk), b.server_version), (str(a.pk), a.server_version)], None
    )
    a.refresh_from_db()
    b.refresh_from_db()
    assert (b.sprint_rank, a.sprint_rank) == (1, 2)
    assert changed == 2


def test_reorder_sprint_endpoint_happy_path(project: Project, member: object) -> None:
    # Member+ (the sprint write floor) can reorder execution order — it's team-owned, unlike
    # the PO-gated product backlog.
    sprint = _active_sprint(project)
    a = _story(project, name="a", status=TaskStatus.NOT_STARTED, sprint=sprint, priority_rank=1)
    b = _story(project, name="b", status=TaskStatus.NOT_STARTED, sprint=sprint, priority_rank=2)
    seed_sprint_rank(sprint)
    a.refresh_from_db()
    b.refresh_from_db()
    client = APIClient()
    client.force_authenticate(user=member)
    resp = client.post(
        SPRINT_REORDER_URL.format(pk=sprint.pk),
        {"tasks": [_entry(b), _entry(a)]},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data["updated"] == 2
    a.refresh_from_db()
    b.refresh_from_db()
    assert (b.sprint_rank, a.sprint_rank) == (1, 2)


def test_reorder_sprint_endpoint_400_on_non_active(
    owner_client: APIClient, project: Project
) -> None:
    sprint = Sprint.objects.create(
        project=project,
        name="S-planned",
        start_date=date(2026, 1, 5),
        finish_date=date(2026, 1, 16),
        state=SprintState.PLANNED,
    )
    a = _story(project, name="a", status=TaskStatus.NOT_STARTED, sprint=sprint, priority_rank=1)
    resp = owner_client.post(
        SPRINT_REORDER_URL.format(pk=sprint.pk),
        {"tasks": [_entry(a)]},
        format="json",
    )
    assert resp.status_code == 400


def test_reorder_sprint_endpoint_409_on_stale(owner_client: APIClient, project: Project) -> None:
    sprint = _active_sprint(project)
    a = _story(project, name="a", status=TaskStatus.NOT_STARTED, sprint=sprint, priority_rank=1)
    b = _story(project, name="b", status=TaskStatus.NOT_STARTED, sprint=sprint, priority_rank=2)
    seed_sprint_rank(sprint)
    a.refresh_from_db()
    b.refresh_from_db()
    resp = owner_client.post(
        SPRINT_REORDER_URL.format(pk=sprint.pk),
        {"tasks": [{"id": str(b.pk), "server_version": b.server_version + 5}, _entry(a)]},
        format="json",
    )
    assert resp.status_code == 409
    assert str(b.pk) in resp.data["conflicts"]


def test_reorder_sprint_endpoint_400_on_malformed(
    owner_client: APIClient, project: Project
) -> None:
    sprint = _active_sprint(project)
    a = _story(project, name="a", status=TaskStatus.NOT_STARTED, sprint=sprint, priority_rank=1)
    seed_sprint_rank(sprint)
    a.refresh_from_db()
    pk = sprint.pk
    # missing field
    assert owner_client.post(SPRINT_REORDER_URL.format(pk=pk), {}, format="json").status_code == 400
    # empty list
    assert (
        owner_client.post(
            SPRINT_REORDER_URL.format(pk=pk), {"tasks": []}, format="json"
        ).status_code
        == 400
    )
    # duplicate ids
    assert (
        owner_client.post(
            SPRINT_REORDER_URL.format(pk=pk), {"tasks": [_entry(a), _entry(a)]}, format="json"
        ).status_code
        == 400
    )


def test_reorder_sprint_endpoint_403_for_viewer_and_non_member(project: Project) -> None:
    # Sprint execution order is Member+ (team-owned): a Viewer on the project and a user
    # with no membership are both denied, enforced object-level via check_object_permissions.
    sprint = _active_sprint(project)
    a = _story(project, name="a", status=TaskStatus.NOT_STARTED, sprint=sprint, priority_rank=1)
    seed_sprint_rank(sprint)
    a.refresh_from_db()
    url = SPRINT_REORDER_URL.format(pk=sprint.pk)
    payload = {"tasks": [_entry(a)]}

    viewer_user = User.objects.create_user(username="viewer", password="pw")
    ProjectMembership.objects.create(project=project, user=viewer_user, role=Role.VIEWER)
    viewer_client = APIClient()
    viewer_client.force_authenticate(user=viewer_user)
    assert viewer_client.post(url, payload, format="json").status_code == 403

    outsider = User.objects.create_user(username="outsider", password="pw")
    outsider_client = APIClient()
    outsider_client.force_authenticate(user=outsider)
    # A non-member must not even learn the sprint exists; 403/404 are both acceptable denials.
    assert outsider_client.post(url, payload, format="json").status_code in (403, 404)

    a.refresh_from_db()
    assert a.sprint_rank == 1  # nothing written on either denial


def test_reorder_broadcasts_backlog_reranked(
    owner_client: APIClient,
    project: Project,
    django_capture_on_commit_callbacks: Any,
) -> None:
    a = _story(project, name="a", priority_rank=1)
    b = _story(project, name="b", priority_rank=2)
    with mock.patch(
        "trueppm_api.apps.projects.product_backlog_services.broadcast_board_event"
    ) as spy:
        # on_commit callbacks only fire when the surrounding transaction commits; the
        # capture fixture executes them so the deferred broadcast is observable.
        with django_capture_on_commit_callbacks(execute=True):
            resp = owner_client.post(
                REORDER_URL.format(pk=project.pk),
                {"stories": [_entry(b), _entry(a)]},
                format="json",
            )
        assert resp.status_code == 200
    spy.assert_called_once_with(
        str(project.pk), "backlog_reranked", {"project_id": str(project.pk)}
    )


# --------------------------------------------------------------------------- #
# Product Owner facet widens the backlog-manager gate (ADR-0078/#1095)
# --------------------------------------------------------------------------- #
#
# The on_commit signal that auto-creates the default team + team membership does
# NOT fire inside a plain ``django_db`` transaction, so these tests materialize the
# default team and the facet-bearing membership row explicitly — the same pattern
# the teams-services tests use.


def _grant_facet(
    project: Project,
    user: object,
    *,
    is_product_owner: bool = False,
    is_scrum_master: bool = False,
) -> None:
    """Create the project's default team and a facet-bearing membership for ``user``.

    Mirrors the production invariant (one default team per project; facets live on
    the TeamMembership row) without relying on the on_commit mirror signal, which
    does not run under the test transaction.
    """
    team, _ = Team.objects.get_or_create(
        project=project,
        is_default=True,
        is_deleted=False,
        defaults={"name": "Default Team", "short_id": "T01", "server_version": 1},
    )
    TeamMembership.objects.update_or_create(
        team=team,
        user=user,
        is_deleted=False,
        defaults={
            "role": TeamRole.MEMBER,
            "is_product_owner": is_product_owner,
            "is_scrum_master": is_scrum_master,
        },
    )


def test_product_owner_facet_member_can_auto_rank(project: Project, member: object) -> None:
    """A Member holding the PO facet may auto-rank — the facet widens the Admin-only gate."""
    _grant_facet(project, member, is_product_owner=True)
    client = APIClient()
    client.force_authenticate(user=member)
    resp = client.post(
        f"/api/v1/projects/{project.pk}/product-backlog/auto-rank/", {}, format="json"
    )
    assert resp.status_code == 200


def test_product_owner_facet_member_can_reorder(project: Project, member: object) -> None:
    """A Member holding the PO facet may manually reorder the backlog."""
    _grant_facet(project, member, is_product_owner=True)
    a = _story(project, name="a", priority_rank=1)
    b = _story(project, name="b", priority_rank=2)
    client = APIClient()
    client.force_authenticate(user=member)
    resp = client.post(
        REORDER_URL.format(pk=project.pk),
        {"stories": [_entry(b), _entry(a)]},
        format="json",
    )
    assert resp.status_code == 200
    a.refresh_from_db()
    b.refresh_from_db()
    assert (b.priority_rank, a.priority_rank) == (1, 2)


def test_product_owner_facet_member_can_write_scoring(project: Project, member: object) -> None:
    """The PO facet also widens the serializer-level structural-field gate (scoring)."""
    _grant_facet(project, member, is_product_owner=True)
    t = _story(project, name="s")
    client = APIClient()
    client.force_authenticate(user=member)
    resp = client.patch(f"/api/v1/tasks/{t.pk}/", {"business_value": 9}, format="json")
    assert resp.status_code == 200


def test_product_owner_facet_does_not_widen_writes_to_schedule_tasks(
    project: Project, member: object
) -> None:
    """The PO write-widening is scoped to EPIC/STORY work items — a PO facet must not
    grant a non-Admin write access to an unowned schedule task (type=task)."""
    _grant_facet(project, member, is_product_owner=True)
    t = _story(project, name="sched", type=TaskType.TASK, status=TaskStatus.NOT_STARTED)
    client = APIClient()
    client.force_authenticate(user=member)
    resp = client.patch(f"/api/v1/tasks/{t.pk}/", {"name": "renamed"}, format="json")
    assert resp.status_code == 403


def test_product_owner_facet_cannot_delete_unowned_story(project: Project, member: object) -> None:
    """The PO write-widening is edit-only — deleting another member's story stays an
    Admin/assignee act, so a PO-facet Member cannot DELETE an unowned STORY."""
    _grant_facet(project, member, is_product_owner=True)
    t = _story(project, name="del-me")
    client = APIClient()
    client.force_authenticate(user=member)
    resp = client.delete(f"/api/v1/tasks/{t.pk}/")
    assert resp.status_code == 403


def test_scrum_master_facet_member_still_denied_backlog(project: Project, member: object) -> None:
    """The SM facet does NOT grant backlog management — only the PO facet does."""
    _grant_facet(project, member, is_scrum_master=True)
    client = APIClient()
    client.force_authenticate(user=member)
    resp = client.post(
        f"/api/v1/projects/{project.pk}/product-backlog/auto-rank/", {}, format="json"
    )
    assert resp.status_code == 403


def test_plain_member_without_facet_denied_backlog(project: Project, member: object) -> None:
    """A Member with no facet remains denied (the unchanged Admin-only baseline)."""
    _grant_facet(project, member)  # team membership but no facet
    client = APIClient()
    client.force_authenticate(user=member)
    resp = client.post(
        f"/api/v1/projects/{project.pk}/product-backlog/auto-rank/", {}, format="json"
    )
    assert resp.status_code == 403


# --------------------------------------------------------------------------- #
# my_facets exposure on the project detail serializer (#1095)
# --------------------------------------------------------------------------- #


def test_project_detail_my_facets_reflects_product_owner(project: Project, member: object) -> None:
    """Project detail GET exposes the caller's own facets; PO sees is_product_owner=true."""
    _grant_facet(project, member, is_product_owner=True)
    client = APIClient()
    client.force_authenticate(user=member)
    resp = client.get(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code == 200
    assert resp.data["my_facets"] == {
        "is_scrum_master": False,
        "is_product_owner": True,
    }


def test_project_detail_my_facets_false_for_non_facet_member(
    project: Project, member: object
) -> None:
    """A member with no facet sees both flags False."""
    client = APIClient()
    client.force_authenticate(user=member)
    resp = client.get(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code == 200
    assert resp.data["my_facets"] == {
        "is_scrum_master": False,
        "is_product_owner": False,
    }
