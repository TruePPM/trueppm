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
    DorTransitionError,
    auto_rank,
    compute_score,
    dor_blockers,
    mark_ready,
    seed_sprint_rank,
    split_story,
)

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
