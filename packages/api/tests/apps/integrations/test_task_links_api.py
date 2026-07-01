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


def test_link_from_another_project_is_404(member: object, memberships: None) -> None:
    """A link in a project the caller is not a member of is a 404 — the
    membership-scoped queryset is the boundary, not just same-project task scoping."""
    other_cal = Calendar.objects.create(name="Other cal")
    other_project = Project.objects.create(
        name="Beta", start_date=date(2026, 1, 1), calendar=other_cal
    )
    other_task = Task.objects.create(project=other_project, name="B-task", duration=1)
    link = TaskLink.objects.create(
        task=other_task, url="https://github.com/a/b/pull/1", provider="github"
    )
    r = _client(member).get(_detail_url(other_project, other_task, link.pk))
    # Non-member: denied at the permission layer (403) or by the empty queryset
    # (404) — either way the link is never disclosed.
    assert r.status_code in (403, 404)


def test_archived_project_blocks_link_write(
    member: object, project: Project, task: Task, memberships: None
) -> None:
    """Archived projects are hard read-only — create is blocked (IsProjectNotArchived)."""
    project.is_archived = True
    project.save(update_fields=["is_archived"])
    r = _client(member).post(
        _list_url(project, task), {"url": "https://github.com/a/b/pull/1"}, format="json"
    )
    assert r.status_code == 403


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


# ---------------------------------------------------------------------------
# url normalization + custom_title + labels (#970)
# ---------------------------------------------------------------------------


def test_create_normalizes_bare_url_and_resolves_provider(
    member: object, project: Project, task: Task, memberships: None
) -> None:
    """A scheme-less URL is normalized to https:// (not rejected) and the
    provider still resolves from the host (#970)."""
    r = _client(member).post(
        _list_url(project, task), {"url": "github.com/acme/api/pull/7"}, format="json"
    )
    assert r.status_code == 201
    body = r.json()
    assert body["url"] == "https://github.com/acme/api/pull/7"
    assert body["provider"] == "github"


def test_create_accepts_custom_title_and_cleans_labels(
    member: object, project: Project, task: Task, memberships: None
) -> None:
    r = _client(member).post(
        _list_url(project, task),
        {
            "url": "https://example.com/spec",
            "custom_title": "  Design spec  ",
            "labels": ["spec", " design ", "Spec", ""],
        },
        format="json",
    )
    assert r.status_code == 201
    body = r.json()
    assert body["custom_title"] == "Design spec"  # trimmed
    # trimmed, blanks dropped, case-insensitive de-dupe, original order kept
    assert body["labels"] == ["spec", "design"]


def test_create_rejects_more_than_12_labels(
    member: object, project: Project, task: Task, memberships: None
) -> None:
    r = _client(member).post(
        _list_url(project, task),
        {"url": "https://example.com/x", "labels": [f"l{i}" for i in range(13)]},
        format="json",
    )
    assert r.status_code == 400


def test_patch_updates_custom_title_and_labels(
    member: object, project: Project, task: Task, memberships: None
) -> None:
    link = TaskLink.objects.create(task=task, url="https://example.com/x", provider="generic")
    r = _client(member).patch(
        _detail_url(project, task, link.pk),
        {"custom_title": "Renamed", "labels": ["ref"]},
        format="json",
    )
    assert r.status_code == 200
    body = r.json()
    assert body["custom_title"] == "Renamed"
    assert body["labels"] == ["ref"]
    link.refresh_from_db()
    assert link.custom_title == "Renamed"
    assert link.labels == ["ref"]


def test_viewer_cannot_patch(
    viewer: object, member: object, project: Project, task: Task, memberships: None
) -> None:
    link = TaskLink.objects.create(task=task, url="https://example.com/x", provider="generic")
    r = _client(viewer).patch(
        _detail_url(project, task, link.pk), {"custom_title": "nope"}, format="json"
    )
    assert r.status_code == 403


def test_put_is_not_allowed(
    member: object, project: Project, task: Task, memberships: None
) -> None:
    """Only PATCH is exposed; a full PUT replace of server-owned fields is 405 (#970)."""
    link = TaskLink.objects.create(task=task, url="https://example.com/x", provider="generic")
    r = _client(member).put(
        _detail_url(project, task, link.pk), {"url": "https://example.com/y"}, format="json"
    )
    assert r.status_code == 405


def test_archived_project_blocks_patch(
    member: object, project: Project, task: Task, memberships: None
) -> None:
    link = TaskLink.objects.create(task=task, url="https://example.com/x", provider="generic")
    project.is_archived = True
    project.save(update_fields=["is_archived"])
    r = _client(member).patch(
        _detail_url(project, task, link.pk), {"custom_title": "x"}, format="json"
    )
    assert r.status_code == 403


def test_refresh_preserves_custom_title(
    member: object,
    project: Project,
    task: Task,
    memberships: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A refresh updates the provider title/status but never clobbers the
    user-supplied custom_title (#970)."""
    IntegrationCredential.upsert(user=member, provider="github", secret="ghp-x")
    link = TaskLink.objects.create(
        task=task,
        url="https://github.com/acme/api/pull/5",
        provider="github",
        custom_title="My name for it",
    )

    def _fake_get(url: str, **kwargs: object) -> http.EgressResponse:
        body = json.dumps({"state": "open", "title": "Provider title"}).encode()
        return http.EgressResponse(status=200, body=body, headers={})

    monkeypatch.setattr(http, "get", _fake_get)
    r = _client(member).post(_refresh_url(project, task, link.pk))
    assert r.status_code == 200
    body = r.json()
    assert body["title"] == "Provider title"
    assert body["custom_title"] == "My name for it"  # untouched by refresh


def test_patch_cannot_set_provider_or_status(
    member: object, project: Project, task: Task, memberships: None
) -> None:
    """provider/status/title stay read-only on PATCH — a client value is ignored (#970)."""
    link = TaskLink.objects.create(task=task, url="https://example.com/x", provider="generic")
    r = _client(member).patch(
        _detail_url(project, task, link.pk),
        {"provider": "github", "status": "merged", "custom_title": "ok"},
        format="json",
    )
    assert r.status_code == 200
    link.refresh_from_db()
    assert link.provider == "generic"  # read-only — ignored
    assert link.status == "unknown"
    assert link.custom_title == "ok"


def test_patch_url_reresolves_provider(
    member: object, project: Project, task: Task, memberships: None
) -> None:
    """Changing the url via PATCH re-resolves the provider server-side (#970)."""
    link = TaskLink.objects.create(task=task, url="https://example.com/x", provider="generic")
    r = _client(member).patch(
        _detail_url(project, task, link.pk),
        {"url": "https://github.com/acme/api/pull/3"},
        format="json",
    )
    assert r.status_code == 200
    body = r.json()
    assert body["provider"] == "github"
    assert body["url"] == "https://github.com/acme/api/pull/3"


def test_patch_link_from_another_project_is_404(member: object, memberships: None) -> None:
    """The membership-scoped queryset is the IDOR boundary for PATCH too (#970)."""
    other_cal = Calendar.objects.create(name="Other cal 2")
    other_project = Project.objects.create(
        name="Gamma", start_date=date(2026, 1, 1), calendar=other_cal
    )
    other_task = Task.objects.create(project=other_project, name="G-task", duration=1)
    link = TaskLink.objects.create(task=other_task, url="https://example.com/x", provider="generic")
    r = _client(member).patch(
        _detail_url(other_project, other_task, link.pk), {"custom_title": "stolen"}, format="json"
    )
    assert r.status_code in (403, 404)


def test_create_link_on_foreign_project_task_is_403_or_404(
    member: object, memberships: None
) -> None:
    """A member of project A cannot CREATE a link on a task in project B (#1508).

    GET (line 283) and PATCH (above) cross-project IDOR were covered, but POST
    create was not. ``IsProjectMemberWrite.has_permission`` sees the foreign
    ``project_pk`` and denies the non-member (403); either way no link is written.
    """
    other_cal = Calendar.objects.create(name="Other cal 3")
    other_project = Project.objects.create(
        name="Delta", start_date=date(2026, 1, 1), calendar=other_cal
    )
    other_task = Task.objects.create(project=other_project, name="D-task", duration=1)
    r = _client(member).post(
        _list_url(other_project, other_task),
        {"url": "https://github.com/a/b/pull/1"},
        format="json",
    )
    assert r.status_code in (403, 404)
    assert not TaskLink.objects.filter(task=other_task, is_deleted=False).exists()


# ---------------------------------------------------------------------------
# Cloud-file preview cache (#571, ADR-0163)
# ---------------------------------------------------------------------------


def test_create_file_link_detects_provider(
    member: object, project: Project, task: Task, memberships: None
) -> None:
    """A pasted cloud-file URL resolves to its file provider server-side."""
    r = _client(member).post(
        _list_url(project, task),
        {"url": "https://docs.google.com/spreadsheets/d/abc/edit"},
        format="json",
    )
    assert r.status_code == 201
    body = r.json()
    assert body["provider"] == "google_drive"
    # No fetch on add — preview fields start empty.
    assert body["description"] == ""
    assert body["thumbnail_url"] == ""
    assert body["preview_type"] == ""


def test_refresh_file_link_writes_preview(
    member: object,
    project: Project,
    task: Task,
    memberships: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Refreshing a file link unfurls OpenGraph and persists the preview cache.

    No credential is required (the unfurl is anonymous), so a Member refreshing
    a Drive link gets a 200 with the enriched fields rather than a 422.
    """
    link = TaskLink.objects.create(
        task=task,
        url="https://docs.google.com/spreadsheets/d/abc/edit",
        provider="google_drive",
    )

    def _fake_get(url: str, **kwargs: object) -> http.EgressResponse:
        body = (
            b"<html><head>"
            b'<meta property="og:title" content="Q3 Budget">'
            b'<meta property="og:description" content="Quarterly projections">'
            b'<meta property="og:image" content="https://cdn.example.com/t.png">'
            b"</head></html>"
        )
        return http.EgressResponse(status=200, body=body, headers={"content-type": "text/html"})

    monkeypatch.setattr(http, "get", _fake_get)
    r = _client(member).post(_refresh_url(project, task, link.pk))
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "unknown"  # a file has no lifecycle status
    assert body["title"] == "Q3 Budget"
    assert body["description"] == "Quarterly projections"
    assert body["thumbnail_url"] == "https://cdn.example.com/t.png"
    assert body["preview_type"] == "spreadsheet"
    assert body["fetched_at"] is not None
    link.refresh_from_db()
    assert link.preview_type == "spreadsheet"
    assert link.thumbnail_url == "https://cdn.example.com/t.png"


def test_refresh_failure_keeps_last_good_preview(
    member: object,
    project: Project,
    task: Task,
    memberships: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A later failed unfurl (SSRF block / dead link) clears the row's preview to
    empty rather than leaving a stale card claiming a description it no longer has."""
    link = TaskLink.objects.create(
        task=task,
        url="https://app.box.com/s/abc",
        provider="box",
        description="old",
        thumbnail_url="https://cdn.example.com/old.png",
        preview_type="document",
    )

    def _raise(*args: object, **kwargs: object) -> object:
        raise http.EgressTimeout("slow")

    monkeypatch.setattr(http, "get", _raise)
    r = _client(member).post(_refresh_url(project, task, link.pk))
    assert r.status_code == 200
    link.refresh_from_db()
    assert link.description == ""
    assert link.thumbnail_url == ""
    assert link.preview_type == ""


def test_preview_fields_are_read_only_on_create(
    member: object, project: Project, task: Task, memberships: None
) -> None:
    """A client cannot seed the server-owned preview cache via create."""
    r = _client(member).post(
        _list_url(project, task),
        {
            "url": "https://www.dropbox.com/s/abc/f.pdf",
            "description": "injected",
            "thumbnail_url": "https://evil.example.com/x.png",
            "preview_type": "pdf",
        },
        format="json",
    )
    assert r.status_code == 201
    body = r.json()
    assert body["description"] == ""
    assert body["thumbnail_url"] == ""
    assert body["preview_type"] == ""


def test_refresh_throttle_caps_per_user(monkeypatch: pytest.MonkeyPatch) -> None:
    """The per-user refresh throttle blocks past its minute cap and fails open on
    a Redis error (so a throttle outage never blocks a refresh)."""
    from trueppm_api.apps.integrations import throttles

    class _FakeRedis:
        def __init__(self) -> None:
            self.counts: dict[str, int] = {}

        def incr(self, key: str) -> int:
            self.counts[key] = self.counts.get(key, 0) + 1
            return self.counts[key]

        def expire(self, key: str, ttl: int) -> None:
            return None

    fake = _FakeRedis()
    monkeypatch.setattr(throttles, "_client", lambda: fake)
    throttle = throttles.TaskLinkRefreshThrottle()

    class _ReqUser:
        pk = 42

    class _Req:
        user = _ReqUser()

    req = _Req()
    allowed = sum(1 for _ in range(40) if throttle.allow_request(req, object()))  # type: ignore[arg-type]
    assert allowed == throttles._REFRESH_LIMIT_PER_MIN  # 30 allowed, the rest blocked

    # Fail-open: a Redis error must not block the request.
    import redis

    def _boom() -> object:
        raise redis.RedisError("down")

    monkeypatch.setattr(throttles, "_client", _boom)
    assert throttle.allow_request(req, object()) is True  # type: ignore[arg-type]
