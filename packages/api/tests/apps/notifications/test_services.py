"""Tests for notifications services — mention parser + fan-out + defaults."""

from __future__ import annotations

from datetime import UTC, date, datetime, time
from typing import Any

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.notifications.models import (
    DEFAULT_PREFERENCES,
    Mention,
    Notification,
    NotificationChannel,
    NotificationEventType,
    NotificationPreference,
    ProjectNotificationChannel,
    ProjectNotificationEventType,
    ProjectNotificationPreference,
)
from trueppm_api.apps.notifications.services import (
    QUIET_HOURS_TZ_SOURCE_FALLBACK,
    QUIET_HOURS_TZ_SOURCE_PROJECT,
    QUIET_HOURS_TZ_SOURCE_SERVER,
    QUIET_HOURS_TZ_SOURCE_WORKSPACE,
    ParsedMention,
    create_mention_notifications,
    get_or_create_default_preferences,
    parse_mentions,
    resolve_parsed_mentions,
    resolve_quiet_hours_timezone,
    should_deliver,
)
from trueppm_api.apps.projects.models import Calendar, Project, Task, TaskComment

# A fixed "now" comfortably outside the default 20:00–07:00 quiet-hours window,
# so fan-out email assertions don't depend on wall-clock time.
NOON_UTC = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
# Inside the default overnight quiet window (20:00–07:00).
MIDNIGHT_UTC = datetime(2026, 1, 1, 0, 30, tzinfo=UTC)

User = get_user_model()


# ---------------------------------------------------------------------------
# parse_mentions — pure-function parser
# ---------------------------------------------------------------------------


class TestParseMentions:
    def test_extracts_direct_user_mention(self) -> None:
        result = parse_mentions("hey @alice take a look")
        assert result == [ParsedMention("user", "alice")]

    def test_extracts_group_mention(self) -> None:
        result = parse_mentions("ping @scrum-team")
        assert result == [ParsedMention("group", "scrum-team")]

    def test_group_match_is_case_insensitive(self) -> None:
        result = parse_mentions("ping @All")
        assert result == [ParsedMention("group", "all")]

    def test_deduplicates_repeats(self) -> None:
        result = parse_mentions("@alice please @alice")
        assert result == [ParsedMention("user", "alice")]

    def test_preserves_first_occurrence_order(self) -> None:
        result = parse_mentions("@bob @alice @scrum-team")
        assert [m.value for m in result] == ["bob", "alice", "scrum-team"]

    def test_escaped_at_is_not_a_mention(self) -> None:
        result = parse_mentions(r"contact us at \@support")
        assert result == []

    def test_at_inside_inline_code_ignored(self) -> None:
        result = parse_mentions("use `@token` to auth")
        assert result == []

    def test_at_inside_fenced_code_ignored(self) -> None:
        body = "```\n@scrum-team is just a string here\n```"
        assert parse_mentions(body) == []

    def test_mention_outside_fence_still_matched(self) -> None:
        body = "real mention: @alice\n```\nignored: @bob\n```"
        result = parse_mentions(body)
        assert ParsedMention("user", "alice") in result
        assert ParsedMention("user", "bob") not in result

    def test_dotted_username_allowed(self) -> None:
        # email-like syntax — '@alice.smith' should parse as user 'alice.smith'
        result = parse_mentions("@alice.smith hi")
        assert result == [ParsedMention("user", "alice.smith")]

    def test_no_mentions_returns_empty(self) -> None:
        assert parse_mentions("nothing to see here") == []


# ---------------------------------------------------------------------------
# Fixtures for resolver + fan-out tests
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def author(db: object) -> object:
    return User.objects.create_user(username="author", password="pw")


@pytest.fixture
def alice(db: object) -> object:
    return User.objects.create_user(username="alice", password="pw")


@pytest.fixture
def bob(db: object) -> object:
    return User.objects.create_user(username="bob", password="pw")


@pytest.fixture
def memberships(
    project: Project, author: object, alice: object, bob: object
) -> dict[str, ProjectMembership]:
    return {
        "author": ProjectMembership.objects.create(project=project, user=author, role=Role.ADMIN),
        "alice": ProjectMembership.objects.create(project=project, user=alice, role=Role.MEMBER),
        "bob": ProjectMembership.objects.create(project=project, user=bob, role=Role.MEMBER),
    }


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="T", duration=1)


@pytest.fixture
def comment(task: Task, author: object) -> TaskComment:
    return TaskComment.objects.create(task=task, author=author, body="body")


# ---------------------------------------------------------------------------
# resolve_parsed_mentions
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestResolveParsedMentions:
    def test_resolves_known_user(
        self,
        project: Project,
        alice: object,
        bob: object,
        memberships: dict[str, ProjectMembership],
    ) -> None:
        parsed = [ParsedMention("user", "alice")]
        result = resolve_parsed_mentions(parsed, project.pk)
        assert [u.pk for u in result.user_targets] == [alice.pk]  # type: ignore[attr-defined]
        assert result.skipped_users == []

    def test_unknown_username_is_skipped(
        self, project: Project, memberships: dict[str, ProjectMembership]
    ) -> None:
        result = resolve_parsed_mentions([ParsedMention("user", "ghost")], project.pk)
        assert result.user_targets == []
        assert result.skipped_users == ["ghost"]

    def test_non_member_username_is_skipped(
        self, project: Project, memberships: dict[str, ProjectMembership]
    ) -> None:
        User.objects.create_user(username="outsider", password="pw")  # exists, not a member
        result = resolve_parsed_mentions([ParsedMention("user", "outsider")], project.pk)
        assert result.skipped_users == ["outsider"]

    def test_known_group_resolves(
        self,
        project: Project,
        alice: object,
        bob: object,
        memberships: dict[str, ProjectMembership],
    ) -> None:
        result = resolve_parsed_mentions(
            [ParsedMention("group", "members")], project.pk, actor_role=Role.MEMBER
        )
        assert len(result.group_targets) == 1
        key, members = result.group_targets[0]
        assert key == "members"
        assert {u.pk for u in members} >= {alice.pk, bob.pk}  # type: ignore[attr-defined]

    def test_at_all_requires_admin(
        self,
        project: Project,
        memberships: dict[str, ProjectMembership],
    ) -> None:
        """@all is skipped if actor is below ADMIN (ADR-0075 locked constraint #2)."""
        result = resolve_parsed_mentions(
            [ParsedMention("group", "all")], project.pk, actor_role=Role.MEMBER
        )
        assert result.group_targets == []
        assert result.skipped_groups == ["all"]

    def test_at_all_allowed_for_admin(
        self,
        project: Project,
        memberships: dict[str, ProjectMembership],
    ) -> None:
        result = resolve_parsed_mentions(
            [ParsedMention("group", "all")], project.pk, actor_role=Role.ADMIN
        )
        assert len(result.group_targets) == 1
        assert result.skipped_groups == []

    def test_invalid_group_key_skipped(
        self, project: Project, memberships: dict[str, ProjectMembership]
    ) -> None:
        # The parser would normally not produce an unknown group, but the
        # resolver still defends against it via InvalidGroupKeyError.
        result = resolve_parsed_mentions(
            [ParsedMention("group", "bogus")], project.pk, actor_role=Role.ADMIN
        )
        assert result.skipped_groups == ["bogus"]


# ---------------------------------------------------------------------------
# create_mention_notifications — fan-out behavior
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestCreateMentionNotifications:
    def test_direct_mention_creates_one_notification(
        self,
        project: Project,
        author: object,
        alice: object,
        comment: TaskComment,
        memberships: dict[str, ProjectMembership],
    ) -> None:
        resolved = resolve_parsed_mentions(
            [ParsedMention("user", "alice")], project.pk, actor_role=Role.ADMIN
        )
        created = create_mention_notifications(
            task_comment=comment,
            mentioner=author,
            parsed_result=resolved,
            project_id=project.pk,
        )
        assert created == 1
        n = Notification.objects.get(recipient=alice)
        assert n.mention is not None
        assert n.mention.mentioned_user_id == alice.pk  # type: ignore[attr-defined]
        # Email_pending follows default preferences (email default OFF)
        assert n.email_pending is False

    def test_self_mention_does_not_notify(
        self,
        project: Project,
        author: object,
        comment: TaskComment,
        memberships: dict[str, ProjectMembership],
    ) -> None:
        resolved = resolve_parsed_mentions(
            [ParsedMention("user", "author")], project.pk, actor_role=Role.ADMIN
        )
        created = create_mention_notifications(
            task_comment=comment,
            mentioner=author,
            parsed_result=resolved,
            project_id=project.pk,
        )
        assert created == 0
        assert Notification.objects.count() == 0
        # The Mention row exists for audit even when no Notification fires.
        assert Mention.objects.filter(mentioned_user=author).count() == 1

    def test_group_fan_out_excludes_mentioner(
        self,
        project: Project,
        author: object,
        alice: object,
        bob: object,
        comment: TaskComment,
        memberships: dict[str, ProjectMembership],
    ) -> None:
        resolved = resolve_parsed_mentions(
            [ParsedMention("group", "members")], project.pk, actor_role=Role.ADMIN
        )
        created = create_mention_notifications(
            task_comment=comment,
            mentioner=author,
            parsed_result=resolved,
            project_id=project.pk,
        )
        # 'members' resolves to alice + bob; author is in band but excluded as self.
        recipient_ids = set(Notification.objects.values_list("recipient_id", flat=True))
        assert author.pk not in recipient_ids  # type: ignore[attr-defined]
        assert {alice.pk, bob.pk} <= recipient_ids  # type: ignore[attr-defined]
        assert created == len(recipient_ids)

    def test_direct_plus_group_dedupes_per_recipient(
        self,
        project: Project,
        author: object,
        alice: object,
        bob: object,
        comment: TaskComment,
        memberships: dict[str, ProjectMembership],
    ) -> None:
        """Alice gets one Notification even when both directly and group-mentioned."""
        resolved = resolve_parsed_mentions(
            [ParsedMention("user", "alice"), ParsedMention("group", "members")],
            project.pk,
            actor_role=Role.ADMIN,
        )
        create_mention_notifications(
            task_comment=comment,
            mentioner=author,
            parsed_result=resolved,
            project_id=project.pk,
        )
        assert Notification.objects.filter(recipient=alice).count() == 1
        # And the source Mention for alice is the direct one (not the group)
        alice_notif = Notification.objects.get(recipient=alice)
        assert alice_notif.mention is not None
        assert alice_notif.mention.mentioned_user_id == alice.pk  # type: ignore[attr-defined]

    def test_paused_recipient_is_skipped(
        self,
        project: Project,
        author: object,
        alice: object,
        bob: object,
        comment: TaskComment,
        memberships: dict[str, ProjectMembership],
    ) -> None:
        """A user with paused=True on this project gets no Notification row (#589)."""
        from trueppm_api.apps.notifications.models import ProjectNotificationPreference

        ProjectNotificationPreference.objects.create(project=project, user=alice, paused=True)
        resolved = resolve_parsed_mentions(
            [ParsedMention("user", "alice"), ParsedMention("user", "bob")],
            project.pk,
            actor_role=Role.ADMIN,
        )
        created = create_mention_notifications(
            task_comment=comment,
            mentioner=author,
            parsed_result=resolved,
            project_id=project.pk,
        )
        assert created == 1
        assert Notification.objects.filter(recipient=alice).count() == 0
        assert Notification.objects.filter(recipient=bob).count() == 1
        # The Mention rows still get persisted — pause suppresses dispatch,
        # not the audit record of who was @-named.
        assert Mention.objects.filter(mentioned_user=alice).count() == 1

    def test_empty_parsed_returns_zero(
        self,
        project: Project,
        author: object,
        comment: TaskComment,
        memberships: dict[str, ProjectMembership],
    ) -> None:
        from trueppm_api.apps.notifications.services import MentionParseResult

        empty = MentionParseResult(
            user_targets=[], group_targets=[], skipped_users=[], skipped_groups=[]
        )
        created = create_mention_notifications(
            task_comment=comment,
            mentioner=author,
            parsed_result=empty,
            project_id=project.pk,
        )
        assert created == 0
        assert Notification.objects.count() == 0

    def test_email_pending_follows_per_user_pref(
        self,
        project: Project,
        author: object,
        alice: object,
        comment: TaskComment,
        memberships: dict[str, ProjectMembership],
    ) -> None:
        NotificationPreference.objects.create(
            user=alice,
            event_type=NotificationEventType.MENTION_INDIVIDUAL,
            channel=NotificationChannel.EMAIL,
            enabled=True,
        )
        resolved = resolve_parsed_mentions(
            [ParsedMention("user", "alice")], project.pk, actor_role=Role.ADMIN
        )
        create_mention_notifications(
            task_comment=comment,
            mentioner=author,
            parsed_result=resolved,
            project_id=project.pk,
            now=NOON_UTC,  # outside quiet hours — isolate the global email pref
        )
        n = Notification.objects.get(recipient=alice)
        assert n.email_pending is True

    def test_quiet_hours_suppresses_email_but_not_in_app(
        self,
        project: Project,
        author: object,
        alice: object,
        comment: TaskComment,
        memberships: dict[str, ProjectMembership],
    ) -> None:
        """Inside quiet hours the durable in-app row still lands; email does not (#674)."""
        # Global email pref ON so email is gated solely by the project matrix.
        NotificationPreference.objects.create(
            user=alice,
            event_type=NotificationEventType.MENTION_INDIVIDUAL,
            channel=NotificationChannel.EMAIL,
            enabled=True,
        )
        resolved = resolve_parsed_mentions(
            [ParsedMention("user", "alice")], project.pk, actor_role=Role.ADMIN
        )
        created = create_mention_notifications(
            task_comment=comment,
            mentioner=author,
            parsed_result=resolved,
            project_id=project.pk,
            now=MIDNIGHT_UTC,  # inside the default 20:00–07:00 quiet window
        )
        assert created == 1
        n = Notification.objects.get(recipient=alice)
        assert n.email_pending is False  # transient channel suppressed

    def test_in_app_matrix_opt_out_skips_notification(
        self,
        project: Project,
        author: object,
        alice: object,
        bob: object,
        comment: TaskComment,
        memberships: dict[str, ProjectMembership],
    ) -> None:
        """A user who turns off comment_mention/in_app gets no inbox row (#674)."""
        ProjectNotificationPreference.objects.create(
            project=project,
            user=alice,
            matrix={ProjectNotificationEventType.COMMENT_MENTION.value: {"in_app": False}},
        )
        resolved = resolve_parsed_mentions(
            [ParsedMention("user", "alice"), ParsedMention("user", "bob")],
            project.pk,
            actor_role=Role.ADMIN,
        )
        created = create_mention_notifications(
            task_comment=comment,
            mentioner=author,
            parsed_result=resolved,
            project_id=project.pk,
            now=NOON_UTC,
        )
        assert created == 1
        assert Notification.objects.filter(recipient=alice).count() == 0
        assert Notification.objects.filter(recipient=bob).count() == 1
        # The Mention audit row still exists — opt-out suppresses dispatch only.
        assert Mention.objects.filter(mentioned_user=alice).count() == 1


# ---------------------------------------------------------------------------
# User-defined mention groups (ADR-0212, #515)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestUserDefinedGroupMentions:
    """The parser can't know @subcontractors is a group; resolve_parsed_mentions
    reinterprets it, and create_mention_notifications applies per-group mute +
    email default."""

    def _group(self, project: Project, name: str, members: list[object], **kw: object):
        from trueppm_api.apps.access.models import UserDefinedMentionGroup

        group = UserDefinedMentionGroup.objects.create(project=project, name=name, **kw)
        group.members.add(*members)
        return group

    def test_group_name_reinterpreted_as_group(
        self,
        project: Project,
        alice: object,
        bob: object,
        memberships: dict[str, ProjectMembership],
    ) -> None:
        self._group(project, "subcontractors", [alice, bob])
        # The pure parser classifies the unknown token as a user mention.
        parsed = parse_mentions("ping @subcontractors")
        assert parsed == [ParsedMention("user", "subcontractors")]
        # The project-aware resolver promotes it to a group target.
        resolved = resolve_parsed_mentions(parsed, project.pk, actor_role=Role.ADMIN)
        assert resolved.skipped_users == []
        assert len(resolved.group_targets) == 1
        key, members = resolved.group_targets[0]
        assert key == "subcontractors"
        assert {u.pk for u in members} == {alice.pk, bob.pk}  # type: ignore[attr-defined]

    def test_group_fan_out_creates_notifications(
        self,
        project: Project,
        author: object,
        alice: object,
        bob: object,
        comment: TaskComment,
        memberships: dict[str, ProjectMembership],
    ) -> None:
        self._group(project, "subs", [alice, bob])
        resolved = resolve_parsed_mentions(
            parse_mentions("@subs heads up"), project.pk, actor_role=Role.ADMIN
        )
        created = create_mention_notifications(
            task_comment=comment,
            mentioner=author,
            parsed_result=resolved,
            project_id=project.pk,
        )
        assert created == 2
        assert {*Notification.objects.values_list("recipient_id", flat=True)} == {alice.pk, bob.pk}
        # The Mention audit row records the group key.
        assert Mention.objects.filter(mentioned_group_key="subs").count() == 1

    def test_muted_member_not_notified_by_group(
        self,
        project: Project,
        author: object,
        alice: object,
        bob: object,
        comment: TaskComment,
        memberships: dict[str, ProjectMembership],
    ) -> None:
        group = self._group(project, "subs", [alice, bob])
        group.muted_by.add(alice)
        resolved = resolve_parsed_mentions(
            parse_mentions("@subs"), project.pk, actor_role=Role.ADMIN
        )
        create_mention_notifications(
            task_comment=comment, mentioner=author, parsed_result=resolved, project_id=project.pk
        )
        assert Notification.objects.filter(recipient=alice).count() == 0
        assert Notification.objects.filter(recipient=bob).count() == 1

    def test_muted_member_still_reached_by_direct_mention(
        self,
        project: Project,
        author: object,
        alice: object,
        comment: TaskComment,
        memberships: dict[str, ProjectMembership],
    ) -> None:
        # Mute is group-scoped: a direct @alice still notifies her.
        group = self._group(project, "subs", [alice])
        group.muted_by.add(alice)
        resolved = resolve_parsed_mentions(
            parse_mentions("@subs and @alice"), project.pk, actor_role=Role.ADMIN
        )
        create_mention_notifications(
            task_comment=comment, mentioner=author, parsed_result=resolved, project_id=project.pk
        )
        assert Notification.objects.filter(recipient=alice).count() == 1

    def test_email_default_off_no_email_pending(
        self,
        project: Project,
        author: object,
        alice: object,
        comment: TaskComment,
        memberships: dict[str, ProjectMembership],
    ) -> None:
        self._group(project, "subs", [alice], email_default_on=False)
        resolved = resolve_parsed_mentions(
            parse_mentions("@subs"), project.pk, actor_role=Role.ADMIN
        )
        create_mention_notifications(
            task_comment=comment,
            mentioner=author,
            parsed_result=resolved,
            project_id=project.pk,
            now=NOON_UTC,
        )
        assert Notification.objects.get(recipient=alice).email_pending is False

    def test_email_default_on_sets_email_pending(
        self,
        project: Project,
        author: object,
        alice: object,
        comment: TaskComment,
        memberships: dict[str, ProjectMembership],
    ) -> None:
        # Group manager flipped the per-group email default ON; outside quiet
        # hours the recipient's email is queued without a per-user global toggle.
        self._group(project, "subs", [alice], email_default_on=True)
        resolved = resolve_parsed_mentions(
            parse_mentions("@subs"), project.pk, actor_role=Role.ADMIN
        )
        create_mention_notifications(
            task_comment=comment,
            mentioner=author,
            parsed_result=resolved,
            project_id=project.pk,
            now=NOON_UTC,
        )
        assert Notification.objects.get(recipient=alice).email_pending is True

    def test_member_still_wins_over_group_on_name_collision(
        self,
        project: Project,
        author: object,
        alice: object,
        bob: object,
        memberships: dict[str, ProjectMembership],
    ) -> None:
        # A group literally named "alice" is shadowed by the member @alice.
        self._group(project, "alice", [bob])
        resolved = resolve_parsed_mentions(
            parse_mentions("@alice"), project.pk, actor_role=Role.ADMIN
        )
        assert [u.pk for u in resolved.user_targets] == [alice.pk]  # type: ignore[attr-defined]
        assert resolved.group_targets == []


# ---------------------------------------------------------------------------
# get_or_create_default_preferences
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestGetOrCreateDefaultPreferences:
    def test_creates_full_default_set(self, alice: object) -> None:
        prefs = get_or_create_default_preferences(alice)
        assert len(prefs) == len(DEFAULT_PREFERENCES)
        as_dict = {(p.event_type, p.channel): p.enabled for p in prefs}
        for et, ch, enabled in DEFAULT_PREFERENCES:
            assert as_dict[(et, ch)] is enabled

    def test_idempotent_does_not_overwrite_existing(self, alice: object) -> None:
        NotificationPreference.objects.create(
            user=alice,
            event_type=NotificationEventType.MENTION_INDIVIDUAL,
            channel=NotificationChannel.IN_APP,
            enabled=False,  # user flipped this off
        )
        prefs = get_or_create_default_preferences(alice)
        # Existing row preserved
        explicit = next(
            p
            for p in prefs
            if p.event_type == NotificationEventType.MENTION_INDIVIDUAL
            and p.channel == NotificationChannel.IN_APP
        )
        assert explicit.enabled is False

    def test_second_call_does_not_duplicate(self, alice: object) -> None:
        get_or_create_default_preferences(alice)
        get_or_create_default_preferences(alice)
        assert NotificationPreference.objects.filter(user=alice).count() == len(DEFAULT_PREFERENCES)


# ---------------------------------------------------------------------------
# should_deliver — project-scoped delivery gate (#674)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestShouldDeliver:
    # COMMENT_MENTION deliberately: it is the only event with a dispatcher, and so
    # the only one that may default ON (#2904). These tests are about quiet hours,
    # lazy row creation and channel semantics — the event is incidental — but they
    # need one whose default is True, or every assertion here reads False for the
    # wrong reason. Do not swap this back to an undispatched event.
    _EVENT = ProjectNotificationEventType.COMMENT_MENTION.value
    _IN_APP = ProjectNotificationChannel.IN_APP.value
    _EMAIL = ProjectNotificationChannel.EMAIL.value

    def test_lazily_creates_row(self, project: Project, alice: object) -> None:
        """First call materializes the user's preference row (defaults apply)."""
        assert should_deliver(alice, project, self._EVENT, self._EMAIL, now=NOON_UTC) is True
        assert (
            ProjectNotificationPreference.objects.filter(project=project, user=alice).count() == 1
        )

    def test_matrix_cell_false_blocks_delivery(self, project: Project, alice: object) -> None:
        ProjectNotificationPreference.objects.create(
            project=project,
            user=alice,
            matrix={self._EVENT: {self._EMAIL: False}},
        )
        assert should_deliver(alice, project, self._EVENT, self._EMAIL, now=NOON_UTC) is False

    def test_matrix_cell_true_allows_delivery(self, project: Project, alice: object) -> None:
        ProjectNotificationPreference.objects.create(
            project=project,
            user=alice,
            matrix={self._EVENT: {self._EMAIL: True}},
        )
        assert should_deliver(alice, project, self._EVENT, self._EMAIL, now=NOON_UTC) is True

    def test_paused_blocks_every_channel(self, project: Project, alice: object) -> None:
        ProjectNotificationPreference.objects.create(project=project, user=alice, paused=True)
        assert should_deliver(alice, project, self._EVENT, self._IN_APP, now=NOON_UTC) is False
        assert should_deliver(alice, project, self._EVENT, self._EMAIL, now=NOON_UTC) is False

    def test_stale_row_missing_event_falls_through_to_defaults(
        self, project: Project, alice: object
    ) -> None:
        """A row predating a new event type routes via the default matrix."""
        # COMMENT_MENTION absent from the stored matrix → default (in_app True).
        ProjectNotificationPreference.objects.create(
            project=project,
            user=alice,
            matrix={self._EVENT: {self._EMAIL: False}},
        )
        comment_mention = ProjectNotificationEventType.COMMENT_MENTION.value
        assert should_deliver(alice, project, comment_mention, self._IN_APP, now=NOON_UTC) is True

    def test_per_channel_opt_out(self, project: Project, alice: object) -> None:
        """Email off + in-app on → in-app fires, email does not (#674)."""
        ProjectNotificationPreference.objects.create(
            project=project,
            user=alice,
            matrix={self._EVENT: {self._IN_APP: True, self._EMAIL: False}},
            quiet_hours_enabled=False,
        )
        assert should_deliver(alice, project, self._EVENT, self._IN_APP, now=NOON_UTC) is True
        assert should_deliver(alice, project, self._EVENT, self._EMAIL, now=NOON_UTC) is False

    def test_quiet_hours_overnight_window_suppresses_email(
        self, project: Project, alice: object
    ) -> None:
        """Overnight 22:00–07:00 window suppresses a 00:30 email."""
        ProjectNotificationPreference.objects.create(
            project=project,
            user=alice,
            quiet_hours_enabled=True,
            quiet_hours_from=time(22, 0),
            quiet_hours_until=time(7, 0),
        )
        assert should_deliver(alice, project, self._EVENT, self._EMAIL, now=MIDNIGHT_UTC) is False

    def test_quiet_hours_same_day_window_suppresses_email(
        self, project: Project, alice: object
    ) -> None:
        """Same-day 20:00–22:00 window suppresses a 21:00 email."""
        ProjectNotificationPreference.objects.create(
            project=project,
            user=alice,
            quiet_hours_enabled=True,
            quiet_hours_from=time(20, 0),
            quiet_hours_until=time(22, 0),
        )
        nine_pm = datetime(2026, 1, 1, 21, 0, tzinfo=UTC)
        assert should_deliver(alice, project, self._EVENT, self._EMAIL, now=nine_pm) is False
        # Outside the window the same cell delivers.
        assert should_deliver(alice, project, self._EVENT, self._EMAIL, now=NOON_UTC) is True

    def test_quiet_hours_never_suppress_in_app(self, project: Project, alice: object) -> None:
        """In-app is durable — quiet hours never drop it (only the matrix cell does)."""
        ProjectNotificationPreference.objects.create(
            project=project,
            user=alice,
            quiet_hours_enabled=True,
            quiet_hours_from=time(22, 0),
            quiet_hours_until=time(7, 0),
        )
        assert should_deliver(alice, project, self._EVENT, self._IN_APP, now=MIDNIGHT_UTC) is True

    def test_quiet_hours_respect_project_timezone(self, project: Project, alice: object) -> None:
        """Quiet-hours windows are interpreted in the project's timezone."""
        project.timezone = "America/New_York"
        project.save(update_fields=["timezone"])
        ProjectNotificationPreference.objects.create(
            project=project,
            user=alice,
            quiet_hours_enabled=True,
            quiet_hours_from=time(22, 0),
            quiet_hours_until=time(7, 0),
        )
        # 04:00 UTC == 23:00 prior-day in New York (EST) → inside the window.
        four_am_utc = datetime(2026, 1, 2, 4, 0, tzinfo=UTC)
        assert should_deliver(alice, project, self._EVENT, self._EMAIL, now=four_am_utc) is False
        # 17:00 UTC == 12:00 New York → outside the window.
        noon_ny = datetime(2026, 1, 2, 17, 0, tzinfo=UTC)
        assert should_deliver(alice, project, self._EVENT, self._EMAIL, now=noon_ny) is True


# ---------------------------------------------------------------------------
# resolve_quiet_hours_timezone — project → workspace → server → UTC chain (#3377)
# ---------------------------------------------------------------------------


def _set_workspace_tz(name: str) -> None:
    """Force the singleton's timezone, creating the row if it does not exist yet."""
    from trueppm_api.apps.workspace.models import Workspace

    ws = Workspace.load()
    ws.timezone = name
    ws.save(update_fields=["timezone"])


@pytest.mark.django_db
class TestResolveQuietHoursTimezone:
    """The chain: Project.timezone → Workspace.timezone → settings.TIME_ZONE → UTC.

    Every assertion here uses a NON-UTC zone as its negative control. The workspace
    default is ``"UTC"``, byte-identical to ``settings.TIME_ZONE``, so a test that
    sets the workspace to UTC and asserts UTC passes just as green against the
    unwired code — it proves nothing.
    """

    def test_project_timezone_wins_over_workspace(self, project: Project) -> None:
        _set_workspace_tz("Asia/Tokyo")
        project.timezone = "America/New_York"
        project.save(update_fields=["timezone"])
        zone, source = resolve_quiet_hours_timezone(project)
        assert zone.key == "America/New_York"
        assert source == QUIET_HOURS_TZ_SOURCE_PROJECT

    def test_blank_project_falls_back_to_workspace(self, project: Project) -> None:
        _set_workspace_tz("Asia/Tokyo")
        assert project.timezone == ""
        zone, source = resolve_quiet_hours_timezone(project)
        assert zone.key == "Asia/Tokyo"
        assert source == QUIET_HOURS_TZ_SOURCE_WORKSPACE

    def test_blank_project_and_workspace_falls_back_to_settings(
        self, project: Project, settings: Any
    ) -> None:
        settings.TIME_ZONE = "Europe/Berlin"
        _set_workspace_tz("")
        zone, source = resolve_quiet_hours_timezone(project)
        assert zone.key == "Europe/Berlin"
        assert source == QUIET_HOURS_TZ_SOURCE_SERVER

    @pytest.mark.parametrize("server_tz", ["", "Pacific Time"])
    def test_nothing_usable_anywhere_lands_on_utc(
        self, project: Project, settings: Any, server_tz: str
    ) -> None:
        """Both ways the server tier can fail: absent, and present-but-unparseable.

        ``""`` is falsy and never enters the ``try``, so it alone leaves the server
        tier's own except-branch unexecuted — the only route into it is a non-empty
        value that ``ZoneInfo`` rejects.
        """
        settings.TIME_ZONE = server_tz
        _set_workspace_tz("")
        zone, source = resolve_quiet_hours_timezone(project)
        assert zone.key == "UTC"
        assert source == QUIET_HOURS_TZ_SOURCE_FALLBACK

    def test_unreadable_workspace_degrades_instead_of_raising(
        self, project: Project, settings: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A workspace table that cannot be read must not take the fan-out down.

        Fresh install or mid-migration: the dispatch path degrades to the server
        default rather than propagating the error. ``ProgrammingError`` is what
        Postgres actually raises for a missing relation, so that is what is injected —
        the handler is narrowed to ``DatabaseError`` on purpose and a ``RuntimeError``
        here would test a path the code deliberately no longer swallows.
        """
        from django.db import ProgrammingError

        from trueppm_api.apps.workspace.models import Workspace

        settings.TIME_ZONE = "Europe/Berlin"

        def _boom(*args: object, **kwargs: object) -> object:
            raise ProgrammingError('relation "workspace_workspace" does not exist')

        monkeypatch.setattr(Workspace.objects, "filter", _boom)
        zone, source = resolve_quiet_hours_timezone(project)
        assert zone.key == "Europe/Berlin"
        assert source == QUIET_HOURS_TZ_SOURCE_SERVER

    def test_missing_workspace_row_is_not_created_by_the_resolve(
        self, project: Project, settings: Any
    ) -> None:
        """The resolve reads; it must never write a singleton as a side effect.

        ``Workspace.load()`` is a get_or_create, so using it here would have a
        notification dispatch INSERT a row merely for asking what timezone it is.
        """
        from trueppm_api.apps.workspace.models import Workspace

        settings.TIME_ZONE = "Europe/Berlin"
        Workspace.objects.all().delete()
        zone, source = resolve_quiet_hours_timezone(project)
        assert zone.key == "Europe/Berlin"
        assert source == QUIET_HOURS_TZ_SOURCE_SERVER
        assert Workspace.objects.count() == 0

    def test_unparseable_workspace_walks_to_the_server_tier(
        self, project: Project, settings: Any
    ) -> None:
        """Bad data at one tier walks to the next, it does not jump to UTC."""
        settings.TIME_ZONE = "Europe/Berlin"
        _set_workspace_tz("Pacific Time")
        zone, source = resolve_quiet_hours_timezone(project)
        assert zone.key == "Europe/Berlin"
        assert source == QUIET_HOURS_TZ_SOURCE_SERVER

    def test_unparseable_project_walks_to_the_workspace_tier(self, project: Project) -> None:
        _set_workspace_tz("Asia/Tokyo")
        project.timezone = "Eastern Standard Time"
        project.save(update_fields=["timezone"])
        zone, source = resolve_quiet_hours_timezone(project)
        assert zone.key == "Asia/Tokyo"
        assert source == QUIET_HOURS_TZ_SOURCE_WORKSPACE

    def test_missing_project_starts_the_chain_lower(self, project: Project) -> None:
        """A project deleted mid-fan-out resolves rather than raising."""
        _set_workspace_tz("Asia/Tokyo")
        zone, source = resolve_quiet_hours_timezone(None)
        assert zone.key == "Asia/Tokyo"
        assert source == QUIET_HOURS_TZ_SOURCE_WORKSPACE

    def test_preloaded_workspace_is_used_without_a_query(self, project: Project) -> None:
        """The threading escape hatch: a caller-supplied singleton skips the load."""
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        from trueppm_api.apps.workspace.models import Workspace

        _set_workspace_tz("Asia/Tokyo")
        preloaded = Workspace.load()
        with CaptureQueriesContext(connection) as ctx:
            zone, source = resolve_quiet_hours_timezone(project, workspace=preloaded)
        assert zone.key == "Asia/Tokyo"
        assert source == QUIET_HOURS_TZ_SOURCE_WORKSPACE
        assert [q for q in ctx.captured_queries if "workspace_workspace" in q["sql"]] == []


@pytest.mark.django_db
class TestQuietHoursHonorWorkspaceTimezone:
    """End-to-end: the delivery gate itself moves when the workspace tz moves."""

    _EVENT = ProjectNotificationEventType.COMMENT_MENTION.value
    _EMAIL = ProjectNotificationChannel.EMAIL.value

    def test_window_is_interpreted_in_the_workspace_timezone(
        self, project: Project, alice: object
    ) -> None:
        _set_workspace_tz("America/New_York")
        assert project.timezone == ""  # nothing overrides — the workspace tier decides
        ProjectNotificationPreference.objects.create(
            project=project,
            user=alice,
            quiet_hours_enabled=True,
            quiet_hours_from=time(22, 0),
            quiet_hours_until=time(7, 0),
        )
        # Both instants are chosen to DISAGREE between UTC and New York — the obvious
        # picks (04:00 and 17:00 UTC) land the same side of a 22:00–07:00 window in
        # both zones, so they pass against the unwired code and prove nothing.
        # 10:00 UTC == 05:00 New York → inside the window there, outside it in UTC.
        ten_am_utc = datetime(2026, 1, 2, 10, 0, tzinfo=UTC)
        assert should_deliver(alice, project, self._EVENT, self._EMAIL, now=ten_am_utc) is False
        # 02:00 UTC == 21:00 prior-day New York → outside it there, inside it in UTC.
        two_am_utc = datetime(2026, 1, 2, 2, 0, tzinfo=UTC)
        assert should_deliver(alice, project, self._EVENT, self._EMAIL, now=two_am_utc) is True

    def test_changing_the_workspace_timezone_moves_the_window(
        self, project: Project, alice: object
    ) -> None:
        """One instant, two workspace zones, opposite verdicts.

        This is the negative control the issue asks for: it holds everything else
        fixed and flips only ``Workspace.timezone``, so it cannot pass against the
        unwired code no matter which zone happens to equal ``settings.TIME_ZONE``.
        02:00 UTC is inside a 22:00–07:00 window read as UTC and outside the same
        window read as New York (21:00 the previous evening).
        """
        _set_workspace_tz("UTC")
        ProjectNotificationPreference.objects.create(
            project=project,
            user=alice,
            quiet_hours_enabled=True,
            quiet_hours_from=time(22, 0),
            quiet_hours_until=time(7, 0),
        )
        two_am_utc = datetime(2026, 1, 2, 2, 0, tzinfo=UTC)
        assert should_deliver(alice, project, self._EVENT, self._EMAIL, now=two_am_utc) is False
        _set_workspace_tz("America/New_York")
        # Same instant, 21:00 New York → now outside the window and delivered.
        assert should_deliver(alice, project, self._EVENT, self._EMAIL, now=two_am_utc) is True


@pytest.mark.django_db
class TestShouldDeliverThreadsTheWorkspace:
    """The ``workspace=`` kwarg on ``should_deliver`` must be wired, not decorative."""

    _EVENT = ProjectNotificationEventType.COMMENT_MENTION.value
    _EMAIL = ProjectNotificationChannel.EMAIL.value

    def test_passed_workspace_wins_over_the_stored_singleton(
        self, project: Project, alice: object
    ) -> None:
        """A caller-supplied singleton decides the window, and no workspace row is read.

        The stored row says UTC and the passed one says New York, so the verdict
        differs by tier: at 02:00 UTC the window is closed under UTC and open under
        New York. Asserting the verdict follows the *passed* value is what proves the
        parameter reaches ``_preference_allows`` rather than being accepted and dropped.
        """
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        from trueppm_api.apps.workspace.models import Workspace

        _set_workspace_tz("UTC")
        passed = Workspace(timezone="America/New_York")
        ProjectNotificationPreference.objects.create(
            project=project,
            user=alice,
            quiet_hours_enabled=True,
            quiet_hours_from=time(22, 0),
            quiet_hours_until=time(7, 0),
        )
        two_am_utc = datetime(2026, 1, 2, 2, 0, tzinfo=UTC)
        # Stored tier (UTC) → 02:00 is inside the window → suppressed.
        assert should_deliver(alice, project, self._EVENT, self._EMAIL, now=two_am_utc) is False
        with CaptureQueriesContext(connection) as ctx:
            allowed = should_deliver(
                alice, project, self._EVENT, self._EMAIL, now=two_am_utc, workspace=passed
            )
        # Passed tier (New York) → 21:00 the previous evening → outside → delivered.
        assert allowed is True
        assert [q for q in ctx.captured_queries if "workspace_workspace" in q["sql"]] == []


@pytest.mark.django_db
class TestFanOutReadsTheWorkspaceOnce:
    """The workspace tier must be resolved per fan-out, never per recipient (#3377).

    Run at two DIFFERENT recipient counts on purpose: a query-count guard sampled at
    one input cannot tell O(1) from O(n).
    """

    def _mention_fanout_workspace_queries(
        self, project: Project, author: object, usernames: list[str], task: Task
    ) -> int:
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        comment = TaskComment.objects.create(
            task=task, author=author, body=" ".join(f"@{u}" for u in usernames)
        )
        resolved = resolve_parsed_mentions(
            [ParsedMention("user", u) for u in usernames], project.pk, actor_role=Role.ADMIN
        )
        with CaptureQueriesContext(connection) as ctx:
            create_mention_notifications(
                task_comment=comment,
                mentioner=author,
                parsed_result=resolved,
                project_id=project.pk,
                now=NOON_UTC,
            )
        return len([q for q in ctx.captured_queries if "workspace_workspace" in q["sql"]])

    def test_workspace_query_count_does_not_scale_with_recipients(
        self, project: Project, author: object, task: Task
    ) -> None:
        _set_workspace_tz("Asia/Tokyo")
        ProjectMembership.objects.create(project=project, user=author, role=Role.ADMIN)
        names = [f"recip{i}" for i in range(5)]
        for name in names:
            user = User.objects.create_user(username=name, password="pw")
            ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)

        two = self._mention_fanout_workspace_queries(project, author, names[:2], task)
        five = self._mention_fanout_workspace_queries(project, author, names, task)
        assert two == 1, f"expected one workspace read per fan-out, got {two}"
        assert five == two, (
            f"workspace reads scaled with recipient count: {two} for 2 recipients, "
            f"{five} for 5 — the singleton is being loaded per recipient"
        )
