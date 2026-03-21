"""ASGI application — Django Channels ProtocolTypeRouter."""

from __future__ import annotations

import os

from channels.routing import ProtocolTypeRouter, URLRouter
from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "trueppm_api.settings.dev")

# Initialize Django ASGI app early so AppRegistry is ready before Channels.
django_asgi_app = get_asgi_application()

from trueppm_api.routing import websocket_urlpatterns  # noqa: E402

application = ProtocolTypeRouter(
    {
        "http": django_asgi_app,
        "websocket": URLRouter(websocket_urlpatterns),
    }
)
