"""Tests for the program-scoped cross-project label view (#2333, ADR-0638).

Covers:
- The OSS boundary: the program is a path segment, and the route never fans out
  beyond the one program in the URL.
- The ADR-0120 D5 access model: program membership admits, project membership
  reveals, and what is withheld is disclosed rather than silently dropped.
- Case-insensitive name matching, and the catalog agreeing with the filter.
- Fail-closed behavior on a missing label parameter.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.models import Label, Program, Project, Task

User = get_user_model()


def _client(user: object) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def lead(db: object) -> object:
    return User.objects.create_user(username="lead", password="pw")


@pytest.fixture
def partial(db: object) -> object:
    """A program member who belongs to only one of the program's projects."""
    return User.objects.create_user(username="partial", password="pw")


@pytest.fixture
def stranger(db: object) -> object:
    return User.objects.create_user(username="stranger", password="pw")


@pytest.fixture
def program(lead: object, partial: object) -> Program:
    program = Program.objects.create(name="Apollo", code="APOLLO")
    ProgramMembership.objects.create(program=program, user=lead, role=Role.OWNER)
    ProgramMembership.objects.create(program=program, user=partial, role=Role.MEMBER)
    return program


def _project(program: Program, name: str, code: str, *users: object) -> Project:
    project = Project.objects.create(name=name, code=code, start_date="2026-01-05", program=program)
    for user in users:
        ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)
    return project


def _task_with_label(
    project: Project, task_name: str, label_name: str, color: str, wbs_path: str = "1.1"
) -> Task:
    label, _ = Label.objects.get_or_create(
        project=project, name=label_name, defaults={"color": color}
    )
    # wbs_path only needs to be unique per project here (#3048) — the tests in this
    # file exercise label filtering, not WBS structure, so the value itself is
    # arbitrary as long as two tasks in the same project never share one.
    task = Task.objects.create(project=project, name=task_name, wbs_path=wbs_path)
    task.labels.add(label)
    return task


@pytest.fixture
def seeded(program: Program, lead: object, partial: object) -> dict[str, object]:
    """Two projects in the program; `partial` belongs to only the first.

    The same label name carries a DIFFERENT color per project, which is the
    condition ADR-0638 D3 is about.
    """
    ares = _project(program, "Ares Platform", "APL", lead, partial)
    beacon = _project(program, "Beacon API", "BCN", lead)
    _task_with_label(ares, "Threat model", "security-review", "teal")
    _task_with_label(beacon, "Auth review", "Security-Review", "amber")
    _task_with_label(beacon, "Unrelated work", "performance", "blue", wbs_path="1.2")
    return {"ares": ares, "beacon": beacon}


def _tasks_url(program: Program) -> str:
    return f"/api/v1/programs/{program.id}/label-tasks/"


def _catalog_url(program: Program) -> str:
    return f"/api/v1/programs/{program.id}/label-catalog/"


# ---------------------------------------------------------------------------
# Access — ADR-0120 D5: program membership admits, project membership reveals
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_non_program_member_is_forbidden(program: Program, seeded: dict, stranger: object) -> None:
    """403 before the queryset runs — never an ambiguous empty 200."""
    response = _client(stranger).get(_tasks_url(program), {"label": "security-review"})
    assert response.status_code == 403


@pytest.mark.django_db
def test_full_member_sees_matches_across_every_project(
    program: Program, seeded: dict, lead: object
) -> None:
    response = _client(lead).get(_tasks_url(program), {"label": "security-review"})
    assert response.status_code == 200
    names = {row["name"] for row in response.data["results"]}
    assert names == {"Threat model", "Auth review"}
    assert response.data["withheld_project_count"] == 0


@pytest.mark.django_db
def test_partial_member_sees_only_readable_projects_and_is_told(
    program: Program, seeded: dict, partial: object
) -> None:
    """The disclosure is the point: a silently partial list is a wrong answer."""
    response = _client(partial).get(_tasks_url(program), {"label": "security-review"})
    assert response.status_code == 200
    names = {row["name"] for row in response.data["results"]}
    assert names == {"Threat model"}
    assert response.data["withheld_project_count"] == 1


@pytest.mark.django_db
def test_tasks_from_another_program_never_appear(
    program: Program, seeded: dict, lead: object
) -> None:
    """The path segment is the OSS boundary — it must actually bound the read."""
    other = Program.objects.create(name="Zeus", code="ZEUS")
    ProgramMembership.objects.create(program=other, user=lead, role=Role.OWNER)
    other_project = _project(other, "Zeus Core", "ZUS", lead)
    _task_with_label(other_project, "Zeus security", "security-review", "rose")

    response = _client(lead).get(_tasks_url(program), {"label": "security-review"})
    assert response.status_code == 200
    names = {row["name"] for row in response.data["results"]}
    assert "Zeus security" not in names
    assert names == {"Threat model", "Auth review"}


# ---------------------------------------------------------------------------
# Matching semantics — ADR-0638 Decision 3
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize("query", ["security-review", "Security-Review", "SECURITY-REVIEW"])
def test_label_match_is_case_insensitive(
    program: Program, seeded: dict, lead: object, query: str
) -> None:
    response = _client(lead).get(_tasks_url(program), {"label": query})
    assert response.status_code == 200
    assert len(response.data["results"]) == 2


@pytest.mark.django_db
def test_each_row_carries_its_own_project_label_color(
    program: Program, seeded: dict, lead: object
) -> None:
    """The same name is legitimately two colors — one per project, never normalized."""
    response = _client(lead).get(_tasks_url(program), {"label": "security-review"})
    by_task = {
        row["name"]: [lbl["color"] for lbl in row["labels"]] for row in response.data["results"]
    }
    assert "teal" in by_task["Threat model"]
    assert "amber" in by_task["Auth review"]


@pytest.mark.django_db
def test_rows_carry_project_attribution(program: Program, seeded: dict, lead: object) -> None:
    response = _client(lead).get(_tasks_url(program), {"label": "security-review"})
    row = next(r for r in response.data["results"] if r["name"] == "Auth review")
    assert row["project"]["name"] == "Beacon API"
    assert row["project"]["code"] == "BCN"


@pytest.mark.django_db
def test_results_are_grouped_by_project_name(program: Program, seeded: dict, lead: object) -> None:
    """Ordering must be total and stable or pagination silently skips rows."""
    response = _client(lead).get(_tasks_url(program), {"label": "security-review"})
    project_names = [row["project"]["name"] for row in response.data["results"]]
    assert project_names == sorted(project_names)


@pytest.mark.django_db
def test_label_present_in_only_one_project_still_matches(
    program: Program, seeded: dict, lead: object
) -> None:
    response = _client(lead).get(_tasks_url(program), {"label": "performance"})
    assert response.status_code == 200
    assert [row["name"] for row in response.data["results"]] == ["Unrelated work"]


@pytest.mark.django_db
def test_soft_deleted_label_stops_matching(program: Program, seeded: dict, lead: object) -> None:
    Label.objects.filter(name="performance").update(is_deleted=True)
    response = _client(lead).get(_tasks_url(program), {"label": "performance"})
    assert response.data["results"] == []


@pytest.mark.django_db
def test_task_with_two_matching_labels_is_not_duplicated(
    program: Program, seeded: dict, lead: object
) -> None:
    ares = seeded["ares"]
    task = Task.objects.get(name="Threat model")
    extra = Label.objects.create(project=ares, name="SECURITY-REVIEW ", color="rose")
    task.labels.add(extra)

    response = _client(lead).get(_tasks_url(program), {"label": "security-review"})
    ids = [row["id"] for row in response.data["results"]]
    assert len(ids) == len(set(ids))


# ---------------------------------------------------------------------------
# Fail-closed on a missing filter — ADR-0638 Durable Execution §8
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize("params", [{}, {"label": ""}, {"label": "   "}])
def test_missing_label_is_a_400_not_a_program_wide_dump(
    program: Program, seeded: dict, lead: object, params: dict
) -> None:
    response = _client(lead).get(_tasks_url(program), params)
    assert response.status_code == 400
    assert "label" in response.data


@pytest.mark.django_db
def test_unknown_label_returns_empty_not_error(
    program: Program, seeded: dict, lead: object
) -> None:
    response = _client(lead).get(_tasks_url(program), {"label": "no-such-label"})
    assert response.status_code == 200
    assert response.data["results"] == []


# ---------------------------------------------------------------------------
# Catalog
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_catalog_lists_distinct_names_with_project_counts(
    program: Program, seeded: dict, lead: object
) -> None:
    response = _client(lead).get(_catalog_url(program))
    assert response.status_code == 200
    by_name = {row["name"]: row["project_count"] for row in response.data["results"]}
    # "security-review" and "Security-Review" are ONE concept in two projects.
    assert by_name == {"Security-Review": 2, "performance": 1}


@pytest.mark.django_db
def test_catalog_agrees_with_the_filter(program: Program, seeded: dict, lead: object) -> None:
    """A picker entry that returns nothing would be a contradiction, not a filter."""
    catalog = _client(lead).get(_catalog_url(program))
    for row in catalog.data["results"]:
        tasks = _client(lead).get(_tasks_url(program), {"label": row["name"]})
        assert tasks.status_code == 200
        assert len(tasks.data["results"]) > 0


@pytest.mark.django_db
def test_catalog_scopes_to_readable_projects_and_discloses(
    program: Program, seeded: dict, partial: object
) -> None:
    response = _client(partial).get(_catalog_url(program))
    by_name = {row["name"] for row in response.data["results"]}
    assert by_name == {"security-review"}
    assert response.data["withheld_project_count"] == 1


@pytest.mark.django_db
def test_catalog_forbidden_for_non_program_member(
    program: Program, seeded: dict, stranger: object
) -> None:
    assert _client(stranger).get(_catalog_url(program)).status_code == 403


# ---------------------------------------------------------------------------
# Ordering is a correctness property, not a preference
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize("ordering", ["-name", "name", "status", "-wbs_path"])
def test_client_cannot_override_the_project_grouping(
    program: Program, seeded: dict, lead: object, ordering: str
) -> None:
    """`OrderingFilter` is enabled globally; this view must not inherit it.

    Two things break if a caller can reorder these rows: the UI groups by
    project and assumes they arrive grouped, and `name` is not unique — so
    ordering by it alone is not a total order, which lets page boundaries skip
    or repeat rows.
    """
    response = _client(lead).get(
        _tasks_url(program), {"label": "security-review", "ordering": ordering}
    )
    assert response.status_code == 200
    project_names = [row["project"]["name"] for row in response.data["results"]]
    assert project_names == sorted(project_names)


@pytest.mark.django_db
@pytest.mark.parametrize("url_name", ["label-tasks", "label-catalog"])
def test_malformed_program_id_is_not_a_500(lead: object, url_name: str) -> None:
    """The #2213 class: a non-UUID path segment must not reach the DB raw."""
    response = _client(lead).get(f"/api/v1/programs/not-a-uuid/{url_name}/", {"label": "x"})
    assert response.status_code in (400, 404)
