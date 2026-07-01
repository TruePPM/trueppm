"""Tests for the My Work contributor surface endpoint (issue #499, ADR-0065 Gap 2).

`GET /api/v1/me/work/` returns the authenticated user's assigned tasks across
all projects, filtered to non-BACKLOG and non-soft-deleted, ordered by:
    (1) active-sprint tasks first,
    (2) earliest planned_start or early_start,
    (3) priority_rank.

The endpoint MUST be hard-scoped to ``assignee=request.user`` — there is no
``?user=`` query escape hatch (Morgan's sprint-sovereignty requirement). PMs
and admins get a 200 with their *own* tasks (which may be empty), not a
tenant-wide read.
"""

from __future__ import annotations

from datetime import date, timedelta
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    RetroActionItem,
    Sprint,
    SprintRetro,
    SprintState,
    Task,
    TaskStatus,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def alice(db: object) -> object:
    return User.objects.create_user(username="alice", password="pw")


@pytest.fixture
def bob(db: object) -> object:
    return User.objects.create_user(username="bob", password="pw")


def _project(calendar: Calendar, name: str) -> Project:
    return Project.objects.create(name=name, start_date=date(2026, 4, 1), calendar=calendar)


def _member(project: Project, user: object, role: int = Role.MEMBER) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=role)


def _active_sprint(project: Project, name: str = "S1", **kwargs: object) -> Sprint:
    defaults = {
        "start_date": date(2026, 4, 1),
        "finish_date": date(2026, 4, 14),
        "state": SprintState.ACTIVE,
    }
    defaults.update(kwargs)
    return Sprint.objects.create(project=project, name=name, **defaults)


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# ---------------------------------------------------------------------------
# Auth + RBAC
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_anonymous_is_rejected() -> None:
    resp = APIClient().get("/api/v1/me/work/")
    assert resp.status_code in (401, 403)


@pytest.mark.django_db
def test_returns_only_own_assigned_tasks(calendar: Calendar, alice: object, bob: object) -> None:
    """Even when other users are assigned in the same project, only own tasks return."""
    proj = _project(calendar, "P1")
    _member(proj, alice)
    _member(proj, bob)
    Task.objects.create(project=proj, name="Alice task", duration=1, assignee=alice)
    Task.objects.create(project=proj, name="Bob task", duration=1, assignee=bob)

    resp = _client(alice).get("/api/v1/me/work/")
    assert resp.status_code == 200
    names = [t["name"] for t in resp.data["results"]]
    assert names == ["Alice task"]


@pytest.mark.django_db
def test_no_user_query_escape_hatch(calendar: Calendar, alice: object, bob: object) -> None:
    """Morgan's RBAC blocker: ``?user=<bob_id>`` MUST NOT return bob's tasks to alice.

    The endpoint is hard-scoped to ``assignee=request.user``. Any ``?user=``
    param is silently ignored — the caller gets their own tasks, not the
    queried user's.
    """
    proj = _project(calendar, "P1")
    _member(proj, alice)
    _member(proj, bob)
    Task.objects.create(project=proj, name="Bob private", duration=1, assignee=bob)

    resp = _client(alice).get(f"/api/v1/me/work/?user={bob.pk}")
    assert resp.status_code == 200
    # No bob tasks leak to alice, even with the spoof param.
    assert all(t["name"] != "Bob private" for t in resp.data["results"])
    # And alice's own (empty) list is what she sees.
    assert resp.data["results"] == []


@pytest.mark.django_db
def test_owner_role_cannot_use_user_param_to_view_others_tasks(
    calendar: Calendar, alice: object, bob: object
) -> None:
    """Even an OWNER-role caller (highest project role) is hard-scoped to self.

    Morgan's sprint-sovereignty concern explicitly called out the PM/OWNER
    escalation path: the endpoint must not become a manager surveillance
    surface even for the project owner.
    """
    proj = _project(calendar, "P1")
    _member(proj, alice, role=Role.OWNER)
    _member(proj, bob)
    Task.objects.create(project=proj, name="Bob private", duration=1, assignee=bob)

    resp = _client(alice).get(f"/api/v1/me/work/?user={bob.pk}")
    assert resp.status_code == 200
    assert resp.data["results"] == []


@pytest.mark.django_db
def test_assignment_without_active_membership_excluded(calendar: Calendar, alice: object) -> None:
    """If alice was removed from the project but still has the assignee FK set,
    her My Work must not surface that orphaned task — the membership re-check
    catches the edge case."""
    proj = _project(calendar, "P1")
    mem = _member(proj, alice)
    Task.objects.create(project=proj, name="Orphan", duration=1, assignee=alice)
    # Soft-delete the membership without clearing the assignee.
    mem.is_deleted = True
    mem.save(update_fields=["is_deleted"])

    resp = _client(alice).get("/api/v1/me/work/")
    assert resp.status_code == 200
    assert resp.data["results"] == []


# ---------------------------------------------------------------------------
# Filters
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_backlog_tasks_excluded(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar, "P1")
    _member(proj, alice)
    Task.objects.create(
        project=proj,
        name="In sprint",
        duration=1,
        assignee=alice,
        status=TaskStatus.IN_PROGRESS,
    )
    Task.objects.create(
        project=proj,
        name="Backlog",
        duration=1,
        assignee=alice,
        status=TaskStatus.BACKLOG,
    )

    resp = _client(alice).get("/api/v1/me/work/")
    names = [t["name"] for t in resp.data["results"]]
    assert names == ["In sprint"]


@pytest.mark.django_db
def test_soft_deleted_tasks_excluded(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar, "P1")
    _member(proj, alice)
    Task.objects.create(project=proj, name="Live", duration=1, assignee=alice)
    Task.objects.create(
        project=proj,
        name="Deleted",
        duration=1,
        assignee=alice,
        is_deleted=True,
    )

    resp = _client(alice).get("/api/v1/me/work/")
    names = [t["name"] for t in resp.data["results"]]
    assert names == ["Live"]


@pytest.mark.django_db
def test_soft_deleted_project_excluded(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar, "P1")
    _member(proj, alice)
    Task.objects.create(project=proj, name="T", duration=1, assignee=alice)
    proj.is_deleted = True
    proj.save(update_fields=["is_deleted"])

    resp = _client(alice).get("/api/v1/me/work/")
    assert resp.data["results"] == []


# ---------------------------------------------------------------------------
# Ordering
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_today_bucket_sorts_by_due_date(calendar: Calendar, alice: object) -> None:
    """ADR-0122 supersedes the old 'active-sprint-first' ordering with date
    bucketing: both these tasks have a past planned_start, so both land in the
    'today' bucket and sort by due date — the earlier-due one first, regardless
    of sprint membership. (The sprint-vs-no-sprint distinction now only matters
    for future-dated tasks: this_sprint vs upcoming — see test_me_work_grouping.)"""
    proj = _project(calendar, "P1")
    _member(proj, alice)
    sprint = _active_sprint(proj)
    Task.objects.create(
        project=proj,
        name="No sprint, early",
        duration=1,
        assignee=alice,
        planned_start=date(2026, 4, 1),
    )
    Task.objects.create(
        project=proj,
        name="In sprint",
        duration=1,
        assignee=alice,
        sprint=sprint,
        planned_start=date(2026, 4, 10),
    )

    resp = _client(alice).get("/api/v1/me/work/")
    names = [t["name"] for t in resp.data["results"]]
    assert names == ["No sprint, early", "In sprint"]
    # Both are overdue → both in the 'today' bucket.
    assert {t["group"] for t in resp.data["results"]} == {"today"}


@pytest.mark.django_db
def test_ordering_by_planned_then_early_then_rank(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar, "P1")
    _member(proj, alice)
    sprint = _active_sprint(proj)
    Task.objects.create(
        project=proj,
        name="Later rank",
        duration=1,
        assignee=alice,
        sprint=sprint,
        planned_start=date(2026, 4, 5),
        priority_rank=20,
    )
    Task.objects.create(
        project=proj,
        name="Earlier rank",
        duration=1,
        assignee=alice,
        sprint=sprint,
        planned_start=date(2026, 4, 5),
        priority_rank=10,
    )
    Task.objects.create(
        project=proj,
        name="Earlier date",
        duration=1,
        assignee=alice,
        sprint=sprint,
        planned_start=date(2026, 4, 1),
        priority_rank=999,
    )

    resp = _client(alice).get("/api/v1/me/work/")
    names = [t["name"] for t in resp.data["results"]]
    assert names == ["Earlier date", "Earlier rank", "Later rank"]


# ---------------------------------------------------------------------------
# Response shape
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_response_has_no_cpm_fields(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar, "P1")
    _member(proj, alice)
    Task.objects.create(
        project=proj,
        name="T",
        duration=1,
        assignee=alice,
        early_start=date(2026, 4, 1),
        early_finish=date(2026, 4, 2),
        late_start=date(2026, 4, 3),
        late_finish=date(2026, 4, 4),
        total_float=5,
    )

    resp = _client(alice).get("/api/v1/me/work/")
    row = resp.data["results"][0]
    forbidden = {
        "early_start",
        "early_finish",
        "late_start",
        "late_finish",
        "total_float",
        "free_float",
        "wbs_path",
        "phase_id",
    }
    assert not forbidden.intersection(row.keys()), (
        f"CPM fields leaked into contributor response: {forbidden & set(row.keys())}"
    )


@pytest.mark.django_db
def test_is_critical_exposed_as_boolean(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar, "P1")
    _member(proj, alice)
    Task.objects.create(project=proj, name="On CP", duration=1, assignee=alice, is_critical=True)
    Task.objects.create(project=proj, name="Off CP", duration=1, assignee=alice, is_critical=False)
    Task.objects.create(
        project=proj, name="Unknown CP", duration=1, assignee=alice, is_critical=None
    )

    resp = _client(alice).get("/api/v1/me/work/")
    by_name = {t["name"]: t for t in resp.data["results"]}
    assert by_name["On CP"]["is_critical"] is True
    assert by_name["Off CP"]["is_critical"] is False
    # Null CPM result must coerce to False, never null — the UI never has to handle null.
    assert by_name["Unknown CP"]["is_critical"] is False


@pytest.mark.django_db
def test_due_cascade(calendar: Calendar, alice: object) -> None:
    """due = actual_finish ?? planned_start ?? early_finish ?? sprint.finish_date."""
    proj = _project(calendar, "P1")
    _member(proj, alice)
    sprint = _active_sprint(proj, name="S", finish_date=date(2026, 4, 14))

    Task.objects.create(
        project=proj,
        name="actual",
        duration=1,
        assignee=alice,
        actual_finish=date(2026, 4, 5),
        planned_start=date(2026, 4, 10),  # ignored — actual wins
    )
    Task.objects.create(
        project=proj,
        name="planned",
        duration=1,
        assignee=alice,
        planned_start=date(2026, 4, 6),
        early_finish=date(2026, 4, 11),  # ignored — planned wins
    )
    Task.objects.create(
        project=proj,
        name="estimated",
        duration=1,
        assignee=alice,
        early_finish=date(2026, 4, 7),
        sprint=sprint,  # ignored — early_finish wins over sprint
    )
    Task.objects.create(
        project=proj,
        name="sprint_fallback",
        duration=1,
        assignee=alice,
        sprint=sprint,  # finish_date 2026-04-14
    )
    Task.objects.create(
        project=proj,
        name="no_due",
        duration=1,
        assignee=alice,
    )

    resp = _client(alice).get("/api/v1/me/work/")
    by_name = {t["name"]: t for t in resp.data["results"]}
    assert by_name["actual"]["due"] == "2026-04-05"
    assert by_name["actual"]["due_source"] == "actual"
    assert by_name["planned"]["due"] == "2026-04-06"
    assert by_name["planned"]["due_source"] == "planned"
    assert by_name["estimated"]["due"] == "2026-04-07"
    assert by_name["estimated"]["due_source"] == "estimated"
    assert by_name["sprint_fallback"]["due"] == "2026-04-14"
    assert by_name["sprint_fallback"]["due_source"] == "sprint"
    assert by_name["no_due"]["due"] is None
    assert by_name["no_due"]["due_source"] is None


@pytest.mark.django_db
def test_url_field_is_schedule_deep_link(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar, "P1")
    _member(proj, alice)
    task = Task.objects.create(project=proj, name="T", duration=1, assignee=alice)

    resp = _client(alice).get("/api/v1/me/work/")
    row = resp.data["results"][0]
    assert row["url"] == f"/projects/{proj.pk}/schedule?task={task.pk}"


@pytest.mark.django_db
def test_active_sprints_excludes_soft_deleted(calendar: Calendar, alice: object) -> None:
    """A soft-deleted ACTIVE sprint must not appear in the active_sprints payload."""
    proj = _project(calendar, "P1")
    _member(proj, alice)
    s_live = _active_sprint(proj, name="Live sprint")
    s_dead = _active_sprint(proj, name="Dead sprint")
    Task.objects.create(project=proj, name="T1", duration=1, assignee=alice, sprint=s_live)
    Task.objects.create(project=proj, name="T2", duration=1, assignee=alice, sprint=s_dead)
    # Soft-delete one of the sprints; its task remains assigned to alice.
    s_dead.is_deleted = True
    s_dead.save(update_fields=["is_deleted"])

    resp = _client(alice).get("/api/v1/me/work/")
    sprint_names = [s["name"] for s in resp.data["active_sprints"]]
    assert "Live sprint" in sprint_names
    assert "Dead sprint" not in sprint_names


@pytest.mark.django_db
def test_due_today_count_is_isolated_per_user(
    calendar: Calendar, alice: object, bob: object
) -> None:
    """Bob's due-today tasks must not inflate alice's due_today_count."""
    proj = _project(calendar, "P1")
    _member(proj, alice)
    _member(proj, bob)
    today = timezone.localdate()
    # Bob owns three tasks due today.
    for i in range(3):
        Task.objects.create(
            project=proj,
            name=f"Bob today {i}",
            duration=1,
            assignee=bob,
            planned_start=today,
        )
    # Alice owns one task due today.
    Task.objects.create(
        project=proj, name="Alice today", duration=1, assignee=alice, planned_start=today
    )

    resp = _client(alice).get("/api/v1/me/work/")
    assert resp.data["due_today_count"] == 1


@pytest.mark.django_db
def test_active_sprints_payload(calendar: Calendar, alice: object) -> None:
    proj1 = _project(calendar, "Alpha")
    proj2 = _project(calendar, "Beta")
    _member(proj1, alice)
    _member(proj2, alice)
    s1 = _active_sprint(proj1, name="Alpha S1", finish_date=date(2026, 4, 30))
    s2 = _active_sprint(proj2, name="Beta S1", finish_date=date(2026, 5, 14))
    Task.objects.create(project=proj1, name="A1", duration=1, assignee=alice, sprint=s1)
    Task.objects.create(project=proj2, name="B1", duration=1, assignee=alice, sprint=s2)
    Task.objects.create(project=proj2, name="B2", duration=1, assignee=alice, sprint=s2)

    resp = _client(alice).get("/api/v1/me/work/")
    sprints = resp.data["active_sprints"]
    assert len(sprints) == 2
    by_name = {s["name"]: s for s in sprints}
    assert by_name["Alpha S1"]["task_count"] == 1
    assert by_name["Beta S1"]["task_count"] == 2
    assert by_name["Beta S1"]["project_name"] == "Beta"
    # days_remaining must be a non-negative integer.
    assert all(s["days_remaining"] >= 0 for s in sprints)


@pytest.mark.django_db
def test_due_today_count(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar, "P1")
    _member(proj, alice)
    today = timezone.localdate()
    Task.objects.create(
        project=proj,
        name="Due today",
        duration=1,
        assignee=alice,
        planned_start=today,
        status=TaskStatus.NOT_STARTED,
    )
    Task.objects.create(
        project=proj,
        name="Due tomorrow",
        duration=1,
        assignee=alice,
        planned_start=today + timedelta(days=1),
    )
    Task.objects.create(
        project=proj,
        name="Done today (excluded)",
        duration=1,
        assignee=alice,
        planned_start=today,
        status=TaskStatus.COMPLETE,
    )

    resp = _client(alice).get("/api/v1/me/work/")
    assert resp.data["due_today_count"] == 1


@pytest.mark.django_db
def test_server_version_high_water(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar, "P1")
    _member(proj, alice)
    Task.objects.create(project=proj, name="T1", duration=1, assignee=alice)
    Task.objects.create(project=proj, name="T2", duration=1, assignee=alice)

    resp = _client(alice).get("/api/v1/me/work/")
    versions = [t["server_version"] for t in resp.data["results"]]
    assert max(versions) == resp.data["server_version_high_water"]


# ---------------------------------------------------------------------------
# Pagination
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_pagination_paginates_at_limit(calendar: Calendar, alice: object) -> None:
    """LimitOffsetPagination — ?limit=3 returns 3 rows + a next link."""
    proj = _project(calendar, "P1")
    _member(proj, alice)
    for i in range(7):
        Task.objects.create(
            project=proj,
            name=f"T{i:02d}",
            duration=1,
            assignee=alice,
            planned_start=date(2026, 4, 1) + timedelta(days=i),
        )

    resp = _client(alice).get("/api/v1/me/work/?limit=3")
    assert resp.status_code == 200
    assert len(resp.data["results"]) == 3
    assert resp.data["next"] is not None
    assert resp.data["count"] == 7

    # Follow the next URL — page 2 has 3 more.
    resp2 = _client(alice).get(resp.data["next"])
    assert resp2.status_code == 200
    assert len(resp2.data["results"]) == 3

    # And a final partial page.
    resp3 = _client(alice).get(resp2.data["next"])
    assert resp3.status_code == 200
    assert len(resp3.data["results"]) == 1
    assert resp3.data["next"] is None


@pytest.mark.django_db
def test_limit_capped_at_max(calendar: Calendar, alice: object) -> None:
    """?limit=500 clamps to max_limit=200 — the request must still succeed."""
    from trueppm_api.apps.projects.views import MeWorkPagination

    # Pin the clamp value on the paginator directly so removing it is caught even
    # without seeding a full page.
    assert MeWorkPagination.max_limit == 200

    proj = _project(calendar, "P1")
    _member(proj, alice)
    # Seed 201 assigned tasks so an un-clamped ?limit=500 would return all 201.
    # With the clamp the page holds exactly max_limit=200; a one-task fixture could
    # never distinguish "clamped to 200" from "clamp deleted".
    for i in range(201):
        Task.objects.create(
            project=proj,
            name=f"T{i}",
            duration=1,
            assignee=alice,
            planned_start=date(2026, 4, 1) + timedelta(days=i),
        )

    resp = _client(alice).get("/api/v1/me/work/?limit=500")
    assert resp.status_code == 200
    assert len(resp.data["results"]) == 200
    assert resp.data["count"] == 201


# ---------------------------------------------------------------------------
# X-Source audit header — TaskViewSet PATCH propagates to webhook
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_x_source_header_propagates_to_webhook_payload(calendar: Calendar, alice: object) -> None:
    """A PATCH from My Work should land in the task.updated webhook with source=my_work.

    Morgan's surface-source audit concern: downstream consumers (audit views,
    enterprise integrations) need to distinguish a status flip from /me/work
    vs the schedule canvas. The X-Source header carries this; the webhook
    payload propagates it.
    """
    proj = _project(calendar, "P1")
    _member(proj, alice, role=Role.ADMIN)
    task = Task.objects.create(project=proj, name="T", duration=1, assignee=alice)

    with patch("trueppm_api.apps.projects.views._dispatch_webhooks") as mock_dispatch:
        resp = _client(alice).patch(
            f"/api/v1/tasks/{task.pk}/",
            data={"status": TaskStatus.IN_PROGRESS},
            format="json",
            headers={"X-Source": "my_work"},
        )
        assert resp.status_code == 200
        # Exactly one task.updated dispatch with the source field set.
        update_calls = [c for c in mock_dispatch.call_args_list if c.args[1] == "task.updated"]
        assert len(update_calls) == 1
        payload = update_calls[0].args[2]
        assert payload["source"] == "my_work"


@pytest.mark.django_db(transaction=True)
def test_x_source_defaults_to_unknown_when_absent(calendar: Calendar, alice: object) -> None:
    """Existing surfaces that don't send X-Source get source=unknown — backward-compatible."""
    proj = _project(calendar, "P1")
    _member(proj, alice, role=Role.ADMIN)
    task = Task.objects.create(project=proj, name="T", duration=1, assignee=alice)

    with patch("trueppm_api.apps.projects.views._dispatch_webhooks") as mock_dispatch:
        resp = _client(alice).patch(
            f"/api/v1/tasks/{task.pk}/",
            data={"status": TaskStatus.IN_PROGRESS},
            format="json",
        )
        assert resp.status_code == 200
        update_calls = [c for c in mock_dispatch.call_args_list if c.args[1] == "task.updated"]
        assert len(update_calls) == 1
        assert update_calls[0].args[2]["source"] == "unknown"


@pytest.mark.django_db(transaction=True)
def test_x_source_invalid_value_falls_back_to_unknown(calendar: Calendar, alice: object) -> None:
    """Reject Unicode, oversized, and disallowed characters — coerce to unknown.

    The header value is forwarded into stored webhook payloads sent to third-
    party consumers. A regex allow-list (lowercase letters + underscores,
    max 64 chars) prevents arbitrary user-controlled strings from reaching
    those consumers.
    """
    proj = _project(calendar, "P1")
    _member(proj, alice, role=Role.ADMIN)
    task = Task.objects.create(project=proj, name="T", duration=1, assignee=alice)

    invalid_cases = [
        "x" * 100,  # too long
        "DROP TABLE",  # uppercase + space
        "../etc/passwd",  # punctuation
        "my-work",  # hyphen not in the allow-list
        "\U0001f916",  # unicode (robot emoji)
        "",  # empty
    ]
    for raw in invalid_cases:
        with patch("trueppm_api.apps.projects.views._dispatch_webhooks") as mock_dispatch:
            resp = _client(alice).patch(
                f"/api/v1/tasks/{task.pk}/",
                data={"status": TaskStatus.IN_PROGRESS},
                format="json",
                headers={"X-Source": raw},
            )
            assert resp.status_code == 200, f"Failed for raw={raw!r}"
            update_calls = [c for c in mock_dispatch.call_args_list if c.args[1] == "task.updated"]
            assert len(update_calls) == 1
            assert update_calls[0].args[2]["source"] == "unknown", (
                f"X-Source={raw!r} should have been coerced to 'unknown'"
            )


# ---------------------------------------------------------------------------
# Query-count regression test — _me_work_retro_action_items scoping (#772)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_me_work_retro_items_scoped_to_member_projects(
    calendar: Calendar, alice: object, bob: object
) -> None:
    """Retro action items on /me/work/ must be scoped to the user's member projects.

    Before the fix, _me_work_retro_action_items fetched ALL RetroActionItems
    across the entire DB regardless of the requesting user's membership.
    This test verifies that items from projects the user does not belong to
    are not included in the response payload.
    """
    # Alice's project + sprint + retro + action item.
    alice_proj = _project(calendar, "Alice Project")
    _member(alice_proj, alice, role=Role.MEMBER)
    alice_sprint = Sprint.objects.create(
        project=alice_proj,
        name="S1",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.COMPLETED,
    )
    alice_retro = SprintRetro.objects.create(sprint=alice_sprint)
    alice_promoted_task = Task.objects.create(
        project=alice_proj,
        name="Alice promoted task",
        duration=1,
        assignee=alice,
    )
    alice_item = RetroActionItem.objects.create(
        retro=alice_retro,
        text="Alice action item",
        promoted_task_id=alice_promoted_task.pk,
    )

    # Bob's project (alice is NOT a member) + retro action item pointing at alice's task.
    bob_proj = _project(calendar, "Bob Project")
    _member(bob_proj, bob, role=Role.MEMBER)
    bob_sprint = Sprint.objects.create(
        project=bob_proj,
        name="S1",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.COMPLETED,
    )
    bob_retro = SprintRetro.objects.create(sprint=bob_sprint)
    # Point bob's retro item at the same promoted task assigned to alice —
    # the old unscoped query would include this item in alice's /me/work/ response.
    RetroActionItem.objects.create(
        retro=bob_retro,
        text="Bob action item pointing at alice task",
        promoted_task_id=alice_promoted_task.pk,
    )

    resp = _client(alice).get("/api/v1/me/work/")
    assert resp.status_code == 200

    retro_items = resp.data.get("retro_action_items", [])
    # Only alice_item (from her project) should appear.
    # The bob retro item must NOT appear because alice is not a member of bob_proj.
    retro_item_ids = [str(item.get("task_id")) for item in retro_items]
    # alice_promoted_task should appear at most once (from alice's project).
    assert retro_item_ids.count(str(alice_promoted_task.pk)) <= 1

    # Verify the text in any returned item belongs to alice's retro, not bob's.
    for item in retro_items:
        if str(item.get("task_id")) == str(alice_promoted_task.pk):
            assert item.get("text") == alice_item.text, (
                "Retro action item text should come from alice's project retro, "
                "not bob's unrelated retro."
            )


@pytest.mark.django_db
def test_me_work_retro_items_query_count_bounded_by_membership(
    calendar: Calendar, alice: object
) -> None:
    """The retro action items query must be bounded by membership rows, not all DB rows.

    Create action items in N projects alice does NOT belong to. The query count
    for /me/work/ must remain roughly constant regardless of how many
    non-member retro rows exist in the database.
    """
    # Baseline: alice has no projects.
    with CaptureQueriesContext(connection) as ctx_baseline:
        resp = _client(alice).get("/api/v1/me/work/")
    assert resp.status_code == 200
    baseline_q = len(ctx_baseline.captured_queries)

    # Create 10 projects alice is NOT a member of, each with a retro + 5 action items.
    for i in range(10):
        other_user = User.objects.create_user(username=f"other{i}", password="pw")
        other_proj = _project(calendar, f"Other{i}")
        _member(other_proj, other_user, role=Role.MEMBER)
        sprint = Sprint.objects.create(
            project=other_proj,
            name="S1",
            start_date=date(2026, 4, 1),
            finish_date=date(2026, 4, 14),
            state=SprintState.COMPLETED,
        )
        retro = SprintRetro.objects.create(sprint=sprint)
        for j in range(5):
            task = Task.objects.create(
                project=other_proj, name=f"T{i}{j}", duration=1, assignee=other_user
            )
            RetroActionItem.objects.create(
                retro=retro,
                text=f"item {i}-{j}",
                promoted_task_id=task.pk,
            )

    with CaptureQueriesContext(connection) as ctx_after:
        resp = _client(alice).get("/api/v1/me/work/")
    assert resp.status_code == 200

    # Query count must not grow significantly because the membership-scoped
    # filter returns zero rows for alice — the 50 non-member action items
    # must not cause extra per-row queries.
    assert len(ctx_after.captured_queries) <= baseline_q + 5, (
        f"Query count grew from {baseline_q} to {len(ctx_after.captured_queries)} "
        "after adding 50 non-member retro action items. "
        "_me_work_retro_action_items is not properly scoped to member projects."
    )
