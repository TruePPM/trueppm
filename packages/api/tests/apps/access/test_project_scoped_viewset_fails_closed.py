"""``ProjectScopedViewSet.get_queryset`` fails CLOSED for models with no project path (#4007).

The base used to end in ``return qs`` for any model lacking a ``project`` /
``predecessor`` FK, so a new task-scoped subclass calling ``super().get_queryset()``
was silently unscoped: a cross-project IDOR with no warning. The default is now
``qs.none()``; deliberately org-level viewsets opt in with ``unscoped_queryset``.
"""

from __future__ import annotations

import pytest
from rest_framework import viewsets
from rest_framework.test import APIRequestFactory

from trueppm_api.apps.access.permissions import ProjectScopedViewSet
from trueppm_api.apps.projects.models import Calendar, TaskRecurrenceRule
from trueppm_api.apps.projects.views import CalendarViewSet, TaskRecurrenceRuleViewSet

pytestmark = pytest.mark.django_db


def _viewset(cls, user):
    request = APIRequestFactory().get("/")
    request.user = user
    view = cls()
    view.request = request
    view.action = "list"
    view.kwargs = {}
    view.format_kwarg = None
    return view


class _NoProjectPathViewSet(ProjectScopedViewSet, viewsets.ReadOnlyModelViewSet):
    queryset = Calendar.objects.all()


class _OptedInViewSet(_NoProjectPathViewSet):
    unscoped_queryset = True


def test_default_is_fail_closed_for_model_without_project_path(django_user_model):
    user = django_user_model.objects.create_user("u4007", password="x")
    Calendar.objects.create(name="Org calendar")
    assert _viewset(_NoProjectPathViewSet, user).get_queryset().count() == 0


def test_explicit_opt_in_returns_unfiltered(django_user_model):
    user = django_user_model.objects.create_user("u4007b", password="x")
    Calendar.objects.create(name="Org calendar")
    assert _viewset(_OptedInViewSet, user).get_queryset().count() == 1


def test_known_unscoped_viewsets_declare_the_opt_in():
    # CalendarViewSet builds its own queryset and never reaches the base fallback,
    # so this only pins the declared intent, not behavior (the list test below does).
    assert CalendarViewSet.unscoped_queryset is True, "Calendar must declare its intent"
    # Reaches its project via `task`; applies its own membership filter after super().
    assert TaskRecurrenceRuleViewSet.unscoped_queryset is True
    assert TaskRecurrenceRule._meta.get_field("task")


def test_calendar_list_unchanged_for_a_non_member(django_user_model):
    from rest_framework.test import APIClient

    user = django_user_model.objects.create_user("u4007c", password="x")
    Calendar.objects.create(name="Shared library entry")
    client = APIClient()
    client.force_authenticate(user)
    r = client.get("/api/v1/calendars/")
    assert r.status_code == 200
    body = r.json()
    rows = body["results"] if isinstance(body, dict) else body
    assert "Shared library entry" in {c["name"] for c in rows}


def test_mcp_filter_fails_closed_for_model_without_project_path(django_user_model):
    """A QUERYSET-scoped MCP mixin on a model with no project path returns none (#4007)."""
    from types import SimpleNamespace
    from unittest.mock import patch

    from trueppm_api.apps.access.permissions import McpReadableViewMixin

    Calendar.objects.create(name="Org calendar")
    view = McpReadableViewMixin()
    view.request = SimpleNamespace(auth=None)
    with patch(
        "trueppm_api.apps.projects.mcp_settings.mcp_visible_project_ids",
        return_value=set(),
    ):
        assert view._mcp_filter_queryset(Calendar.objects.all()).count() == 0
