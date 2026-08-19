"""The case 16 rendering rule, as a server fact (#2953, ADR-0843).

These mirror `laneAssignment.test.ts` deliberately. The rule now exists in two
places, and two answers to one question would be worse than the API-first gap
this closes — so the invariants are asserted identically on both sides.
"""

from __future__ import annotations

from datetime import date

import pytest

from trueppm_api.apps.projects.board_lanes import ROOT_LANE_ID, build_lanes
from trueppm_api.apps.projects.models import Calendar, Project, Task


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="Pad 39C", start_date=date(2026, 3, 2), calendar=cal)


def mk(project: Project, path: str, name: str, **kw: object) -> Task:
    return Task.objects.create(project=project, wbs_path=path, name=name, duration=3, **kw)


@pytest.fixture
def tree(project: Project) -> list[Task]:
    """1 Mobilization > 1.1 Permits; 2 Procurement > 2.3 Electrical > 2.3.1 PO; 3 root work."""
    return [
        mk(project, "1", "Mobilization"),
        mk(project, "1.1", "Permits"),
        mk(project, "2", "Long-lead procurement"),
        mk(project, "2.3", "Electrical"),
        mk(project, "2.3.1", "Switchgear PO"),
        mk(project, "3", "Insurance certificate"),
    ]


@pytest.mark.django_db
class TestRenderingRule:
    def test_a_container_is_never_a_card(self, tree: list[Task]) -> None:
        lanes, _ = build_lanes(tree, project_name="Pad 39C")
        carded = {tid for lane in lanes for tid in lane.task_ids}
        by_name = {t.name: str(t.id) for t in tree}
        for container in ("Mobilization", "Long-lead procurement", "Electrical"):
            assert by_name[container] not in carded, f"{container} is a lane, never a card"

    def test_every_task_appears_exactly_once(self, tree: list[Task]) -> None:
        lanes, _ = build_lanes(tree, project_name="Pad 39C")
        carded = [tid for lane in lanes for tid in lane.task_ids]
        assert len(carded) == len(set(carded))
        assert len(carded) == 3, "Permits, Switchgear PO, Insurance certificate"

    def test_a_nested_card_lands_in_its_TOP_LEVEL_lane(self, tree: list[Task]) -> None:
        """Depth must not multiply lanes — that is the whole point."""
        lanes, _ = build_lanes(tree, project_name="Pad 39C")
        by_name = {t.name: str(t.id) for t in tree}
        procurement = next(x for x in lanes if x.id == by_name["Long-lead procurement"])
        assert by_name["Switchgear PO"] in procurement.task_ids
        assert not any(x.id == by_name["Electrical"] for x in lanes)

    def test_the_nested_container_travels_as_a_crumb(self, tree: list[Task]) -> None:
        _, crumbs = build_lanes(tree, project_name="Pad 39C")
        by_name = {t.name: str(t.id) for t in tree}
        assert crumbs[by_name["Switchgear PO"]] == "Electrical"

    def test_no_crumb_when_the_card_sits_directly_in_its_lane(self, tree: list[Task]) -> None:
        _, crumbs = build_lanes(tree, project_name="Pad 39C")
        by_name = {t.name: str(t.id) for t in tree}
        assert by_name["Permits"] not in crumbs

    def test_root_work_belongs_to_the_project_node(self, tree: list[Task]) -> None:
        lanes, _ = build_lanes(tree, project_name="Pad 39C")
        root = next(x for x in lanes if x.is_root)
        assert root.id == ROOT_LANE_ID
        assert root.name == "Pad 39C", "the lane carries the project's own name"

    def test_the_root_lane_is_absent_when_it_holds_nothing(self, project: Project) -> None:
        tasks = [mk(project, "1", "Mobilization"), mk(project, "1.1", "Permits")]
        lanes, _ = build_lanes(tasks, project_name="Pad 39C")
        assert not any(x.is_root for x in lanes)


@pytest.mark.django_db
class TestEdges:
    def test_lanes_order_numerically_not_lexically(self, project: Project) -> None:
        """`1.10` sorts after `1.9`, not between 1 and 2."""
        tasks = [mk(project, str(i), f"Phase {i}") for i in range(1, 12)]
        tasks += [mk(project, f"{i}.1", f"Work {i}") for i in range(1, 12)]
        lanes, _ = build_lanes(tasks, project_name="P")
        assert [x.name for x in lanes][:3] == ["Phase 1", "Phase 2", "Phase 3"]
        assert [x.name for x in lanes][-1] == "Phase 11"

    def test_a_subtask_is_never_structural(self, project: Project) -> None:
        """A checklist item is not a lane and not a card."""
        tasks = [mk(project, "1", "Leaf"), mk(project, "1.1", "Check A", is_subtask=True)]
        lanes, _ = build_lanes(tasks, project_name="P")
        root = next(x for x in lanes if x.is_root)
        assert len(root.task_ids) == 1, "the leaf is a card; its subtask is not"

    def test_an_orphaned_card_is_not_dropped(self, project: Project) -> None:
        """A gap in the tree (deleted ancestor) must not lose the work."""
        tasks = [mk(project, "4.2", "Stranded")]
        lanes, _ = build_lanes(tasks, project_name="P")
        carded = [tid for lane in lanes for tid in lane.task_ids]
        assert len(carded) == 1

    def test_group_depth_is_a_parameter(self, tree: list[Task]) -> None:
        """No UI exposes it; a client may still ask."""
        lanes, crumbs = build_lanes(tree, project_name="P", group_depth=2)
        by_name = {t.name: str(t.id) for t in tree}
        assert any(x.id == by_name["Electrical"] for x in lanes), "deeper lanes at depth 2"
        assert by_name["Switchgear PO"] not in crumbs, "its lane IS its parent now"


@pytest.mark.django_db
class TestEndpoint:
    """The rule reachable over HTTP — the point of the whole issue."""

    @pytest.fixture
    def client(self, db: object):  # type: ignore[no-untyped-def]
        from django.contrib.auth import get_user_model
        from rest_framework.test import APIClient

        user = get_user_model().objects.create_user(username="laneuser", password="pw")
        c = APIClient()
        c.force_authenticate(user=user)
        c._user = user  # type: ignore[attr-defined]
        return c

    @pytest.fixture
    def membership(self, client, project: Project):  # type: ignore[no-untyped-def]
        from trueppm_api.apps.access.models import ProjectMembership, Role

        return ProjectMembership.objects.create(project=project, user=client._user, role=Role.OWNER)

    def test_returns_lanes_with_real_container_ids(
        self, client, project: Project, tree: list[Task], membership: object
    ) -> None:
        r = client.get(f"/api/v1/projects/{project.id}/board/lanes/")
        assert r.status_code == 200
        by_name = {t.name: str(t.id) for t in tree}
        ids = [x["id"] for x in r.data["lanes"]]
        assert by_name["Mobilization"] in ids
        assert "root" in ids, "the project node is a lane, not a synthetic bucket"

    def test_the_root_lane_carries_the_projects_name(
        self, client, project: Project, tree: list[Task], membership: object
    ) -> None:
        r = client.get(f"/api/v1/projects/{project.id}/board/lanes/")
        root = next(x for x in r.data["lanes"] if x["is_root"])
        assert root["name"] == "Pad 39C"

    def test_crumbs_name_the_nested_container(
        self, client, project: Project, tree: list[Task], membership: object
    ) -> None:
        r = client.get(f"/api/v1/projects/{project.id}/board/lanes/")
        by_name = {t.name: str(t.id) for t in tree}
        assert r.data["crumbs"][by_name["Switchgear PO"]] == "Electrical"

    def test_group_depth_is_honored_and_echoed(
        self, client, project: Project, tree: list[Task], membership: object
    ) -> None:
        r = client.get(f"/api/v1/projects/{project.id}/board/lanes/?group_depth=2")
        assert r.data["group_depth"] == 2

    def test_a_junk_group_depth_falls_back_rather_than_500ing(
        self, client, project: Project, tree: list[Task], membership: object
    ) -> None:
        """The #2795 class: a query param is user-controlled input."""
        for junk in ("abc", "", "-4", "0"):
            r = client.get(f"/api/v1/projects/{project.id}/board/lanes/?group_depth={junk}")
            assert r.status_code == 200, junk
            assert r.data["group_depth"] >= 1

    def test_a_non_member_is_refused(self, client, project: Project, tree: list[Task]) -> None:
        r = client.get(f"/api/v1/projects/{project.id}/board/lanes/")
        assert r.status_code in (403, 404)


class TestSchemaBinding:
    """The #2455 orphaned-decorator trap, pinned.

    Inserting a view between an existing ``@extend_schema_view`` and the class it
    decorates silently reassigns that decorator to the new view — the new view
    gets the wrong response, and the original view loses its schema entirely.
    That happened while building this endpoint and was invisible until the
    generated schema was read back.
    """

    @staticmethod
    def _schema() -> dict:
        import json
        from pathlib import Path

        root = Path(__file__).resolve().parents[5]
        return json.loads((root / "docs" / "api" / "openapi.json").read_text())

    def test_lanes_declares_its_own_response(self) -> None:
        s = self._schema()["paths"]["/api/v1/projects/{id}/board/lanes/"]["get"]
        ref = s["responses"]["200"]["content"]["application/json"]["schema"]["$ref"]
        assert ref.endswith("/BoardLanes")

    def test_board_config_kept_its_own(self) -> None:
        """The half that would have regressed silently."""
        s = self._schema()["paths"]["/api/v1/projects/{id}/board-config/"]["get"]
        ref = s["responses"]["200"]["content"]["application/json"]["schema"]["$ref"]
        assert ref.endswith("/BoardColumnConfigResponse")

    def test_group_depth_is_a_declared_parameter(self) -> None:
        s = self._schema()["paths"]["/api/v1/projects/{id}/board/lanes/"]["get"]
        assert "group_depth" in [q["name"] for q in s.get("parameters", [])]

    def test_the_lane_shape_is_visible_not_a_bare_object(self) -> None:
        props = self._schema()["components"]["schemas"]["BoardLanes"]["properties"]
        assert set(props) == {"group_depth", "lanes", "crumbs"}
