"""Tests for the GET /api/v1/edition/ endpoint (ADR-0029)."""

from __future__ import annotations

import pytest
from django.core.exceptions import ImproperlyConfigured
from django.test import override_settings
from rest_framework.test import APIClient

from trueppm_api.core.demo_read_only import parse_demo_login_hint


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
        # Assert the field, not the whole payload: the endpoint also carries
        # build identity (#2392), and an exact-equality assertion here would
        # fail every time a field is added rather than when the edition breaks.
        assert r.data["edition"] == "community"

    def test_returns_enterprise_when_setting_overridden(self) -> None:
        client = APIClient()
        with override_settings(TRUEPPM_EDITION="enterprise"):
            r = client.get("/api/v1/edition/")
        assert r.status_code == 200
        assert r.data["edition"] == "enterprise"

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


@pytest.mark.django_db
class TestEditionDemoFields:
    """The read-only demo mode the login screen reads pre-auth (ADR-1197 D3/D4)."""

    def test_demo_read_only_is_false_and_hint_null_by_default(self) -> None:
        r = APIClient().get("/api/v1/edition/")
        assert r.status_code == 200
        assert r.data["demo_read_only"] is False
        assert r.data["demo_login_hint"] is None

    def test_demo_read_only_true_emits_hint(self) -> None:
        with override_settings(
            DEMO_READ_ONLY=True,
            DEMO_LOGIN_HINT={"username": "demo@trueppm.com", "password": "trueppm-demo"},
        ):
            r = APIClient().get("/api/v1/edition/")
        assert r.data["demo_read_only"] is True
        assert r.data["demo_login_hint"] == {
            "username": "demo@trueppm.com",
            "password": "trueppm-demo",
        }

    def test_hint_is_withheld_when_mode_is_off(self) -> None:
        """A stale hint on a live install must not be broadcast.

        This is the case the gate exists for: the operator turned the demo off but
        left the variable set, and the endpoint is public.
        """
        with override_settings(
            DEMO_READ_ONLY=False,
            DEMO_LOGIN_HINT={"username": "demo@trueppm.com", "password": "trueppm-demo"},
        ):
            r = APIClient().get("/api/v1/edition/")
        assert r.data["demo_read_only"] is False
        assert r.data["demo_login_hint"] is None

    def test_demo_mode_with_no_hint_configured(self) -> None:
        with override_settings(DEMO_READ_ONLY=True, DEMO_LOGIN_HINT=None):
            r = APIClient().get("/api/v1/edition/")
        assert r.data["demo_read_only"] is True
        assert r.data["demo_login_hint"] is None


class TestParseDemoLoginHint:
    """`TRUEPPM_DEMO_LOGIN_HINT` parsing (#3926)."""

    @pytest.mark.parametrize("raw", [None, "", "   "])
    def test_unset_or_empty_is_none(self, raw: str | None) -> None:
        assert parse_demo_login_hint(raw) is None

    def test_splits_on_first_colon_only(self) -> None:
        # A password may contain colons; the username may not.
        assert parse_demo_login_hint("demo@trueppm.com:pa:ss:word") == {
            "username": "demo@trueppm.com",
            "password": "pa:ss:word",
        }

    def test_strips_surrounding_whitespace_on_the_username(self) -> None:
        assert parse_demo_login_hint("  demo:secret  ") == {
            "username": "demo",
            "password": "secret",
        }

    @pytest.mark.parametrize("raw", ["demo", ":secret", "demo:", "  :  "])
    def test_malformed_refuses_to_boot(self, raw: str) -> None:
        with pytest.raises(ImproperlyConfigured):
            parse_demo_login_hint(raw)
