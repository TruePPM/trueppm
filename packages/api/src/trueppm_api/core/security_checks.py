"""SECRET_KEY hardening — refuse to boot in prod with a weak key (#566).

PYSEC-2025-183 against pyjwt notes that key length is the caller's
responsibility. ``djangorestframework-simplejwt`` inherits Django's
``SECRET_KEY`` for ``SIGNING_KEY`` unless explicitly overridden, so any
weakness in ``SECRET_KEY`` flows directly into JWT signing. Django's own
``check_secret_key`` only warns; we want a hard refusal in prod.

Two enforcement paths share the same validator:

* ``manage.py check --deploy`` — exercised via the Django system-check
  registry below (tagged ``Tags.security``, ``deploy=True``).
* App boot — ``settings/prod.py`` calls :func:`validate_secret_key` at
  import time and raises ``RuntimeError`` on any error message. Without
  this, ``gunicorn``/``asgi`` workers never run system checks and a weak
  key would only surface at the first JWT verify failure.
"""

from __future__ import annotations

from collections.abc import Sequence

from django.core.checks import Error, register
from django.core.checks.messages import CheckMessage
from django.core.checks.registry import Tags

MIN_SECRET_KEY_LENGTH = 32

INSECURE_PREFIX = "django-insecure-"


def validate_secret_key(secret_key: str | None, *, debug: bool) -> list[CheckMessage]:
    """Return Django check errors for a weak ``SECRET_KEY`` in prod.

    Returns an empty list when ``debug`` is True so developer workstations
    keep booting with the placeholder key from ``settings/base.py``.
    """
    if debug:
        return []

    errors: list[CheckMessage] = []

    if not secret_key:
        errors.append(
            Error(
                "SECRET_KEY is empty in a non-DEBUG environment.",
                hint=(
                    'Generate one with: python3 -c "import secrets; '
                    'print(secrets.token_urlsafe(50))"'
                ),
                id="trueppm.E001",
            )
        )
        return errors

    if secret_key.startswith(INSECURE_PREFIX):
        errors.append(
            Error(
                f"SECRET_KEY starts with {INSECURE_PREFIX!r} — this is the "
                "Django placeholder and must not be used outside DEBUG.",
                hint=(
                    'Generate one with: python3 -c "import secrets; '
                    'print(secrets.token_urlsafe(50))"'
                ),
                id="trueppm.E002",
            )
        )

    if len(secret_key) < MIN_SECRET_KEY_LENGTH:
        errors.append(
            Error(
                f"SECRET_KEY is {len(secret_key)} characters; minimum is {MIN_SECRET_KEY_LENGTH}.",
                hint=(
                    "JWT signing inherits SECRET_KEY when SIMPLE_JWT.SIGNING_KEY "
                    "is unset (PYSEC-2025-183). Generate a strong key with: "
                    'python3 -c "import secrets; print(secrets.token_urlsafe(50))"'
                ),
                id="trueppm.E003",
            )
        )

    return errors


@register(Tags.security, deploy=True)
def check_secret_key(
    app_configs: Sequence[object] | None = None,
    **kwargs: object,
) -> list[CheckMessage]:
    """Django system check entry point — reads live settings."""
    from django.conf import settings

    return validate_secret_key(
        getattr(settings, "SECRET_KEY", None),
        debug=bool(getattr(settings, "DEBUG", False)),
    )
