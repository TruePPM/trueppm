"""Tests for public read-only board share links (#283, ADR-0245).

Covers the RBAC gate on management, the one-time token reveal + hashed storage,
the public endpoint's read-only minimization (comments/notes/assignees excluded by
default), the 410-vs-404 semantics, the instance kill switch, and access metering.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects import share_services
from trueppm_api.apps.projects.authentication import sha256_hex
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    ShareLink,
    Task,
    TaskComment,
    TaskStatus,
)

User = get_user_model()


@pytest.fixture
def calendar(db):
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar):
    # public_sharing=True opts this project into the ADR-0135 sharing policy; public
    # board links require it (the workspace default is off — sharing is opt-in).
    return Project.objects.create(
        name="Riverside",
        code="RIV",
        start_date=date(2026, 1, 1),
        calendar=calendar,
        public_sharing=True,
    )


def _member(project, username, role):
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    return user


def _client(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def admin_client(project):
    return _client(_member(project, "admin", Role.ADMIN))


@pytest.fixture
def member_client(project):
    return _client(_member(project, "member", Role.MEMBER))


def _links_url(project):
    return f"/api/v1/projects/{project.pk}/share-links/"


def _public_url(token):
    return f"/api/v1/share/board/{token}/"


# --------------------------------------------------------------------------- #
# Management RBAC + token lifecycle
# --------------------------------------------------------------------------- #


@pytest.mark.django_db
def test_admin_creates_link_and_token_returned_once(admin_client, project):
    resp = admin_client.post(_links_url(project), {"label": "Client board"}, format="json")
    assert resp.status_code == 201
    body = resp.data
    # The raw token + relative path appear exactly once here.
    assert body["token"]
    assert body["share_path"] == f"/share/board/{body['token']}"
    assert body["label"] == "Client board"
    assert body["show_assignees"] is False
    # It is NOT retrievable again: the list serializer never carries the raw token.
    link = ShareLink.objects.get(pk=body["id"])
    assert "token" not in admin_client.get(_links_url(project)).data[0]
    # Stored hashed, never raw.
    assert link.token_hash == sha256_hex(body["token"])
    assert link.token_prefix == body["token"][:12]


@pytest.mark.django_db
def test_member_cannot_create(member_client, project):
    resp = member_client.post(_links_url(project), {}, format="json")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_anonymous_cannot_create(project):
    resp = APIClient().post(_links_url(project), {}, format="json")
    assert resp.status_code in (401, 403)


@pytest.mark.django_db
def test_list_shows_active_excludes_revoked(admin_client, project):
    admin_client.post(_links_url(project), {"label": "keep"}, format="json")
    revoked = admin_client.post(_links_url(project), {"label": "gone"}, format="json").data
    admin_client.post(f"{_links_url(project)}{revoked['id']}/revoke/")
    rows = admin_client.get(_links_url(project)).data
    labels = {r["label"] for r in rows}
    assert labels == {"keep"}


@pytest.mark.django_db
def test_revoke_is_idempotent(admin_client, project):
    link = admin_client.post(_links_url(project), {}, format="json").data
    url = f"{_links_url(project)}{link['id']}/revoke/"
    assert admin_client.post(url).status_code == 200
    # Second revoke is a no-op, still 200 (not an error).
    assert admin_client.post(url).status_code == 200


@pytest.mark.django_db
def test_member_cannot_revoke(admin_client, member_client, project):
    link = admin_client.post(_links_url(project), {}, format="json").data
    resp = member_client.post(f"{_links_url(project)}{link['id']}/revoke/")
    assert resp.status_code == 403


# --------------------------------------------------------------------------- #
# Public read-only endpoint
# --------------------------------------------------------------------------- #


def _seed_board(project, assignee=None):
    """Two visible cards + a backlog card + a soft-deleted card + a comment."""
    t1 = Task.objects.create(project=project, name="Frame walls", duration=5, assignee=assignee)
    t1.status = TaskStatus.IN_PROGRESS
    t1.save()
    TaskComment.objects.create(task=t1, author=assignee, body="internal chatter")
    t2 = Task.objects.create(project=project, name="Pour slab", duration=3)
    t2.status = TaskStatus.REVIEW
    t2.save()
    backlog = Task.objects.create(project=project, name="Someday", duration=1)
    backlog.status = TaskStatus.BACKLOG
    backlog.save()
    deleted = Task.objects.create(project=project, name="Dropped", duration=1)
    deleted.status = TaskStatus.IN_PROGRESS
    deleted.is_deleted = True
    deleted.save()
    return t1, t2


@pytest.mark.django_db
def test_public_board_is_minimized_and_read_only(project):
    _seed_board(project)
    _link, raw = share_services.mint_share_link(project, None)
    resp = APIClient().get(_public_url(raw))
    assert resp.status_code == 200
    body = resp.data
    assert body["content_kind"] == "board"
    assert body["project"] == {"name": "Riverside", "short_id": "RIV"}
    names = {c["name"] for col in body["columns"] for c in col["cards"]}
    # Visible cards present; backlog + soft-deleted excluded.
    assert names == {"Frame walls", "Pour slab"}
    # No column is the backlog column.
    assert all(col["key"] != "BACKLOG" for col in body["columns"])
    # Cards carry only whitelisted keys — no comments/notes/points/assignee-by-default.
    card = next(c for col in body["columns"] for c in col["cards"] if c["name"] == "Frame walls")
    assert set(card) == {
        "short_id",
        "name",
        "status",
        "is_milestone",
        "percent_complete",
        "due_date",
        "assignee",
    }
    assert card["assignee"] is None  # show_assignees defaults off


@pytest.mark.django_db
def test_public_board_shows_assignee_only_when_enabled(project):
    dev = User.objects.create_user(username="dev", first_name="Dana", last_name="Vale")
    _seed_board(project, assignee=dev)
    _link, raw = share_services.mint_share_link(project, None, show_assignees=True)
    resp = APIClient().get(_public_url(raw))
    card = next(
        c for col in resp.data["columns"] for c in col["cards"] if c["name"] == "Frame walls"
    )
    assert card["assignee"] is not None
    assert "Dana" in card["assignee"]


@pytest.mark.django_db
def test_public_revoked_returns_410(project):
    link, raw = share_services.mint_share_link(project, None)
    share_services.revoke_share_link(link, None)
    resp = APIClient().get(_public_url(raw))
    assert resp.status_code == 410


@pytest.mark.django_db
def test_public_unknown_token_returns_404(project):
    resp = APIClient().get(_public_url("not-a-real-token"))
    assert resp.status_code == 404


@pytest.mark.django_db
def test_public_access_is_metered(project):
    link, raw = share_services.mint_share_link(project, None)
    assert link.access_count == 0
    APIClient().get(_public_url(raw))
    link.refresh_from_db()
    assert link.access_count == 1
    assert link.last_accessed_at is not None


# --------------------------------------------------------------------------- #
# Instance kill switch
# --------------------------------------------------------------------------- #


@pytest.mark.django_db
def test_kill_switch_blocks_create(admin_client, project, settings):
    settings.TRUEPPM_PUBLIC_BOARD_SHARING_ENABLED = False
    resp = admin_client.post(_links_url(project), {}, format="json")
    assert resp.status_code == 403
    assert "disabled" in resp.data["detail"].lower()


@pytest.mark.django_db
def test_kill_switch_hides_public_link_with_404(project, settings):
    _link, raw = share_services.mint_share_link(project, None)
    settings.TRUEPPM_PUBLIC_BOARD_SHARING_ENABLED = False
    resp = APIClient().get(_public_url(raw))
    assert resp.status_code == 404


# --------------------------------------------------------------------------- #
# Lifecycle + cross-project scoping
# --------------------------------------------------------------------------- #


@pytest.mark.django_db
def test_admin_of_another_project_cannot_revoke_link(calendar, project, admin_client):
    """A link is scoped to its project — a different project's Admin gets a 404, not
    a cross-project IDOR that revokes someone else's link."""
    link = admin_client.post(_links_url(project), {}, format="json").data
    other = Project.objects.create(name="Other", start_date=date(2026, 1, 1), calendar=calendar)
    other_admin = _client(_member(other, "other_admin", Role.ADMIN))
    resp = other_admin.post(f"{_links_url(other)}{link['id']}/revoke/")
    assert resp.status_code == 404
    assert ShareLink.objects.get(pk=link["id"]).revoked_at is None  # untouched


@pytest.mark.django_db
def test_cannot_mint_on_archived_project_but_can_still_list(project, admin_client):
    """Minting is a write → blocked on an archived (hard read-only) project; listing
    existing links is a read → still allowed."""
    project.is_archived = True
    project.save()
    assert admin_client.post(_links_url(project), {}, format="json").status_code == 403
    assert admin_client.get(_links_url(project)).status_code == 200


# --------------------------------------------------------------------------- #
# ADR-0135 "Public sharing" policy integration
# --------------------------------------------------------------------------- #


@pytest.mark.django_db
def test_mint_blocked_when_public_sharing_policy_off(project, admin_client):
    """When the project's effective 'Public sharing' policy is off, an Admin cannot
    mint a public board link even though the instance kill switch is on."""
    project.public_sharing = False
    project.save()
    resp = admin_client.post(_links_url(project), {}, format="json")
    assert resp.status_code == 403
    assert "turned off" in resp.data["detail"].lower()


@pytest.mark.django_db
def test_public_link_404_when_policy_turned_off_after_mint(project):
    """Turning 'Public sharing' off after a link exists immediately stops it resolving."""
    _link, raw = share_services.mint_share_link(project, None)
    assert APIClient().get(_public_url(raw)).status_code == 200
    project.public_sharing = False
    project.save()
    assert APIClient().get(_public_url(raw)).status_code == 404
