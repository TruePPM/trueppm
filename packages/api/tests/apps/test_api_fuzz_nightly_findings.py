"""Regressions for the 2026-11-27 nightly ``api:fuzz`` findings (#5093).

Each case reproduces the body or exception the fuzzer reached on the wire, at the
layer that produced it, so the fix is pinned without a live server.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from rest_framework.exceptions import ValidationError

from trueppm_api.apps.integrations.serializers import CredentialUpsertSerializer
from trueppm_api.apps.projects.retro_board_services import _assert_board_writable


@pytest.mark.parametrize("secret", ["ghp_Āabc", "tok‾", "tok\r\nX-Injected: 1", "\U000fc87d"])
def test_credential_secret_outside_printable_ascii_is_a_400_not_a_500(secret: str) -> None:
    # The secret goes into an ``Authorization`` header, which http.client encodes as
    # latin-1: these raised UnicodeEncodeError inside verify_token and answered 500.
    serializer = CredentialUpsertSerializer(data={"secret": secret}, context={"provider": "github"})
    assert not serializer.is_valid()
    assert serializer.errors["secret"] == ["Secret must contain only printable ASCII characters."]


def test_credential_secret_of_printable_ascii_still_validates() -> None:
    serializer = CredentialUpsertSerializer(
        data={"secret": "not-a-real-token-0123"}, context={"provider": "github"}
    )
    assert serializer.is_valid(), serializer.errors


def test_retro_board_read_only_refusal_is_a_detail_object_not_an_array() -> None:
    # A bare-string ValidationError serializes as a top-level array, which the
    # generic 400 envelope on the board and pulse routes does not admit.
    with pytest.raises(ValidationError) as exc_info:
        _assert_board_writable(SimpleNamespace(state="CANCELLED"))  # type: ignore[arg-type]
    detail = exc_info.value.detail
    assert isinstance(detail, dict)
    assert set(detail) == {"detail"}
    assert "read-only while the sprint is CANCELLED" in str(detail["detail"])
