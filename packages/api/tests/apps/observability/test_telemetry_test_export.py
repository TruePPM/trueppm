"""Tests for the telemetry test-export probe (#2110, ADR-0223 follow-up).

Covers:
  - POST /api/v1/health/telemetry/test/ IsAdminUser gating (401 unauth, 403 non-staff)
  - export mode: canary SUCCESS -> outcome "success", FAILURE -> "failure"
  - probe mode (export switched off): TCP reachable -> "reachable", refused -> "failure"
  - not configured -> "failure" with a canned "no endpoint" detail
  - SECURITY: the OTLP bearer token / headers never appear in the response, even when
    the exporter raises an error that embeds them
  - the request body is ignored (target comes only from settings — closes SSRF)
  - the one-off exporter is always shut down
  - the _telemetry() selector exposes service_version + edition and no token
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import override_settings
from opentelemetry.sdk.trace.export import SpanExportResult
from rest_framework.test import APIClient
from rest_framework.throttling import ScopedRateThrottle

User = get_user_model()

URL = "/api/v1/health/telemetry/test/"


@pytest.fixture(autouse=True)
def _clear_throttle_cache() -> object:
    """The telemetry_test throttle history lives in the LocMem cache; clear it around
    each test so the scope never leaves a later test pre-throttled."""
    cache.clear()
    yield
    cache.clear()


# Import path of the provider symbol as *used by services* (services does
# `from ...otel import provider` then `provider.build_span_exporter`).
_BUILD_EXPORTER = "trueppm_api.apps.observability.otel.provider.build_span_exporter"
_CREATE_CONNECTION = "trueppm_api.apps.observability.services.socket.create_connection"

_ENABLED = {"OTEL_EXPORTER_OTLP_ENDPOINT": "http://collector:4317", "TRUEPPM_OTEL_ENABLED": True}
_DISABLED = {"OTEL_EXPORTER_OTLP_ENDPOINT": "http://collector:4317", "TRUEPPM_OTEL_ENABLED": False}


def _admin_client() -> APIClient:
    admin = User.objects.create_user(username="tel_admin", password="pw", is_staff=True)
    client = APIClient()
    client.force_authenticate(user=admin)
    return client


def _mock_exporter(result: SpanExportResult | None = None, *, side_effect: Exception | None = None):
    exporter = MagicMock()
    if side_effect is not None:
        exporter.export.side_effect = side_effect
    else:
        exporter.export.return_value = result
    return exporter


@pytest.mark.django_db
class TestGating:
    def test_requires_authentication(self) -> None:
        assert APIClient().post(URL).status_code in (401, 403)

    def test_forbidden_for_non_staff(self) -> None:
        user = User.objects.create_user(username="tel_member", password="pw")
        client = APIClient()
        client.force_authenticate(user=user)
        assert client.post(URL).status_code == 403


@pytest.mark.django_db
class TestExportMode:
    @override_settings(**_ENABLED)
    def test_canary_success(self) -> None:
        exporter = _mock_exporter(SpanExportResult.SUCCESS)
        with patch(_BUILD_EXPORTER, return_value=exporter):
            res = _admin_client().post(URL)
        assert res.status_code == 200
        assert res.data["mode"] == "export"
        assert res.data["outcome"] == "success"
        assert res.data["endpoint"] == "http://collector:4317"
        exporter.shutdown.assert_called_once()

    @override_settings(**_ENABLED)
    def test_canary_failure(self) -> None:
        exporter = _mock_exporter(SpanExportResult.FAILURE)
        with patch(_BUILD_EXPORTER, return_value=exporter):
            res = _admin_client().post(URL)
        assert res.status_code == 200
        assert res.data["mode"] == "export"
        assert res.data["outcome"] == "failure"
        exporter.shutdown.assert_called_once()

    @override_settings(**_ENABLED)
    def test_exporter_error_is_a_failure_and_still_shuts_down(self) -> None:
        exporter = _mock_exporter(side_effect=RuntimeError("boom"))
        with patch(_BUILD_EXPORTER, return_value=exporter):
            res = _admin_client().post(URL)
        assert res.data["outcome"] == "failure"
        exporter.shutdown.assert_called_once()


@pytest.mark.django_db
class TestProbeMode:
    @override_settings(**_DISABLED)
    def test_reachable(self) -> None:
        with patch(_CREATE_CONNECTION, return_value=MagicMock()):
            res = _admin_client().post(URL)
        assert res.status_code == 200
        assert res.data["mode"] == "probe"
        assert res.data["outcome"] == "reachable"

    @override_settings(**_DISABLED)
    def test_connection_refused(self) -> None:
        with patch(_CREATE_CONNECTION, side_effect=ConnectionRefusedError()):
            res = _admin_client().post(URL)
        assert res.data["mode"] == "probe"
        assert res.data["outcome"] == "failure"
        assert "refused" in res.data["detail"].lower()

    @override_settings(OTEL_EXPORTER_OTLP_ENDPOINT="", TRUEPPM_OTEL_ENABLED=True)
    def test_not_configured(self) -> None:
        res = _admin_client().post(URL)
        assert res.data["mode"] == "probe"
        assert res.data["outcome"] == "failure"
        assert "No collector endpoint" in res.data["detail"]

    @override_settings(
        OTEL_EXPORTER_OTLP_ENDPOINT="http://collector:99999", TRUEPPM_OTEL_ENABLED=False
    )
    def test_out_of_range_port_is_a_clean_failure_not_a_500(self) -> None:
        # A malformed port must not raise out of _parse_host_port (which runs before
        # _tcp_probe's try-block) and surface as a 500.
        with patch(_CREATE_CONNECTION, side_effect=OSError()):
            res = _admin_client().post(URL)
        assert res.status_code == 200
        assert res.data["outcome"] == "failure"


@pytest.mark.django_db
class TestSecurityInvariants:
    @override_settings(
        OTEL_EXPORTER_OTLP_ENDPOINT="http://collector:4317",
        OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer SECRET123",
        TRUEPPM_OTEL_ENABLED=True,
    )
    def test_token_never_appears_in_response_even_on_error(self) -> None:
        # The exporter raises an error whose text embeds the token, mimicking a
        # transport failure. The canned `detail` must never echo it.
        boom = RuntimeError("export to collector failed: authorization=Bearer SECRET123")
        exporter = _mock_exporter(side_effect=boom)
        with patch(_BUILD_EXPORTER, return_value=exporter):
            res = _admin_client().post(URL)
        blob = json.dumps(res.data)
        assert "SECRET123" not in blob
        assert "Bearer" not in blob
        assert "authorization" not in blob

    @override_settings(**_DISABLED)
    def test_request_body_is_ignored(self) -> None:
        # A caller cannot redirect the probe: the target comes only from settings.
        with patch(_CREATE_CONNECTION, return_value=MagicMock()):
            res = _admin_client().post(URL, {"endpoint": "http://evil.example:9999"}, format="json")
        assert res.data["endpoint"] == "http://collector:4317"


@pytest.mark.django_db
class TestSelectorFields:
    @override_settings(
        OTEL_EXPORTER_OTLP_ENDPOINT="http://collector:4317",
        OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer SECRET123",
        TRUEPPM_OTEL_ENABLED=True,
    )
    def test_system_health_telemetry_has_new_fields_and_no_token(self) -> None:
        res = _admin_client().get("/api/v1/health/system/")
        telemetry = res.data["telemetry"]
        assert "service_version" in telemetry
        assert "edition" in telemetry
        assert "SECRET123" not in json.dumps(telemetry)


@pytest.mark.django_db
class TestThrottle:
    @override_settings(OTEL_EXPORTER_OTLP_ENDPOINT="", TRUEPPM_OTEL_ENABLED=True)
    def test_exceeding_rate_returns_429(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """The telemetry_test scope bounds a single admin's probe rate — the fix for
        the inert-scope bug (ScopedRateThrottle re-reads view.throttle_scope, absent on
        an @api_view, so TelemetryTestThrottle binds its scope in allow_request). Patch
        the rate on the class — DRF binds THROTTLE_RATES at import, so a settings
        override never reaches the already-bound throttle. Uses the not-configured case
        so no outbound socket is opened."""
        monkeypatch.setattr(
            ScopedRateThrottle,
            "THROTTLE_RATES",
            {**ScopedRateThrottle.THROTTLE_RATES, "telemetry_test": "2/min"},
        )
        cache.clear()
        client = _admin_client()  # one user -> one throttle bucket across the loop
        statuses = [client.post(URL).status_code for _ in range(3)]
        assert statuses == [200, 200, 429]
