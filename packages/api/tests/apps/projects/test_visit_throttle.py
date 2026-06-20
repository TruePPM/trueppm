"""Unit tests for claim_visit_window — the last-visited coalesce (ADR-0150 D3).

Exercises the Redis ``SET NX EX`` claim directly (the API-level tests
monkeypatch this helper, so its body needs its own coverage): a fresh window is
claimed, a repeat ping inside the window is rejected, and a Redis outage fails
*open* so real last-visited data is never dropped.
"""

from __future__ import annotations

import uuid
from datetime import date

import pytest
import redis

from trueppm_api.apps.projects import throttles
from trueppm_api.apps.projects.throttles import claim_visit_window


class _FakeRedis:
    """Minimal stand-in: records the SET call and returns a canned result."""

    def __init__(self, set_result: object) -> None:
        self._set_result = set_result
        self.calls: list[tuple[object, object, dict[str, object]]] = []

    def set(self, key: object, value: object, **kwargs: object) -> object:
        self.calls.append((key, value, kwargs))
        return self._set_result


def test_first_ping_claims_the_window(monkeypatch: pytest.MonkeyPatch) -> None:
    """SET NX succeeds (returns truthy) → the caller should record the visit."""
    fake = _FakeRedis(set_result=True)
    monkeypatch.setattr(throttles, "_client", lambda: fake)

    assert claim_visit_window("u1", "p1", ttl=60) is True
    key, _value, kwargs = fake.calls[0]
    assert key == "rate:project_visit:u1:p1"
    assert kwargs == {"nx": True, "ex": 60}


def test_repeat_ping_in_window_is_coalesced(monkeypatch: pytest.MonkeyPatch) -> None:
    """SET NX returns None when the key already exists → coalesced, skip the write."""
    monkeypatch.setattr(throttles, "_client", lambda: _FakeRedis(set_result=None))

    assert claim_visit_window("u1", "p1") is False


def test_redis_error_fails_open(monkeypatch: pytest.MonkeyPatch) -> None:
    """A Redis outage must never drop a real visit — fail open (record it)."""

    def _boom() -> object:
        raise redis.RedisError("down")

    monkeypatch.setattr(throttles, "_client", _boom)

    assert claim_visit_window("u1", "p1") is True


@pytest.mark.django_db
def test_project_visit_str_is_readable() -> None:
    """ProjectVisit.__str__ renders the user→project mapping with the date."""
    from django.contrib.auth import get_user_model
    from django.utils import timezone

    from trueppm_api.apps.profiles.models import ProjectVisit
    from trueppm_api.apps.projects.models import Calendar, Project

    user = get_user_model().objects.create_user(username="stringy", password="pw")
    project = Project.objects.create(
        name="Apollo", start_date=date(2026, 4, 1), calendar=Calendar.objects.create(name="Std")
    )
    visit = ProjectVisit.objects.create(
        id=uuid.uuid4(), user=user, project=project, visited_at=timezone.now()
    )

    rendered = str(visit)
    assert str(user.pk) in rendered
    assert str(project.pk) in rendered
    assert "ProjectVisit(" in rendered
