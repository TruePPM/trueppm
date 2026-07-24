"""Tests for the informational TaskRelation API (ADR-0455, closes #2065).

A TaskRelation is a cross-reference between two tasks (``relates_to`` / ``blocks``
/ ``duplicates``) — NOT a scheduling :class:`Dependency`. It is inert: no CPM
effect, no lag, no cycle check, and crucially **no schedule recompute** on write.
Endpoints may share a project or sit in two projects of the same *program*
(ADR-0120 D1); cross-*program* links are rejected (portfolio coordination is
Enterprise, ADR-0070).

Coverage mirrors the label-attach RBAC shape and the cross-project Dependency
IDOR handling:

* Happy path — Member relates their own task; the link is visible from BOTH
  endpoints (the derived inverse).
* RBAC — Viewer denied; Member denied on a task they cannot edit; PM/Owner allowed
  on any task; the cross-project write-on-source / read-on-target asymmetry.
* IDOR — the membership-scoped queryset closes a foreign relation with a 404.
* Self-link — rejected at the serializer (400) AND the DB CheckConstraint.
* Cross-program — rejected (400 ``cross_program_relation``); same-program
  cross-project populates ``target_card``, same-project does not.
* Dedupe — a repeat (and, for ``relates_to``, the reverse) is a clean 400, never a
  500 IntegrityError.
* Soft-delete — DELETE tombstones and bumps ``server_version``; a re-create of the
  same triple is allowed by the partial-unique constraint.
* Broadcast + inertness — ``task_relation_*`` fires to both endpoint projects on
  commit, and NO CPM recompute is ever enqueued (the key inert-relation guarantee).
* PATCH — edits ``note`` only; a repoint of source/target/relation_type is rejected.
"""

from __future__ import annotations

from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Program,
    Project,
    Task,
    TaskRelation,
)

User = get_user_model()

START = date(2026, 4, 1)

LIST_URL = "/api/v1/task-relations/"


def _detail_url(pk: Any) -> str:
    return f"/api/v1/task-relations/{pk}/"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def owner_user(db: object) -> Any:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def pm_user(db: object) -> Any:
    return User.objects.create_user(username="pm", password="pw")


@pytest.fixture
def member_user(db: object) -> Any:
    return User.objects.create_user(username="member", password="pw")


@pytest.fixture
def viewer_user(db: object) -> Any:
    return User.objects.create_user(username="viewer", password="pw")


@pytest.fixture
def outsider_user(db: object) -> Any:
    return User.objects.create_user(username="outsider", password="pw")


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def owner_client(owner_user: Any) -> APIClient:
    return _client(owner_user)


@pytest.fixture
def pm_client(pm_user: Any) -> APIClient:
    return _client(pm_user)


@pytest.fixture
def member_client(member_user: Any) -> APIClient:
    return _client(member_user)


@pytest.fixture
def viewer_client(viewer_user: Any) -> APIClient:
    return _client(viewer_user)


@pytest.fixture
def outsider_client(outsider_user: Any) -> APIClient:
    return _client(outsider_user)


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def program(db: object) -> Program:
    return Program.objects.create(name="GA Launch")


@pytest.fixture
def project(calendar: Calendar, program: Program) -> Project:
    return Project.objects.create(
        name="Alpha", start_date=START, calendar=calendar, program=program
    )


@pytest.fixture
def memberships(
    project: Project,
    owner_user: Any,
    pm_user: Any,
    member_user: Any,
    viewer_user: Any,
) -> None:
    ProjectMembership.objects.create(project=project, user=owner_user, role=Role.OWNER)
    ProjectMembership.objects.create(project=project, user=pm_user, role=Role.ADMIN)
    ProjectMembership.objects.create(project=project, user=member_user, role=Role.MEMBER)
    ProjectMembership.objects.create(project=project, user=viewer_user, role=Role.VIEWER)


@pytest.fixture
def member_task(project: Project, member_user: Any) -> Task:
    # Assigned to the member so IsProjectMemberWriteOrOwn lets them relate it.
    return Task.objects.create(
        project=project, name="Refactor auth", duration=5, assignee=member_user
    )


@pytest.fixture
def other_task(project: Project) -> Task:
    # Unassigned — a Member cannot edit it (PM+ only), so it is the "no write" case.
    return Task.objects.create(project=project, name="Design review", duration=3)


def _no_broadcast() -> Any:
    """Silence the WS emitter — writes broadcast board events; tests don't need a
    live channel layer (best-effort, self-heals via sync)."""
    return patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")


def _results(data: Any) -> list[dict[str, Any]]:
    return data["results"] if isinstance(data, dict) and "results" in data else data


# ---------------------------------------------------------------------------
# 1. Happy path — Member relates their own task, visible from both endpoints
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestHappyPath:
    def test_member_creates_relates_to_on_own_task(
        self,
        member_client: APIClient,
        member_user: Any,
        member_task: Task,
        other_task: Task,
        memberships: None,
    ) -> None:
        with _no_broadcast():
            r = member_client.post(
                LIST_URL,
                {
                    "source": str(member_task.pk),
                    "target": str(other_task.pk),
                    "relation_type": "relates_to",
                    "note": "see also",
                },
                format="json",
            )
        assert r.status_code == 201, r.data
        assert r.data["relation_type"] == "relates_to"
        assert r.data["note"] == "see also"
        # created_by is server-set to the requesting user (read-only field).
        assert str(r.data["created_by"]) == str(member_user.pk)
        # Same-project relation carries no visibility card (client holds both tasks).
        assert r.data["source_card"] is None
        assert r.data["target_card"] is None

    def test_relation_visible_from_both_endpoints(
        self,
        member_client: APIClient,
        member_task: Task,
        other_task: Task,
        memberships: None,
    ) -> None:
        with _no_broadcast():
            created = member_client.post(
                LIST_URL,
                {
                    "source": str(member_task.pk),
                    "target": str(other_task.pk),
                    "relation_type": "relates_to",
                },
                format="json",
            )
        assert created.status_code == 201, created.data
        rel_id = created.data["id"]

        # From the source side.
        from_source = member_client.get(LIST_URL, {"task": str(member_task.pk)})
        assert from_source.status_code == 200
        assert rel_id in {row["id"] for row in _results(from_source.data)}

        # From the target side — the derived inverse (?task filters source OR target).
        from_target = member_client.get(LIST_URL, {"task": str(other_task.pk)})
        assert from_target.status_code == 200
        assert rel_id in {row["id"] for row in _results(from_target.data)}

    def test_list_returns_bare_array_not_paginated_envelope(
        self,
        member_client: APIClient,
        member_task: Task,
        other_task: Task,
        memberships: None,
    ) -> None:
        # Regression for #2321: the client (`useTaskRelations`) reads the list
        # response as a bare array (`res.data.map(...)`). If the project-wide
        # PageNumberPagination leaks onto this viewset the body becomes
        # `{count, next, previous, results}`, the client `.map()`s it and throws,
        # and the drawer shows "Couldn't load related tasks". Assert the raw
        # shape directly — the `_results()` helper above deliberately accepts
        # either shape, so it cannot catch this. `pagination_class = None`.
        with _no_broadcast():
            created = member_client.post(
                LIST_URL,
                {
                    "source": str(member_task.pk),
                    "target": str(other_task.pk),
                    "relation_type": "relates_to",
                },
                format="json",
            )
        assert created.status_code == 201, created.data

        listed = member_client.get(LIST_URL, {"task": str(member_task.pk)})
        assert listed.status_code == 200
        # A bare list, never a paginated envelope.
        assert isinstance(listed.data, list), listed.data
        assert created.data["id"] in {row["id"] for row in listed.data}


# ---------------------------------------------------------------------------
# 2. Permissions — Viewer / Member-no-edit denied; PM / Owner allowed
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestPermissions:
    def test_viewer_cannot_create(
        self,
        viewer_client: APIClient,
        member_task: Task,
        other_task: Task,
        memberships: None,
    ) -> None:
        r = viewer_client.post(
            LIST_URL,
            {"source": str(member_task.pk), "target": str(other_task.pk)},
            format="json",
        )
        assert r.status_code == 403, r.data

    def test_member_cannot_create_on_task_they_cannot_edit(
        self,
        member_client: APIClient,
        other_task: Task,
        member_task: Task,
        memberships: None,
    ) -> None:
        # Source is the unassigned task the Member has no edit rights on (PM+ only);
        # the write gate is evaluated against the SOURCE task.
        r = member_client.post(
            LIST_URL,
            {"source": str(other_task.pk), "target": str(member_task.pk)},
            format="json",
        )
        assert r.status_code == 403, r.data

    def test_pm_can_create_on_any_task(
        self,
        pm_client: APIClient,
        other_task: Task,
        member_task: Task,
        memberships: None,
    ) -> None:
        with _no_broadcast():
            r = pm_client.post(
                LIST_URL,
                {"source": str(other_task.pk), "target": str(member_task.pk)},
                format="json",
            )
        assert r.status_code == 201, r.data

    def test_owner_can_create_on_any_task(
        self,
        owner_client: APIClient,
        other_task: Task,
        member_task: Task,
        memberships: None,
    ) -> None:
        with _no_broadcast():
            r = owner_client.post(
                LIST_URL,
                {"source": str(other_task.pk), "target": str(member_task.pk)},
                format="json",
            )
        assert r.status_code == 201, r.data


# ---------------------------------------------------------------------------
# 3. IDOR — membership-scoped queryset; cross-project read/write asymmetry
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestIdor:
    def test_retrieve_foreign_relation_returns_404(
        self,
        outsider_client: APIClient,
        member_task: Task,
        other_task: Task,
        memberships: None,
    ) -> None:
        # A relation between two tasks in a project the caller is NOT a member of is
        # invisible: the membership-scoped queryset closes it with a 404, not a 403
        # (no existence oracle, no leak).
        rel = TaskRelation.objects.create(
            source=member_task, target=other_task, relation_type="relates_to"
        )
        r = outsider_client.get(_detail_url(rel.pk))
        assert r.status_code == 404, r.data

    def test_foreign_relation_absent_from_list(
        self,
        outsider_client: APIClient,
        member_task: Task,
        other_task: Task,
        memberships: None,
    ) -> None:
        rel = TaskRelation.objects.create(
            source=member_task, target=other_task, relation_type="relates_to"
        )
        r = outsider_client.get(LIST_URL, {"task": str(member_task.pk)})
        assert r.status_code == 200
        assert rel.pk not in {row["id"] for row in _results(r.data)}

    def test_cross_project_create_read_target_but_not_edit(
        self,
        calendar: Calendar,
        program: Program,
        pm_user: Any,
    ) -> None:
        """Write on source + read (Viewer) on target → 201; the asymmetry holds.

        The caller is Admin on the source project (can edit any source task) and a
        mere Viewer on the target project (read-only). A cross-project relation only
        needs read on the target, so this succeeds and populates the D5 card.
        """
        proj_a = Project.objects.create(
            name="Security", start_date=START, calendar=calendar, program=program
        )
        proj_b = Project.objects.create(
            name="Marketing", start_date=START, calendar=calendar, program=program
        )
        ProjectMembership.objects.create(project=proj_a, user=pm_user, role=Role.ADMIN)
        ProjectMembership.objects.create(project=proj_b, user=pm_user, role=Role.VIEWER)
        src = Task.objects.create(project=proj_a, name="Sign-off", duration=2)
        tgt = Task.objects.create(project=proj_b, name="Go-live", duration=1)

        with _no_broadcast():
            r = _client(pm_user).post(
                LIST_URL,
                {"source": str(src.pk), "target": str(tgt.pk), "relation_type": "blocks"},
                format="json",
            )
        assert r.status_code == 201, r.data
        # Cross-project → both endpoints carry the minimal visibility card.
        assert r.data["source_card"] is not None
        assert r.data["target_card"] is not None
        assert r.data["target_card"]["project_id"] == str(proj_b.pk)


# ---------------------------------------------------------------------------
# 4. Self-link — serializer 400 AND DB CheckConstraint
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestSelfLink:
    def test_serializer_rejects_self_link(
        self,
        member_client: APIClient,
        member_task: Task,
        memberships: None,
    ) -> None:
        r = member_client.post(
            LIST_URL,
            {"source": str(member_task.pk), "target": str(member_task.pk)},
            format="json",
        )
        assert r.status_code == 400, r.data

    def test_db_check_constraint_rejects_self_link(self, member_task: Task) -> None:
        # Belt-and-braces: the DB CheckConstraint task_relation_no_self must reject a
        # raw create that bypasses the serializer.
        with pytest.raises(IntegrityError), transaction.atomic():
            TaskRelation.objects.create(
                source=member_task, target=member_task, relation_type="relates_to"
            )


# ---------------------------------------------------------------------------
# 5. Cross-program rejected; same-program card behaviour
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestCrossProgram:
    def test_cross_program_rejected(
        self,
        calendar: Calendar,
        pm_user: Any,
    ) -> None:
        prog1 = Program.objects.create(name="Prog One")
        prog2 = Program.objects.create(name="Prog Two")
        proj1 = Project.objects.create(
            name="P1", start_date=START, calendar=calendar, program=prog1
        )
        proj2 = Project.objects.create(
            name="P2", start_date=START, calendar=calendar, program=prog2
        )
        # Caller can read BOTH (so the reject is the cross-program check, not a 403).
        ProjectMembership.objects.create(project=proj1, user=pm_user, role=Role.ADMIN)
        ProjectMembership.objects.create(project=proj2, user=pm_user, role=Role.MEMBER)
        src = Task.objects.create(project=proj1, name="A", duration=1)
        tgt = Task.objects.create(project=proj2, name="B", duration=1)

        r = _client(pm_user).post(
            LIST_URL,
            {"source": str(src.pk), "target": str(tgt.pk)},
            format="json",
        )
        assert r.status_code == 400, r.data
        assert "cross_program" in str(r.data).lower()

    def test_same_program_cross_project_populates_target_card(
        self,
        calendar: Calendar,
        program: Program,
        pm_user: Any,
    ) -> None:
        proj_a = Project.objects.create(
            name="A", start_date=START, calendar=calendar, program=program
        )
        proj_b = Project.objects.create(
            name="B", start_date=START, calendar=calendar, program=program
        )
        ProjectMembership.objects.create(project=proj_a, user=pm_user, role=Role.ADMIN)
        ProjectMembership.objects.create(project=proj_b, user=pm_user, role=Role.MEMBER)
        src = Task.objects.create(project=proj_a, name="A1", duration=1)
        tgt = Task.objects.create(project=proj_b, name="B1", duration=1)

        with _no_broadcast():
            r = _client(pm_user).post(
                LIST_URL,
                {"source": str(src.pk), "target": str(tgt.pk)},
                format="json",
            )
        assert r.status_code == 201, r.data
        assert r.data["target_card"] is not None
        assert r.data["source_card"] is not None

    def test_same_project_link_has_null_cards(
        self,
        pm_client: APIClient,
        member_task: Task,
        other_task: Task,
        memberships: None,
    ) -> None:
        with _no_broadcast():
            r = pm_client.post(
                LIST_URL,
                {"source": str(member_task.pk), "target": str(other_task.pk)},
                format="json",
            )
        assert r.status_code == 201, r.data
        assert r.data["source_card"] is None
        assert r.data["target_card"] is None


# ---------------------------------------------------------------------------
# 6. Dedupe — repeat and (symmetric) reverse are clean 400s, not 500s
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestDedupe:
    def test_duplicate_same_direction_rejected(
        self,
        pm_client: APIClient,
        member_task: Task,
        other_task: Task,
        memberships: None,
    ) -> None:
        payload = {
            "source": str(member_task.pk),
            "target": str(other_task.pk),
            "relation_type": "relates_to",
        }
        with _no_broadcast():
            first = pm_client.post(LIST_URL, payload, format="json")
            assert first.status_code == 201, first.data
            second = pm_client.post(LIST_URL, payload, format="json")
        assert second.status_code == 400, second.data
        assert "duplicate" in str(second.data).lower()

    def test_reverse_relates_to_is_duplicate(
        self,
        pm_client: APIClient,
        member_task: Task,
        other_task: Task,
        memberships: None,
    ) -> None:
        # relates_to is symmetric: B→A duplicates a live A→B.
        with _no_broadcast():
            first = pm_client.post(
                LIST_URL,
                {
                    "source": str(member_task.pk),
                    "target": str(other_task.pk),
                    "relation_type": "relates_to",
                },
                format="json",
            )
            assert first.status_code == 201, first.data
            reverse = pm_client.post(
                LIST_URL,
                {
                    "source": str(other_task.pk),
                    "target": str(member_task.pk),
                    "relation_type": "relates_to",
                },
                format="json",
            )
        assert reverse.status_code == 400, reverse.data
        assert "duplicate" in str(reverse.data).lower()


# ---------------------------------------------------------------------------
# 7. Soft-delete — tombstone + version bump; re-create allowed
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestSoftDelete:
    def test_delete_soft_deletes_and_bumps_version(
        self,
        pm_client: APIClient,
        member_task: Task,
        other_task: Task,
        memberships: None,
    ) -> None:
        rel = TaskRelation.objects.create(
            source=member_task, target=other_task, relation_type="relates_to"
        )
        version_before = rel.server_version
        with _no_broadcast():
            r = pm_client.delete(_detail_url(rel.pk))
        assert r.status_code == 204, getattr(r, "data", None)
        rel.refresh_from_db()
        assert rel.is_deleted is True
        assert rel.deleted_at is not None
        assert rel.server_version > version_before

    def test_recreate_after_delete_allowed(
        self,
        pm_client: APIClient,
        member_task: Task,
        other_task: Task,
        memberships: None,
    ) -> None:
        # Soft-delete a relation, then re-create the same triple — the partial-unique
        # (is_deleted=False) constraint must allow it.
        rel = TaskRelation.objects.create(
            source=member_task, target=other_task, relation_type="relates_to"
        )
        rel.soft_delete()
        with _no_broadcast():
            r = pm_client.post(
                LIST_URL,
                {
                    "source": str(member_task.pk),
                    "target": str(other_task.pk),
                    "relation_type": "relates_to",
                },
                format="json",
            )
        assert r.status_code == 201, r.data


# ---------------------------------------------------------------------------
# 8. Broadcast + inertness — events fire on commit; NO schedule recompute
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
class TestBroadcastAndInertness:
    def test_create_broadcasts_and_never_recomputes(
        self,
        pm_client: APIClient,
        member_task: Task,
        other_task: Task,
        memberships: None,
        project: Project,
    ) -> None:
        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as bcast,
            patch("trueppm_api.apps.projects.views._enqueue_recalculate") as recalc,
        ):
            r = pm_client.post(
                LIST_URL,
                {"source": str(member_task.pk), "target": str(other_task.pk)},
                format="json",
            )
            assert r.status_code == 201, r.data
        events = [call.args[1] for call in bcast.call_args_list]
        assert "task_relation_created" in events
        # A same-project relation broadcasts to its one project.
        project_ids = {call.args[0] for call in bcast.call_args_list}
        assert str(project.pk) in project_ids
        # The key inert-relation guarantee: never a CPM recompute.
        recalc.assert_not_called()

    def test_cross_project_create_broadcasts_both_projects(
        self,
        calendar: Calendar,
        program: Program,
        pm_user: Any,
    ) -> None:
        proj_a = Project.objects.create(
            name="A", start_date=START, calendar=calendar, program=program
        )
        proj_b = Project.objects.create(
            name="B", start_date=START, calendar=calendar, program=program
        )
        ProjectMembership.objects.create(project=proj_a, user=pm_user, role=Role.ADMIN)
        ProjectMembership.objects.create(project=proj_b, user=pm_user, role=Role.MEMBER)
        src = Task.objects.create(project=proj_a, name="A1", duration=1)
        tgt = Task.objects.create(project=proj_b, name="B1", duration=1)

        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as bcast,
            patch("trueppm_api.apps.projects.views._enqueue_recalculate") as recalc,
        ):
            r = _client(pm_user).post(
                LIST_URL,
                {"source": str(src.pk), "target": str(tgt.pk), "relation_type": "blocks"},
                format="json",
            )
            assert r.status_code == 201, r.data
        project_ids = {call.args[0] for call in bcast.call_args_list}
        assert str(proj_a.pk) in project_ids
        assert str(proj_b.pk) in project_ids
        recalc.assert_not_called()

    def test_delete_broadcasts_and_never_recomputes(
        self,
        pm_client: APIClient,
        member_task: Task,
        other_task: Task,
        memberships: None,
    ) -> None:
        rel = TaskRelation.objects.create(
            source=member_task, target=other_task, relation_type="relates_to"
        )
        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as bcast,
            patch("trueppm_api.apps.projects.views._enqueue_recalculate") as recalc,
        ):
            r = pm_client.delete(_detail_url(rel.pk))
            assert r.status_code == 204
        events = [call.args[1] for call in bcast.call_args_list]
        assert "task_relation_deleted" in events
        recalc.assert_not_called()


# ---------------------------------------------------------------------------
# 9. PATCH — note-only; repoint rejected
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestPatch:
    def test_patch_edits_note(
        self,
        pm_client: APIClient,
        member_task: Task,
        other_task: Task,
        memberships: None,
    ) -> None:
        rel = TaskRelation.objects.create(
            source=member_task, target=other_task, relation_type="relates_to", note="old"
        )
        with _no_broadcast():
            r = pm_client.patch(_detail_url(rel.pk), {"note": "new note"}, format="json")
        assert r.status_code == 200, r.data
        assert r.data["note"] == "new note"
        rel.refresh_from_db()
        assert rel.note == "new note"

    def test_patch_cannot_change_relation_type(
        self,
        pm_client: APIClient,
        member_task: Task,
        other_task: Task,
        memberships: None,
    ) -> None:
        rel = TaskRelation.objects.create(
            source=member_task, target=other_task, relation_type="relates_to"
        )
        with _no_broadcast():
            r = pm_client.patch(_detail_url(rel.pk), {"relation_type": "blocks"}, format="json")
        assert r.status_code == 400, r.data
        rel.refresh_from_db()
        assert rel.relation_type == "relates_to"

    def test_patch_cannot_repoint_target(
        self,
        pm_client: APIClient,
        member_task: Task,
        other_task: Task,
        project: Project,
        memberships: None,
    ) -> None:
        third = Task.objects.create(project=project, name="Third", duration=1)
        rel = TaskRelation.objects.create(
            source=member_task, target=other_task, relation_type="relates_to"
        )
        with _no_broadcast():
            r = pm_client.patch(_detail_url(rel.pk), {"target": str(third.pk)}, format="json")
        assert r.status_code == 400, r.data
        rel.refresh_from_db()
        assert rel.target_id == other_task.pk
