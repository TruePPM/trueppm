"""Signals for the access app — real-time eviction on membership revocation (#813).

Project WebSocket consumers (board + workshop) check ``ProjectMembership`` only at
``websocket_connect``. Once accepted, a socket keeps receiving project events until it
disconnects, so a user whose membership is soft-deleted or demoted below ``Role.MEMBER``
would keep receiving real-time CPM/task/presence data for as long as the socket stayed
open — the active-connection analog of #419 (which fixed the reconnect-time path).

These signals detect a revocation transition on any ``ProjectMembership`` write — the
viewset, the ownership-transfer service, and the workspace Group→project cascade all go
through ``save()``/``delete()`` — and push a ``connection.evict`` to the project's WS
groups so the affected user's live sockets close with code 4003 immediately.
"""

from __future__ import annotations

from functools import partial
from typing import Any

from django.db import transaction
from django.db.models.signals import post_delete, pre_save
from django.dispatch import receiver

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.sync.broadcast import evict_project_connection


def _schedule_evict(project_id: Any, user_id: Any) -> None:
    """Defer the evict to commit so a rolled-back revocation evicts nobody."""
    transaction.on_commit(partial(evict_project_connection, str(project_id), str(user_id)))


@receiver(pre_save, sender=ProjectMembership, dispatch_uid="access_evict_on_membership_revocation")
def _evict_on_revocation(sender: type, instance: ProjectMembership, **kwargs: Any) -> None:
    """Evict live sockets when a membership transitions to soft-deleted or below Member."""
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


@receiver(
    post_delete, sender=ProjectMembership, dispatch_uid="access_evict_on_membership_hard_delete"
)
def _evict_on_hard_delete(sender: type, instance: ProjectMembership, **kwargs: Any) -> None:
    """Evict live sockets if a membership row is hard-deleted (cascade / admin)."""
    _schedule_evict(instance.project_id, instance.user_id)
