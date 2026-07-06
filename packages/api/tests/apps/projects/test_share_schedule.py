"""Tests for public read-only schedule share links (#1486, ADR-0265).

Extends the #283 board share model with a ``SCHEDULE`` content kind. Covers the
schedule projection's whitelist (float/Monte-Carlo/cost withheld), the cross-kind
discriminator firewall (a board token can never resolve a schedule view or
vice-versa), dependency-edge emission by short_id, link expiry (→ 410), and the
shared kill switch / RBAC / ADR-0135 policy (which are proven for board in
``test_share_links.py`` — here we only assert the schedule endpoint inherits them).
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects import share_services
from trueppm_api.apps.projects.models import (
    Calendar,
    Dependency,
    Project,
    ShareContentKind,
    Task,
    TaskStatus,
)

User = get_user_model()


@pytest.fixture
def calendar(db):
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar):
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


def _schedule_url(token):
    return f"/api/v1/share/schedule/{token}/"


def _board_url(token):
    return f"/api/v1/share/board/{token}/"


def _seed_schedule(project, assignee=None):
    """A summary + two tasks (one critical) + a milestone + a soft-deleted task,
    plus one dependency edge and one comment. Returns (t1, t2, milestone)."""
    t1 = Task.objects.create(
        project=project,
        name="Frame walls",
        duration=5,
        assignee=assignee,
        early_start=date(2026, 2, 1),
        early_finish=date(2026, 2, 7),
        is_critical=True,
        total_float=0,
    )
    t1.status = TaskStatus.IN_PROGRESS
    t1.save()
    t2 = Task.objects.create(
        project=project,
        name="Pour slab",
        duration=3,
        early_start=date(2026, 2, 8),
        early_finish=date(2026, 2, 11),
        is_critical=False,
        total_float=4,
    )
    t2.save()
    milestone = Task.objects.create(
        project=project,
        name="Foundation done",
        duration=0,
        is_milestone=True,
        early_start=date(2026, 2, 11),
        early_finish=date(2026, 2, 11),
    )
    milestone.save()
    dropped = Task.objects.create(project=project, name="Dropped", duration=1)
    dropped.is_deleted = True
    dropped.save()
    Dependency.objects.create(predecessor=t1, successor=t2, dep_type="FS", lag=0)
    return t1, t2, milestone


# --------------------------------------------------------------------------- #
# Management mint — content_kind + share_path
# --------------------------------------------------------------------------- #


@pytest.mark.django_db
def test_admin_mints_schedule_link_with_schedule_share_path(admin_client, project):
    resp = admin_client.post(
        _links_url(project), {"label": "Client review", "content_kind": "schedule"}, format="json"
    )
    assert resp.status_code == 201
    body = resp.data
    assert body["content_kind"] == "schedule"
    assert body["share_path"] == f"/share/schedule/{body['token']}"


@pytest.mark.django_db
def test_content_kind_defaults_to_board_for_pre_1486_clients(admin_client, project):
    resp = admin_client.post(_links_url(project), {"label": "old client"}, format="json")
    assert resp.status_code == 201
    assert resp.data["content_kind"] == "board"
    assert resp.data["share_path"] == f"/share/board/{resp.data['token']}"


@pytest.mark.django_db
def test_member_cannot_mint_schedule_link(member_client, project):
    resp = member_client.post(_links_url(project), {"content_kind": "schedule"}, format="json")
    assert resp.status_code == 403


# --------------------------------------------------------------------------- #
# Public schedule projection — whitelist + structure
# --------------------------------------------------------------------------- #


@pytest.mark.django_db
def test_public_schedule_is_minimized_and_whitelisted(project):
    _seed_schedule(project)
    _link, raw = share_services.mint_share_link(
        project, None, content_kind=ShareContentKind.SCHEDULE
    )
    resp = APIClient().get(_schedule_url(raw))
    assert resp.status_code == 200
    body = resp.data
    assert body["content_kind"] == "schedule"
    assert body["project"] == {"name": "Riverside", "short_id": "RIV"}
    names = {t["name"] for t in body["tasks"]}
    # Soft-deleted task excluded; the rest present.
    assert names == {"Frame walls", "Pour slab", "Foundation done"}
    task = next(t for t in body["tasks"] if t["name"] == "Frame walls")
    # Only whitelisted keys — internal float / PERT / MC / cost are withheld by omission.
    assert set(task) == {
        "short_id",
        "name",
        "wbs_path",
        "duration",
        "planned_start",
        "early_start",
        "early_finish",
        "is_milestone",
        "is_critical",
        "percent_complete",
        "status",
        "assignee",
    }
    assert "total_float" not in task
    assert "late_start" not in task
    assert task["is_critical"] is True
    assert task["assignee"] is None  # show_assignees defaults off


@pytest.mark.django_db
def test_public_schedule_excludes_backlog(project):
    """Backlog (intake-pool) tasks are withheld from the public schedule exactly as
    they are from the public board — the most likely to carry raw/sensitive names."""
    _seed_schedule(project)
    backlog = Task.objects.create(project=project, name="Secret intake idea", duration=1)
    backlog.status = TaskStatus.BACKLOG
    backlog.save()
    _link, raw = share_services.mint_share_link(
        project, None, content_kind=ShareContentKind.SCHEDULE
    )
    body = APIClient().get(_schedule_url(raw)).data
    names = {t["name"] for t in body["tasks"]}
    assert "Secret intake idea" not in names


@pytest.mark.django_db
def test_public_schedule_emits_dependency_edges_by_short_id(project):
    t1, t2, _ms = _seed_schedule(project)
    _link, raw = share_services.mint_share_link(
        project, None, content_kind=ShareContentKind.SCHEDULE
    )
    body = APIClient().get(_schedule_url(raw)).data
    assert body["dependencies"] == [
        {
            "predecessor_short_id": t1.short_id,
            "successor_short_id": t2.short_id,
            "dep_type": "FS",
            "lag": 0,
        }
    ]


@pytest.mark.django_db
def test_public_schedule_assignee_only_when_enabled(project):
    dev = User.objects.create_user(username="dev", first_name="Dana", last_name="Vale")
    _seed_schedule(project, assignee=dev)
    _link, raw = share_services.mint_share_link(
        project, None, content_kind=ShareContentKind.SCHEDULE, show_assignees=True
    )
    body = APIClient().get(_schedule_url(raw)).data
    task = next(t for t in body["tasks"] if t["name"] == "Frame walls")
    assert task["assignee"] is not None
    assert "Dana" in task["assignee"]


@pytest.mark.django_db
def test_public_schedule_has_no_n_plus_one(project, django_assert_max_num_queries):
    """The projection fetches tasks and dependency edges in one query each, so the
    query count stays CONSTANT as the schedule grows — a large project must not fan
    into a per-task/per-edge N+1. (The remaining queries are the shared kill-switch /
    ADR-0135 policy-inheritance resolution that the board endpoint also incurs.)"""
    # A constant query ceiling across an 8× size jump is the N+1 proof: were the
    # projection fanning per-task or per-edge, the 40-task run would blow past the cap.
    for count in (5, 40):
        # Rebuild the project's tasks at two very different sizes.
        Task.objects.filter(project=project).delete()
        tasks = [
            Task.objects.create(
                project=project,
                name=f"T{i}",
                duration=2,
                early_start=date(2026, 2, 1),
                early_finish=date(2026, 2, 3),
            )
            for i in range(count)
        ]
        for i in range(count - 1):
            Dependency.objects.create(
                predecessor=tasks[i], successor=tasks[i + 1], dep_type="FS", lag=0
            )
        _link, raw = share_services.mint_share_link(
            project, None, content_kind=ShareContentKind.SCHEDULE
        )
        with django_assert_max_num_queries(12):
            assert APIClient().get(_schedule_url(raw)).status_code == 200


# --------------------------------------------------------------------------- #
# Cross-kind discriminator firewall (the headline security property)
# --------------------------------------------------------------------------- #


@pytest.mark.django_db
def test_board_token_cannot_resolve_schedule_view(project):
    _seed_schedule(project)
    _link, raw = share_services.mint_share_link(project, None, content_kind=ShareContentKind.BOARD)
    assert APIClient().get(_schedule_url(raw)).status_code == 404
    # ...but resolves fine on its own kind.
    assert APIClient().get(_board_url(raw)).status_code == 200


@pytest.mark.django_db
def test_schedule_token_cannot_resolve_board_view(project):
    _seed_schedule(project)
    _link, raw = share_services.mint_share_link(
        project, None, content_kind=ShareContentKind.SCHEDULE
    )
    assert APIClient().get(_board_url(raw)).status_code == 404
    assert APIClient().get(_schedule_url(raw)).status_code == 200


# --------------------------------------------------------------------------- #
# Lifecycle: revoked (410), expired (410), unknown (404), kill switch (404)
# --------------------------------------------------------------------------- #


@pytest.mark.django_db
def test_revoked_schedule_returns_410(project):
    link, raw = share_services.mint_share_link(
        project, None, content_kind=ShareContentKind.SCHEDULE
    )
    share_services.revoke_share_link(link, None)
    assert APIClient().get(_schedule_url(raw)).status_code == 410


@pytest.mark.django_db
def test_expired_schedule_returns_410(project):
    past = timezone.now() - timedelta(days=1)
    _link, raw = share_services.mint_share_link(
        project, None, content_kind=ShareContentKind.SCHEDULE, expires_at=past
    )
    assert APIClient().get(_schedule_url(raw)).status_code == 410


@pytest.mark.django_db
def test_future_expiry_still_resolves(project):
    _seed_schedule(project)
    future = timezone.now() + timedelta(days=7)
    _link, raw = share_services.mint_share_link(
        project, None, content_kind=ShareContentKind.SCHEDULE, expires_at=future
    )
    assert APIClient().get(_schedule_url(raw)).status_code == 200


@pytest.mark.django_db
def test_unknown_schedule_token_returns_404(project):
    assert APIClient().get(_schedule_url("not-a-real-token")).status_code == 404


@pytest.mark.django_db
def test_kill_switch_hides_public_schedule_with_404(project, settings):
    _link, raw = share_services.mint_share_link(
        project, None, content_kind=ShareContentKind.SCHEDULE
    )
    settings.TRUEPPM_PUBLIC_BOARD_SHARING_ENABLED = False
    assert APIClient().get(_schedule_url(raw)).status_code == 404


# --------------------------------------------------------------------------- #
# Expiry input validation
# --------------------------------------------------------------------------- #


@pytest.mark.django_db
def test_mint_rejects_past_expiry(admin_client, project):
    past = (timezone.now() - timedelta(days=1)).isoformat()
    resp = admin_client.post(
        _links_url(project),
        {"content_kind": "schedule", "expires_at": past},
        format="json",
    )
    assert resp.status_code == 400
    assert "expires_at" in resp.data


@pytest.mark.django_db
def test_mint_accepts_future_expiry_and_echoes_it(admin_client, project):
    future = (timezone.now() + timedelta(days=30)).replace(microsecond=0)
    resp = admin_client.post(
        _links_url(project),
        {"content_kind": "schedule", "expires_at": future.isoformat()},
        format="json",
    )
    assert resp.status_code == 201
    assert resp.data["expires_at"] is not None
    assert resp.data["is_expired"] is False
