"""The one-time repair behind projects.0175: retire FF/SF links into a summary (#4437).

Tests the function the migration delegates to, never the migration module itself — a
squash deletes migration file names (CLAUDE.md migration rule 3).
"""

from __future__ import annotations

import logging
from datetime import date

import pytest

from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task
from trueppm_api.apps.projects.summary_link_repair import retire_inbound_summary_links


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="Repair", start_date=date(2026, 1, 5), calendar=cal)


def _task(project: Project, name: str, path: str) -> Task:
    return Task.objects.create(project=project, name=name, duration=2, wbs_path=path)


def _run() -> list[Dependency]:
    return retire_inbound_summary_links(Dependency, Task, Project)


@pytest.mark.django_db
def test_retires_ff_and_sf_into_a_summary_and_leaves_everything_else(
    project: Project, caplog: pytest.LogCaptureFixture
) -> None:
    summary = _task(project, "Phase", "1")
    _task(project, "Inner", "1.1")
    leaf = _task(project, "Leaf", "2")
    other = _task(project, "Other", "3")
    ff = Dependency.objects.create(predecessor=other, successor=summary, dep_type="FF")
    sf = Dependency.objects.create(predecessor=other, successor=summary, dep_type="SF")
    fs = Dependency.objects.create(predecessor=other, successor=summary, dep_type="FS")
    ss = Dependency.objects.create(predecessor=other, successor=summary, dep_type="SS")
    ff_leaf = Dependency.objects.create(predecessor=other, successor=leaf, dep_type="FF")
    # An FF *out of* a summary is legal: the rule is on the successor side only.
    ff_out = Dependency.objects.create(predecessor=summary, successor=leaf, dep_type="FF")
    before_version = Project.objects.get(pk=project.pk).last_sync_version

    with caplog.at_level(logging.WARNING, logger="trueppm_api.apps.projects.summary_link_repair"):
        retired = _run()

    assert {d.pk for d in retired} == {ff.pk, sf.pk}
    for dep, gone in ((ff, True), (sf, True), (fs, False), (ss, False), (ff_leaf, False)):
        dep.refresh_from_db()
        assert dep.is_deleted is gone, dep.dep_type
    ff_out.refresh_from_db()
    assert ff_out.is_deleted is False
    # Tombstone bookkeeping: the sync pull needs a fresh cursor and a deletion marker.
    ff.refresh_from_db()
    assert ff.deleted_at is not None
    assert ff.deleted_version == ff.server_version
    assert ff.sync_seq > before_version
    assert Project.objects.get(pk=project.pk).last_sync_version >= ff.sync_seq
    # One log line per retired link, naming the link, the summary and the project.
    lines = [r.getMessage() for r in caplog.records if "retired" in r.getMessage()]
    assert len(lines) == 2
    assert any(str(ff.pk) in line and str(summary.pk) in line for line in lines)
    assert all(str(project.pk) in line for line in lines)


@pytest.mark.django_db
def test_is_idempotent(project: Project) -> None:
    summary = _task(project, "Phase", "1")
    _task(project, "Inner", "1.1")
    other = _task(project, "Other", "2")
    Dependency.objects.create(predecessor=other, successor=summary, dep_type="FF")

    assert len(_run()) == 1
    assert _run() == []


@pytest.mark.django_db
def test_a_cross_project_link_is_judged_by_the_successors_own_project(project: Project) -> None:
    other_project = Project.objects.create(
        name="Elsewhere", start_date=date(2026, 1, 5), calendar=project.calendar
    )
    pred = _task(other_project, "Pred", "1")
    # Same wbs_path "1" in this project is a summary; in the predecessor's it is a leaf.
    summary = _task(project, "Phase", "1")
    _task(project, "Inner", "1.1")
    link = Dependency.objects.create(predecessor=pred, successor=summary, dep_type="FF")

    retired = _run()

    assert [d.pk for d in retired] == [link.pk]
    # The tombstone's cursor comes from the predecessor's project, the sync owner.
    link.refresh_from_db()
    assert link.sync_seq == Project.objects.get(pk=other_project.pk).last_sync_version


@pytest.mark.django_db
def test_a_deleted_child_does_not_make_a_summary(project: Project) -> None:
    summary = _task(project, "Phase", "1")
    child = _task(project, "Inner", "1.1")
    child.soft_delete()
    other = _task(project, "Other", "2")
    link = Dependency.objects.create(predecessor=other, successor=summary, dep_type="FF")

    assert _run() == []
    link.refresh_from_db()
    assert link.is_deleted is False


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("child_kwargs", "retired"),
    [
        ({"status": "BACKLOG"}, False),
        ({"type": "epic"}, False),
        ({"is_recurring": True}, False),
        ({"status": "NOT_STARTED"}, True),
    ],
)
def test_only_cpm_feed_children_make_a_summary(
    project: Project, child_kwargs: dict[str, object], retired: bool
) -> None:
    """A parent whose only child the engine drops is no summary; a committed child is."""
    summary = _task(project, "Phase", "1")
    Task.objects.create(
        project=project,
        name="Inner",
        duration=2,
        wbs_path="1.1",
        **child_kwargs,  # type: ignore[arg-type]
    )
    other = _task(project, "Other", "2")
    link = Dependency.objects.create(predecessor=other, successor=summary, dep_type="FF")

    assert bool(_run()) is retired
    link.refresh_from_db()
    assert link.is_deleted is retired
