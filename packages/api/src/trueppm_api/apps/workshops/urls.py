"""URL routing for the workshops app."""

from __future__ import annotations

from django.urls import path

from trueppm_api.apps.workshops.views import (
    WorkshopCurrentView,
    WorkshopEndView,
    WorkshopForceEndView,
    WorkshopStartView,
)

urlpatterns = [
    path(
        "projects/<pk>/workshop/start/",
        WorkshopStartView.as_view(),
        name="workshop-start",
    ),
    path(
        "projects/<pk>/workshop/end/",
        WorkshopEndView.as_view(),
        name="workshop-end",
    ),
    path(
        "projects/<pk>/workshop/force-end/",
        WorkshopForceEndView.as_view(),
        name="workshop-force-end",
    ),
    path(
        "projects/<pk>/workshop/current/",
        WorkshopCurrentView.as_view(),
        name="workshop-current",
    ),
]
