"""Tests for the TaskNote sub-resource (ADR-0143, #740).

Covers the per-author task note "why/decision log": create + RBAC, the
read-only ``decision``/``pinned`` create seams, list ordering and read RBAC,
the 15-minute author-only edit window, pin toggle, soft-delete, the per-task
count cap, the ``task_note_created`` broadcast, and the ``latest_note_at``
freshness annotation on the task list.

Fixtures mirror ``test_task_collaboration.py``. TaskNote has no mention
throttle, so the ``_mute_throttle`` fixture is intentionally omitted.
"""

from __future__ import annotations

from datetime import date, timedelta
from unittest.mock import Mock, patch

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Task,
    TaskNote,
)
from trueppm_api.apps.projects.serializers import (
    MAX_NOTE_BODY_CHARS,
    NOTE_EDIT_WINDOW_SECONDS,
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
def admin(db: object) -> object:
    return User.objects.create_user(username="admin", password="pw")


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
    admin: object,
    member: object,
    member2: object,
    viewer: object,
) -> None:
    ProjectMembership.objects.create(project=project, user=owner, role=Role.OWNER)
    ProjectMembership.objects.create(project=project, user=admin, role=Role.ADMIN)
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
def admin_client(admin: object) -> APIClient:
    return _client_for(admin)


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


def _notes_list_url(project: Project, task: Task) -> str:
    return f"/api/v1/projects/{project.pk}/tasks/{task.pk}/notes/"


def _notes_detail_url(project: Project, task: Task, note_pk: object) -> str:
    return f"/api/v1/projects/{project.pk}/tasks/{task.pk}/notes/{note_pk}/"


def _notes_pin_url(project: Project, task: Task, note_pk: object) -> str:
    return f"/api/v1/projects/{project.pk}/tasks/{task.pk}/notes/{note_pk}/pin/"


# ---------------------------------------------------------------------------
# 1. Create + RBAC + validation
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskNoteCreate:
    def test_member_can_create(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        r = member_client.post(
            _notes_list_url(project, task),
            {"body": "We chose Postgres for the JSONB indexes."},
            format="json",
        )
        assert r.status_code == 201, r.data
        assert r.data["body"] == "We chose Postgres for the JSONB indexes."
        assert r.data["author"]["username"] == "member"
        assert r.data["pinned"] is False
        assert r.data["decision"] is False
        assert r.data["edited_at"] is None

    def test_viewer_cannot_create(
        self,
        viewer_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        r = viewer_client.post(
            _notes_list_url(project, task),
            {"body": "Viewer note"},
            format="json",
        )
        assert r.status_code == 403

    def test_outsider_cannot_create(
        self,
        outsider_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        r = outsider_client.post(
            _notes_list_url(project, task),
            {"body": "Outsider note"},
            format="json",
        )
        assert r.status_code in (403, 404)

    def test_blank_body_rejected(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        r = member_client.post(
            _notes_list_url(project, task),
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
        r = member_client.post(
            _notes_list_url(project, task),
            {"body": "x" * (MAX_NOTE_BODY_CHARS + 1)},
            format="json",
        )
        assert r.status_code == 400


# ---------------------------------------------------------------------------
# 2. decision + pinned are read-only on create
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskNoteCreateReadOnlySeams:
    def test_decision_and_pinned_are_not_client_settable_on_create(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        """``decision`` (the #748 seam) and ``pinned`` are server-controlled."""
        r = member_client.post(
            _notes_list_url(project, task),
            {"body": "x", "decision": True, "pinned": True},
            format="json",
        )
        assert r.status_code == 201, r.data
        assert r.data["decision"] is False
        assert r.data["pinned"] is False
        note = TaskNote.objects.get(pk=r.data["id"])
        assert note.decision is False
        assert note.pinned is False


# ---------------------------------------------------------------------------
# 3. List + read RBAC + ordering + soft-delete exclusion
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskNoteList:
    def test_member_and_viewer_can_list(
        self,
        member_client: APIClient,
        viewer_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        member_client.post(_notes_list_url(project, task), {"body": "one"}, format="json")
        assert member_client.get(_notes_list_url(project, task)).status_code == 200
        r = viewer_client.get(_notes_list_url(project, task))
        assert r.status_code == 200
        assert len(r.data["results"]) == 1

    def test_outsider_cannot_list(
        self,
        outsider_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        r = outsider_client.get(_notes_list_url(project, task))
        assert r.status_code in (403, 404)

    def test_pinned_first_then_newest(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        """Ordering is ['-pinned', '-created_at']: a pinned old note leads."""
        first = member_client.post(_notes_list_url(project, task), {"body": "first"}, format="json")
        member_client.post(_notes_list_url(project, task), {"body": "second"}, format="json")
        member_client.post(_notes_list_url(project, task), {"body": "third"}, format="json")

        # Pin the OLDEST note — it must jump to the front despite being oldest.
        pin = member_client.post(_notes_pin_url(project, task, first.data["id"]))
        assert pin.status_code == 200

        r = member_client.get(_notes_list_url(project, task))
        assert r.status_code == 200
        bodies = [n["body"] for n in r.data["results"]]
        # Pinned "first" leads; the rest are newest-first ("third", then "second").
        assert bodies == ["first", "third", "second"]

    def test_soft_deleted_notes_excluded_from_list(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        member: object,
        memberships: None,
    ) -> None:
        kept = TaskNote.objects.create(task=task, author=member, body="kept")
        gone = TaskNote.objects.create(task=task, author=member, body="gone")
        gone.soft_delete(actor=member)

        r = member_client.get(_notes_list_url(project, task))
        assert r.status_code == 200
        ids = {n["id"] for n in r.data["results"]}
        assert str(kept.pk) in ids
        assert str(gone.pk) not in ids


# ---------------------------------------------------------------------------
# 4. Edit window + author guard
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskNoteEdit:
    def test_author_can_edit_within_window(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        c = member_client.post(_notes_list_url(project, task), {"body": "v1"}, format="json")
        r = member_client.patch(
            _notes_detail_url(project, task, c.data["id"]),
            {"body": "v2"},
            format="json",
        )
        assert r.status_code == 200, r.data
        assert r.data["body"] == "v2"
        note = TaskNote.objects.get(pk=c.data["id"])
        assert note.edited_at is not None

    def test_non_author_member_cannot_edit(
        self,
        member_client: APIClient,
        member2_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        c = member_client.post(_notes_list_url(project, task), {"body": "v1"}, format="json")
        r = member2_client.patch(
            _notes_detail_url(project, task, c.data["id"]),
            {"body": "v2"},
            format="json",
        )
        # perform_update raises serializers.ValidationError → DRF renders 400
        # (same pattern as the sibling TaskComment edit guard).
        assert r.status_code == 400

    def test_author_cannot_edit_after_window(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        c = member_client.post(_notes_list_url(project, task), {"body": "v1"}, format="json")
        # Backdate created_at past the edit window.
        TaskNote.objects.filter(pk=c.data["id"]).update(
            created_at=timezone.now() - timedelta(seconds=NOTE_EDIT_WINDOW_SECONDS + 60)
        )
        r = member_client.patch(
            _notes_detail_url(project, task, c.data["id"]),
            {"body": "v2"},
            format="json",
        )
        # The serializer's update() raises ValidationError once the window has
        # closed → DRF renders 400.
        assert r.status_code == 400

    def test_viewer_cannot_edit(
        self,
        member_client: APIClient,
        viewer_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        c = member_client.post(_notes_list_url(project, task), {"body": "v1"}, format="json")
        r = viewer_client.patch(
            _notes_detail_url(project, task, c.data["id"]),
            {"body": "v2"},
            format="json",
        )
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# 5. Pin RBAC + toggle
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskNotePin:
    def test_member_can_toggle_pin(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        c = member_client.post(_notes_list_url(project, task), {"body": "x"}, format="json")
        note_id = c.data["id"]

        r1 = member_client.post(_notes_pin_url(project, task, note_id))
        assert r1.status_code == 200
        assert r1.data["pinned"] is True
        assert TaskNote.objects.get(pk=note_id).pinned is True

        r2 = member_client.post(_notes_pin_url(project, task, note_id))
        assert r2.status_code == 200
        assert r2.data["pinned"] is False
        assert TaskNote.objects.get(pk=note_id).pinned is False

    def test_viewer_cannot_pin(
        self,
        member_client: APIClient,
        viewer_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        c = member_client.post(_notes_list_url(project, task), {"body": "x"}, format="json")
        r = viewer_client.post(_notes_pin_url(project, task, c.data["id"]))
        assert r.status_code == 403

    def test_pin_is_not_author_gated(
        self,
        member_client: APIClient,
        member2_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        """Pin is curation, not authorship — any writer may pin another's note."""
        c = member_client.post(_notes_list_url(project, task), {"body": "x"}, format="json")
        r = member2_client.post(_notes_pin_url(project, task, c.data["id"]))
        assert r.status_code == 200
        assert r.data["pinned"] is True


# ---------------------------------------------------------------------------
# 6. Delete RBAC + soft-delete
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskNoteDelete:
    def test_author_can_soft_delete_own_note(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        member: object,
        memberships: None,
    ) -> None:
        c = member_client.post(_notes_list_url(project, task), {"body": "x"}, format="json")
        note_id = c.data["id"]
        r = member_client.delete(_notes_detail_url(project, task, note_id))
        assert r.status_code == 204
        note = TaskNote.objects.get(pk=note_id)
        assert note.is_deleted is True
        assert note.deleted_by_id == member.pk  # type: ignore[attr-defined]

        # It disappears from the list.
        listing = member_client.get(_notes_list_url(project, task))
        assert str(note_id) not in {n["id"] for n in listing.data["results"]}

    def test_admin_can_delete_another_users_note(
        self,
        member_client: APIClient,
        admin_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        c = member_client.post(_notes_list_url(project, task), {"body": "x"}, format="json")
        r = admin_client.delete(_notes_detail_url(project, task, c.data["id"]))
        assert r.status_code == 204
        assert TaskNote.objects.get(pk=c.data["id"]).is_deleted is True

    def test_non_author_member_cannot_delete(
        self,
        member_client: APIClient,
        member2_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        c = member_client.post(_notes_list_url(project, task), {"body": "x"}, format="json")
        r = member2_client.delete(_notes_detail_url(project, task, c.data["id"]))
        # perform_destroy raises serializers.ValidationError → DRF renders 400
        # (same pattern as the sibling TaskComment / TaskAttachment delete guard).
        assert r.status_code == 400


# ---------------------------------------------------------------------------
# 7. Per-task count cap (ADR-0143 DoS guard)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskNoteCountCap:
    def test_count_cap_enforced(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        with patch("trueppm_api.apps.projects.views.MAX_NOTES_PER_TASK", 2):
            for i in range(2):
                r = member_client.post(
                    _notes_list_url(project, task), {"body": f"note {i}"}, format="json"
                )
                assert r.status_code == 201, r.data
            # The next create exceeds the cap.
            over = member_client.post(
                _notes_list_url(project, task), {"body": "one too many"}, format="json"
            )
            assert over.status_code == 400


# ---------------------------------------------------------------------------
# 8. Broadcast wiring
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskNoteBroadcast:
    def test_create_broadcasts_task_note_created(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
        django_capture_on_commit_callbacks: object,
    ) -> None:
        """The create path fires a deferred ``task_note_created`` board event.

        The autouse fixture mutes broadcasts; re-patch the same target locally
        with a Mock and flush the on_commit callbacks to assert the call.
        """
        with patch(
            "trueppm_api.apps.sync.broadcast.broadcast_board_event",
            Mock(),
        ) as mock_bcast:
            with django_capture_on_commit_callbacks(execute=True):  # type: ignore[operator]
                r = member_client.post(
                    _notes_list_url(project, task),
                    {"body": "decision recorded"},
                    format="json",
                )
            assert r.status_code == 201, r.data
        assert mock_bcast.call_count == 1
        _project_id, event_type, payload = mock_bcast.call_args.args
        assert event_type == "task_note_created"
        assert payload["id"] == str(r.data["id"])
        assert payload["task_id"] == str(task.pk)


# ---------------------------------------------------------------------------
# 9. latest_note_at annotation on the task list
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskLatestNoteAtAnnotation:
    def _task_in_list(self, client: APIClient, project: Project, task: Task) -> dict:
        r = client.get(f"/api/v1/tasks/?project={project.pk}")
        assert r.status_code == 200, r.data
        rows = r.data["results"] if isinstance(r.data, dict) and "results" in r.data else r.data
        match = next((row for row in rows if row["id"] == str(task.pk)), None)
        assert match is not None, f"task {task.pk} not in list"
        return match

    def test_null_when_no_notes(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        memberships: None,
    ) -> None:
        row = self._task_in_list(member_client, project, task)
        assert row["latest_note_at"] is None

    def test_reflects_most_recent_note(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        member: object,
        memberships: None,
    ) -> None:
        older = TaskNote.objects.create(task=task, author=member, body="older")
        newer = TaskNote.objects.create(task=task, author=member, body="newer")
        # Force a deterministic ordering of created_at.
        TaskNote.objects.filter(pk=older.pk).update(created_at=timezone.now() - timedelta(hours=2))
        TaskNote.objects.filter(pk=newer.pk).update(created_at=timezone.now() - timedelta(hours=1))
        newer.refresh_from_db()

        row = self._task_in_list(member_client, project, task)
        assert row["latest_note_at"] is not None
        assert row["latest_note_at"][:19] == newer.created_at.isoformat()[:19]

    def test_excludes_soft_deleted_note(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        member: object,
        memberships: None,
    ) -> None:
        older = TaskNote.objects.create(task=task, author=member, body="older")
        newer = TaskNote.objects.create(task=task, author=member, body="newer")
        TaskNote.objects.filter(pk=older.pk).update(created_at=timezone.now() - timedelta(hours=2))
        TaskNote.objects.filter(pk=newer.pk).update(created_at=timezone.now() - timedelta(hours=1))
        # Soft-delete the newer note — latest_note_at must fall back to the older.
        newer.refresh_from_db()
        newer.soft_delete(actor=member)
        older.refresh_from_db()

        row = self._task_in_list(member_client, project, task)
        assert row["latest_note_at"] is not None
        assert row["latest_note_at"][:19] == older.created_at.isoformat()[:19]
