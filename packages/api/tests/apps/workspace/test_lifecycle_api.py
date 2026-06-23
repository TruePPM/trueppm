"""Tests for the Workspace lifecycle API (#641, ADR-0174).

Covers the Owner-only gate, transfer-ownership demotion, the async export job +
authenticated download, and the hard-delete factory reset (typed-confirmation
header + full purge).
"""

from __future__ import annotations

from datetime import date, timedelta
from unittest.mock import patch

import pytest
from celery.exceptions import Retry
from django.contrib.auth import get_user_model
from django.core import mail
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.projects.models import Project
from trueppm_api.apps.workspace.models import (
    ExportJobStatus,
    MemberStatus,
    Workspace,
    WorkspaceExportJob,
    WorkspaceMembership,
    WorkspaceRole,
)

User = get_user_model()

TRANSFER_URL = "/api/v1/workspace/transfer-ownership/"
EXPORT_URL = "/api/v1/workspace/export/"
WORKSPACE_URL = "/api/v1/workspace/"


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def owner(db: object) -> object:
    """A regular user with an explicit OWNER membership (not a superuser)."""
    user = User.objects.create_user(username="ws_owner", password="pw", email="owner@example.com")
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=user, role=WorkspaceRole.OWNER
    )
    return user


@pytest.fixture
def member(db: object) -> object:
    user = User.objects.create_user(username="ws_member", password="pw")
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=user, role=WorkspaceRole.MEMBER
    )
    return user


# ---------------------------------------------------------------------------
# Transfer ownership
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_owner_transfers_ownership_and_is_demoted(owner: object, member: object) -> None:
    resp = _client(owner).post(TRANSFER_URL, {"new_owner_user_id": member.pk}, format="json")
    assert resp.status_code == 200

    new_owner_row = WorkspaceMembership.objects.get(user=member)
    old_owner_row = WorkspaceMembership.objects.get(user=owner)
    assert new_owner_row.role == WorkspaceRole.OWNER
    assert old_owner_row.role == WorkspaceRole.ADMIN
    assert new_owner_row.role_changed_at is not None


@pytest.mark.django_db
def test_member_cannot_transfer(owner: object, member: object) -> None:
    resp = _client(member).post(TRANSFER_URL, {"new_owner_user_id": owner.pk}, format="json")
    assert resp.status_code == 403
    assert WorkspaceMembership.objects.get(user=owner).role == WorkspaceRole.OWNER


@pytest.mark.django_db
def test_transfer_to_self_is_rejected(owner: object) -> None:
    resp = _client(owner).post(TRANSFER_URL, {"new_owner_user_id": owner.pk}, format="json")
    assert resp.status_code == 400


@pytest.mark.django_db
def test_transfer_to_non_member_is_rejected(owner: object) -> None:
    stranger = User.objects.create_user(username="stranger", password="pw")
    resp = _client(owner).post(TRANSFER_URL, {"new_owner_user_id": stranger.pk}, format="json")
    assert resp.status_code == 400


@pytest.mark.django_db
def test_transfer_to_deactivated_member_is_rejected(owner: object) -> None:
    deactivated = User.objects.create_user(username="gone", password="pw")
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(),
        user=deactivated,
        role=WorkspaceRole.MEMBER,
        status=MemberStatus.DEACTIVATED,
    )
    resp = _client(owner).post(TRANSFER_URL, {"new_owner_user_id": deactivated.pk}, format="json")
    assert resp.status_code == 400


@pytest.mark.django_db
def test_transfer_to_unknown_user_is_404(owner: object) -> None:
    resp = _client(owner).post(TRANSFER_URL, {"new_owner_user_id": 999999}, format="json")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_owner_queues_export(owner: object) -> None:
    resp = _client(owner).post(EXPORT_URL)
    assert resp.status_code == 202
    assert resp.data["status"] == ExportJobStatus.PENDING
    assert WorkspaceExportJob.objects.filter(id=resp.data["id"]).exists()


@pytest.mark.django_db
def test_member_cannot_export(member: object) -> None:
    assert _client(member).post(EXPORT_URL).status_code == 403


@pytest.mark.django_db
def test_member_cannot_read_export_status(owner: object, member: object) -> None:
    job = WorkspaceExportJob.objects.create(requested_by=owner)
    assert _client(member).get(f"{EXPORT_URL}{job.id}/").status_code == 403


@pytest.mark.django_db
def test_export_task_builds_archive_and_emails_owner(owner: object) -> None:
    # Some real data to serialize.
    Project.objects.create(name="Apollo", start_date=date(2026, 1, 1))
    job = WorkspaceExportJob.objects.create(requested_by=owner)

    from trueppm_api.apps.workspace.tasks import run_workspace_export

    run_workspace_export.apply(args=[str(job.id)], throw=True)

    job.refresh_from_db()
    assert job.status == ExportJobStatus.SUCCESS
    assert job.file_path
    assert job.file_size and job.file_size > 0
    assert job.expires_at is not None
    # Owner is notified.
    assert any("export is ready" in m.subject for m in mail.outbox)


@pytest.mark.django_db
def test_export_status_exposes_download_url_when_ready(owner: object) -> None:
    job = WorkspaceExportJob.objects.create(requested_by=owner)
    from trueppm_api.apps.workspace.tasks import run_workspace_export

    run_workspace_export.apply(args=[str(job.id)], throw=True)

    resp = _client(owner).get(f"{EXPORT_URL}{job.id}/")
    assert resp.status_code == 200
    assert resp.data["status"] == ExportJobStatus.SUCCESS
    assert resp.data["download_url"] == f"/api/v1/workspace/export/{job.id}/download/"


@pytest.mark.django_db
def test_owner_downloads_ready_export(owner: object) -> None:
    job = WorkspaceExportJob.objects.create(requested_by=owner)
    from trueppm_api.apps.workspace.tasks import run_workspace_export

    run_workspace_export.apply(args=[str(job.id)], throw=True)

    resp = _client(owner).get(f"{EXPORT_URL}{job.id}/download/")
    assert resp.status_code == 200
    body = b"".join(resp.streaming_content)
    # gzip magic number — confirms a real .tar.gz came back.
    assert body[:2] == b"\x1f\x8b"


@pytest.mark.django_db
def test_download_before_ready_is_409(owner: object) -> None:
    job = WorkspaceExportJob.objects.create(requested_by=owner)
    assert _client(owner).get(f"{EXPORT_URL}{job.id}/download/").status_code == 409


@pytest.mark.django_db
def test_download_after_expiry_is_410(owner: object) -> None:
    job = WorkspaceExportJob.objects.create(
        requested_by=owner,
        status=ExportJobStatus.SUCCESS,
        file_path="workspace-exports/x.tar.gz",
        expires_at=timezone.now() - timedelta(days=1),
    )
    assert _client(owner).get(f"{EXPORT_URL}{job.id}/download/").status_code == 410


# ---------------------------------------------------------------------------
# Delete (hard delete / factory reset)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_owner_deletes_workspace_with_confirmation(owner: object) -> None:
    ws = Workspace.load()
    ws.name = "Acme"
    ws.save(update_fields=["name"])
    Project.objects.create(name="Doomed", start_date=date(2026, 1, 1))

    resp = _client(owner).delete(WORKSPACE_URL, headers={"X-Confirm-Workspace": "Acme"})
    assert resp.status_code == 204
    # Data purged and the singleton row gone (it re-materializes lazily on load()).
    assert Workspace.objects.count() == 0
    assert Project.objects.count() == 0
    assert WorkspaceMembership.objects.count() == 0


@pytest.mark.django_db
def test_delete_without_confirmation_header_is_400(owner: object) -> None:
    Workspace.load()
    resp = _client(owner).delete(WORKSPACE_URL)
    assert resp.status_code == 400
    assert Workspace.objects.count() == 1


@pytest.mark.django_db
def test_delete_with_wrong_confirmation_is_400(owner: object) -> None:
    ws = Workspace.load()
    ws.name = "Acme"
    ws.save(update_fields=["name"])
    resp = _client(owner).delete(WORKSPACE_URL, headers={"X-Confirm-Workspace": "wrong"})
    assert resp.status_code == 400
    assert Workspace.objects.count() == 1


@pytest.mark.django_db
def test_member_cannot_delete_workspace(member: object) -> None:
    ws = Workspace.load()
    resp = _client(member).delete(WORKSPACE_URL, headers={"X-Confirm-Workspace": ws.name})
    assert resp.status_code == 403
    assert Workspace.objects.count() == 1


# ---------------------------------------------------------------------------
# Export task lifecycle — idempotency gate, retry/permanent-fail, drain, purge,
# and the owner-ready email (ADR-0174 §Durable Execution).
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_export_task_no_ops_for_unknown_job() -> None:
    """A duplicate/late delivery for a deleted job is a safe no-op (not a crash)."""
    from trueppm_api.apps.workspace.tasks import run_workspace_export

    # A well-formed but non-existent UUID — claim finds nothing and returns.
    run_workspace_export.run("00000000-0000-0000-0000-000000000000")


@pytest.mark.django_db
def test_export_task_skips_already_completed_job(owner: object) -> None:
    """A redundant delivery for a finished job never rebuilds the archive."""
    from trueppm_api.apps.workspace.tasks import run_workspace_export

    job = WorkspaceExportJob.objects.create(
        requested_by=owner, status=ExportJobStatus.SUCCESS, file_path="ws/done.tar.gz"
    )
    assert str(job).startswith("WorkspaceExportJob(")  # __str__ smoke

    with patch("trueppm_api.apps.workspace.export.build_and_store_archive") as mock_build:
        run_workspace_export.run(str(job.id))

    mock_build.assert_not_called()
    job.refresh_from_db()
    assert job.status == ExportJobStatus.SUCCESS
    assert job.file_path == "ws/done.tar.gz"


@pytest.mark.django_db
def test_export_task_retries_on_transient_failure(owner: object) -> None:
    """A transient build error reschedules via self.retry and leaves the job running."""
    from trueppm_api.apps.workspace.tasks import run_workspace_export

    job = WorkspaceExportJob.objects.create(requested_by=owner)
    with (
        patch(
            "trueppm_api.apps.workspace.export.build_and_store_archive",
            side_effect=RuntimeError("transient"),
        ),
        patch.object(run_workspace_export, "retry", side_effect=Retry()) as mock_retry,
        pytest.raises(Retry),
    ):
        run_workspace_export.run(str(job.id))

    mock_retry.assert_called_once()
    job.refresh_from_db()
    # Stays RUNNING so the retried delivery is allowed back through the claim gate.
    assert job.status == ExportJobStatus.RUNNING


@pytest.mark.django_db
def test_export_task_marks_failed_after_retries_exhausted(owner: object) -> None:
    """Once retries are exhausted the job is marked FAILED with the error recorded."""
    from trueppm_api.apps.workspace.tasks import EXPORT_MAX_RETRIES, run_workspace_export

    job = WorkspaceExportJob.objects.create(requested_by=owner)
    run_workspace_export.push_request(retries=EXPORT_MAX_RETRIES)
    try:
        with patch(
            "trueppm_api.apps.workspace.export.build_and_store_archive",
            side_effect=RuntimeError("permanent boom"),
        ):
            run_workspace_export.run(str(job.id))
    finally:
        run_workspace_export.pop_request()

    job.refresh_from_db()
    assert job.status == ExportJobStatus.FAILED
    assert "permanent boom" in job.error_detail
    assert job.completed_at is not None


@pytest.mark.django_db
def test_drain_redispatches_stranded_export(owner: object) -> None:
    """A PENDING job whose on_commit dispatch was lost (broker down) is re-queued."""
    from trueppm_api.apps.workspace.tasks import (
        EXPORT_ORPHAN_WINDOW_MINUTES,
        _do_drain_workspace_exports,
        run_workspace_export,
    )

    job = WorkspaceExportJob.objects.create(requested_by=owner, status=ExportJobStatus.PENDING)
    # created_at is auto_now_add — backdate past the orphan window so it qualifies.
    stranded_at = timezone.now() - timedelta(minutes=EXPORT_ORPHAN_WINDOW_MINUTES + 1)
    WorkspaceExportJob.objects.filter(pk=job.pk).update(created_at=stranded_at)

    with patch.object(run_workspace_export, "delay") as mock_delay:
        _do_drain_workspace_exports()

    mock_delay.assert_called_once_with(str(job.id))


@pytest.mark.django_db
def test_drain_ignores_recent_export(owner: object) -> None:
    """A freshly queued job inside the orphan window is left for its own dispatch."""
    from trueppm_api.apps.workspace.tasks import (
        _do_drain_workspace_exports,
        run_workspace_export,
    )

    WorkspaceExportJob.objects.create(requested_by=owner, status=ExportJobStatus.PENDING)
    with patch.object(run_workspace_export, "delay") as mock_delay:
        _do_drain_workspace_exports()

    mock_delay.assert_not_called()


@pytest.mark.django_db
def test_purge_deletes_expired_export_and_file(owner: object) -> None:
    """The nightly purge drops rows past expiry and deletes their stored archive."""
    from trueppm_api.apps.workspace.tasks import _do_purge_expired_exports

    job = WorkspaceExportJob.objects.create(
        requested_by=owner,
        status=ExportJobStatus.SUCCESS,
        file_path="workspace-exports/old.tar.gz",
        expires_at=timezone.now() - timedelta(days=1),
    )
    with patch("django.core.files.storage.default_storage") as mock_storage:
        _do_purge_expired_exports()

    mock_storage.delete.assert_called_once_with("workspace-exports/old.tar.gz")
    assert not WorkspaceExportJob.objects.filter(pk=job.pk).exists()


@pytest.mark.django_db
@override_settings(TRUEPPM_EXPORT_RETENTION_DAYS=None)
def test_purge_is_disabled_when_retention_is_none(owner: object) -> None:
    """Retention=None keeps archives indefinitely — the purge is a no-op."""
    from trueppm_api.apps.workspace.tasks import _do_purge_expired_exports

    job = WorkspaceExportJob.objects.create(
        requested_by=owner,
        status=ExportJobStatus.SUCCESS,
        expires_at=timezone.now() - timedelta(days=1),
    )
    _do_purge_expired_exports()
    assert WorkspaceExportJob.objects.filter(pk=job.pk).exists()


@pytest.mark.django_db
def test_export_ready_email_skipped_without_recipient() -> None:
    """No owner email address → the ready notification is skipped, not retried."""
    from trueppm_api.apps.workspace.tasks import _send_export_ready_email

    no_email = User.objects.create_user(username="noemail", password="pw")
    job = WorkspaceExportJob.objects.create(requested_by=no_email)
    assert _send_export_ready_email(str(job.id)) is False
    assert mail.outbox == []


@pytest.mark.django_db
def test_export_ready_email_handles_send_failure(owner: object) -> None:
    """An SMTP failure on the ready email is swallowed (best-effort notification)."""
    from trueppm_api.apps.workspace.tasks import _send_export_ready_email

    job = WorkspaceExportJob.objects.create(requested_by=owner)
    with patch("django.core.mail.EmailMessage.send", side_effect=RuntimeError("smtp down")):
        assert _send_export_ready_email(str(job.id)) is False
