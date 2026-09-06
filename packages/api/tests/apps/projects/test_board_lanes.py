"""The case 16 rendering rule, as a server derivation (#2953, ADR-0843).

These mirror `laneAssignment.test.ts` deliberately: the rule exists in two
places, and two answers to one question would be worse than one duplicated
answer — so the invariants are asserted identically on both sides. The server
copy is the oracle the structure-declaration suites assert invariant 1 through
(`test_structure_declaration_on_restructure.py`,
`test_structure_declaration_on_bulk_writes.py`).
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
