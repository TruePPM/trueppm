"""A restructure cannot leave a link between a summary and its own descendant (#4705).

``Design -FS-> Build`` on adjacent rows, then indent Build, gives ``Design{Build} -FS->
Build``. ``find_cycle`` and the engine's summary expansion both treat such a link as a
cycle, so after that move every recalculation of the project is refused. Indent,
outdent and reparent run no cycle check of their own, so each now refuses the move
with ``summary_descendant_link`` before any row changes. Each refusal test asserts
the outline is unchanged, and each endpoint has a test that an unrelated move of a
linked task still succeeds.
"""

from __future__ import annotations

from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient
from trueppm_scheduler import find_cycle

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task
from trueppm_api.apps.projects.serializers import _load_project_tasks_and_children_map

User = get_user_model()

INDENT_URL = "/api/v1/projects/{pk}/tasks/{task_id}/indent/"
OUTDENT_URL = "/api/v1/projects/{pk}/tasks/{task_id}/outdent/"
REPARENT_URL = "/api/v1/projects/{pk}/tasks/{task_id}/reparent/"

CODE = "summary_descendant_link"


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="Guard", start_date=date(2026, 1, 5), calendar=cal)


@pytest.fixture
def owner_client(project: Project) -> APIClient:
    user = User.objects.create_user(username="owner", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _task(project: Project, name: str, path: str) -> Task:
    return Task.objects.create(project=project, name=name, duration=2, wbs_path=path)


def _link(pred: Task, succ: Task, dep_type: str = "FS") -> Dependency:
    return Dependency.objects.create(predecessor=pred, successor=succ, dep_type=dep_type)


def _post(client: APIClient, url: str, body: Any = None) -> Any:
    with (
        patch("django.db.transaction.on_commit", side_effect=lambda fn, *a, **kw: fn()),
        patch("trueppm_api.apps.scheduling.services.enqueue_recalculate"),
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
    ):
        return client.post(url, body if body is not None else {}, format="json")


def _outline(project: Project) -> dict[str, str]:
    return {
        name: str(path)
        for name, path in Task.objects.filter(project=project, is_deleted=False).values_list(
            "name", "wbs_path"
        )
    }


def _assert_refused(
    response: Any, link: Dependency, before: dict[str, str], project: Project
) -> None:
    assert response.status_code == 400, response.data
    body = response.json()
    assert body["code"] == CODE
    assert {
        "id": str(link.pk),
        "dep_type": link.dep_type,
        "successor_id": str(link.successor_id),
    } in (body["blocking_dependencies"])
    assert f"“{link.predecessor.name}” → “{link.successor.name}”" in body["detail"]
    assert _outline(project) == before


def _project_is_schedulable(project: Project) -> bool:
    """What the guard protects: ``find_cycle`` over the stored links and outline."""
    _, children_map = _load_project_tasks_and_children_map(project.pk)
    edges = [
        (str(p), str(s))
        for p, s in Dependency.live.filter(predecessor__project=project).values_list(
            "predecessor_id", "successor_id"
        )
    ]
    return not find_cycle(edges, children_map=children_map)


@pytest.mark.django_db
class TestIndent:
    def test_issue_repro_is_refused(self, project: Project, owner_client: APIClient) -> None:
        """Design -FS-> Build on adjacent rows; indenting Build would nest it under Design."""
        design = _task(project, "Design", "1")
        build = _task(project, "Build", "2")
        link = _link(design, build)
        before = _outline(project)

        response = _post(owner_client, INDENT_URL.format(pk=project.pk, task_id=build.pk))

        _assert_refused(response, link, before, project)
        assert _project_is_schedulable(project)

    def test_link_into_the_moved_subtree_from_below_is_refused(
        self, project: Project, owner_client: APIClient
    ) -> None:
        """A subtask of the moved row linked back to the new parent counts too."""
        design = _task(project, "Design", "1")
        build = _task(project, "Build", "2")
        wire = _task(project, "Wire", "2.1")
        link = _link(wire, design, "FF")
        before = _outline(project)

        response = _post(owner_client, INDENT_URL.format(pk=project.pk, task_id=build.pk))

        _assert_refused(response, link, before, project)

    def test_unrelated_indent_of_a_linked_task_succeeds(
        self, project: Project, owner_client: APIClient
    ) -> None:
        phase = _task(project, "Phase", "1")
        build = _task(project, "Build", "2")
        ship = _task(project, "Ship", "3")
        _link(build, ship)

        response = _post(owner_client, INDENT_URL.format(pk=project.pk, task_id=build.pk))

        assert response.status_code == 200, response.data
        build.refresh_from_db()
        assert str(build.wbs_path) == f"{phase.wbs_path}.1"
        assert _project_is_schedulable(project)


@pytest.mark.django_db
class TestOutdent:
    def test_adopting_a_linked_follower_is_refused(
        self, project: Project, owner_client: APIClient
    ) -> None:
        """Outdenting Design makes it adopt Build, the sibling it is linked to."""
        _task(project, "Phase", "1")
        design = _task(project, "Design", "1.1")
        build = _task(project, "Build", "1.2")
        link = _link(design, build)
        before = _outline(project)

        response = _post(owner_client, OUTDENT_URL.format(pk=project.pk, task_id=design.pk))

        _assert_refused(response, link, before, project)
        assert _project_is_schedulable(project)

    def test_unrelated_outdent_of_a_linked_task_succeeds(
        self, project: Project, owner_client: APIClient
    ) -> None:
        _task(project, "Phase", "1")
        design = _task(project, "Design", "1.1")
        _task(project, "Build", "1.2")
        ship = _task(project, "Ship", "2")
        _link(design, ship)

        response = _post(owner_client, OUTDENT_URL.format(pk=project.pk, task_id=design.pk))

        assert response.status_code == 200, response.data
        design.refresh_from_db()
        assert str(design.wbs_path) == "2"
        assert _project_is_schedulable(project)


@pytest.mark.django_db
class TestReparent:
    def test_reparent_under_the_linked_task_is_refused(
        self, project: Project, owner_client: APIClient
    ) -> None:
        design = _task(project, "Design", "1")
        build = _task(project, "Build", "2")
        link = _link(build, design)
        before = _outline(project)

        response = _post(
            owner_client,
            REPARENT_URL.format(pk=project.pk, task_id=build.pk),
            {"new_parent_id": str(design.pk)},
        )

        _assert_refused(response, link, before, project)
        assert _project_is_schedulable(project)

    def test_link_to_a_new_grand_ancestor_is_refused(
        self, project: Project, owner_client: APIClient
    ) -> None:
        """The target's own ancestors become ancestors of the moved row too."""
        program = _task(project, "Program", "1")
        design = _task(project, "Design", "1.1")
        build = _task(project, "Build", "2")
        link = _link(program, build)
        before = _outline(project)

        response = _post(
            owner_client,
            REPARENT_URL.format(pk=project.pk, task_id=build.pk),
            {"new_parent_id": str(design.pk)},
        )

        _assert_refused(response, link, before, project)

    def test_unrelated_reparent_of_a_linked_task_succeeds(
        self, project: Project, owner_client: APIClient
    ) -> None:
        phase = _task(project, "Phase", "1")
        _task(project, "Spec", "1.1")
        build = _task(project, "Build", "2")
        ship = _task(project, "Ship", "3")
        _link(build, ship)

        response = _post(
            owner_client,
            REPARENT_URL.format(pk=project.pk, task_id=build.pk),
            {"new_parent_id": str(phase.pk)},
        )

        assert response.status_code == 200, response.data
        build.refresh_from_db()
        assert str(build.wbs_path) == "1.2"
        assert _project_is_schedulable(project)


@pytest.mark.django_db
class TestMoreShapes:
    """The differential and the deep-descendant cases (fix-diff re-check of #4705)."""

    def test_outdent_refused_when_linked_to_a_followers_descendant(
        self, project: Project, owner_client: APIClient
    ) -> None:
        """Adopting Build also brings Build's subtask under Design."""
        _task(project, "Phase", "1")
        design = _task(project, "Design", "1.1")
        _task(project, "Build", "1.2")
        wire = _task(project, "Wire", "1.2.1")
        link = _link(design, wire)
        before = _outline(project)

        response = _post(owner_client, OUTDENT_URL.format(pk=project.pk, task_id=design.pk))

        _assert_refused(response, link, before, project)

    def test_reparent_refused_when_a_moved_descendant_links_to_the_target(
        self, project: Project, owner_client: APIClient
    ) -> None:
        design = _task(project, "Design", "1")
        build = _task(project, "Build", "2")
        wire = _task(project, "Wire", "2.1")
        link = _link(wire, design, "FF")
        before = _outline(project)

        response = _post(
            owner_client,
            REPARENT_URL.format(pk=project.pk, task_id=build.pk),
            {"new_parent_id": str(design.pk)},
        )

        _assert_refused(response, link, before, project)

    def test_reparent_is_not_blamed_for_a_link_to_a_shared_existing_ancestor(
        self, project: Project, owner_client: APIClient
    ) -> None:
        """Program was already Build's ancestor; moving Build within it adds nothing new.

        The pre-existing ``Program -> Build`` link already breaks the rule, and
        refusing every move inside Program on that account would block the edits that
        repair the plan. Only ancestors the move *adds* (Design) are checked.
        """
        program = _task(project, "Program", "1")
        design = _task(project, "Design", "1.1")
        build = _task(project, "Build", "1.2")
        _link(program, build)

        response = _post(
            owner_client,
            REPARENT_URL.format(pk=project.pk, task_id=build.pk),
            {"new_parent_id": str(design.pk)},
        )

        assert response.status_code == 200, response.data
        build.refresh_from_db()
        assert str(build.wbs_path) == "1.1.1"
