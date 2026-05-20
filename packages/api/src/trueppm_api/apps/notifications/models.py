"""Notifications data model (ADR-0075).

Three entities power the unified @mention surface that #311 ships first and
#476 (deferred Notes) will inherit unchanged:

- Mention — polymorphic append-only @mention record. Source is one of a small
  set of nullable FKs (today: TaskComment; #476 adds TaskNote). Target is
  either a user (direct mention) or a group key (snapshot expanded to per-
  user Notification rows at write time).
- Notification — per-recipient inbox row. Single feed surface so a future
  #476 note-mention lands in the same UI as today's comment-mention.
- NotificationPreference — per-user `(event_type, channel)` toggle. Consumes
  ADR-0049's NOTIFICATION_CHANNELS registry; Enterprise extends the channel
  axis with slack_dm/teams_dm/sms without OSS changes.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from django.conf import settings
from django.db import models

if TYPE_CHECKING:
    pass

# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class MentionScope(models.TextChoices):
    """Visibility scope of a @mention's source content.

    `PROJECT_VISIBLE` is the only value used by #311 (comments); #476 will
    populate `TEAM_ONLY` for team-private Decisions and the visibility gate
    on the Decisions view. The scope field exists on day one so #476's gate
    isn't bolted on as an afterthought.
    """

    PROJECT_VISIBLE = "project_visible", "Project visible"
    TEAM_ONLY = "team_only", "Team only"
    PRIVATE = "private", "Private"


class NotificationEventType(models.TextChoices):
    """Event types that produce notifications.

    Mapped to NotificationPreference rows so users can independently toggle
    in_app / email per event type. 0.2 has two; #476 adds note-flavored events.
    """

    MENTION_INDIVIDUAL = "mention_individual", "Direct @mention"
    MENTION_GROUP = "mention_group", "Group @mention"


class NotificationChannel(models.TextChoices):
    """Delivery channels (OSS keys only; Enterprise extends via ADR-0049
    NOTIFICATION_CHANNELS registry — slack_dm / teams_dm / sms).
    """

    IN_APP = "in_app", "In-app"
    EMAIL = "email", "Email"


# ---------------------------------------------------------------------------
# Manager — scope-respecting queryset (ADR-0075 must-fix)
# ---------------------------------------------------------------------------


class MentionManager(models.Manager["Mention"]):
    """Manager enforcing the `Mention.objects.visible_to(user)` pattern.

    All read paths must go through this method so #476's TEAM_ONLY scope is
    enforced at a single point. Raw `Mention.objects.filter(...)` in viewsets
    is forbidden — the rule is a review checklist item until a lint can be
    added.
    """

    def visible_to(self, user, project_id: uuid.UUID | str | None = None):
        """Return mentions the user is permitted to see.

        Rules:
        - Always restricted to projects the user is a member of (anchored by
          ProjectMembership; non-deleted only).
        - Within those projects, PROJECT_VISIBLE mentions are visible to all
          members. TEAM_ONLY mentions (future #476) are visible only to the
          mentioner, the mentioned user, and members of the mentioned group.
          PRIVATE mentions are visible only to mentioner + mentioned_user.
        """
        from trueppm_api.apps.access.models import ProjectMembership

        if not user or not getattr(user, "is_authenticated", False):
            return self.none()

        member_projects = ProjectMembership.objects.filter(user=user, is_deleted=False).values_list(
            "project_id", flat=True
        )
        qs = self.get_queryset().filter(project_id__in=list(member_projects))

        if project_id is not None:
            qs = qs.filter(project_id=project_id)

        # Scope gate. PROJECT_VISIBLE is the only scope used in 0.2 (#311);
        # the other two branches are inert today but the structure exists so
        # #476 can populate them without a schema change or rewrite.
        return qs.filter(
            models.Q(scope=MentionScope.PROJECT_VISIBLE)
            | models.Q(scope=MentionScope.TEAM_ONLY, mentioned_user=user)
            | models.Q(scope=MentionScope.TEAM_ONLY, mentioner=user)
            | models.Q(scope=MentionScope.PRIVATE, mentioned_user=user)
            | models.Q(scope=MentionScope.PRIVATE, mentioner=user)
        )


# ---------------------------------------------------------------------------
# Mention
# ---------------------------------------------------------------------------


class Mention(models.Model):
    """Append-only @mention record. Polymorphic source via nullable FKs.

    Exactly one source FK and at least one target (user OR group_key) must be
    set — enforced by CheckConstraints. The `mentioned_group_key` is preserved
    on the row for display ("@scrum-team was mentioned"), independently of
    the per-recipient Notification rows that fan out from group resolution.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    mentioner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="mentions_authored",
    )

    # Target — direct user OR group_key (or both, if the group resolution
    # happens to include the mentioned user explicitly).
    mentioned_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="mentions_received",
    )
    # Empty string = no group key (Django convention DJ001: no nullable CharField).
    mentioned_group_key = models.CharField(max_length=32, blank=True, default="")

    # Polymorphic source. 0.2 has TaskComment only; #476 will add task_note.
    # CheckConstraint requires exactly one (today: task_comment must be set).
    task_comment = models.ForeignKey(
        "projects.TaskComment",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="mentions",
    )

    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.CASCADE,
        related_name="mentions",
    )
    scope = models.CharField(
        max_length=32,
        choices=MentionScope.choices,
        default=MentionScope.PROJECT_VISIBLE,
    )
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    objects = MentionManager()

    class Meta:
        db_table = "notifications_mention"
        ordering = ["-created_at"]
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(mentioned_user__isnull=False) | ~models.Q(mentioned_group_key="")
                ),
                name="mention_must_have_target",
            ),
            # In 0.2 only task_comment is a valid source; when #476 ships,
            # widen this to allow task_note as well.
            models.CheckConstraint(
                condition=models.Q(task_comment__isnull=False),
                name="mention_must_have_source",
            ),
        ]
        indexes = [
            models.Index(fields=["mentioned_user", "-created_at"], name="ix_mention_user_recent"),
            models.Index(fields=["project", "-created_at"], name="ix_mention_project_recent"),
        ]

    def __str__(self) -> str:
        target = self.mentioned_user_id or f"@{self.mentioned_group_key}"
        return f"Mention(to={target}, scope={self.scope})"


# ---------------------------------------------------------------------------
# Notification — per-recipient inbox row
# ---------------------------------------------------------------------------


class Notification(models.Model):
    """Per-recipient unread notification. Generated from Mention fan-out (0.2)
    and future event types. Single inbox surface — every #476 mention lands
    here unchanged.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    recipient = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="notifications",
    )

    # Source — nullable FKs (exactly one set today). Extends as new event
    # types arrive without schema rewrite.
    mention = models.ForeignKey(
        Mention,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="notifications",
    )

    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.CASCADE,
        related_name="notifications",
    )

    is_read = models.BooleanField(default=False, db_index=True)
    is_archived = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    read_at = models.DateTimeField(null=True, blank=True)

    # Email delivery state (drained via drain_notification_emails Beat task).
    email_pending = models.BooleanField(default=False, db_index=True)
    email_sent_at = models.DateTimeField(null=True, blank=True)
    email_failed_at = models.DateTimeField(null=True, blank=True)
    email_attempts = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "notifications_notification"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["recipient", "is_read", "-created_at"], name="ix_notif_unread"),
            models.Index(
                fields=["email_pending", "-created_at"],
                name="ix_notif_email_pending",
                condition=models.Q(email_pending=True),
            ),
        ]

    def __str__(self) -> str:
        return f"Notification(to={self.recipient_id}, mention={self.mention_id})"


# ---------------------------------------------------------------------------
# NotificationPreference — per-user (event_type, channel) toggle
# ---------------------------------------------------------------------------


class NotificationPreference(models.Model):
    """Per-user channel preference, per event type.

    Defaults backfill on first GET (see services.get_or_create_defaults). The
    channel axis is open-ended — ADR-0049 Enterprise channels (slack_dm,
    teams_dm, sms) coexist here without an OSS schema change.
    """

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="notification_preferences",
    )
    event_type = models.CharField(max_length=64)  # NotificationEventType + future
    channel = models.CharField(max_length=32)  # NotificationChannel + Enterprise extensions
    enabled = models.BooleanField()
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "notifications_preference"
        constraints = [
            models.UniqueConstraint(
                fields=["user", "event_type", "channel"],
                name="uq_notifpref_user_event_channel",
            ),
        ]

    def __str__(self) -> str:
        state = "on" if self.enabled else "off"
        return f"NotificationPreference({self.event_type}/{self.channel}={state})"


# ---------------------------------------------------------------------------
# Defaults (ADR-0075 V2 VoC — Priya's "flip email default OFF")
# ---------------------------------------------------------------------------


DEFAULT_PREFERENCES: list[tuple[str, str, bool]] = [
    (NotificationEventType.MENTION_INDIVIDUAL, NotificationChannel.IN_APP, True),
    (NotificationEventType.MENTION_INDIVIDUAL, NotificationChannel.EMAIL, False),
    (NotificationEventType.MENTION_GROUP, NotificationChannel.IN_APP, True),
    (NotificationEventType.MENTION_GROUP, NotificationChannel.EMAIL, False),
]
