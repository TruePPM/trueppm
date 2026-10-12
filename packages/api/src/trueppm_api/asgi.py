"""ASGI application — Django Channels ProtocolTypeRouter."""

from __future__ import annotations

import os

from channels.generic.websocket import WebsocketConsumer
from channels.routing import ProtocolTypeRouter, URLRouter
from django.core.asgi import get_asgi_application
from django.urls import re_path

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "trueppm_api.settings.dev")

# Initialize Django ASGI app early so AppRegistry is ready before Channels.
django_asgi_app = get_asgi_application()

from trueppm_api.routing import websocket_urlpatterns  # noqa: E402


class _CloseConsumer(WebsocketConsumer):  # type: ignore[misc]
    """Catch-all consumer that immediately closes unmatched WebSocket paths.

    Deliberately closes BEFORE accept, unlike ``ProjectConsumer``'s policy refusals
    (#4375): Channels turns a pre-accept close into an HTTP 403 on the upgrade, so a
    browser sees close code 1006 and never the 4404 below. That is the intent — no
    shipped client dials an unrouted path, so there is no code for one to act on,
    and refusing at the upgrade keeps arbitrary-path probes off the accept path.
    """

    def connect(self) -> None:
        self.close(code=4404)


# WebSocket spans (#709): DjangoInstrumentor covers HTTP through Django's request
# handler, but the Channels WebSocket path never reaches that handler. Wrap the
# websocket branch ONLY with the ASGI middleware so connect/receive get a span —
# wrapping the whole router would double-span every HTTP request. get_asgi_application()
# above already ran ObservabilityConfig.ready(), so the provider is bootstrapped and
# wrap_asgi_app() is a strict no-op unless telemetry is enabled.
from trueppm_api.apps.observability import otel  # noqa: E402

websocket_app = URLRouter([*websocket_urlpatterns, re_path(r".*", _CloseConsumer.as_asgi())])

application = ProtocolTypeRouter(
    {
        "http": django_asgi_app,
        "websocket": otel.wrap_asgi_app(websocket_app),
    }
)
