"""Tests for the soft-deleted project retention purge (_do_project_purge).

Covers (#1114, ADR-0173):
  - Projects soft-deleted longer than the window are hard-deleted
  - Recently soft-deleted projects are preserved (age boundary)
  - Live (never soft-deleted) projects are never touched
  - A NULL deleted_at (legacy row, pre-column) is never auto-purged — the safety
    default that keeps age-unknown projects out of the hard-delete path
  - dry_run counts eligible rows without deleting
  - The hard-delete CASCADES to child rows (tasks) and first removes the
    PROTECT-constrained ProjectMembership rows (the ?force=true parity)
  - Idempotency: a second run is a no-op
  - A custom / disabled (None) window is respected; override_value forces a window
  - purge_soft_deleted_projects has the expected idempotent_task configuration
  - The purge is registered in the ADR-0173 purge registry
"""

from __future__ import annotations

from datetime import date, timedelta
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

User = get_user_model()


def _make_project(
    *,
    name: str = "Trashed",
    soft_deleted: bool = True,
    age_days: float | None = 40,
    null_deleted_at: bool = False,
) -> object:
    """Create a project and drive it into the desired soft-delete state.

    ``age_days`` back-dates ``deleted_at`` so the retention window can be exercised
    without a time-travel library. ``null_deleted_at`` simulates a legacy row
    soft-deleted before the ``deleted_at`` column existed.
    """
    from trueppm_api.apps.projects.models import Project

    project = Project.objects.create(name=name, start_date=date(2026, 1, 1))
    if not soft_deleted:
        return project
    project.soft_delete()
    if null_deleted_at:
        Project.objects.filter(pk=project.pk).update(deleted_at=None)
    elif age_days is not None:
        Project.objects.filter(pk=project.pk).update(
            deleted_at=timezone.now() - timedelta(days=age_days)
        )
    return project


def _purge(*, dry_run: bool = False, override_value: int | None = None) -> int:
    from trueppm_api.apps.projects.tasks import _do_project_purge

    return _do_project_purge(dry_run=dry_run, override_value=override_value)


@pytest.mark.django_db
class TestProjectPurge:
    def test_soft_delete_stamps_deleted_at(self) -> None:
        # The purge measures age off deleted_at, so soft_delete must set it.
        project = _make_project(soft_deleted=False)
        assert project.deleted_at is None
        project.soft_delete()
        assert project.is_deleted is True
        assert project.deleted_at is not None

    def test_deletes_old_soft_deleted_project(self) -> None:
        from trueppm_api.apps.projects.models import Project

        p = _make_project(age_days=40)
        deleted = _purge()
        assert deleted == 1
        assert not Project.objects.filter(pk=p.pk).exists()

    def test_preserves_recent_soft_deleted_project(self) -> None:
        from trueppm_api.apps.projects.models import Project

        # 5 days < the default 30-day window.
        p = _make_project(age_days=5)
        assert _purge() == 0
        assert Project.objects.filter(pk=p.pk).exists()

    def test_boundary_just_inside_window_is_kept(self) -> None:
        from trueppm_api.apps.projects.models import Project

        # 29 days old under a 30-day window: cutoff is now-30d, deleted_at is
        # now-29d which is > cutoff, so the row is NOT yet eligible.
        p = _make_project(age_days=29)
        assert _purge() == 0
        assert Project.objects.filter(pk=p.pk).exists()

    def test_preserves_live_project_regardless_of_age(self) -> None:
        from trueppm_api.apps.projects.models import Project

        # A live (never soft-deleted) project has is_deleted=False and must never
        # be a purge candidate, even though it is old.
        p = _make_project(soft_deleted=False)
        Project.objects.filter(pk=p.pk).update(deleted_at=timezone.now() - timedelta(days=999))
        assert _purge() == 0
        assert Project.objects.filter(pk=p.pk).exists()

    def test_null_deleted_at_never_purged(self) -> None:
        from trueppm_api.apps.projects.models import Project

        # Legacy safety: is_deleted=True but deleted_at IS NULL (soft-deleted before
        # the column existed). Age is unknown, so it must be retained, not guessed.
        p = _make_project(null_deleted_at=True)
        assert Project.objects.filter(pk=p.pk, is_deleted=True, deleted_at__isnull=True).exists()
        assert _purge() == 0
        assert Project.objects.filter(pk=p.pk).exists()

    def test_dry_run_counts_without_deleting(self) -> None:
        from trueppm_api.apps.projects.models import Project

        _make_project(name="a", age_days=40)
        _make_project(name="b", age_days=40)
        _make_project(name="recent", age_days=1)
        assert _purge(dry_run=True) == 2
        # Nothing deleted — dry_run is a pure count.
        assert Project.objects.count() == 3

    def test_cascade_removes_child_tasks(self) -> None:
        from trueppm_api.apps.projects.models import Project, Task

        p = _make_project(age_days=40)
        child = Task.objects.create(project=p, name="T1", duration=5)
        assert _purge() == 1
        assert not Project.objects.filter(pk=p.pk).exists()
        # DB-level CASCADE removed the child row with the parent.
        assert not Task.objects.filter(pk=child.pk).exists()

    def test_removes_protected_membership_rows(self) -> None:
        from trueppm_api.apps.access.models import ProjectMembership, Role
        from trueppm_api.apps.projects.models import Project

        # ProjectMembership.project is on_delete=PROTECT — a bare Project.delete()
        # would raise. The purge deletes memberships first (the ?force=true parity),
        # so the project row still goes.
        p = _make_project(age_days=40)
        user = User.objects.create_user(username="member", password="pw")
        m = ProjectMembership.objects.create(project=p, user=user, role=Role.OWNER)
        assert _purge() == 1
        assert not Project.objects.filter(pk=p.pk).exists()
        assert not ProjectMembership.objects.filter(pk=m.pk).exists()

    def test_idempotent_second_run_is_noop(self) -> None:
        from trueppm_api.apps.projects.models import Project

        _make_project(age_days=40)
        assert _purge() == 1
        # Re-running finds nothing left to purge.
        assert _purge() == 0
        assert Project.objects.count() == 0

    def test_respects_custom_retention_window(self) -> None:
        from trueppm_api.apps.projects.models import Project

        # 20 days old: kept under the default 30-day window, purged under 14 days.
        p = _make_project(age_days=20)
        with patch("django.conf.settings.TRUEPPM_PROJECT_SOFT_DELETE_RETENTION_DAYS", 14):
            assert _purge() == 1
        assert not Project.objects.filter(pk=p.pk).exists()

    def test_disabled_when_retention_none(self) -> None:
        from trueppm_api.apps.projects.models import Project

        p = _make_project(age_days=999)
        with patch("django.conf.settings.TRUEPPM_PROJECT_SOFT_DELETE_RETENTION_DAYS", None):
            assert _purge() == 0
        assert Project.objects.filter(pk=p.pk).exists()

    def test_override_value_forces_window(self) -> None:
        from trueppm_api.apps.projects.models import Project

        # 20 days old, default window 30 → not eligible; override_value=10 forces a
        # tighter hypothetical window (the System Health impact estimate path).
        _make_project(age_days=20)
        assert _purge(dry_run=True, override_value=10) == 1
        # override_value=60 widens it back out below the age.
        assert _purge(dry_run=True, override_value=60) == 0
        assert Project.objects.count() == 1

    def test_task_idempotent_config(self) -> None:
        from trueppm_api.apps.projects.tasks import purge_soft_deleted_projects

        assert purge_soft_deleted_projects.name == "projects.purge_soft_deleted_projects"
        assert getattr(purge_soft_deleted_projects, "reject_on_worker_lost", False) is True

    def test_registered_in_purge_registry(self) -> None:
        from trueppm_api.apps.observability.purge_registry import get_purge_specs
        from trueppm_api.apps.projects.models import Project
        from trueppm_api.apps.projects.tasks import _do_project_purge

        spec = next(
            s for s in get_purge_specs() if s.key == "TRUEPPM_PROJECT_SOFT_DELETE_RETENTION_DAYS"
        )
        assert spec.purge is _do_project_purge
        assert spec.db_tables == (Project._meta.db_table,)
