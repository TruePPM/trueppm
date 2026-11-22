"""/api/schema/ is anonymous but cached and throttled (#4315)."""

from __future__ import annotations

from collections.abc import Iterator
from unittest import mock

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APIClient
from rest_framework.throttling import SimpleRateThrottle

from trueppm_api.core.schema_views import CachedSpectacularAPIView

URL = "/api/schema/"


@pytest.fixture(autouse=True)
def _fresh_state() -> Iterator[None]:
    cache.clear()
    CachedSpectacularAPIView._cache.clear()
    yield
    cache.clear()
    CachedSpectacularAPIView._cache.clear()


@pytest.mark.django_db
def test_anonymous_get_is_served() -> None:
    """The route stays public: generate:types, smoke tests and the drill read it anonymously."""
    r = APIClient().get(URL)
    assert r.status_code == 200
    assert "paths" in r.data


@pytest.mark.django_db
def test_authenticated_get_is_served() -> None:
    user = get_user_model().objects.create_user("schema_reader", password="x")
    client = APIClient()
    client.force_authenticate(user)
    assert client.get(URL).status_code == 200


@pytest.mark.django_db
def test_schema_is_generated_once_per_process() -> None:
    client = APIClient()
    with mock.patch.object(
        CachedSpectacularAPIView.generator_class, "get_schema", return_value={"paths": {}}
    ) as get_schema:
        first = client.get(URL)
        second = client.get(URL)
    assert first.status_code == second.status_code == 200
    assert first.data == second.data == {"paths": {}}
    assert get_schema.call_count == 1


@pytest.mark.django_db
def test_dedicated_schema_scope_throttles_past_its_rate() -> None:
    client = APIClient()
    with mock.patch.dict(SimpleRateThrottle.THROTTLE_RATES, {"schema": "2/min"}):
        statuses = [client.get(URL).status_code for _ in range(3)]
    assert statuses == [200, 200, 429]
