"""Development settings — DEBUG on, relaxed auth, local service URLs."""

from __future__ import annotations

import environ

from .base import *  # noqa: F403
from .base import REST_FRAMEWORK

env = environ.Env()

# Read .env file if present (optional in dev)
environ.Env.read_env(env_file=".env", overwrite=False)

DEBUG = True

ALLOWED_HOSTS = ["*"]

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
