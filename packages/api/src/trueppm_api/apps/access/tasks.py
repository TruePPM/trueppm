"""Celery tasks for the access app — JWT blacklist maintenance (#910)."""

from __future__ import annotations

import logging
from typing import Any

from django.apps import apps as django_apps
from django.core.management import call_command
from django.db import OperationalError

from trueppm_api.core.idempotent import idempotent_task

logger = logging.getLogger(__name__)

_BLACKLIST_APP = "rest_framework_simplejwt.token_blacklist"


@idempotent_task(
    lock_key_template="flush_expired_blacklisted_tokens",
    lock_ttl=300,
    on_contention="skip",
    name="access.flush_expired_blacklisted_tokens",
    autoretry_for=(ConnectionError, OperationalError),
    retry_backoff=60,
    retry_backoff_max=600,
    retry_jitter=True,
    max_retries=3,
    soft_time_limit=120,
    time_limit=180,
    acks_late=True,
)
def flush_expired_blacklisted_tokens(self: object) -> dict[str, Any]:
    """Delete OutstandingToken/BlacklistedToken rows whose tokens have expired.

    Registered in CELERY_BEAT_SCHEDULE to run nightly. Without it the blacklist
    tables grow by one OutstandingToken per login for the life of the deployment;
    flushing expired rows bounds them to roughly the active-session window.

    Wraps simplejwt's ``flushexpiredtokens`` management command. No-ops when the
    ``token_blacklist`` app is not installed (the lean-OSS opt-out described in
    settings.SIMPLE_JWT) so the beat schedule entry is safe to ship unconditionally.
    """
    if not django_apps.is_installed(_BLACKLIST_APP):
        logger.info("flush_expired_blacklisted_tokens: token_blacklist not installed, skipping")
        return {"status": "skipped", "reason": "token_blacklist app not installed"}

    call_command("flushexpiredtokens")
    logger.info("flush_expired_blacklisted_tokens: flushed expired blacklist rows")
    return {"status": "ok"}
