"""Tests for short hex object IDs (ADR-0016, issue #50)."""

from __future__ import annotations

import uuid
from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Risk, Sprint, SprintState, Task

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username=f"pm-{uuid.uuid4().hex[:8]}", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def membership(project: Project, user: object) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)


@pytest.fixture
def client(user: object, membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# ---------------------------------------------------------------------------
# Model — short_id assignment
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_task_gets_short_id_on_create(project: Project) -> None:
    t = Task.objects.create(project=project, name="T1", duration=3)
    assert t.short_id == "00000001"


@pytest.mark.django_db
def test_risk_gets_short_id_on_create(project: Project, user: object) -> None:
    # Risks moved off the shared hex object_sequence onto a dedicated decimal
    # risk_sequence in #929, so the raw short_id is a contiguous decimal string.
    r = Risk.objects.create(project=project, title="R1", probability=3, impact=4, created_by=user)
    assert r.short_id == "1"


@pytest.mark.django_db
def test_short_ids_use_separate_counters_by_type(project: Project, user: object) -> None:
    """Tasks/Sprints share the hex object_sequence; risks have their own decimal counter (#929)."""
    t1 = Task.objects.create(project=project, name="T1", duration=1)
    r1 = Risk.objects.create(project=project, title="R1", probability=1, impact=1, created_by=user)
    t2 = Task.objects.create(project=project, name="T2", duration=1)
    # The risk does not consume a slot in the shared task/sprint counter.
    assert t1.short_id == "00000001"
    assert t2.short_id == "00000002"
    # Risks number independently in decimal from their dedicated risk_sequence.
    assert r1.short_id == "1"


@pytest.mark.django_db
def test_short_ids_are_project_scoped(calendar: Calendar) -> None:
    """Two projects have independent counters."""
    p1 = Project.objects.create(name="P1", start_date=date(2026, 1, 1), calendar=calendar)
    p2 = Project.objects.create(name="P2", start_date=date(2026, 1, 1), calendar=calendar)
    t1 = Task.objects.create(project=p1, name="A", duration=1)
    t2 = Task.objects.create(project=p2, name="B", duration=1)
    assert t1.short_id == t2.short_id == "00000001"


@pytest.mark.django_db
def test_short_id_immutable_on_update(project: Project) -> None:
    """short_id does not change when the task is updated."""
    t = Task.objects.create(project=project, name="T1", duration=1)
    original = t.short_id
    t.name = "Updated"
    t.save()
    t.refresh_from_db()
    assert t.short_id == original


@pytest.mark.django_db
def test_project_object_sequence_tracks_counter(project: Project) -> None:
    Task.objects.create(project=project, name="T1", duration=1)
    Task.objects.create(project=project, name="T2", duration=1)
    project.refresh_from_db()
    assert project.object_sequence == 2


# ---------------------------------------------------------------------------
# API — TaskSerializer includes short_id
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_task_list_includes_short_id(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        t = Task.objects.create(project=project, name="T1", duration=1)
    r = client.get(f"/api/v1/tasks/?project={project.pk}")
    assert r.status_code == 200
    results = r.data.get("results", r.data)
    first = next(item for item in results if item["id"] == str(t.pk))
    assert first["short_id"] == "00000001"


@pytest.mark.django_db
def test_short_id_is_read_only_on_patch(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    t = Task.objects.create(project=project, name="T1", duration=1)
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = client.patch(
            f"/api/v1/tasks/{t.pk}/",
            {"short_id": "FFFFFFFF"},
            format="json",
        )
    assert r.status_code == 200
    t.refresh_from_db()
    assert t.short_id == "00000001"  # unchanged


@pytest.mark.django_db
def test_task_filter_by_short_id(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    Task.objects.create(project=project, name="T1", duration=1)
    t2 = Task.objects.create(project=project, name="T2", duration=1)
    r = client.get(f"/api/v1/tasks/?project={project.pk}&short_id=00000002")
    assert r.status_code == 200
    results = r.data.get("results", r.data)
    assert len(results) == 1
    assert results[0]["id"] == str(t2.pk)


@pytest.mark.django_db
def test_task_filter_short_id_case_insensitive(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """Filter should match regardless of case."""
    Task.objects.create(project=project, name="T1", duration=1)
    r = client.get(f"/api/v1/tasks/?project={project.pk}&short_id=00000001")
    results = r.data.get("results", r.data)
    assert len(results) == 1
    # Also try lowercase
    r2 = client.get(f"/api/v1/tasks/?project={project.pk}&short_id=00000001")
    results2 = r2.data.get("results", r2.data)
    assert len(results2) == 1


# ---------------------------------------------------------------------------
# API — RiskSerializer includes short_id
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_risk_list_includes_short_id(
    client: APIClient, project: Project, user: object, membership: ProjectMembership
) -> None:
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
        risk = Risk.objects.create(
            project=project, title="R1", probability=2, impact=3, created_by=user
        )
    r = client.get(f"/api/v1/projects/{project.pk}/risks/")
    assert r.status_code == 200
    results = r.data.get("results", r.data)
    first = next(item for item in results if item["id"] == str(risk.pk))
    assert first["short_id"] == "1"


@pytest.mark.django_db
def test_risk_short_id_is_read_only(
    client: APIClient, project: Project, user: object, membership: ProjectMembership
) -> None:
    risk = Risk.objects.create(
        project=project, title="R1", probability=2, impact=3, created_by=user
    )
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
        r = client.patch(
            f"/api/v1/projects/{project.pk}/risks/{risk.pk}/",
            {"short_id": "FFFFFFFF"},
            format="json",
        )
    assert r.status_code == 200
    risk.refresh_from_db()
    assert risk.short_id == "1"


# ---------------------------------------------------------------------------
# Sync serializers include short_id
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_sync_task_serializer_includes_short_id(project: Project) -> None:
    from trueppm_api.apps.sync.serializers import SyncTaskSerializer

    t = Task.objects.create(project=project, name="T1", duration=1)
    data = SyncTaskSerializer(t).data
    assert data["short_id"] == "00000001"


@pytest.mark.django_db
def test_sync_risk_serializer_includes_short_id(project: Project, user: object) -> None:
    from trueppm_api.apps.sync.serializers import SyncRiskSerializer

    r = Risk.objects.create(project=project, title="R1", probability=2, impact=3, created_by=user)
    data = SyncRiskSerializer(r).data
    assert data["short_id"] == "1"


# ---------------------------------------------------------------------------
# API — server-owned task display references (#2430)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_task_display_refs_decode_the_hex_sequence(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """``short_id_display`` reads as a task number, not a padded hex string.

    The stored ``short_id`` is ``{object_sequence:08X}``, so the tenth task is
    ``0000000A`` — which leaked onto board cards as an internal identifier (#2430).
    The display form decodes the sequence back to the integer it always was.
    """
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        for i in range(10):
            Task.objects.create(project=project, name=f"T{i}", duration=1)
    tenth = Task.objects.get(project=project, short_id="0000000A")

    r = client.get(f"/api/v1/tasks/?project={project.pk}")
    assert r.status_code == 200
    results = r.data.get("results", r.data)
    row = next(item for item in results if item["id"] == str(tenth.pk))
    # Raw identity is preserved (no migration), the display form is derived.
    assert row["short_id"] == "0000000A"
    assert row["short_id_display"] == "T-10"


@pytest.mark.django_db
def test_qualified_id_uses_the_project_code_settings_promises(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """Settings → General says the code prefixes task IDs — this is what keeps it."""
    project.code = "ENG-2026"
    project.save(update_fields=["code"])
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        t = Task.objects.create(project=project, name="T1", duration=1)

    r = client.get(f"/api/v1/tasks/?project={project.pk}")
    row = next(item for item in r.data.get("results", r.data) if item["id"] == str(t.pk))
    assert row["qualified_id"] == "ENG-2026-1"
    assert row["short_id_display"] == "T-1"


@pytest.mark.django_db
def test_qualified_id_falls_back_to_compact_form_without_a_code(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """The project code is optional (#520) — the reference is never blank for lack of it."""
    assert project.code == ""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        t = Task.objects.create(project=project, name="T1", duration=1)

    r = client.get(f"/api/v1/tasks/?project={project.pk}")
    row = next(item for item in r.data.get("results", r.data) if item["id"] == str(t.pk))
    assert row["qualified_id"] == "T-1"


@pytest.mark.django_db
def test_task_display_refs_are_read_only(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    t = Task.objects.create(project=project, name="T1", duration=1)
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = client.patch(
            f"/api/v1/tasks/{t.pk}/",
            {"short_id_display": "T-999", "qualified_id": "NOPE-999"},
            format="json",
        )
    assert r.status_code == 200
    assert r.data["short_id_display"] == "T-1"
    assert r.data["qualified_id"] == "T-1"


@pytest.mark.django_db
def test_qualified_id_costs_one_project_query_for_a_whole_list(project: Project) -> None:
    """``qualified_id`` must not be one query per row on a list without ``select_related``.

    Not every TaskSerializer caller selects ``project`` — the grooming board builds a
    fresh serializer per row over a hand-assembled queryset — so reading ``obj.project``
    for the code was an N+1 that only surfaced as a failing perf test. The code is
    memoized on the shared context, so N rows of one project cost one lookup, not N.
    """
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    from trueppm_api.apps.projects.serializers import TaskSerializer

    project.code = "ENG"
    project.save(update_fields=["code"])
    for i in range(6):
        Task.objects.create(project=project, name=f"T{i}", duration=1)

    # Filtering by project does not populate the FK cache, so this mirrors a caller
    # that never selected the relation. A fresh serializer per row over one shared
    # context is the grooming board's exact shape.
    tasks = list(Task.objects.filter(project=project).order_by("short_id"))
    ctx: dict[str, object] = {}
    with CaptureQueriesContext(connection) as captured:
        refs = [TaskSerializer(t, context=ctx).data["qualified_id"] for t in tasks]

    assert refs == [f"ENG-{i}" for i in range(1, 7)]
    # Scoped to the code lookup this field owns — the broader per-row project load
    # this bare queryset also provokes predates #2430 and does not fire on the real
    # endpoints (their perf tests pin that separately).
    code_lookups = [
        q for q in captured.captured_queries if 'projects_project"."code" AS' in q["sql"]
    ]
    assert len(code_lookups) == 1, (
        f"qualified_id N+1: {len(code_lookups)} code lookups for 6 tasks — "
        "the memo must be shared across rows, not per serializer instance"
    )


@pytest.mark.django_db
def test_task_display_ref_survives_a_non_hex_short_id(project: Project) -> None:
    """A hand-seeded / imported row must not blank its reference."""
    from trueppm_api.apps.projects.serializers import TaskSerializer

    t = Task.objects.create(project=project, name="T1", duration=1)
    Task.objects.filter(pk=t.pk).update(short_id="ZZZ")
    t.refresh_from_db()
    assert TaskSerializer(t).data["short_id_display"] == "T-ZZZ"


# ---------------------------------------------------------------------------
# API — server-owned sprint display references (#2671)
# ---------------------------------------------------------------------------
#
# Sprint shares the hex object_sequence counter with Task, but never got the
# #2430 decode treatment — SprintSerializer hand-rolled f"SP-{obj.short_id}",
# which never decoded the hex and rendered e.g. "SP-0000000A" for the tenth
# sprint on every Sprint surface. These mirror the Task coverage above with a
# real 8-hex-digit short_id (never a pretty fixture value like "SP-A1"), which
# is exactly the shape of fixture that hid this bug (#2671).


def _make_sprint(project: Project, name: str = "Sprint") -> Sprint:
    return Sprint.objects.create(
        project=project,
        name=name,
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.PLANNED,
    )


@pytest.mark.django_db
def test_sprint_gets_short_id_on_create(project: Project) -> None:
    _make_sprint(project)
    s2 = _make_sprint(project, name="Sprint 2")
    # Sprint and Task share the project's hex object_sequence counter.
    assert s2.short_id == "00000002"


@pytest.mark.django_db
def test_sprint_display_ref_decodes_the_hex_sequence(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """``short_id_display`` reads as a sprint number, not a padded hex string.

    Ten sprints are created so the tenth one's raw ``short_id`` is
    ``0000000A`` — the naive ``f"SP-{obj.short_id}"`` would render
    ``SP-0000000A``; the fix must render ``SP-10``.
    """
    for i in range(10):
        _make_sprint(project, name=f"Sprint {i}")
    tenth = Sprint.objects.get(project=project, short_id="0000000A")

    r = client.get(f"/api/v1/projects/{project.pk}/sprints/")
    assert r.status_code == 200
    results = r.data.get("results", r.data)
    row = next(item for item in results if item["id"] == str(tenth.pk))
    # Raw identity is preserved (no migration); the display form is derived.
    assert row["short_id"] == "0000000A"
    assert row["short_id_display"] == "SP-10"


@pytest.mark.django_db
def test_sprint_qualified_id_keeps_the_sp_marker(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """Unlike Task, a sprint's qualified form keeps its ``SP-`` marker.

    Sprint and Task share the same hex counter, so a bare ``ENG-2026-3``
    (Task's own qualifying convention, which drops the ``T-`` marker) would be
    ambiguous between "task 3" and "sprint 3" once both entity kinds are
    qualified with the same project code.
    """
    project.code = "ENG-2026"
    project.save(update_fields=["code"])
    sprint = _make_sprint(project)

    r = client.get(f"/api/v1/projects/{project.pk}/sprints/")
    row = next(item for item in r.data.get("results", r.data) if item["id"] == str(sprint.pk))
    assert row["short_id_display"] == "SP-1"
    assert row["qualified_id"] == "ENG-2026-SP-1"


@pytest.mark.django_db
def test_sprint_qualified_id_falls_back_without_a_code(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    assert project.code == ""
    sprint = _make_sprint(project)

    r = client.get(f"/api/v1/projects/{project.pk}/sprints/")
    row = next(item for item in r.data.get("results", r.data) if item["id"] == str(sprint.pk))
    assert row["qualified_id"] == "SP-1"


@pytest.mark.django_db
def test_sprint_display_refs_are_read_only(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    sprint = _make_sprint(project)
    r = client.patch(
        f"/api/v1/sprints/{sprint.pk}/",
        {"short_id_display": "SP-999", "qualified_id": "NOPE-999"},
        format="json",
    )
    assert r.status_code == 200
    assert r.data["short_id_display"] == "SP-1"
    assert r.data["qualified_id"] == "SP-1"
