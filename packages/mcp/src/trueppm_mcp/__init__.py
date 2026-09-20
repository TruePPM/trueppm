"""trueppm-mcp — read-only Model Context Protocol server for self-hosted TruePPM.

A thin protocol adapter that talks to TruePPM only over HTTP (ADR-0186): it never
imports Django, never touches the ORM or database, and never imports from the
proprietary enterprise repo. RBAC is enforced once, at the API layer.
"""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _pkg_version

from trueppm_mcp.client import (
    ApiError,
    AuthError,
    NonAgentTokenError,
    RateLimitError,
    TruePPMClient,
)
from trueppm_mcp.config import ConfigError, Settings
from trueppm_mcp.server import build_server

try:
    # Single source of truth: the version is whatever pip installed (set from
    # pyproject.toml at build time), matching trueppm_scheduler's pattern —
    # so this can't freeze at a stale literal the way trueppm_api's did.
    __version__ = _pkg_version("trueppm-mcp")
except PackageNotFoundError:  # running from an un-installed source tree
    __version__ = "0.0.0+unknown"

__all__ = [
    "ApiError",
    "AuthError",
    "ConfigError",
    "NonAgentTokenError",
    "RateLimitError",
    "Settings",
    "TruePPMClient",
    "__version__",
    "build_server",
]
