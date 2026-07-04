"""Notification fan-out + mention parser (ADR-0075 §C, §D).

Pure-function `parse_mentions` extracts `@user` and `@group` references from
free-text comment bodies. Code-fence and inline-code aware so `@foo` inside
triple-backtick blocks or single backticks is NOT treated as a mention.
`\\@foo` is an explicit escape that renders the literal text.

`create_mention_notifications` is the single transactional fan-out path:
called from the comment viewset's `perform_create` (inside `transaction.
on_commit` is NOT correct here — Notification rows must be visible to the
caller in the same transaction so the API response can include the count).
"""

from __future__ import annotations

import datetime
import logging
import re
from typing import TYPE_CHECKING, Any, NamedTuple
from zoneinfo import ZoneInfo

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone

# django-stubs needs a real class for type annotations; get_user_model() returns
# a runtime alias that mypy can't use in a type position. Import the concrete
# User class for typing, keep get_user_model() result for runtime queries.
if TYPE_CHECKING:
    from django.contrib.auth.models import User as UserType
else:
    UserType = get_user_model()

from trueppm_api.apps.access.groups import (
    KNOWN_GROUP_KEYS,
    GroupTooLargeError,
    InvalidGroupKeyError,
    resolve_group_members,
)

from .models import (
    DEFAULT_PREFERENCES,
    PROJECT_NOTIFICATION_DEFAULT_MATRIX,
    Mention,
    MentionScope,
    Notification,
    NotificationChannel,
    NotificationEventType,
    NotificationPreference,
    ProjectNotificationChannel,
    ProjectNotificationEventType,
    ProjectNotificationPreference,
)

if TYPE_CHECKING:
    import uuid
    from collections.abc import Sequence

    from trueppm_api.apps.projects.models import TaskComment

logger = logging.getLogger(__name__)

User = get_user_model()


# ---------------------------------------------------------------------------
# Mention parser
# ---------------------------------------------------------------------------


class ParsedMention(NamedTuple):
    """One extracted @reference. `kind` is 'user' or 'group'."""

    kind: str  # "user" or "group"
    value: str  # username or group key


# Matches @{username-or-groupkey}. Username/key allows letters, digits,
# underscore, hyphen, dot. Min 1 char. Word boundary required after.
# A leading backslash escapes the @ (handled in the loop, not the regex).
_MENTION_RE = re.compile(r"(?P<esc>\\?)@(?P<name>[A-Za-z0-9_.-]+)")

# Stripping strategy: replace fenced code blocks (```...```) and inline code
# (`...`) with same-length placeholders so the regex's character offsets stay
# consistent, then scan for mentions. We don't need to preserve original
# content — only to mask out the regions where @ doesn't mean mention.
_FENCE_RE = re.compile(r"```.*?```", re.DOTALL)
_INLINE_CODE_RE = re.compile(r"`[^`]*`")


def _mask_code_regions(body: str) -> str:
    """Replace code spans with same-length spaces so @-mentions inside don't match."""

    def _spaces(match: re.Match[str]) -> str:
        return " " * (match.end() - match.start())

    body = _FENCE_RE.sub(_spaces, body)
    body = _INLINE_CODE_RE.sub(_spaces, body)
    return body


def parse_mentions(body: str) -> list[ParsedMention]:
    """Extract distinct @mentions from a comment body.

    - `@scrum-team` and other KNOWN_GROUP_KEYS are returned as `kind='group'`
    - Anything else matching the @name pattern is returned as `kind='user'`
    - `\\@name` is treated as escaped — not a mention
    - `@name` inside ``` ``` ``` ``` fences or `single-backtick` code is NOT a mention
    - Duplicates collapsed (one mention per distinct value, first-occurrence order)

    User existence + project-membership check happens in
    `create_mention_notifications`, not in the parser. The parser is pure.
    """
    masked = _mask_code_regions(body)
    seen: set[tuple[str, str]] = set()
    out: list[ParsedMention] = []

    for match in _MENTION_RE.finditer(masked):
        if match.group("esc"):  # escaped: \@name
            continue
        name = match.group("name")
        kind = "group" if name.lower() in KNOWN_GROUP_KEYS else "user"
        key = (kind, name if kind == "user" else name.lower())
        if key in seen:
            continue
        seen.add(key)
        out.append(ParsedMention(kind=kind, value=key[1]))
    return out


# ---------------------------------------------------------------------------
# Rate-limit constants (ADR-0075 locked constraints #8, #9)
# ---------------------------------------------------------------------------

MENTION_DAILY_LIMIT = 1000
MENTION_HOURLY_BURST = 100


# ---------------------------------------------------------------------------
# Notification preference defaults
# ---------------------------------------------------------------------------


def get_or_create_default_preferences(user: UserType) -> list[NotificationPreference]:
    """Backfill NotificationPreference rows for a user using DEFAULT_PREFERENCES.

    Idempotent: existing rows are left alone; only missing (event_type, channel)
    pairs are inserted. Returns the user's full preference set.
    """
    with transaction.atomic():
        existing = {
            (pref.event_type, pref.channel): pref
            for pref in NotificationPreference.objects.filter(user=user)
        }
        to_create = [
            NotificationPreference(
                user=user, event_type=event_type, channel=channel, enabled=enabled
            )
            for event_type, channel, enabled in DEFAULT_PREFERENCES
            if (event_type, channel) not in existing
        ]
        if to_create:
            NotificationPreference.objects.bulk_create(to_create)
        return list(NotificationPreference.objects.filter(user=user))


# ---------------------------------------------------------------------------
# Project-scoped delivery gate (#674)
# ---------------------------------------------------------------------------

# Channels carrying a durable record rather than a transient ping. The in-app
# inbox row *is* the notification — suppressing it during quiet hours would
# lose the mention outright instead of deferring a ping, so quiet hours never
# gate it (the matrix in_app cell still does). Email / Slack / mobile push are
# transient interrupts and ARE silenced inside the window. Mirrors Slack and
# GitHub DND: the record persists; only the interruption is held back.
_QUIET_HOURS_EXEMPT_CHANNELS = frozenset({ProjectNotificationChannel.IN_APP.value})


def _project_timezone(project: Any) -> ZoneInfo:
    """Resolve the tz that a project's quiet-hours window is interpreted in.

    The default ``auth.User`` carries no timezone, so quiet hours anchor to the
    project's IANA timezone (``Project.timezone``, #520), falling back to the
    workspace default (``settings.TIME_ZONE``) and finally UTC. Unparseable tz
    data degrades to UTC rather than raising inside a dispatch path.
    """
    name = (getattr(project, "timezone", "") or "").strip() or settings.TIME_ZONE or "UTC"
    try:
        return ZoneInfo(name)
    except Exception:
        # Bad tz data must never break a dispatch path — degrade to UTC.
        return ZoneInfo("UTC")


def _in_quiet_window(now_local: datetime.time, start: datetime.time, end: datetime.time) -> bool:
    """True if ``now_local`` falls in the half-open ``[start, end)`` window.

    Handles the wrap-past-midnight case (e.g. 22:00–07:00, where ``start > end``).
    A zero-width window (``start == end``) means "no quiet hours".
    """
    if start == end:
        return False
    if start < end:
        return start <= now_local < end
    return now_local >= start or now_local < end


def _matrix_cell(matrix: Any, event_type: str, channel: str) -> bool:
    """Effective on/off for one ``(event_type, channel)`` cell.

    Falls through to ``PROJECT_NOTIFICATION_DEFAULT_MATRIX`` whenever the stored
    matrix omits the event type or channel, so a stale row that predates a newly
    added event still routes correctly. Unknown keys resolve to ``False`` — a
    safe default that also neutralizes any legacy garbage that escaped key
    validation (#675).
    """
    if isinstance(matrix, dict):
        row = matrix.get(event_type)
        if isinstance(row, dict):
            cell = row.get(channel)
            if isinstance(cell, bool):
                return cell
    default_row = PROJECT_NOTIFICATION_DEFAULT_MATRIX.get(event_type, {})
    return bool(default_row.get(channel, False))


def _preference_allows(
    pref: ProjectNotificationPreference,
    *,
    event_type: str,
    channel: str,
    now: datetime.datetime,
    tz: ZoneInfo,
) -> bool:
    """Evaluate the delivery gate against an already-loaded preference row.

    Pure (no DB access) so a fan-out can batch-load every recipient's row in one
    query and evaluate each without an N+1 or a write-amplifying get_or_create.
    An unsaved ``ProjectNotificationPreference()`` carries the model defaults, so
    callers can pass a fresh instance for a recipient who has no row yet.
    """
    # Per-project kill-switch (#589) overrides the matrix entirely.
    if pref.paused:
        return False
    if not _matrix_cell(pref.matrix, event_type, channel):
        return False
    if channel not in _QUIET_HOURS_EXEMPT_CHANNELS and pref.quiet_hours_enabled:
        now_local = now.astimezone(tz).time()
        if _in_quiet_window(now_local, pref.quiet_hours_from, pref.quiet_hours_until):
            return False
    return True


def should_deliver(
    user: Any,
    project: Any,
    event_type: str,
    channel: str,
    *,
    now: datetime.datetime | None = None,
) -> bool:
    """Whether a project-scoped notification should be delivered to ``user``.

    The routing source of truth for project notifications (#674). Loads — and
    lazily creates — the user's :class:`ProjectNotificationPreference` row, then
    applies, in order: the per-project pause kill-switch (#589), the matrix cell
    (defaults overlaid for missing keys), and the quiet-hours window (transient
    channels only — the in-app inbox is always recorded). ``now`` defaults to the
    current time and is injectable for testing.

    Call before sending at any project-scoped dispatch site. For a fan-out to
    many recipients, batch-load rows and reuse :func:`_preference_allows` rather
    than calling this once per recipient.
    """
    if now is None:
        now = timezone.now()
    pref, _ = ProjectNotificationPreference.objects.get_or_create(project=project, user=user)
    return _preference_allows(
        pref, event_type=event_type, channel=channel, now=now, tz=_project_timezone(project)
    )


# ---------------------------------------------------------------------------
# Mention fan-out
# ---------------------------------------------------------------------------


class MentionParseResult(NamedTuple):
    """Result of resolving parsed mentions against project membership."""

    user_targets: list[UserType]
    group_targets: list[tuple[str, list[UserType]]]  # (group_key, members)
    skipped_users: list[str]  # usernames that didn't resolve / not project members
    skipped_groups: list[str]  # group keys that were unknown or too large


def resolve_parsed_mentions(
    parsed: Sequence[ParsedMention],
    project_id: uuid.UUID | str,
    *,
    actor_role: int | None = None,
) -> MentionParseResult:
    """Turn parser output into validated, project-scoped resolution.

    - User mentions are filtered to current project members; non-members go to
      `skipped_users` so the caller can surface a structured 400.
    - Group mentions go through `resolve_group_members`; `@all` requires
      actor_role >= ADMIN (ADR-0075 locked constraint #2). Oversized groups
      land in `skipped_groups` with a structured marker.
    """
    from trueppm_api.apps.access.models import ProjectMembership, Role

    user_targets: list[UserType] = []
    group_targets: list[tuple[str, list[UserType]]] = []
    skipped_users: list[str] = []
    skipped_groups: list[str] = []

    # Resolve usernames in one query
    requested_usernames = [m.value for m in parsed if m.kind == "user"]
    if requested_usernames:
        member_users = list(
            User.objects.filter(
                username__in=requested_usernames,
                pk__in=ProjectMembership.objects.filter(
                    project_id=project_id, is_deleted=False
                ).values_list("user_id", flat=True),
            )
        )
        resolved_by_name = {u.username: u for u in member_users}
        for name in requested_usernames:
            if name in resolved_by_name:
                user_targets.append(resolved_by_name[name])
            else:
                skipped_users.append(name)

    for m in parsed:
        if m.kind != "group":
            continue
        key = m.value
        # @all role gate (ADR-0075 locked constraint #2)
        if key == "all" and (actor_role is None or actor_role < Role.ADMIN):
            skipped_groups.append(key)
            continue
        try:
            member_ids = resolve_group_members(project_id, key)
        except (InvalidGroupKeyError, GroupTooLargeError):
            skipped_groups.append(key)
            continue
        # resolve_group_members annotates its result list[UUID], but the `pk`
        # lookup is typed Iterable[str|int] under django-stubs; stringify so the
        # ids satisfy the lookup type (Django coerces them back to the User pk).
        members = list(User.objects.filter(pk__in=[str(uid) for uid in member_ids]))
        group_targets.append((key, members))

    return MentionParseResult(
        user_targets=user_targets,
        group_targets=group_targets,
        skipped_users=skipped_users,
        skipped_groups=skipped_groups,
    )


def create_mention_notifications(
    *,
    task_comment: TaskComment,
    mentioner: UserType,
    parsed_result: MentionParseResult,
    project_id: uuid.UUID | str,
    scope: MentionScope = MentionScope.PROJECT_VISIBLE,
    now: datetime.datetime | None = None,
) -> int:
    """Create Mention + Notification rows from a parsed comment.

    Returns the number of Notification rows created. Direct mentions and
    group members are deduplicated per-recipient (one user mentioned both
    directly and via @scrum-team gets one Notification, not two).

    Each recipient is gated by their ProjectNotificationPreference for the
    `comment_mention` event (#674): the in-app row is created only if the matrix
    `in_app` cell is on, and `email_pending` is set only if the matrix `email`
    cell is on AND outside quiet hours AND the user's global mention email
    preference is on. `now` is injectable so quiet-hours behavior is testable.

    All writes happen in the caller's transaction — the response can include
    the count immediately. Email delivery is best-effort via `email_pending`
    + the `drain_notification_emails` Beat task (not this function).
    """
    if now is None:
        now = timezone.now()
    mentions: list[Mention] = []

    # Direct user mentions
    for user in parsed_result.user_targets:
        mentions.append(
            Mention(
                mentioner=mentioner,
                mentioned_user=user,
                task_comment=task_comment,
                project_id=project_id,
                scope=scope,
            )
        )

    # Group mentions — store one Mention row per group (preserves "@scrum-team
    # was mentioned" semantics), then fan out per-member Notification rows.
    group_member_index: dict[str, list[UserType]] = {}
    for group_key, members in parsed_result.group_targets:
        mentions.append(
            Mention(
                mentioner=mentioner,
                mentioned_group_key=group_key,
                task_comment=task_comment,
                project_id=project_id,
                scope=scope,
            )
        )
        group_member_index[group_key] = members

    if not mentions:
        return 0

    Mention.objects.bulk_create(mentions)

    # Resolve per-recipient set with dedup. A user mentioned directly AND via
    # a group gets one notification. Pick the direct-mention row as the
    # source so it shows up as "@you" in the UI.
    recipients: dict[int | str, Mention] = {}
    for mention in mentions:
        if mention.mentioned_user_id:
            # Direct mention always wins (overwrites a prior group-source entry)
            recipients[mention.mentioned_user_id] = mention
    for mention in mentions:
        if mention.mentioned_group_key:
            for member in group_member_index[mention.mentioned_group_key]:
                if member.pk == mentioner.pk:
                    continue  # Don't notify yourself
                recipients.setdefault(member.pk, mention)
    # Drop the mentioner from direct mentions too (don't ping yourself)
    recipients.pop(mentioner.pk, None)

    if not recipients:
        return 0

    # Project-scoped routing gate (#674). Batch-load each recipient's project
    # preference once and evaluate the matrix + pause kill-switch + quiet-hours
    # window per recipient without an N+1. A recipient with no row yet evaluates
    # against an unsaved instance carrying the model defaults, so we neither
    # write a row per comment nor lose the defaults overlay. This subsumes the
    # standalone pause check (#589) — _preference_allows returns False for a
    # paused user on every channel.
    from trueppm_api.apps.projects.models import Project

    project = Project.objects.filter(pk=project_id).only("timezone").first()
    project_tz = _project_timezone(project)
    project_prefs: dict[int | str, ProjectNotificationPreference] = {
        proj_pref.user_id: proj_pref
        for proj_pref in ProjectNotificationPreference.objects.filter(
            project_id=project_id, user_id__in=list(recipients.keys())
        )
    }
    event_type_project = ProjectNotificationEventType.COMMENT_MENTION.value

    # Global per-user mention email preference (#311). A comment mention emails
    # only when BOTH the project matrix (comment_mention/email, above) and this
    # global toggle allow it; in-app inbox routing is governed by the project
    # matrix alone.
    global_email: dict[int | str, dict[str, bool]] = {}
    for global_pref in NotificationPreference.objects.filter(
        user_id__in=recipients.keys(), channel=NotificationChannel.EMAIL
    ):
        global_email.setdefault(global_pref.user_id, {})[global_pref.event_type] = (
            global_pref.enabled
        )

    notifications: list[Notification] = []
    for user_id, source_mention in recipients.items():
        pref = project_prefs.get(user_id) or ProjectNotificationPreference()
        # In-app inbox row — matrix-gated only; quiet hours never drop the
        # durable record (see _QUIET_HOURS_EXEMPT_CHANNELS).
        if not _preference_allows(
            pref,
            event_type=event_type_project,
            channel=ProjectNotificationChannel.IN_APP.value,
            now=now,
            tz=project_tz,
        ):
            continue
        global_event = (
            NotificationEventType.MENTION_INDIVIDUAL.value
            if source_mention.mentioned_user_id
            else NotificationEventType.MENTION_GROUP.value
        )
        email_pending = _preference_allows(
            pref,
            event_type=event_type_project,
            channel=ProjectNotificationChannel.EMAIL.value,
            now=now,
            tz=project_tz,
        ) and global_email.get(user_id, {}).get(global_event, False)
        notifications.append(
            Notification(
                recipient_id=user_id,
                mention=source_mention,
                project_id=project_id,
                email_pending=email_pending,
            )
        )
    if not notifications:
        return 0
    Notification.objects.bulk_create(notifications)
    return len(notifications)


def create_event_notifications(
    *,
    event_type: str,
    recipient_ids: Sequence[int | str | None],
    subject: str,
    body: str,
    project_id: uuid.UUID | str,
    task_id: uuid.UUID | str | None = None,
) -> int:
    """Create event-sourced Notification rows for an own-task event (#639).

    Gated by each recipient's **global** ``NotificationPreference`` for
    ``(event_type, channel)`` — the per-user toggles on the User → Settings →
    Notifications page — falling back to ``DEFAULT_PREFERENCES`` for users who
    have never visited that page (no stored rows). Mirrors the mention path's
    coupling (ADR-0085 §4): the in-app inbox row is the durable record, created
    only when ``in_app`` is enabled; ``email_pending`` is set additionally when
    ``email`` is enabled (default OFF — Priya's VoC blocker). A recipient who has
    turned ``in_app`` off for this event opts out of both channels.

    The ``subject``/``body`` are rendered by the caller at dispatch time and
    frozen onto each row, so the drain can send the email without re-deriving it
    from a (possibly later-mutated or deleted) source object.

    Args:
        event_type: A ``NotificationEventType`` value (e.g. ``"task.assigned"``).
        recipient_ids: User PKs to notify; ``None`` and duplicates are dropped,
            so callers may pass the actor without special-casing.
        subject: Pre-rendered email subject line.
        body: Pre-rendered plain-text email body.
        project_id: The project the event occurred on (scopes the inbox row).
        task_id: Optional deep-link target — the task/milestone the inbox row
            should link to (#497/#861). ``None`` for events with no task anchor.

    Returns:
        The number of Notification rows created.
    """
    unique_ids = {rid for rid in recipient_ids if rid is not None}
    if not unique_ids:
        return 0

    defaults = {(et, ch): enabled for et, ch, enabled in DEFAULT_PREFERENCES}
    stored: dict[int | str, dict[str, bool]] = {}
    for pref in NotificationPreference.objects.filter(
        user_id__in=unique_ids, event_type=event_type
    ):
        stored.setdefault(pref.user_id, {})[pref.channel] = pref.enabled

    def _allows(user_id: int | str, channel: str) -> bool:
        per_user = stored.get(user_id, {})
        if channel in per_user:
            return per_user[channel]
        return defaults.get((event_type, channel), False)

    notifications: list[Notification] = []
    for user_id in unique_ids:
        if not _allows(user_id, NotificationChannel.IN_APP.value):
            continue
        notifications.append(
            Notification(
                recipient_id=user_id,
                event_type=event_type,
                subject=subject,
                body=body,
                project_id=project_id,
                task_id=task_id,
                email_pending=_allows(user_id, NotificationChannel.EMAIL.value),
            )
        )
    if not notifications:
        return 0
    Notification.objects.bulk_create(notifications)
    return len(notifications)


# Default per-board stale threshold, mirrored on Project.stale_task_threshold_days
# so a Project that predates the field (or has it cleared) still gets a sane cutoff.
DEFAULT_STALE_TASK_THRESHOLD_DAYS = 7


def _stale_pref_allows(
    stored: dict[Any, dict[str, bool]],
    defaults: dict[tuple[str, str], bool],
    event: str,
    user_id: Any,
    channel: str,
) -> bool:
    """Resolve one (user, channel) delivery decision against stored prefs + defaults.

    A module-level helper (not a closure) so it does not capture the per-project loop
    variables in :func:`create_stale_task_notifications` — same fall-back semantics as
    :func:`create_event_notifications`: stored preference wins, else the default.
    """
    per_user = stored.get(user_id, {})
    if channel in per_user:
        return per_user[channel]
    return defaults.get((event, channel), False)


def create_stale_task_notifications(
    *,
    now: datetime.datetime | None = None,
) -> int:
    """Scan every project for stale non-terminal tasks and nudge their assignees.

    ADR-0199. A task is *stale* when it has sat in its current status for more than
    the owning project's ``stale_task_threshold_days`` (default 7) and that status is
    non-terminal — every ``TaskStatus`` except ``COMPLETE``. Staleness is defined by
    *status column*, not ``percent_complete``: a card in ``REVIEW`` coerces
    ``percent_complete`` to 100 (it is functionally done, pending sign-off) yet is the
    flagship "task I forgot in Review" case, so it must stay in scope. The threshold is
    per-project, so the cutoff is evaluated one project at a time.

    Only the task's **assignee** is notified — an unassigned card has no single owner
    to nudge (those are surfaced by the board-card chip instead). Delivery is gated by
    each assignee's global ``NotificationPreference`` for ``(task.stale, channel)``,
    exactly like :func:`create_event_notifications`, but resolved and written in bulk
    to keep the daily scan off the N+1 path.

    Idempotent: a ``(recipient, task)`` that already has an **unread, un-archived**
    ``task.stale`` notification is skipped, so re-running the scan (retry, manual
    re-queue, or the next daily tick) creates zero duplicates.

    Args:
        now: Injected clock for deterministic testing; defaults to ``timezone.now()``.

    Returns:
        The total number of Notification rows created across all projects.
    """
    from trueppm_api.apps.projects.models import Project, Task, TaskStatus

    now = now or timezone.now()
    event = NotificationEventType.TASK_STALE.value
    defaults = {(et, ch): enabled for et, ch, enabled in DEFAULT_PREFERENCES}
    non_terminal = [s for s in TaskStatus.values if s != TaskStatus.COMPLETE]

    total = 0
    for project in (
        Project.objects.filter(is_deleted=False).only("id", "stale_task_threshold_days").iterator()
    ):
        threshold = project.stale_task_threshold_days or DEFAULT_STALE_TASK_THRESHOLD_DAYS
        cutoff = now - datetime.timedelta(days=threshold)
        candidates = list(
            Task.objects.filter(
                project_id=project.id,
                is_deleted=False,
                status__in=non_terminal,
                status_changed_at__lt=cutoff,
                assignee_id__isnull=False,
            ).values_list("id", "name", "assignee_id")
        )
        if not candidates:
            continue

        task_ids = [row[0] for row in candidates]
        already_notified = set(
            Notification.objects.filter(
                event_type=event,
                is_read=False,
                is_archived=False,
                task_id__in=task_ids,
            ).values_list("recipient_id", "task_id")
        )

        assignee_ids = {row[2] for row in candidates}
        stored: dict[Any, dict[str, bool]] = {}
        for pref in NotificationPreference.objects.filter(
            user_id__in=assignee_ids, event_type=event
        ):
            stored.setdefault(pref.user_id, {})[pref.channel] = pref.enabled

        rows: list[Notification] = []
        for task_id, name, assignee_id in candidates:
            if (assignee_id, task_id) in already_notified:
                continue
            if not _stale_pref_allows(
                stored, defaults, event, assignee_id, NotificationChannel.IN_APP.value
            ):
                continue
            # Task.name is CharField(max_length=512) but Notification.subject is
            # max_length=255. bulk_create bypasses field validation, so an over-long
            # name would raise a Postgres DataError and abort the whole nightly scan
            # (this project and every later one). Truncate the name used in the
            # subject well under the limit, mirroring _sanitize_snippet's bounding.
            display_name = name if len(name) <= 200 else name[:200].rstrip() + "…"
            subject = f'"{display_name}" has gone stale'
            body = (
                f'Your task "{display_name}" has sat in the same status for more than '
                f"{threshold} days. If it is still active, move it forward; "
                f"otherwise update its status so the board reflects reality."
            )
            rows.append(
                Notification(
                    recipient_id=assignee_id,
                    event_type=event,
                    subject=subject,
                    body=body,
                    project_id=project.id,
                    task_id=task_id,
                    email_pending=_stale_pref_allows(
                        stored, defaults, event, assignee_id, NotificationChannel.EMAIL.value
                    ),
                )
            )
        if rows:
            # batch_size caps the INSERT statement size so a pathologically large
            # single-project backlog is chunked rather than one unbounded statement.
            Notification.objects.bulk_create(rows, batch_size=500)
            total += len(rows)
    return total
