"""Tests for the GET /api/v1/edition/ endpoint (ADR-0029)."""

from __future__ import annotations

from typing import ClassVar

import pytest
from django.core.exceptions import ImproperlyConfigured
from django.test import override_settings
from rest_framework.test import APIClient

from trueppm_api.core.demo_read_only import (
    parse_demo_access_gate,
    parse_demo_login_hint,
    parse_demo_reset_schedule,
)


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


@pytest.mark.django_db
class TestEditionDemoAccessGate:
    """The external email-capture gate's disclosure (ADR-1197 D8 resolution, #3969)."""

    GATE: ClassVar[dict[str, str]] = {
        "provider": "Cloudflare Access",
        "privacy_url": "https://example.com/privacy",
    }

    def test_absent_by_default(self) -> None:
        """A normal install discloses nothing — the field is null, not omitted.

        The whole point of the mechanism is that it is conditional: an instance with
        no gate must never carry a claim that it collects email addresses.
        """
        r = APIClient().get("/api/v1/edition/")
        assert r.status_code == 200
        assert r.data["demo_access_gate"] is None

    def test_emitted_in_demo_mode_when_declared(self) -> None:
        with override_settings(DEMO_READ_ONLY=True, DEMO_ACCESS_GATE=self.GATE):
            r = APIClient().get("/api/v1/edition/")
        assert r.data["demo_access_gate"] == self.GATE

    def test_demo_mode_with_no_gate_declared(self) -> None:
        """Demo mode alone must not imply a gate. This is the false-claim case."""
        with override_settings(DEMO_READ_ONLY=True, DEMO_ACCESS_GATE=None):
            r = APIClient().get("/api/v1/edition/")
        assert r.data["demo_read_only"] is True
        assert r.data["demo_access_gate"] is None

    def test_withheld_when_demo_mode_is_off(self) -> None:
        """A stale declaration on a live install must not be broadcast.

        Same gate as `demo_login_hint`, plus one of its own: on a normal install this
        would hand any unauthenticated caller the edge topology for free.
        """
        with override_settings(DEMO_READ_ONLY=False, DEMO_ACCESS_GATE=self.GATE):
            r = APIClient().get("/api/v1/edition/")
        assert r.data["demo_access_gate"] is None

    def test_no_authentication_required_to_read_the_disclosure(self) -> None:
        """The disclosure is owed to a visitor who has not signed in — that is the point."""
        with override_settings(DEMO_READ_ONLY=True, DEMO_ACCESS_GATE=self.GATE):
            r = APIClient().get("/api/v1/edition/")
        assert r.status_code == 200
        assert r.data["demo_access_gate"]["provider"] == "Cloudflare Access"


class TestParseDemoAccessGate:
    """`TRUEPPM_DEMO_ACCESS_GATE_*` parsing (#3969)."""

    @pytest.mark.parametrize("raw", [None, "", "   "])
    def test_no_provider_is_none(self, raw: str | None) -> None:
        assert parse_demo_access_gate(raw, None) is None

    def test_privacy_url_without_provider_is_none(self) -> None:
        """The link is an attribute of a declared gate, never a disclosure alone."""
        assert parse_demo_access_gate(None, "https://example.com/privacy") is None

    def test_provider_alone_yields_null_privacy_url(self) -> None:
        assert parse_demo_access_gate("Authelia", None) == {
            "provider": "Authelia",
            "privacy_url": None,
        }

    def test_provider_is_operator_text_not_a_fixed_vendor(self) -> None:
        """A demo behind Authelia must not publish a notice naming Cloudflare."""
        gate = parse_demo_access_gate("Authelia", "https://auth.example.internal/privacy")
        assert gate == {
            "provider": "Authelia",
            "privacy_url": "https://auth.example.internal/privacy",
        }

    def test_strips_surrounding_whitespace(self) -> None:
        assert parse_demo_access_gate("  Cloudflare Access  ", "  https://x.test/p  ") == {
            "provider": "Cloudflare Access",
            "privacy_url": "https://x.test/p",
        }

    @pytest.mark.parametrize(
        "url",
        [
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "/relative/path",
            "example.com/privacy",
            "http://auth.example.internal/privacy",
            "HTTP://auth.example.internal/privacy",
        ],
    )
    def test_non_https_privacy_url_refuses_to_boot(self, url: str) -> None:
        """The value becomes an href on a pre-auth page — refuse, never sanitize at use.

        Plain ``http://`` is refused, not just non-http(s) schemes (#3997): the link
        is rendered on a public unauthenticated page and is held to the same bar as
        any other link a visitor is handed there.
        """
        with pytest.raises(ImproperlyConfigured):
            parse_demo_access_gate("Cloudflare Access", url)


@pytest.mark.django_db
class TestEditionDemoResetSchedule:
    """The reset cadence the demo bar states (#4152, ADR-1197 D9)."""

    def test_absent_by_default(self) -> None:
        r = APIClient().get("/api/v1/edition/")
        assert r.status_code == 200
        assert r.data["demo_reset_schedule"] is None

    def test_emitted_in_demo_mode_when_set(self) -> None:
        with override_settings(DEMO_READ_ONLY=True, DEMO_RESET_SCHEDULE="0 8 * * *"):
            r = APIClient().get("/api/v1/edition/")
        assert r.data["demo_reset_schedule"] == "0 8 * * *"

    def test_demo_mode_with_reset_disabled_is_null(self) -> None:
        """The chart renders the variable empty when demo.reset.enabled is false."""
        with override_settings(DEMO_READ_ONLY=True, DEMO_RESET_SCHEDULE=None):
            r = APIClient().get("/api/v1/edition/")
        assert r.data["demo_read_only"] is True
        assert r.data["demo_reset_schedule"] is None

    def test_withheld_when_demo_mode_is_off(self) -> None:
        """A stale schedule on a live install must not be broadcast."""
        with override_settings(DEMO_READ_ONLY=False, DEMO_RESET_SCHEDULE="0 8 * * *"):
            r = APIClient().get("/api/v1/edition/")
        assert r.data["demo_reset_schedule"] is None


class TestParseDemoResetSchedule:
    """`TRUEPPM_DEMO_RESET_SCHEDULE` parsing (#4152)."""

    @pytest.mark.parametrize("raw", [None, "", "   "])
    def test_unset_or_empty_is_none(self, raw: str | None) -> None:
        assert parse_demo_reset_schedule(raw) is None

    def test_strips_surrounding_whitespace(self) -> None:
        assert parse_demo_reset_schedule("  0 8 * * *  ") == "0 8 * * *"

    def test_passes_through_verbatim_otherwise(self) -> None:
        """Not validated as a cron expression — the CronJob's own field is (#4152)."""
        assert parse_demo_reset_schedule("not-a-cron") == "not-a-cron"


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
