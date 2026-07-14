"""Sprint-membership-change notifications (ADR-0412, #1946).

Verifies that a committed change to a task's sprint FK that ENTERS or LEAVES an
ACTIVE sprint fans out a ``sprint.membership_changed`` in-app notification to the
project lead cohort (role >= ADMIN, minus the actor) — the "PM/admin silently
added a task to the active sprint" audit gap (Jordan's PO / Alex's SM hard-NOs in
the 2026-07-14 activity-streams VoC audit). Covers the firing rules (active-only,
no-op guard), recipient resolution, per-user opt-out, and DND, plus the end-to-end
PATCH wiring at ``TaskViewSet.perform_update``.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.notifications.models import (
    Notification,
    NotificationChannel,
    NotificationEventType,
    NotificationPreference,
    UserNotificationSettings,
)
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Sprint,
    SprintState,
    Task,
    TaskStatus,
)
from trueppm_api.apps.projects.services import notify_sprint_membership_change

User = get_user_model()
pytestmark = pytest.mark.django_db


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


@pytest.fixture
def project(db: object) -> Project:
    calendar = Calendar.objects.create(name="Std")
    return Project.objects.create(name="Proj", start_date=date(2026, 1, 1), calendar=calendar)


def _member(project: Project, username: str, role: int) -> Any:
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    return user


@pytest.fixture
def actor(project: Project) -> Any:
    """The lead making the change — excluded from recipients."""
    return _member(project, "actor", Role.ADMIN)


@pytest.fixture
def lead(project: Project) -> Any:
    """A second lead — the recipient."""
    return _member(project, "lead", Role.ADMIN)


@pytest.fixture
def member(project: Project) -> Any:
    """A non-lead contributor — never a recipient."""
    return _member(project, "member", Role.MEMBER)


def _sprint(project: Project, name: str, state: str) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name=name,
        start_date=date(2026, 2, 1),
        finish_date=date(2026, 2, 14),
        state=state,
    )


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _fire(
    task: Task,
    old_id: Any,
    new_id: Any,
    actor: Any,
    callbacks: Callable[..., Any],
) -> None:
    with callbacks(execute=True):
        notify_sprint_membership_change(task, old_id, new_id, actor)


# --------------------------------------------------------------------------- #
# Firing rules
# --------------------------------------------------------------------------- #


def test_enter_active_sprint_notifies_leads_minus_actor(
    project: Project,
    actor: Any,
    lead: Any,
    member: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    active = _sprint(project, "S-active", SprintState.ACTIVE)
    task = Task.objects.create(project=project, name="Login form", duration=5, sprint=active)

    _fire(task, None, active.pk, actor, django_capture_on_commit_callbacks)

    notes = Notification.objects.filter(event_type=NotificationEventType.SPRINT_MEMBERSHIP_CHANGED)
    recipients = {n.recipient_id for n in notes}
    # The other lead is notified; the actor and the non-lead member are not.
    assert recipients == {lead.pk}
    note = notes.first()
    assert note is not None
    assert "added" in note.body
    assert "Login form" in note.body
    assert "S-active" in note.body
    assert str(note.task_id) == str(task.pk)


def test_leave_active_sprint_notifies_with_removed_copy(
    project: Project,
    actor: Any,
    lead: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    active = _sprint(project, "S-active", SprintState.ACTIVE)
    task = Task.objects.create(project=project, name="Card", duration=5)

    _fire(task, active.pk, None, actor, django_capture_on_commit_callbacks)

    note = Notification.objects.filter(
        recipient=lead, event_type=NotificationEventType.SPRINT_MEMBERSHIP_CHANGED
    ).first()
    assert note is not None
    assert "removed" in note.body
    assert "S-active" in note.body


def test_move_active_to_active_uses_moved_copy(
    project: Project,
    actor: Any,
    lead: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    a = _sprint(project, "S-a", SprintState.ACTIVE)
    b = _sprint(project, "S-b", SprintState.ACTIVE)
    task = Task.objects.create(project=project, name="Card", duration=5, sprint=b)

    _fire(task, a.pk, b.pk, actor, django_capture_on_commit_callbacks)

    note = Notification.objects.filter(
        recipient=lead, event_type=NotificationEventType.SPRINT_MEMBERSHIP_CHANGED
    ).first()
    assert note is not None
    assert "moved" in note.body
    assert "S-a" in note.body and "S-b" in note.body


def test_no_op_change_fires_nothing(
    project: Project,
    actor: Any,
    lead: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    active = _sprint(project, "S-active", SprintState.ACTIVE)
    task = Task.objects.create(project=project, name="Card", duration=5, sprint=active)

    _fire(task, active.pk, active.pk, actor, django_capture_on_commit_callbacks)

    assert not Notification.objects.filter(
        event_type=NotificationEventType.SPRINT_MEMBERSHIP_CHANGED
    ).exists()


@pytest.mark.parametrize(
    "state", [SprintState.PLANNED, SprintState.COMPLETED, SprintState.CANCELLED]
)
def test_non_active_sprint_never_notifies(
    project: Project,
    actor: Any,
    lead: Any,
    state: str,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    sprint = _sprint(project, f"S-{state}", state)
    task = Task.objects.create(project=project, name="Card", duration=5, sprint=sprint)

    _fire(task, None, sprint.pk, actor, django_capture_on_commit_callbacks)

    assert not Notification.objects.filter(
        event_type=NotificationEventType.SPRINT_MEMBERSHIP_CHANGED
    ).exists()


def test_revoked_lead_membership_is_excluded(
    project: Project,
    actor: Any,
    lead: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """A soft-deleted membership row keeps its role but must not receive notices."""
    ProjectMembership.objects.filter(project=project, user=lead).update(is_deleted=True)
    active = _sprint(project, "S-active", SprintState.ACTIVE)
    task = Task.objects.create(project=project, name="Card", duration=5, sprint=active)

    _fire(task, None, active.pk, actor, django_capture_on_commit_callbacks)

    assert not Notification.objects.filter(recipient=lead).exists()


def test_per_user_opt_out_suppresses_row(
    project: Project,
    actor: Any,
    lead: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    NotificationPreference.objects.create(
        user=lead,
        event_type=NotificationEventType.SPRINT_MEMBERSHIP_CHANGED,
        channel=NotificationChannel.IN_APP,
        enabled=False,
    )
    active = _sprint(project, "S-active", SprintState.ACTIVE)
    task = Task.objects.create(project=project, name="Card", duration=5, sprint=active)

    _fire(task, None, active.pk, actor, django_capture_on_commit_callbacks)

    assert not Notification.objects.filter(recipient=lead).exists()


def test_dnd_holds_email_but_keeps_in_app_row(
    project: Project,
    actor: Any,
    lead: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    # Opt the lead INTO email, then enable account-wide DND: the durable in-app row
    # still lands, but email is held (this event is not in DND_BYPASS_EVENTS).
    NotificationPreference.objects.create(
        user=lead,
        event_type=NotificationEventType.SPRINT_MEMBERSHIP_CHANGED,
        channel=NotificationChannel.EMAIL,
        enabled=True,
    )
    UserNotificationSettings.objects.create(user=lead, dnd_enabled=True)
    active = _sprint(project, "S-active", SprintState.ACTIVE)
    task = Task.objects.create(project=project, name="Card", duration=5, sprint=active)

    _fire(task, None, active.pk, actor, django_capture_on_commit_callbacks)

    note = Notification.objects.filter(recipient=lead).first()
    assert note is not None  # in-app inbox row is never silenced by DND
    assert note.email_pending is False  # email held by DND


# --------------------------------------------------------------------------- #
# End-to-end: PATCH wiring at perform_update
# --------------------------------------------------------------------------- #


@pytest.mark.django_db(transaction=True)
def test_patch_task_into_active_sprint_notifies_other_lead(
    project: Project,
) -> None:
    """Golden path: PATCHing a task's sprint FK to an active sprint fires the notice."""
    actor = _member(project, "patch_actor", Role.ADMIN)
    lead = _member(project, "patch_lead", Role.ADMIN)
    active = _sprint(project, "S-active", SprintState.ACTIVE)
    task = Task.objects.create(
        project=project, name="Wire login", duration=5, status=TaskStatus.NOT_STARTED
    )

    resp = _client(actor).patch(
        f"/api/v1/tasks/{task.pk}/", data={"sprint": str(active.pk)}, format="json"
    )
    assert resp.status_code == 200, resp.data

    note = Notification.objects.filter(
        recipient=lead, event_type=NotificationEventType.SPRINT_MEMBERSHIP_CHANGED
    ).first()
    assert note is not None
    assert "Wire login" in note.body
    assert "S-active" in note.body
    # The actor who made the change is never notified.
    assert not Notification.objects.filter(
        recipient=actor, event_type=NotificationEventType.SPRINT_MEMBERSHIP_CHANGED
    ).exists()


# --------------------------------------------------------------------------- #
# Enum + category maps include the new type
# --------------------------------------------------------------------------- #


def test_new_event_type_is_categorized_as_tasks() -> None:
    from trueppm_api.apps.notifications.categories import CATEGORY_TASKS, category_for

    assert category_for(NotificationEventType.SPRINT_MEMBERSHIP_CHANGED.value) == CATEGORY_TASKS


def test_new_event_type_has_default_preferences() -> None:
    from trueppm_api.apps.notifications.models import DEFAULT_PREFERENCES

    defaults = {
        (et, ch): enabled
        for et, ch, enabled in DEFAULT_PREFERENCES
        if et == NotificationEventType.SPRINT_MEMBERSHIP_CHANGED
    }
    assert (
        defaults[(NotificationEventType.SPRINT_MEMBERSHIP_CHANGED, NotificationChannel.IN_APP)]
        is True
    )
    assert (
        defaults[(NotificationEventType.SPRINT_MEMBERSHIP_CHANGED, NotificationChannel.EMAIL)]
        is False
    )
