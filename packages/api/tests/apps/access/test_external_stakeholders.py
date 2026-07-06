"""External stakeholder registry model, CRUD, RBAC, and resolver (#1658, ADR-0264).

Covers the ``ExternalStakeholder`` model (case-insensitive per-program email
uniqueness across live rows), the program-scoped CRUD API and its Owner/Admin
RBAC + IDOR scoping, the ``resolve_external_stakeholders`` snapshot resolver, the
additive threading of ``external_targets`` onto ``resolve_parsed_mentions`` (leaving
the User-keyed ``group_targets`` untouched), and the hard invariant that external
stakeholders create NO Notification rows and send NO email (delivery deferred to
#1675).
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from rest_framework.test import APIClient

from trueppm_api.apps.access.groups import resolve_external_stakeholders
from trueppm_api.apps.access.models import (
    ExternalStakeholder,
    ProgramMembership,
    ProjectMembership,
    Role,
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


# ---------------------------------------------------------------------------
# Fixtures — one program with two projects + one standalone project
# ---------------------------------------------------------------------------


@pytest.fixture
def program(db: object) -> object:
    owner = User.objects.create_user(username="es_owner", password="pw")
    prog = create_program(
        name="Alpha",
        description="",
        methodology=Methodology.HYBRID,
        created_by=owner,
    )
    prog._owner = owner  # type: ignore[attr-defined]
    return prog


@pytest.fixture
def other_program(db: object) -> object:
    owner = User.objects.create_user(username="es_other_owner", password="pw")
    return create_program(
        name="Beta", description="", methodology=Methodology.HYBRID, created_by=owner
    )


@pytest.fixture
def proj_a(program: object) -> Project:
    return Project.objects.create(name="A", start_date=date(2026, 1, 1), program=program)


@pytest.fixture
def standalone(db: object) -> Project:
    return Project.objects.create(name="Solo", start_date=date(2026, 1, 1), program=None)


def _prog_member(program: object, username: str, role: int) -> object:
    user = User.objects.create_user(username=username, password="pw")
    ProgramMembership.objects.create(program=program, user=user, role=role)
    return user


@pytest.fixture
def owner_user(program: object) -> object:
    return program._owner  # OWNER ProgramMembership created by create_program


@pytest.fixture
def admin_user(program: object) -> object:
    return _prog_member(program, "es_admin", Role.ADMIN)


@pytest.fixture
def scheduler_user(program: object) -> object:
    return _prog_member(program, "es_scheduler", Role.SCHEDULER)


@pytest.fixture
def member_user(program: object) -> object:
    return _prog_member(program, "es_member", Role.MEMBER)


@pytest.fixture
def viewer_user(program: object) -> object:
    return _prog_member(program, "es_viewer", Role.VIEWER)


@pytest.fixture
def outsider(db: object) -> object:
    return User.objects.create_user(username="es_outsider", password="pw")


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _url(program: object) -> str:
    return f"/api/v1/programs/{program.id}/external-stakeholders/"


# ---------------------------------------------------------------------------
# Model — case-insensitive per-program email uniqueness across live rows
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_duplicate_email_same_program_rejected(program: object) -> None:
    ExternalStakeholder.objects.create(program=program, name="Sponsor", email="vip@client.com")
    # Different case, same program → the partial unique index must reject it.
    with pytest.raises(IntegrityError), transaction.atomic():
        ExternalStakeholder.objects.create(
            program=program, name="Sponsor 2", email="VIP@client.com"
        )


@pytest.mark.django_db
def test_same_email_different_program_allowed(program: object, other_program: object) -> None:
    ExternalStakeholder.objects.create(program=program, name="Sponsor", email="vip@client.com")
    # Same email under a different program is fine — the constraint is per-program.
    ExternalStakeholder.objects.create(
        program=other_program, name="Sponsor", email="vip@client.com"
    )
    assert ExternalStakeholder.objects.filter(email="vip@client.com").count() == 2


@pytest.mark.django_db
def test_soft_deleted_row_frees_email_for_readd(program: object) -> None:
    row = ExternalStakeholder.objects.create(
        program=program, name="Sponsor", email="vip@client.com"
    )
    row.is_deleted = True
    row.save(update_fields=["is_deleted"])
    # The condition excludes deleted rows, so re-adding the same email is allowed.
    ExternalStakeholder.objects.create(
        program=program, name="Sponsor Again", email="vip@client.com"
    )
    assert (
        ExternalStakeholder.objects.filter(
            program=program, email="vip@client.com", is_deleted=False
        ).count()
        == 1
    )


# ---------------------------------------------------------------------------
# CRUD API — happy path
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_owner_can_create_and_list(program: object, owner_user: object) -> None:
    resp = _client(owner_user).post(
        _url(program),
        {"name": "Jane Client", "email": "jane@client.com", "note": "VP Sponsor"},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    assert resp.data["name"] == "Jane Client"
    assert resp.data["email"] == "jane@client.com"
    assert resp.data["note"] == "VP Sponsor"
    # created_by is echoed as the adder's display name (username fallback), not a row.
    assert resp.data["created_by"] == "es_owner"

    lst = _client(owner_user).get(_url(program))
    assert lst.status_code == 200
    assert len(lst.data) == 1


@pytest.mark.django_db
def test_admin_can_create(program: object, admin_user: object) -> None:
    resp = _client(admin_user).post(
        _url(program), {"name": "Vendor", "email": "v@vendor.com"}, format="json"
    )
    assert resp.status_code == 201, resp.content


@pytest.mark.django_db
def test_create_duplicate_email_is_friendly_400(program: object, owner_user: object) -> None:
    _client(owner_user).post(_url(program), {"name": "A", "email": "dup@client.com"}, format="json")
    resp = _client(owner_user).post(
        _url(program), {"name": "B", "email": "DUP@client.com"}, format="json"
    )
    assert resp.status_code == 400
    assert "already exists" in str(resp.data).lower()


@pytest.mark.django_db
def test_patch_and_soft_delete(program: object, owner_user: object) -> None:
    row = ExternalStakeholder.objects.create(program=program, name="Old", email="x@client.com")
    detail = f"{_url(program)}{row.id}/"
    patched = _client(owner_user).patch(detail, {"name": "New Name"}, format="json")
    assert patched.status_code == 200
    assert patched.data["name"] == "New Name"

    deleted = _client(owner_user).delete(detail)
    assert deleted.status_code == 204
    row.refresh_from_db()
    assert row.is_deleted is True
    # A soft-deleted row disappears from the list.
    lst = _client(owner_user).get(_url(program))
    assert lst.data == []


# ---------------------------------------------------------------------------
# RBAC — Owner/Admin only; Scheduler/Member/Viewer/non-member denied
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize("role_fixture", ["scheduler_user", "member_user", "viewer_user"])
def test_below_admin_cannot_create(
    program: object, request: pytest.FixtureRequest, role_fixture: str
) -> None:
    user = request.getfixturevalue(role_fixture)
    resp = _client(user).post(_url(program), {"name": "X", "email": "x@client.com"}, format="json")
    assert resp.status_code == 403


@pytest.mark.django_db
@pytest.mark.parametrize("role_fixture", ["scheduler_user", "member_user", "viewer_user"])
def test_below_admin_cannot_list(
    program: object, request: pytest.FixtureRequest, role_fixture: str
) -> None:
    user = request.getfixturevalue(role_fixture)
    resp = _client(user).get(_url(program))
    assert resp.status_code == 403


@pytest.mark.django_db
def test_outsider_cannot_create(program: object, outsider: object) -> None:
    resp = _client(outsider).post(
        _url(program), {"name": "X", "email": "x@client.com"}, format="json"
    )
    assert resp.status_code in (403, 404)


@pytest.mark.django_db
def test_below_admin_cannot_delete(program: object, member_user: object) -> None:
    row = ExternalStakeholder.objects.create(program=program, name="X", email="x@client.com")
    resp = _client(member_user).delete(f"{_url(program)}{row.id}/")
    assert resp.status_code == 403
    row.refresh_from_db()
    assert row.is_deleted is False


@pytest.mark.django_db
def test_cannot_delete_from_closed_program(program: object, owner_user: object) -> None:
    """A closed program is read-only (#530). Delete names its action "destroy",
    which IsProgramNotClosed's bypass set would otherwise let through — the viewset
    re-asserts the closed check, matching the sibling mention-group viewset."""
    row = ExternalStakeholder.objects.create(program=program, name="X", email="x@client.com")
    program.is_closed = True
    program.save(update_fields=["is_closed"])
    resp = _client(owner_user).delete(f"{_url(program)}{row.id}/")
    assert resp.status_code == 403
    row.refresh_from_db()
    assert row.is_deleted is False


# ---------------------------------------------------------------------------
# IDOR — cannot create/read against another program
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_cannot_create_against_another_program(
    program: object, other_program: object, owner_user: object
) -> None:
    # owner_user owns `program` but is NOT a member of `other_program`.
    resp = _client(owner_user).post(
        _url(other_program), {"name": "X", "email": "x@client.com"}, format="json"
    )
    assert resp.status_code in (403, 404)
    assert not ExternalStakeholder.objects.filter(program=other_program).exists()


@pytest.mark.django_db
def test_detail_scoped_to_url_program(
    program: object, other_program: object, owner_user: object
) -> None:
    # A row in `other_program` must not be reachable under `program`'s URL even
    # though the caller is an Owner of `program` (the queryset scopes by URL pk).
    other_row = ExternalStakeholder.objects.create(
        program=other_program, name="X", email="x@client.com"
    )
    resp = _client(owner_user).get(f"{_url(program)}{other_row.id}/")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Resolver — snapshot semantics
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_resolver_returns_program_stakeholders(program: object, proj_a: Project) -> None:
    ExternalStakeholder.objects.create(program=program, name="Bea", email="bea@client.com")
    ExternalStakeholder.objects.create(program=program, name="Amy", email="amy@client.com")
    # Deleted rows are excluded.
    ExternalStakeholder.objects.create(
        program=program, name="Gone", email="gone@client.com", is_deleted=True
    )
    result = resolve_external_stakeholders(proj_a.id)
    assert [s.email for s in result] == ["amy@client.com", "bea@client.com"]


@pytest.mark.django_db
def test_resolver_empty_for_standalone(standalone: Project) -> None:
    assert resolve_external_stakeholders(standalone.id) == []


# ---------------------------------------------------------------------------
# resolve_parsed_mentions — external_targets is additive and separate
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_parsed_mentions_populates_external_and_leaves_group_targets(
    program: object, proj_a: Project
) -> None:
    # A Viewer-role project member is the User-account arm of @program-stakeholders.
    viewer = User.objects.create_user(username="viewer_member", password="pw")
    ProjectMembership.objects.create(project=proj_a, user=viewer, role=Role.VIEWER)
    ExternalStakeholder.objects.create(program=program, name="Client", email="c@client.com")

    parsed = parse_mentions("hey @program-stakeholders please review")
    result = resolve_parsed_mentions(parsed, proj_a.id, actor_role=Role.ADMIN)

    # group_targets holds the resolved Viewer member(s) — UNCHANGED by external work.
    stakeholder_groups = [
        members for key, members in result.group_targets if key == "program-stakeholders"
    ]
    assert stakeholder_groups, "the @program-stakeholders group should resolve"
    assert [u.username for u in stakeholder_groups[0]] == ["viewer_member"]

    # external_targets is the SEPARATE non-account arm.
    assert [s.email for s in result.external_targets] == ["c@client.com"]


@pytest.mark.django_db
def test_parsed_mentions_no_external_without_group_mention(
    program: object, proj_a: Project
) -> None:
    ExternalStakeholder.objects.create(program=program, name="Client", email="c@client.com")
    parsed = parse_mentions("no group here")
    result = resolve_parsed_mentions(parsed, proj_a.id, actor_role=Role.ADMIN)
    assert result.external_targets == []


@pytest.mark.django_db
def test_parsed_mentions_no_external_for_standalone(standalone: Project) -> None:
    # @program-stakeholders on a standalone project is a skipped group, so external
    # resolution never runs.
    parsed = parse_mentions("@program-stakeholders")
    result = resolve_parsed_mentions(parsed, standalone.id, actor_role=Role.ADMIN)
    assert result.external_targets == []
    assert "program-stakeholders" in result.skipped_groups


# ---------------------------------------------------------------------------
# Delivery boundary — NO Notification rows, NO email for external stakeholders (#1675)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_external_stakeholders_create_no_notifications(program: object, proj_a: Project) -> None:
    author = User.objects.create_user(username="author", password="pw")
    ProjectMembership.objects.create(project=proj_a, user=author, role=Role.ADMIN)
    # A Viewer member so the User-account arm produces exactly one notification.
    viewer = User.objects.create_user(username="viewer_only", password="pw")
    ProjectMembership.objects.create(project=proj_a, user=viewer, role=Role.VIEWER)

    task = Task.objects.create(project=proj_a, name="T", duration=1)
    comment = TaskComment.objects.create(task=task, author=author, body="@program-stakeholders")

    parsed = parse_mentions(comment.body)
    resolved = resolve_parsed_mentions(parsed, proj_a.id, actor_role=Role.ADMIN)

    # Baseline: no external stakeholders yet → count with only the Viewer member.
    baseline = create_mention_notifications(
        task_comment=comment,
        mentioner=author,
        parsed_result=resolved,
        project_id=proj_a.id,
    )

    # Now add external stakeholders and re-resolve on a fresh comment.
    ExternalStakeholder.objects.create(program=program, name="C1", email="c1@client.com")
    ExternalStakeholder.objects.create(program=program, name="C2", email="c2@client.com")
    comment2 = TaskComment.objects.create(task=task, author=author, body="@program-stakeholders")
    resolved2 = resolve_parsed_mentions(
        parse_mentions(comment2.body), proj_a.id, actor_role=Role.ADMIN
    )
    assert len(resolved2.external_targets) == 2

    before = Notification.objects.count()
    created2 = create_mention_notifications(
        task_comment=comment2,
        mentioner=author,
        parsed_result=resolved2,
        project_id=proj_a.id,
    )
    after = Notification.objects.count()

    # The two external stakeholders add ZERO notifications — the count matches the
    # baseline (Viewer member only), and no Notification row references an external
    # stakeholder (they have no recipient User).
    assert created2 == baseline
    assert after - before == created2
    # No email was queued for any external stakeholder — there is no email path.
    assert not Notification.objects.filter(email_pending=True).exists()
