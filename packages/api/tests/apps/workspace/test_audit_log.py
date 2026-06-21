"""Tests for the OSS operational audit log (#859, ADR-0157).

Covers the ``record_audit_event`` choke point + ``audit_event_created`` signal,
the eight emission sites that live in the workspace app (member add/remove/role-
change, ownership transfer, settings change, export trigger — project create/
delete are exercised in ``tests/apps/projects/test_audit_log.py``), and the
Owner/Admin-only read endpoint (RBAC, pagination, filters, N+1 safety).
"""

from __future__ import annotations

from datetime import timedelta

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.workspace import services
from trueppm_api.apps.workspace.models import (
    AuditEvent,
    AuditEventType,
    MemberStatus,
    Workspace,
    WorkspaceMembership,
    WorkspaceRole,
)
from trueppm_api.apps.workspace.signals import audit_event_created

User = get_user_model()

AUDIT_URL = "/api/v1/workspace/audit-events/"
ACCEPT_URL = "/api/v1/workspace/invites/accept/"
TRANSFER_URL = "/api/v1/workspace/transfer-ownership/"
EXPORT_URL = "/api/v1/workspace/export/"
SETTINGS_URL = "/api/v1/workspace/"


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _member_detail(user: object) -> str:
    return f"/api/v1/workspace/members/{user.pk}/"


@pytest.fixture
def owner(db: object) -> object:
    user = User.objects.create_user(username="ws_owner", password="pw", email="owner@x.io")
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=user, role=WorkspaceRole.OWNER
    )
    return user


@pytest.fixture
def admin(db: object) -> object:
    user = User.objects.create_user(username="ws_admin", password="pw", email="admin@x.io")
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=user, role=WorkspaceRole.ADMIN
    )
    return user


@pytest.fixture
def member(db: object) -> object:
    return User.objects.create_user(username="ws_member", password="pw", email="m@x.io")


# ---------------------------------------------------------------------------
# record_audit_event service + signal extension point
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_record_audit_event_writes_row(member: object) -> None:
    event = services.record_audit_event(
        event_type=AuditEventType.SETTINGS_CHANGED,
        actor=member,
        target_type="workspace",
        target_label="Workspace settings",
        metadata={"fields": ["name"]},
    )
    assert AuditEvent.objects.filter(pk=event.pk).exists()
    assert event.event_type == AuditEventType.SETTINGS_CHANGED
    assert event.actor_id == member.pk
    # Denormalized label is captured at event time so the row survives user deletion.
    assert event.actor_label == "m@x.io"
    assert event.metadata == {"fields": ["name"]}


@pytest.mark.django_db
def test_system_actor_is_null_with_blank_label() -> None:
    event = services.record_audit_event(event_type=AuditEventType.EXPORT_TRIGGERED, actor=None)
    assert event.actor_id is None
    assert event.actor_label == ""


@pytest.mark.django_db
def test_actor_label_survives_user_deletion(member: object) -> None:
    event = services.record_audit_event(event_type=AuditEventType.MEMBER_ADDED, actor=member)
    member.delete()
    event.refresh_from_db()
    assert event.actor_id is None  # FK SET_NULL
    assert event.actor_label == "m@x.io"  # but the log stays readable


@pytest.mark.django_db
def test_signal_fires_after_commit(member, django_capture_on_commit_callbacks) -> None:
    received: list[AuditEvent] = []

    def _receiver(sender, audit_event, **kwargs):
        received.append(audit_event)

    audit_event_created.connect(_receiver, weak=False)
    try:
        with django_capture_on_commit_callbacks(execute=True):
            services.record_audit_event(event_type=AuditEventType.SETTINGS_CHANGED, actor=member)
        assert len(received) == 1
        assert received[0].event_type == AuditEventType.SETTINGS_CHANGED
    finally:
        audit_event_created.disconnect(_receiver)


@pytest.mark.django_db
def test_raising_receiver_cannot_break_write_path(
    member, django_capture_on_commit_callbacks
) -> None:
    """send_robust swallows a raising enterprise receiver — OSS write path is safe."""

    def _boom(sender, audit_event, **kwargs):
        raise RuntimeError("enterprise receiver blew up")

    audit_event_created.connect(_boom, weak=False)
    try:
        with django_capture_on_commit_callbacks(execute=True):
            event = services.record_audit_event(
                event_type=AuditEventType.SETTINGS_CHANGED, actor=member
            )
        # No exception propagated, and the row is committed.
        assert AuditEvent.objects.filter(pk=event.pk).exists()
    finally:
        audit_event_created.disconnect(_boom)


# ---------------------------------------------------------------------------
# Emission sites (workspace app)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_accept_invite_logs_member_added(admin: object) -> None:
    invite = services.create_invite(
        workspace=Workspace.load(), email="join@x.io", role=WorkspaceRole.MEMBER, invited_by=admin
    )
    APIClient().post(
        ACCEPT_URL,
        {"token": invite.email_token, "username": "joiner", "password": "s3cretpw123"},
        format="json",
    )
    event = AuditEvent.objects.get(event_type=AuditEventType.MEMBER_ADDED)
    assert event.target_type == "member"
    assert event.target_label == "join@x.io"
    assert event.metadata == {"role": "Member", "source": "invite"}


@pytest.mark.django_db
def test_patch_role_change_logs_event(owner: object, member: object) -> None:
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=member, role=WorkspaceRole.MEMBER
    )
    resp = _client(owner).patch(
        _member_detail(member), {"role": WorkspaceRole.ADMIN}, format="json"
    )
    assert resp.status_code == 200
    event = AuditEvent.objects.get(event_type=AuditEventType.MEMBER_ROLE_CHANGED)
    assert event.actor_id == owner.pk
    assert event.target_label == "m@x.io"
    assert event.metadata == {"old_role": "Member", "new_role": "Admin"}


@pytest.mark.django_db
def test_patch_status_only_does_not_log_role_change(owner: object, member: object) -> None:
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=member, role=WorkspaceRole.MEMBER
    )
    _client(owner).patch(
        _member_detail(member), {"status": MemberStatus.DEACTIVATED}, format="json"
    )
    assert not AuditEvent.objects.filter(event_type=AuditEventType.MEMBER_ROLE_CHANGED).exists()


@pytest.mark.django_db
def test_delete_member_logs_removed(owner: object, member: object) -> None:
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=member, role=WorkspaceRole.MEMBER
    )
    resp = _client(owner).delete(_member_detail(member))
    assert resp.status_code == 204
    event = AuditEvent.objects.get(event_type=AuditEventType.MEMBER_REMOVED)
    assert event.actor_id == owner.pk
    assert event.target_label == "m@x.io"
    assert event.metadata == {"role": "Member"}


@pytest.mark.django_db
def test_transfer_ownership_logs_event(owner: object, member: object) -> None:
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=member, role=WorkspaceRole.MEMBER
    )
    resp = _client(owner).post(TRANSFER_URL, {"new_owner_user_id": member.pk}, format="json")
    assert resp.status_code == 200
    event = AuditEvent.objects.get(event_type=AuditEventType.OWNERSHIP_TRANSFERRED)
    assert event.actor_id == owner.pk
    assert event.metadata == {"new_owner_user_id": member.pk}


@pytest.mark.django_db
def test_settings_patch_logs_changed_fields(admin: object) -> None:
    resp = _client(admin).patch(
        SETTINGS_URL, {"name": "Acme PMO", "allow_guests": False}, format="json"
    )
    assert resp.status_code == 200
    event = AuditEvent.objects.get(event_type=AuditEventType.SETTINGS_CHANGED)
    assert event.actor_id == admin.pk
    # Keys only — never the values, which may be large/sensitive (branding blobs).
    assert event.metadata == {"fields": ["allow_guests", "name"]}


@pytest.mark.django_db
def test_export_logs_once_and_dedupes(owner: object) -> None:
    _client(owner).post(EXPORT_URL)
    # Second request finds the in-flight job and must NOT mint a second event.
    _client(owner).post(EXPORT_URL)
    events = AuditEvent.objects.filter(event_type=AuditEventType.EXPORT_TRIGGERED)
    assert events.count() == 1
    assert events.first().target_type == "workspace_export"


# ---------------------------------------------------------------------------
# Read endpoint — RBAC, pagination, filtering, N+1
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_read_requires_authentication() -> None:
    resp = APIClient().get(AUDIT_URL)
    assert resp.status_code == 401


@pytest.mark.django_db
def test_member_cannot_read_audit_log(member: object) -> None:
    resp = _client(member).get(AUDIT_URL)
    assert resp.status_code == 403


@pytest.mark.django_db
def test_admin_can_read_audit_log(admin: object) -> None:
    services.record_audit_event(event_type=AuditEventType.SETTINGS_CHANGED, actor=admin)
    resp = _client(admin).get(AUDIT_URL)
    assert resp.status_code == 200
    assert resp.data["results"][0]["event_type"] == AuditEventType.SETTINGS_CHANGED.value


@pytest.mark.django_db
def test_owner_can_read_audit_log(owner: object) -> None:
    resp = _client(owner).get(AUDIT_URL)
    assert resp.status_code == 200
    assert "results" in resp.data


@pytest.mark.django_db
def test_results_are_newest_first(admin: object) -> None:
    first = services.record_audit_event(event_type=AuditEventType.MEMBER_ADDED, actor=admin)
    AuditEvent.objects.filter(pk=first.pk).update(created_at=timezone.now() - timedelta(days=1))
    second = services.record_audit_event(event_type=AuditEventType.MEMBER_REMOVED, actor=admin)
    resp = _client(admin).get(AUDIT_URL)
    ids = [row["id"] for row in resp.data["results"]]
    assert ids[0] == str(second.pk)
    assert ids[1] == str(first.pk)


@pytest.mark.django_db
def test_filter_by_event_type(admin: object) -> None:
    services.record_audit_event(event_type=AuditEventType.MEMBER_ADDED, actor=admin)
    services.record_audit_event(event_type=AuditEventType.PROJECT_CREATED, actor=admin)
    resp = _client(admin).get(AUDIT_URL, {"event_type": AuditEventType.MEMBER_ADDED.value})
    types = {row["event_type"] for row in resp.data["results"]}
    assert types == {AuditEventType.MEMBER_ADDED.value}


@pytest.mark.django_db
def test_unknown_event_type_is_400(admin: object) -> None:
    resp = _client(admin).get(AUDIT_URL, {"event_type": "not_a_real_event"})
    assert resp.status_code == 400


@pytest.mark.django_db
def test_filter_by_actor(admin: object, owner: object) -> None:
    services.record_audit_event(event_type=AuditEventType.MEMBER_ADDED, actor=admin)
    services.record_audit_event(event_type=AuditEventType.MEMBER_ADDED, actor=owner)
    resp = _client(admin).get(AUDIT_URL, {"actor": str(owner.pk)})
    actor_ids = {row["actor_id"] for row in resp.data["results"]}
    assert actor_ids == {owner.pk}


@pytest.mark.django_db
def test_non_integer_actor_is_400(admin: object) -> None:
    resp = _client(admin).get(AUDIT_URL, {"actor": "abc"})
    assert resp.status_code == 400


@pytest.mark.django_db
def test_filter_by_date_range(admin: object) -> None:
    old = services.record_audit_event(event_type=AuditEventType.MEMBER_ADDED, actor=admin)
    AuditEvent.objects.filter(pk=old.pk).update(created_at=timezone.now() - timedelta(days=10))
    recent = services.record_audit_event(event_type=AuditEventType.MEMBER_REMOVED, actor=admin)
    since = (timezone.now() - timedelta(days=1)).isoformat()
    resp = _client(admin).get(AUDIT_URL, {"since": since})
    ids = {row["id"] for row in resp.data["results"]}
    assert ids == {str(recent.pk)}


@pytest.mark.django_db
def test_invalid_date_bound_is_400(admin: object) -> None:
    resp = _client(admin).get(AUDIT_URL, {"since": "not-a-date"})
    assert resp.status_code == 400


@pytest.mark.django_db
def test_read_is_not_n_plus_one(admin: object, django_assert_max_num_queries) -> None:
    # Each event has a distinct actor — without select_related("actor") the
    # serializer would issue one extra query per row.
    for i in range(6):
        actor = User.objects.create_user(username=f"actor{i}", password="pw", email=f"a{i}@x.io")
        services.record_audit_event(event_type=AuditEventType.MEMBER_ADDED, actor=actor)
    with django_assert_max_num_queries(8):
        resp = _client(admin).get(AUDIT_URL)
    assert resp.status_code == 200
    assert len(resp.data["results"]) == 6
