"""Unit + API-level tests for TaskAttachmentUploadThrottle (#574, security
review !306 LOW-3).

``TaskAttachmentViewSet.create`` had no throttle at all before this fix — an
authenticated Member could burst-upload attachments unbounded (cost-bounded
only by the 100 MB ``DATA_UPLOAD_MAX_MEMORY_SIZE`` per request). These exercise
the limiter directly with a fake Redis client (allowed under the cap, denied
at the cap with a 60s wait, per-user isolation, anonymous bypass, fail-open on
a Redis outage — matching every other throttle in ``projects/throttles.py``)
and confirm the viewset is actually wired up: ``create`` returns 429 once the
throttle denies a request, while ``list`` never even calls it.
"""

from __future__ import annotations

from datetime import date
from types import SimpleNamespace
from unittest.mock import patch

import pytest
import redis
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects import throttles
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.projects.throttles import TaskAttachmentUploadThrottle

User = get_user_model()


class _FakeRedis:
    """Minimal stand-in for the ``incr``/``expire`` calls the throttle issues."""

    def __init__(self, raise_on_incr: bool = False) -> None:
        self._counts: dict[str, int] = {}
        self.expire_calls: list[tuple[str, int]] = []
        self._raise_on_incr = raise_on_incr

    def incr(self, key: str) -> int:
        if self._raise_on_incr:
            raise redis.RedisError("down")
        self._counts[key] = self._counts.get(key, 0) + 1
        return self._counts[key]

    def expire(self, key: str, ttl: int) -> None:
        self.expire_calls.append((key, ttl))


def _request(user: object) -> SimpleNamespace:
    return SimpleNamespace(user=user)


def _auth_user(pk: str = "u1") -> SimpleNamespace:
    return SimpleNamespace(pk=pk, is_authenticated=True)


# ---------------------------------------------------------------------------
# allow_request — unit coverage of the counting logic
# ---------------------------------------------------------------------------


def test_anonymous_request_is_allowed() -> None:
    """An unauthenticated request is not rate limited (no per-user bucket)."""
    throttle = TaskAttachmentUploadThrottle()
    assert throttle.allow_request(_request(None), view=None) is True
    anon = SimpleNamespace(is_authenticated=False)
    assert throttle.allow_request(_request(anon), view=None) is True


def test_allowed_up_to_the_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    """USER_LIMIT requests in the window all pass; the TTL is set once."""
    fake = _FakeRedis()
    monkeypatch.setattr(throttles, "_client", lambda: fake)
    throttle = TaskAttachmentUploadThrottle()

    for _ in range(TaskAttachmentUploadThrottle.USER_LIMIT):
        assert throttle.allow_request(_request(_auth_user()), view=None) is True
    assert throttle.wait() is None
    assert fake.expire_calls == [("rate:task_attachment_upload:u1", 60)]


def test_denied_over_the_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    """The (USER_LIMIT + 1)th request in the window is denied with a 60s wait."""
    fake = _FakeRedis()
    monkeypatch.setattr(throttles, "_client", lambda: fake)
    throttle = TaskAttachmentUploadThrottle()

    for _ in range(TaskAttachmentUploadThrottle.USER_LIMIT):
        assert throttle.allow_request(_request(_auth_user()), view=None) is True
    assert throttle.allow_request(_request(_auth_user()), view=None) is False
    assert throttle.wait() == 60.0


def test_buckets_are_per_user(monkeypatch: pytest.MonkeyPatch) -> None:
    """Two different users each get their own USER_LIMIT budget."""
    fake = _FakeRedis()
    monkeypatch.setattr(throttles, "_client", lambda: fake)
    throttle = TaskAttachmentUploadThrottle()

    for _ in range(TaskAttachmentUploadThrottle.USER_LIMIT):
        assert throttle.allow_request(_request(_auth_user("u1")), view=None) is True
    assert throttle.allow_request(_request(_auth_user("u1")), view=None) is False
    # u2's bucket is untouched by u1's burst.
    assert throttle.allow_request(_request(_auth_user("u2")), view=None) is True


def test_allow_request_fails_open_on_redis_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """A Redis outage must never block legitimate uploads — fail open (allow).

    Hardening this fail-open behavior itself (e.g. degrading gracefully rather
    than silently uncapping uploads during an outage) is explicitly deferred to
    a follow-up issue per #574 — this test only pins the current, intentional
    behavior.
    """

    def _boom() -> object:
        raise redis.RedisError("down")

    monkeypatch.setattr(throttles, "_client", _boom)
    throttle = TaskAttachmentUploadThrottle()

    assert throttle.allow_request(_request(_auth_user()), view=None) is True


# ---------------------------------------------------------------------------
# API-level — viewset wiring
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="Foundation", duration=1)


@pytest.fixture
def member_client(project: Project) -> APIClient:
    user = User.objects.create_user(username="member", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _att_list_url(project: Project, task: Task) -> str:
    return f"/api/v1/projects/{project.pk}/tasks/{task.pk}/attachments/"


@pytest.mark.django_db
def test_create_action_returns_429_after_burst(
    member_client: APIClient, project: Project, task: Task
) -> None:
    """The create action is wired to TaskAttachmentUploadThrottle: once the
    throttle denies a request, the endpoint responds 429 rather than 201."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch(
            "trueppm_api.apps.projects.throttles.TaskAttachmentUploadThrottle.allow_request",
            side_effect=[True, True, True, False],
        ),
    ):
        statuses = [
            member_client.post(
                _att_list_url(project, task),
                {"external_url": f"https://example.com/doc{i}"},
                format="json",
            ).status_code
            for i in range(4)
        ]

    assert statuses == [201, 201, 201, 429]


@pytest.mark.django_db
def test_list_action_is_not_throttled(
    member_client: APIClient, project: Project, task: Task
) -> None:
    """list/retrieve/destroy stay unthrottled — only create burns upload budget."""
    with patch(
        "trueppm_api.apps.projects.throttles.TaskAttachmentUploadThrottle.allow_request"
    ) as allow_request:
        resp = member_client.get(_att_list_url(project, task))
    assert resp.status_code == 200
    allow_request.assert_not_called()
