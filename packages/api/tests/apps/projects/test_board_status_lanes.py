"""Named board lanes over the five canonical statuses (#2967).

The property under test throughout is the one the whole design exists for:
``Task.status`` stays canonical. A lane is a second axis — configured on the
column it belongs to, stored on the card as a bare key, and invisible to every
consumer of ``status``.

Not to be confused with ``test_board_lanes.py``, which covers the case 16
*rendering* rule (ADR-0843) — which swimlane ROW a card sits in. This file
covers the vertical subdivision of a status COLUMN.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import BoardColumnConfig, Calendar, Project, Task
from trueppm_api.apps.projects.serializers import MAX_LANES_PER_COLUMN

User = get_user_model()

CANONICAL = ["BACKLOG", "NOT_STARTED", "IN_PROGRESS", "REVIEW", "COMPLETE"]


def columns(**lanes_by_status: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """A full five-column config, optionally carrying lanes on named statuses."""
    return [
        {
            "status": status,
            "label": status.title(),
            "visible": True,
            "color": None,
            "wip_limit": None,
            "age_threshold_days": None,
            "lanes": lanes_by_status.get(status, []),
        }
        for status in CANONICAL
    ]


def lane(key: str, label: str, wip_limit: int | None = None) -> dict[str, Any]:
    return {"key": key, "label": label, "wip_limit": wip_limit}


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Lanes", start_date=date(2026, 1, 1), calendar=calendar)


def client_with_role(project: Project, role: int, username: str) -> APIClient:
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def scheduler_client(project: Project) -> APIClient:
    """Writes the board CONFIG. Scheduler is the gate the column config already uses."""
    return client_with_role(project, Role.SCHEDULER, "sched")


@pytest.fixture
def owner_client(project: Project) -> APIClient:
    """Writes TASKS. ``board_lane`` is task content, so it sits behind
    ``IsProjectMemberWriteOrOwn`` — under which a Resource Manager (Scheduler) is
    deliberately read-only on task content and cannot set it."""
    return client_with_role(project, Role.OWNER, "owner")


def config_url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/board-config/"


# ---------------------------------------------------------------------------
# Config shape
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_lanes_round_trip_on_a_single_status(scheduler_client: APIClient, project: Project) -> None:
    """The happy path: three named lanes inside one canonical column."""
    payload = columns(
        REVIEW=[lane("review", "Review"), lane("qa", "QA", 2), lane("blocked", "Blocked")]
    )
    resp = scheduler_client.put(config_url(project), data={"columns": payload}, format="json")
    assert resp.status_code == 200

    review = next(c for c in resp.data["columns"] if c["status"] == "REVIEW")
    assert [lane_entry["key"] for lane_entry in review["lanes"]] == ["review", "qa", "blocked"]
    assert review["lanes"][1]["wip_limit"] == 2
    # Every other column stays unladen — lanes are opt-in per column.
    assert all(c["lanes"] == [] for c in resp.data["columns"] if c["status"] != "REVIEW")


@pytest.mark.django_db
def test_the_five_statuses_stay_exactly_five(scheduler_client: APIClient, project: Project) -> None:
    """Lanes never add a status — that is the whole point of nesting them.

    The duplicate-status guard is what keeps ``Task.status`` canonical for
    burndown, rollup, export and integrations. A config carrying nine lanes still
    carries five statuses, and this asserts the two facts together so a future
    change cannot satisfy one by breaking the other.
    """
    payload = columns(
        IN_PROGRESS=[lane("dev", "Dev"), lane("pairing", "Pairing")],
        REVIEW=[lane("review", "Review"), lane("qa", "QA")],
    )
    resp = scheduler_client.put(config_url(project), data={"columns": payload}, format="json")
    assert resp.status_code == 200
    assert [c["status"] for c in resp.data["columns"]] == CANONICAL
    total_lanes = sum(len(c["lanes"]) for c in resp.data["columns"])
    assert total_lanes == 4


@pytest.mark.django_db
def test_duplicate_status_is_still_rejected_with_lanes_present(
    scheduler_client: APIClient, project: Project
) -> None:
    """The pre-existing guard is untouched — a repeated status is not a lane."""
    payload = columns(REVIEW=[lane("qa", "QA")])
    payload.append({**payload[3], "lanes": []})  # a second REVIEW column
    resp = scheduler_client.put(config_url(project), data={"columns": payload}, format="json")
    assert resp.status_code == 400
    assert "Duplicate status" in str(resp.data)


@pytest.mark.django_db
def test_lane_keys_are_unique_project_wide_not_just_per_column(
    scheduler_client: APIClient, project: Project
) -> None:
    """A key names exactly one (status, lane) pair.

    ``Task.board_lane`` stores the bare key, so two columns each owning a lane
    called ``blocked`` would make a card's lane ambiguous the moment its status
    moved. Rejecting it here is what lets the stored value stay a bare string.
    """
    payload = columns(
        IN_PROGRESS=[lane("blocked", "Blocked")],
        REVIEW=[lane("blocked", "Blocked")],
    )
    resp = scheduler_client.put(config_url(project), data={"columns": payload}, format="json")
    assert resp.status_code == 400
    assert "Duplicate lane key" in str(resp.data)


@pytest.mark.django_db
@pytest.mark.parametrize(
    "bad_lane",
    [
        {"key": "Has Caps", "label": "Nope", "wip_limit": None},
        {"key": "-leading", "label": "Nope", "wip_limit": None},
        {"key": "ok", "label": "", "wip_limit": None},
        {"key": "ok", "label": "x" * 25, "wip_limit": None},
        {"key": "ok", "label": "Fine", "wip_limit": 0},
        {"key": "ok", "label": "Fine", "wip_limit": True},
    ],
)
def test_malformed_lane_is_rejected(
    scheduler_client: APIClient, project: Project, bad_lane: dict[str, Any]
) -> None:
    resp = scheduler_client.put(
        config_url(project), data={"columns": columns(REVIEW=[bad_lane])}, format="json"
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_lane_count_is_capped(scheduler_client: APIClient, project: Project) -> None:
    """An unbounded lane list is an unbounded grid; the cap is the server's."""
    too_many = [lane(f"l{n}", f"Lane {n}") for n in range(MAX_LANES_PER_COLUMN + 1)]
    resp = scheduler_client.put(
        config_url(project), data={"columns": columns(REVIEW=too_many)}, format="json"
    )
    assert resp.status_code == 400
    assert f"at most {MAX_LANES_PER_COLUMN}" in str(resp.data)


@pytest.mark.django_db
def test_unknown_lane_keys_are_dropped_not_smuggled(
    scheduler_client: APIClient, project: Project
) -> None:
    """Forward-compat key smuggling is refused for lanes exactly as for columns."""
    smuggled = {"key": "qa", "label": "QA", "wip_limit": None, "secret": "value"}
    resp = scheduler_client.put(
        config_url(project), data={"columns": columns(REVIEW=[smuggled])}, format="json"
    )
    assert resp.status_code == 200
    review = next(c for c in resp.data["columns"] if c["status"] == "REVIEW")
    assert review["lanes"] == [{"key": "qa", "label": "QA", "wip_limit": None}]


# ---------------------------------------------------------------------------
# Existing configs and the migration
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_a_config_saved_before_lanes_existed_reads_as_unladen(
    scheduler_client: APIClient, project: Project
) -> None:
    """The migration's effect on existing data: nothing, by construction.

    ``lanes`` lives inside the existing ``columns`` JSON, so a row written before
    #2967 simply has no key. It must read as "one implicit lane" rather than
    erroring or inventing one.
    """
    BoardColumnConfig.objects.create(
        project=project,
        columns=[{"status": s, "label": s.title(), "visible": True} for s in CANONICAL],
    )
    resp = scheduler_client.get(config_url(project))
    assert resp.status_code == 200
    assert all(c["lanes"] == [] for c in resp.data["columns"])


@pytest.mark.django_db
def test_existing_tasks_default_to_the_unassigned_lane(project: Project) -> None:
    """The column the migration adds is blank for every row that predates it."""
    task = Task.objects.create(project=project, name="Pour slab", duration=3, wbs_path="1")
    task.refresh_from_db()
    assert task.board_lane == ""


# ---------------------------------------------------------------------------
# Permissions — all five roles
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("role", "expected"),
    [
        (Role.OWNER, 200),
        (Role.ADMIN, 200),
        (Role.SCHEDULER, 200),
        (Role.MEMBER, 403),
        (Role.VIEWER, 403),
    ],
)
def test_configuring_lanes_requires_scheduler(project: Project, role: int, expected: int) -> None:
    """Lanes are board configuration, so they inherit the column config's gate.

    Reads stay open to every member (asserted below) — a Viewer must be able to
    see the lanes the board is drawn from, or the board renders nothing.
    """
    client = client_with_role(project, role, f"user{role}")
    resp = client.put(
        config_url(project), data={"columns": columns(REVIEW=[lane("qa", "QA")])}, format="json"
    )
    assert resp.status_code == expected


@pytest.mark.django_db
@pytest.mark.parametrize("role", [Role.OWNER, Role.ADMIN, Role.SCHEDULER, Role.MEMBER, Role.VIEWER])
def test_every_role_can_read_the_lane_config(project: Project, role: int) -> None:
    BoardColumnConfig.objects.create(project=project, columns=columns(REVIEW=[lane("qa", "QA")]))
    client = client_with_role(project, role, f"reader{role}")
    resp = client.get(config_url(project))
    assert resp.status_code == 200
    review = next(c for c in resp.data["columns"] if c["status"] == "REVIEW")
    assert review["lanes"][0]["key"] == "qa"


@pytest.mark.django_db
def test_non_member_cannot_read_lanes(project: Project) -> None:
    outsider = User.objects.create_user(username="outsider", password="pw")
    client = APIClient()
    client.force_authenticate(user=outsider)
    assert client.get(config_url(project)).status_code == 403


# ---------------------------------------------------------------------------
# Task.board_lane
# ---------------------------------------------------------------------------


@pytest.fixture
def laned_project(project: Project) -> Project:
    BoardColumnConfig.objects.create(
        project=project,
        columns=columns(REVIEW=[lane("review", "Review"), lane("qa", "QA", 1)]),
    )
    return project


@pytest.fixture
def review_task(laned_project: Project) -> Task:
    return Task.objects.create(
        project=laned_project, name="Inspect welds", duration=2, wbs_path="1", status="REVIEW"
    )


@pytest.mark.django_db
def test_assigning_a_configured_lane_leaves_status_untouched(
    owner_client: APIClient, review_task: Task
) -> None:
    """The load-bearing assertion of the whole issue."""
    resp = owner_client.patch(
        f"/api/v1/tasks/{review_task.pk}/", data={"board_lane": "qa"}, format="json"
    )
    assert resp.status_code == 200
    review_task.refresh_from_db()
    assert review_task.board_lane == "qa"
    assert review_task.status == "REVIEW"


@pytest.mark.django_db
def test_a_lane_from_another_column_is_rejected(
    owner_client: APIClient, laned_project: Project
) -> None:
    """A lane belongs to one column; a card in another column cannot claim it."""
    task = Task.objects.create(
        project=laned_project, name="Frame", duration=2, wbs_path="2", status="IN_PROGRESS"
    )
    resp = owner_client.patch(f"/api/v1/tasks/{task.pk}/", data={"board_lane": "qa"}, format="json")
    assert resp.status_code == 400
    assert "board_lane" in resp.data


@pytest.mark.django_db
def test_an_unknown_lane_is_rejected(owner_client: APIClient, review_task: Task) -> None:
    resp = owner_client.patch(
        f"/api/v1/tasks/{review_task.pk}/", data={"board_lane": "nope"}, format="json"
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_moving_status_clears_the_lane(owner_client: APIClient, review_task: Task) -> None:
    """A lane is scoped to its column, so carrying one across columns is meaningless.

    Clearing rather than keeping matters: a retained key would silently
    resurrect if the card ever came back, giving one card two truths about
    where it belongs.
    """
    review_task.board_lane = "qa"
    review_task.save(update_fields=["board_lane"])

    resp = owner_client.patch(
        f"/api/v1/tasks/{review_task.pk}/", data={"status": "COMPLETE"}, format="json"
    )
    assert resp.status_code == 200
    review_task.refresh_from_db()
    assert review_task.status == "COMPLETE"
    assert review_task.board_lane == ""


@pytest.mark.django_db
def test_a_status_move_can_name_its_destination_lane(
    owner_client: APIClient, laned_project: Project
) -> None:
    """The board's drag path: status and lane arrive in one PATCH."""
    task = Task.objects.create(
        project=laned_project, name="Frame", duration=2, wbs_path="2", status="IN_PROGRESS"
    )
    resp = owner_client.patch(
        f"/api/v1/tasks/{task.pk}/",
        data={"status": "REVIEW", "board_lane": "qa"},
        format="json",
    )
    assert resp.status_code == 200
    task.refresh_from_db()
    assert (task.status, task.board_lane) == ("REVIEW", "qa")


@pytest.mark.django_db
def test_a_same_status_patch_does_not_disturb_the_lane(
    owner_client: APIClient, review_task: Task
) -> None:
    """Only a status *change* clears the lane — a no-op status resend must not."""
    review_task.board_lane = "qa"
    review_task.save(update_fields=["board_lane"])
    resp = owner_client.patch(
        f"/api/v1/tasks/{review_task.pk}/", data={"status": "REVIEW"}, format="json"
    )
    assert resp.status_code == 200
    review_task.refresh_from_db()
    assert review_task.board_lane == "qa"


@pytest.mark.django_db
def test_task_payload_exposes_board_lane(owner_client: APIClient, review_task: Task) -> None:
    resp = owner_client.get(f"/api/v1/tasks/{review_task.pk}/")
    assert resp.status_code == 200
    assert resp.data["board_lane"] == ""


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("role", "expected"),
    [
        (Role.OWNER, 200),
        (Role.ADMIN, 200),
        (Role.SCHEDULER, 403),
        (Role.MEMBER, 403),
        (Role.VIEWER, 403),
    ],
)
def test_setting_a_lane_inherits_the_task_edit_gate(
    laned_project: Project, review_task: Task, role: int, expected: int
) -> None:
    """A lane is task content, not a separate permission surface (#2967).

    That is the point of the parametrization: it pins ``board_lane`` to
    ``IsProjectMemberWriteOrOwn`` rather than letting it acquire a rule of its
    own. Scheduler (Resource Manager) is read-only on task content by design, and
    Member is scoped to their own assigned tasks — this one is unassigned.
    """
    client = client_with_role(laned_project, role, f"laner{role}")
    resp = client.patch(
        f"/api/v1/tasks/{review_task.pk}/", data={"board_lane": "qa"}, format="json"
    )
    assert resp.status_code == expected


# ---------------------------------------------------------------------------
# Per-lane counts and WIP verdict
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_lane_counts_and_breach_are_server_facts(
    scheduler_client: APIClient, laned_project: Project
) -> None:
    for n in range(2):
        Task.objects.create(
            project=laned_project,
            name=f"QA {n}",
            duration=1,
            wbs_path=f"9.{n}",
            status="REVIEW",
            board_lane="qa",
        )
    Task.objects.create(
        project=laned_project,
        name="In review",
        duration=1,
        wbs_path="8",
        status="REVIEW",
        board_lane="review",
    )

    resp = scheduler_client.get(config_url(laned_project))
    review = next(c for c in resp.data["columns"] if c["status"] == "REVIEW")
    by_key = {lane_entry["key"]: lane_entry for lane_entry in review["lanes"]}
    assert by_key["review"]["current_count"] == 1
    assert by_key["review"]["breach"] is None  # no limit configured
    assert by_key["qa"]["current_count"] == 2
    assert by_key["qa"]["breach"] == "over"  # limit is 1
    # The column total is unchanged by the subdivision.
    assert review["current_count"] == 3


@pytest.mark.django_db
def test_an_orphaned_lane_key_counts_in_the_first_lane(
    scheduler_client: APIClient, laned_project: Project
) -> None:
    """Deleting a lane needs no data migration — the count resolves like the board.

    A card left pointing at a removed lane must land somewhere exactly once, and
    the client's fallback (`resolveTrackKey`) picks the first lane. If the server
    counted it anywhere else the header badge would disagree with the cards
    beneath it.
    """
    Task.objects.create(
        project=laned_project,
        name="Stale",
        duration=1,
        wbs_path="7",
        status="REVIEW",
        board_lane="deleted-lane",
    )
    resp = scheduler_client.get(config_url(laned_project))
    review = next(c for c in resp.data["columns"] if c["status"] == "REVIEW")
    assert review["lanes"][0]["current_count"] == 1
    assert review["lanes"][1]["current_count"] == 0


@pytest.mark.django_db
def test_lane_counts_cost_no_extra_queries(
    scheduler_client: APIClient, laned_project: Project, django_assert_max_num_queries: Any
) -> None:
    """One grouped query covers every column AND every lane (perf-check gate)."""
    for n in range(6):
        Task.objects.create(
            project=laned_project,
            name=f"T{n}",
            duration=1,
            wbs_path=f"5.{n}",
            status="REVIEW",
            board_lane="qa" if n % 2 else "review",
        )
    with django_assert_max_num_queries(8):
        assert scheduler_client.get(config_url(laned_project)).status_code == 200


@pytest.mark.django_db
def test_an_unladen_board_reports_no_lanes(scheduler_client: APIClient, project: Project) -> None:
    """The default project: five columns, zero lanes, no behavior change at all."""
    Task.objects.create(project=project, name="A", duration=1, wbs_path="1", status="REVIEW")
    resp = scheduler_client.get(config_url(project))
    assert all(c["lanes"] == [] for c in resp.data["columns"])
    review = next(c for c in resp.data["columns"] if c["status"] == "REVIEW")
    assert review["current_count"] == 1
