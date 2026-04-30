"""Business logic for workshop session lifecycle."""

from __future__ import annotations

from typing import TYPE_CHECKING

from django.db import transaction
from django.utils import timezone

from trueppm_api.apps.workshops.models import WorkshopSession

if TYPE_CHECKING:
    from django.contrib.auth.models import AbstractUser

    from trueppm_api.apps.projects.models import Project


def start_workshop(project: Project, user: AbstractUser) -> WorkshopSession:
    """Create and return a new active WorkshopSession for the project.

    Raises IntegrityError if a session is already active (callers should catch
    and return HTTP 409).

    Args:
        project: The project to start the workshop on.
        user: The user initiating the session.

    Returns:
        The newly created WorkshopSession.
    """
    session = WorkshopSession(project=project, started_by=user)  # type: ignore[misc]
    session.save()  # IntegrityError propagates on duplicate active session

    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    transaction.on_commit(
        lambda: broadcast_board_event(
            project_id=str(project.pk),
            event_type="workshop_started",
            payload={"session_id": str(session.pk)},
        )
    )
    return session


def end_workshop(session: WorkshopSession, user: AbstractUser) -> WorkshopSession:
    """End a workshop session by setting ended_at.

    Idempotent: if already ended, returns the session unchanged.

    Args:
        session: The WorkshopSession to end.
        user: The user ending the session (for audit purposes, unused for now).

    Returns:
        The updated WorkshopSession.
    """
    if session.ended_at is not None:
        return session

    session.ended_at = timezone.now()
    session.save(update_fields=["ended_at"])

    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    transaction.on_commit(
        lambda: broadcast_board_event(
            project_id=str(session.project_id),
            event_type="workshop_ended",
            payload={"session_id": str(session.pk)},
        )
    )
    return session


def force_end_workshop(project: Project) -> WorkshopSession | None:
    """End the active workshop session for a project, if one exists.

    Used by admins to recover from crashed sessions that never called end.

    Args:
        project: The project whose active session to terminate.

    Returns:
        The ended WorkshopSession, or None if no active session exists.
    """
    try:
        session = WorkshopSession.objects.get(project=project, ended_at__isnull=True)
    except WorkshopSession.DoesNotExist:
        return None

    session.ended_at = timezone.now()
    session.save(update_fields=["ended_at"])

    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    transaction.on_commit(
        lambda: broadcast_board_event(
            project_id=str(project.pk),
            event_type="workshop_ended",
            payload={"session_id": str(session.pk)},
        )
    )
    return session
