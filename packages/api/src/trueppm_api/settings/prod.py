"""Production settings — security hardened, secrets from environment."""

from __future__ import annotations

import environ

from .base import *  # noqa: F403
from .base import DATABASES

env = environ.Env()

DEBUG = False

ALLOWED_HOSTS = env.list("ALLOWED_HOSTS")

SECRET_KEY = env("SECRET_KEY")  # required; no default in prod

# Persistent connections for production load.
DATABASES["default"]["CONN_MAX_AGE"] = 600

# Security headers.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_HSTS_SECONDS = 31536000
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
