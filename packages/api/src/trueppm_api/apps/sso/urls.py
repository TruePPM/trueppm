"""URL routes for the SSO app (ADR-0187 §2).

Flow endpoints sit under ``auth/oidc/`` next to the existing cookie-auth views;
admin config sits under ``workspace/sso/`` next to the workspace settings views.
Included at ``api/v1/`` from the root urlconf.
"""

from __future__ import annotations

from django.urls import path

from trueppm_api.apps.sso.views import (
    OIDCCallbackView,
    OIDCDiscoverView,
    OIDCLoginView,
    OIDCProviderView,
    OIDCTestConnectionView,
)

urlpatterns = [
    path("auth/oidc/discover/", OIDCDiscoverView.as_view(), name="oidc-discover"),
    path("auth/oidc/login/", OIDCLoginView.as_view(), name="oidc-login"),
    path("auth/oidc/callback/", OIDCCallbackView.as_view(), name="oidc-callback"),
    path("workspace/sso/", OIDCProviderView.as_view(), name="oidc-provider"),
    path(
        "workspace/sso/test-connection/",
        OIDCTestConnectionView.as_view(),
        name="oidc-test-connection",
    ),
]
