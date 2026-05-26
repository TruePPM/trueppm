"""API tests for the task-link viewset (#637).

Covers create (server-side provider detection, scheme rejection), list/destroy
(soft-delete), the synchronous refresh action (status update, 422 when the
provider needs a credential the caller hasn't connected), five-role RBAC
(write follows task-edit, read follows task-read, IDOR via queryset scoping),
and that links flow through the project sync delta.
"""

from __future__ import annotations

import json
from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.integrations import http
from trueppm_api.apps.integrations.models import IntegrationCredential, TaskLink
from trueppm_api.apps.projects.models import Calendar, Project, Task

User = get_user_model()

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _mute_broadcasts() -> object:
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
        yield


@pytest.fixture
def project() -> Project:
    calendar = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="Alpha", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def member() -> object:
    return User.objects.create_user(username="member", password="pw")


@pytest.fixture
def viewer() -> object:
    return User.objects.create_user(username="viewer", password="pw")


@pytest.fixture
def outsider() -> object:
    return User.objects.create_user(username="outsider", password="pw")


@pytest.fixture
def memberships(project: Project, member: object, viewer: object) -> None:
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="Foundation", duration=1)


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _list_url(project: Project, task: Task) -> str:
    return f"/api/v1/projects/{project.pk}/tasks/{task.pk}/links/"


def _detail_url(project: Project, task: Task, link_id: object) -> str:
    return f"/api/v1/projects/{project.pk}/tasks/{task.pk}/links/{link_id}/"


def _refresh_url(project: Project, task: Task, link_id: object) -> str:
    return f"/api/v1/projects/{project.pk}/tasks/{task.pk}/links/{link_id}/refresh/"


# ---------------------------------------------------------------------------
# create — provider auto-detection + validation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("url", "expected_provider"),
    [
        ("https://github.com/acme/api/pull/5", "github"),
        ("https://gitlab.com/acme/api/-/merge_requests/5", "gitlab"),
        ("https://example.com/some/doc", "generic"),
    ],
)
def test_member_creates_link_with_detected_provider(
    member: object,
    project: Project,
    task: Task,
    memberships: None,
    url: str,
    expected_provider: str,
) -> None:
    r = _client(member).post(_list_url(project, task), {"url": url}, format="json")
    assert r.status_code == 201
    body = r.json()
    assert body["provider"] == expected_provider
    assert body["status"] == "unknown"  # no fetch on add
    assert body["fetched_at"] is None
    assert TaskLink.objects.filter(task=task, is_deleted=False).count() == 1


def test_create_rejects_non_http_scheme(
    member: object, project: Project, task: Task, memberships: None
) -> None:
    r = _client(member).post(
        _list_url(project, task), {"url": "ftp://example.com/x"}, format="json"
    )
    assert r.status_code == 400


def test_provider_is_not_client_settable(
    member: object, project: Project, task: Task, memberships: None
) -> None:
    """provider is read-only — a client-supplied value is ignored and the URL
    decides. A github URL stays github even if the body claims gitlab."""
    r = _client(member).post(
        _list_url(project, task),
        {"url": "https://github.com/acme/api/pull/9", "provider": "gitlab", "status": "merged"},
        format="json",
    )
    assert r.status_code == 201
    assert r.json()["provider"] == "github"
    assert r.json()["status"] == "unknown"


# ---------------------------------------------------------------------------
# RBAC
# ---------------------------------------------------------------------------


def test_viewer_cannot_create(
    viewer: object, project: Project, task: Task, memberships: None
) -> None:
    r = _client(viewer).post(
        _list_url(project, task), {"url": "https://github.com/a/b/pull/1"}, format="json"
    )
    assert r.status_code == 403


def test_viewer_can_list(
    viewer: object, member: object, project: Project, task: Task, memberships: None
) -> None:
    TaskLink.objects.create(task=task, url="https://github.com/a/b/pull/1", provider="github")
    r = _client(viewer).get(_list_url(project, task))
    assert r.status_code == 200
    assert len(r.json()) == 1


def test_outsider_cannot_list(
    outsider: object, project: Project, task: Task, memberships: None
) -> None:
    TaskLink.objects.create(task=task, url="https://github.com/a/b/pull/1", provider="github")
    r = _client(outsider).get(_list_url(project, task))
    # Non-member: empty queryset (membership check) — never another project's data.
    assert r.status_code in (200, 403)
    if r.status_code == 200:
        assert r.json() == []


# ---------------------------------------------------------------------------
# destroy — soft delete
# ---------------------------------------------------------------------------


def test_member_soft_deletes_link(
    member: object, project: Project, task: Task, memberships: None
) -> None:
    link = TaskLink.objects.create(
        task=task, url="https://github.com/a/b/pull/1", provider="github"
    )
    r = _client(member).delete(_detail_url(project, task, link.pk))
    assert r.status_code == 204
    link.refresh_from_db()
    assert link.is_deleted is True  # soft delete — row retained for sync tombstone
    assert _client(member).get(_list_url(project, task)).json() == []


def test_viewer_cannot_delete(
    viewer: object, member: object, project: Project, task: Task, memberships: None
) -> None:
    link = TaskLink.objects.create(
        task=task, url="https://github.com/a/b/pull/1", provider="github"
    )
    r = _client(viewer).delete(_detail_url(project, task, link.pk))
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# refresh — synchronous status fetch
# ---------------------------------------------------------------------------


def test_refresh_updates_status_with_credential(
    member: object, project: Project, task: Task, memberships: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    IntegrationCredential.upsert(user=member, provider="github", secret="ghp-x")
    link = TaskLink.objects.create(
        task=task, url="https://github.com/acme/api/pull/5", provider="github"
    )

    def _fake_get(url: str, **kwargs: object) -> http.EgressResponse:
        body = json.dumps({"state": "closed", "merged": True, "title": "Land it"}).encode()
        return http.EgressResponse(status=200, body=body, headers={})

    monkeypatch.setattr(http, "get", _fake_get)
    r = _client(member).post(_refresh_url(project, task, link.pk))
    assert r.status_code == 200
    assert r.json()["status"] == "merged"
    assert r.json()["title"] == "Land it"
    assert r.json()["fetched_at"] is not None
    link.refresh_from_db()
    assert link.status == "merged"
    # The credential's last_used_at is stamped.
    cred = IntegrationCredential.objects.get(user=member, provider="github")
    assert cred.last_used_at is not None


def test_refresh_without_credential_returns_422(
    member: object, project: Project, task: Task, memberships: None
) -> None:
    link = TaskLink.objects.create(
        task=task, url="https://github.com/acme/api/pull/5", provider="github"
    )
    r = _client(member).post(_refresh_url(project, task, link.pk))
    assert r.status_code == 422
    body = r.json()
    assert body["code"] == "credential_required"
    assert body["provider"] == "github"
    assert body["requires_credential"] is True


def test_refresh_generic_link_needs_no_credential(
    member: object, project: Project, task: Task, memberships: None
) -> None:
    """The generic provider doesn't require a credential — refresh returns 200
    with status unknown rather than prompting a connect."""
    link = TaskLink.objects.create(task=task, url="https://example.com/x", provider="generic")
    r = _client(member).post(_refresh_url(project, task, link.pk))
    assert r.status_code == 200
    assert r.json()["status"] == "unknown"


def test_viewer_can_refresh(
    viewer: object, project: Project, task: Task, memberships: None
) -> None:
    """Refresh follows read permission — a Viewer may refresh."""
    link = TaskLink.objects.create(task=task, url="https://example.com/x", provider="generic")
    r = _client(viewer).post(_refresh_url(project, task, link.pk))
    assert r.status_code == 200


# ---------------------------------------------------------------------------
# IDOR — queryset scoping
# ---------------------------------------------------------------------------


def test_link_from_another_task_is_404(
    member: object, project: Project, task: Task, memberships: None
) -> None:
    other_task = Task.objects.create(project=project, name="Other", duration=1)
    link = TaskLink.objects.create(
        task=other_task, url="https://github.com/a/b/pull/1", provider="github"
    )
    # Addressing the link under the wrong task's URL must 404, not leak it.
    r = _client(member).get(_detail_url(project, task, link.pk))
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# sync delta
# ---------------------------------------------------------------------------


def test_task_link_appears_in_sync_delta(
    member: object, project: Project, task: Task, memberships: None
) -> None:
    link = TaskLink.objects.create(
        task=task, url="https://github.com/a/b/pull/1", provider="github"
    )
    r = _client(member).get(f"/api/v1/projects/{project.pk}/sync/?since=0")
    assert r.status_code == 200
    task_links = r.json()["changes"]["task_links"]
    ids = {row["id"] for row in task_links["updated"]}
    assert str(link.pk) in ids


def test_soft_deleted_link_is_a_sync_tombstone(
    member: object, project: Project, task: Task, memberships: None
) -> None:
    link = TaskLink.objects.create(
        task=task, url="https://github.com/a/b/pull/1", provider="github"
    )
    link.soft_delete()
    r = _client(member).get(f"/api/v1/projects/{project.pk}/sync/?since=0")
    task_links = r.json()["changes"]["task_links"]
    assert str(link.pk) in task_links["deleted"]
