"""URL routes for the SSO app (ADR-0517 §3.4–3.5).

Flow endpoints keep their ADR-0187 paths under ``auth/oidc/`` (unchanged callback
path for every provider — OTel redaction + operator allow-lists depend on it); the
admin config moves from a singleton to a collection under
``workspace/sso/providers/``. Included at ``api/v1/`` from the root urlconf.
"""

from __future__ import annotations

from django.urls import path

from trueppm_api.apps.sso.views import (
    OIDCCallbackView,
    OIDCDiscoverView,
    OIDCLoginView,
    SsoProviderCollectionView,
    SsoProviderDetailView,
    SsoTestConnectionView,
)

urlpatterns = [
    path("auth/oidc/discover/", OIDCDiscoverView.as_view(), name="oidc-discover"),
    path("auth/oidc/login/", OIDCLoginView.as_view(), name="oidc-login"),
    path("auth/oidc/callback/", OIDCCallbackView.as_view(), name="oidc-callback"),
    path(
        "workspace/sso/providers/",
        SsoProviderCollectionView.as_view(),
        name="sso-provider-collection",
    ),
    path(
        "workspace/sso/providers/<slug:slug>/",
        SsoProviderDetailView.as_view(),
        name="sso-provider-detail",
    ),
    path(
        "workspace/sso/providers/<slug:slug>/test-connection/",
        SsoTestConnectionView.as_view(),
        name="sso-provider-test-connection",
    ),
]
