"""Origin validation for the WebSocket handshake (#1729)."""

from __future__ import annotations

from typing import Any

from channels.security.websocket import OriginValidator
from django.conf import settings


class TruePPMOriginValidator(OriginValidator):  # type: ignore[misc]
    """Accept ``ALLOWED_HOSTS`` plus ``TRUEPPM_WS_ALLOWED_ORIGINS``, with a policy for no Origin.

    Channels' stock ``AllowedHostsOriginValidator`` refuses a handshake that carries no
    ``Origin`` header outright. A browser always sends one, so the missing-header case
    is a script, integration or test client -- not a cross-site hijack -- and refusing
    it would break the documented non-browser use of the ticket flow. It is allowed
    unless ``TRUEPPM_WS_REQUIRE_ORIGIN`` is set. Allowed origins are resolved per
    handshake (not at import) so settings overrides apply.
    """

    def __init__(self, application: Any) -> None:
        super().__init__(application, [])

    @property
    def allowed_origins(self) -> list[str]:
        hosts = list(settings.ALLOWED_HOSTS)
        if settings.DEBUG and not hosts:
            hosts = ["localhost", "127.0.0.1", "[::1]"]
        return hosts + list(settings.TRUEPPM_WS_ALLOWED_ORIGINS)

    @allowed_origins.setter
    def allowed_origins(self, value: list[str]) -> None:  # set by the base __init__
        return None

    def valid_origin(self, parsed_origin: Any) -> bool:
        if parsed_origin is None:
            return not settings.TRUEPPM_WS_REQUIRE_ORIGIN
        return bool(self.validate_origin(parsed_origin))
