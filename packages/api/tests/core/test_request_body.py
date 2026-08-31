"""Unit tests for :mod:`trueppm_api.core.request_body`.

The endpoint-level regression sweep lives in
``tests/apps/projects/test_non_object_body_rejected.py``; this module pins the
helper's own contract so the sweep can assert on a shape it does not re-derive.
"""

from __future__ import annotations

from typing import Any

import pytest
from rest_framework import status
from rest_framework.parsers import JSONParser
from rest_framework.request import Request
from rest_framework.test import APIRequestFactory

from trueppm_api.core.request_body import InvalidRequestBody, object_body


def _request(payload: Any) -> Request:
    # `parsers=` is required: a bare `Request` carries no parser, so touching
    # `.data` raises UnsupportedMediaType before the helper ever sees the body.
    return Request(APIRequestFactory().post("/", payload, format="json"), parsers=[JSONParser()])


def test_object_body_returns_the_mapping() -> None:
    assert object_body(_request({"a": 1})) == {"a": 1}


def test_object_body_accepts_an_empty_object() -> None:
    """`{}` is a valid object — the guard is about the container, not its size."""
    assert object_body(_request({})) == {}


@pytest.mark.parametrize("payload", [[], [{"a": 1}], ["a"]])
def test_object_body_rejects_a_list(payload: list[Any]) -> None:
    with pytest.raises(InvalidRequestBody):
        object_body(_request(payload))


def test_invalid_request_body_is_a_400_with_a_flat_detail() -> None:
    """Flat ``{"detail": ...}``, matching the hand-written guards it generalizes.

    A ``ValidationError`` would nest the message under a field key and describe a
    field problem; this is a problem with the envelope, and no field is at fault.
    """
    exc = InvalidRequestBody()
    assert exc.status_code == status.HTTP_400_BAD_REQUEST
    assert str(exc.detail) == "Request body must be a JSON object."
    assert exc.detail.code == "invalid_body"  # type: ignore[union-attr]
