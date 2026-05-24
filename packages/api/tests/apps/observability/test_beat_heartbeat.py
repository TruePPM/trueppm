"""Tests for Beat liveness observability (ADR-0081, issue #662).

Covers:
  - beat.heartbeat upserts a single BeatHeartbeat row (creates then updates)
  - beat.check_stale_heartbeat logs WARNING when stale / missing, silent when fresh
  - GET /api/v1/health/beat/ shape, 200-fresh / 503-stale, and IsAdminUser gating
  - The two tasks carry the expected idempotent_task names
"""

from __future__ import annotations

import logging
from datetime import timedelta
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

User = get_user_model()


def _set_heartbeat(age_seconds: float) -> None:
    from trueppm_api.apps.observability.models import BeatHeartbeat

    BeatHeartbeat.objects.update_or_create(
        singleton_key=1,
        defaults={"last_heartbeat": timezone.now() - timedelta(seconds=age_seconds)},
    )


@pytest.mark.django_db
class TestHeartbeatTask:
    def test_heartbeat_creates_then_updates_single_row(self) -> None:
        from trueppm_api.apps.observability.models import BeatHeartbeat
        from trueppm_api.apps.observability.tasks import _do_heartbeat

        _do_heartbeat()
        assert BeatHeartbeat.objects.count() == 1
        first = BeatHeartbeat.objects.get().last_heartbeat

        _do_heartbeat()
        assert BeatHeartbeat.objects.count() == 1  # upsert, not a second row
        assert BeatHeartbeat.objects.get().last_heartbeat >= first


@pytest.mark.django_db
class TestCheckStaleTask:
    def test_fresh_heartbeat_is_not_stale_and_silent(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        from trueppm_api.apps.observability.tasks import _do_check_stale

        _set_heartbeat(age_seconds=10)
        with caplog.at_level(logging.WARNING, logger="trueppm_api.apps.observability.tasks"):
            assert _do_check_stale() is False
        assert [r for r in caplog.records if r.name == "trueppm_api.apps.observability.tasks"] == []

    def test_stale_heartbeat_warns(self, caplog: pytest.LogCaptureFixture) -> None:
        from trueppm_api.apps.observability.tasks import _do_check_stale

        # Older than the default 120 s threshold.
        _set_heartbeat(age_seconds=300)
        with caplog.at_level(logging.WARNING, logger="trueppm_api.apps.observability.tasks"):
            assert _do_check_stale() is True
        assert any("heartbeat is" in r.message for r in caplog.records)

    def test_missing_heartbeat_warns(self, caplog: pytest.LogCaptureFixture) -> None:
        from trueppm_api.apps.observability.tasks import _do_check_stale

        with caplog.at_level(logging.WARNING, logger="trueppm_api.apps.observability.tasks"):
            assert _do_check_stale() is True
        assert any("no heartbeat recorded" in r.message for r in caplog.records)

    def test_threshold_is_configurable(self, caplog: pytest.LogCaptureFixture) -> None:
        from trueppm_api.apps.observability.tasks import _do_check_stale

        _set_heartbeat(age_seconds=60)  # fresh under 120 s, stale under a 30 s threshold
        with patch("django.conf.settings.TRUEPPM_BEAT_STALE_SECONDS", 30):
            assert _do_check_stale() is True


@pytest.mark.django_db
class TestBeatHealthEndpoint:
    URL = "/api/v1/health/beat/"

    def test_requires_authentication(self) -> None:
        res = APIClient().get(self.URL)
        assert res.status_code in (401, 403)

    def test_forbidden_for_non_staff(self) -> None:
        user = User.objects.create_user(username="beat_member", password="pw")
        client = APIClient()
        client.force_authenticate(user=user)
        res = client.get(self.URL)
        assert res.status_code == 403

    def test_fresh_returns_200_not_stale(self) -> None:
        admin = User.objects.create_user(username="beat_admin", password="pw", is_staff=True)
        _set_heartbeat(age_seconds=5)
        client = APIClient()
        client.force_authenticate(user=admin)
        res = client.get(self.URL)
        assert res.status_code == 200
        assert res.data["stale"] is False
        assert res.data["last_heartbeat"] is not None

    def test_stale_returns_503_stale(self) -> None:
        admin = User.objects.create_user(username="beat_admin2", password="pw", is_staff=True)
        _set_heartbeat(age_seconds=300)
        client = APIClient()
        client.force_authenticate(user=admin)
        res = client.get(self.URL)
        assert res.status_code == 503
        assert res.data["stale"] is True

    def test_no_heartbeat_returns_503_null(self) -> None:
        admin = User.objects.create_user(username="beat_admin3", password="pw", is_staff=True)
        client = APIClient()
        client.force_authenticate(user=admin)
        res = client.get(self.URL)
        assert res.status_code == 503
        assert res.data["last_heartbeat"] is None
        assert res.data["stale"] is True


def test_task_names() -> None:
    from trueppm_api.apps.observability.tasks import check_stale_heartbeat, heartbeat

    assert heartbeat.name == "beat.heartbeat"
    assert check_stale_heartbeat.name == "beat.check_stale_heartbeat"
