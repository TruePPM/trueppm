"""WebSocket URL routing — registered consumers are added here as features land."""

from __future__ import annotations

from django.urls import path

from trueppm_api.apps.sync.consumers import ProjectConsumer
from trueppm_api.apps.workshops.consumers import WorkshopConsumer

websocket_urlpatterns = [
    path("ws/v1/projects/<uuid:pk>/", ProjectConsumer.as_asgi()),
    path("ws/v1/projects/<uuid:pk>/workshop/", WorkshopConsumer.as_asgi()),
]
