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


@pytest.mark.parametrize("payload", ["scalar", 42, True])
def test_object_body_rejects_a_scalar(payload: Any) -> None:
    """A list is the common case; it is not the only non-object.

    `"scalar"` is the nastiest of these because `str` has no `.get` either but
    *does* support `in` and `[...]` — so a scalar body slips past exactly the
    membership tests a list slips past, and then indexes by character.
    """
    with pytest.raises(InvalidRequestBody):
        object_body(_request(payload))


def test_invalid_request_body_is_a_400_carrying_the_code_on_the_wire() -> None:
    """Shape 2 — ``{"code", "detail"}`` — and the `code` must be IN the body.

    The distinction this pins is the whole of #3281. A *string* ``default_detail``
    leaves ``default_code`` on the ``ErrorDetail`` object, where DRF's handler
    never renders it: the class looks like it publishes a code and does not. So
    the assertion is on ``exc.detail`` as a mapping, not on ``.code`` — the
    attribute was present the entire time the wire format was missing it.
    """
    exc = InvalidRequestBody()
    assert exc.status_code == status.HTTP_400_BAD_REQUEST
    assert isinstance(exc.detail, dict)
    assert dict(exc.detail) == {
        "code": "invalid_body",
        "detail": "Request body must be a JSON object.",
    }
