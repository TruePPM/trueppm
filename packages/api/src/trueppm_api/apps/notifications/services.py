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

import logging
import re
from typing import TYPE_CHECKING, NamedTuple

from django.contrib.auth import get_user_model
from django.db import transaction

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
    Mention,
    MentionScope,
    Notification,
    NotificationPreference,
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
        members = list(User.objects.filter(pk__in=member_ids))
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
) -> int:
    """Create Mention + Notification rows from a parsed comment.

    Returns the number of Notification rows created. Direct mentions and
    group members are deduplicated per-recipient (one user mentioned both
    directly and via @scrum-team gets one Notification, not two).

    All writes happen in the caller's transaction — the response can include
    the count immediately. Email delivery is best-effort via `email_pending`
    + the `drain_notification_emails` Beat task (not this function).
    """
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

    # Per-project kill-switch (#589). Drop any recipient who has paused all
    # notifications on this project — both the in-app row and the email
    # enqueue. The matrix is preserved so unpausing restores prior routing.
    paused_user_ids = set(
        ProjectNotificationPreference.objects.filter(
            project_id=project_id,
            user_id__in=list(recipients.keys()),
            paused=True,
        ).values_list("user_id", flat=True)
    )
    if paused_user_ids:
        for uid in paused_user_ids:
            recipients.pop(uid, None)
    if not recipients:
        return 0

    # Look up preferences in one query for all recipients
    prefs = NotificationPreference.objects.filter(user_id__in=recipients.keys())
    prefs_by_user: dict[int | str, dict[tuple[str, str], bool]] = {}
    for pref in prefs:
        prefs_by_user.setdefault(pref.user_id, {})[(pref.event_type, pref.channel)] = pref.enabled

    # Default to enabled in-app, disabled email for any user without explicit
    # preferences (matches DEFAULT_PREFERENCES — backfilled lazily here).
    def _email_enabled(user_id: int | str, event_type: str) -> bool:
        per_user = prefs_by_user.get(user_id, {})
        return per_user.get((event_type, "email"), False)

    notifications: list[Notification] = []
    for user_id, source_mention in recipients.items():
        event_type = "mention_individual" if source_mention.mentioned_user_id else "mention_group"
        notifications.append(
            Notification(
                recipient_id=user_id,
                mention=source_mention,
                project_id=project_id,
                email_pending=_email_enabled(user_id, event_type),
            )
        )
    Notification.objects.bulk_create(notifications)
    return len(notifications)
