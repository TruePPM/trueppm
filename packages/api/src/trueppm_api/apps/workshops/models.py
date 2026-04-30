"""Workshop session models — live collaborative planning sessions on the Board."""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models


class WorkshopSession(models.Model):
    """A live collaborative workshop session scoped to a single project.

    At most one session may be active (ended_at IS NULL) per project at a time,
    enforced by the unique_active_workshop_per_project partial unique constraint.

    Plain Model (not VersionedModel) — workshop sessions are not synced to
    mobile; they are ephemeral coordination records.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.CASCADE,
        related_name="workshop_sessions",
    )
    started_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="+",
    )
    started_at = models.DateTimeField(auto_now_add=True)
    ended_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "workshops_session"
        ordering = ["-started_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["project"],
                condition=models.Q(ended_at__isnull=True),
                name="unique_active_workshop_per_project",
            )
        ]

    def __str__(self) -> str:
        status = "active" if self.ended_at is None else "ended"
        return f"WorkshopSession({self.project_id}, {status})"


class WorkshopParticipant(models.Model):
    """Tracks a user's presence in a workshop session.

    Records join/leave times for the session log. A user may rejoin a session
    (left_at is reset to NULL on reconnect; a new row is created on each join
    to preserve the full participation history).
    """

    session = models.ForeignKey(
        WorkshopSession,
        on_delete=models.CASCADE,
        related_name="participants",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="+",
    )
    joined_at = models.DateTimeField(auto_now_add=True)
    left_at = models.DateTimeField(null=True, blank=True)
    # Stable color index assigned on first join; drives the avatar color in the UI.
    color_index = models.PositiveSmallIntegerField(default=0)

    class Meta:
        db_table = "workshops_participant"
        ordering = ["joined_at"]
        # DB-level guard against duplicate rows from simultaneous reconnects.
        unique_together = [("session", "user")]

    def __str__(self) -> str:
        return f"WorkshopParticipant({self.user_id} in {self.session_id})"
