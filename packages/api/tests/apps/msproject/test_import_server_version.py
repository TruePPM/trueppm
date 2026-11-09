"""Rows the importer inserts with ``bulk_create`` must carry ``server_version = 1``.

``bulk_create`` never reaches ``VersionedModel.save()``, whose INSERT path is the only
place that sets it. A row left at 0 publishes a lock token no client can echo back as
``X-Base-Version``.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest

from trueppm_api.apps.msproject.dataclasses import (
    PredecessorLinkData,
    ProjectData,
    ResourceData,
    TaskData,
)
from trueppm_api.apps.msproject.importer import import_project
from trueppm_api.apps.projects.models import Dependency, Label, Project, Task
from trueppm_api.apps.resources.models import Resource

BROADCAST = "trueppm_api.apps.sync.broadcast.broadcast_board_event"
RECALC = "trueppm_api.apps.scheduling.services.enqueue_recalculate"


@pytest.mark.django_db(transaction=True)
def test_import_inserts_every_bulk_row_at_server_version_one() -> None:
    project = Project.objects.create(name="Import target", start_date=date(2026, 3, 2))
    data = ProjectData(
        name="Imported",
        tasks=[
            TaskData(uid=1, name="First", outline_number="1", outline_level=1, labels=["Urgent"]),
            TaskData(
                uid=2,
                name="Second",
                outline_number="2",
                outline_level=1,
                predecessor_links=[PredecessorLinkData(predecessor_uid=1)],
            ),
        ],
        resources=[ResourceData(uid=1, name="Imported Person")],
    )

    with patch(BROADCAST), patch(RECALC):
        import_project(str(project.pk), data)

    assert Task.objects.filter(project=project).count() == 2
    assert Label.objects.filter(project=project).exists()
    assert Dependency.objects.filter(successor__project=project).exists()
    assert Resource.objects.filter(name="Imported Person").exists()
    for model, qs in (
        (Task, Task.objects.filter(project=project)),
        (Label, Label.objects.filter(project=project)),
        (Dependency, Dependency.objects.filter(successor__project=project)),
        (Resource, Resource.objects.filter(name="Imported Person")),
    ):
        assert {r.server_version for r in qs} == {1}, model.__name__


@pytest.mark.django_db(transaction=True)
def test_reimport_recreates_a_soft_deleted_label() -> None:
    """#3437: the importer's bulk_create must not collide with a label tombstone."""
    project = Project.objects.create(name="Import target", start_date=date(2026, 3, 2))
    Label.objects.create(project=project, name="Urgent", is_deleted=True)
    data = ProjectData(
        name="Imported",
        tasks=[
            TaskData(uid=1, name="First", outline_number="1", outline_level=1, labels=["Urgent"])
        ],
    )

    with patch(BROADCAST), patch(RECALC):
        import_project(str(project.pk), data)

    assert Label.objects.filter(project=project, name="Urgent", is_deleted=False).count() == 1
