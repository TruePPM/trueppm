"""Task seed provenance — source_kind/seeded_at/edited_at (ADR-0786, #2730).

The load-bearing assertions here are the ones about *direction of failure*. The
predicate these fields feed decides what B4's sweep deletes, so the tests that
matter most are:

* a human write always leaves a mark (``test_bulk_view_update_leaves_the_untouched_set``
  and friends) — if one did not, the sweep would delete work someone typed;
* a CPM recompute never does (``test_cpm_bulk_update_does_not_mark_seeded_rows_edited``)
  — if it did, the offer would be empty seconds after seeding and the feature
  would be dead on arrival;
* the fields are not client-writable (``test_provenance_fields_are_read_only``) —
  a caller that could clear ``edited_at`` could make the sweep delete its own edits.
"""

from __future__ import annotations

import itertools
from datetime import date, timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Task,
    TaskSource,
    TaskStatus,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> Any:
    return User.objects.create_user(username="pm", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def membership(project: Project, user: Any) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)


@pytest.fixture
def client(user: Any, membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


#: Monotonic short_id source for the helper below. bulk_create bypasses the
#: allocator Task.save() would use, so the test has to mint its own — and they must
#: stay unique across every call in a test, not just within one call.
_short_id_seq = itertools.count(1)


def _seed_rows(project: Project, count: int, *, when: Any = None) -> list[Task]:
    """Create ``count`` rows the way an importer does — bulk_create, never save().

    Deliberately mirrors the real seeding path: bulk_create bypasses
    ``Task.save()``, which is exactly why ``edited_at`` stays null and these rows
    are sweepable.
    """
    seeded_at = when or timezone.now()
    rows = [
        Task(
            project=project,
            name=f"Seeded {i}",
            duration=1,
            short_id=f"S{next(_short_id_seq):05X}",
            server_version=1,
            source_kind=TaskSource.TEMPLATE,
            seeded_at=seeded_at,
        )
        for i in range(count)
    ]
    Task.objects.bulk_create(rows)
    return rows


# ---------------------------------------------------------------------------
# Defaults — an ordinary task is hand-authored and never sweepable
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_hand_authored_task_defaults_to_hand_and_never_seeded(project: Project) -> None:
    task = Task.objects.create(project=project, name="Typed", duration=1)

    assert task.source_kind == TaskSource.HAND
    assert task.source_id is None
    assert task.source_version == ""
    assert task.seeded_at is None
    # save() ran, so the row is marked as human-touched.
    assert task.edited_at is not None
    # ...but seeded_at is what keeps it out of the set, whatever edited_at says.
    assert task not in Task.objects.untouched_seeded(project)


@pytest.mark.django_db
def test_untouched_seeded_returns_only_unedited_seeded_rows(project: Project) -> None:
    seeded = _seed_rows(project, 3)
    Task.objects.create(project=project, name="Typed", duration=1)

    assert set(Task.objects.untouched_seeded(project)) == set(seeded)


# ---------------------------------------------------------------------------
# The predicate — window, soft-delete, and the edited transition
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_a_human_edit_removes_a_row_from_the_set_permanently(project: Project) -> None:
    row = _seed_rows(project, 1)[0]
    assert row in Task.objects.untouched_seeded(project)

    row.refresh_from_db()
    row.name = "Renamed by a person"
    row.save()

    row.refresh_from_db()
    assert row.edited_at is not None
    assert row.seeded_at is not None  # provenance survives the edit
    assert row not in Task.objects.untouched_seeded(project)


@pytest.mark.django_db
def test_rows_seeded_before_the_window_are_excluded(project: Project) -> None:
    fresh = _seed_rows(project, 1)[0]
    stale = _seed_rows(project, 1, when=timezone.now() - timedelta(days=8))[0]

    inside = set(Task.objects.untouched_seeded(project))
    assert fresh in inside
    assert stale not in inside

    # ...but the retention measurement, which passes its own window, sees both.
    assert stale in set(Task.objects.untouched_seeded(project, within=timedelta(days=14)))
    assert stale in set(Task.objects.untouched_seeded(project, within=None))


@pytest.mark.django_db
def test_soft_deleted_rows_leave_the_set_without_being_marked_edited(project: Project) -> None:
    """Deleting is not editing — otherwise B4's undo could not restore the offer."""
    row = _seed_rows(project, 1)[0]
    row.refresh_from_db()
    row.soft_delete()

    row.refresh_from_db()
    assert row.is_deleted is True
    assert row.edited_at is None, "soft_delete must not count as a human edit"
    assert row not in Task.objects.untouched_seeded(project)

    row.restore()
    row.refresh_from_db()
    assert row.edited_at is None, "restore must not count as a human edit either"
    assert row in Task.objects.untouched_seeded(project)


@pytest.mark.django_db
def test_untouched_seeded_is_scoped_to_its_project(calendar: Calendar, project: Project) -> None:
    other = Project.objects.create(name="Other", start_date=date(2026, 4, 1), calendar=calendar)
    mine = _seed_rows(project, 2)
    _seed_rows(other, 3)

    assert set(Task.objects.untouched_seeded(project)) == set(mine)


# ---------------------------------------------------------------------------
# Direction of failure — the two assertions the feature's safety rests on
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_cpm_bulk_update_does_not_mark_seeded_rows_edited(project: Project) -> None:
    """A recompute must never consume the sweep window.

    CPM persists via ``bulk_update``, which bypasses ``Task.save()`` by design
    (ADR-0091). If that ever changed, every seeded row would read as edited within
    seconds of being written and "Delete untouched rows (N)" would always show 0 —
    a silent, total failure of the feature with no error anywhere. This test is the
    tripwire for that change.
    """
    rows = _seed_rows(project, 3)
    for row in rows:
        row.early_start = date(2026, 5, 1)
        row.early_finish = date(2026, 5, 2)
        row.is_critical = True
    Task.objects.bulk_update(rows, ["early_start", "early_finish", "is_critical"])

    assert Task.objects.untouched_seeded(project).count() == 3
    assert all(t.edited_at is None for t in Task.objects.filter(project=project))


@pytest.mark.django_db
def test_a_partial_save_still_stamps_edited_at(project: Project) -> None:
    """``update_fields`` must be widened, or the stamp is computed and discarded.

    A caller passing ``update_fields=("status",)`` has no way to know save() also
    stamps ``edited_at``; without the ``_also_write`` widening the UPDATE would omit
    the column and the row would still look untouched after a real human edit —
    the failure that deletes someone's work.
    """
    row = _seed_rows(project, 1)[0]
    row.refresh_from_db()
    row.status = TaskStatus.IN_PROGRESS
    row.save(update_fields=["status"])

    row.refresh_from_db()
    assert row.edited_at is not None
    assert row not in Task.objects.untouched_seeded(project)


@pytest.mark.django_db
def test_system_write_opt_out_leaves_the_row_untouched(project: Project) -> None:
    row = _seed_rows(project, 1)[0]
    row.refresh_from_db()
    row.percent_complete = 10.0
    row.save(system_write=True)

    row.refresh_from_db()
    assert row.edited_at is None
    assert row in Task.objects.untouched_seeded(project)


# ---------------------------------------------------------------------------
# API surface — read-only, and reachable
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_provenance_fields_are_read_only(client: APIClient, project: Project) -> None:
    """A client must not be able to assert its own provenance.

    Clearing ``edited_at`` would make the sweep eligible to delete a row the caller
    had edited; setting it would let a caller pin a row it never touched.
    """
    row = _seed_rows(project, 1)[0]
    original_seeded_at = row.seeded_at

    resp = client.patch(
        f"/api/v1/tasks/{row.pk}/",
        {
            "name": "Renamed",
            "edited_at": None,
            "seeded_at": None,
            "source_kind": TaskSource.HAND,
            "source_id": None,
        },
        format="json",
    )
    assert resp.status_code == 200

    row.refresh_from_db()
    assert row.source_kind == TaskSource.TEMPLATE, "client must not rewrite source_kind"
    assert row.seeded_at == original_seeded_at, "client must not clear seeded_at"
    # The name change is a real human edit, so edited_at is stamped despite the
    # client's attempt to null it — the server's stamp wins, not the payload.
    assert row.edited_at is not None
    assert row not in Task.objects.untouched_seeded(project)


# ---------------------------------------------------------------------------
# The importers stamp themselves, and stamp themselves *distinctly*
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_msproject_import_stamps_its_own_source_kind(project: Project) -> None:
    from trueppm_api.apps.msproject.dataclasses import ProjectData, TaskData
    from trueppm_api.apps.msproject.importer import import_project

    data = ProjectData(
        name="Plan",
        tasks=[TaskData(uid=1, name="Design", outline_number="1", outline_level=0)],
    )
    import_project(str(project.pk), data)

    row = Task.objects.get(project=project, name="Design")
    assert row.source_kind == TaskSource.MSPROJECT_IMPORT
    assert row.seeded_at is not None
    assert row.edited_at is None
    assert row in Task.objects.untouched_seeded(project)


@pytest.mark.django_db
def test_csv_and_jira_are_distinguishable_from_msproject(project: Project) -> None:
    """The three importers share one code path, so the label must be passed, not defaulted.

    Without the explicit ``source_kind`` at each call site, spreadsheet and Jira rows
    would be attributed to an MS Project file that never existed — wrong in the
    divergence digest and wrong in anything that later explains where a row came from.
    """
    from trueppm_api.apps.msproject.dataclasses import ProjectData, TaskData
    from trueppm_api.apps.msproject.importer import import_project

    data = ProjectData(
        name="Sheet",
        tasks=[TaskData(uid=1, name="From CSV", outline_number="1", outline_level=0)],
    )
    import_project(str(project.pk), data, source_kind=TaskSource.CSV_IMPORT)

    row = Task.objects.get(project=project, name="From CSV")
    assert row.source_kind == TaskSource.CSV_IMPORT


@pytest.mark.django_db
def test_task_payload_publishes_the_untouched_verdict(client: APIClient, project: Project) -> None:
    """``is_untouched_seed`` is published positively, because a null does not survive MCP.

    The MCP server drops keys whose value is None, so a client reading provenance
    through it would never see ``edited_at`` on precisely the rows the field is
    about (ADR-0786 §5a). The boolean is what survives that compaction.
    """
    seeded = _seed_rows(project, 1)[0]
    typed = Task.objects.create(project=project, name="Typed", duration=1)

    resp = client.get(f"/api/v1/tasks/{seeded.pk}/")
    assert resp.status_code == 200
    assert resp.data["is_untouched_seed"] is True
    assert resp.data["source_kind"] == TaskSource.TEMPLATE
    assert resp.data["seeded_at"] is not None
    assert resp.data["edited_at"] is None

    resp = client.get(f"/api/v1/tasks/{typed.pk}/")
    assert resp.status_code == 200
    assert resp.data["is_untouched_seed"] is False
    assert resp.data["source_kind"] == TaskSource.HAND
