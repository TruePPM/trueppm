"""Tests for ProjectMembership revocation → WS eviction signals (#813)."""

from __future__ import annotations

import contextlib
from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.timetracking.models import ActiveTimer

User = get_user_model()

_EVICT = "trueppm_api.apps.access.signals.evict_project_connection"


@pytest.fixture
def user(db: object) -> Any:
    return User.objects.create_user(username="evictee", password="pw")


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Std")
    return Project.objects.create(name="EvictProj", start_date=date(2026, 1, 1), calendar=cal)


@pytest.mark.django_db
def test_soft_delete_evicts_live_sockets(
    user: Any, project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    m = ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    with patch(_EVICT) as evict, django_capture_on_commit_callbacks(execute=True):
        m.soft_delete()
    evict.assert_called_once_with(str(project.pk), str(user.pk))


@pytest.mark.django_db
def test_demotion_below_member_evicts(
    user: Any, project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    m = ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    with patch(_EVICT) as evict, django_capture_on_commit_callbacks(execute=True):
        m.role = Role.VIEWER
        m.save()
    evict.assert_called_once_with(str(project.pk), str(user.pk))


@pytest.mark.django_db
def test_demotion_to_member_does_not_evict(
    user: Any, project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """Demoting Admin -> Member keeps the user connectable, so no eviction."""
    m = ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    with patch(_EVICT) as evict, django_capture_on_commit_callbacks(execute=True):
        m.role = Role.MEMBER
        m.save()
    evict.assert_not_called()


@pytest.mark.django_db
def test_creating_membership_does_not_evict(
    user: Any, project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    with patch(_EVICT) as evict, django_capture_on_commit_callbacks(execute=True):
        ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    evict.assert_not_called()


def _task(project: Project, name: str = "T1") -> Task:
    return Task.objects.create(project=project, name=name, duration=1)


# ---------------------------------------------------------------------------
# Running-timer discard on revocation (#4318) — the chosen semantics is discard,
# never finalize-on-revoke: see `_discard_active_timers_on_revocation`'s docstring.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_soft_delete_discards_active_timer(
    user: Any, project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    task = _task(project)
    m = ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    ActiveTimer.objects.create(user=user, task=task, started_at=timezone.now())

    with patch(_EVICT), django_capture_on_commit_callbacks(execute=True):
        m.soft_delete()

    assert not ActiveTimer.objects.filter(user=user).exists()


@pytest.mark.django_db
def test_demotion_below_member_discards_active_timer(
    user: Any, project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    task = _task(project)
    m = ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    ActiveTimer.objects.create(user=user, task=task, started_at=timezone.now())

    with patch(_EVICT), django_capture_on_commit_callbacks(execute=True):
        m.role = Role.VIEWER
        m.save()

    assert not ActiveTimer.objects.filter(user=user).exists()


@pytest.mark.django_db
def test_demotion_to_member_does_not_discard_active_timer(
    user: Any, project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """Demoting Admin -> Member keeps can_log_time true, so the timer survives."""
    task = _task(project)
    m = ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    timer = ActiveTimer.objects.create(user=user, task=task, started_at=timezone.now())

    with patch(_EVICT), django_capture_on_commit_callbacks(execute=True):
        m.role = Role.MEMBER
        m.save()

    assert ActiveTimer.objects.filter(pk=timer.pk).exists()


@pytest.mark.django_db
def test_hard_delete_discards_active_timer(
    user: Any, project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    task = _task(project)
    m = ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    ActiveTimer.objects.create(user=user, task=task, started_at=timezone.now())

    with patch(_EVICT), django_capture_on_commit_callbacks(execute=True):
        m.delete()

    assert not ActiveTimer.objects.filter(user=user).exists()


@pytest.mark.django_db
def test_discard_is_scoped_to_the_revoked_project_only(
    user: Any, project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """Revoking membership on one project must not touch a timer on another project
    the user is still a live member of — only one ActiveTimer can exist per user
    (OneToOneField), so this proves the discard filters by project, not just by user.
    """
    cal = project.calendar
    other_project = Project.objects.create(
        name="OtherProj", start_date=date(2026, 1, 1), calendar=cal
    )
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    ProjectMembership.objects.create(project=other_project, user=user, role=Role.MEMBER)
    m = ProjectMembership.objects.get(project=project, user=user)
    other_task = _task(other_project, "OtherTask")
    timer = ActiveTimer.objects.create(user=user, task=other_task, started_at=timezone.now())

    with patch(_EVICT), django_capture_on_commit_callbacks(execute=True):
        m.soft_delete()

    assert ActiveTimer.objects.filter(pk=timer.pk).exists()


def test_pre_save_receiver_skips_unsaved_instance() -> None:
    """An instance with no pk has no prior row to compare against — short-circuit.

    UUID PKs are assigned at instantiation, so ORM creates never reach this guard;
    exercise it directly with an explicitly pk-less instance to prove it returns
    before issuing the prior-row SELECT.
    """
    from trueppm_api.apps.access.signals import _evict_on_revocation

    with patch(_EVICT) as evict, patch.object(ProjectMembership.objects, "filter") as filt:
        _evict_on_revocation(ProjectMembership, ProjectMembership(id=None))
    filt.assert_not_called()
    evict.assert_not_called()


# ---------------------------------------------------------------------------
# Account deactivation is the second revocation axis (#2850)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_account_deactivation_evicts_every_project_socket(
    user: Any, project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """Workspace off-boarding never touches ProjectMembership, so the receivers above
    never fired for it — and ``is_active`` is read only at connect, so an already-open
    socket was never re-checked. The member's REST access died immediately (the JWT
    authenticator honors ``is_active``) while their board socket kept streaming.
    """
    cal = project.calendar
    second = Project.objects.create(name="Second", start_date=date(2026, 1, 1), calendar=cal)
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    ProjectMembership.objects.create(project=second, user=user, role=Role.MEMBER)

    with patch(_EVICT) as evict, django_capture_on_commit_callbacks(execute=True):
        user.is_active = False
        user.save(update_fields=["is_active"])

    evicted = {call.args[0] for call in evict.call_args_list}
    assert evicted == {str(project.pk), str(second.pk)}
    assert all(call.args[1] == str(user.pk) for call in evict.call_args_list)


@pytest.mark.django_db
def test_reactivation_does_not_evict(
    user: Any, project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """Restoring access grants nothing that needs evicting."""
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    user.is_active = False
    user.save(update_fields=["is_active"])

    with patch(_EVICT) as evict, django_capture_on_commit_callbacks(execute=True):
        user.is_active = True
        user.save(update_fields=["is_active"])
    evict.assert_not_called()


@pytest.mark.django_db
def test_an_unrelated_save_on_an_inactive_account_does_not_evict(
    user: Any, project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """Only the True -> False transition evicts.

    Without the prior-value check, every profile edit on an already-deactivated
    account would push one evict message per project, forever.
    """
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    user.is_active = False
    user.save(update_fields=["is_active"])

    with patch(_EVICT) as evict, django_capture_on_commit_callbacks(execute=True):
        user.first_name = "Renamed"
        user.save(update_fields=["first_name"])
    evict.assert_not_called()


@pytest.mark.django_db
def test_a_rolled_back_deactivation_evicts_nobody(user: Any, project: Project) -> None:
    """The evict is deferred to commit, so a failed deactivation drops no socket."""
    from django.db import transaction

    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)

    with patch(_EVICT) as evict, contextlib.suppress(RuntimeError), transaction.atomic():
        user.is_active = False
        user.save(update_fields=["is_active"])
        raise RuntimeError("boom")
    evict.assert_not_called()


@pytest.mark.django_db
def test_a_soft_deleted_membership_is_not_re_evicted_on_deactivation(
    user: Any, project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """A membership already revoked evicted at revocation time; don't send it twice."""
    m = ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    m.soft_delete()

    with patch(_EVICT) as evict, django_capture_on_commit_callbacks(execute=True):
        user.is_active = False
        user.save(update_fields=["is_active"])
    evict.assert_not_called()
