"""Origin validation for the WebSocket handshake (#1729)."""

from __future__ import annotations

import logging
import time
from typing import Any
from urllib.parse import urlparse

from channels.security.websocket import OriginValidator, WebsocketDenier
from django.conf import settings

logger = logging.getLogger(__name__)

# Denied handshakes are attacker-controlled volume, so the warning is rate-limited
# to one line per interval per process (the count since the last line is included).
_DENY_LOG_INTERVAL = 60.0
_last_deny_log = float("-inf")
_suppressed = 0


def _log_denied(origin: str | None) -> None:
    global _last_deny_log, _suppressed
    now = time.monotonic()
    if now - _last_deny_log < _DENY_LOG_INTERVAL:
        _suppressed += 1
        return
    logger.warning(
        "WebSocket handshake denied: Origin %r not allowed (%d similar suppressed)",
        (origin or "")[:200],
        _suppressed,
    )
    _last_deny_log = now
    _suppressed = 0


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
        try:
            return bool(self.validate_origin(parsed_origin))
        except ValueError:
            # e.g. an Origin whose port is out of range: urlparse().port raises.
            return False

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> Any:
        """Parse Origin defensively: a malformed value is a denial, never a 500."""
        raw: str | None = None
        for name, value in scope.get("headers", []):
            if name == b"origin":
                raw = value.decode("latin1")
                break
        parsed = None
        ok = True
        if raw is not None:
            try:
                parsed = urlparse(raw)
            except ValueError:
                ok = False
        if ok:
            ok = self.valid_origin(parsed)
        if not ok:
            _log_denied(raw)
            return await WebsocketDenier()(scope, receive, send)
        return await self.application(scope, receive, send)
