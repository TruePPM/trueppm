"""Sprint-membership-change notifications (ADR-0412, #1946).

Verifies that a committed change to a task's sprint FK that ENTERS or LEAVES an
ACTIVE sprint fans out a ``sprint.membership_changed`` in-app notification to the
cohort authorized to rule on it — role >= ADMIN plus the ADR-0078 Scrum Master and
Product Owner facet holders, minus the actor — the "PM/admin silently added a task
to the active sprint" audit gap (Jordan's PO / Alex's SM hard-NOs in the 2026-07-14
activity-streams VoC audit). Covers the firing rules (active-only, no-op guard),
recipient resolution, per-user opt-out, and DND, plus the end-to-end PATCH wiring at
``TaskViewSet.perform_update``.

The facet half shipped in #2897. Until then the cohort was ADMIN+ only, so the two
roles named in the paragraph above — the ones the notification exists for — were
exactly the two it never reached. ``test_notified_set_covers_authorized_set`` pins
the recipient set to the authorization predicate across the whole role x facet
matrix so they cannot split again.
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
from trueppm_api.apps.teams.models import Team, TeamMembership

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


def _default_team(project: Project) -> Team:
    """The project's default team — the only team the ADR-0078 facets are read from."""
    team, _ = Team.objects.get_or_create(
        project=project, is_default=True, defaults={"name": "Default Team", "short_id": "T01"}
    )
    return team


def _facet_member(
    project: Project,
    username: str,
    role: int,
    *,
    scrum_master: bool = False,
    product_owner: bool = False,
) -> Any:
    """A project member who also holds a facet on the default team.

    ``role`` is deliberately independent of the facet: the #2897 cohort is exactly
    the people seated *below* ADMIN who nonetheless hold a facet, so a fixture that
    only ever pairs a facet with ADMIN cannot see the bug.
    """
    user = _member(project, username, role)
    TeamMembership.objects.create(
        team=_default_team(project),
        user=user,
        is_scrum_master=scrum_master,
        is_product_owner=product_owner,
    )
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
# #2897 — the notified set must equal the authorized set
# --------------------------------------------------------------------------- #


def test_product_owner_below_admin_is_notified(
    project: Project,
    actor: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """A PO seated at MEMBER is authorized to rule on the change, so they are told.

    This is the exact shape of #2897 and the normal seating for a Product Owner:
    ``assert_scope_gate_for_project`` lets them accept or reject the injection, and
    ``useCanManageScope`` shows them the "Review pending (N)" chip — but the
    ADMIN-only recipient query meant they only ever found the queue by going to look.
    """
    po = _facet_member(project, "po", Role.MEMBER, product_owner=True)
    active = _sprint(project, "S-active", SprintState.ACTIVE)
    task = Task.objects.create(project=project, name="Injected card", duration=5, sprint=active)

    _fire(task, None, active.pk, actor, django_capture_on_commit_callbacks)

    recipients = {
        n.recipient_id
        for n in Notification.objects.filter(
            event_type=NotificationEventType.SPRINT_MEMBERSHIP_CHANGED
        )
    }
    assert po.pk in recipients


def test_scrum_master_below_admin_is_notified(
    project: Project,
    actor: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """Same for the SM facet — the gate unions both, so the cohort must too."""
    sm = _facet_member(project, "sm", Role.MEMBER, scrum_master=True)
    active = _sprint(project, "S-active", SprintState.ACTIVE)
    task = Task.objects.create(project=project, name="Injected card", duration=5, sprint=active)

    _fire(task, None, active.pk, actor, django_capture_on_commit_callbacks)

    recipients = {
        n.recipient_id
        for n in Notification.objects.filter(
            event_type=NotificationEventType.SPRINT_MEMBERSHIP_CHANGED
        )
    }
    assert sm.pk in recipients


def test_facet_holder_who_is_the_actor_is_not_notified(
    project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """The actor exclusion still applies on the facet half — they made the change.

    Worth its own case: the actor is discarded from the *unioned* set, so a PO who
    is also the actor must not be re-added by the facet query.
    """
    po = _facet_member(project, "po", Role.MEMBER, product_owner=True)
    lead_user = _member(project, "other-lead", Role.ADMIN)
    active = _sprint(project, "S-active", SprintState.ACTIVE)
    task = Task.objects.create(project=project, name="Card", duration=5, sprint=active)

    _fire(task, None, active.pk, po, django_capture_on_commit_callbacks)

    recipients = {
        n.recipient_id
        for n in Notification.objects.filter(
            event_type=NotificationEventType.SPRINT_MEMBERSHIP_CHANGED
        )
    }
    assert recipients == {lead_user.pk}


def test_admin_holding_a_facet_is_notified_exactly_once(
    project: Project,
    actor: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """The union must not duplicate someone who qualifies on both axes.

    A set union rather than list concatenation is what makes this hold; a
    concatenated recipient list would send the same person two inbox rows.
    """
    both = _facet_member(project, "admin-po", Role.ADMIN, product_owner=True)
    active = _sprint(project, "S-active", SprintState.ACTIVE)
    task = Task.objects.create(project=project, name="Card", duration=5, sprint=active)

    _fire(task, None, active.pk, actor, django_capture_on_commit_callbacks)

    assert (
        Notification.objects.filter(
            recipient=both, event_type=NotificationEventType.SPRINT_MEMBERSHIP_CHANGED
        ).count()
        == 1
    )


def test_revoked_facet_holder_is_not_notified(
    project: Project,
    actor: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """A soft-deleted team membership keeps its facet flags — filter it out.

    The privacy property the ADMIN half already had (``is_deleted=False`` on
    ``ProjectMembership``) has to hold on the facet half too, or widening the cohort
    would widen who keeps receiving a project's task names after being removed.
    """
    gone = _facet_member(project, "ex-po", Role.MEMBER, product_owner=True)
    TeamMembership.objects.filter(user=gone).update(is_deleted=True)
    active = _sprint(project, "S-active", SprintState.ACTIVE)
    task = Task.objects.create(project=project, name="Card", duration=5, sprint=active)

    _fire(task, None, active.pk, actor, django_capture_on_commit_callbacks)

    assert not Notification.objects.filter(
        recipient=gone, event_type=NotificationEventType.SPRINT_MEMBERSHIP_CHANGED
    ).exists()


@pytest.mark.parametrize("role", [Role.VIEWER, Role.MEMBER, Role.SCHEDULER, Role.ADMIN])
@pytest.mark.parametrize(
    ("scrum_master", "product_owner"),
    [(False, False), (True, False), (False, True), (True, True)],
)
def test_notified_set_covers_authorized_set(
    project: Project,
    actor: Any,
    role: int,
    scrum_master: bool,
    product_owner: bool,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """Across the whole role x facet matrix: authorized to rule => notified.

    This is the anti-drift pin, and it asserts the *relationship* rather than either
    side's membership list. #2897 was not a wrong query — both queries were correct
    for what they said. It was two correct queries that had stopped meaning the same
    thing, with a stale comment explaining away the difference. A test of either one
    alone would have stayed green through it; only comparing them fails.

    The converse (notified => authorized) is deliberately not asserted: an ADMIN who
    is not a facet holder is both, but a future cohort could reasonably widen to
    interested-but-unauthorized watchers. Authorized-without-notice is the defect.
    """
    from trueppm_api.apps.projects.services import (
        ScopeAcceptForbidden,
        assert_scope_gate_for_project,
    )

    subject = _facet_member(
        project,
        "subject",
        role,
        scrum_master=scrum_master,
        product_owner=product_owner,
    )
    active = _sprint(project, "S-active", SprintState.ACTIVE)
    task = Task.objects.create(project=project, name="Card", duration=5, sprint=active)

    try:
        assert_scope_gate_for_project(project.pk, subject)
        authorized = True
    except ScopeAcceptForbidden:
        authorized = False

    _fire(task, None, active.pk, actor, django_capture_on_commit_callbacks)
    notified = Notification.objects.filter(
        recipient=subject, event_type=NotificationEventType.SPRINT_MEMBERSHIP_CHANGED
    ).exists()

    assert not (authorized and not notified), (
        f"role={role} scrum_master={scrum_master} product_owner={product_owner} may accept or "
        "reject this scope change and was never told it arrived"
    )


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
