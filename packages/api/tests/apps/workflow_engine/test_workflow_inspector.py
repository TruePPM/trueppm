"""Operator read path for workflow instances (#2994)."""

from __future__ import annotations

from datetime import timedelta

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.workflow_engine.models import (
    WorkflowInstance,
    WorkflowOutboxRow,
    WorkflowOutboxStatus,
    WorkflowStatus,
)

pytestmark = pytest.mark.django_db
User = get_user_model()
BASE = "/api/v1/admin/workflows"


def _client(**user_kwargs: bool) -> APIClient:
    user = User.objects.create_user(
        username=f"u{User.objects.count()}", password="pw", **user_kwargs
    )
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _instance(status: str = WorkflowStatus.FAILED, name: str = "demo") -> WorkflowInstance:
    return WorkflowInstance.objects.create(
        name=name,
        status=status,
        idempotency_key=f"k-{WorkflowInstance.objects.count()}",
        error="RuntimeError('boom')" if status == WorkflowStatus.FAILED else "",
        input={"secret": "do-not-leak"},
    )


def test_operator_sees_which_workflow_failed_and_why() -> None:
    inst = _instance()
    WorkflowOutboxRow.objects.create(
        workflow=inst,
        step_name="0",
        status=WorkflowOutboxStatus.DEAD,
        attempt_count=3,
        failure_reason="error",
        error_message="RuntimeError('boom')",
    )
    res = _client(is_superuser=True).get(f"{BASE}/{inst.id}/")
    assert res.status_code == 200
    assert res.data["status"] == "failed"
    assert res.data["terminal"] is True
    assert res.data["retrying"] is False
    assert res.data["current_step"]["failure_reason"] == "error"
    assert res.data["current_step"]["attempt_count"] == 3
    assert "input" not in res.data


def test_retrying_workflow_reports_next_attempt() -> None:
    inst = _instance(status=WorkflowStatus.RUNNING)
    WorkflowOutboxRow.objects.create(
        workflow=inst,
        step_name="0",
        status=WorkflowOutboxStatus.DEAD,
        next_attempt_at=timezone.now() + timedelta(seconds=60),
    )
    res = _client(is_superuser=True).get(f"{BASE}/{inst.id}/")
    assert res.data["terminal"] is False
    assert res.data["retrying"] is True
    assert res.data["current_step"]["next_attempt_at"] is not None


def test_list_filters_by_status_and_name() -> None:
    _instance(status=WorkflowStatus.FAILED, name="a")
    _instance(status=WorkflowStatus.COMPLETED, name="b")
    client = _client(is_superuser=True)
    res = client.get(f"{BASE}/?status=failed")
    assert [r["name"] for r in res.data["results"]] == ["a"]
    res = client.get(f"{BASE}/?name=b")
    assert [r["status"] for r in res.data["results"]] == ["completed"]


def test_non_operator_is_refused_and_anonymous_is_unauthenticated() -> None:
    inst = _instance()
    assert _client().get(f"{BASE}/{inst.id}/").status_code == 403
    assert _client(is_staff=True).get(BASE + "/").status_code == 403
    assert APIClient().get(f"{BASE}/{inst.id}/").status_code in (401, 403)


def test_read_only_no_write_methods() -> None:
    inst = _instance()
    client = _client(is_superuser=True)
    assert client.post(BASE + "/", {}, format="json").status_code == 405
    assert client.delete(f"{BASE}/{inst.id}/").status_code == 405


def test_list_query_count_is_constant() -> None:
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    client = _client(is_superuser=True)
    for i in range(3):
        WorkflowOutboxRow.objects.create(workflow=_instance(name=f"n{i}"), step_name="0")
    with CaptureQueriesContext(connection) as small:
        client.get(BASE + "/")
    for i in range(5):
        WorkflowOutboxRow.objects.create(workflow=_instance(name=f"m{i}"), step_name="0")
    with CaptureQueriesContext(connection) as large:
        client.get(BASE + "/")
    assert len(large) == len(small)
