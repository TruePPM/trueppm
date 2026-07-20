"""Session/CSRF cookie + auth-surface hardening (#2248).

These are defense-in-depth / hygiene invariants surfaced by the 2026-07-20
login/logout/session audit:

- the Django session and CSRF cookies pin SameSite/HttpOnly explicitly rather
  than relying on Django's implicit defaults, so the posture is auditable and
  survives a framework-default change;
- the base (and therefore prod) DRF posture authenticates the API with JWT only;
  SessionAuthentication is re-added only in dev/test so ``client.force_login()``
  can populate ``request.user`` without minting a JWT.
"""

from __future__ import annotations

from django.conf import settings

from trueppm_api.settings import base

_JWT = "rest_framework_simplejwt.authentication.JWTAuthentication"
_SESSION = "rest_framework.authentication.SessionAuthentication"


def test_session_and_csrf_cookies_are_pinned_explicitly() -> None:
    assert settings.SESSION_COOKIE_HTTPONLY is True
    assert settings.SESSION_COOKIE_SAMESITE == "Lax"
    assert settings.CSRF_COOKIE_SAMESITE == "Lax"


def test_base_auth_posture_is_jwt_only() -> None:
    """Base/prod authenticate the API with JWT only — no session second surface."""
    assert base.REST_FRAMEWORK["DEFAULT_AUTHENTICATION_CLASSES"] == [_JWT]


def test_dev_test_settings_readd_session_auth_for_force_login() -> None:
    """The live test settings (dev) keep SessionAuthentication so force_login works."""
    classes = settings.REST_FRAMEWORK["DEFAULT_AUTHENTICATION_CLASSES"]
    assert _JWT in classes
    assert _SESSION in classes
