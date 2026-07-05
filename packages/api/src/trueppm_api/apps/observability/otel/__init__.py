"""OpenTelemetry foundation for the OSS API (ADR-0223, epic #707, issue #708).

Public surface — stable across releases (additive-only), imported by OSS Phase
1/2 instrumentation and by the proprietary ``trueppm-enterprise`` edition. OSS
never imports enterprise; enterprise imports this module (one-way boundary).

* :func:`bootstrap` — install the providers at startup (called from the app's
  ``ready()``); a strict no-op unless an OTLP endpoint is configured.
* :func:`register_provider_hook` / :class:`OTelBootstrapContext` — the enterprise
  extension point.
* :func:`get_tracer` / :func:`get_meter` — stable accessors over the OTel API.
* :func:`is_enabled` — whether export is active.
* :mod:`attributes` — the ``trueppm.*`` attribute-key convention.
"""

from __future__ import annotations

from . import attributes
from .provider import (
    OTelBootstrapContext,
    ProviderHook,
    bootstrap,
    get_meter,
    get_tracer,
    is_enabled,
    register_provider_hook,
)

__all__ = [
    "OTelBootstrapContext",
    "ProviderHook",
    "attributes",
    "bootstrap",
    "get_meter",
    "get_tracer",
    "is_enabled",
    "register_provider_hook",
]
