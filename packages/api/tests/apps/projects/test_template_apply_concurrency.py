"""#3074 — concurrent applies/creates into one project get non-overlapping WBS paths.

Both writers used to compute their root ordinal from an unlocked read, so two racing
on the same (especially empty) project computed the same number and the loser failed
on ``unique_task_wbs_path_per_project_live`` at COMMIT.
"""

from __future__ import annotations

import threading
import time
from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.db import connection, transaction

from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    ProjectTemplate,
    Task,
)
from trueppm_api.apps.projects.project_templates import STRUCTURE_VERSION, materialize_structure
from trueppm_api.apps.projects.views import _next_root_wbs_path

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def project() -> Project:
    return Project.objects.create(
        name="Race", start_date=date(2026, 1, 1), calendar=Calendar.objects.create(name="Std")
    )


def _race(work) -> list[BaseException | None]:  # type: ignore[no-untyped-def]
    """Run ``work(i)`` in two threads, the first holding its transaction open briefly."""
    errors: list[BaseException | None] = [None, None]
    started = threading.Event()

    def run(i: int) -> None:
        try:
            if i == 1:
                started.wait(5)
            with transaction.atomic():
                work(i, started)
        except BaseException as exc:
            errors[i] = exc
        finally:
            connection.close()

    threads = [threading.Thread(target=run, args=(i,)) for i in (0, 1)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    return errors


def test_two_concurrent_template_applies_to_an_empty_project_do_not_overlap(
    project: Project,
) -> None:
    owner = get_user_model().objects.create_user(username="o", password="pw")
    template = ProjectTemplate.objects.create(
        name="T",
        owner=owner,
        structure={
            "version": STRUCTURE_VERSION,
            "tasks": [
                {"ref": "a", "name": "A", "wbs_path": "1"},
                {"ref": "b", "name": "B", "wbs_path": "2"},
            ],
        },
    )

    def work(i: int, started: threading.Event) -> None:
        materialize_structure(template, project)
        if i == 0:
            started.set()
            time.sleep(0.5)  # hold the transaction open so the other apply overlaps it

    assert _race(work) == [None, None]
    paths = sorted(
        str(p) for p in Task.objects.filter(project=project).values_list("wbs_path", flat=True)
    )
    assert paths == ["1", "2", "3", "4"]


def test_two_concurrent_root_creates_into_an_empty_project_do_not_overlap(
    project: Project,
) -> None:
    got: list[str] = []

    def work(i: int, started: threading.Event) -> None:
        path = _next_root_wbs_path(project)
        got.append(path)
        if i == 0:
            started.set()
            time.sleep(0.5)
        Task.objects.create(project=project, name=f"R{i}", duration=1, wbs_path=path)

    assert _race(work) == [None, None]
    assert sorted(got) == ["1", "2"]
