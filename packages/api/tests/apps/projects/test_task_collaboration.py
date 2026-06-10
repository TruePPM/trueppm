"""Tests for task collaboration viewsets and serializers (ADR-0075, #310 #311).

Covers TaskAttachment, TaskComment, CommentAcknowledgement, and CommentReaction
endpoints plus the locked ADR-0075 constraints they enforce.
"""

from __future__ import annotations

from datetime import date, timedelta
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    CommentAcknowledgement,
    CommentReaction,
    Project,
    Task,
    TaskAttachment,
    TaskComment,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _mute_broadcasts() -> object:
    """Every write path schedules an on_commit broadcast; mute it for unit tests."""
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
        yield


@pytest.fixture(autouse=True)
def _mute_throttle() -> object:
    """MentionRateThrottle would hit Redis on the comment-create path — bypass."""
    with (
        patch(
            "trueppm_api.apps.notifications.throttles.MentionRateThrottle.allow_request",
            return_value=True,
        ),
        patch("trueppm_api.apps.notifications.throttles.record_mention_usage"),
    ):
        yield


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def owner(db: object) -> object:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def member(db: object) -> object:
    return User.objects.create_user(username="member", password="pw")


@pytest.fixture
def member2(db: object) -> object:
    return User.objects.create_user(username="member2", password="pw")


@pytest.fixture
def viewer(db: object) -> object:
    return User.objects.create_user(username="viewer", password="pw")


@pytest.fixture
def outsider(db: object) -> object:
    return User.objects.create_user(username="outsider", password="pw")


@pytest.fixture
def memberships(
    project: Project,
    owner: object,
    member: object,
    member2: object,
    viewer: object,
) -> None:
    ProjectMembership.objects.create(project=project, user=owner, role=Role.OWNER)
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    ProjectMembership.objects.create(project=project, user=member2, role=Role.MEMBER)
    ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)


def _client_for(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def owner_client(owner: object) -> APIClient:
    return _client_for(owner)


@pytest.fixture
def member_client(member: object) -> APIClient:
    return _client_for(member)


@pytest.fixture
def member2_client(member2: object) -> APIClient:
    return _client_for(member2)


@pytest.fixture
def viewer_client(viewer: object) -> APIClient:
    return _client_for(viewer)


@pytest.fixture
def outsider_client(outsider: object) -> APIClient:
    return _client_for(outsider)


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="Foundation", duration=1)


def _att_list_url(project: Project, task: Task) -> str:
    return f"/api/v1/projects/{project.pk}/tasks/{task.pk}/attachments/"


def _att_detail_url(project: Project, task: Task, att_pk: object) -> str:
    return f"/api/v1/projects/{project.pk}/tasks/{task.pk}/attachments/{att_pk}/"


def _comment_list_url(project: Project, task: Task) -> str:
    return f"/api/v1/projects/{project.pk}/tasks/{task.pk}/comments/"


def _comment_detail_url(project: Project, task: Task, c_pk: object) -> str:
    return f"/api/v1/projects/{project.pk}/tasks/{task.pk}/comments/{c_pk}/"


# ---------------------------------------------------------------------------
# TaskAttachment — external URL path
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskAttachmentExternalUrl:
    def test_member_can_create_external_link(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        r = member_client.post(
            _att_list_url(project, task),
            {"external_url": "https://example.com/doc", "external_title": "Doc"},
            format="json",
        )
        assert r.status_code == 201, r.data
        assert r.data["external_url"] == "https://example.com/doc"
        assert r.data["uploaded_by"]["username"] == "member"

    def test_neither_file_nor_url_rejected(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        r = member_client.post(_att_list_url(project, task), {}, format="json")
        assert r.status_code == 400

    def test_both_file_and_url_rejected(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        upload = SimpleUploadedFile("a.pdf", b"%PDF-1.4 test", content_type="application/pdf")
        r = member_client.post(
            _att_list_url(project, task),
            {"file": upload, "external_url": "https://example.com/doc"},
            format="multipart",
        )
        assert r.status_code == 400

    def test_external_url_must_be_http_or_https(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        r = member_client.post(
            _att_list_url(project, task),
            {"external_url": "javascript:alert(1)"},
            format="json",
        )
        # URLField rejects javascript:; either way the request must fail.
        assert r.status_code == 400

    def test_viewer_cannot_create(
        self,
        viewer_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        r = viewer_client.post(
            _att_list_url(project, task),
            {"external_url": "https://example.com/doc"},
            format="json",
        )
        assert r.status_code == 403

    def test_viewer_can_list(
        self,
        viewer_client: APIClient,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        member_client.post(
            _att_list_url(project, task),
            {"external_url": "https://example.com/doc"},
            format="json",
        )
        r = viewer_client.get(_att_list_url(project, task))
        assert r.status_code == 200
        assert len(r.data["results"]) == 1

    def test_non_member_blocked(
        self,
        outsider_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        r = outsider_client.get(_att_list_url(project, task))
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# TaskAttachment — file path + MIME / size enforcement
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskAttachmentFileUpload:
    def test_pdf_upload_accepted(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        upload = SimpleUploadedFile("report.pdf", b"%PDF-1.4 small", content_type="application/pdf")
        r = member_client.post(
            _att_list_url(project, task),
            {"file": upload},
            format="multipart",
        )
        assert r.status_code == 201, r.data
        assert r.data["file_mime"] == "application/pdf"

    def test_unsupported_mime_rejected(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        upload = SimpleUploadedFile("bad.exe", b"MZ\x00", content_type="application/x-msdownload")
        r = member_client.post(
            _att_list_url(project, task),
            {"file": upload},
            format="multipart",
        )
        assert r.status_code == 400

    def test_oversize_file_rejected(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        """Patch the size cap down so we don't have to allocate 100 MB."""
        upload = SimpleUploadedFile(
            "huge.pdf", b"%PDF-1.4 " + b"x" * 1024, content_type="application/pdf"
        )
        with patch("trueppm_api.apps.projects.serializers.MAX_ATTACHMENT_SIZE_BYTES", 100):
            r = member_client.post(
                _att_list_url(project, task),
                {"file": upload},
                format="multipart",
            )
        assert r.status_code == 400

    def test_html_payload_declared_as_png_rejected(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        """#1003: HTML bytes posing as image/png are caught by content sniffing.

        The client-declared content_type passes the allow-list, but the real
        bytes are not a PNG, so the upload must 400 (not be stored as an image).
        """
        upload = SimpleUploadedFile(
            "payload.png",
            b"<!DOCTYPE html><script>alert(1)</script>",
            content_type="image/png",
        )
        r = member_client.post(
            _att_list_url(project, task),
            {"file": upload},
            format="multipart",
        )
        assert r.status_code == 400
        assert "image/png" in str(r.data)

    def test_genuine_png_accepted(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        """A real PNG (correct magic bytes) declared image/png is accepted."""
        png_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
        upload = SimpleUploadedFile("real.png", png_bytes, content_type="image/png")
        r = member_client.post(
            _att_list_url(project, task),
            {"file": upload},
            format="multipart",
        )
        assert r.status_code == 201, r.data
        assert r.data["file_mime"] == "image/png"

    def test_html_payload_declared_as_csv_rejected(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        """#1003: markup posing as text/csv is rejected (csv has no binary magic)."""
        upload = SimpleUploadedFile(
            "data.csv",
            b"<svg onload=alert(1)>",
            content_type="text/csv",
        )
        r = member_client.post(
            _att_list_url(project, task),
            {"file": upload},
            format="multipart",
        )
        assert r.status_code == 400

    def test_genuine_csv_accepted(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        """A plain CSV body declared text/csv is accepted."""
        upload = SimpleUploadedFile(
            "data.csv",
            b"name,role\nAlice,PM\nBob,Dev\n",
            content_type="text/csv",
        )
        r = member_client.post(
            _att_list_url(project, task),
            {"file": upload},
            format="multipart",
        )
        assert r.status_code == 201, r.data
        assert r.data["file_mime"] == "text/csv"


# ---------------------------------------------------------------------------
# TaskAttachment — filename sanitization (#892 stored XSS / header injection)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskAttachmentFilenameSanitization:
    """file_name is echoed verbatim in responses + download headers, so HTML and
    control characters in the uploaded filename are scrubbed before storage."""

    def test_html_in_uploaded_filename_is_stripped(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        upload = SimpleUploadedFile(
            '"><script>alert(1)</script>.pdf',
            b"%PDF-1.4 x",
            content_type="application/pdf",
        )
        r = member_client.post(
            _att_list_url(project, task),
            {"file": upload},
            format="multipart",
        )
        assert r.status_code == 201, r.data
        stored = r.data["file_name"]
        # No HTML metacharacters survive the allow-list.
        for banned in ("<", ">", '"', "script"):
            if banned == "script":
                # the literal tag is broken up; ensure no '<script' sequence remains.
                assert "<script" not in stored
            else:
                assert banned not in stored
        att = TaskAttachment.objects.get(pk=r.data["id"])
        assert "<" not in att.file_name and ">" not in att.file_name

    def test_crlf_in_uploaded_filename_is_stripped(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        """CR/LF would enable header injection on Content-Disposition download."""
        upload = SimpleUploadedFile(
            "evil\nX-Inject: 1.pdf",
            b"%PDF-1.4 x",
            content_type="application/pdf",
        )
        r = member_client.post(
            _att_list_url(project, task),
            {"file": upload},
            format="multipart",
        )
        assert r.status_code == 201, r.data
        stored = r.data["file_name"]
        assert "\n" not in stored and "\r" not in stored

    def test_client_supplied_file_name_is_sanitized(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        """file_name is writable, so a client-supplied value is scrubbed too."""
        upload = SimpleUploadedFile("ok.pdf", b"%PDF-1.4 x", content_type="application/pdf")
        r = member_client.post(
            _att_list_url(project, task),
            {"file": upload, "file_name": "<img src=x onerror=alert(1)>.pdf"},
            format="multipart",
        )
        assert r.status_code == 201, r.data
        stored = r.data["file_name"]
        assert "<" not in stored and ">" not in stored


# ---------------------------------------------------------------------------
# TaskAttachment — delete + signed URL
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskAttachmentDelete:
    def test_uploader_can_soft_delete(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        create = member_client.post(
            _att_list_url(project, task),
            {"external_url": "https://example.com/doc"},
            format="json",
        )
        att_id = create.data["id"]
        r = member_client.delete(_att_detail_url(project, task, att_id))
        assert r.status_code == 204
        att = TaskAttachment.objects.get(pk=att_id)
        assert att.is_deleted is True
        assert att.deleted_at is not None

    def test_non_uploader_member_cannot_delete(
        self,
        member_client: APIClient,
        member2_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        create = member_client.post(
            _att_list_url(project, task),
            {"external_url": "https://example.com/doc"},
            format="json",
        )
        r = member2_client.delete(_att_detail_url(project, task, create.data["id"]))
        assert r.status_code == 400  # serializer raises ValidationError → 400

    def test_owner_can_delete_anyones(
        self,
        member_client: APIClient,
        owner_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        create = member_client.post(
            _att_list_url(project, task),
            {"external_url": "https://example.com/doc"},
            format="json",
        )
        r = owner_client.delete(_att_detail_url(project, task, create.data["id"]))
        assert r.status_code == 204

    def test_count_cap_enforced(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        with patch("trueppm_api.apps.projects.views.MAX_ATTACHMENTS_PER_TASK", 2):
            for i in range(2):
                r = member_client.post(
                    _att_list_url(project, task),
                    {"external_url": f"https://example.com/{i}"},
                    format="json",
                )
                assert r.status_code == 201
            # Third attempt fails
            r = member_client.post(
                _att_list_url(project, task),
                {"external_url": "https://example.com/3"},
                format="json",
            )
            assert r.status_code == 400

    def test_signed_url_rejected_for_external(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        create = member_client.post(
            _att_list_url(project, task),
            {"external_url": "https://example.com/doc"},
            format="json",
        )
        r = member_client.get(_att_detail_url(project, task, create.data["id"]) + "signed-url/")
        assert r.status_code == 400

    def test_signed_url_ttl_out_of_range_rejected(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        upload = SimpleUploadedFile("a.pdf", b"%PDF-1.4", content_type="application/pdf")
        create = member_client.post(
            _att_list_url(project, task), {"file": upload}, format="multipart"
        )
        att_id = create.data["id"]
        r = member_client.get(_att_detail_url(project, task, att_id) + "signed-url/?ttl=999999")
        assert r.status_code == 400

    def test_signed_url_ttl_not_integer_rejected(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        upload = SimpleUploadedFile("a.pdf", b"%PDF-1.4", content_type="application/pdf")
        create = member_client.post(
            _att_list_url(project, task), {"file": upload}, format="multipart"
        )
        att_id = create.data["id"]
        r = member_client.get(_att_detail_url(project, task, att_id) + "signed-url/?ttl=abc")
        assert r.status_code == 400

    def test_signed_url_happy_path(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        upload = SimpleUploadedFile("a.pdf", b"%PDF-1.4", content_type="application/pdf")
        create = member_client.post(
            _att_list_url(project, task), {"file": upload}, format="multipart"
        )
        att_id = create.data["id"]
        r = member_client.get(_att_detail_url(project, task, att_id) + "signed-url/")
        assert r.status_code == 200
        assert "url" in r.data
        assert "expires_at" in r.data


# ---------------------------------------------------------------------------
# TaskComment — CRUD + validation
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskCommentCRUD:
    def test_member_can_post(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        r = member_client.post(
            _comment_list_url(project, task),
            {"body": "Looks good"},
            format="json",
        )
        assert r.status_code == 201, r.data
        assert r.data["body"] == "Looks good"
        assert r.data["author"]["username"] == "member"

    def test_blank_body_rejected(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        r = member_client.post(
            _comment_list_url(project, task),
            {"body": "   "},
            format="json",
        )
        assert r.status_code == 400

    def test_body_over_cap_rejected(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        from trueppm_api.apps.projects.serializers import MAX_COMMENT_BODY_CHARS

        r = member_client.post(
            _comment_list_url(project, task),
            {"body": "x" * (MAX_COMMENT_BODY_CHARS + 1)},
            format="json",
        )
        assert r.status_code == 400

    def test_viewer_cannot_post(
        self,
        viewer_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        r = viewer_client.post(
            _comment_list_url(project, task),
            {"body": "Hi"},
            format="json",
        )
        assert r.status_code == 403

    def test_reply_depth_limited_to_one(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        top = member_client.post(_comment_list_url(project, task), {"body": "top"}, format="json")
        reply = member_client.post(
            _comment_list_url(project, task),
            {"body": "reply", "parent": top.data["id"]},
            format="json",
        )
        assert reply.status_code == 201
        # Reply to a reply must fail
        nested = member_client.post(
            _comment_list_url(project, task),
            {"body": "deep", "parent": reply.data["id"]},
            format="json",
        )
        assert nested.status_code == 400

    def test_parent_on_different_task_rejected(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        other_task = Task.objects.create(project=project, name="Other", duration=1)
        other_comment = TaskComment.objects.create(
            task=other_task, author=User.objects.get(username="member"), body="x"
        )
        r = member_client.post(
            _comment_list_url(project, task),
            {"body": "reply across tasks", "parent": str(other_comment.pk)},
            format="json",
        )
        assert r.status_code == 400

    def test_comment_count_cap_enforced(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        with patch("trueppm_api.apps.projects.views.MAX_COMMENTS_PER_TASK", 1):
            r1 = member_client.post(
                _comment_list_url(project, task), {"body": "one"}, format="json"
            )
            assert r1.status_code == 201
            r2 = member_client.post(
                _comment_list_url(project, task), {"body": "two"}, format="json"
            )
            assert r2.status_code == 400


# ---------------------------------------------------------------------------
# TaskComment — edit window + author guard
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskCommentEdit:
    def test_author_can_edit_within_window(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        c = member_client.post(_comment_list_url(project, task), {"body": "v1"}, format="json")
        r = member_client.patch(
            _comment_detail_url(project, task, c.data["id"]),
            {"body": "v2"},
            format="json",
        )
        assert r.status_code == 200, r.data
        assert r.data["body"] == "v2"
        comment = TaskComment.objects.get(pk=c.data["id"])
        assert comment.edited_at is not None

    def test_non_author_cannot_edit(
        self,
        member_client: APIClient,
        member2_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        c = member_client.post(_comment_list_url(project, task), {"body": "v1"}, format="json")
        r = member2_client.patch(
            _comment_detail_url(project, task, c.data["id"]),
            {"body": "v2"},
            format="json",
        )
        assert r.status_code == 400

    def test_edit_after_window_rejected(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
        member: object,
    ) -> None:
        # Create directly to backdate created_at past the window
        c = TaskComment.objects.create(task=task, author=member, body="old")
        c.created_at = timezone.now() - timedelta(hours=1)
        c.save(update_fields=["created_at"])
        r = member_client.patch(
            _comment_detail_url(project, task, c.pk),
            {"body": "new"},
            format="json",
        )
        assert r.status_code == 400


# ---------------------------------------------------------------------------
# TaskComment — delete
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskCommentDelete:
    def test_author_can_soft_delete(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        c = member_client.post(_comment_list_url(project, task), {"body": "x"}, format="json")
        r = member_client.delete(_comment_detail_url(project, task, c.data["id"]))
        assert r.status_code == 204
        comment = TaskComment.objects.get(pk=c.data["id"])
        assert comment.is_deleted is True

    def test_owner_can_delete_anyones(
        self,
        member_client: APIClient,
        owner_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        c = member_client.post(_comment_list_url(project, task), {"body": "x"}, format="json")
        r = owner_client.delete(_comment_detail_url(project, task, c.data["id"]))
        assert r.status_code == 204

    def test_other_member_cannot_delete(
        self,
        member_client: APIClient,
        member2_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        c = member_client.post(_comment_list_url(project, task), {"body": "x"}, format="json")
        r = member2_client.delete(_comment_detail_url(project, task, c.data["id"]))
        assert r.status_code == 400


# ---------------------------------------------------------------------------
# TaskComment — @mention fan-out validation (skipped users / groups)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskCommentMentionFanOut:
    def test_mentioning_nonmember_returns_400(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
        outsider: object,
    ) -> None:
        r = member_client.post(
            _comment_list_url(project, task),
            {"body": "hi @outsider"},
            format="json",
        )
        assert r.status_code == 400
        assert "skipped_users" in r.data or "detail" in r.data

    def test_mentioning_unknown_user_returns_400(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        r = member_client.post(
            _comment_list_url(project, task),
            {"body": "hi @ghost"},
            format="json",
        )
        assert r.status_code == 400

    def test_valid_mention_creates_notification(
        self,
        member_client: APIClient,
        member2: object,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        from trueppm_api.apps.notifications.models import Notification

        r = member_client.post(
            _comment_list_url(project, task),
            {"body": "hey @member2 look at this"},
            format="json",
        )
        assert r.status_code == 201, r.data
        assert Notification.objects.filter(recipient=member2).count() == 1


# ---------------------------------------------------------------------------
# Acknowledge toggle
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestCommentAcknowledge:
    def test_member_can_acknowledge(
        self,
        member_client: APIClient,
        member2_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        c = member_client.post(_comment_list_url(project, task), {"body": "x"}, format="json")
        url = _comment_detail_url(project, task, c.data["id"]) + "acknowledge/"
        r = member2_client.post(url)
        assert r.status_code == 200
        assert CommentAcknowledgement.objects.filter(comment_id=c.data["id"]).count() == 1

    def test_acknowledge_is_idempotent(
        self,
        member_client: APIClient,
        member2_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        c = member_client.post(_comment_list_url(project, task), {"body": "x"}, format="json")
        url = _comment_detail_url(project, task, c.data["id"]) + "acknowledge/"
        member2_client.post(url)
        member2_client.post(url)
        assert CommentAcknowledgement.objects.filter(comment_id=c.data["id"]).count() == 1

    def test_delete_removes_ack(
        self,
        member_client: APIClient,
        member2_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        c = member_client.post(_comment_list_url(project, task), {"body": "x"}, format="json")
        url = _comment_detail_url(project, task, c.data["id"]) + "acknowledge/"
        member2_client.post(url)
        r = member2_client.delete(url)
        assert r.status_code == 200
        assert CommentAcknowledgement.objects.filter(comment_id=c.data["id"]).count() == 0

    def test_viewer_cannot_acknowledge(
        self,
        member_client: APIClient,
        viewer_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        c = member_client.post(_comment_list_url(project, task), {"body": "x"}, format="json")
        url = _comment_detail_url(project, task, c.data["id"]) + "acknowledge/"
        r = viewer_client.post(url)
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# CommentReaction — 👍-only allow-list
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestCommentReaction:
    def _reactions_url(self, project: Project, task: Task, comment_pk: object) -> str:
        return f"/api/v1/projects/{project.pk}/tasks/{task.pk}/comments/{comment_pk}/reactions/"

    def test_thumbs_up_accepted(
        self,
        member_client: APIClient,
        member2_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        c = member_client.post(_comment_list_url(project, task), {"body": "nice"}, format="json")
        r = member2_client.post(
            self._reactions_url(project, task, c.data["id"]),
            {"emoji": "👍"},
            format="json",
        )
        assert r.status_code == 201, r.data
        assert CommentReaction.objects.filter(comment_id=c.data["id"]).count() == 1

    def test_other_emoji_rejected(
        self,
        member_client: APIClient,
        member2_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        c = member_client.post(_comment_list_url(project, task), {"body": "nice"}, format="json")
        r = member2_client.post(
            self._reactions_url(project, task, c.data["id"]),
            {"emoji": "❤️"},
            format="json",
        )
        assert r.status_code == 400

    def test_user_can_only_remove_own_reaction(
        self,
        member_client: APIClient,
        member2_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        c = member_client.post(_comment_list_url(project, task), {"body": "nice"}, format="json")
        create = member2_client.post(
            self._reactions_url(project, task, c.data["id"]),
            {"emoji": "👍"},
            format="json",
        )
        # member tries to delete member2's reaction
        url = self._reactions_url(project, task, c.data["id"]) + f"{create.data['id']}/"
        r = member_client.delete(url)
        assert r.status_code == 400

    def test_removing_own_reaction_broadcasts_removed_event(
        self,
        member_client: APIClient,
        member2_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
        django_capture_on_commit_callbacks: object,
    ) -> None:
        """Deleting one's own reaction soft-fires a body-less reaction_removed event (#837)."""
        c = member_client.post(_comment_list_url(project, task), {"body": "nice"}, format="json")
        create = member2_client.post(
            self._reactions_url(project, task, c.data["id"]),
            {"emoji": "👍"},
            format="json",
        )
        reaction_id = create.data["id"]
        # The autouse fixture mutes broadcasts; re-patch locally to assert the event.
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_bcast:
            with django_capture_on_commit_callbacks(execute=True):  # type: ignore[operator]
                url = self._reactions_url(project, task, c.data["id"]) + f"{reaction_id}/"
                r = member2_client.delete(url)
            assert r.status_code == 204, r.data
        assert not CommentReaction.objects.filter(pk=reaction_id).exists()
        assert mock_bcast.call_count == 1
        _project_id, event_type, payload = mock_bcast.call_args.args
        assert event_type == "task_comment_reaction_removed"
        assert payload["id"] == str(reaction_id)
        assert payload["comment_id"] == str(c.data["id"])
        assert payload["task_id"] == str(task.pk)

    def test_viewer_cannot_react(
        self,
        member_client: APIClient,
        viewer_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        c = member_client.post(_comment_list_url(project, task), {"body": "nice"}, format="json")
        r = viewer_client.post(
            self._reactions_url(project, task, c.data["id"]),
            {"emoji": "👍"},
            format="json",
        )
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# Model soft_delete helpers
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestModelSoftDeleteHelpers:
    def test_attachment_soft_delete_sets_actor(
        self, project: Project, task: Task, member: object
    ) -> None:
        a = TaskAttachment.objects.create(
            task=task, external_url="https://example.com/x", uploaded_by=member
        )
        a.soft_delete(actor=member)
        a.refresh_from_db()
        assert a.is_deleted is True
        assert a.deleted_by_id == member.pk  # type: ignore[attr-defined]
        assert a.deleted_at is not None

    def test_comment_soft_delete_sets_actor(
        self, project: Project, task: Task, member: object
    ) -> None:
        c = TaskComment.objects.create(task=task, author=member, body="x")
        c.soft_delete(actor=member)
        c.refresh_from_db()
        assert c.is_deleted is True
        assert c.deleted_by_id == member.pk  # type: ignore[attr-defined]
        assert c.deleted_at is not None

    def test_attachment_str_distinguishes_file_vs_url(self, project: Project, task: Task) -> None:
        url_att = TaskAttachment.objects.create(task=task, external_url="https://example.com/x")
        file_att = TaskAttachment.objects.create(
            task=task,
            file=SimpleUploadedFile("a.pdf", b"%PDF-1.4", content_type="application/pdf"),
        )
        assert "url" in str(url_att)
        assert "file" in str(file_att)


# ---------------------------------------------------------------------------
# Query-count regression tests (issue #772)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_comment_list_query_count_does_not_scale_with_acknowledgements(
    project: Project,
    task: Task,
    owner: object,
    member: object,
    member2: object,
    viewer: object,
    memberships: None,
) -> None:
    """GET comments should not issue extra queries per comment for ack/reaction counts.

    TaskCommentViewSet.get_queryset() prefetch_related("acknowledgements", "reactions")
    so the serializer fields must read that cache (len / any) rather than calling
    .count() or .filter().exists() per comment row (the original N+1 pattern).
    """
    url = _comment_list_url(project, task)
    client = _client_for(member)

    # Create 2 comments with varying ack and reaction counts.
    c1 = TaskComment.objects.create(task=task, author=owner, body="first")
    c2 = TaskComment.objects.create(task=task, author=owner, body="second")
    CommentAcknowledgement.objects.create(comment=c1, user=member)
    CommentAcknowledgement.objects.create(comment=c1, user=member2)
    CommentReaction.objects.create(comment=c2, user=member, emoji="👍")

    # Baseline: 2 comments. The list endpoint is paginated, so the comments are
    # under the "results" key of the page envelope, not the top level.
    with CaptureQueriesContext(connection) as ctx_2:
        resp = client.get(url)
    assert resp.status_code == 200
    assert len(resp.data["results"]) == 2
    baseline_count = len(ctx_2.captured_queries)

    # Add 8 more comments with acks — total 10 comments.
    for i in range(8):
        cx = TaskComment.objects.create(task=task, author=owner, body=f"c{i}")
        CommentAcknowledgement.objects.create(comment=cx, user=member)

    with CaptureQueriesContext(connection) as ctx_10:
        resp = client.get(url)
    assert resp.status_code == 200
    assert len(resp.data["results"]) == 10

    # Query count must not grow proportionally with the number of comments.
    # Allow a small fixed slack (e.g. pagination) but not 8 extra queries.
    assert len(ctx_10.captured_queries) <= baseline_count + 3, (
        f"N+1 regression: {baseline_count} queries for 2 comments, "
        f"{len(ctx_10.captured_queries)} for 10. "
        "Check that get_acknowledged_count/get_reaction_count/get_has_my_acknowledgement "
        "read the prefetch cache instead of issuing new queries."
    )
