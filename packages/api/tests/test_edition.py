"""Tests for the GET /api/v1/edition/ endpoint (ADR-0029)."""

from __future__ import annotations

import pytest
from django.test import override_settings
from rest_framework.test import APIClient


@pytest.mark.django_db
class TestEditionEndpoint:
    """Edition endpoint is public and returns the TRUEPPM_EDITION setting.

    No database access is required — the endpoint reads only from Django
    settings, so these tests run without the django_db fixture.
    """

    def test_returns_community_by_default(self) -> None:
        client = APIClient()
        r = client.get("/api/v1/edition/")
        assert r.status_code == 200
        assert r.data == {"edition": "community"}

    def test_returns_enterprise_when_setting_overridden(self) -> None:
        client = APIClient()
        with override_settings(TRUEPPM_EDITION="enterprise"):
            r = client.get("/api/v1/edition/")
        assert r.status_code == 200
        assert r.data == {"edition": "enterprise"}

    def test_no_authentication_required(self) -> None:
        """Unauthenticated requests must succeed — the endpoint is public."""
        client = APIClient()
        # Explicitly not calling force_authenticate or setting credentials.
        r = client.get("/api/v1/edition/")
        assert r.status_code == 200

    def test_get_only(self) -> None:
        client = APIClient()
        post_resp = client.post("/api/v1/edition/")
        put_resp = client.put("/api/v1/edition/")
        delete_resp = client.delete("/api/v1/edition/")
        assert post_resp.status_code == 405
        assert put_resp.status_code == 405
        assert delete_resp.status_code == 405
