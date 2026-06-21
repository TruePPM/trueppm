"""Tests for OSS Git-event board-card automation (#329, ADR-0158).

Covers the security boundary (signature pass / fail / missing, secret never
leaked, enabled-only 404), the forward-only transition service (pr.opened →
REVIEW, pr.merged → COMPLETE, no backward move, no-op idempotency), URL→TaskLink
matching (GitHub + GitLab, wrong project), and the project-admin-only config +
rotate-secret endpoints.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.urls import reverse
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.integrations.models import BoardAutomation, TaskLink
from trueppm_api.apps.projects.models import Calendar, Project, Task, TaskStatus

User = get_user_model()

pytestmark = pytest.mark.django_db

SECRET = "s3cr3t-webhook-token"
GITHUB_PR_URL = "https://github.com/acme/api/pull/5"
GITLAB_MR_URL = "https://gitlab.com/acme/api/-/merge_requests/7"


@pytest.fixture(autouse=True)
def _mute_broadcasts() -> object:
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
        yield


@pytest.fixture
def project() -> Project:
    calendar = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="Alpha", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def admin(project: Project) -> object:
    user = User.objects.create_user(username="admin", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    return user


@pytest.fixture
def member(project: Project) -> object:
    user = User.objects.create_user(username="member", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    return user


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(
        project=project, name="Foundation", duration=1, status=TaskStatus.IN_PROGRESS
    )


@pytest.fixture
def automation(project: Project, admin: object) -> BoardAutomation:
    auto = BoardAutomation(project=project, enabled=True, configured_by=admin)
    auto.set_secret(SECRET)
    auto.save()
    return auto


def _github_link(task: Task) -> TaskLink:
    return TaskLink.objects.create(task=task, url=GITHUB_PR_URL, provider="github")


def _gitlab_link(task: Task) -> TaskLink:
    return TaskLink.objects.create(task=task, url=GITLAB_MR_URL, provider="gitlab")


def _github_body(action: str, *, merged: bool = False) -> bytes:
    return json.dumps(
        {
            "action": action,
            "pull_request": {"html_url": GITHUB_PR_URL, "merged": merged},
        }
    ).encode("utf-8")


def _gitlab_body(action: str) -> bytes:
    return json.dumps(
        {
            "object_kind": "merge_request",
            "object_attributes": {"action": action, "url": GITLAB_MR_URL, "id": 42},
        }
    ).encode("utf-8")


def _github_headers(body: bytes, *, secret: str = SECRET, delivery: str = "d1") -> dict[str, str]:
    sig = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return {
        "HTTP_X_GITHUB_EVENT": "pull_request",
        "HTTP_X_HUB_SIGNATURE_256": sig,
        "HTTP_X_GITHUB_DELIVERY": delivery,
    }


def _post(project: Project, body: bytes, headers: dict[str, str]) -> object:
    url = reverse("git-webhook", kwargs={"project_pk": str(project.pk)})
    return APIClient().post(url, data=body, content_type="application/json", **headers)


# --- GitHub happy paths ------------------------------------------------------


def test_github_pr_opened_moves_to_review(
    project: Project, task: Task, automation: BoardAutomation
) -> None:
    _github_link(task)
    body = _github_body("opened")
    resp = _post(project, body, _github_headers(body))
    assert resp.status_code == 200
    assert resp.json()["moved"] is True
    assert resp.json()["to"] == TaskStatus.REVIEW
    task.refresh_from_db()
    assert task.status == TaskStatus.REVIEW


def test_github_pr_merged_moves_to_complete(
    project: Project, task: Task, automation: BoardAutomation
) -> None:
    _github_link(task)
    body = _github_body("closed", merged=True)
    resp = _post(project, body, _github_headers(body))
    assert resp.status_code == 200
    assert resp.json()["to"] == TaskStatus.COMPLETE
    task.refresh_from_db()
    assert task.status == TaskStatus.COMPLETE


def test_github_closed_without_merge_is_noop(
    project: Project, task: Task, automation: BoardAutomation
) -> None:
    _github_link(task)
    body = _github_body("closed", merged=False)
    resp = _post(project, body, _github_headers(body))
    # closed-not-merged is not an actionable event → ignored, card unchanged.
    assert resp.status_code == 200
    assert resp.json()["moved"] is False
    task.refresh_from_db()
    assert task.status == TaskStatus.IN_PROGRESS


# --- GitLab happy paths ------------------------------------------------------


def test_gitlab_mr_open_moves_to_review(
    project: Project, task: Task, automation: BoardAutomation
) -> None:
    _gitlab_link(task)
    body = _gitlab_body("open")
    headers = {"HTTP_X_GITLAB_EVENT": "Merge Request Hook", "HTTP_X_GITLAB_TOKEN": SECRET}
    resp = _post(project, body, headers)
    assert resp.status_code == 200
    assert resp.json()["to"] == TaskStatus.REVIEW
    task.refresh_from_db()
    assert task.status == TaskStatus.REVIEW


def test_gitlab_mr_merge_moves_to_complete(
    project: Project, task: Task, automation: BoardAutomation
) -> None:
    _gitlab_link(task)
    body = _gitlab_body("merge")
    headers = {"HTTP_X_GITLAB_EVENT": "Merge Request Hook", "HTTP_X_GITLAB_TOKEN": SECRET}
    resp = _post(project, body, headers)
    assert resp.status_code == 200
    task.refresh_from_db()
    assert task.status == TaskStatus.COMPLETE


def test_gitlab_wrong_token_is_401(
    project: Project, task: Task, automation: BoardAutomation
) -> None:
    _gitlab_link(task)
    body = _gitlab_body("merge")
    headers = {"HTTP_X_GITLAB_EVENT": "Merge Request Hook", "HTTP_X_GITLAB_TOKEN": "wrong"}
    resp = _post(project, body, headers)
    assert resp.status_code == 401
    task.refresh_from_db()
    assert task.status == TaskStatus.IN_PROGRESS


# --- Signature / security ----------------------------------------------------


def test_invalid_github_signature_is_401_and_no_move(
    project: Project, task: Task, automation: BoardAutomation
) -> None:
    _github_link(task)
    body = _github_body("opened")
    headers = _github_headers(body)
    headers["HTTP_X_HUB_SIGNATURE_256"] = "sha256=deadbeef"
    resp = _post(project, body, headers)
    assert resp.status_code == 401
    task.refresh_from_db()
    assert task.status == TaskStatus.IN_PROGRESS


def test_missing_signature_is_401(
    project: Project, task: Task, automation: BoardAutomation
) -> None:
    _github_link(task)
    body = _github_body("opened")
    resp = _post(project, body, {"HTTP_X_GITHUB_EVENT": "pull_request"})
    assert resp.status_code == 401


def test_no_automation_is_404(project: Project, task: Task) -> None:
    # No BoardAutomation row at all — must not leak that the project lacks it.
    _github_link(task)
    body = _github_body("opened")
    resp = _post(project, body, _github_headers(body))
    assert resp.status_code == 404


def test_disabled_automation_is_404(
    project: Project, task: Task, automation: BoardAutomation
) -> None:
    automation.enabled = False
    automation.save(update_fields=["enabled"])
    _github_link(task)
    body = _github_body("opened")
    resp = _post(project, body, _github_headers(body))
    assert resp.status_code == 404


# --- Matching + forward-only guard -------------------------------------------


def test_no_matching_link_returns_unmatched(
    project: Project, task: Task, automation: BoardAutomation
) -> None:
    # Task has no link to this PR → nothing to move.
    body = _github_body("opened")
    resp = _post(project, body, _github_headers(body))
    assert resp.status_code == 200
    assert resp.json()["matched"] is False


def test_forward_only_does_not_move_completed_card(
    project: Project, task: Task, automation: BoardAutomation
) -> None:
    task.status = TaskStatus.COMPLETE
    task.save(update_fields=["status"])
    _github_link(task)
    body = _github_body("closed", merged=True)
    resp = _post(project, body, _github_headers(body))
    assert resp.status_code == 200
    assert resp.json()["moved"] is False
    assert resp.json()["reason"] == "noop_forward_only"
    task.refresh_from_db()
    assert task.status == TaskStatus.COMPLETE


def test_pr_opened_does_not_move_card_already_in_review(
    project: Project, task: Task, automation: BoardAutomation
) -> None:
    task.status = TaskStatus.REVIEW
    task.save(update_fields=["status"])
    _github_link(task)
    body = _github_body("opened")
    resp = _post(project, body, _github_headers(body))
    assert resp.json()["moved"] is False
    task.refresh_from_db()
    assert task.status == TaskStatus.REVIEW


def test_link_in_other_project_is_not_matched(
    project: Project, task: Task, automation: BoardAutomation
) -> None:
    # A different project owns the PR link; this project's webhook must not reach it.
    other = Project.objects.create(
        name="Beta", start_date=date(2026, 1, 1), calendar=project.calendar
    )
    other_task = Task.objects.create(project=other, name="X", duration=1)
    TaskLink.objects.create(task=other_task, url=GITHUB_PR_URL, provider="github")
    body = _github_body("opened")
    resp = _post(project, body, _github_headers(body))
    assert resp.json()["matched"] is False
    other_task.refresh_from_db()
    assert other_task.status != TaskStatus.REVIEW


def test_ignored_event_returns_200(
    project: Project, task: Task, automation: BoardAutomation
) -> None:
    _github_link(task)
    body = json.dumps({"zen": "ping"}).encode("utf-8")
    sig = "sha256=" + hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()
    headers = {"HTTP_X_GITHUB_EVENT": "push", "HTTP_X_HUB_SIGNATURE_256": sig}
    resp = _post(project, body, headers)
    assert resp.status_code == 200
    assert resp.json()["ignored"] == "push"


def test_duplicate_delivery_is_noop(
    project: Project, task: Task, automation: BoardAutomation
) -> None:
    _github_link(task)
    body = _github_body("opened")
    with patch(
        "trueppm_api.apps.integrations.throttles.claim_webhook_delivery", return_value=False
    ):
        resp = _post(project, body, _github_headers(body))
    assert resp.status_code == 200
    assert resp.json()["reason"] == "duplicate"
    task.refresh_from_db()
    assert task.status == TaskStatus.IN_PROGRESS


# --- Config + rotate-secret RBAC ---------------------------------------------


def _auth(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def test_config_get_admin_ok_member_forbidden(
    project: Project, admin: object, member: object
) -> None:
    url = reverse("git-automation-config", kwargs={"project_pk": str(project.pk)})
    assert _auth(admin).get(url).status_code == 200
    assert _auth(member).get(url).status_code == 403


def test_config_put_toggles_enabled(project: Project, admin: object) -> None:
    url = reverse("git-automation-config", kwargs={"project_pk": str(project.pk)})
    resp = _auth(admin).put(url, {"enabled": True}, format="json")
    assert resp.status_code == 200
    assert resp.json()["enabled"] is True
    assert BoardAutomation.objects.get(project=project).enabled is True


def test_config_get_never_returns_secret(
    project: Project, admin: object, automation: BoardAutomation
) -> None:
    url = reverse("git-automation-config", kwargs={"project_pk": str(project.pk)})
    data = _auth(admin).get(url).json()
    assert data["secret_set"] is True
    assert "secret" not in data
    assert "secret_ciphertext" not in data


def test_rotate_secret_returns_plaintext_once_admin_only(
    project: Project, admin: object, member: object
) -> None:
    url = reverse("git-automation-rotate-secret", kwargs={"project_pk": str(project.pk)})
    assert _auth(member).post(url).status_code == 403
    resp = _auth(admin).post(url)
    assert resp.status_code == 201
    secret = resp.json()["secret"]
    assert secret
    auto = BoardAutomation.objects.get(project=project)
    assert auto.has_secret
    # The stored ciphertext is not the plaintext, and the GET never returns it.
    assert bytes(auto.secret_ciphertext) != secret.encode()
