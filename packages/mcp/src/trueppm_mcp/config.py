"""Runtime configuration for the TruePPM MCP server.

All settings come from the environment so the server can be spawned as a local
subprocess by an AI client (Claude Desktop and the like) with no config file on
disk. The bearer token is treated as a secret throughout: it is never logged and
never included in an exception message or ``repr`` (ADR-0186 §E/§I).
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field

#: REST API mount point appended to the instance base URL when absent.
DEFAULT_API_PATH = "/api/v1"

#: Environment variable holding the TruePPM instance base URL.
ENV_API_URL = "TRUEPPM_API_URL"
#: Environment variable holding the personal ``mcp:read`` API token (``tppm_<64-hex>``).
#: The MCP read surface accepts only owner-scoped (personal) tokens, minted with the
#: ``mcp:read`` scope and an expiry — see the package README.
ENV_API_TOKEN = "TRUEPPM_API_TOKEN"  # noqa: S105 — variable *name*, not a secret


class ConfigError(RuntimeError):
    """Raised when required configuration is missing or malformed.

    The message states only *which* variable is absent — never the token value.
    """


@dataclass(frozen=True)
class Settings:
    """Resolved server settings.

    Attributes:
        api_base_url: Fully-qualified base URL for the v1 REST API, for example
            ``https://ppm.example.com/api/v1``.
        token: The ``tppm_<64-hex>`` bearer token. A secret — excluded from the
            generated ``repr`` so it cannot leak into a stack trace or log line.
    """

    api_base_url: str
    token: str = field(repr=False)

    def __repr__(self) -> str:  # pragma: no cover — trivial, exercised by test
        return f"Settings(api_base_url={self.api_base_url!r}, token=<redacted>)"

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> Settings:
        """Build settings from the process environment.

        Args:
            environ: Mapping to read from; defaults to ``os.environ``. Injectable
                so tests need not mutate global process state.

        Returns:
            A frozen :class:`Settings` instance.

        Raises:
            ConfigError: If either required variable is absent or blank.
        """
        env = os.environ if environ is None else environ
        raw_url = (env.get(ENV_API_URL) or "").strip()
        token = (env.get(ENV_API_TOKEN) or "").strip()
        if not raw_url:
            raise ConfigError(
                f"{ENV_API_URL} is required (the base URL of your TruePPM instance, "
                "e.g. https://ppm.example.com)."
            )
        if not token:
            raise ConfigError(
                f"{ENV_API_TOKEN} is required (a personal access token with the "
                "'mcp:read' scope and an expiry, minted in Personal Settings)."
            )
        return cls(api_base_url=_compose_base_url(raw_url), token=token)


def _compose_base_url(raw_url: str) -> str:
    """Normalize an instance URL to its ``/api/v1`` base, idempotently."""
    base = raw_url.rstrip("/")
    if base.endswith(DEFAULT_API_PATH):
        return base
    return f"{base}{DEFAULT_API_PATH}"
