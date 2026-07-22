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
from django.db.models.functions import Lower
from django.utils import timezone

# django-stubs needs a real class for type annotations; get_user_model() returns
# a runtime alias that mypy can't use in a type position. Import the concrete
# User class for typing, keep get_user_model() result for runtime queries.
if TYPE_CHECKING:
    from django.contrib.auth.models import User as UserType
else:
    UserType = get_user_model()

from trueppm_api.apps.access.groups import (
    ALL_AUTO_GROUP_KEYS,
    GroupTooLargeError,
    InvalidGroupKeyError,
    resolve_group_members,
)

from .models import (
    DEFAULT_PREFERENCES,
    DND_BYPASS_EVENTS,
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
    UserNotificationSettings,
)

if TYPE_CHECKING:
    import uuid
    from collections.abc import Sequence

    from trueppm_api.apps.access.models import ExternalStakeholder
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

    - `@scrum-team`, `@program-pms`, and other auto-group keys (project +
      program scope) are returned as `kind='group'`
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
        kind = "group" if name.lower() in ALL_AUTO_GROUP_KEYS else "user"
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

# Channels account-wide Do-Not-Disturb (UserNotificationSettings.dnd_enabled)
# silences. Same rationale as _QUIET_HOURS_EXEMPT_CHANNELS: the in-app inbox row
# is the durable record and is NEVER silenced — DND holds back the interrupt, not
# the record. The "in_app" string value is shared by NotificationChannel.IN_APP
# and ProjectNotificationChannel.IN_APP, so this exemption is correct on both the
# global event-sourced gate and the project-scoped gate.
_DND_EXEMPT_CHANNELS = frozenset({NotificationChannel.IN_APP.value})


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
    ) and _dnd_allows(user, event_type, channel)


# ---------------------------------------------------------------------------
# Account-wide Do-Not-Disturb gate (#1707, ADR-0292)
# ---------------------------------------------------------------------------


def get_or_create_notification_settings(user: Any) -> UserNotificationSettings:
    """Return the user's account-wide notification settings, creating the row on
    first access.

    Mirrors :func:`get_or_create_default_preferences` — no backfill on user
    create; the absence of a row reads as DND off. This is the authoritative
    accessor used by the read/write endpoint and the single-user delivery gate.
    ``user`` is typed ``Any`` to match the request-context accessors in this
    module (``should_deliver`` / ``_get_or_create_pref``): the ``IsAuthenticated``
    gate on the view guarantees a real ``User`` at runtime.
    """
    settings_row, _ = UserNotificationSettings.objects.get_or_create(user=user)
    return settings_row


def load_dnd_user_ids(user_ids: Any) -> set[Any]:
    """Return the subset of ``user_ids`` that currently have DND enabled.

    One query for a whole fan-out (no N+1, no write-amplifying get_or_create) —
    a user with no settings row is simply absent from the result, which reads as
    DND off. Pair with :func:`_dnd_silences` in a batch dispatch loop.
    """
    return set(
        UserNotificationSettings.objects.filter(user_id__in=user_ids, dnd_enabled=True).values_list(
            "user_id", flat=True
        )
    )


def _dnd_silences(event_type: str, channel: str, *, dnd_enabled: bool) -> bool:
    """Whether account-wide DND holds back this ``(event_type, channel)`` delivery.

    Pure — takes the already-resolved DND flag so a batch fan-out can load the DND
    set once (see :func:`load_dnd_user_ids`) and evaluate each recipient without a
    query. DND silences ONLY transient channels (email/push) and ONLY for events
    outside :data:`DND_BYPASS_EVENTS`; the in-app inbox row (``_DND_EXEMPT_CHANNELS``)
    and the four bypass events always deliver — the safety contract is one
    frozenset checked at one gate, so it cannot drift or swallow a blocker.
    """
    if not dnd_enabled:
        return False
    if channel in _DND_EXEMPT_CHANNELS:
        return False
    # A non-exempt (transient) channel under DND: silence it unless the event is
    # on the always-through safety list.
    return event_type not in DND_BYPASS_EVENTS


def _dnd_allows(user: Any, event_type: str, channel: str) -> bool:
    """Single-user DND gate for :func:`should_deliver`.

    Resolves (and lazily creates) the caller's settings row, then delegates to the
    pure :func:`_dnd_silences` predicate. For a fan-out to many recipients, use
    :func:`load_dnd_user_ids` + :func:`_dnd_silences` instead of calling this per
    recipient.
    """
    settings_row = get_or_create_notification_settings(user)
    return not _dnd_silences(event_type, channel, dnd_enabled=settings_row.dnd_enabled)


# ---------------------------------------------------------------------------
# Mention fan-out
# ---------------------------------------------------------------------------


class MentionParseResult(NamedTuple):
    """Result of resolving parsed mentions against project membership."""

    user_targets: list[UserType]
    group_targets: list[tuple[str, list[UserType]]]  # (group_key, members)
    skipped_users: list[str]  # usernames that didn't resolve / not project members
    skipped_groups: list[str]  # group keys that were unknown or too large
    # Non-account external stakeholders reached by a resolved @program-stakeholders
    # mention (#1658, ADR-0264). Additive and SEPARATE from group_targets — these
    # rows have no User, so create_mention_notifications never writes Mention /
    # Notification rows for them and no email is sent (delivery deferred to #1675).
    # Default is a shared empty list, only ever read, never mutated in place — the
    # NamedTuple is immutable and every producer builds a fresh list (RUF012 flags
    # the mutable default, but the shared-mutation footgun does not apply here).
    external_targets: list[ExternalStakeholder] = []  # noqa: RUF012


def _load_project_udg_members(
    project_id: uuid.UUID | str, names_lower: list[str]
) -> dict[str, list[UserType]]:
    """Project-scoped user-defined mention groups (ADR-0212), keyed by lowercased name.

    Members are snapshotted at write time and filtered to those still on the project.
    """
    from trueppm_api.apps.access.models import ProjectMembership, UserDefinedMentionGroup

    active_member_ids = set(
        ProjectMembership.objects.filter(project_id=project_id, is_deleted=False).values_list(
            "user_id", flat=True
        )
    )
    resolved: dict[str, list[UserType]] = {}
    udg_groups = (
        UserDefinedMentionGroup.objects.annotate(name_lower=Lower("name"))
        .filter(project_id=project_id, name_lower__in=names_lower, is_deleted=False)
        .prefetch_related("members")
    )
    for group in udg_groups:
        resolved[group.name.lower()] = [
            member for member in group.members.all() if member.pk in active_member_ids
        ]
    return resolved


def _load_program_udg_members(
    project_id: uuid.UUID | str, names_lower: list[str]
) -> dict[str, list[UserType]]:
    """Program-scoped user-defined mention groups (ADR-0248, #516), keyed by lowercased name.

    Returns empty for a standalone project (no program). Members are filtered to those
    still on any project in the program.
    """
    from trueppm_api.apps.access.models import (
        ProgramUserDefinedMentionGroup,
        ProjectMembership,
    )
    from trueppm_api.apps.projects.models import Project

    program_id = Project.objects.filter(pk=project_id).values_list("program_id", flat=True).first()
    if program_id is None:
        return {}
    program_member_ids = set(
        ProjectMembership.objects.filter(
            project__program_id=program_id,
            project__is_deleted=False,
            is_deleted=False,
        ).values_list("user_id", flat=True)
    )
    resolved: dict[str, list[UserType]] = {}
    pudg_groups = (
        ProgramUserDefinedMentionGroup.objects.annotate(name_lower=Lower("name"))
        .filter(program_id=program_id, name_lower__in=names_lower, is_deleted=False)
        .prefetch_related("members")
    )
    for pgroup in pudg_groups:
        resolved[pgroup.name.lower()] = [
            member for member in pgroup.members.all() if member.pk in program_member_ids
        ]
    return resolved


def _resolve_udg_groups_by_lower(
    project_id: uuid.UUID | str, unresolved: list[str]
) -> dict[str, list[UserType]]:
    """Reinterpret non-member @names as user-defined groups (ADR-0212, ADR-0248).

    Batch-resolved in one query set per scope (not per-token) to keep the synchronous
    comment-create path off the N+1. Precedence is member → project group → program
    group: a project group shadows a same-named program group, so only names still
    unresolved after the project step fall through to the program step.
    """
    groups_by_lower = _load_project_udg_members(project_id, [name.lower() for name in unresolved])
    still_unresolved = [name for name in unresolved if name.lower() not in groups_by_lower]
    if still_unresolved:
        program_groups = _load_program_udg_members(
            project_id, [name.lower() for name in still_unresolved]
        )
        for key, members in program_groups.items():
            groups_by_lower[key] = members
    return groups_by_lower


def _resolve_user_mentions(
    parsed: Sequence[ParsedMention], project_id: uuid.UUID | str
) -> tuple[list[UserType], list[tuple[str, list[UserType]]], list[str]]:
    """Resolve @user tokens to project members, user-defined groups, or skipped names.

    A real project member always wins on an exact name collision; a non-member name is
    promoted to a user-defined group target when one exists (see
    :func:`_resolve_udg_groups_by_lower`), else recorded in ``skipped_users``.
    """
    from trueppm_api.apps.access.models import ProjectMembership

    user_targets: list[UserType] = []
    group_targets: list[tuple[str, list[UserType]]] = []
    skipped_users: list[str] = []

    requested_usernames = [m.value for m in parsed if m.kind == "user"]
    if not requested_usernames:
        return user_targets, group_targets, skipped_users

    member_users = list(
        User.objects.filter(
            username__in=requested_usernames,
            pk__in=ProjectMembership.objects.filter(
                project_id=project_id, is_deleted=False
            ).values_list("user_id", flat=True),
        )
    )
    resolved_by_name = {u.username: u for u in member_users}
    unresolved = [name for name in requested_usernames if name not in resolved_by_name]
    groups_by_lower = _resolve_udg_groups_by_lower(project_id, unresolved) if unresolved else {}
    for name in requested_usernames:
        if name in resolved_by_name:
            user_targets.append(resolved_by_name[name])
        elif name.lower() in groups_by_lower:
            group_targets.append((name.lower(), groups_by_lower[name.lower()]))
        else:
            skipped_users.append(name)
    return user_targets, group_targets, skipped_users


def _resolve_group_mentions(
    parsed: Sequence[ParsedMention],
    project_id: uuid.UUID | str,
    actor_role: int | None,
) -> tuple[list[tuple[str, list[UserType]]], list[str]]:
    """Resolve @group tokens via ``resolve_group_members``.

    ``@all`` / ``@program-all`` are unbounded fan-outs and require actor_role >= ADMIN
    (ADR-0075 locked constraint #2); unknown or oversized groups land in
    ``skipped_groups`` with a structured marker.
    """
    from trueppm_api.apps.access.models import Role

    group_targets: list[tuple[str, list[UserType]]] = []
    skipped_groups: list[str] = []
    for m in parsed:
        if m.kind != "group":
            continue
        key = m.value
        if key in ("all", "program-all") and (actor_role is None or actor_role < Role.ADMIN):
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
    return group_targets, skipped_groups


def resolve_parsed_mentions(
    parsed: Sequence[ParsedMention],
    project_id: uuid.UUID | str,
    *,
    actor_role: int | None = None,
) -> MentionParseResult:
    """Turn parser output into validated, project-scoped resolution.

    - User mentions are filtered to current project members; non-members go to
      `skipped_users` so the caller can surface a structured 400.
    - A `@name` that resolves to neither a member nor an auto-group key
      is reinterpreted as a **user-defined group** (ADR-0212, #515):
      the parser is pure and cannot know a name is a group, so this project-aware
      step promotes it to a group target when a live
      `UserDefinedMentionGroup` with that name exists in the project. A real
      member always wins on an exact name collision.
    - Group mentions go through `resolve_group_members`; `@all` and
      `@program-all` require actor_role >= ADMIN (ADR-0075 locked constraint
      #2). Oversized groups land in `skipped_groups` with a structured marker.
    """
    user_targets, user_group_targets, skipped_users = _resolve_user_mentions(parsed, project_id)
    auto_group_targets, skipped_groups = _resolve_group_mentions(parsed, project_id, actor_role)
    # User-token-resolved groups precede auto-groups, preserving the original
    # single-list append order (user block first, then the @group loop).
    group_targets = user_group_targets + auto_group_targets

    # External stakeholders (#1658, ADR-0264) are the non-account arm of a resolved
    # @program-stakeholders mention. Resolve them ONLY when that group actually
    # resolved (it is present in group_targets — a standalone project skips it), and
    # keep them on a distinct field: they have no User account, so they are never
    # unioned into the User-keyed group_targets and never produce Notification rows.
    external_targets: list[ExternalStakeholder] = []
    if any(group_key == "program-stakeholders" for group_key, _ in group_targets):
        from trueppm_api.apps.access.groups import resolve_external_stakeholders

        external_targets = resolve_external_stakeholders(project_id)

    return MentionParseResult(
        user_targets=user_targets,
        group_targets=group_targets,
        skipped_users=skipped_users,
        skipped_groups=skipped_groups,
        external_targets=external_targets,
    )


def _build_mention_rows(
    *,
    task_comment: TaskComment,
    mentioner: UserType,
    parsed_result: MentionParseResult,
    project_id: uuid.UUID | str,
    scope: MentionScope,
) -> tuple[list[Mention], dict[str, list[UserType]]]:
    """Build the unsaved Mention rows and the per-group member index.

    One Mention row per direct user, then one per group (preserving "@scrum-team was
    mentioned" semantics); the returned index maps each group key to its members for
    the later per-member fan-out. Order matches the original append sequence: direct
    user mentions first, group mentions second.
    """
    mentions: list[Mention] = []
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
    return mentions, group_member_index


def _load_udg_email_settings(
    project_id: uuid.UUID | str, mentioned_group_keys: list[str]
) -> tuple[dict[str, bool], set[tuple[int | str, str]]]:
    """Load per-group email defaults and mute sets for mentioned user-defined groups.

    User-defined group routing (ADR-0212 §5). Auto-group keys (@admins, @scrum-team, …)
    simply don't match and keep their existing global-toggle behavior. The returned
    ``udg_email_default`` maps a lowercased group name to its manager-set email default;
    ``udg_mutes`` is the set of ``(user_id, group_name)`` pairs whose owner muted that
    group. Keys in ``mentioned_group_keys`` are lowercased (see resolve_parsed_mentions),
    so match on ``Lower(name)`` — group names are case-insensitive mention keys even
    though the display name preserves the manager's casing.

    Program-scoped user-defined groups (ADR-0248, #516) load first so a same-named
    project group overwrites the email default (project wins, matching the resolution
    precedence). Mutes union across scopes — a member who muted either same-named group
    is defensively suppressed (a negligible, documented name-collision case).
    """
    udg_email_default: dict[str, bool] = {}
    udg_mutes: set[tuple[int | str, str]] = set()
    if not mentioned_group_keys:
        return udg_email_default, udg_mutes

    from trueppm_api.apps.access.models import (
        ProgramUserDefinedMentionGroup,
        UserDefinedMentionGroup,
    )
    from trueppm_api.apps.projects.models import Project

    program_id = Project.objects.filter(pk=project_id).values_list("program_id", flat=True).first()
    if program_id is not None:
        pudg_groups = (
            ProgramUserDefinedMentionGroup.objects.annotate(name_lower=Lower("name"))
            .filter(program_id=program_id, name_lower__in=mentioned_group_keys, is_deleted=False)
            .prefetch_related("muted_by")
        )
        for pgroup in pudg_groups:
            key = pgroup.name.lower()
            udg_email_default[key] = pgroup.email_default_on
            for muter in pgroup.muted_by.all():
                udg_mutes.add((muter.pk, key))
    udg_groups = (
        UserDefinedMentionGroup.objects.annotate(name_lower=Lower("name"))
        .filter(project_id=project_id, name_lower__in=mentioned_group_keys, is_deleted=False)
        .prefetch_related("muted_by")
    )
    for group in udg_groups:
        key = group.name.lower()
        udg_email_default[key] = group.email_default_on
        for muter in group.muted_by.all():
            udg_mutes.add((muter.pk, key))
    return udg_email_default, udg_mutes


def _add_group_recipients(
    recipients: dict[int | str, Mention],
    group_mention: Mention,
    members: list[UserType],
    udg_mutes: set[tuple[int | str, str]],
    mentioner_pk: int | str,
) -> None:
    """Fan a group mention out to its members, mutating ``recipients`` in place.

    Skips the mentioner (don't ping yourself) and any member who muted THIS
    user-defined group (ADR-0212); ``setdefault`` means a member already claimed by a
    direct @mention or an earlier un-muted group is left untouched.
    """
    group_key = group_mention.mentioned_group_key
    for member in members:
        if member.pk == mentioner_pk:
            continue
        if (member.pk, group_key) in udg_mutes:
            continue
        recipients.setdefault(member.pk, group_mention)


def _resolve_mention_recipients(
    mentions: list[Mention],
    group_member_index: dict[str, list[UserType]],
    udg_mutes: set[tuple[int | str, str]],
    mentioner: UserType,
) -> dict[int | str, Mention]:
    """Dedup mentions to one source Mention per recipient.

    A user mentioned directly AND via a group gets one notification; the direct-mention
    row wins (overwriting a prior group-source entry) so the UI shows "@you". Per-group
    mutes (ADR-0212) drop a member for the muting group only — they may still be added
    by a different, un-muted group. The mentioner is never notified.
    """
    recipients: dict[int | str, Mention] = {}
    for mention in mentions:
        if mention.mentioned_user_id:
            recipients[mention.mentioned_user_id] = mention
    for mention in mentions:
        if mention.mentioned_group_key:
            _add_group_recipients(
                recipients,
                mention,
                group_member_index[mention.mentioned_group_key],
                udg_mutes,
                mentioner.pk,
            )
    # Drop the mentioner from direct mentions too (don't ping yourself)
    recipients.pop(mentioner.pk, None)
    return recipients


class _MentionRoutingContext(NamedTuple):
    """Batch-loaded, per-fan-out routing state for mention notification delivery."""

    project_tz: ZoneInfo
    project_prefs: dict[int | str, ProjectNotificationPreference]
    global_email: dict[int | str, dict[str, bool]]
    source_project_member_ids: set[Any]
    dnd_user_ids: set[Any]


def _load_mention_routing_context(
    project_id: uuid.UUID | str, recipient_ids: list[int | str]
) -> _MentionRoutingContext:
    """Batch-load the per-recipient routing state in a fixed number of queries.

    - Project timezone + each recipient's ProjectNotificationPreference row (#674):
      evaluated per recipient without an N+1; a recipient with no row evaluates against
      an unsaved instance carrying the model defaults (subsumes the #589 pause check).
    - Global per-user mention email preference (#311): a mention emails only when BOTH
      the project matrix and this global toggle allow it.
    - Source-project membership set (cross-project email read boundary, ADR-0248 §5 /
      ADR-0240 §5): the email render path embeds the raw comment body, so email is
      suppressed for any recipient not a current member of the source project; they
      still get the redacted in-app row.
    - Account-wide DND set (#1707): a mention is not a bypass event, so DND silences its
      email while the durable in-app inbox row still lands.
    """
    from trueppm_api.apps.access.models import ProjectMembership
    from trueppm_api.apps.projects.models import Project

    project = Project.objects.filter(pk=project_id).only("timezone").first()
    project_tz = _project_timezone(project)
    project_prefs: dict[int | str, ProjectNotificationPreference] = {
        proj_pref.user_id: proj_pref
        for proj_pref in ProjectNotificationPreference.objects.filter(
            project_id=project_id, user_id__in=recipient_ids
        )
    }
    global_email: dict[int | str, dict[str, bool]] = {}
    for global_pref in NotificationPreference.objects.filter(
        user_id__in=recipient_ids, channel=NotificationChannel.EMAIL
    ):
        global_email.setdefault(global_pref.user_id, {})[global_pref.event_type] = (
            global_pref.enabled
        )
    source_project_member_ids = set(
        ProjectMembership.objects.filter(
            project_id=project_id, is_deleted=False, user_id__in=recipient_ids
        ).values_list("user_id", flat=True)
    )
    dnd_user_ids = load_dnd_user_ids(recipient_ids)
    return _MentionRoutingContext(
        project_tz=project_tz,
        project_prefs=project_prefs,
        global_email=global_email,
        source_project_member_ids=source_project_member_ids,
        dnd_user_ids=dnd_user_ids,
    )


def _build_mention_notification(
    *,
    user_id: int | str,
    source_mention: Mention,
    context: _MentionRoutingContext,
    udg_email_default: dict[str, bool],
    project_id: uuid.UUID | str,
    now: datetime.datetime,
) -> Notification | None:
    """Build one recipient's Notification row, or None if the in-app gate blocks it.

    The in-app inbox row is matrix-gated only; quiet hours never drop the durable record
    (see _QUIET_HOURS_EXEMPT_CHANNELS). The email gate layers the project matrix
    (comment_mention/email) + quiet hours with the per-source opt-in:
      - user-defined group (ADR-0212 §5): the group manager's per-group email default is
        the self-contained opt-in — a mute already removed the recipient from the in-app
        gate above, so reaching here means un-muted; email follows the group default.
      - direct mention / auto-group: the existing global per-user toggle (#311) —
        MENTION_INDIVIDUAL / MENTION_GROUP — governs, default OFF.
    then the cross-project read boundary and account-wide DND (#1707).
    """
    event_type_project = ProjectNotificationEventType.COMMENT_MENTION.value
    pref = context.project_prefs.get(user_id) or ProjectNotificationPreference()
    if not _preference_allows(
        pref,
        event_type=event_type_project,
        channel=ProjectNotificationChannel.IN_APP.value,
        now=now,
        tz=context.project_tz,
    ):
        return None
    global_event = (
        NotificationEventType.MENTION_INDIVIDUAL.value
        if source_mention.mentioned_user_id
        else NotificationEventType.MENTION_GROUP.value
    )
    source_group_key = source_mention.mentioned_group_key
    if source_group_key and source_group_key in udg_email_default:
        per_user_opt_in = udg_email_default[source_group_key]
    else:
        per_user_opt_in = context.global_email.get(user_id, {}).get(global_event, False)
    email_pending = (
        _preference_allows(
            pref,
            event_type=event_type_project,
            channel=ProjectNotificationChannel.EMAIL.value,
            now=now,
            tz=context.project_tz,
        )
        and per_user_opt_in
        and user_id in context.source_project_member_ids
        and not _dnd_silences(
            global_event,
            ProjectNotificationChannel.EMAIL.value,
            dnd_enabled=user_id in context.dnd_user_ids,
        )
    )
    return Notification(
        recipient_id=user_id,
        mention=source_mention,
        project_id=project_id,
        email_pending=email_pending,
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

    mentions, group_member_index = _build_mention_rows(
        task_comment=task_comment,
        mentioner=mentioner,
        parsed_result=parsed_result,
        project_id=project_id,
        scope=scope,
    )
    udg_email_default, udg_mutes = _load_udg_email_settings(
        project_id, list(group_member_index.keys())
    )

    if not mentions:
        return 0

    Mention.objects.bulk_create(mentions)

    recipients = _resolve_mention_recipients(mentions, group_member_index, udg_mutes, mentioner)
    if not recipients:
        return 0

    context = _load_mention_routing_context(project_id, list(recipients.keys()))

    notifications: list[Notification] = []
    for user_id, source_mention in recipients.items():
        notification = _build_mention_notification(
            user_id=user_id,
            source_mention=source_mention,
            context=context,
            udg_email_default=udg_email_default,
            project_id=project_id,
            now=now,
        )
        if notification is not None:
            notifications.append(notification)
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

    # Account-wide DND (#1707) silences email for non-bypass events. Loaded once
    # over the recipient set; the in-app inbox row below is never gated by DND.
    dnd_user_ids = load_dnd_user_ids(unique_ids)

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
                email_pending=_allows(user_id, NotificationChannel.EMAIL.value)
                and not _dnd_silences(
                    event_type,
                    NotificationChannel.EMAIL.value,
                    dnd_enabled=user_id in dnd_user_ids,
                ),
            )
        )
    if not notifications:
        return 0
    Notification.objects.bulk_create(notifications)
    return len(notifications)


def create_event_notifications_batch(
    *,
    event_type: str,
    project_id: uuid.UUID | str,
    rows: Sequence[tuple[int | str | None, str, str, uuid.UUID | str | None]],
) -> int:
    """Create per-recipient event Notification rows for a batch of
    ``(recipient_id, subject, body, task_id)`` tuples in ONE preference lookup
    and one ``bulk_create``.

    Same gating as ``create_event_notifications`` — each row is written only when
    the recipient's ``NotificationPreference`` (falling back to
    ``DEFAULT_PREFERENCES``) enables ``in_app`` for ``event_type``, and
    ``email_pending`` is set when ``email`` is enabled. Use this instead of
    calling ``create_event_notifications`` in a loop when one event fans out to
    many recipients with a *different* per-row subject/body/deep-link (e.g.
    sprint-close carryover, ADR-0232 #1470): a loop would issue one preference
    query and one insert *per row* — and repeat the identical query for a
    recipient who appears more than once — whereas this collapses to a single
    ``NotificationPreference`` query over the unique recipient set plus one
    ``bulk_create``.

    Args:
        event_type: A ``NotificationEventType`` value.
        project_id: The project the event occurred on (scopes every row).
        rows: ``(recipient_id, subject, body, task_id)`` tuples. ``None``
            recipients are skipped; ``task_id`` may be ``None`` for a row with no
            single task anchor (e.g. a multi-task summary).

    Returns:
        The number of Notification rows created.
    """
    unique_ids = {row[0] for row in rows if row[0] is not None}
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

    # Account-wide DND (#1707) silences email for non-bypass events. Loaded once
    # over the recipient set; the in-app inbox row below is never gated by DND.
    dnd_user_ids = load_dnd_user_ids(unique_ids)

    notifications: list[Notification] = []
    for recipient_id, subject, body, task_id in rows:
        if recipient_id is None or not _allows(recipient_id, NotificationChannel.IN_APP.value):
            continue
        notifications.append(
            Notification(
                recipient_id=recipient_id,
                event_type=event_type,
                subject=subject,
                body=body,
                project_id=project_id,
                task_id=task_id,
                email_pending=_allows(recipient_id, NotificationChannel.EMAIL.value)
                and not _dnd_silences(
                    event_type,
                    NotificationChannel.EMAIL.value,
                    dnd_enabled=recipient_id in dnd_user_ids,
                ),
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

    ADR-0200. A task is *stale* when it has sat in its current status for more than
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
        # Account-wide DND (#1707): task.stale is not a bypass event, so DND
        # suppresses its email nudge while the durable in-app row still lands.
        dnd_user_ids = load_dnd_user_ids(assignee_ids)

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
                    )
                    and not _dnd_silences(
                        event,
                        NotificationChannel.EMAIL.value,
                        dnd_enabled=assignee_id in dnd_user_ids,
                    ),
                )
            )
        if rows:
            # batch_size caps the INSERT statement size so a pathologically large
            # single-project backlog is chunked rather than one unbounded statement.
            Notification.objects.bulk_create(rows, batch_size=500)
            total += len(rows)
    return total
