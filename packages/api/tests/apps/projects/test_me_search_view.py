"""Tests for the global cross-program Epic/Story omni-search (ADR-0508 D4, #2103).

``GET /api/v1/me/search/`` merges two membership-scoped sources into one ranked,
paginated list for the ⌘K palette's Epic/Story result type:

* committed ``Task`` rows of type EPIC / STORY / TASK — project-membership scope;
* program ``BacklogItem`` intake rows — program-membership scope.

The 🔴 blocking contract is IDOR safety: a title from a project or program the
caller is NOT a member of must never appear. The leak test below seeds a second
user's project/program with matching titles and asserts zero leakage.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import (
    ProgramMembership,
    ProjectMembership,
    Role,
)
from trueppm_api.apps.projects.models import (
    BacklogItem,
    BacklogItemType,
    Calendar,
    Program,
    Project,
    Task,
    TaskType,
)

User = get_user_model()

URL = "/api/v1/me/search/"


# ---------------------------------------------------------------------------
# Fixtures / helpers
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


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _program(name: str, code: str = "") -> Program:
    return Program.objects.create(name=name, code=code)


def _project(calendar: Calendar, name: str, program: Program | None = None) -> Project:
    return Project.objects.create(
        name=name, start_date=date(2026, 4, 1), calendar=calendar, program=program
    )


def _project_member(project: Project, user: object, role: int = Role.MEMBER) -> None:
    ProjectMembership.objects.create(project=project, user=user, role=role)


def _program_member(program: Program, user: object, role: int = Role.MEMBER) -> None:
    ProgramMembership.objects.create(program=program, user=user, role=role)


def _task(project: Project, name: str, task_type: str = TaskType.STORY, **kw: object) -> Task:
    return Task.objects.create(project=project, name=name, type=task_type, **kw)


def _item(program: Program, title: str, item_type: str = BacklogItemType.STORY) -> BacklogItem:
    return BacklogItem.objects.create(program=program, title=title, item_type=item_type)


def _results(resp: object) -> list:
    return resp.data["results"]


def _titles(resp: object) -> set:
    return {r["title"] for r in _results(resp)}


# ---------------------------------------------------------------------------
# Auth + query-length behavior
# ---------------------------------------------------------------------------


def test_requires_authentication(db: object) -> None:
    resp = APIClient().get(f"{URL}?q=login")
    assert resp.status_code in (401, 403)


def test_short_query_returns_empty_page(calendar: Calendar, alice: object) -> None:
    prog = _program("Platform")
    project = _project(calendar, "Web", program=prog)
    _project_member(project, alice)
    _task(project, "Login epic", TaskType.EPIC)

    # 1-char is below the 2-char floor → empty, not a leak-or-scan.
    resp = _client(alice).get(f"{URL}?q=L")
    assert resp.status_code == 200
    assert resp.data["count"] == 0
    assert _results(resp) == []


def test_absent_query_returns_empty_page(calendar: Calendar, alice: object) -> None:
    resp = _client(alice).get(URL)
    assert resp.status_code == 200
    assert resp.data["count"] == 0


# ---------------------------------------------------------------------------
# Happy path: epics + stories + backlog with breadcrumbs
# ---------------------------------------------------------------------------


def test_returns_epic_story_and_backlog_with_breadcrumbs(calendar: Calendar, alice: object) -> None:
    prog = _program("Q3 Marketing")
    project = _project(calendar, "Website Relaunch", program=prog)
    _project_member(project, alice)
    _program_member(prog, alice)

    epic = _task(project, "Login flow", TaskType.EPIC)
    _task(project, "Login form validation", TaskType.STORY, parent_epic=epic)
    _item(prog, "Login rate limiting", BacklogItemType.STORY)

    resp = _client(alice).get(f"{URL}?q=login&type=epic,story")
    assert resp.status_code == 200
    assert _titles(resp) == {"Login flow", "Login form validation", "Login rate limiting"}

    by_title = {r["title"]: r for r in _results(resp)}

    epic_row = by_title["Login flow"]
    assert epic_row["kind"] == "task"
    assert epic_row["type"] == "epic"
    assert epic_row["program_name"] == "Q3 Marketing"
    assert epic_row["project_name"] == "Website Relaunch"
    assert epic_row["parent_epic_id"] is None

    story_row = by_title["Login form validation"]
    assert story_row["kind"] == "task"
    assert story_row["type"] == "story"
    # Agile breadcrumb: parent epic name, never a WBS code.
    assert story_row["parent_epic_id"] == str(epic.id)
    assert story_row["parent_epic_name"] == "Login flow"

    backlog_row = by_title["Login rate limiting"]
    assert backlog_row["kind"] == "backlog_item"
    assert backlog_row["type"] == "story"
    assert backlog_row["program_name"] == "Q3 Marketing"
    # A backlog item is program-level intake — no project/parent-epic breadcrumb.
    assert backlog_row["project_id"] is None
    assert backlog_row["project_name"] is None


def test_no_wbs_code_in_breadcrumb_fields(calendar: Calendar, alice: object) -> None:
    """The PO persona's hard-NO: the payload must not carry a WBS breadcrumb."""
    project = _project(calendar, "Web", program=_program("P"))
    _project_member(project, alice)
    task = _task(project, "Checkout epic", TaskType.EPIC, wbs_path="1.2.3")

    resp = _client(alice).get(f"{URL}?q=checkout")
    row = _results(resp)[0]
    assert task.wbs_path == "1.2.3"  # the task HAS a WBS code…
    assert "wbs" not in row  # …but it is never surfaced.
    assert "wbs_path" not in row


# ---------------------------------------------------------------------------
# type filtering
# ---------------------------------------------------------------------------


def test_default_type_is_epic_and_story_only(calendar: Calendar, alice: object) -> None:
    project = _project(calendar, "Web", program=_program("P"))
    _project_member(project, alice)
    _task(project, "Zeta epic", TaskType.EPIC)
    _task(project, "Zeta story", TaskType.STORY)
    _task(project, "Zeta task", TaskType.TASK)

    resp = _client(alice).get(f"{URL}?q=zeta")  # no ?type → epic,story default
    assert _titles(resp) == {"Zeta epic", "Zeta story"}


def test_task_type_is_opt_in(calendar: Calendar, alice: object) -> None:
    project = _project(calendar, "Web", program=_program("P"))
    _project_member(project, alice)
    _task(project, "Zeta task", TaskType.TASK)

    assert _titles(_client(alice).get(f"{URL}?q=zeta")) == set()
    assert _titles(_client(alice).get(f"{URL}?q=zeta&type=task")) == {"Zeta task"}


def test_unknown_type_ignored_falls_back_to_default(calendar: Calendar, alice: object) -> None:
    project = _project(calendar, "Web", program=_program("P"))
    _project_member(project, alice)
    _task(project, "Zeta epic", TaskType.EPIC)

    # Present-but-unrecognized filter falls back to the epic,story default.
    resp = _client(alice).get(f"{URL}?q=zeta&type=bogus")
    assert _titles(resp) == {"Zeta epic"}


# ---------------------------------------------------------------------------
# 🔴 IDOR: strict membership scoping — the blocking gate
# ---------------------------------------------------------------------------


def test_does_not_leak_other_users_tasks_or_backlog(
    calendar: Calendar, alice: object, bob: object
) -> None:
    """A second user's project/program with matching titles must not leak (IDOR)."""
    # Bob's world — identical titles to what Alice searches for.
    bob_prog = _program("Bob Program")
    bob_project = _project(calendar, "Bob Project", program=bob_prog)
    _project_member(bob_project, bob)
    _program_member(bob_prog, bob)
    _task(bob_project, "Secret epic", TaskType.EPIC)
    _task(bob_project, "Secret story", TaskType.STORY)
    _item(bob_prog, "Secret backlog", BacklogItemType.STORY)

    # Alice is a member of NOTHING here.
    resp = _client(alice).get(f"{URL}?q=secret&type=epic,story")
    assert resp.status_code == 200
    assert resp.data["count"] == 0
    assert _results(resp) == []


def test_task_scoped_to_project_membership(calendar: Calendar, alice: object, bob: object) -> None:
    prog = _program("Shared")
    a_project = _project(calendar, "Alice Project", program=prog)
    b_project = _project(calendar, "Bob Project", program=prog)
    _project_member(a_project, alice)
    _project_member(b_project, bob)  # alice is NOT a member of b_project
    _task(a_project, "Alpha epic", TaskType.EPIC)
    _task(b_project, "Alpha epic", TaskType.EPIC)

    resp = _client(alice).get(f"{URL}?q=alpha")
    # Only the epic in Alice's project — the identically-titled one is invisible.
    assert len(_results(resp)) == 1
    assert _results(resp)[0]["project_name"] == "Alice Project"


def test_backlog_scoped_to_program_membership(
    calendar: Calendar, alice: object, bob: object
) -> None:
    a_prog = _program("Alice Prog")
    b_prog = _program("Bob Prog")
    _program_member(a_prog, alice)
    _program_member(b_prog, bob)  # alice is NOT a program member here
    _item(a_prog, "Beta story", BacklogItemType.STORY)
    _item(b_prog, "Beta story", BacklogItemType.STORY)

    resp = _client(alice).get(f"{URL}?q=beta")
    assert len(_results(resp)) == 1
    assert _results(resp)[0]["program_name"] == "Alice Prog"


def test_revoked_project_membership_excludes_task(calendar: Calendar, alice: object) -> None:
    project = _project(calendar, "Web", program=_program("P"))
    membership = ProjectMembership.objects.create(project=project, user=alice, role=Role.MEMBER)
    _task(project, "Gamma epic", TaskType.EPIC)
    membership.is_deleted = True
    membership.save(update_fields=["is_deleted"])

    resp = _client(alice).get(f"{URL}?q=gamma")
    assert _results(resp) == []


def test_deleted_task_and_project_excluded(calendar: Calendar, alice: object) -> None:
    project = _project(calendar, "Web", program=_program("P"))
    _project_member(project, alice)
    live = _task(project, "Delta epic", TaskType.EPIC)
    soft = _task(project, "Delta story", TaskType.STORY)
    soft.is_deleted = True
    soft.save(update_fields=["is_deleted"])

    resp = _client(alice).get(f"{URL}?q=delta&type=epic,story")
    assert _titles(resp) == {"Delta epic"}
    assert live.name == "Delta epic"


# ---------------------------------------------------------------------------
# Ranking + pagination
# ---------------------------------------------------------------------------


def test_prefix_matches_rank_first(calendar: Calendar, alice: object) -> None:
    project = _project(calendar, "Web", program=_program("P"))
    _project_member(project, alice)
    _task(project, "Improve login page", TaskType.STORY)  # contains, not prefix
    _task(project, "Login epic", TaskType.EPIC)  # prefix match

    resp = _client(alice).get(f"{URL}?q=login&type=epic,story")
    titles = [r["title"] for r in _results(resp)]
    assert titles[0] == "Login epic"  # prefix ranks above the contains match


def test_paginated_envelope_and_page_two(calendar: Calendar, alice: object) -> None:
    project = _project(calendar, "Web", program=_program("P"))
    _project_member(project, alice)
    for i in range(60):
        _task(project, f"Paginate story {i:03d}", TaskType.STORY)

    resp = _client(alice).get(f"{URL}?q=paginate")
    assert resp.data["count"] == 60
    assert len(_results(resp)) == 50  # default PAGE_SIZE
    assert resp.data["next"] is not None

    resp2 = _client(alice).get(f"{URL}?q=paginate&page=2")
    assert len(_results(resp2)) == 10
    assert resp2.data["previous"] is not None


# ---------------------------------------------------------------------------
# Throttle wiring
# ---------------------------------------------------------------------------


def test_throttle_scope_is_declared() -> None:
    from trueppm_api.apps.projects.views import MeSearchView

    assert MeSearchView.throttle_scope == "omni_search"
    assert any(
        getattr(c, "scope", None) == "omni_search" or c.__name__ == "ScopedRateThrottle"
        for c in MeSearchView.throttle_classes
    )
