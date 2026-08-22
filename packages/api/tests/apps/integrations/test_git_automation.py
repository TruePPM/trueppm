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
import logging
import uuid
from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.core.exceptions import ImproperlyConfigured
from django.urls import reverse
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.integrations.encryption import CredentialEncryptionError
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


def test_gitlab_wrong_token_is_404(
    project: Project, task: Task, automation: BoardAutomation
) -> None:
    # 404, not 401: a 401 would have told an anonymous caller that this project has
    # automation enabled with a secret set (#2881). See the indistinguishability
    # tests below.
    _gitlab_link(task)
    body = _gitlab_body("merge")
    headers = {"HTTP_X_GITLAB_EVENT": "Merge Request Hook", "HTTP_X_GITLAB_TOKEN": "wrong"}
    resp = _post(project, body, headers)
    assert resp.status_code == 404
    task.refresh_from_db()
    assert task.status == TaskStatus.IN_PROGRESS


# --- Signature / security ----------------------------------------------------


def test_invalid_github_signature_is_404_and_no_move(
    project: Project, task: Task, automation: BoardAutomation
) -> None:
    _github_link(task)
    body = _github_body("opened")
    headers = _github_headers(body)
    headers["HTTP_X_HUB_SIGNATURE_256"] = "sha256=deadbeef"
    resp = _post(project, body, headers)
    assert resp.status_code == 404
    task.refresh_from_db()
    assert task.status == TaskStatus.IN_PROGRESS


def test_missing_signature_is_404(
    project: Project, task: Task, automation: BoardAutomation
) -> None:
    _github_link(task)
    body = _github_body("opened")
    resp = _post(project, body, {"HTTP_X_GITHUB_EVENT": "pull_request"})
    assert resp.status_code == 404


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


# --- #2881: the receiver is an unauthenticated attack surface -----------------
#
# Three defects, all reachable by anyone holding a project UUID — which every
# project Viewer has, straight out of the SPA URL.


def _gitlab_headers(token: str) -> dict[str, str]:
    return {"HTTP_X_GITLAB_EVENT": "Merge Request Hook", "HTTP_X_GITLAB_TOKEN": token}


@pytest.mark.parametrize(
    ("headers_factory", "body_factory"),
    [
        # One Latin-1 byte in the header. hmac.compare_digest raises TypeError on a
        # non-ASCII *str*, and both arms passed the raw header straight in, so this
        # was an unhandled 500.
        (
            lambda: {"HTTP_X_GITHUB_EVENT": "pull_request", "HTTP_X_HUB_SIGNATURE_256": "café"},
            lambda: _github_body("opened"),
        ),
        (lambda: _gitlab_headers("café"), lambda: _gitlab_body("open")),
        # A code point above U+00FF, which the latin-1 encode path cannot represent.
        (
            lambda: {
                "HTTP_X_GITHUB_EVENT": "pull_request",
                "HTTP_X_HUB_SIGNATURE_256": "sha256=中",
            },
            lambda: _github_body("opened"),
        ),
        (lambda: _gitlab_headers("\U0001f600"), lambda: _gitlab_body("open")),
    ],
)
def test_non_ascii_signature_header_is_404_not_500(
    project: Project,
    task: Task,
    automation: BoardAutomation,
    headers_factory: object,
    body_factory: object,
) -> None:
    """A non-ASCII signature header must be a plain refusal, never a 500.

    The crash mattered less than its shape: a 500 is only reachable *after* the
    "is automation configured?" check, so its mere existence told the caller that
    this project has automation enabled and a secret set — admin-only state.
    """
    _github_link(task)
    body = body_factory()  # type: ignore[operator]
    resp = _post(project, body, headers_factory())  # type: ignore[operator]
    assert resp.status_code == 404
    task.refresh_from_db()
    assert task.status == TaskStatus.IN_PROGRESS


def test_every_pre_verification_refusal_is_byte_identical(
    project: Project, task: Task, admin: object
) -> None:
    """The oracle-closing assertion: every refusal must be indistinguishable.

    Not "all 404" — *identical*. Status, body, and content type all have to match,
    because any observable difference between them re-opens the disclosure: with a
    project UUID a caller could otherwise read off whether automation is enabled,
    whether a secret is set, and whether its signature guess was even the right
    shape — three facts ``GitAutomationConfigView`` gates at Owner/Admin.
    """
    _github_link(task)
    body = _github_body("opened")
    responses = []

    # (1) No BoardAutomation row at all.
    responses.append(_post(project, body, _github_headers(body)))

    auto = BoardAutomation(project=project, enabled=False, configured_by=admin)
    auto.save()
    # (2) Row exists, automation disabled, no secret.
    responses.append(_post(project, body, _github_headers(body)))

    auto.set_secret(SECRET)
    auto.save()
    # (3) Secret set but automation still disabled.
    responses.append(_post(project, body, _github_headers(body)))

    auto.enabled = True
    auto.save()
    # (4) Enabled + secret, but no provider header.
    responses.append(_post(project, body, {}))
    # (5) Enabled + secret, wrong signature.
    bad = _github_headers(body)
    bad["HTTP_X_HUB_SIGNATURE_256"] = "sha256=deadbeef"
    responses.append(_post(project, body, bad))
    # (6) Enabled + secret, non-ASCII signature (the #2881 500).
    nonascii = _github_headers(body)
    nonascii["HTTP_X_HUB_SIGNATURE_256"] = "café"
    responses.append(_post(project, body, nonascii))
    # (7) Enabled + secret, but the secret cannot be decrypted at all. Covers all
    # three exception types this arm has to absorb — the two beyond
    # CredentialEncryptionError were unhandled 500s, i.e. the same disclosure.
    for failure in (
        CredentialEncryptionError("ciphertext undecryptable"),
        ImproperlyConfigured("INTEGRATION_ENCRYPTION_KEY is not set"),
        ValueError("Fernet key must be 32 url-safe base64-encoded bytes."),
    ):
        with patch("trueppm_api.apps.integrations.views.decrypt_secret", side_effect=failure):
            responses.append(_post(project, body, _github_headers(body)))

    observations = {
        (r.status_code, r["Content-Type"], r.content)  # type: ignore[index,attr-defined]
        for r in responses
    }
    assert len(observations) == 1, observations
    assert next(iter(observations))[0] == 404
    task.refresh_from_db()
    assert task.status == TaskStatus.IN_PROGRESS


def test_oversized_body_is_413(project: Project, task: Task, automation: BoardAutomation) -> None:
    """A body over the cap is refused, and refused for a reason the caller can act on.

    413 rather than the uniform 404 on purpose: the size check runs *before* any
    project state is read, so its answer cannot depend on — and therefore cannot
    leak — whether automation is configured.
    """
    _github_link(task)
    oversized = b'{"pad":"' + b"x" * (1024 * 1024 + 64) + b'"}'
    resp = _post(project, oversized, _github_headers(oversized))
    assert resp.status_code == 413
    task.refresh_from_db()
    assert task.status == TaskStatus.IN_PROGRESS


def test_oversized_body_is_413_even_with_no_automation(project: Project) -> None:
    """The size refusal is state-independent — same 413 on an unconfigured project.

    This is the property that lets 413 stay distinct from the uniform 404 without
    becoming a second oracle.
    """
    oversized = b'{"pad":"' + b"x" * (1024 * 1024 + 64) + b'"}'
    resp = _post(project, oversized, _github_headers(oversized))
    assert resp.status_code == 413


def test_oversized_declared_content_length_is_refused_without_reading_the_body(
    project: Project, automation: BoardAutomation
) -> None:
    """A lying/large ``Content-Length`` is rejected before the body is buffered.

    The old code's first statement was ``raw_body = request.body``, so a 20 MB POST
    at a random project UUID was fully accepted before the 404. Asserting on the
    declared length is how we prove the cheap check runs first: ``request.body`` is
    never touched, so a header claiming more than the cap is enough on its own.
    """
    body = _github_body("opened")
    url = reverse("git-webhook", kwargs={"project_pk": str(project.pk)})
    resp = APIClient().post(
        url,
        data=body,
        content_type="application/json",
        CONTENT_LENGTH=str(50 * 1024 * 1024),
        **_github_headers(body),
    )
    assert resp.status_code == 413


def test_per_ip_throttle_survives_project_uuid_rotation(monkeypatch: pytest.MonkeyPatch) -> None:
    """Rotating the project UUID must no longer mint a fresh throttle bucket.

    The per-project throttle keys on ``project_pk`` *from the URL*, so 200 POSTs to
    200 random UUIDs were all allowed while 130 to one UUID were correctly 429'd —
    an unauthenticated endpoint with no per-caller bound at all, because declaring
    ``throttle_classes`` also replaced the global anon default. The per-IP throttle
    is stacked alongside; a UUID it has never seen must still count.
    """
    from trueppm_api.apps.integrations.throttles import GitWebhookIpThrottle

    monkeypatch.setattr(
        GitWebhookIpThrottle,
        "THROTTLE_RATES",
        {**GitWebhookIpThrottle.THROTTLE_RATES, "git_webhook_ip": "2/min"},
    )
    from django.core.cache import cache

    cache.clear()

    body = _github_body("opened")
    statuses = []
    for _ in range(4):
        url = reverse("git-webhook", kwargs={"project_pk": str(uuid.uuid4())})
        resp = APIClient().post(
            url, data=body, content_type="application/json", **_github_headers(body)
        )
        statuses.append(resp.status_code)

    # Every UUID is fresh, so before the fix all four would have been 404.
    assert statuses[:2] == [404, 404]
    assert statuses[2:] == [429, 429]


def test_ip_throttle_scope_matches_a_configured_rate() -> None:
    """A scope with no matching ``DEFAULT_THROTTLE_RATES`` key silently does nothing."""
    from trueppm_api.apps.integrations.throttles import GitWebhookIpThrottle

    assert GitWebhookIpThrottle.scope == "git_webhook_ip"
    assert GitWebhookIpThrottle.THROTTLE_RATES.get("git_webhook_ip")


def test_both_throttles_are_stacked_on_the_receiver() -> None:
    """Both classes must be declared: neither alone bounds the endpoint."""
    from trueppm_api.apps.integrations.throttles import GitWebhookIpThrottle, GitWebhookThrottle
    from trueppm_api.apps.integrations.views import GitWebhookIngestView

    assert set(GitWebhookIngestView.throttle_classes) == {GitWebhookThrottle, GitWebhookIpThrottle}


def test_non_string_pr_url_in_a_signed_payload_does_not_500(
    project: Project, task: Task, automation: BoardAutomation
) -> None:
    """``html_url: 1`` must resolve to "no URL", not an AttributeError in ``urlparse``.

    The GitLab arm already narrowed ``url`` with ``isinstance``; the GitHub arm
    returned it unnarrowed, so a signed but garbled payload reached ``_pr_key`` and
    crashed on ``.decode`` (the #2795 container-vs-value class).
    """
    _github_link(task)
    body = json.dumps({"action": "opened", "pull_request": {"html_url": 1}}).encode("utf-8")
    resp = _post(project, body, _github_headers(body))
    assert resp.status_code == 200
    assert resp.json()["reason"] == "no_url"


# --- #2882: draft pull/merge requests must not advance the card ---------------


def test_github_draft_pr_opened_does_not_move_the_card(
    project: Project, task: Task, automation: BoardAutomation
) -> None:
    """A draft opened to run CI is not a request for review.

    Forward-only means a card promoted by mistake can never come back, so this has
    to be inert rather than merely reversible.
    """
    _github_link(task)
    body = json.dumps(
        {"action": "opened", "pull_request": {"html_url": GITHUB_PR_URL, "draft": True}}
    ).encode("utf-8")
    resp = _post(project, body, _github_headers(body))
    assert resp.status_code == 200
    assert resp.json()["moved"] is False
    assert resp.json()["reason"] == "draft"
    task.refresh_from_db()
    assert task.status == TaskStatus.IN_PROGRESS


def test_github_ready_for_review_moves_the_card(
    project: Project, task: Task, automation: BoardAutomation
) -> None:
    """The promotion a draft was waiting for: marking it ready moves the card."""
    _github_link(task)
    body = json.dumps(
        {
            "action": "ready_for_review",
            "pull_request": {"html_url": GITHUB_PR_URL, "draft": False},
        }
    ).encode("utf-8")
    resp = _post(project, body, _github_headers(body))
    assert resp.json()["to"] == TaskStatus.REVIEW
    task.refresh_from_db()
    assert task.status == TaskStatus.REVIEW


def test_github_draft_merge_still_completes(
    project: Project, task: Task, automation: BoardAutomation
) -> None:
    """The draft guard is scoped to *open* — a merge always completes the card.

    GitHub cannot merge a draft, but the payload's ``draft`` flag is whatever the
    sender put there, and gating the merge branch on it would be a way to strand a
    card at Review forever.
    """
    _github_link(task)
    body = json.dumps(
        {
            "action": "closed",
            "pull_request": {"html_url": GITHUB_PR_URL, "merged": True, "draft": True},
        }
    ).encode("utf-8")
    resp = _post(project, body, _github_headers(body))
    assert resp.json()["to"] == TaskStatus.COMPLETE


@pytest.mark.parametrize("draft_key", ["work_in_progress", "draft"])
def test_gitlab_draft_mr_open_does_not_move_the_card(
    project: Project, task: Task, automation: BoardAutomation, draft_key: str
) -> None:
    """GitLab's flag is ``work_in_progress``; newer versions also send ``draft``.

    Both are read, matching the link-status parser that already handled both.
    """
    _gitlab_link(task)
    body = json.dumps(
        {
            "object_kind": "merge_request",
            "object_attributes": {
                "action": "open",
                "url": GITLAB_MR_URL,
                "id": 42,
                draft_key: True,
            },
        }
    ).encode("utf-8")
    resp = _post(project, body, _gitlab_headers(SECRET))
    assert resp.status_code == 200
    assert resp.json()["moved"] is False
    assert resp.json()["reason"] == "draft"
    task.refresh_from_db()
    assert task.status == TaskStatus.IN_PROGRESS


# --- #2882: a failed or unmatched delivery must have a consumer ---------------


@pytest.mark.parametrize(
    ("mutate", "headers_key", "expected"),
    [
        ("disable", "good", "automation_disabled"),
        ("clear_secret", "good", "no_secret"),
        (None, "none", "unknown_provider"),
        (None, "bad", "bad_signature"),
    ],
)
def test_refused_delivery_is_recorded_on_the_config_row(
    project: Project,
    task: Task,
    automation: BoardAutomation,
    mutate: str | None,
    headers_key: str,
    expected: str,
) -> None:
    """The reason a refusal happened survives where only an admin can read it.

    This is the other half of the uniform 404: the caller learns nothing, and the
    operator learns everything. Before this, a rotated secret or a stripped header
    produced a refusal that was invisible on every surface an operator can reach —
    no log line, no state, and the provider's own delivery tab is outside their
    monitoring.
    """
    _github_link(task)
    if mutate == "disable":
        automation.enabled = False
        automation.save(update_fields=["enabled"])
    elif mutate == "clear_secret":
        automation.secret_ciphertext = b""
        automation.save(update_fields=["secret_ciphertext"])

    body = _github_body("opened")
    if headers_key == "good":
        headers = _github_headers(body)
    elif headers_key == "none":
        headers = {}
    else:
        headers = _github_headers(body)
        headers["HTTP_X_HUB_SIGNATURE_256"] = "sha256=deadbeef"

    resp = _post(project, body, headers)
    assert resp.status_code == 404
    automation.refresh_from_db()
    # The REFUSAL slot, not the delivery slot — see the displacement test below.
    assert automation.last_refusal_outcome == expected
    assert automation.last_refusal_at is not None
    assert automation.last_delivery_outcome == ""
    assert automation.last_delivery_at is None


def test_a_delivery_that_matches_nothing_is_recorded(
    project: Project, task: Task, automation: BoardAutomation
) -> None:
    """``no_link`` is THE silent failure: green check from the provider, no card moves.

    Matching is exact-URL against an existing ``TaskLink``, and an operator who
    completed every documented setup step has usually not created one.
    """
    body = _github_body("opened")  # no TaskLink created
    resp = _post(project, body, _github_headers(body))
    assert resp.json()["reason"] == "no_link"
    automation.refresh_from_db()
    assert automation.last_delivery_outcome == "no_link"
    assert automation.last_delivery_provider == "github"


def test_a_successful_move_is_recorded(
    project: Project, task: Task, automation: BoardAutomation
) -> None:
    _github_link(task)
    body = _github_body("opened")
    _post(project, body, _github_headers(body))
    automation.refresh_from_db()
    assert automation.last_delivery_outcome == "opened_review"


def test_recording_a_delivery_does_not_look_like_a_config_change(
    project: Project, task: Task, automation: BoardAutomation
) -> None:
    """``updated_at`` means "an admin changed this config" — a webhook must not bump it.

    Recorded via a queryset ``.update()`` precisely so ``auto_now`` never fires.
    """
    before = BoardAutomation.objects.get(pk=automation.pk).updated_at
    _github_link(task)
    body = _github_body("opened")
    _post(project, body, _github_headers(body))
    after = BoardAutomation.objects.get(pk=automation.pk)
    assert after.updated_at == before
    assert after.last_delivery_at is not None


def test_config_get_surfaces_the_last_delivery(
    project: Project, task: Task, admin: object, automation: BoardAutomation
) -> None:
    """The admin-only GET is what feeds the settings card's "Last delivery" row."""
    body = _github_body("opened")
    _post(project, body, _github_headers(body))  # unmatched → no_link

    url = reverse("git-automation-config", kwargs={"project_pk": str(project.pk)})
    data = _auth(admin).get(url).json()
    assert data["last_delivery_outcome"] == "no_link"
    assert data["last_delivery_provider"] == "github"
    assert data["last_delivery_at"] is not None


def test_config_get_reports_no_delivery_before_the_first_webhook(
    project: Project, admin: object, automation: BoardAutomation
) -> None:
    """The empty state has to be representable, or the card renders a false "OK"."""
    url = reverse("git-automation-config", kwargs={"project_pk": str(project.pk)})
    data = _auth(admin).get(url).json()
    assert data["last_delivery_at"] is None
    assert data["last_delivery_outcome"] == ""
    assert data["last_refusal_at"] is None
    assert data["last_refusal_outcome"] == ""


def test_an_anonymous_refusal_cannot_displace_a_verified_outcome(
    project: Project, task: Task, admin: object, automation: BoardAutomation
) -> None:
    """The reason refusals live in their own columns (#2882, threat-model F1).

    A refusal is recorded *before* the signature is verified, so anyone holding the
    project UUID — not a secret; every Viewer reads it out of the SPA URL — can force
    one. Sharing a column with the verified outcome would let that caller erase the
    genuine ``no_link`` an admin is mid-diagnosis on, and leave the card telling the
    admin to rotate a working secret. This asserts the verified outcome survives an
    unauthenticated caller hammering the endpoint afterwards.
    """
    good = _github_body("opened")
    _post(project, good, _github_headers(good))  # verified, unmatched → no_link
    assert BoardAutomation.objects.get(pk=automation.pk).last_delivery_outcome == "no_link"

    forged = _github_headers(good)
    forged["HTTP_X_HUB_SIGNATURE_256"] = "sha256=deadbeef"
    for _ in range(3):
        assert _post(project, good, forged).status_code == 404

    after = BoardAutomation.objects.get(pk=automation.pk)
    # The real diagnosis is intact...
    assert after.last_delivery_outcome == "no_link"
    # ...and the forged traffic is quarantined in the slot the UI labels as
    # "may not be your provider".
    assert after.last_refusal_outcome == "bad_signature"

    url = reverse("git-automation-config", kwargs={"project_pk": str(project.pk)})
    data = _auth(admin).get(url).json()
    assert data["last_delivery_outcome"] == "no_link"
    assert data["last_refusal_outcome"] == "bad_signature"


@pytest.mark.parametrize(
    "raised",
    [
        ImproperlyConfigured("INTEGRATION_ENCRYPTION_KEY is not set"),
        ValueError("Fernet key must be 32 url-safe base64-encoded bytes."),
    ],
)
def test_an_unreadable_encryption_key_is_404_not_500(
    project: Project, task: Task, automation: BoardAutomation, raised: Exception
) -> None:
    """Every way the stored secret can fail to come back must reach the same 404.

    ``decrypt_secret`` raises ``CredentialEncryptionError`` when the key was rotated,
    but ``ImproperlyConfigured`` when it is unset and ``ValueError`` when it is
    malformed — the same operator scenario. Catching only the first left the other two
    as unhandled 500s, and a 500 is reachable only on a project that HAS automation
    with a secret set: the exact disclosure #2881 removes, one exception type over.
    """
    _github_link(task)
    body = _github_body("opened")
    with patch(
        "trueppm_api.apps.integrations.views.decrypt_secret",
        side_effect=raised,
    ):
        resp = _post(project, body, _github_headers(body))
    assert resp.status_code == 404
    automation.refresh_from_db()
    assert automation.last_refusal_outcome == "secret_unreadable"


def test_a_non_ascii_secret_is_refused_at_write_time(project: Project) -> None:
    """The ASCII invariant ``constant_time_equal`` depends on, enforced in code.

    The encode falls back latin-1 → utf-8 and the two codecs agree only on ASCII.
    Since #2929 both sides go through the same encode, so a non-ASCII secret no
    longer lets different headers compare equal — it instead never verifies, because
    the header's wire bytes round-trip through latin-1 and cannot match the secret's
    own latin-1 encoding. Refused at write time either way. Every secret today comes
    from ``secrets.token_urlsafe``; this keeps that true the day a "paste your
    existing provider secret" path is added.
    """
    auto = BoardAutomation(project=project, enabled=True)
    with pytest.raises(ValueError, match="ASCII"):
        auto.set_secret("sécret-with-an-accent")


def test_latin1_and_utf8_confusable_headers_do_not_verify(
    project: Project, task: Task, automation: BoardAutomation
) -> None:
    """The confusable pair the ASCII invariant exists to rule out.

    ``"Ã©"`` encodes under latin-1 to the same bytes ``"é"`` encodes to under utf-8.
    With an ASCII secret neither can ever match, which is the property being pinned —
    if a future change let a non-ASCII secret be stored, this is what would break.
    """
    _gitlab_link(task)
    body = _gitlab_body("open")
    for token in ("Ã©", "é"):
        assert _post(project, body, _gitlab_headers(token)).status_code == 404
    task.refresh_from_db()
    assert task.status == TaskStatus.IN_PROGRESS


def test_refusal_is_logged(
    project: Project,
    task: Task,
    automation: BoardAutomation,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A structured WARNING per refused delivery — the receiver logged nothing at all.

    The log is the surface for the one case the config row cannot hold: a POST at a
    project UUID with no automation row to record against.
    """
    _github_link(task)
    body = _github_body("opened")
    headers = _github_headers(body)
    headers["HTTP_X_HUB_SIGNATURE_256"] = "sha256=deadbeef"
    with caplog.at_level(logging.WARNING, logger="trueppm_api.apps.integrations.views"):
        _post(project, body, headers)
    messages = [r.getMessage() for r in caplog.records]
    assert any("bad_signature" in m for m in messages)
    # Attributable: without a client identity an admin cannot tell a misconfigured
    # provider from someone poking a public endpoint, and the two need opposite
    # actions. The delivery id is what ties the line to the provider's own log.
    assert any("client=" in m and "delivery=d1" in m for m in messages)


def test_unmatched_delivery_is_logged(
    project: Project,
    task: Task,
    automation: BoardAutomation,
    caplog: pytest.LogCaptureFixture,
) -> None:
    body = _github_body("opened")  # no TaskLink
    with caplog.at_level(logging.WARNING, logger="trueppm_api.apps.integrations.views"):
        _post(project, body, _github_headers(body))
    assert any("no_link" in r.getMessage() for r in caplog.records)
