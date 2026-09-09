"""Tests for ``GET /workspace/sso/redirect-uri/`` (#3690).

The redirect URI is server-derived and identical for every provider
(``_derive_redirect_uri``, ADR-0517 §3.5) — it does not need a saved
``SsoProviderPolicy`` row to compute. Before this endpoint existed, the value was
only reachable through ``SsoProviderReadSerializer.redirect_uri`` on an already
*saved* provider, which meant an admin adding their very first provider (GitLab
included) had no way to see the callback URL they must register with their IdP
before that IdP will issue a client id/secret — a genuine chicken-and-egg gap.
The test that matters most here is the zero-providers case; the rest establishes
the surface is gated the same as its siblings.
"""

from __future__ import annotations

from typing import Any

import pytest

from trueppm_api.apps.sso.models import SsoProviderPolicy

from .conftest import api_client, make_oidc_ctx

REDIRECT_URI = "/api/v1/workspace/sso/redirect-uri/"


@pytest.mark.django_db
def test_available_with_zero_providers_configured(admin: Any) -> None:
    """The regression test: no provider need exist for this value to be readable."""
    assert not SsoProviderPolicy.objects.exists()

    resp = api_client(admin).get(REDIRECT_URI)

    assert resp.status_code == 200, resp.data
    assert resp.data["redirect_uri"].endswith("/api/v1/auth/oidc/callback/")


@pytest.mark.django_db
def test_matches_the_value_a_saved_provider_reports(admin: Any) -> None:
    """Same value whether read before or after a provider is saved (ADR-0517 §3.5)."""
    client = api_client(admin)
    before = client.get(REDIRECT_URI).data["redirect_uri"]

    make_oidc_ctx()
    provider_resp = client.get("/api/v1/workspace/sso/providers/generic/")

    assert provider_resp.data["redirect_uri"] == before


@pytest.mark.django_db
def test_member_cannot_read_it(member: Any) -> None:
    resp = api_client(member).get(REDIRECT_URI)
    assert resp.status_code == 403, resp.data


@pytest.mark.django_db
def test_anonymous_is_denied(db: object) -> None:
    resp = api_client().get(REDIRECT_URI)
    assert resp.status_code == 401
