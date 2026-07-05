"""Tests for notifications services — mention parser + fan-out + defaults."""

from __future__ import annotations

from datetime import UTC, date, datetime, time

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
    ParsedMention,
    create_mention_notifications,
    get_or_create_default_preferences,
    parse_mentions,
    resolve_parsed_mentions,
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
# User-defined mention groups (ADR-0211, #515)
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
    _EVENT = ProjectNotificationEventType.TASK_ASSIGNED.value
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
