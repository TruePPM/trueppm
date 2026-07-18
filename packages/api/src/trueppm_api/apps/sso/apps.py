"""App config for ``apps/sso`` — basic multi-provider SSO (ADR-0517, supersedes ADR-0187).

The two extension seams (``register_oidc_identity_mapper`` and
``register_local_login_policy_provider``) default to safe community behaviour
with no provider registered, so this app needs no OSS-side ``ready()`` wiring —
the module-level fallbacks in :mod:`trueppm_api.apps.sso.extensions` are the
community defaults. ``trueppm-enterprise`` registers richer providers against the
same seams from its own ``AppConfig.ready()`` (ADR-0177), with zero OSS change.
"""

from __future__ import annotations

from django.apps import AppConfig


class SsoConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "trueppm_api.apps.sso"
    verbose_name = "Single sign-on"
