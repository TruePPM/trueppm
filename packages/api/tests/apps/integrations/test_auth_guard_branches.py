"""Direct-call coverage for the defense-in-depth auth guards (#1516).

These branches are normally unreachable through the HTTP surface because an
``IsAuthenticated`` / ``IsProjectMember`` permission class rejects an anonymous
request before the view body runs. They exist as a second, code-level boundary:
if a future refactor drops or reorders a permission class, the queryset must
still fail closed (empty / 403) rather than leak another user's rows.

A permission class can be removed without any test noticing, so these guards are
exercised by calling the view methods directly with an anonymous request — the
only way to reach the branch — rather than through the client (which the
permission layer short-circuits first).
"""

from __future__ import annotations

import pytest
from django.contrib.auth.models import AnonymousUser
from rest_framework import status
from rest_framework.test import APIRequestFactory

from trueppm_api.apps.integrations.throttles import TaskLinkRefreshThrottle
from trueppm_api.apps.integrations.views import (
    IntegrationCredentialViewSet,
    TaskLinkViewSet,
)

pytestmark = pytest.mark.django_db


def _anonymous_request():
    request = APIRequestFactory().get("/")
    request.user = AnonymousUser()
    return request


def test_credential_queryset_fails_closed_for_anonymous_user() -> None:
    """``get_queryset`` returns no rows when the caller is not authenticated.

    Guards the ``IntegrationCredential`` viewset against a dropped
    ``IsAuthenticated`` permission — the queryset is the single per-user
    boundary, so it must yield nothing rather than every user's credentials.
    """
    view = IntegrationCredentialViewSet()
    view.request = _anonymous_request()

    assert list(view.get_queryset()) == []


def test_task_link_queryset_fails_closed_for_anonymous_user() -> None:
    """``TaskLinkViewSet.get_queryset`` returns no rows for an anonymous caller.

    The anonymous branch returns before the URL kwargs are read, so no
    ``project_pk``/``task_pk`` are needed to reach it.
    """
    view = TaskLinkViewSet()
    view.request = _anonymous_request()

    assert list(view.get_queryset()) == []


def test_task_link_refresh_returns_403_for_anonymous_user() -> None:
    """The refresh action returns 403 before touching the object for anon users."""
    view = TaskLinkViewSet()
    request = _anonymous_request()

    response = view.refresh(request)

    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_refresh_throttle_fails_open_without_a_user_id() -> None:
    """The per-user refresh throttle allows the request when there is no user id.

    Keyed on the authenticated user's pk; an anonymous principal (pk ``None``)
    has no bucket, so the throttle must fail open rather than key on ``None`` and
    rate-limit every anonymous caller into one shared bucket.
    """
    throttle = TaskLinkRefreshThrottle()
    request = _anonymous_request()

    # ``view`` is unused on this branch — the guard returns before it is read.
    assert throttle.allow_request(request, view=None) is True  # type: ignore[arg-type]
