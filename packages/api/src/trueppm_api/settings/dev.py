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
from .base import DATABASES, REST_FRAMEWORK  # noqa: E402

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
# Throttle classes/rates are inherited from base settings via the spread below;
# this dev-only module merely relaxes the permission classes. Fenced by
# _assert_dev_environment_safe — never loaded in staging or production.
REST_FRAMEWORK = {  # nosemgrep: missing-throttle-config
    **REST_FRAMEWORK,  # nosemgrep: missing-throttle-config
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.AllowAny"],
}

# The refresh cookie must work over plain HTTP on localhost — a Secure cookie is
# dropped by the browser on http://. Production keeps the base default (True).
AUTH_REFRESH_COOKIE_SECURE = False


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

# ---------------------------------------------------------------------------
# CI test-DB prewarm (#688)
# ---------------------------------------------------------------------------
# When the api:test CI shards have loaded a `migrated` template database from
# the schema dump produced by api:testdb-dump, clone each pytest-xdist worker
# DB from it (CREATE DATABASE ... TEMPLATE, a fast file copy) and skip the
# per-worker migration replay. The template already carries the ltree
# extension, the wbs_path GiST index, and the data backfills, so this is
# equivalent to a full migrate — unlike --no-migrations, which skips the
# RunSQL that creates the ltree extension and breaks test-DB creation.
#
# Gated on the CI-set env var: a local `pytest` run (no `migrated` template
# present) leaves DATABASES untouched and builds its test DB by replaying
# migrations exactly as before. This is test-only — the TEST sub-dict is read
# solely by Django's test-database creation, never by a running server.
_test_db_template = os.environ.get("TRUEPPM_TEST_DB_TEMPLATE")
if _test_db_template:
    DATABASES["default"].setdefault("TEST", {})
    DATABASES["default"]["TEST"]["TEMPLATE"] = _test_db_template
    DATABASES["default"]["TEST"]["MIGRATE"] = False
