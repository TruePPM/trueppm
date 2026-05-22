"""Development settings — DEBUG on, relaxed auth, local service URLs.

This module is fenced by ``_assert_dev_environment_safe`` because it sets
``AllowAny`` and ``ALLOWED_HOSTS=['*']`` — loading it in staging or production
would silently disable authentication on every endpoint. The guard fails loudly
at import time unless the process is a test runner or the operator has
explicitly opted in via ``TRUEPPM_ALLOW_DEV_SETTINGS=1``.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping
from typing import Any

import environ


def _assert_dev_environment_safe(
    env: Mapping[str, str] | None = None,
    modules: Mapping[str, Any] | None = None,
) -> None:
    """Refuse to load dev settings outside a test runner or developer workstation.

    Four signals permit the load, in order of precedence:
      1. ``PYTEST_CURRENT_TEST`` is set in the environment (pytest is active)
      2. ``pytest`` is already imported in the running process (test collection)
      3. ``mypy`` is already imported (django-stubs imports settings under mypy)
      4. ``TRUEPPM_ALLOW_DEV_SETTINGS=1`` is set (explicit developer opt-in)

    Any other environment — staging, production, an unconfigured Docker image —
    raises ``RuntimeError`` to prevent the module from completing its import and
    overriding ``DEFAULT_PERMISSION_CLASSES`` with ``AllowAny``.

    Args are injectable so the assertion can be unit-tested without mutating the
    real environment or the global module table.
    """
    env = env if env is not None else os.environ
    modules = modules if modules is not None else sys.modules

    if env.get("PYTEST_CURRENT_TEST"):
        return
    if "pytest" in modules or "mypy" in modules:
        return
    if env.get("TRUEPPM_ALLOW_DEV_SETTINGS") == "1":
        return

    raise RuntimeError(
        "trueppm_api.settings.dev was loaded outside local dev or a test runner. "
        "This module sets AllowAny and ALLOWED_HOSTS=['*'] — refusing to import. "
        "Set TRUEPPM_ALLOW_DEV_SETTINGS=1 to override on a developer workstation."
    )


_assert_dev_environment_safe()


from .base import *  # noqa: F403, E402
from .base import REST_FRAMEWORK  # noqa: E402

env = environ.Env()

# Read .env file if present (optional in dev)
environ.Env.read_env(env_file=".env", overwrite=False)

DEBUG = True

ALLOWED_HOSTS = ["*"]

# Deterministic Fernet key for dev / pytest only — never use this value in
# staging or production. The dev settings module is fenced by
# _assert_dev_environment_safe above; production reads its key from a
# Kubernetes Secret via the Helm chart and never falls through to this default.
INTEGRATION_ENCRYPTION_KEY = "cNHot7PnbAHGIuY4zUht8FwB5wYGv06O7ppzGyhzR84="

# In dev, allow unauthenticated access to the API for ease of local testing.
REST_FRAMEWORK = {
    **REST_FRAMEWORK,
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.AllowAny"],
}


# Detailed SQL logging in dev
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {
        "console": {"class": "logging.StreamHandler"},
    },
    "root": {
        "handlers": ["console"],
        "level": "WARNING",
    },
    "loggers": {
        "django.db.backends": {
            "handlers": ["console"],
            "level": env("SQL_LOG_LEVEL", default="WARNING"),
            "propagate": False,
        },
    },
}
