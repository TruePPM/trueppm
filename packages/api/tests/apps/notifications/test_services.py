"""Tests for notifications services — mention parser + fan-out + defaults."""

from __future__ import annotations

from datetime import date

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
)
from trueppm_api.apps.notifications.services import (
    ParsedMention,
    create_mention_notifications,
    get_or_create_default_preferences,
    parse_mentions,
    resolve_parsed_mentions,
)
from trueppm_api.apps.projects.models import Calendar, Project, Task, TaskComment

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
        )
        n = Notification.objects.get(recipient=alice)
        assert n.email_pending is True


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
