"""WebSocket URL routing — registered consumers are added here as features land."""

from __future__ import annotations

from django.urls import path

# WebSocket consumers will be registered here as real-time features are built.
# Example: path("ws/projects/<uuid:project_id>/", ProjectConsumer.as_asgi())
websocket_urlpatterns: list[path] = []  # type: ignore[type-arg]
