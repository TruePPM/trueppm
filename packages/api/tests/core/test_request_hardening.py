"""RejectNullBytesMiddleware tests (#2229).

A NUL byte (``0x00``) in a query param reaches the ORM and makes PostgreSQL raise
an uncaught ``DataError`` (500). The middleware rejects it as a 400 before the
view, endpoint-agnostically. ``/api/v1/health/`` is unauthenticated and always
200, so it is a clean probe for the query-string guard.
"""

from __future__ import annotations

import pytest
from rest_framework.test import APIClient

HEALTH = "/api/v1/health/"


@pytest.mark.django_db
def test_null_byte_query_value_rejected_400() -> None:
    # APIClient urlencodes the NUL byte to %00 in the query string.
    resp = APIClient().get(HEALTH, {"q": "a\x00b"})
    assert resp.status_code == 400
    assert resp.json()["detail"].startswith("Query parameters must not contain NUL")


@pytest.mark.django_db
def test_encoded_null_byte_in_raw_query_rejected_400() -> None:
    resp = APIClient().get(f"{HEALTH}?q=a%00b")
    assert resp.status_code == 400


@pytest.mark.django_db
def test_null_byte_in_query_key_rejected_400() -> None:
    resp = APIClient().get(f"{HEALTH}?bad%00key=1")
    assert resp.status_code == 400


@pytest.mark.django_db
def test_clean_query_passes_through() -> None:
    resp = APIClient().get(HEALTH, {"q": "totally-fine"})
    assert resp.status_code == 200


@pytest.mark.django_db
def test_no_query_string_passes_through() -> None:
    resp = APIClient().get(HEALTH)
    assert resp.status_code == 200
