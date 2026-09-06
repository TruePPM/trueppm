"""Tests for the inbound task-sync protocol (issue #500, ADR-0068).

Covers:
  - Token authentication: valid, revoked, malformed, missing.
  - IDOR defense: token must match URL project.
  - RBAC on token CRUD: role ≥ 3 (Admin/PM) required.
  - Idempotent upsert by (project, source, external_id).
  - Parent attach via parent_external_id (preserves Jira epic→story hierarchy).
  - Cross-source parent rejection (downgrade attack from STRIDE §EoP #4).
  - Default status_map fallback + per-token override.
  - Assignee resolution by email; pending_assignee_email fallback; resolve on re-push.
  - Audit log: mint / revoke / used entries written, source_ip captured.
  - Status_map immutability — change requires new token.
  - broadcast_board_event fires on inbound upsert (transaction.on_commit).
  - pending-assignee count surfaced on project detail.
  - HistoricalTask row written on the bulk-.update() branch (#1876) and
    surfaced by the task history endpoint.
"""

from __future__ import annotations

from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import (
    ApiTokenAuditAction,
    ApiTokenAuditEntry,
    Calendar,
    InboundTaskLink,
    Project,
    ProjectApiToken,
    Task,
    TaskStatus,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def admin_user(db: object) -> Any:
    return User.objects.create_user(username="adminuser", email="admin@example.com", password="pw")


@pytest.fixture
def member_user(db: object) -> Any:
    return User.objects.create_user(
        username="memberuser", email="member@example.com", password="pw"
    )


@pytest.fixture
def other_user(db: object) -> Any:
    return User.objects.create_user(username="otheruser", email="other@example.com", password="pw")


@pytest.fixture
def project(calendar: Calendar, admin_user: Any, member_user: Any) -> Project:
    proj = Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)
    ProjectMembership.objects.create(project=proj, user=admin_user, role=Role.ADMIN)
    ProjectMembership.objects.create(project=proj, user=member_user, role=Role.MEMBER)
    return proj


@pytest.fixture
def other_project(calendar: Calendar, admin_user: Any) -> Project:
    proj = Project.objects.create(name="Q", start_date=date(2026, 4, 1), calendar=calendar)
    ProjectMembership.objects.create(project=proj, user=admin_user, role=Role.ADMIN)
    return proj


def _mint_token(
    project: Project, creator: Any, status_map: dict[str, str] | None = None
) -> tuple[ProjectApiToken, str]:
    """Helper — create a token row with a known raw value so tests can hit the endpoint."""
    import secrets

    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    token = ProjectApiToken.objects.create(
        project=project,
        name="test-token",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        status_map=status_map or {},
        created_by=creator,
    )
    return token, raw


def _bearer(client: APIClient, raw_token: str) -> APIClient:
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw_token}")
    return client


# ---------------------------------------------------------------------------
# Token authentication
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_no_auth_header_is_rejected(project: Project) -> None:
    resp = APIClient().post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1"},
        format="json",
    )
    assert resp.status_code in (401, 403)


@pytest.mark.django_db
def test_malformed_token_is_rejected(project: Project) -> None:
    client = _bearer(APIClient(), "not_a_token")
    resp = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1"},
        format="json",
    )
    assert resp.status_code == 401


@pytest.mark.django_db
def test_token_with_wrong_prefix_is_rejected(project: Project) -> None:
    client = _bearer(APIClient(), "wrong_" + "0" * 64)
    resp = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1"},
        format="json",
    )
    assert resp.status_code == 401


@pytest.mark.django_db
def test_token_with_non_hex_body_is_rejected(project: Project) -> None:
    client = _bearer(APIClient(), TOKEN_PREFIX + "z" * 64)
    resp = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1"},
        format="json",
    )
    assert resp.status_code == 401


@pytest.mark.django_db
def test_revoked_token_is_rejected(project: Project, admin_user: Any) -> None:
    token, raw = _mint_token(project, admin_user)
    token.revoked_at = timezone.now()
    token.save(update_fields=["revoked_at"])
    client = _bearer(APIClient(), raw)
    resp = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1"},
        format="json",
    )
    assert resp.status_code == 401


@pytest.mark.django_db
def test_token_for_other_project_is_rejected_with_401(
    project: Project, other_project: Project, admin_user: Any
) -> None:
    """IDOR defense — token bound to project Q cannot push to project P.

    Returns 401 (not 403) to avoid leaking whether the URL project exists.
    """
    _token, raw = _mint_token(other_project, admin_user)
    client = _bearer(APIClient(), raw)
    resp = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1"},
        format="json",
    )
    assert resp.status_code == 401


@pytest.mark.django_db
def test_valid_token_updates_last_used_at(project: Project, admin_user: Any) -> None:
    token, raw = _mint_token(project, admin_user)
    assert token.last_used_at is None
    client = _bearer(APIClient(), raw)
    resp = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "name": "Issue 1"},
        format="json",
    )
    assert resp.status_code == 201
    token.refresh_from_db()
    assert token.last_used_at is not None


@pytest.mark.django_db
def test_token_still_syncs_after_its_minter_is_deactivated(
    project: Project, admin_user: Any
) -> None:
    """#2832: off-boarding a colleague must not break the team's CI integration.

    The workspace off-boarding path revokes only ``owner=`` personal tokens, and the
    authenticator's disabled-account guard is scoped to ``is_personal`` for the same
    reason. This asserts the promise end-to-end, through the real permission stack —
    the authenticator returning a tuple is not enough, because ``IsAuthenticated`` runs
    after it and would turn a downgraded/anonymous principal into a 403 that the
    unit-level assertion could never see.
    """
    _token, raw = _mint_token(project, admin_user)
    admin_user.is_active = False
    admin_user.save(update_fields=["is_active"])

    resp = _bearer(APIClient(), raw).post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-9", "name": "Issue 9"},
        format="json",
    )
    assert resp.status_code == 201


# ---------------------------------------------------------------------------
# Upsert behavior
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_lands_task_in_backlog_with_default_status(
    project: Project, admin_user: Any
) -> None:
    """No status in payload → default to BACKLOG (not NOT_STARTED, which is a PM commitment)."""
    _token, raw = _mint_token(project, admin_user)
    client = _bearer(APIClient(), raw)
    resp = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "name": "Issue 1"},
        format="json",
    )
    assert resp.status_code == 201
    assert resp.data["created"] is True
    task = Task.objects.get(pk=resp.data["task_id"])
    assert task.status == TaskStatus.BACKLOG
    assert task.name == "Issue 1"


@pytest.mark.django_db
def test_default_status_map_translates_in_progress(project: Project, admin_user: Any) -> None:
    _token, raw = _mint_token(project, admin_user)
    client = _bearer(APIClient(), raw)
    resp = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "status": "in_progress"},
        format="json",
    )
    assert resp.status_code == 201
    task = Task.objects.get(pk=resp.data["task_id"])
    assert task.status == TaskStatus.IN_PROGRESS


@pytest.mark.django_db
def test_per_token_status_map_overrides_default(project: Project, admin_user: Any) -> None:
    """Custom override wins over the global default."""
    _token, raw = _mint_token(project, admin_user, status_map={"shipped": "COMPLETE"})
    client = _bearer(APIClient(), raw)
    resp = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "status": "shipped"},
        format="json",
    )
    assert resp.status_code == 201
    task = Task.objects.get(pk=resp.data["task_id"])
    assert task.status == TaskStatus.COMPLETE


@pytest.mark.django_db
def test_unknown_status_falls_back_to_backlog(project: Project, admin_user: Any) -> None:
    _token, raw = _mint_token(project, admin_user)
    client = _bearer(APIClient(), raw)
    resp = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "status": "totally-unknown"},
        format="json",
    )
    assert resp.status_code == 201
    task = Task.objects.get(pk=resp.data["task_id"])
    assert task.status == TaskStatus.BACKLOG


@pytest.mark.django_db
def test_idempotent_upsert_updates_existing_task(project: Project, admin_user: Any) -> None:
    """Re-push of the same (source, external_id) updates the existing task."""
    _token, raw = _mint_token(project, admin_user)
    client = _bearer(APIClient(), raw)
    resp1 = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "name": "v1", "status": "todo"},
        format="json",
    )
    assert resp1.status_code == 201
    assert resp1.data["created"] is True
    task_id = resp1.data["task_id"]

    resp2 = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "name": "v2", "status": "done"},
        format="json",
    )
    # 200 on update (resource existed) vs 201 on first push (resource created).
    assert resp2.status_code == 200
    assert resp2.data["created"] is False
    assert resp2.data["task_id"] == task_id
    task = Task.objects.get(pk=task_id)
    assert task.name == "v2"
    assert task.status == TaskStatus.COMPLETE
    assert Task.objects.filter(project=project).count() == 1
    assert InboundTaskLink.objects.filter(project=project).count() == 1


@pytest.mark.django_db
def test_existing_assignee_not_overwritten_by_repush(
    project: Project, admin_user: Any, member_user: Any
) -> None:
    """A previously-resolved assignee is NOT overwritten by a re-push.

    Prevents a compromised token from silently rewriting human ownership decisions.
    """
    _token, raw = _mint_token(project, admin_user)
    client = _bearer(APIClient(), raw)
    resp = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "assignee_email": member_user.email},
        format="json",
    )
    assert resp.data["assignee_resolved"] is True
    task = Task.objects.get(pk=resp.data["task_id"])
    assert task.assignee_id == member_user.pk

    # Re-push with no assignee → keeps member_user; re-push with a different
    # email → still keeps member_user (no overwrite).
    client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "assignee_email": "drift@nowhere.com"},
        format="json",
    )
    task.refresh_from_db()
    assert task.assignee_id == member_user.pk


# ---------------------------------------------------------------------------
# Assignee resolution
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_unresolved_email_lands_in_pending(
    project: Project, admin_user: Any, other_user: Any
) -> None:
    """Email of a non-member lands in pending_assignee_email, not on the task."""
    _token, raw = _mint_token(project, admin_user)
    client = _bearer(APIClient(), raw)
    resp = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "assignee_email": other_user.email},
        format="json",
    )
    assert resp.status_code == 201
    assert resp.data["assignee_resolved"] is False
    task = Task.objects.get(pk=resp.data["task_id"])
    assert task.assignee_id is None
    link = InboundTaskLink.objects.get(task=task)
    assert link.pending_assignee_email == other_user.email


@pytest.mark.django_db
def test_pending_assignee_resolves_on_member_join(
    project: Project, admin_user: Any, other_user: Any
) -> None:
    """When the unresolved user joins the project, a re-push resolves the assignee."""
    _token, raw = _mint_token(project, admin_user)
    client = _bearer(APIClient(), raw)
    client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "assignee_email": other_user.email},
        format="json",
    )
    ProjectMembership.objects.create(project=project, user=other_user, role=Role.MEMBER)

    resp = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "assignee_email": other_user.email},
        format="json",
    )
    # Second push on an existing task is 200 (update), not 201 (create).
    assert resp.status_code == 200
    assert resp.data["assignee_resolved"] is True
    task = Task.objects.get(pk=resp.data["task_id"])
    assert task.assignee_id == other_user.pk
    link = InboundTaskLink.objects.get(task=task)
    assert link.pending_assignee_email is None


# ---------------------------------------------------------------------------
# Parent attach
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_parent_attach_creates_subtask_under_parent_wbs(project: Project, admin_user: Any) -> None:
    """Jira epic → story hierarchy preserved via parent_external_id."""
    _token, raw = _mint_token(project, admin_user)
    client = _bearer(APIClient(), raw)
    # 1. Push the parent.  Without a WBS path it has no children to attach to.
    parent_resp = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "EPIC-1", "name": "Epic"},
        format="json",
    )
    assert parent_resp.status_code == 201
    parent_task = Task.objects.get(pk=parent_resp.data["task_id"])
    # Promote the parent to have a wbs_path so the child can attach.
    parent_task.wbs_path = "1"
    parent_task.save(update_fields=["wbs_path"])

    child_resp = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {
            "source": "jira",
            "external_id": "STORY-1",
            "name": "Story",
            "parent_external_id": "EPIC-1",
        },
        format="json",
    )
    assert child_resp.status_code == 201
    child_task = Task.objects.get(pk=child_resp.data["task_id"])
    assert child_task.is_subtask is True
    assert str(child_task.wbs_path).startswith("1.")


@pytest.mark.django_db
def test_unknown_parent_results_in_flat_backlog_item(project: Project, admin_user: Any) -> None:
    """If parent_external_id has no matching link, the task lands flat — no error."""
    _token, raw = _mint_token(project, admin_user)
    client = _bearer(APIClient(), raw)
    resp = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {
            "source": "jira",
            "external_id": "STORY-2",
            "name": "Orphan",
            "parent_external_id": "EPIC-NOT-HERE",
        },
        format="json",
    )
    assert resp.status_code == 201
    task = Task.objects.get(pk=resp.data["task_id"])
    assert task.is_subtask is False


@pytest.mark.django_db
def test_cross_source_parent_rejected(project: Project, admin_user: Any) -> None:
    """A Linear story cannot attach under a Jira epic — same (project, source) scope only.

    STRIDE §EoP #4 — downgrade attack: tokens cannot reparent another source's tasks.
    """
    _token, raw = _mint_token(project, admin_user)
    client = _bearer(APIClient(), raw)
    # Jira epic in project.
    client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "EPIC-1", "name": "Jira epic"},
        format="json",
    )
    Task.objects.filter(name="Jira epic").update(wbs_path="1")

    # Linear story claiming the Jira epic as parent — lands flat, not under "1".
    child = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {
            "source": "linear",
            "external_id": "STORY-1",
            "name": "Linear orphan",
            "parent_external_id": "EPIC-1",
        },
        format="json",
    )
    assert child.status_code == 201
    t = Task.objects.get(pk=child.data["task_id"])
    assert t.is_subtask is False


# ---------------------------------------------------------------------------
# Token CRUD + RBAC
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_member_cannot_mint_token(project: Project, member_user: Any) -> None:
    client = APIClient()
    client.force_authenticate(user=member_user)
    resp = client.post(
        f"/api/v1/projects/{project.pk}/api-tokens/",
        {"name": "from-member"},
        format="json",
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_admin_can_mint_token_and_raw_value_returned_once(
    project: Project, admin_user: Any
) -> None:
    client = APIClient()
    client.force_authenticate(user=admin_user)
    resp = client.post(
        f"/api/v1/projects/{project.pk}/api-tokens/",
        {"name": "Jira Production"},
        format="json",
    )
    assert resp.status_code == 201
    assert "token" in resp.data
    raw = resp.data["token"]
    assert raw.startswith(TOKEN_PREFIX)
    assert len(raw) == len(TOKEN_PREFIX) + 64

    # List response must NOT contain the raw token.
    list_resp = client.get(f"/api/v1/projects/{project.pk}/api-tokens/")
    assert list_resp.status_code == 200
    listed = list_resp.data["results"] if isinstance(list_resp.data, dict) else list_resp.data
    for row in listed:
        assert "token" not in row


@pytest.mark.django_db
def test_member_can_list_tokens(project: Project, admin_user: Any, member_user: Any) -> None:
    """Visibility for team — Morgan's sprint-sovereignty signal."""
    _mint_token(project, admin_user)
    client = APIClient()
    client.force_authenticate(user=member_user)
    resp = client.get(f"/api/v1/projects/{project.pk}/api-tokens/")
    assert resp.status_code == 200


@pytest.mark.django_db
def test_admin_can_revoke_token(project: Project, admin_user: Any) -> None:
    token, _raw = _mint_token(project, admin_user)
    client = APIClient()
    client.force_authenticate(user=admin_user)
    resp = client.delete(f"/api/v1/projects/{project.pk}/api-tokens/{token.pk}/")
    assert resp.status_code == 204
    token.refresh_from_db()
    assert token.revoked_at is not None


@pytest.mark.django_db
def test_status_map_value_must_be_valid_task_status(project: Project, admin_user: Any) -> None:
    """Defensive validation — invalid TaskStatus values are rejected at mint time."""
    client = APIClient()
    client.force_authenticate(user=admin_user)
    resp = client.post(
        f"/api/v1/projects/{project.pk}/api-tokens/",
        {"name": "bad-map", "status_map": {"done": "PRETEND_STATUS"}},
        format="json",
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Audit log
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_mint_writes_audit_entry(project: Project, admin_user: Any) -> None:
    client = APIClient()
    client.force_authenticate(user=admin_user)
    resp = client.post(
        f"/api/v1/projects/{project.pk}/api-tokens/",
        {"name": "audited"},
        format="json",
    )
    assert resp.status_code == 201
    entry = ApiTokenAuditEntry.objects.get(project=project, action=ApiTokenAuditAction.MINTED)
    assert entry.actor_id == admin_user.pk
    assert entry.token_prefix == resp.data["token_prefix"]


@pytest.mark.django_db
def test_revoke_writes_audit_entry(project: Project, admin_user: Any) -> None:
    token, _raw = _mint_token(project, admin_user)
    client = APIClient()
    client.force_authenticate(user=admin_user)
    client.delete(f"/api/v1/projects/{project.pk}/api-tokens/{token.pk}/")
    assert ApiTokenAuditEntry.objects.filter(
        project=project, action=ApiTokenAuditAction.REVOKED, token=token
    ).exists()


@pytest.mark.django_db
def test_used_audit_entry_written_with_source_ip(project: Project, admin_user: Any) -> None:
    token, raw = _mint_token(project, admin_user)
    client = _bearer(APIClient(), raw)
    resp = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-AUDIT"},
        format="json",
        HTTP_X_FORWARDED_FOR="203.0.113.1, 198.51.100.1",
    )
    assert resp.status_code == 201
    entry = ApiTokenAuditEntry.objects.get(
        project=project, action=ApiTokenAuditAction.USED, token=token
    )
    assert entry.source_ip == "203.0.113.1"
    assert entry.actor is None  # inbound — no Django user
    assert entry.detail["external_id"] == "X-AUDIT"


@pytest.mark.django_db
def test_audit_list_endpoint_returns_member_visible_log(
    project: Project, admin_user: Any, member_user: Any
) -> None:
    """Any member can read the audit log (Morgan's sprint-sovereignty signal)."""
    _mint_token(project, admin_user)
    # Admin can read.
    admin_client = APIClient()
    admin_client.force_authenticate(user=admin_user)
    assert admin_client.get(f"/api/v1/projects/{project.pk}/api-token-audit/").status_code == 200
    # Member can read.
    member_client = APIClient()
    member_client.force_authenticate(user=member_user)
    assert member_client.get(f"/api/v1/projects/{project.pk}/api-token-audit/").status_code == 200


@pytest.mark.django_db
def test_audit_source_ip_visible_to_admin(project: Project, admin_user: Any) -> None:
    """Admin (Project Manager+) sees raw source_ip in audit responses."""
    _token, raw = _mint_token(project, admin_user)
    inbound = _bearer(APIClient(), raw)
    inbound.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-IP-ADMIN"},
        format="json",
        HTTP_X_FORWARDED_FOR="203.0.113.42",
    )
    client = APIClient()
    client.force_authenticate(user=admin_user)
    resp = client.get(f"/api/v1/projects/{project.pk}/api-token-audit/")
    assert resp.status_code == 200
    used_rows = [r for r in resp.data["results"] if r["action"] == ApiTokenAuditAction.USED]
    assert used_rows, "expected at least one USED audit row"
    assert used_rows[0]["source_ip"] == "203.0.113.42"


@pytest.mark.django_db
def test_audit_source_ip_redacted_for_member(
    project: Project, admin_user: Any, member_user: Any
) -> None:
    """Below-PM callers see source_ip as null — integration topology stays hidden.

    Mitigates IP enumeration of Jira egress / webhook-relay infrastructure by
    team members who have legitimate read access to the audit trail itself.
    """
    _token, raw = _mint_token(project, admin_user)
    inbound = _bearer(APIClient(), raw)
    inbound.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-IP-MEMBER"},
        format="json",
        HTTP_X_FORWARDED_FOR="203.0.113.99",
    )
    client = APIClient()
    client.force_authenticate(user=member_user)
    resp = client.get(f"/api/v1/projects/{project.pk}/api-token-audit/")
    assert resp.status_code == 200
    used_rows = [r for r in resp.data["results"] if r["action"] == ApiTokenAuditAction.USED]
    assert used_rows, "expected at least one USED audit row"
    assert used_rows[0]["source_ip"] is None


@pytest.mark.django_db
def test_audit_source_ip_redacted_for_viewer(
    project: Project, admin_user: Any, other_user: Any
) -> None:
    """Viewer (role 0) also gets source_ip redacted — only Admin+ sees raw IPs."""
    ProjectMembership.objects.create(project=project, user=other_user, role=Role.VIEWER)
    _token, raw = _mint_token(project, admin_user)
    inbound = _bearer(APIClient(), raw)
    inbound.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-IP-VIEWER"},
        format="json",
        HTTP_X_FORWARDED_FOR="203.0.113.7",
    )
    client = APIClient()
    client.force_authenticate(user=other_user)
    resp = client.get(f"/api/v1/projects/{project.pk}/api-token-audit/")
    assert resp.status_code == 200
    used_rows = [r for r in resp.data["results"] if r["action"] == ApiTokenAuditAction.USED]
    assert used_rows, "expected at least one USED audit row"
    assert used_rows[0]["source_ip"] is None


# ---------------------------------------------------------------------------
# Broadcast wiring (sync side effects)
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_inbound_create_fires_board_event(project: Project, admin_user: Any) -> None:
    """task_created event fires on commit so live boards refresh.

    Requires ``transaction=True`` so the request's outermost atomic block
    actually commits and Django fires the queued on_commit callbacks —
    same pattern used for the broadcast tests in ``test_risks.py``.
    """
    _token, raw = _mint_token(project, admin_user)
    client = _bearer(APIClient(), raw)
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as broadcast_mock:
        resp = client.post(
            f"/api/v1/projects/{project.pk}/task-sync/",
            {"source": "jira", "external_id": "X-CREATE"},
            format="json",
        )
        assert resp.status_code == 201
        # A create must dispatch the "task_created" event specifically. Merely
        # asserting `.called` passes even if a create wrongly emits "task_updated"
        # (or any other name) — mirror the sibling update test and pin the type.
        event_types = [call.args[1] for call in broadcast_mock.call_args_list]
        assert "task_created" in event_types


@pytest.mark.django_db(transaction=True)
def test_inbound_update_fires_task_updated_event(project: Project, admin_user: Any) -> None:
    _token, raw = _mint_token(project, admin_user)
    client = _bearer(APIClient(), raw)
    client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-UP"},
        format="json",
    )
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as broadcast_mock:
        resp = client.post(
            f"/api/v1/projects/{project.pk}/task-sync/",
            {"source": "jira", "external_id": "X-UP", "name": "renamed"},
            format="json",
        )
        # Second push on an existing task is 200 (update), not 201 (create).
        assert resp.status_code == 200
        event_types = [call.args[1] for call in broadcast_mock.call_args_list]
        assert "task_updated" in event_types


# ---------------------------------------------------------------------------
# Pending-assignee surface (Sarah's VoC 🟡)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_project_detail_surfaces_unresolved_assignee_count(
    project: Project, admin_user: Any
) -> None:
    """Project detail response includes the count so PMs have a triage signal."""
    _token, raw = _mint_token(project, admin_user)
    sync_client = _bearer(APIClient(), raw)
    # Push two tasks with unresolved assignees.
    for i in range(2):
        sync_client.post(
            f"/api/v1/projects/{project.pk}/task-sync/",
            {
                "source": "jira",
                "external_id": f"X-{i}",
                "assignee_email": f"nobody-{i}@example.com",
            },
            format="json",
        )

    client = APIClient()
    client.force_authenticate(user=admin_user)
    resp = client.get(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code == 200
    assert resp.data["unresolved_assignee_count"] == 2


@pytest.mark.django_db
def test_project_list_does_not_include_count(project: Project, admin_user: Any) -> None:
    """List response omits the count to keep portfolio-scale list fast."""
    client = APIClient()
    client.force_authenticate(user=admin_user)
    resp = client.get("/api/v1/projects/")
    assert resp.status_code == 200
    rows = resp.data["results"] if isinstance(resp.data, dict) else resp.data
    assert all("unresolved_assignee_count" not in row for row in rows)


# ---------------------------------------------------------------------------
# Source validation (input hygiene)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_invalid_source_rejected(project: Project, admin_user: Any) -> None:
    _token, raw = _mint_token(project, admin_user)
    client = _bearer(APIClient(), raw)
    resp = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "Jira-Cloud!", "external_id": "X-1"},
        format="json",
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_empty_external_id_rejected(project: Project, admin_user: Any) -> None:
    _token, raw = _mint_token(project, admin_user)
    client = _bearer(APIClient(), raw)
    resp = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "   "},
        format="json",
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# #1767 — the bulk .update() path must re-apply the coercions Task.save() /
# TaskSerializer.update() do, and fire task_status_changed, on a status flip.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_external_complete_coerces_percent_and_stamps_actual_finish(
    project: Project, admin_user: Any
) -> None:
    """A task flipped to COMPLETE by an external push lands at 100% with an
    actual_finish and zero remaining effort — not 0% with no dates (#1767)."""
    _token, raw = _mint_token(project, admin_user)
    client = _bearer(APIClient(), raw)
    # Create as "todo" (NOT_STARTED) so the flip travels the bulk-.update() path.
    client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "name": "v1", "status": "todo"},
        format="json",
    )
    resp = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "name": "v1", "status": "done"},
        format="json",
    )
    task = Task.objects.get(pk=resp.data["task_id"])
    assert task.status == TaskStatus.COMPLETE
    assert task.percent_complete == 100.0
    assert task.actual_finish == timezone.localdate()
    assert task.remaining_points == 0


@pytest.mark.django_db
def test_external_in_progress_stamps_actual_start(project: Project, admin_user: Any) -> None:
    """IN_PROGRESS via the external push stamps actual_start when it was null (#1767)."""
    _token, raw = _mint_token(project, admin_user)
    client = _bearer(APIClient(), raw)
    client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "status": "todo"},
        format="json",
    )
    resp = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "status": "in_progress"},
        format="json",
    )
    task = Task.objects.get(pk=resp.data["task_id"])
    assert task.status == TaskStatus.IN_PROGRESS
    assert task.actual_start == timezone.localdate()


@pytest.mark.django_db
def test_external_status_flip_fires_task_status_changed(project: Project, admin_user: Any) -> None:
    """The bulk .update() path fires task_status_changed so burndown upserts and
    notification delivery still run for externally-driven flips (#1767)."""
    from trueppm_api.apps.projects.signals import task_status_changed

    received: list[dict[str, Any]] = []

    def _probe(sender: Any, **kwargs: Any) -> None:
        received.append(kwargs)

    _token, raw = _mint_token(project, admin_user)
    client = _bearer(APIClient(), raw)
    client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "status": "todo"},
        format="json",
    )
    task_status_changed.connect(_probe)
    try:
        client.post(
            f"/api/v1/projects/{project.pk}/task-sync/",
            {"source": "jira", "external_id": "X-1", "status": "done"},
            format="json",
        )
    finally:
        task_status_changed.disconnect(_probe)

    assert len(received) == 1
    assert received[0]["old_status"] == TaskStatus.NOT_STARTED.value
    assert received[0]["new_status"] == TaskStatus.COMPLETE.value


@pytest.mark.django_db
def test_external_repush_without_status_change_does_not_fire_signal(
    project: Project, admin_user: Any
) -> None:
    """A re-push that does not change status must not fire task_status_changed
    (no spurious notifications / burndown churn) (#1767)."""
    from trueppm_api.apps.projects.signals import task_status_changed

    received: list[dict[str, Any]] = []

    def _probe(sender: Any, **kwargs: Any) -> None:
        received.append(kwargs)

    _token, raw = _mint_token(project, admin_user)
    client = _bearer(APIClient(), raw)
    client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "name": "v1", "status": "in_progress"},
        format="json",
    )
    task_status_changed.connect(_probe)
    try:
        client.post(
            f"/api/v1/projects/{project.pk}/task-sync/",
            {"source": "jira", "external_id": "X-1", "name": "v2", "status": "in_progress"},
            format="json",
        )
    finally:
        task_status_changed.disconnect(_probe)
    assert received == []


@pytest.mark.django_db
def test_external_reopen_from_complete_clears_finish_and_restores_remaining(
    project: Project, admin_user: Any
) -> None:
    """Reopening a COMPLETE task via the external push clears actual_finish and
    restores remaining effort from the commitment baseline, mirroring the REST
    path so burndown counts the reopened work again (#1767)."""
    _token, raw = _mint_token(project, admin_user)
    client = _bearer(APIClient(), raw)
    client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "status": "todo", "story_points": 8},
        format="json",
    )
    # Flip to done → remaining zeroed, actual_finish stamped.
    client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "status": "done", "story_points": 8},
        format="json",
    )
    # Reopen → done reverted.
    resp = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "status": "in_progress", "story_points": 8},
        format="json",
    )
    task = Task.objects.get(pk=resp.data["task_id"])
    assert task.status == TaskStatus.IN_PROGRESS
    assert task.actual_finish is None
    assert task.remaining_points == 8


# ---------------------------------------------------------------------------
# History rows for inbound updates (#1876)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_external_update_writes_historical_task_row(project: Project, admin_user: Any) -> None:
    """The bulk-.update() path writes an explicit HistoricalTask row so
    external-system/agent edits appear in activity and history surfaces (#1876).
    The row must reflect POST-update values (including the #1767 coercions)."""
    _token, raw = _mint_token(project, admin_user)
    client = _bearer(APIClient(), raw)
    resp1 = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "name": "v1", "status": "todo"},
        format="json",
    )
    task = Task.objects.get(pk=resp1.data["task_id"])
    rows_before = task.history.count()

    client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "name": "v2", "status": "done"},
        format="json",
    )

    assert task.history.count() == rows_before + 1
    record = task.history.order_by("-history_date").first()
    assert record is not None
    assert record.history_type == "~"
    # simple_history's middleware context resolves request.user, which the token
    # auth class sets to token.created_by — the same attribution the create
    # branch's post_save "+" row gets.
    assert record.history_user == admin_user
    assert record.history_change_reason == "inbound sync: jira"
    # Post-update field values, including the status-transition coercions.
    assert record.name == "v2"
    assert record.status == TaskStatus.COMPLETE.value
    assert record.percent_complete == 100.0
    assert record.actual_finish == timezone.localdate()
    assert record.remaining_points == 0
    assert record.id == task.pk
    assert record.project_id == project.pk


@pytest.mark.django_db
def test_external_update_does_not_double_bump_server_version(
    project: Project, admin_user: Any
) -> None:
    """Writing the explicit history row must not touch the task row itself —
    server_version increments exactly once per inbound update (#1876)."""
    _token, raw = _mint_token(project, admin_user)
    client = _bearer(APIClient(), raw)
    resp1 = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "name": "v1", "status": "todo"},
        format="json",
    )
    task = Task.objects.get(pk=resp1.data["task_id"])
    version_before = task.server_version

    client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "name": "v2", "status": "todo"},
        format="json",
    )

    task.refresh_from_db()
    assert task.server_version == version_before + 1


@pytest.mark.django_db
def test_task_history_endpoint_surfaces_inbound_diff(project: Project, admin_user: Any) -> None:
    """The task history endpoint diffs the inbound-update row against the
    previous state, so external edits are visible to project members (#1876)."""
    _token, raw = _mint_token(project, admin_user)
    sync_client = _bearer(APIClient(), raw)
    resp1 = sync_client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "name": "v1", "status": "todo"},
        format="json",
    )
    task_id = resp1.data["task_id"]
    sync_client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "name": "v2", "status": "in_progress"},
        format="json",
    )

    member_client = APIClient()
    member_client.force_authenticate(admin_user)
    resp = member_client.get(f"/api/v1/projects/{project.pk}/tasks/{task_id}/history/")
    assert resp.status_code == 200
    entries = resp.data["results"]
    # Newest first: the inbound update row, then the creation (+) row.
    change = entries[0]
    assert change["history_type"] == "~"
    # Attributed to the token's creator (request.user on the token-auth path),
    # matching the creation row's attribution.
    assert change["history_user"] == admin_user.username
    diff_by_field = {d["field"]: d for d in change["diff"]}
    assert diff_by_field["name"]["old"] == "v1"
    assert diff_by_field["name"]["new"] == "v2"
    assert diff_by_field["status"]["old"] == TaskStatus.NOT_STARTED.value
    assert diff_by_field["status"]["new"] == TaskStatus.IN_PROGRESS.value


# ---------------------------------------------------------------------------
# Archived projects take no inbound writes (#3413)
# ---------------------------------------------------------------------------
#
# Every assertion here is a ROW COUNT, not a status code, and that is the point.
# `TaskSyncView`'s route spells the project id `pk`, not the `project_pk` that
# `_project_pk_from_view` defaults to, so before #3413 an `IsProjectNotArchived`
# appended to `permission_classes` resolved no project and silently passed (the
# #2745 trap). A test that asserted only "not 200" would then have gone green
# against the unfixed view, because the endpoint answers 201 — not 200 — on the
# create path it was supposed to be refusing. Counting rows is the only assertion
# that can tell "refused" from "wrong success code".


@pytest.mark.django_db
def test_inbound_push_into_an_archived_project_writes_no_rows(
    project: Project, admin_user: Any
) -> None:
    """Archived is hard read-only — the create path must be inert, not merely non-200."""
    _token, raw = _mint_token(project, admin_user)
    Project.objects.filter(pk=project.pk).update(is_archived=True)

    tasks_before = Task.objects.filter(project=project).count()
    links_before = InboundTaskLink.objects.filter(project=project).count()
    used_before = ApiTokenAuditEntry.objects.filter(
        project=project, action=ApiTokenAuditAction.USED.value
    ).count()

    resp = _bearer(APIClient(), raw).post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "ARCH-1", "name": "Should not land"},
        format="json",
    )

    assert resp.status_code == 403
    # Inertness, asserted three ways — the task, its link row, and the audit row
    # the upsert writes inside the same transaction.
    assert Task.objects.filter(project=project).count() == tasks_before
    assert InboundTaskLink.objects.filter(project=project).count() == links_before
    assert (
        ApiTokenAuditEntry.objects.filter(
            project=project, action=ApiTokenAuditAction.USED.value
        ).count()
        == used_before
    )
    assert not Task.objects.filter(project=project, name="Should not land").exists()


@pytest.mark.django_db
def test_inbound_push_into_a_live_project_still_writes(project: Project, admin_user: Any) -> None:
    """Paired control — fails if the archived gate is applied unconditionally.

    Without this, a fix that refused *every* push would satisfy the row-count test
    above and look correct.
    """
    _token, raw = _mint_token(project, admin_user)
    assert not Project.objects.get(pk=project.pk).is_archived

    resp = _bearer(APIClient(), raw).post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "LIVE-1", "name": "Should land"},
        format="json",
    )

    assert resp.status_code == 201
    assert Task.objects.filter(project=project, name="Should land").count() == 1
    assert InboundTaskLink.objects.filter(
        project=project, source="jira", external_id="LIVE-1"
    ).exists()


@pytest.mark.django_db
def test_archiving_after_a_push_freezes_the_existing_task(
    project: Project, admin_user: Any
) -> None:
    """The *update* half of the upsert is gated too.

    The create path is the obvious hole, but an integration that has already
    pushed once holds a live link row — a re-push takes the update branch and
    would rewrite name and status on a plan the PM archived precisely to stop it.
    """
    _token, raw = _mint_token(project, admin_user)
    client = _bearer(APIClient(), raw)
    first = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-7", "name": "v1", "status": "todo"},
        format="json",
    )
    assert first.status_code == 201
    task = Task.objects.get(pk=first.data["task_id"])
    version_before = task.server_version

    Project.objects.filter(pk=project.pk).update(is_archived=True)

    resp = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-7", "name": "v2", "status": "in_progress"},
        format="json",
    )

    assert resp.status_code == 403
    task.refresh_from_db()
    assert task.name == "v1"
    assert task.status == TaskStatus.NOT_STARTED.value
    assert task.server_version == version_before
    assert Task.objects.filter(project=project).count() == 1


@pytest.mark.django_db
def test_unarchiving_restores_inbound_pushes(project: Project, admin_user: Any) -> None:
    """The refusal tracks the flag, not the token — it clears when the project does."""
    _token, raw = _mint_token(project, admin_user)
    client = _bearer(APIClient(), raw)
    Project.objects.filter(pk=project.pk).update(is_archived=True)
    assert (
        client.post(
            f"/api/v1/projects/{project.pk}/task-sync/",
            {"source": "jira", "external_id": "U-1", "name": "later"},
            format="json",
        ).status_code
        == 403
    )

    Project.objects.filter(pk=project.pk).update(is_archived=False)

    resp = client.post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "U-1", "name": "later"},
        format="json",
    )
    assert resp.status_code == 201
    assert Task.objects.filter(project=project, name="later").count() == 1


@pytest.mark.django_db
def test_archived_refusal_does_not_outrank_the_idor_401(
    project: Project, other_project: Project, admin_user: Any
) -> None:
    """Ordering matters: a token for another project must still see 401, not 403.

    `IsProjectNotArchived` is declared last so the archived state of a project the
    caller holds no token for never becomes an existence oracle.
    """
    _token, raw = _mint_token(other_project, admin_user)
    Project.objects.filter(pk=project.pk).update(is_archived=True)

    resp = _bearer(APIClient(), raw).post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "IDOR-1", "name": "x"},
        format="json",
    )
    assert resp.status_code == 401
    assert not Task.objects.filter(project=project).exists()


@pytest.mark.django_db
def test_upsert_inbound_task_refuses_an_archived_project_without_a_request(
    project: Project, admin_user: Any
) -> None:
    """The floor underneath the view (#3413, mirroring !2318 / #3354).

    Archived is lifecycle state, not authority, so a non-view caller — a Celery
    task, a management command, a future webhook ingest that resolves its project
    from the body — must not reintroduce the hole. Called with no request in hand,
    which is exactly the shape DRF's permission stack cannot cover.
    """
    from rest_framework.exceptions import PermissionDenied

    from trueppm_api.apps.projects.inbound_sync import upsert_inbound_task

    token, _raw = _mint_token(project, admin_user)
    Project.objects.filter(pk=project.pk).update(is_archived=True)
    # Deliberately a STALE instance: `project` was fetched before the archive and
    # still carries is_archived=False in memory. The assert re-reads the flag, so
    # passing an instance of any age cannot opt out of the floor.
    assert project.is_archived is False

    with pytest.raises(PermissionDenied):
        upsert_inbound_task(
            project=project,
            token=token,
            payload={"source": "jira", "external_id": "SVC-1", "name": "direct"},
            source_ip=None,
        )

    assert not Task.objects.filter(project=project).exists()
    assert not InboundTaskLink.objects.filter(project=project).exists()


@pytest.mark.django_db
def test_upsert_inbound_task_still_writes_for_a_live_project_without_a_request(
    project: Project, admin_user: Any
) -> None:
    """Service-layer control — the floor refuses archived projects, not all of them."""
    from trueppm_api.apps.projects.inbound_sync import upsert_inbound_task

    token, _raw = _mint_token(project, admin_user)

    result = upsert_inbound_task(
        project=project,
        token=token,
        payload={"source": "jira", "external_id": "SVC-2", "name": "direct-live"},
        source_ip=None,
    )

    assert result.created is True
    assert Task.objects.filter(project=project, name="direct-live").count() == 1


@pytest.mark.django_db
def test_archived_gate_runs_at_the_view_layer_before_serializer_validation(
    project: Project, admin_user: Any
) -> None:
    """Pins the *view* half of the fix, which the tests above cannot see.

    `assert_project_not_archived()` inside `upsert_inbound_task` raises the same
    `PermissionDenied`, with the same message, having written the same zero rows —
    so every row-count assertion above is satisfied by the service floor alone.
    Delete `project_url_kwarg = "pk"` (or `IsProjectNotArchived`) and they all stay
    green, which would leave the #2745 un-firing-permission trap that #3413 was
    actually filed about with no regression test at all.

    The discriminator is *layer ordering*, not the outcome: DRF runs
    `check_permissions` in `initial()`, before the view body deserializes anything.
    So a body missing the required `external_id` is a 403 while the view gate is
    armed, and a 400 the moment it is not — the serializer would get there first.
    """
    _token, raw = _mint_token(project, admin_user)
    Project.objects.filter(pk=project.pk).update(is_archived=True)

    resp = _bearer(APIClient(), raw).post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira"},  # no external_id — a 400 if the serializer runs first
        format="json",
    )

    assert resp.status_code == 403, (
        "Expected the permission layer to refuse before deserialization. A 400 here "
        "means IsProjectNotArchived did not fire and only the service floor is left."
    )
    assert not Task.objects.filter(project=project).exists()


@pytest.mark.django_db
def test_both_layers_refuse_with_the_identical_message(project: Project, admin_user: Any) -> None:
    """The two layers must be indistinguishable to a client (!2318's contract).

    `assert_project_not_archived` reuses `IsProjectNotArchived.message` verbatim so
    the refusal reads the same whether DRF's permission stack or the service floor
    produced it. Nothing asserted that, so the two could drift apart and an
    integrator would see the wording change depending on which caller reached it.
    """
    from rest_framework.exceptions import PermissionDenied

    from trueppm_api.apps.access.permissions import IsProjectNotArchived
    from trueppm_api.apps.projects.inbound_sync import upsert_inbound_task

    token, raw = _mint_token(project, admin_user)
    Project.objects.filter(pk=project.pk).update(is_archived=True)

    view_resp = _bearer(APIClient(), raw).post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "MSG-1", "name": "x"},
        format="json",
    )
    assert view_resp.status_code == 403
    assert str(view_resp.data["detail"]) == IsProjectNotArchived.message

    with pytest.raises(PermissionDenied) as exc:
        upsert_inbound_task(
            project=project,
            token=token,
            payload={"source": "jira", "external_id": "MSG-1", "name": "x"},
            source_ip=None,
        )
    assert str(exc.value.detail) == IsProjectNotArchived.message


@pytest.mark.django_db
def test_a_malformed_project_id_is_a_401_and_never_a_500(project: Project, admin_user: Any) -> None:
    """Pins the mask that keeps the new archived lookup off the #2785 500 path.

    The route is `projects/<pk>/task-sync/` with **no** `uuid:` converter, so `pk`
    is any string. Declaring `project_url_kwarg = "pk"` newly routes that value
    into `_project_pk_from_view` -> `_project_exists` -> `Project.objects.filter(
    pk=<garbage>)`, which reaches `UUIDField.to_python` and raises Django's
    `ValidationError` — not something DRF converts, so it would surface as a 500.

    Nothing in the permission classes themselves prevents that. What prevents it is
    *ordering*: `IsTokenForProject` parses the pk as a UUID and raises 401 first, so
    the archived lookup only ever sees a validated id. That mask is load-bearing and
    invisible in the source, which is exactly why it needs a test — reorder the list
    and this goes 500 with no other signal.
    """
    _token, raw = _mint_token(project, admin_user)

    resp = _bearer(APIClient(), raw).post(
        "/api/v1/projects/not-a-uuid/task-sync/",
        {"source": "jira", "external_id": "M-1", "name": "x"},
        format="json",
    )
    assert resp.status_code == 401


@pytest.mark.django_db
def test_a_soft_deleted_archived_project_still_answers_404_not_403(
    project: Project, admin_user: Any
) -> None:
    """The new declaration must not silently reclassify a 404 as a 403.

    Declaring `project_url_kwarg` routes this view into `_project_pk_from_view`'s
    declared-kwarg branch, which calls `_project_exists(pk)` — and that filters
    `is_deleted=False`. So for a soft-deleted project the resolver returns None and
    `IsProjectNotArchived` stands *down*, leaving the view's own
    `get_object_or_404(..., is_deleted=False)` to answer 404, exactly as before.
    Worth pinning because the archived lookup itself does not filter `is_deleted`:
    if `_project_exists` ever stopped being consulted, a soft-deleted-and-archived
    project would start answering 403, changing a published status code as a side
    effect of an internal resolver change.
    """
    _token, raw = _mint_token(project, admin_user)
    Project.objects.filter(pk=project.pk).update(is_archived=True, is_deleted=True)

    resp = _bearer(APIClient(), raw).post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "DEL-1", "name": "x"},
        format="json",
    )
    assert resp.status_code == 404
