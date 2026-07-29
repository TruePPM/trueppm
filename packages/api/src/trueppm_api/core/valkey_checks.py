"""Startup validation for the Valkey topology settings (ADR-0716, #2554).

Every Valkey consumer in the app fails **open** on a broker error — a cache or
throttle outage must not become an application outage. That policy is correct,
and it is exactly why a misconfigured Sentinel block must be caught here: a bad
``TRUEPPM_VALKEY_*`` combination would otherwise produce a deploy that starts
cleanly, serves traffic, and silently degrades every throttle and the OIDC login
state to a no-op. Refusing to boot is the honest outcome.

Registered from ``apps/access/apps.py::ready()``, the same path
``core.security_checks`` uses.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from django.conf import settings
from django.core.checks import Error, Info, register
from django.core.checks import Warning as CheckWarning

from trueppm_api.core.valkey_config import DEFAULT_REDIS_URL, parse_sentinels

if TYPE_CHECKING:
    from collections.abc import Sequence

    from django.apps.config import AppConfig
    from django.core.checks.messages import CheckMessage


@register()
def check_valkey_topology(
    app_configs: Sequence[AppConfig] | None = None,
    **kwargs: Any,
) -> list[CheckMessage]:
    """Validate the ``TRUEPPM_VALKEY_*`` settings as a coherent whole."""
    errors: list[CheckMessage] = []

    raw = getattr(settings, "VALKEY_SENTINELS_RAW", "")
    if not raw.strip():
        return errors  # Single-endpoint mode — nothing to validate.

    try:
        parse_sentinels(raw)
    except ValueError as exc:
        errors.append(
            Error(
                f"TRUEPPM_VALKEY_SENTINELS is malformed: {exc}.",
                hint=(
                    "Use a comma-separated host:port list, e.g. "
                    "'sentinel-0:26379,sentinel-1:26379,sentinel-2:26379'."
                ),
                id="trueppm.valkey.E002",
            )
        )
        return errors  # Master-name check below is noise until this parses.

    if not getattr(settings, "VALKEY_MASTER_NAME", ""):
        errors.append(
            Error(
                "TRUEPPM_VALKEY_SENTINELS is set but TRUEPPM_VALKEY_MASTER_NAME is empty.",
                hint=(
                    "Set TRUEPPM_VALKEY_MASTER_NAME to the name the Sentinels monitor "
                    "the primary under (the first argument of 'sentinel monitor' in "
                    "sentinel.conf, commonly 'mymaster')."
                ),
                id="trueppm.valkey.E001",
            )
        )

    # Info, not Warning: operators legitimately run `manage.py check --deploy
    # --fail-level WARNING` in CI, and an experimental-status notice must not fail
    # their pipeline. It still puts the caveat in front of anyone who never read the
    # HA page — which is the whole point of surfacing it at boot.
    errors.append(
        Info(
            "Valkey Sentinel support is EXPERIMENTAL in 0.4: the wiring is unit-tested "
            "but has not been verified against a live Sentinel quorum performing a real "
            "failover.",
            hint=(
                "Validate a full failover in a staging environment that mirrors "
                "production before depending on this, and report results on "
                "https://gitlab.com/trueppm/trueppm/-/issues/2554. A replicated primary "
                "behind one stable endpoint (REDIS_URL) is the already-proven path."
            ),
            id="trueppm.valkey.I001",
        )
    )

    if getattr(settings, "REDIS_URL", DEFAULT_REDIS_URL) != DEFAULT_REDIS_URL:
        errors.append(
            CheckWarning(
                "REDIS_URL is set to a non-default value but Sentinel mode is active, "
                "so REDIS_URL is ignored.",
                hint=(
                    "In Sentinel mode the primary is resolved from "
                    "TRUEPPM_VALKEY_SENTINELS / TRUEPPM_VALKEY_MASTER_NAME. Unset "
                    "REDIS_URL to make it clear which one is in effect."
                ),
                id="trueppm.valkey.W001",
            )
        )

    return errors
