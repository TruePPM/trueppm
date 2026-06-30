"""trueppm-mcp — read-only Model Context Protocol server for self-hosted TruePPM.

A thin protocol adapter that talks to TruePPM only over HTTP (ADR-0186): it never
imports Django, never touches the ORM or database, and never imports from the
proprietary enterprise repo. RBAC is enforced once, at the API layer.
"""

from __future__ import annotations

from trueppm_mcp.client import ApiError, AuthError, TruePPMClient
from trueppm_mcp.config import ConfigError, Settings
from trueppm_mcp.server import build_server

__version__ = "0.4.0a0"

__all__ = [
    "ApiError",
    "AuthError",
    "ConfigError",
    "Settings",
    "TruePPMClient",
    "__version__",
    "build_server",
]
