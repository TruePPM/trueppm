"""POST /projects/{id}/sprints/generate/ — the cadence generator (#2968).

Covers the four properties the endpoint exists to guarantee — calendar-aware
boundaries, an editable preview that writes nothing, idempotency on name, and a
bulk-size bound — plus the permission matrix across all five roles.
"""

from __future__ import annotations

from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    CalendarException,
    Project,
    Sprint,
    SprintState,
)
from trueppm_api.apps.projects.sprint_cadence import (
    CAPACITY_HINT_NOTE,
    CAPACITY_HINT_NOTE_NO_HISTORY,
    MAX_GENERATED_SPRINTS,
    render_sprint_name,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    """Mon–Fri, no holidays — the default working week."""
    return Calendar.objects.create(name="Standard", working_days=31)


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 4, 1), calendar=calendar)


def _member(project: Project, username: str, role: int) -> Any:
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    return user


@pytest.fixture
def owner(project: Project) -> Any:
    return _member(project, "owner", Role.OWNER)


@pytest.fixture
def client(owner: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=owner)
    return c


def url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/sprints/generate/"


def body(**overrides: Any) -> dict[str, Any]:
    """A minimal valid request: four two-week iterations from a Monday."""
    payload: dict[str, Any] = {
        "count": 4,
        "start_date": "2026-04-06",  # a Monday
        "length_days": 10,
    }
    payload.update(overrides)
    return payload


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_generates_contiguous_two_week_iterations(client: APIClient, project: Project) -> None:
    res = client.post(url(project), body(), format="json")

    assert res.status_code == 201, res.data
    assert res.data["created_count"] == 4
    assert res.data["skipped_count"] == 0
    assert res.data["dry_run"] is False

    rows = res.data["sprints"]
    assert [r["name"] for r in rows] == ["Sprint 1", "Sprint 2", "Sprint 3", "Sprint 4"]
    # Mon 6 Apr + 10 working days -> Fri 17 Apr; next starts Mon 20 Apr.
    assert str(rows[0]["start_date"]) == "2026-04-06"
    assert str(rows[0]["finish_date"]) == "2026-04-17"
    assert str(rows[1]["start_date"]) == "2026-04-20"
    assert str(rows[1]["finish_date"]) == "2026-05-01"
    assert all(r["working_days"] == 10 for r in rows)
    assert all(r["status"] == "created" for r in rows)
    assert all(r["id"] is not None for r in rows)

    stored = list(Sprint.objects.filter(project=project).order_by("start_date"))
    assert len(stored) == 4
    assert all(s.state == SprintState.PLANNED for s in stored)
    assert all(s.created_by_id is not None for s in stored)
    # short_id comes from Sprint.save(); bulk_create would have left it blank.
    assert all(s.short_id for s in stored)
    assert len({s.short_id for s in stored}) == 4
    # server_version is what the sync delta pulls on; bulk_create bypasses it.
    assert all(s.server_version > 0 for s in stored)


@pytest.mark.django_db
def test_response_shape_matches_the_declared_schema(client: APIClient, project: Project) -> None:
    """No undeclared keys leak — the view builds rows from `asdict(CadenceRow)`,
    which carries an internal `exists` flag the serializer must not emit."""
    res = client.post(url(project), body(count=1), format="json")

    assert set(res.data) == {
        "dry_run",
        "sprints",
        "created_count",
        "skipped_count",
        "capacity_hint",
    }
    assert set(res.data["sprints"][0]) == {
        "name",
        "start_date",
        "finish_date",
        "working_days",
        "non_working_days_skipped",
        "status",
        "id",
    }
    assert set(res.data["capacity_hint"]) == {
        "points",
        "basis",
        "sprints_sampled",
        "note",
    }


@pytest.mark.django_db
def test_start_date_snaps_forward_off_a_weekend(client: APIClient, project: Project) -> None:
    # 2026-04-04 is a Saturday.
    res = client.post(url(project), body(count=1, start_date="2026-04-04"), format="json")

    assert res.status_code == 201, res.data
    assert str(res.data["sprints"][0]["start_date"]) == "2026-04-06"


@pytest.mark.django_db
def test_name_pattern_and_first_index_are_honored(client: APIClient, project: Project) -> None:
    res = client.post(
        url(project),
        body(count=3, name_pattern="Iteration {n} — Q2", first_index=7),
        format="json",
    )

    assert res.status_code == 201, res.data
    assert [r["name"] for r in res.data["sprints"]] == [
        "Iteration 7 — Q2",
        "Iteration 8 — Q2",
        "Iteration 9 — Q2",
    ]


@pytest.mark.django_db
def test_name_pattern_must_contain_the_token(client: APIClient, project: Project) -> None:
    res = client.post(url(project), body(name_pattern="Sprint"), format="json")

    assert res.status_code == 400
    assert "name_pattern" in res.data
    assert Sprint.objects.filter(project=project).count() == 0


@pytest.mark.django_db
def test_name_pattern_is_not_a_format_string(project: Project) -> None:
    """``{n}`` is substituted literally — no ``str.format`` attribute traversal."""
    assert render_sprint_name("Sprint {n} {0.__class__}", 3) == "Sprint 3 {0.__class__}"


# ---------------------------------------------------------------------------
# Calendar awareness
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_holiday_lengthens_the_window_rather_than_shrinking_the_iteration(
    client: APIClient, project: Project, calendar: Calendar
) -> None:
    # A three-day shutdown mid-iteration (Wed 8 – Fri 10 April).
    CalendarException.objects.create(
        calendar=calendar,
        exc_start=date(2026, 4, 8),
        exc_end=date(2026, 4, 10),
        description="Spring shutdown",
    )

    res = client.post(url(project), body(count=1), format="json")

    assert res.status_code == 201, res.data
    row = res.data["sprints"][0]
    assert str(row["start_date"]) == "2026-04-06"
    # The iteration still holds ten working days; three non-working days were
    # skipped, so the finish moves out from Fri 17 Apr to Wed 22 Apr.
    assert str(row["finish_date"]) == "2026-04-22"
    assert row["working_days"] == 10
    # Every non-working day the window spans: three shutdown days plus two
    # weekends. Without the shutdown the same ten working days would have
    # finished on Fri 17 April spanning only four non-working days.
    assert row["non_working_days_skipped"] == 7


@pytest.mark.django_db
def test_start_snaps_past_a_holiday_range(
    client: APIClient, project: Project, calendar: Calendar
) -> None:
    CalendarException.objects.create(
        calendar=calendar, exc_start=date(2026, 4, 6), exc_end=date(2026, 4, 8)
    )

    res = client.post(url(project), body(count=1, start_date="2026-04-06"), format="json")

    assert res.status_code == 201, res.data
    assert str(res.data["sprints"][0]["start_date"]) == "2026-04-09"


@pytest.mark.django_db
def test_overlay_calendar_layers_are_composed(
    client: APIClient, project: Project, calendar: Calendar
) -> None:
    """The generator reads the *composed* calendar, not just ``project.calendar``."""
    from trueppm_api.apps.projects.models import ProjectCalendarLayer

    holidays = Calendar.objects.create(name="Public holidays", working_days=31)
    CalendarException.objects.create(
        calendar=holidays, exc_start=date(2026, 4, 6), exc_end=date(2026, 4, 6)
    )
    ProjectCalendarLayer.objects.create(project=project, calendar=holidays)

    res = client.post(url(project), body(count=1, start_date="2026-04-06"), format="json")

    assert res.status_code == 201, res.data
    # Monday 6 April is non-working only under the overlay.
    assert str(res.data["sprints"][0]["start_date"]) == "2026-04-07"


@pytest.mark.django_db
def test_degenerate_calendar_is_a_400_not_a_hang(
    client: APIClient, project: Project, calendar: Calendar
) -> None:
    """Two overlays with disjoint masks compose to 'no working day ever'."""
    from trueppm_api.apps.projects.models import ProjectCalendarLayer

    weekend_only = Calendar.objects.create(name="Weekend", working_days=96)  # Sat|Sun
    ProjectCalendarLayer.objects.create(project=project, calendar=weekend_only)

    res = client.post(url(project), body(count=1), format="json")

    assert res.status_code == 400
    assert "calendar" in res.data["detail"].lower()
    assert Sprint.objects.filter(project=project).count() == 0


# ---------------------------------------------------------------------------
# Preview
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_dry_run_writes_nothing(client: APIClient, project: Project) -> None:
    res = client.post(url(project), body(count=12, dry_run=True), format="json")

    assert res.status_code == 200, res.data
    assert res.data["dry_run"] is True
    assert res.data["created_count"] == 12
    assert len(res.data["sprints"]) == 12
    assert all(r["status"] == "new" for r in res.data["sprints"])
    assert all(r["id"] is None for r in res.data["sprints"])
    assert Sprint.objects.filter(project=project).count() == 0


@pytest.mark.django_db
def test_dry_run_and_commit_agree_on_the_boundaries(
    client: APIClient, project: Project, calendar: Calendar
) -> None:
    CalendarException.objects.create(
        calendar=calendar, exc_start=date(2026, 4, 13), exc_end=date(2026, 4, 14)
    )
    preview = client.post(url(project), body(count=6, dry_run=True), format="json")
    committed = client.post(url(project), body(count=6), format="json")

    assert preview.status_code == 200
    assert committed.status_code == 201
    keys = ("name", "start_date", "finish_date", "working_days", "non_working_days_skipped")
    assert [{k: r[k] for k in keys} for r in preview.data["sprints"]] == [
        {k: r[k] for k in keys} for r in committed.data["sprints"]
    ]


@pytest.mark.django_db
def test_edited_preview_rows_are_committed_verbatim(client: APIClient, project: Project) -> None:
    """The operator's edits win — the generator's rules are not re-applied."""
    res = client.post(
        url(project),
        {
            "sprints": [
                {"name": "Hardening", "start_date": "2026-04-06", "finish_date": "2026-04-10"},
                {"name": "Sprint 12", "start_date": "2026-04-13", "finish_date": "2026-04-30"},
            ]
        },
        format="json",
    )

    assert res.status_code == 201, res.data
    assert res.data["created_count"] == 2
    stored = list(Sprint.objects.filter(project=project).order_by("start_date"))
    assert [s.name for s in stored] == ["Hardening", "Sprint 12"]
    assert stored[0].start_date == date(2026, 4, 6)
    assert stored[0].finish_date == date(2026, 4, 10)
    # The calendar read-out stays server-computed even on an edited row.
    assert res.data["sprints"][0]["working_days"] == 5
    assert res.data["sprints"][0]["non_working_days_skipped"] == 0
    # Mon 13 Apr – Thu 30 Apr: 18 days spanned, two weekends inside.
    assert res.data["sprints"][1]["working_days"] == 14
    assert res.data["sprints"][1]["non_working_days_skipped"] == 4


@pytest.mark.django_db
def test_edited_row_with_finish_on_start_is_rejected(client: APIClient, project: Project) -> None:
    """The model's CheckConstraint is strict; a same-day window is a 400, not a 500."""
    res = client.post(
        url(project),
        {"sprints": [{"name": "One day", "start_date": "2026-04-06", "finish_date": "2026-04-06"}]},
        format="json",
    )

    assert res.status_code == 400
    assert Sprint.objects.filter(project=project).count() == 0


@pytest.mark.django_db
def test_edited_rows_must_have_unique_names(client: APIClient, project: Project) -> None:
    res = client.post(
        url(project),
        {
            "sprints": [
                {"name": "Dup", "start_date": "2026-04-06", "finish_date": "2026-04-10"},
                {"name": "Dup", "start_date": "2026-04-13", "finish_date": "2026-04-17"},
            ]
        },
        format="json",
    )

    assert res.status_code == 400
    assert Sprint.objects.filter(project=project).count() == 0


# ---------------------------------------------------------------------------
# Idempotency on name
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_double_submit_creates_one_set(client: APIClient, project: Project) -> None:
    first = client.post(url(project), body(count=6), format="json")
    second = client.post(url(project), body(count=6), format="json")

    assert first.status_code == 201
    assert first.data["created_count"] == 6
    assert second.status_code == 201
    assert second.data["created_count"] == 0
    assert second.data["skipped_count"] == 6
    assert all(r["status"] == "exists" for r in second.data["sprints"])
    assert all(r["id"] is None for r in second.data["sprints"])
    assert Sprint.objects.filter(project=project).count() == 6


@pytest.mark.django_db
def test_partial_overlap_fills_only_the_gap(client: APIClient, project: Project) -> None:
    Sprint.objects.create(
        project=project,
        name="Sprint 2",
        start_date=date(2026, 1, 5),
        finish_date=date(2026, 1, 16),
    )

    res = client.post(url(project), body(count=4), format="json")

    assert res.status_code == 201, res.data
    assert res.data["created_count"] == 3
    assert res.data["skipped_count"] == 1
    statuses = {r["name"]: r["status"] for r in res.data["sprints"]}
    assert statuses["Sprint 2"] == "exists"
    assert statuses["Sprint 1"] == "created"
    # The pre-existing sprint's dates are untouched — generation never overwrites.
    existing = Sprint.objects.get(project=project, name="Sprint 2")
    assert existing.start_date == date(2026, 1, 5)


@pytest.mark.django_db
def test_a_soft_deleted_name_is_free_again(client: APIClient, project: Project) -> None:
    sprint = Sprint.objects.create(
        project=project,
        name="Sprint 1",
        start_date=date(2026, 1, 5),
        finish_date=date(2026, 1, 16),
    )
    sprint.soft_delete()

    res = client.post(url(project), body(count=1), format="json")

    assert res.status_code == 201, res.data
    assert res.data["created_count"] == 1


@pytest.mark.django_db
def test_another_projects_sprint_names_do_not_collide(
    client: APIClient, project: Project, calendar: Calendar
) -> None:
    other = Project.objects.create(name="Beta", start_date=date(2026, 4, 1), calendar=calendar)
    Sprint.objects.create(
        project=other,
        name="Sprint 1",
        start_date=date(2026, 1, 5),
        finish_date=date(2026, 1, 16),
    )

    res = client.post(url(project), body(count=1), format="json")

    assert res.status_code == 201, res.data
    assert res.data["created_count"] == 1


# ---------------------------------------------------------------------------
# Bulk-size bound
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_count_above_the_bound_is_rejected(client: APIClient, project: Project) -> None:
    res = client.post(url(project), body(count=MAX_GENERATED_SPRINTS + 1), format="json")

    assert res.status_code == 400
    assert "count" in res.data
    assert Sprint.objects.filter(project=project).count() == 0


@pytest.mark.django_db
def test_count_at_the_bound_is_accepted(client: APIClient, project: Project) -> None:
    res = client.post(url(project), body(count=MAX_GENERATED_SPRINTS, length_days=2), format="json")

    assert res.status_code == 201, res.data
    assert res.data["created_count"] == MAX_GENERATED_SPRINTS


@pytest.mark.django_db
def test_edited_row_list_above_the_bound_is_rejected(client: APIClient, project: Project) -> None:
    rows = [
        {
            "name": f"Sprint {i}",
            "start_date": "2026-04-06",
            "finish_date": "2026-04-10",
        }
        for i in range(MAX_GENERATED_SPRINTS + 1)
    ]

    res = client.post(url(project), {"sprints": rows}, format="json")

    assert res.status_code == 400
    assert Sprint.objects.filter(project=project).count() == 0


@pytest.mark.django_db
def test_single_working_day_length_is_rejected(client: APIClient, project: Project) -> None:
    res = client.post(url(project), body(length_days=1), format="json")

    assert res.status_code == 400
    assert "length_days" in res.data


@pytest.mark.django_db
def test_count_and_start_date_required_without_an_edit_list(
    client: APIClient, project: Project
) -> None:
    res = client.post(url(project), {"length_days": 10}, format="json")

    assert res.status_code == 400
    assert "count" in res.data
    assert "start_date" in res.data


# ---------------------------------------------------------------------------
# Capacity — a planning aid, never a cap
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_generation_never_stores_a_capacity_on_its_own(client: APIClient, project: Project) -> None:
    res = client.post(url(project), body(count=4), format="json")

    assert res.status_code == 201, res.data
    assert all(s.capacity_points is None for s in Sprint.objects.filter(project=project)), (
        "the generator must not stamp a ceiling onto a cadence"
    )


@pytest.mark.django_db
def test_capacity_hint_is_null_without_velocity_history(
    client: APIClient, project: Project
) -> None:
    res = client.post(url(project), body(dry_run=True), format="json")

    hint = res.data["capacity_hint"]
    assert hint["points"] is None
    assert hint["basis"] == "no_history"
    assert hint["sprints_sampled"] == 0
    assert hint["note"] == CAPACITY_HINT_NOTE_NO_HISTORY


@pytest.mark.django_db
def test_capacity_hint_averages_closed_iterations(client: APIClient, project: Project) -> None:
    from django.utils import timezone

    for index, points in enumerate((20, 24, 28)):
        Sprint.objects.create(
            project=project,
            name=f"Closed {index}",
            start_date=date(2026, 1, 5),
            finish_date=date(2026, 1, 16),
            state=SprintState.COMPLETED,
            completed_points=points,
            closed_at=timezone.now(),
        )

    res = client.post(url(project), body(dry_run=True), format="json")

    hint = res.data["capacity_hint"]
    assert hint["points"] == 24
    assert hint["basis"] == "velocity_average"
    assert hint["sprints_sampled"] == 3
    # The sentence that bounds the number travels with it, always.
    assert hint["note"] == CAPACITY_HINT_NOTE
    assert "not a limit" in hint["note"]


@pytest.mark.django_db
def test_capacity_hint_honors_exclude_from_velocity(client: APIClient, project: Project) -> None:
    from django.utils import timezone

    Sprint.objects.create(
        project=project,
        name="Sprint 0",
        start_date=date(2026, 1, 5),
        finish_date=date(2026, 1, 16),
        state=SprintState.COMPLETED,
        completed_points=2,
        exclude_from_velocity=True,
        closed_at=timezone.now(),
    )
    Sprint.objects.create(
        project=project,
        name="Closed 1",
        start_date=date(2026, 1, 19),
        finish_date=date(2026, 1, 30),
        state=SprintState.COMPLETED,
        completed_points=30,
        closed_at=timezone.now(),
    )

    res = client.post(url(project), body(dry_run=True), format="json")

    assert res.data["capacity_hint"]["points"] == 30
    assert res.data["capacity_hint"]["sprints_sampled"] == 1


@pytest.mark.django_db
def test_explicit_capacity_lands_on_the_first_iteration_only(
    client: APIClient, project: Project
) -> None:
    res = client.post(url(project), body(count=3, first_sprint_capacity_points=26), format="json")

    assert res.status_code == 201, res.data
    stored = list(Sprint.objects.filter(project=project).order_by("start_date"))
    assert stored[0].capacity_points == 26
    assert stored[1].capacity_points is None
    assert stored[2].capacity_points is None


# ---------------------------------------------------------------------------
# Permissions — all five roles
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("role", "expected"),
    [
        (Role.VIEWER, 403),
        (Role.MEMBER, 201),
        (Role.SCHEDULER, 201),
        (Role.ADMIN, 201),
        (Role.OWNER, 201),
    ],
)
def test_generate_permission_matrix(project: Project, role: int, expected: int) -> None:
    user = _member(project, f"u{int(role)}", role)
    client = APIClient()
    client.force_authenticate(user=user)

    res = client.post(url(project), body(count=1), format="json")

    assert res.status_code == expected, res.data
    assert Sprint.objects.filter(project=project).count() == (1 if expected == 201 else 0)


@pytest.mark.django_db
def test_viewer_cannot_even_preview(project: Project) -> None:
    """Preview shares the write gate: it is only meaningful to someone who can commit."""
    user = _member(project, "viewer", Role.VIEWER)
    client = APIClient()
    client.force_authenticate(user=user)

    res = client.post(url(project), body(dry_run=True), format="json")

    assert res.status_code == 403


@pytest.mark.django_db
def test_non_member_gets_403(project: Project) -> None:
    stranger = User.objects.create_user(username="stranger", password="pw")
    client = APIClient()
    client.force_authenticate(user=stranger)

    res = client.post(url(project), body(), format="json")

    assert res.status_code in (403, 404)
    assert Sprint.objects.filter(project=project).count() == 0


@pytest.mark.django_db
def test_anonymous_gets_401(project: Project) -> None:
    res = APIClient().post(url(project), body(), format="json")

    assert res.status_code in (401, 403)
    assert Sprint.objects.filter(project=project).count() == 0


@pytest.mark.django_db
@pytest.mark.parametrize("role", [Role.VIEWER, Role.MEMBER])
def test_capacity_points_field_stays_scheduler_gated(project: Project, role: int) -> None:
    """The bulk route must not be a way around the ADR-0073 field-level gate."""
    user = _member(project, f"cap{int(role)}", role)
    client = APIClient()
    client.force_authenticate(user=user)

    res = client.post(url(project), body(count=1, first_sprint_capacity_points=20), format="json")

    assert res.status_code in (400, 403), res.data
    assert Sprint.objects.filter(project=project).count() == 0


@pytest.mark.django_db
def test_scheduler_may_set_the_capacity(project: Project) -> None:
    user = _member(project, "sched", Role.SCHEDULER)
    client = APIClient()
    client.force_authenticate(user=user)

    res = client.post(url(project), body(count=1, first_sprint_capacity_points=20), format="json")

    assert res.status_code == 201, res.data
    assert Sprint.objects.get(project=project).capacity_points == 20


# ---------------------------------------------------------------------------
# Broadcast
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_one_sprint_created_event_per_created_row(
    client: APIClient, project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """Deferred to commit, one event per row actually written."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_broadcast,
        django_capture_on_commit_callbacks(execute=True),
    ):
        res = client.post(url(project), body(count=3), format="json")

    assert res.status_code == 201, res.data
    assert mock_broadcast.call_count == 3
    assert {call.args[1] for call in mock_broadcast.call_args_list} == {"sprint_created"}
    assert {call.args[0] for call in mock_broadcast.call_args_list} == {str(project.pk)}
    assert {call.args[2]["id"] for call in mock_broadcast.call_args_list} == {
        str(s.pk) for s in Sprint.objects.filter(project=project)
    }


@pytest.mark.django_db
def test_dry_run_broadcasts_nothing(
    client: APIClient, project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_broadcast,
        django_capture_on_commit_callbacks(execute=True),
    ):
        client.post(url(project), body(count=3, dry_run=True), format="json")

    assert mock_broadcast.call_count == 0
