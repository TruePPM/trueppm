"""Signals for the access app — real-time eviction on membership revocation (#813).

The project WebSocket consumer checks ``ProjectMembership`` only at
``websocket_connect``. Once accepted, a socket keeps receiving project events until it
disconnects, so a user whose membership is soft-deleted or demoted below ``Role.MEMBER``
would keep receiving real-time CPM/task/presence data for as long as the socket stayed
open — the active-connection analog of #419 (which fixed the reconnect-time path).

These signals detect a revocation transition on any ``ProjectMembership`` write — the
viewset, the ownership-transfer service, and the workspace Group→project cascade all go
through ``save()``/``delete()`` — and push a ``connection.evict`` to the project's WS
groups so the affected user's live sockets close with code 4003 immediately.

**Account deactivation is a second, independent revocation axis (#2850).** Workspace
off-boarding writes ``WorkspaceMembership.status = DEACTIVATED`` and
``User.is_active = False`` and **never touches ``ProjectMembership``**, so the
membership receivers below never fired for it. Two prior fixes each closed one axis
and neither closed the intersection: #813 closed revoke-while-connected for *project
membership*, #888 closed the ``is_active`` gap at *connect time* — leaving an
off-boarded member's already-open socket streaming until they closed the tab.

The account-level receiver is bound to ``User`` rather than added as two calls in the
off-boarding view precisely because that is what makes it cover the *class*: both
off-boarding branches, the Django admin, a management command, and any future
deactivation path all go through ``User.save()``.
"""

from __future__ import annotations

from functools import partial
from typing import Any

from django.conf import settings
from django.db import transaction
from django.db.models.signals import post_delete, pre_save
from django.dispatch import receiver

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.sync.broadcast import evict_project_connection


def _schedule_evict(project_id: Any, user_id: Any) -> None:
    """Defer the evict to commit so a rolled-back revocation evicts nobody."""
    transaction.on_commit(partial(evict_project_connection, str(project_id), str(user_id)))


def _discard_active_timers_on_revocation(project_id: Any, user_id: Any) -> None:
    """Delete the user's running timer(s) on this project's tasks (#4318).

    **Discard, not finalize — the settled choice for #4318.** A member whose
    ``ProjectMembership`` is revoked (removed, or demoted below ``Role.MEMBER``, so
    ``can_log_time`` would now answer ``False``) can still have a live
    ``ActiveTimer`` row ticking. Two options existed: auto-finalize it into a
    ``TimeEntry`` at the moment of revocation, or drop it with no entry created.
    Discard was chosen — auto-finalizing would silently attribute logged hours to a
    project the user no longer belongs to, and the resulting entry would outlive
    the membership that was supposed to authorize it. A dropped timer is simply
    gone; a subsequent ``POST /me/timer/stop`` finds no row and answers the
    existing ``409`` ("no active timer to stop"), not a new error shape.

    Synchronous, inside the caller's transaction — unlike ``_schedule_evict``, this
    is a same-database write with no external side effect, so it naturally rolls
    back together with the membership change on a failed transaction; deferring it
    to commit would buy nothing and would let a stopped-in-between request race the
    delete.

    Scoped to ``project_id`` (not every project the user belongs to): a revocation
    on one project must not touch a running timer on another project the user is
    still a live member of.
    """
    from trueppm_api.apps.timetracking.models import ActiveTimer

    ActiveTimer.objects.filter(user_id=user_id, task__project_id=project_id).delete()


@receiver(pre_save, sender=ProjectMembership, dispatch_uid="access_evict_on_membership_revocation")
def _evict_on_revocation(sender: type, instance: ProjectMembership, **kwargs: Any) -> None:
    """Evict live sockets and discard running timers when a membership is revoked.

    Fires on the same transition for both effects: a soft-delete, or a demotion
    *across* the Member threshold (e.g. Member/Scheduler/Admin -> Viewer). A
    demotion that stays at or above Member keeps the user connectable and able to
    log time, so neither effect fires. See :func:`_discard_active_timers_on_revocation`
    for why the timer is discarded rather than finalized (#4318).
    """
    if instance.pk is None:
        return  # brand-new membership — nothing to revoke
    old = ProjectMembership.objects.filter(pk=instance.pk).only("role", "is_deleted").first()
    if old is None:
        return
    became_deleted = not old.is_deleted and instance.is_deleted
    # Demotion *across* the Member threshold (e.g. Member/Scheduler/Admin -> Viewer).
    # A demotion that stays at or above Member keeps the user connectable, so no evict.
    demoted_below_member = old.role >= Role.MEMBER and instance.role < Role.MEMBER
    if became_deleted or demoted_below_member:
        _schedule_evict(instance.project_id, instance.user_id)
        _discard_active_timers_on_revocation(instance.project_id, instance.user_id)


@receiver(
    post_delete, sender=ProjectMembership, dispatch_uid="access_evict_on_membership_hard_delete"
)
def _evict_on_hard_delete(sender: type, instance: ProjectMembership, **kwargs: Any) -> None:
    """Evict live sockets and discard running timers if a membership row is hard-deleted.

    Cascade / admin only — the viewset's own removal path soft-deletes (see
    :func:`_evict_on_revocation`). A cascaded *project* delete already removes any
    ``ActiveTimer`` transitively (``Task`` -> ``Project`` is ``CASCADE``), so this
    mainly covers a direct admin hard-delete of just the membership row, where the
    project and its tasks are untouched (#4318).
    """
    _schedule_evict(instance.project_id, instance.user_id)
    _discard_active_timers_on_revocation(instance.project_id, instance.user_id)


@receiver(pre_save, sender=settings.AUTH_USER_MODEL, dispatch_uid="access_evict_on_deactivation")
def _evict_on_account_deactivation(sender: type, instance: Any, **kwargs: Any) -> None:
    """Evict every live project socket when an account is deactivated (#2850).

    Authorization on both consumers runs exactly once, at connect, and ``is_active``
    is read only there (``sync/ws_auth.py:_resolve_active_user``). So an off-boarded
    member's open socket kept streaming ``task_created`` / ``task_dates_updated`` /
    presence for the whole session — while their REST access died immediately,
    because the JWT authenticator does honor ``is_active``.

    Fires on the ``True -> False`` transition only. Reactivation grants nothing that
    needs evicting, and firing on every ``User.save()`` would push an evict message
    per project on unrelated profile edits.

    Deferred to commit through ``_schedule_evict``, so a rolled-back deactivation
    evicts nobody — the same contract the membership receivers above use.
    """
    if instance.pk is None:
        return  # new account — nothing connected under it yet
    if instance.is_active:
        return  # not a deactivation; reactivation needs no evict
    model = type(instance)
    was_active = model.objects.filter(pk=instance.pk).values_list("is_active", flat=True).first()
    if not was_active:
        return  # already inactive — an unrelated save, not the transition

    # Live memberships only: a soft-deleted one already evicted via _evict_on_revocation,
    # and the consumer would refuse the reconnect anyway.
    project_ids = ProjectMembership.objects.filter(
        user_id=instance.pk, is_deleted=False
    ).values_list("project_id", flat=True)
    for project_id in project_ids:
        _schedule_evict(project_id, instance.pk)
