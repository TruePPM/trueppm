"""Declaring a container on the BULK write paths, and a guard on the next one (#3030).

``sync_structure_shadow_values`` is what declares a row a container
(``structure_role = CONTAINER``, ``auto_container = True``). #2950 wired it into task
create and delete, #3010 into indent / outdent / reparent / reorder. ``bulk_create``
reaches none of them, because it never calls ``Task.save()`` — so a parent written by a
bulk path landed ``structure_role='work'`` *with children*, and the Board's rendering
rule (ADR-0843, #2947) had nothing to key on. An MS Project import — a headline way in —
arrived with every phase undeclared, and #2909's bundled starters made template
materialization a first-run path with the same defect.

**This file is deliberately two halves, and the second is the point.** This was the third
site of one defect. Patching each writer as it is found is what let the class survive
three rounds — the same shape as the CSV escaper (#2762 → #2892), which only ended when
someone wrote a source-scanning test. So the behavioral tests below assert the two live
paths, and ``TestNoBulkWriterGoesAroundTheFunnel`` asserts that a **fourth** bulk writer
cannot be added without tripping — plus its own non-vacuity, because an enumeration that
matches nothing passes silently, which is what made the sub-12px lint gate useless.
"""

from __future__ import annotations

import ast
import uuid
from datetime import date
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

import trueppm_api
from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.msproject.importer import import_project
from trueppm_api.apps.msproject.parser import ProjectData, TaskData
from trueppm_api.apps.projects.board_lanes import ROOT_LANE_ID, build_lanes
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    ProjectTemplate,
    StructureRole,
    Task,
    bulk_create_tasks,
    declare_containers_in_batch,
    wbs_ancestor_paths,
)
from trueppm_api.apps.projects.project_templates import (
    STRUCTURE_VERSION,
    materialize_structure,
)

User = get_user_model()

pytestmark = pytest.mark.django_db


# ── Fixtures ────────────────────────────────────────────────────────────────────


@pytest.fixture
def calendar() -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def user() -> Any:
    return User.objects.create_user(username="importer", password="pw")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Runway 27", start_date=date(2026, 1, 5), calendar=calendar)


@pytest.fixture
def owner_client(user: Any, project: Project) -> APIClient:
    ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _two_phase_file() -> ProjectData:
    """One phase with two tasks under it, one flat task beside it.

    Deliberately mixed: the assertions have to separate "declared because it has
    children" from "declared because the import declared everything".
    """
    return ProjectData(
        tasks=[
            TaskData(uid=1, name="Mobilization", duration_days=4, outline_number="1"),
            TaskData(uid=2, name="Permits", duration_days=3, outline_number="1.1"),
            TaskData(uid=3, name="Survey", duration_days=2, outline_number="1.2"),
            TaskData(uid=4, name="Punch list", duration_days=1, outline_number="2"),
        ]
    )


def undeclared_containers(project: Project) -> list[str]:
    """Rows that have structural children and still claim to be work — the invariant.

    The whole defect in one query, expressed as data rather than as a code path, so it
    holds however the row was written. Any bulk writer that skips the declaration
    lights this up.
    """
    rows = list(Task.objects.filter(project=project, is_deleted=False, is_subtask=False))
    ancestors = wbs_ancestor_paths([str(r.wbs_path) for r in rows if r.wbs_path])
    return sorted(
        f"{r.name} ({r.wbs_path})"
        for r in rows
        if r.wbs_path and str(r.wbs_path) in ancestors and r.structure_role == StructureRole.WORK
    )


# ── MS Project import — shared by the Jira and CSV importers too ─────────────────


class TestMsProjectImportDeclaresItsContainers:
    def test_an_imported_phase_lands_declared(self, project: Project) -> None:
        import_project(str(project.pk), _two_phase_file())

        phase = Task.objects.get(project=project, name="Mobilization")
        assert phase.structure_role == StructureRole.CONTAINER
        assert phase.auto_container is True, (
            "it became a container by gaining a child, so losing the last one reverts it"
        )

    def test_the_phase_parks_its_authored_status_and_estimate(self, project: Project) -> None:
        """Not decoration: the first rollup overwrites the live fields.

        Without the park the file's own duration is gone the moment CPM runs, with no
        way back — the same data loss #2950 exists to prevent, just reached through a
        different door.
        """
        import_project(str(project.pk), _two_phase_file())

        phase = Task.objects.get(project=project, name="Mobilization")
        assert phase.own_estimate == 4
        assert phase.own_status == phase.status

    def test_leaf_rows_are_left_alone(self, project: Project) -> None:
        import_project(str(project.pk), _two_phase_file())

        for name in ("Permits", "Survey", "Punch list"):
            row = Task.objects.get(project=project, name=name)
            assert row.structure_role == StructureRole.WORK, name
            assert row.auto_container is False, name
            assert row.own_estimate is None, name

    def test_a_deep_tree_declares_every_level(self, project: Project) -> None:
        """A grandparent is a container too — the sweep is over strict prefixes,
        not over "has a direct child in the file"."""
        import_project(
            str(project.pk),
            ProjectData(
                tasks=[
                    TaskData(uid=1, name="Program", duration_days=1, outline_number="1"),
                    TaskData(uid=2, name="Phase", duration_days=1, outline_number="1.1"),
                    TaskData(uid=3, name="Work", duration_days=1, outline_number="1.1.1"),
                ]
            ),
        )
        assert undeclared_containers(project) == []
        for name in ("Program", "Phase"):
            assert Task.objects.get(project=project, name=name).structure_role == (
                StructureRole.CONTAINER
            )

    def test_the_whole_import_leaves_no_undeclared_container(self, project: Project) -> None:
        import_project(str(project.pk), _two_phase_file())
        assert undeclared_containers(project) == []


# ── Template materialization — a first-run path since #2909 ──────────────────────


def _template(owner: Any) -> ProjectTemplate:
    return ProjectTemplate.objects.create(
        name="Construction starter",
        owner=owner,
        structure={
            "version": STRUCTURE_VERSION,
            "tasks": [
                {"ref": "a", "name": "Design", "wbs_path": "1", "duration": 6},
                {"ref": "b", "name": "Drawings", "wbs_path": "1.1", "duration": 3},
                {"ref": "c", "name": "Review", "wbs_path": "1.2", "duration": 2},
                {"ref": "d", "name": "Handover", "wbs_path": "2", "duration": 1},
            ],
            "dependencies": [],
        },
    )


class TestTemplateMaterializationDeclaresItsContainers:
    def test_a_materialized_phase_lands_declared(self, project: Project, user: Any) -> None:
        materialize_structure(_template(user), project)

        phase = Task.objects.get(project=project, name="Design")
        assert phase.structure_role == StructureRole.CONTAINER
        assert phase.auto_container is True
        assert phase.own_estimate == 6
        assert undeclared_containers(project) == []

    def test_a_flat_template_declares_nothing(self, project: Project, user: Any) -> None:
        """The no-op case earns a test: a pass that declares everything would also
        make ``undeclared_containers`` empty, and prove nothing."""
        template = ProjectTemplate.objects.create(
            name="Flat",
            owner=user,
            structure={
                "version": STRUCTURE_VERSION,
                "tasks": [
                    {"ref": "a", "name": "A", "wbs_path": "1", "duration": 1},
                    {"ref": "b", "name": "B", "wbs_path": "2", "duration": 1},
                ],
                "dependencies": [],
            },
        )
        materialize_structure(template, project)

        assert [r.structure_role for r in Task.objects.filter(project=project)] == [
            StructureRole.WORK,
            StructureRole.WORK,
        ]


# ── The Board invariant the declaration exists to serve ──────────────────────────


class TestBoardRendersAnImportedPhaseAsALane:
    def test_an_imported_phase_is_a_lane_never_a_card(self, project: Project) -> None:
        """Invariant 1 of ADR-0843: a container is never a card.

        This is the thing a user would actually notice — the first screen after an
        import. ``build_lanes`` derives container-ness from the child count today, so
        this is pinned as the invariant the declaration serves: when the board is moved
        onto the declared role, an imported phase must already be covered, and with the
        fix reverted the declaration assertion here is what fails first.
        """
        import_project(str(project.pk), _two_phase_file())

        phase = Task.objects.get(project=project, name="Mobilization")
        assert phase.structure_role == StructureRole.CONTAINER, (
            "the lane's identity is the declared role, not a re-derivation per render"
        )

        tasks = list(Task.objects.filter(project=project, is_deleted=False))
        lanes, _crumbs = build_lanes(tasks, project_name=project.name)

        lane = next((lightweight for lightweight in lanes if lightweight.id == str(phase.id)), None)
        assert lane is not None, "the imported phase is a lane"
        assert lane.name == "Mobilization"
        child_ids = {
            str(Task.objects.get(project=project, name=n).id) for n in ("Permits", "Survey")
        }
        assert child_ids <= set(lane.task_ids)
        # And it is nowhere a card — not in its own lane, not in the project node.
        assert not any(str(phase.id) in other.task_ids for other in lanes)
        assert any(other.id == ROOT_LANE_ID for other in lanes), "the flat row still has a home"


# ── The reverse: an imported container de-promotes and hands the values back ─────


class TestDePromotionOfABulkWrittenContainer:
    def test_deleting_the_last_child_restores_the_imported_estimate(
        self, owner_client: APIClient, project: Project
    ) -> None:
        """#3010 found ``perform_ungroup`` destroying the parked values on the way
        back. A bulk-written container must not repeat it: park is only half a
        mechanism if the restore does not fire."""
        import_project(str(project.pk), _two_phase_file())
        phase = Task.objects.get(project=project, name="Mobilization")
        assert phase.own_estimate == 4

        for name in ("Permits", "Survey"):
            child = Task.objects.get(project=project, name=name)
            response = owner_client.delete(f"/api/v1/tasks/{child.id}/")
            assert response.status_code in (200, 204), response.content

        phase.refresh_from_db()
        assert phase.structure_role == StructureRole.WORK
        assert phase.auto_container is False
        assert phase.duration == 4, "the file's own estimate is handed back, not dropped"
        assert phase.own_estimate is None
        assert phase.own_status is None


# ── A batch that promotes a row it does not carry ────────────────────────────────


class TestABatchCanPromoteAPreExistingRow:
    def test_a_template_applied_under_an_existing_row_declares_it(
        self, project: Project, user: Any
    ) -> None:
        """The ancestor the batch parents is not always in the batch.

        Declaring in memory covers only the rows the writer holds; a row already in
        the table that just gained its first child has to be resynced after the
        INSERT, through the same #3010 helper the restructure endpoints use.
        """
        existing = Task.objects.create(
            project=project, name="Enabling works", duration=9, wbs_path="1"
        )
        assert existing.structure_role == StructureRole.WORK

        rows = [
            Task(project=project, name="Site clearance", duration=2, wbs_path="1.1", short_id="A1"),
            Task(project=project, name="Fencing", duration=1, wbs_path="1.2", short_id="A2"),
        ]
        bulk_create_tasks(rows)

        existing.refresh_from_db()
        assert existing.structure_role == StructureRole.CONTAINER
        assert existing.auto_container is True
        assert existing.own_estimate == 9
        assert undeclared_containers(project) == []

    def test_a_custom_insert_callable_still_declares(self, project: Project) -> None:
        """The seed importer inserts through ``bulk_create_with_history``. The
        declaration must not be coupled to which INSERT shape ran."""
        seen: list[int] = []

        def insert(batch: Any) -> None:
            batch = list(batch)
            seen.append(len(batch))
            Task.objects.bulk_create(batch)

        rows = [
            Task(project=project, name="Commissioning", duration=5, wbs_path="1", short_id="B1"),
            Task(project=project, name="Wet testing", duration=2, wbs_path="1.1", short_id="B2"),
        ]
        bulk_create_tasks(rows, insert=insert)

        assert seen == [2], "the caller's own INSERT ran, exactly once"
        assert Task.objects.get(project=project, name="Commissioning").structure_role == (
            StructureRole.CONTAINER
        )


# ── The sweep itself ─────────────────────────────────────────────────────────────


class TestWbsAncestorSweep:
    def test_a_path_is_not_its_own_ancestor(self) -> None:
        assert wbs_ancestor_paths(["1"]) == set()

    def test_strict_prefixes_only(self) -> None:
        assert wbs_ancestor_paths(["1.2.3", "4"]) == {"1", "1.2"}

    def test_declaration_reports_ancestors_outside_the_batch(self, project: Project) -> None:
        rows = [Task(project=project, name="Leaf", duration=1, wbs_path="1.1")]
        outside = declare_containers_in_batch(rows)
        assert outside == {"1"}
        assert rows[0].structure_role == StructureRole.WORK

    def test_subtasks_are_never_containers(self, project: Project) -> None:
        """A subtask is a checklist item, never structural — it neither has nor is a
        structural parent, so it must not be swept into the ancestor set."""
        rows = [
            Task(project=project, name="Parent", duration=1, wbs_path="1", is_subtask=True),
            Task(project=project, name="Child", duration=1, wbs_path="1.1", is_subtask=True),
        ]
        declare_containers_in_batch(rows)
        assert all(r.structure_role == StructureRole.WORK for r in rows)


# ── The guard: no fourth bulk writer goes around the funnel ───────────────────────

#: Root of the API source tree, scanned in full below.
#:
#: Derived from **this file's own path**, not from ``trueppm_api.__file__``. Under the
#: project's parallel-worktree workflow the venv is symlinked back to the main checkout
#: and the editable install resolves ``trueppm_api`` from *there* — so a package-derived
#: root would have this guard read main's sources and never see the writer the branch
#: just added, on a green local run. ``MIN_MODULES_SCANNED`` cannot catch that: main has
#: the same module count. The two are asserted equal below only when they resolve to the
#: same tree, which is the CI case.
API_SRC = Path(__file__).resolve().parents[3] / "src" / "trueppm_api"

#: The one module allowed to call ``Task.objects.bulk_create`` — it *is* the funnel.
FUNNEL_MODULE = "apps/projects/models.py"

#: Modules that insert ``Task`` rows through a *generic* dispatcher, so the direct-call
#: scan below cannot see them (``model.objects.bulk_create`` /
#: ``bulk_create_with_history``). Each must still route through the funnel, and each
#: entry is verified to still describe a real bulk insert — a registry that has drifted
#: onto a moved or renamed function must fail, not quietly match nothing.
GENERIC_TASK_INSERT_MODULES = {"apps/projects/seed/importer.py"}

#: Fails the scan if the tree it walks has collapsed (a bad root, a moved package).
#: The API source tree has been well over this for the whole life of the project.
MIN_MODULES_SCANNED = 200


def _task_aliases(tree: ast.AST) -> set[str]:
    """Local names that refer to the ``Task`` model in this module.

    ``from ...models import Task as T`` is a one-token way around a matcher keyed on
    the literal name, so the aliases are resolved rather than assumed away.
    """
    names = {"Task"}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name == "Task" and alias.asname:
                    names.add(alias.asname)
    return names


def _direct_task_bulk_creates(tree: ast.AST) -> list[int]:
    """Line numbers of every direct bulk INSERT of ``Task`` rows in ``tree``.

    Three spellings, because each is a way around a matcher that only knew the first:
    ``Task.objects.bulk_create(...)``, ``Task._default_manager.bulk_create(...)``, and
    ``bulk_create_with_history(rows, Task, ...)``.

    Matched structurally rather than by text, so a comment or docstring naming the call
    — this file and three of the fixed call sites do exactly that — is not a hit.
    """
    aliases = _task_aliases(tree)
    hits: list[int] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Name) and func.id == "bulk_create_with_history":
            model_arg = node.args[1] if len(node.args) > 1 else None
            if isinstance(model_arg, ast.Name) and model_arg.id in aliases:
                hits.append(node.lineno)
            continue
        if not isinstance(func, ast.Attribute) or func.attr != "bulk_create":
            continue
        manager = func.value
        if not isinstance(manager, ast.Attribute) or manager.attr not in {
            "objects",
            "_default_manager",
        }:
            continue
        model = manager.value
        if isinstance(model, ast.Name) and model.id in aliases:
            hits.append(node.lineno)
    return sorted(hits)


def _any_bulk_insert(tree: ast.AST) -> bool:
    """Does this module perform a bulk INSERT of any shape?"""
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr in {
            "bulk_create",
            "bulk_create_with_history",
        }:
            return True
        if isinstance(func, ast.Name) and func.id in {"bulk_create", "bulk_create_with_history"}:
            return True
    return False


def _scan() -> dict[str, tuple[ast.AST, str]]:
    modules: dict[str, tuple[ast.AST, str]] = {}
    for path in sorted(API_SRC.rglob("*.py")):
        source = path.read_text(encoding="utf-8")
        modules[path.relative_to(API_SRC).as_posix()] = (ast.parse(source), source)
    return modules


class TestNoBulkWriterGoesAroundTheFunnel:
    """The guard. A fourth bulk writer must trip this, not ship quietly."""

    def test_the_scan_is_not_vacuous(self) -> None:
        """A guard whose enumeration matches nothing passes forever.

        Three ways this one can silently stop looking, each asserted: the walk finds
        no files, the detector matches no call it should, and the registry names a
        module that no longer bulk-inserts anything.
        """
        modules = _scan()
        assert API_SRC.is_dir(), f"{API_SRC} is not a directory — the scan root is wrong"
        assert len(modules) >= MIN_MODULES_SCANNED, (
            f"only {len(modules)} modules under {API_SRC} — the scan root is wrong"
        )
        assert FUNNEL_MODULE in modules, "the funnel itself was not scanned"
        # The tree this guard reads must be the tree the tests import, or a worktree
        # running against the main checkout's editable install would scan the wrong
        # sources and pass on a branch that reintroduced the defect.
        imported_from = Path(trueppm_api.__file__).resolve().parent
        assert imported_from == API_SRC, (
            f"the guard scans {API_SRC} but the suite imports "
            f"{imported_from} — set PYTHONPATH to this "
            "checkout's packages/api/src before trusting any result here"
        )
        assert _direct_task_bulk_creates(modules[FUNNEL_MODULE][0]), (
            "the detector found no Task.objects.bulk_create even in the funnel — "
            "it has stopped matching and every assertion below is vacuous"
        )
        for rel in GENERIC_TASK_INSERT_MODULES:
            assert rel in modules, f"{rel} no longer exists — fix the registry"
            assert _any_bulk_insert(modules[rel][0]), (
                f"{rel} no longer bulk-inserts anything — the registry has drifted"
            )

    def test_the_detector_matches_a_synthetic_writer(self) -> None:
        """Prove the matcher on a source it has never seen, including the near-misses.

        Without this, a detector narrowed to something that only the funnel happens to
        satisfy would still pass every assertion above.
        """
        for writer in (
            "def go(rows):\n    Task.objects.bulk_create(rows, batch_size=10)\n",
            "def go(rows):\n    Task._default_manager.bulk_create(rows)\n",
            "from x.models import Task as T\n\n\ndef go(rows):\n    T.objects.bulk_create(rows)\n",
            "def go(rows):\n    bulk_create_with_history(rows, Task, batch_size=10)\n",
        ):
            assert _direct_task_bulk_creates(ast.parse(writer)), writer

        for near_miss in (
            "def go(rows):\n    BaselineTask.objects.bulk_create(rows)\n",
            "def go(rows):\n    bulk_create_tasks(rows)\n",
            "def go(rows):\n    bulk_create_with_history(rows, Sprint)\n",
            "def go(rows):\n    # Task.objects.bulk_create(rows)\n    pass\n",
            'def go(rows):\n    """Task.objects.bulk_create is banned."""\n',
        ):
            assert _direct_task_bulk_creates(ast.parse(near_miss)) == [], near_miss

    def test_no_module_outside_the_funnel_calls_task_bulk_create(self) -> None:
        offenders = [
            f"{rel}:{line}"
            for rel, (tree, _src) in _scan().items()
            if rel != FUNNEL_MODULE
            for line in _direct_task_bulk_creates(tree)
        ]
        assert offenders == [], (
            "these call Task.objects.bulk_create directly, so the rows they write land "
            "with structure_role='work' and children (#3030). Use "
            "trueppm_api.apps.projects.models.bulk_create_tasks instead: " + ", ".join(offenders)
        )

    def test_every_generic_task_inserter_routes_through_the_funnel(self) -> None:
        modules = _scan()
        for rel in GENERIC_TASK_INSERT_MODULES:
            _tree, source = modules[rel]
            assert "bulk_create_tasks" in source, (
                f"{rel} inserts Task rows through a generic dispatcher and never "
                "reaches bulk_create_tasks — its containers land undeclared (#3030)"
            )


# ── The behavioral guard: the invariant, not the API (#3036) ────────────────────


class TestNoCreateSurfaceLeavesAParentUndeclared:
    """Assert the OUTCOME across the create surfaces, not which function they called.

    ``TestNoBulkWriterGoesAroundTheFunnel`` above is a source scan for
    ``Task.objects.bulk_create``, and it works — but ``bulk_create`` is a **proxy** for
    the real invariant, and the proxy has a blind spot the width of a whole endpoint.
    ``POST /projects/{pk}/tasks/bulk/`` writes rows through a per-row
    ``TaskSerializer.save()``: it calls neither ``bulk_create`` (so the scan never looks
    at it) nor the viewset's ``perform_create`` (which declares inline). It therefore
    left every parent it gave a first child as ``structure_role='work'`` for its entire
    life, while the guard written to prevent exactly that reported green (#3036).

    So this class asserts the thing that actually matters — **after a create lands, no
    row has structural children and ``structure_role='work'``** — once per create
    surface. A fifth surface added tomorrow is not caught by this file automatically;
    what the file gives is a named place where forgetting to add it is visible, and an
    assertion that the surfaces already listed still behave.

    Be honest about the limit: an enumerated behavioral guard covers what it enumerates.
    That is strictly more than the source scan covered, and it is not "every path".
    """

    def _undeclared_parents(self, project: Project) -> list[str]:
        """Every row in ``project`` with structural children and no declaration."""
        rows = list(Task.objects.filter(project=project, is_deleted=False, is_subtask=False))
        by_path = {str(r.wbs_path): r for r in rows if r.wbs_path}
        parents = wbs_ancestor_paths(set(by_path))
        return [
            f"{by_path[p].name} ({p})"
            for p in sorted(parents)
            if p in by_path and by_path[p].structure_role != StructureRole.CONTAINER
        ]

    def test_the_invariant_probe_is_not_vacuous(self, project: Project) -> None:
        """A probe that can never report an offender passes on a broken tree forever.

        Build the defect by hand — a parent and a child, with the parent left declared
        work — and require the probe to name it. Without this, a probe whose ancestor
        derivation silently returned an empty set would make every assertion below
        meaningless in exactly the way the sub-12px lint gate was (rule 300).
        """
        parent = Task.objects.create(project=project, name="Undeclared", duration=1, wbs_path="1")
        Task.objects.create(project=project, name="Child", duration=1, wbs_path="1.1")
        assert parent.structure_role == StructureRole.WORK
        assert self._undeclared_parents(project) == ["Undeclared (1)"]

    def test_the_bulk_endpoint_declares_a_pre_existing_parent(
        self, owner_client: APIClient, project: Project
    ) -> None:
        """The #3036 case: one create op naming a parent that is already in the table."""
        parent = Task.objects.create(project=project, name="Mobilization", duration=1, wbs_path="1")
        response = owner_client.post(
            f"/api/v1/projects/{project.pk}/tasks/bulk/",
            {
                "operations": [
                    {
                        "op": "create",
                        "data": {"name": "Survey", "duration": 2, "parent_id": str(parent.pk)},
                    }
                ]
            },
            format="json",
        )
        assert response.status_code == 207, response.data
        assert len(response.data["applied"]) == 1, response.data
        assert self._undeclared_parents(project) == []

    def test_the_bulk_endpoint_declares_a_parent_created_in_the_same_batch(
        self, owner_client: APIClient, project: Project
    ) -> None:
        """The paste-many shape: parent and child both minted in one call.

        Distinct from the case above — the parent is not in the table when the batch
        starts, so a fix that only re-read pre-existing ancestors would pass the other
        test and leave a pasted subtree's own phases undeclared.
        """
        parent_id = str(uuid.uuid4())
        response = owner_client.post(
            f"/api/v1/projects/{project.pk}/tasks/bulk/",
            {
                "operations": [
                    {"op": "create", "id": parent_id, "data": {"name": "Fitout", "duration": 1}},
                    {
                        "op": "create",
                        "data": {"name": "Cable trays", "duration": 2, "parent_id": parent_id},
                    },
                ]
            },
            format="json",
        )
        assert response.status_code == 207, response.data
        assert len(response.data["applied"]) == 2, response.data
        assert Task.objects.get(pk=parent_id).structure_role == StructureRole.CONTAINER
        assert self._undeclared_parents(project) == []

    def test_a_rolled_back_child_does_not_declare_its_parent(
        self, owner_client: APIClient, project: Project
    ) -> None:
        """Partial application must not declare a container for a row that never landed.

        The declaration is derived from ``created_ids`` precisely so that
        ``_rollback_bookkeeping`` truncating that list also un-declares the parent. A
        fix that noted the parent inside ``_apply_create`` would survive its own child's
        savepoint rollback and promote a leaf on the strength of a row that does not
        exist.
        """
        parent = Task.objects.create(project=project, name="Solo", duration=1, wbs_path="1")
        response = owner_client.post(
            f"/api/v1/projects/{project.pk}/tasks/bulk/",
            {
                "operations": [
                    # No name — rejected by the serializer, so nothing is created.
                    {"op": "create", "data": {"duration": 2, "parent_id": str(parent.pk)}}
                ]
            },
            format="json",
        )
        assert response.status_code == 207, response.data
        assert response.data["applied"] == []
        assert len(response.data["rejected"]) == 1
        parent.refresh_from_db()
        assert parent.structure_role == StructureRole.WORK
        assert parent.auto_container is False

    def test_a_subtask_never_declares_its_parent(
        self, owner_client: APIClient, project: Project
    ) -> None:
        """A checklist item is not structural — it must not promote its task (#2950)."""
        parent = Task.objects.create(project=project, name="Punch list", duration=1, wbs_path="1")
        response = owner_client.post(
            f"/api/v1/projects/{project.pk}/tasks/bulk/",
            {
                "operations": [
                    {
                        "op": "create",
                        "data": {
                            "name": "Check seals",
                            "duration": 1,
                            "parent_id": str(parent.pk),
                            "is_subtask": True,
                        },
                    }
                ]
            },
            format="json",
        )
        assert response.status_code == 207, response.data
        assert len(response.data["applied"]) == 1, response.data
        parent.refresh_from_db()
        assert parent.structure_role == StructureRole.WORK

    def test_a_declared_parent_is_in_the_batch_broadcast(
        self,
        owner_client: APIClient,
        project: Project,
        django_capture_on_commit_callbacks: Any,
    ) -> None:
        """The promotion must reach the other clients, not only the database.

        ``tasks_bulk_mutated`` carries the ids so a client refetches *those rows* rather
        than blind-refetching the board (#1009). The declared parent is not any op's
        target, so it is exactly the row a targeted refetch omits — and the omission is
        invisible to every assertion about the database, which is why it is pinned here.
        Without it a collaborator keeps seeing a card where the author sees a lane.
        """
        parent = Task.objects.create(project=project, name="Mobilization", duration=1, wbs_path="1")
        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as broadcast,
            patch("trueppm_api.apps.projects.views._enqueue_recalculate"),
            # Deferred with transaction.on_commit, so the callbacks must be captured
            # and executed or nothing is observable at all.
            django_capture_on_commit_callbacks(execute=True),
        ):
            response = owner_client.post(
                f"/api/v1/projects/{project.pk}/tasks/bulk/",
                {
                    "operations": [
                        {
                            "op": "create",
                            "data": {"name": "Survey", "duration": 2, "parent_id": str(parent.pk)},
                        }
                    ]
                },
                format="json",
            )
        assert response.status_code == 207, response.data

        mutated = [
            call.args[2]["task_ids"]
            for call in broadcast.call_args_list
            if call.args[1] == "tasks_bulk_mutated"
        ]
        assert mutated, f"no tasks_bulk_mutated broadcast: {broadcast.call_args_list}"
        assert str(parent.pk) in mutated[0], (
            "the declared parent is missing from the broadcast, so a collaborator's "
            f"targeted refetch never re-reads it: {mutated[0]}"
        )
