"""Program-scoped user-defined @mention group CRUD, RBAC, and resolution (ADR-0248, #516).

The program parallel of ``test_mention_groups_api.py``. Covers Owner-gated
lifecycle, Admin-gated membership over the program-wide member union, mute, cross-
program isolation, the ``resolve_program_user_defined_group_members`` resolver, and
the member → project-group → program-group resolution precedence in
``resolve_parsed_mentions``.
"""

from __future__ import annotations

from datetime import UTC, date, datetime

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.groups import (
    resolve_program_user_defined_group_members,
)
from trueppm_api.apps.access.models import (
    ProgramMembership,
    ProgramUserDefinedMentionGroup,
    ProjectMembership,
    Role,
    UserDefinedMentionGroup,
)
from trueppm_api.apps.access.services import create_program
from trueppm_api.apps.notifications.models import Notification
from trueppm_api.apps.notifications.services import (
    create_mention_notifications,
    parse_mentions,
    resolve_parsed_mentions,
)
from trueppm_api.apps.projects.models import Methodology, Project, Task, TaskComment

User = get_user_model()

# Pin the dispatch clock outside the default 20:00–07:00 quiet-hours window so the
# email-suppression assertions are deterministic. Without this, email_pending races
# the wall clock: a CI run between 20:00 and 07:00 UTC lands inside the default
# quiet window and suppresses the source recipient's email, flaking the test.
NOON_UTC = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)


# ---------------------------------------------------------------------------
# Fixtures — one program with two projects + one standalone project
# ---------------------------------------------------------------------------


@pytest.fixture
def program(db: object) -> object:
    owner = User.objects.create_user(username="prog_owner", password="pw")
    prog = create_program(
        name="Alpha",
        description="",
        methodology=Methodology.HYBRID,
        created_by=owner,
    )
    # Stash the creator (already an OWNER ProgramMembership) for the tests.
    prog._owner = owner  # type: ignore[attr-defined]
    return prog


@pytest.fixture
def other_program(db: object) -> object:
    owner = User.objects.create_user(username="other_owner", password="pw")
    return create_program(
        name="Beta", description="", methodology=Methodology.HYBRID, created_by=owner
    )


@pytest.fixture
def proj_a(program: object) -> Project:
    return Project.objects.create(name="A", start_date=date(2026, 1, 1), program=program)


@pytest.fixture
def proj_b(program: object) -> Project:
    return Project.objects.create(name="B", start_date=date(2026, 1, 1), program=program)


@pytest.fixture
def standalone(db: object) -> Project:
    return Project.objects.create(name="Solo", start_date=date(2026, 1, 1), program=None)


def _prog_member(program: object, username: str, role: int) -> object:
    user = User.objects.create_user(username=username, password="pw")
    ProgramMembership.objects.create(program=program, user=user, role=role)
    return user


@pytest.fixture
def owner_user(program: object) -> object:
    return program._owner  # created by create_program with an OWNER membership


@pytest.fixture
def admin_user(program: object) -> object:
    return _prog_member(program, "prog_admin", Role.ADMIN)


@pytest.fixture
def member_user(program: object) -> object:
    return _prog_member(program, "prog_member", Role.MEMBER)


@pytest.fixture
def viewer_user(program: object) -> object:
    return _prog_member(program, "prog_viewer", Role.VIEWER)


@pytest.fixture
def outsider(db: object) -> object:
    return User.objects.create_user(username="outsider", password="pw")


def _proj_member(project: Project, username: str, role: int = Role.MEMBER) -> object:
    """A user with a ProjectMembership on a project in the program (an addable member)."""
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    return user


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _url(program: object) -> str:
    return f"/api/v1/programs/{program.id}/mention-groups/"


# ---------------------------------------------------------------------------
# Create — RBAC + validation
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_owner_can_create_group(program: object, owner_user: object) -> None:
    resp = _client(owner_user).post(
        _url(program), {"name": "tech-leads", "description": "leads"}, format="json"
    )
    assert resp.status_code == 201, resp.content
    assert resp.data["name"] == "tech-leads"
    assert resp.data["email_default_on"] is False
    assert resp.data["member_count"] == 0
    assert ProgramUserDefinedMentionGroup.objects.filter(
        program=program, name="tech-leads"
    ).exists()


@pytest.mark.django_db
@pytest.mark.parametrize("role_fixture", ["admin_user", "member_user", "viewer_user"])
def test_below_owner_cannot_create_group(
    program: object, request: pytest.FixtureRequest, role_fixture: str
) -> None:
    user = request.getfixturevalue(role_fixture)
    resp = _client(user).post(_url(program), {"name": "leads"}, format="json")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_outsider_cannot_create_group(program: object, outsider: object) -> None:
    resp = _client(outsider).post(_url(program), {"name": "leads"}, format="json")
    assert resp.status_code in (403, 404)


@pytest.mark.django_db
def test_name_uniqueness_case_insensitive(program: object, owner_user: object) -> None:
    _client(owner_user).post(_url(program), {"name": "Leads"}, format="json")
    resp = _client(owner_user).post(_url(program), {"name": "leads"}, format="json")
    assert resp.status_code == 400
    assert "already exists" in str(resp.data).lower()


@pytest.mark.django_db
@pytest.mark.parametrize(
    "reserved",
    ["admins", "all", "scrum-team", "program-pms", "program-all", "program-stakeholders"],
)
def test_reserved_auto_group_names_rejected(
    program: object, owner_user: object, reserved: str
) -> None:
    # Both project- and program-scoped auto-group keys are reserved (ADR-0248 §1).
    resp = _client(owner_user).post(_url(program), {"name": reserved}, format="json")
    assert resp.status_code == 400
    assert "reserved" in str(resp.data).lower()


@pytest.mark.django_db
def test_leading_at_and_bad_chars_handled(program: object, owner_user: object) -> None:
    ok = _client(owner_user).post(_url(program), {"name": "@vendor-x"}, format="json")
    assert ok.status_code == 201
    assert ok.data["name"] == "vendor-x"
    bad = _client(owner_user).post(_url(program), {"name": "bad name"}, format="json")
    assert bad.status_code == 400


@pytest.mark.django_db
def test_same_name_allowed_in_different_programs(
    program: object, other_program: object, owner_user: object
) -> None:
    a = _client(owner_user).post(_url(program), {"name": "leads"}, format="json")
    assert a.status_code == 201
    # Owner of `program` is a member of `other_program` too, for this test.
    ProgramMembership.objects.create(program=other_program, user=owner_user, role=Role.OWNER)
    b = _client(owner_user).post(_url(other_program), {"name": "leads"}, format="json")
    assert b.status_code == 201


# ---------------------------------------------------------------------------
# Rename / delete — Owner
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_owner_can_rename_and_delete(program: object, owner_user: object) -> None:
    group = ProgramUserDefinedMentionGroup.objects.create(program=program, name="leads")
    detail = f"{_url(program)}{group.id}/"
    r = _client(owner_user).patch(detail, {"name": "principals"}, format="json")
    assert r.status_code == 200
    assert r.data["name"] == "principals"
    d = _client(owner_user).delete(detail)
    assert d.status_code == 204
    group.refresh_from_db()
    assert group.is_deleted is True


@pytest.mark.django_db
def test_admin_cannot_rename(program: object, admin_user: object) -> None:
    group = ProgramUserDefinedMentionGroup.objects.create(program=program, name="leads")
    r = _client(admin_user).patch(
        f"{_url(program)}{group.id}/", {"name": "principals"}, format="json"
    )
    assert r.status_code == 403


@pytest.mark.django_db
def test_name_reusable_after_soft_delete(program: object, owner_user: object) -> None:
    group = ProgramUserDefinedMentionGroup.objects.create(program=program, name="leads")
    _client(owner_user).delete(f"{_url(program)}{group.id}/")
    resp = _client(owner_user).post(_url(program), {"name": "leads"}, format="json")
    assert resp.status_code == 201, resp.content


@pytest.mark.django_db
def test_cannot_delete_group_on_closed_program(program: object, owner_user: object) -> None:
    # A closed program is read-only. IsProgramNotClosed bypasses the "destroy"
    # action (so a closed program can be deleted), so the viewset re-asserts the
    # closed invariant explicitly for its own nested destroy.
    group = ProgramUserDefinedMentionGroup.objects.create(program=program, name="leads")
    program.is_closed = True
    program.save()
    resp = _client(owner_user).delete(f"{_url(program)}{group.id}/")
    assert resp.status_code == 403
    group.refresh_from_db()
    assert group.is_deleted is False


# ---------------------------------------------------------------------------
# Membership — Admin+ manages, member union across the program's projects
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_admin_can_add_member_from_any_program_project(
    program: object, admin_user: object, proj_a: Project, proj_b: Project
) -> None:
    group = ProgramUserDefinedMentionGroup.objects.create(program=program, name="leads")
    # A member of proj_b (a different project in the same program) is addable.
    pm_b = _proj_member(proj_b, "pm_b")
    add = _client(admin_user).post(
        f"{_url(program)}{group.id}/add-member/", {"user": str(pm_b.pk)}, format="json"
    )
    assert add.status_code == 200, add.content
    assert add.data["member_count"] == 1
    remove = _client(admin_user).post(
        f"{_url(program)}{group.id}/remove-member/", {"user": str(pm_b.pk)}, format="json"
    )
    assert remove.status_code == 200
    assert remove.data["member_count"] == 0


@pytest.mark.django_db
def test_member_cannot_add_member(program: object, member_user: object, proj_a: Project) -> None:
    group = ProgramUserDefinedMentionGroup.objects.create(program=program, name="leads")
    pm_a = _proj_member(proj_a, "pm_a")
    r = _client(member_user).post(
        f"{_url(program)}{group.id}/add-member/", {"user": str(pm_a.pk)}, format="json"
    )
    assert r.status_code == 403


@pytest.mark.django_db
def test_cannot_add_user_with_no_program_project_membership(
    program: object, admin_user: object, outsider: object
) -> None:
    group = ProgramUserDefinedMentionGroup.objects.create(program=program, name="leads")
    r = _client(admin_user).post(
        f"{_url(program)}{group.id}/add-member/", {"user": str(outsider.pk)}, format="json"
    )
    assert r.status_code == 400
    assert "not a member" in str(r.data).lower()


@pytest.mark.django_db
def test_membership_add_bumps_server_version(
    program: object, admin_user: object, proj_a: Project
) -> None:
    group = ProgramUserDefinedMentionGroup.objects.create(program=program, name="leads")
    pm_a = _proj_member(proj_a, "pm_a")
    before = group.server_version
    _client(admin_user).post(
        f"{_url(program)}{group.id}/add-member/", {"user": str(pm_a.pk)}, format="json"
    )
    group.refresh_from_db()
    assert group.server_version > before


@pytest.mark.django_db
def test_group_not_visible_from_other_program(
    program: object, other_program: object, owner_user: object
) -> None:
    ProgramMembership.objects.create(program=other_program, user=owner_user, role=Role.OWNER)
    group = ProgramUserDefinedMentionGroup.objects.create(program=program, name="leads")
    r = _client(owner_user).get(f"{_url(other_program)}{group.id}/")
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Mute — any member, self only
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_viewer_can_mute_and_unmute(program: object, viewer_user: object) -> None:
    group = ProgramUserDefinedMentionGroup.objects.create(program=program, name="leads")
    detail = f"{_url(program)}{group.id}/"
    m = _client(viewer_user).post(f"{detail}mute/", {}, format="json")
    assert m.status_code == 200
    assert m.data["muted_by_me"] is True
    assert group.muted_by.filter(pk=viewer_user.pk).exists()
    u = _client(viewer_user).post(f"{detail}unmute/", {}, format="json")
    assert u.status_code == 200
    assert u.data["muted_by_me"] is False


# ---------------------------------------------------------------------------
# Resolver — snapshot-at-write + program-wide active-member filtering
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_resolver_returns_current_members(
    program: object, proj_a: Project, proj_b: Project
) -> None:
    group = ProgramUserDefinedMentionGroup.objects.create(program=program, name="leads")
    pm_a = _proj_member(proj_a, "pm_a")
    pm_b = _proj_member(proj_b, "pm_b")
    group.members.add(pm_a, pm_b)
    resolved = resolve_program_user_defined_group_members(program.id, "leads")
    assert resolved is not None
    assert set(resolved) == {pm_a.pk, pm_b.pk}


@pytest.mark.django_db
def test_resolver_case_insensitive_and_unknown(program: object, proj_a: Project) -> None:
    group = ProgramUserDefinedMentionGroup.objects.create(program=program, name="Leads")
    pm_a = _proj_member(proj_a, "pm_a")
    group.members.add(pm_a)
    assert resolve_program_user_defined_group_members(program.id, "leads") == [pm_a.pk]
    assert resolve_program_user_defined_group_members(program.id, "nope") is None


@pytest.mark.django_db
def test_resolver_excludes_members_who_left_the_program(program: object, proj_a: Project) -> None:
    group = ProgramUserDefinedMentionGroup.objects.create(program=program, name="leads")
    pm_a = _proj_member(proj_a, "pm_a")
    group.members.add(pm_a)
    # The member's only project membership in the program is soft-deleted.
    ProjectMembership.objects.filter(project=proj_a, user=pm_a).update(is_deleted=True)
    assert resolve_program_user_defined_group_members(program.id, "leads") == []


@pytest.mark.django_db
def test_deleted_group_does_not_resolve(program: object, proj_a: Project) -> None:
    group = ProgramUserDefinedMentionGroup.objects.create(program=program, name="leads")
    pm_a = _proj_member(proj_a, "pm_a")
    group.members.add(pm_a)
    group.is_deleted = True
    group.save()
    assert resolve_program_user_defined_group_members(program.id, "leads") is None


# ---------------------------------------------------------------------------
# Resolution precedence in resolve_parsed_mentions (ADR-0248 §4)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_program_group_resolves_from_a_project_comment(
    program: object, proj_a: Project, proj_b: Project
) -> None:
    group = ProgramUserDefinedMentionGroup.objects.create(program=program, name="leads")
    pm_b = _proj_member(proj_b, "pm_b")
    group.members.add(pm_b)
    parsed = parse_mentions("ping @leads")
    result = resolve_parsed_mentions(parsed, proj_a.id)
    keys = {key for key, _ in result.group_targets}
    assert "leads" in keys
    members = dict(result.group_targets)["leads"]
    assert {m.pk for m in members} == {pm_b.pk}
    assert "leads" not in result.skipped_users


@pytest.mark.django_db
def test_project_group_wins_over_program_group_on_name_collision(
    program: object, proj_a: Project, proj_b: Project
) -> None:
    # Same @name at both scopes: the project group is the more specific match.
    proj_group = UserDefinedMentionGroup.objects.create(project=proj_a, name="leads")
    prog_group = ProgramUserDefinedMentionGroup.objects.create(program=program, name="leads")
    pm_a = _proj_member(proj_a, "pm_a")
    pm_b = _proj_member(proj_b, "pm_b")
    proj_group.members.add(pm_a)
    prog_group.members.add(pm_b)
    parsed = parse_mentions("ping @leads")
    result = resolve_parsed_mentions(parsed, proj_a.id)
    members = dict(result.group_targets)["leads"]
    assert {m.pk for m in members} == {pm_a.pk}  # project group wins


@pytest.mark.django_db
def test_standalone_project_skips_program_groups(
    program: object, proj_a: Project, standalone: Project
) -> None:
    # A program group exists, but a comment from a standalone project (no program)
    # can't reference it — the @name is an unresolved user, not a group.
    group = ProgramUserDefinedMentionGroup.objects.create(program=program, name="leads")
    group.members.add(_proj_member(proj_a, "pm_a"))
    parsed = parse_mentions("ping @leads")
    result = resolve_parsed_mentions(parsed, standalone.id)
    assert result.group_targets == []
    assert "leads" in result.skipped_users


# ---------------------------------------------------------------------------
# Cross-project email read-boundary in the notification fan-out (ADR-0248 §5)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_email_suppressed_for_cross_project_program_group_recipient(
    program: object, proj_a: Project, proj_b: Project
) -> None:
    """A sibling-project member of a program group must NOT be emailed the source
    project's comment body — the email channel honors the same read boundary the
    in-app snippet redaction does. Both recipients still get the in-app row.
    """
    author = _proj_member(proj_a, "author")  # mentioner, source-project member
    source_member = _proj_member(proj_a, "source_member")  # can see the source project
    sibling_member = _proj_member(proj_b, "sibling_member")  # sibling project only
    group = ProgramUserDefinedMentionGroup.objects.create(
        program=program, name="leads", email_default_on=True
    )
    group.members.add(source_member, sibling_member)

    task = Task.objects.create(project=proj_a, name="T", duration=1)
    comment = TaskComment.objects.create(task=task, author=author, body="@leads secret floor price")

    resolved = resolve_parsed_mentions(parse_mentions(comment.body), proj_a.id)
    create_mention_notifications(
        task_comment=comment,
        mentioner=author,
        parsed_result=resolved,
        project_id=proj_a.id,
        now=NOON_UTC,
    )

    # Both members get the durable in-app row…
    source_n = Notification.objects.get(recipient=source_member)
    sibling_n = Notification.objects.get(recipient=sibling_member)
    # …but only the source-project member is emailed the body (email_default_on +
    # the comment_mention/email matrix default). The sibling's email is suppressed.
    assert source_n.email_pending is True
    assert sibling_n.email_pending is False
