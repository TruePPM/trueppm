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
- ProjectNotificationPreference — per-(project, user) routing matrix plus
  daily quiet-hours window. Backs the Project > Notifications settings page
  (#522); orthogonal to NotificationPreference, which is the *global* mention
  feed default.
"""

from __future__ import annotations

import datetime
import uuid
from typing import Any

from django.conf import settings
from django.db import models

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
    in_app / email per event type. The own-task events (#639, ADR-0085) reuse
    the WebhookEventType string values where one exists (task.assigned,
    task.due_date_changed) so event names share one source of truth across the
    webhook and notification subsystems; comment_on_my_task is notification-only.
    @mentions of me are covered by MENTION_INDIVIDUAL / MENTION_GROUP and the
    existing mention path — task.mentioned is not duplicated here.
    """

    MENTION_INDIVIDUAL = "mention_individual", "Direct @mention"
    MENTION_GROUP = "mention_group", "Group @mention"
    # Own-task events (#639) — a user's reach over work assigned to or owned by them.
    TASK_ASSIGNED = "task.assigned", "Assigned to me"
    TASK_DUE_DATE_CHANGED = "task.due_date_changed", "Due date changed on my task"
    COMMENT_ON_MY_TASK = "comment_on_my_task", "Comment on my task"
    # Contributor signal (#855, #476) — fires when a task I own is flagged blocked
    # by someone else. One of the two events in the SIGNAL_ONLY_EVENTS preset.
    TASK_BLOCKED = "task.blocked", "A task I own is blocked"
    # Sprint-close bridge digest (#861) — the PM cohort is told when a closed
    # sprint's reforecast materially shifts a bound milestone's finish. Email
    # defaults ON for this one event (see DEFAULT_PREFERENCES): the issue's whole
    # point is reaching the PM *outside* her session, which in-app alone can't do.
    MILESTONE_FORECAST_SHIFTED = "milestone.forecast_shifted", "Milestone forecast shifted"
    # Schedule-canvas reschedule of a sprint-mate's task (#497) — the rest of the
    # ACTIVE sprint team learns a committed date moved. In-app only for v1.
    SPRINT_TASK_RESCHEDULED = "sprint.task_rescheduled", "Task in my sprint rescheduled"
    # Signal-privacy ceiling-raise ratification (#1275, ADR-0104 Amendment B) — a
    # team-owned vote to widen a signal's visibility. "Opened" reaches eligible
    # voters so the 72h window is discoverable off the Settings page; "resolved"
    # reaches voters + the proposer with the outcome. In-app ON, email opt-in OFF
    # (Priya's hard-NO was on un-opted email, not on an in-app inbox row).
    SIGNAL_CEILING_PROPOSAL_OPENED = (
        "signal.ceiling_proposal_opened",
        "Team signal visibility proposal opened",
    )
    SIGNAL_CEILING_PROPOSAL_RESOLVED = (
        "signal.ceiling_proposal_resolved",
        "Team signal visibility proposal resolved",
    )
    # Project-delete team notification (#1115, VoC Option C). A project soft-delete
    # is a large destructive write that removes the whole team's workspace; every
    # member (bar the deleter) is told in-app who deleted it, so a project does not
    # simply vanish from under them. In-app ON by default; email strictly opt-in OFF
    # (Priya's hard-NO on un-opted email); NEVER push — the durable inbox row is the
    # only channel, so the notification can never arrive as an unsolicited interrupt.
    PROJECT_DELETED = "project.deleted", "A project I belong to was deleted"


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

    def visible_to(
        self,
        user: Any,
        project_id: uuid.UUID | str | None = None,
    ) -> models.QuerySet[Mention]:
        """Return mentions the user is permitted to see.

        Rules:
        - Always restricted to projects the user is a member of (anchored by
          ProjectMembership; non-deleted only).
        - Within those projects, PROJECT_VISIBLE mentions are visible to all
          members. TEAM_ONLY mentions (future #476) are visible only to the
          mentioner, the mentioned user, and members of the mentioned group.
          PRIVATE mentions are visible only to mentioner + mentioned_user.

        NOTE: Currently UNUSED in the 0.2 viewsets — Mention visibility is
        enforced indirectly via NotificationViewSet's `recipient=request.user`
        filter and the absence of a direct Mention list endpoint. This method
        is pre-positioned for #476, which will expose a Decision rollup view
        that queries Mentions directly. Do NOT remove as dead code; it's the
        single point of TEAM_ONLY scope enforcement when that scope is wired.
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

    # Source — a notification is EITHER mention-sourced (mention set, rendered
    # from the comment) OR event-sourced (#639, ADR-0085 §3: event_type + the
    # pre-rendered subject/body set, mention null). Both feed the one inbox.
    mention = models.ForeignKey(
        Mention,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="notifications",
    )
    # Event-sourced notifications (own-task events) — blank for mention rows.
    event_type = models.CharField(max_length=64, blank=True, default="")
    subject = models.CharField(max_length=255, blank=True, default="")
    body = models.TextField(blank=True, default="")

    # Optional deep-link target (#497/#861). Mention rows resolve their task via
    # the comment; event rows have no such path, so this FK lets the inbox row
    # link straight to the affected task/milestone in the schedule. SET_NULL +
    # related_name="+" — a deleted task should never cascade-delete the historical
    # notification, and no reverse accessor on Task is needed.
    task = models.ForeignKey(
        "projects.Task",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
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
    # Own-task events (#639): in-app ON, email OFF. Email is strictly opt-in —
    # aggressive email defaults were Priya's VoC blocker (ADR-0085 §1, ADR-0075 V2).
    (NotificationEventType.TASK_ASSIGNED, NotificationChannel.IN_APP, True),
    (NotificationEventType.TASK_ASSIGNED, NotificationChannel.EMAIL, False),
    (NotificationEventType.TASK_DUE_DATE_CHANGED, NotificationChannel.IN_APP, True),
    (NotificationEventType.TASK_DUE_DATE_CHANGED, NotificationChannel.EMAIL, False),
    (NotificationEventType.COMMENT_ON_MY_TASK, NotificationChannel.IN_APP, True),
    (NotificationEventType.COMMENT_ON_MY_TASK, NotificationChannel.EMAIL, False),
    # Blocked signal (#855): in-app ON, email OFF — same opt-in-email rule. This
    # event is one of the two kept ON by the Signal-only preset below.
    (NotificationEventType.TASK_BLOCKED, NotificationChannel.IN_APP, True),
    (NotificationEventType.TASK_BLOCKED, NotificationChannel.EMAIL, False),
    # #861 — the bridge digest is the deliberate exception to the email-OFF
    # default: a PM who is not logged in when the team closes a sprint at 7pm
    # must still be pushed the milestone-confidence shift, or "automatic" still
    # demands she remember to log in (the issue's core blocker). Still fully
    # matrix-overridable — a PM can mute either channel.
    (NotificationEventType.MILESTONE_FORECAST_SHIFTED, NotificationChannel.IN_APP, True),
    (NotificationEventType.MILESTONE_FORECAST_SHIFTED, NotificationChannel.EMAIL, True),
    # #497 — in-app only for v1 (email digest/push explicitly out of scope).
    (NotificationEventType.SPRINT_TASK_RESCHEDULED, NotificationChannel.IN_APP, True),
    (NotificationEventType.SPRINT_TASK_RESCHEDULED, NotificationChannel.EMAIL, False),
    # #1275 / ADR-0104 Amendment B — ceiling-raise proposal discovery. In-app ON so
    # voters see the ask without navigating to Settings; email strictly opt-in OFF
    # (Priya's hard-NO is preserved — un-opted email noise, not the in-app inbox).
    (NotificationEventType.SIGNAL_CEILING_PROPOSAL_OPENED, NotificationChannel.IN_APP, True),
    (NotificationEventType.SIGNAL_CEILING_PROPOSAL_OPENED, NotificationChannel.EMAIL, False),
    (NotificationEventType.SIGNAL_CEILING_PROPOSAL_RESOLVED, NotificationChannel.IN_APP, True),
    (NotificationEventType.SIGNAL_CEILING_PROPOSAL_RESOLVED, NotificationChannel.EMAIL, False),
    # #1115 — project-delete team notification. In-app ON so every member learns
    # their project was deleted; email opt-in OFF (Priya's un-opted-email hard-NO).
    (NotificationEventType.PROJECT_DELETED, NotificationChannel.IN_APP, True),
    (NotificationEventType.PROJECT_DELETED, NotificationChannel.EMAIL, False),
]


# ---------------------------------------------------------------------------
# Signal-only preset (#855) — the contributor-friendly minimal profile
# ---------------------------------------------------------------------------
# Priya (Team Member) gave a hard-NO on noisy notifications. "Signal-only" is the
# one-click profile that keeps ON only the two events that mean "something needs
# my attention" — a task of mine got blocked, or a deadline moved — and turns
# everything else OFF. It is applied by POST /me/notification-preferences/
# apply-preset/ (a wholesale write of the per-(event,channel) rows), NOT a new
# stored model: the matrix stays the single source of truth so the existing
# data-driven settings page (ADR-0085) keeps rendering whatever rows the server
# returns. The "everything" preset restores DEFAULT_PREFERENCES.
SIGNAL_ONLY_EVENTS: frozenset[str] = frozenset(
    {
        NotificationEventType.TASK_BLOCKED,
        NotificationEventType.TASK_DUE_DATE_CHANGED,
    }
)


# ---------------------------------------------------------------------------
# Project-scoped notification preferences (#522)
# ---------------------------------------------------------------------------


class ProjectNotificationEventType(models.TextChoices):
    """Project-scoped notification events surfaced on Project > Notifications.

    Disjoint from `NotificationEventType` (which today only covers @mention
    fan-out for the inbox surface). The project page covers the broader set
    of routing decisions a PM makes per-project — task assignment, slips,
    risk creation, sprint lifecycle, etc.
    """

    TASK_ASSIGNED = "task_assigned", "Task assigned to me"
    TASK_OVERDUE = "task_overdue", "Task I own is overdue"
    COMMENT_MENTION = "comment_mention", "Mention (@) in a comment"
    STATUS_CHANGE = "status_change", "Task moves to another column"
    BUDGET_ALERT = "budget_alert", "Budget threshold crossed"
    RISK_CREATED = "risk_created", "Risk created or escalated"
    MILESTONE_REACHED = "milestone_reached", "Milestone reached"
    SPRINT_START = "sprint_start", "Sprint started"
    SPRINT_END = "sprint_end", "Sprint closed"


class ProjectNotificationChannel(models.TextChoices):
    """Delivery channels for project-scoped notifications.

    `slack` and `mobile_push` are wired here for the settings UI; actual
    delivery requires the Slack/mobile integrations to be configured at the
    project (Slack) or user (mobile push) level. A toggle in the matrix
    represents user intent — it does not imply the integration is live.
    """

    IN_APP = "in_app", "In-app"
    EMAIL = "email", "Email"
    SLACK = "slack", "Slack"
    MOBILE_PUSH = "mobile_push", "Mobile push"


# Default matrix — applied lazily on first GET (no per-user backfill on join).
# Mobile push is OFF by default for non-critical events to avoid waking users;
# critical-path / risk / budget alerts default ON across every channel.
_T = ProjectNotificationEventType
_C = ProjectNotificationChannel

PROJECT_NOTIFICATION_DEFAULT_MATRIX: dict[str, dict[str, bool]] = {
    _T.TASK_ASSIGNED: {_C.IN_APP: True, _C.EMAIL: True, _C.SLACK: True, _C.MOBILE_PUSH: True},
    _T.TASK_OVERDUE: {_C.IN_APP: True, _C.EMAIL: True, _C.SLACK: True, _C.MOBILE_PUSH: True},
    _T.COMMENT_MENTION: {
        _C.IN_APP: True,
        _C.EMAIL: True,
        _C.SLACK: True,
        _C.MOBILE_PUSH: True,
    },
    _T.STATUS_CHANGE: {
        _C.IN_APP: True,
        _C.EMAIL: False,
        _C.SLACK: False,
        _C.MOBILE_PUSH: False,
    },
    _T.BUDGET_ALERT: {_C.IN_APP: True, _C.EMAIL: True, _C.SLACK: True, _C.MOBILE_PUSH: True},
    _T.RISK_CREATED: {_C.IN_APP: True, _C.EMAIL: True, _C.SLACK: True, _C.MOBILE_PUSH: True},
    _T.MILESTONE_REACHED: {
        _C.IN_APP: True,
        _C.EMAIL: True,
        _C.SLACK: True,
        _C.MOBILE_PUSH: False,
    },
    _T.SPRINT_START: {
        _C.IN_APP: True,
        _C.EMAIL: True,
        _C.SLACK: True,
        _C.MOBILE_PUSH: False,
    },
    _T.SPRINT_END: {
        _C.IN_APP: True,
        _C.EMAIL: True,
        _C.SLACK: True,
        _C.MOBILE_PUSH: False,
    },
}


def _default_matrix() -> dict[str, dict[str, bool]]:
    """Deep-copy of the default matrix used as the JSONField default.

    Django requires a callable; returning the literal would share mutable
    state across rows.
    """
    return {evt: dict(chans) for evt, chans in PROJECT_NOTIFICATION_DEFAULT_MATRIX.items()}


class ProjectNotificationPreference(models.Model):
    """Per-(project, user) notification routing matrix and quiet-hours window.

    One row per user per project. The matrix is a `{event_type: {channel: bool}}`
    JSON document — the row count stays small (one per user per project) and
    PATCH is a single UPDATE rather than a 36-row diff. Missing event/channel
    keys fall back to the default matrix on read, so a stale row won't break
    when the event set grows.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.CASCADE,
        related_name="notification_preferences_by_user",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="project_notification_preferences",
    )
    matrix = models.JSONField(default=_default_matrix)

    # Per-user-per-project kill-switch (#589). When True, all notification
    # dispatch for this user on this project is suppressed regardless of the
    # matrix — an opt-out path for members who haven't dialed in their
    # routing yet. The matrix remains preserved so unpausing restores prior
    # preferences exactly.
    paused = models.BooleanField(default=False)

    quiet_hours_enabled = models.BooleanField(default=True)
    quiet_hours_from = models.TimeField(default=datetime.time(20, 0))
    quiet_hours_until = models.TimeField(default=datetime.time(7, 0))

    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "notifications_project_preference"
        constraints = [
            models.UniqueConstraint(
                fields=["project", "user"],
                name="uq_projnotifpref_project_user",
            ),
        ]
        indexes = [
            models.Index(fields=["project", "user"], name="ix_projnotifpref_proj_user"),
        ]

    def __str__(self) -> str:
        return f"ProjectNotificationPreference(project={self.project_id}, user={self.user_id})"
