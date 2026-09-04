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
from pathlib import Path
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
from .base import BASE_DIR, DATABASES, REST_FRAMEWORK  # noqa: E402

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
    # Re-add SessionAuthentication on top of base's posture (#2248) so the test
    # suite's `client.force_login()` populates request.user without minting a JWT.
    # Never loaded in staging/prod (fenced by _assert_dev_environment_safe). Keeps
    # base's OwnerScopedApiTokenAuthentication entry (#2547) so PAT-authenticated
    # requests in the test suite exercise the real production auth wiring.
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "trueppm_api.apps.projects.authentication.OwnerScopedApiTokenAuthentication",
        "rest_framework_simplejwt.authentication.JWTAuthentication",
        "rest_framework.authentication.SessionAuthentication",
    ],
}

# The refresh cookie must work over plain HTTP on localhost — a Secure cookie is
# dropped by the browser on http://. Production keeps the base default (True).
AUTH_REFRESH_COOKIE_SECURE = False

# base.py defaults MEDIA_ROOT to /var/lib/trueppm/media — the path the chart and
# compose mount a writable volume at (#3184). Nothing creates that path on a
# developer workstation, and pytest runs under this module, so keep uploads
# inside the checkout. BASE_DIR is packages/api/src, so `.parent` lands on
# packages/api/media/, which .gitignore has already carried since #817.
MEDIA_ROOT = Path(env("TRUEPPM_MEDIA_ROOT", default=str(BASE_DIR.parent / "media")))

# WhiteNoise (base.py MIDDLEWARE) serves static from STATIC_ROOT, which requires a
# `collectstatic` run. In dev and under pytest we want /static/ to work without
# that step, so serve straight from the staticfiles *finders* (each app's static/
# dir, including drf-spectacular-sidecar's bundles) and re-scan on every request so
# newly added files appear without a restart. Production keeps the base behavior:
# collectstatic into STATIC_ROOT, which WhiteNoise serves with far-future caching.
WHITENOISE_USE_FINDERS = True
WHITENOISE_AUTOREFRESH = True

# Local dev / pytest run in a single process, so per-process memory is a
# sufficient (and dependency-free) cache for the OIDC login state and the DRF
# throttles. Production uses the Redis-backed cache from base.py. Overriding here
# keeps `pytest` from requiring a separate Valkey cache db (the testcontainers
# fixture provisions PostgreSQL only).
CACHES = {
    "default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"},
}


# Detailed SQL logging in dev.
#
# This override replaces base.py's build_logging_config() output entirely, so the
# UTC-timestamp fix in that function (#1952) does not reach dev. That is fine and
# intentional: these handlers declare no "formatter", so they use logging's
# default (message-only) formatter, which emits no %(asctime)s at all — there is
# no log timestamp here to render in the wrong timezone. If a formatter with
# %(asctime)s is ever added to this dev config, mirror the base fix
# (logging.Formatter.converter = time.gmtime) so dev timestamps stay UTC too.
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

# ---------------------------------------------------------------------------
# Per-worktree test DB (scripts/wt)
# ---------------------------------------------------------------------------
# `scripts/wt new` writes TRUEPPM_TEST_DB=test_trueppm_wt_<slug> into each
# worktree's .envrc so N parallel worktrees each create and drop their OWN test
# database instead of racing on one shared `test_trueppm`. This removes the need
# for the out-of-band flock mutex that serialized parallel pytest runs (and that
# flock(1) can't provide on macOS). Test-only: like TEST["TEMPLATE"] above, the
# TEST["NAME"] key is read solely by Django's test-database creation, never by a
# running server.


def _apply_test_db_name(databases: dict[str, Any], env: Mapping[str, str]) -> None:
    """Point Django's test-DB creation at a per-worktree database, if requested.

    Reads ``TRUEPPM_TEST_DB`` from ``env`` and, when set, writes it to
    ``databases["default"]["TEST"]["NAME"]`` so a worktree's ``pytest`` run builds
    an isolated test database instead of racing on the shared one. A no-op when the
    variable is unset or empty. ``databases``/``env`` are injectable so the logic
    is unit-testable without reloading the settings module or mutating the process
    environment (mirrors ``_assert_dev_environment_safe``).
    """
    name = env.get("TRUEPPM_TEST_DB")
    if not name:
        return
    databases["default"].setdefault("TEST", {})
    databases["default"]["TEST"]["NAME"] = name


_apply_test_db_name(DATABASES, os.environ)


# ---------------------------------------------------------------------------
# Fast password hashing under pytest (#3391)
# ---------------------------------------------------------------------------
# Django 5.2 defaults to PBKDF2-SHA256 at 1,000,000 iterations. That cost is the
# whole point in production and pure waste in the test suite, which makes 1,054
# `create_user(..., password=...)` calls and asserts nothing about hash strength.
# Measured: 76.3ms per PBKDF2 hash vs 0.026ms for MD5 — 2,899x, several minutes
# of every api:test run spent proving nothing.
#
# Gated on pytest actually being loaded rather than applied to all of dev: a
# local `runserver` keeps the production hasher, so a developer never logs in
# against a weaker algorithm than the one they ship. `"pytest" in sys.modules`
# is ONE of the four signals `_assert_dev_environment_safe` trusts above, not
# the same test — that guard also accepts PYTEST_CURRENT_TEST from the env,
# which this deliberately does not, because it is set per test rather than at
# settings-import time. The gap is worth naming: a subprocess spawned from a
# test inherits PYTEST_CURRENT_TEST but not the parent's module table, so it
# would load PBKDF2 while its parent used MD5, and a cross-process
# check_password against an md5 hash would raise "Unknown password hashing
# algorithm". Latent, not live — the suite's only subprocess use is a mocked
# Popen — but a future test that really shells out has to know this.
#
# Where settings.dev actually loads, so the next reader does not have to guess:
# the local compose stack (docker-compose.yml, three services, which set
# TRUEPPM_ALLOW_DEV_SETTINGS=1), every api:* CI job, the Makefile, and
# scripts/export-openapi.sh — plus pytest. It is routine infrastructure, not a
# rare manual opt-in. The branch is unreachable in all of those but pytest for
# one reason: packages/api/Dockerfile installs `api[c]`/`api[binary]` and never
# `api[dev]`, and uninstalls pip, so the runtime image has no pytest to import.
# Every deployed path (helm values, docker-compose.prod, docker-compose.demo)
# loads settings.prod and never reaches this file at all.
#
# The list is deliberately a SINGLE entry. Adding PBKDF2 back as a fallback
# looks safer and is not: `hasher_changed` would then be True on every login, so
# check_password's setter fires and ModelBackend REWRITES stored PBKDF2 hashes
# as MD5. One entry fails those rows closed instead of silently downgrading them.
#
# DX note: with --reuse-db, a test database created before this change still
# holds PBKDF2 hashes, which no longer verify (Django catches the unknown-hasher
# ValueError and returns False rather than raising). That reads as an auth
# regression; it is a stale test DB. Use --create-db once.
#
# Asserted by tests/test_password_hashers.py, including the invariant this
# gate rests on: nothing under src/ may import pytest.


def _use_fast_password_hashers(modules: Mapping[str, Any]) -> bool:
    """Report whether the test-only fast password hasher should be installed.

    Injectable so the predicate is unit-testable without mutating the global
    module table (mirrors ``_assert_dev_environment_safe``).
    """
    return "pytest" in modules


if _use_fast_password_hashers(sys.modules):
    PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]
