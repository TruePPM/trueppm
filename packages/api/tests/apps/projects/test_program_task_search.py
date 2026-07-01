"""Tests for the program-scoped task-search endpoint (#1150 / ADR-0120 D5 create side).

`GET /api/v1/programs/{id}/task-search/?q=<term>&exclude_project=<uuid>` backs the
cross-project dependency picker: it returns a slim list of tasks in the program's
member projects **the caller can read**, so a Scheduler can pick a sibling-project
task to gate against. Coverage: happy-path across two readable projects, the
`exclude_project` filter (the picker's own project), ADR-0120 D5 exclusion of a
non-readable member project, cross-program isolation, the blank-query short-circuit,
name-over-notes ranking, the IsProgramMember gate, and that a closed program stays
searchable (a read is not blocked by the closed-lifecycle write gate).
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
    Calendar,
    Program,
    Project,
    Task,
)

User = get_user_model()

START = date(2026, 3, 2)


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _url(program: Program, q: str, exclude: Project | None = None) -> str:
    url = f"/api/v1/programs/{program.pk}/task-search/?q={q}"
    if exclude is not None:
        url += f"&exclude_project={exclude.pk}"
    return url


@pytest.fixture
def program_two_projects(calendar: Calendar) -> tuple[Program, Project, Project]:
    """One program with two projects, A (Security) and B (Marketing)."""
    program = Program.objects.create(name="GA Launch")
    proj_a = Project.objects.create(
        name="Security", start_date=START, calendar=calendar, program=program
    )
    proj_b = Project.objects.create(
        name="Marketing", start_date=START, calendar=calendar, program=program
    )
    return program, proj_a, proj_b


@pytest.mark.django_db
def test_search_returns_tasks_across_readable_projects(
    program_two_projects: tuple[Program, Project, Project],
) -> None:
    """A program member with read access to both projects sees matching tasks from
    both, each carrying its owning project's id and name for grouping."""
    program, proj_a, proj_b = program_two_projects
    a1 = Task.objects.create(project=proj_a, name="Launch sign-off", duration=2)
    b1 = Task.objects.create(project=proj_b, name="Launch email", duration=1)
    Task.objects.create(project=proj_a, name="Unrelated", duration=1)

    user = User.objects.create_user(username="pm", password="pw")
    ProgramMembership.objects.create(program=program, user=user, role=Role.MEMBER)
    ProjectMembership.objects.create(project=proj_a, user=user, role=Role.SCHEDULER)
    ProjectMembership.objects.create(project=proj_b, user=user, role=Role.SCHEDULER)

    resp = _client(user).get(_url(program, "launch"))
    assert resp.status_code == 200, resp.data

    by_id = {row["id"]: row for row in resp.data}
    assert set(by_id) == {str(a1.pk), str(b1.pk)}
    assert by_id[str(a1.pk)]["project_name"] == "Security"
    assert by_id[str(b1.pk)]["project_name"] == "Marketing"
    # Slim shape only — no schedule internals leak through.
    assert set(by_id[str(a1.pk)]) == {
        "id",
        "name",
        "short_id",
        "project_id",
        "project_name",
    }


@pytest.mark.django_db
def test_search_excludes_the_pickers_own_project(
    program_two_projects: tuple[Program, Project, Project],
) -> None:
    """`exclude_project` drops the picker's own project — its tasks are already
    local, so re-offering them would be noise (and same-project edges are made in
    the local picker scope)."""
    program, proj_a, proj_b = program_two_projects
    Task.objects.create(project=proj_a, name="Launch sign-off", duration=2)
    b1 = Task.objects.create(project=proj_b, name="Launch email", duration=1)

    user = User.objects.create_user(username="pm", password="pw")
    ProgramMembership.objects.create(program=program, user=user, role=Role.MEMBER)
    ProjectMembership.objects.create(project=proj_a, user=user, role=Role.SCHEDULER)
    ProjectMembership.objects.create(project=proj_b, user=user, role=Role.SCHEDULER)

    resp = _client(user).get(_url(program, "launch", exclude=proj_a))
    assert resp.status_code == 200, resp.data
    assert [row["id"] for row in resp.data] == [str(b1.pk)]


@pytest.mark.django_db
def test_search_excludes_non_readable_project(
    program_two_projects: tuple[Program, Project, Project],
) -> None:
    """ADR-0120 D5: a member project the caller cannot read is not searched — its
    task titles never appear in the picker (creator needs read access to both)."""
    program, proj_a, proj_b = program_two_projects
    a1 = Task.objects.create(project=proj_a, name="Launch sign-off", duration=2)
    Task.objects.create(project=proj_b, name="Launch email", duration=1)

    user = User.objects.create_user(username="partial", password="pw")
    ProgramMembership.objects.create(program=program, user=user, role=Role.MEMBER)
    ProjectMembership.objects.create(project=proj_a, user=user, role=Role.SCHEDULER)
    # No ProjectMembership on B — not readable.

    resp = _client(user).get(_url(program, "launch"))
    assert resp.status_code == 200, resp.data
    assert [row["id"] for row in resp.data] == [str(a1.pk)]


@pytest.mark.django_db
def test_search_is_isolated_to_the_program(
    program_two_projects: tuple[Program, Project, Project],
    calendar: Calendar,
) -> None:
    """A task in another program is never returned, even when readable — the picker
    only offers same-program siblings (ADR-0120 is within-program)."""
    program, proj_a, _proj_b = program_two_projects
    a1 = Task.objects.create(project=proj_a, name="Launch sign-off", duration=2)

    other_program = Program.objects.create(name="Other")
    other_proj = Project.objects.create(
        name="Elsewhere", start_date=START, calendar=calendar, program=other_program
    )
    Task.objects.create(project=other_proj, name="Launch something", duration=1)

    user = User.objects.create_user(username="pm", password="pw")
    ProgramMembership.objects.create(program=program, user=user, role=Role.MEMBER)
    ProjectMembership.objects.create(project=proj_a, user=user, role=Role.SCHEDULER)
    # Readable in the *other* program too, but out of scope for this program's search.
    ProjectMembership.objects.create(project=other_proj, user=user, role=Role.SCHEDULER)

    resp = _client(user).get(_url(program, "launch"))
    assert resp.status_code == 200, resp.data
    assert [row["id"] for row in resp.data] == [str(a1.pk)]


@pytest.mark.django_db
def test_blank_query_returns_empty_without_scan(
    program_two_projects: tuple[Program, Project, Project],
) -> None:
    """A blank/whitespace term short-circuits to `[]` — the picker gates on a
    non-empty term, but the server must not fall through to an unbounded scan."""
    program, proj_a, _proj_b = program_two_projects
    Task.objects.create(project=proj_a, name="Launch sign-off", duration=2)

    user = User.objects.create_user(username="pm", password="pw")
    ProgramMembership.objects.create(program=program, user=user, role=Role.MEMBER)
    ProjectMembership.objects.create(project=proj_a, user=user, role=Role.SCHEDULER)

    resp = _client(user).get(_url(program, "%20%20"))
    assert resp.status_code == 200, resp.data
    assert resp.data == []


@pytest.mark.django_db
def test_name_match_ranks_above_notes_only_match(
    program_two_projects: tuple[Program, Project, Project],
) -> None:
    """A title hit sorts above a description-only hit so the most relevant task is
    the default keyboard selection."""
    program, proj_a, _proj_b = program_two_projects
    notes_only = Task.objects.create(
        project=proj_a, name="Backend work", notes="needs launch review", duration=1
    )
    name_hit = Task.objects.create(project=proj_a, name="Launch gate", duration=1)

    user = User.objects.create_user(username="pm", password="pw")
    ProgramMembership.objects.create(program=program, user=user, role=Role.MEMBER)
    ProjectMembership.objects.create(project=proj_a, user=user, role=Role.SCHEDULER)

    resp = _client(user).get(_url(program, "launch"))
    assert resp.status_code == 200, resp.data
    ids = [row["id"] for row in resp.data]
    assert ids == [str(name_hit.pk), str(notes_only.pk)]


@pytest.mark.django_db
def test_search_requires_program_membership(
    program_two_projects: tuple[Program, Project, Project],
) -> None:
    """Project access alone does not reach the program endpoint; a non-member gets
    404 (the membership-scoped queryset does not leak the program's existence)."""
    program, proj_a, _proj_b = program_two_projects
    Task.objects.create(project=proj_a, name="Launch sign-off", duration=2)

    user = User.objects.create_user(username="projonly", password="pw")
    ProjectMembership.objects.create(project=proj_a, user=user, role=Role.SCHEDULER)
    # No ProgramMembership row.

    resp = _client(user).get(_url(program, "launch"))
    assert resp.status_code == 404


@pytest.mark.django_db
def test_search_works_on_closed_program(
    program_two_projects: tuple[Program, Project, Project],
) -> None:
    """A closed program is still searchable — the picker is a read, and the closed
    lifecycle gate only blocks writes. (The edge itself is created via the
    per-project /dependencies/ POST, which carries its own project-lifecycle gate.)"""
    program, proj_a, _proj_b = program_two_projects
    a1 = Task.objects.create(project=proj_a, name="Launch sign-off", duration=2)
    program.is_closed = True
    program.save(update_fields=["is_closed"])

    user = User.objects.create_user(username="pm", password="pw")
    ProgramMembership.objects.create(program=program, user=user, role=Role.MEMBER)
    ProjectMembership.objects.create(project=proj_a, user=user, role=Role.SCHEDULER)

    resp = _client(user).get(_url(program, "launch"))
    assert resp.status_code == 200, resp.data
    assert [row["id"] for row in resp.data] == [str(a1.pk)]
