"""#2510 keyset index shape and #4948 task-child tombstones on the delta pull."""

from __future__ import annotations

import base64
import json
from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.db.models import F
from django.db.models.fields.tuple_lookups import TupleGreaterThan
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.integrations.models import TaskLink
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    SuggestionState,
    Task,
    TaskRecurrenceRule,
    TaskRelation,
    TaskSuggestedAssignee,
    bulk_soft_delete_tasks,
    cascade_task_children_restore,
)

User = get_user_model()


@pytest.fixture
def world(db: object):
    user = User.objects.create_user(username="kuser", password="pw")
    project = Project.objects.create(
        name="K", start_date=date(2026, 1, 1), calendar=Calendar.objects.create(name="Std")
    )
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    client = APIClient()
    client.force_authenticate(user=user)
    return user, project, client


def _pull(client: APIClient, project: Project, since: int) -> dict:
    resp = client.get(f"/api/v1/projects/{project.pk}/sync/", {"since": str(since)})
    assert resp.status_code == 200, resp.content
    return resp.data


# --- #2510 -----------------------------------------------------------------


@pytest.mark.django_db
def test_keyset_resume_is_a_single_index_range_scan_with_no_sort(world) -> None:
    """The resume predicate is a row comparison the planner seeks on, and the
    ``(project, sync_seq, id)`` index delivers rows already in ORDER BY order."""
    _user, project, _client = world
    qs = Task.objects.filter(project=project, sync_seq__gt=0).filter(
        TupleGreaterThan((F("sync_seq"), F("pk")), (5, "00000000-0000-0000-0000-000000000001"))
    )
    with connection.cursor() as cur:
        cur.execute("SET LOCAL enable_seqscan = off")
        cur.execute("SET LOCAL enable_bitmapscan = off")
        plan = qs.order_by("sync_seq", "id")[:11].explain()
    assert "task_proj_syncseq_idx" in plan, plan
    assert "Sort" not in plan, plan
    # The tuple comparison is pushed into the index condition, not left as a filter.
    assert "(sync_seq, id) >" in plan.replace('"', ""), plan


@pytest.mark.django_db
def test_dead_sync_seq_indexes_are_gone_and_synced_ones_carry_id(world) -> None:
    with connection.cursor() as cur:
        cur.execute(
            "SELECT indexname, indexdef FROM pg_indexes WHERE indexdef LIKE %s"
            " AND indexdef LIKE %s AND indexname NOT LIKE %s",
            ["%sync_seq%", "%btree (%", "%pkey"],
        )
        defs = dict(cur.fetchall())
    for dead in (
        "udmg_proj_syncseq_idx",
        "pudmg_prog_syncseq_idx",
        "rbi_retro_syncseq_idx",
        "pulse_retro_syncseq_idx",
    ):
        assert dead not in defs
    assert "progm_syncseq_idx" in defs
    assert len(defs) == 14, sorted(defs)
    for name, definition in defs.items():
        assert definition.rstrip(")").endswith("sync_seq, id"), (name, definition)


@pytest.mark.django_db
def test_cursor_with_non_uuid_row_id_is_a_400_not_a_500(world) -> None:
    _user, project, client = world
    token = base64.urlsafe_b64encode(
        json.dumps({"i": 1, "v": 1, "id": "not-a-uuid", "w": 1}).encode()
    ).decode()
    resp = client.get(f"/api/v1/projects/{project.pk}/sync/", {"since": "0", "cursor": token})
    assert resp.status_code == 400


# --- #4948 -----------------------------------------------------------------


def _children(user, project):
    t1 = Task.objects.create(project=project, name="Parent", duration=1)
    t2 = Task.objects.create(project=project, name="Other", duration=1)
    made = {
        "task_links": TaskLink.objects.create(task=t1, url="https://x.test/a", provider="gitlab"),
        "task_suggested_assignees": TaskSuggestedAssignee.objects.create(
            task=t1, suggested_user=user, suggested_by=user, state=SuggestionState.PENDING
        ),
        "task_recurrence_rules": TaskRecurrenceRule.objects.create(task=t1),
    }
    relation = TaskRelation.objects.create(source=t2, target=t1)
    return t1, t2, made, relation


def _watermark(client, project) -> int:
    return int(_pull(client, project, 0)["timestamp"])


@pytest.mark.django_db
def test_soft_delete_tombstones_every_synced_child_for_a_synced_client(world) -> None:
    user, project, client = world
    t1, _t2, made, relation = _children(user, project)
    cursor = _watermark(client, project)

    t1.refresh_from_db()
    t1.soft_delete()

    changes = _pull(client, project, cursor)["changes"]
    for name, row in made.items():
        assert str(row.pk) in changes[name]["deleted"], name
    assert str(relation.pk) in changes["task_relations"]["deleted"]
    assert str(t1.pk) in changes["tasks"]["deleted"]


@pytest.mark.django_db
def test_bulk_soft_delete_tombstones_every_synced_child(world) -> None:
    user, project, client = world
    t1, _t2, made, relation = _children(user, project)
    cursor = _watermark(client, project)

    bulk_soft_delete_tasks([t1])

    changes = _pull(client, project, cursor)["changes"]
    for name, row in made.items():
        assert str(row.pk) in changes[name]["deleted"], name
    assert str(relation.pk) in changes["task_relations"]["deleted"]


@pytest.mark.django_db
def test_restoring_the_task_returns_its_children_as_live_rows(world) -> None:
    user, project, client = world
    t1, _t2, made, relation = _children(user, project)
    t1.refresh_from_db()
    t1.soft_delete()
    cursor = _watermark(client, project)

    t1.refresh_from_db()
    t1.restore()
    cascade_task_children_restore(t1)

    changes = _pull(client, project, cursor)["changes"]
    for name, row in made.items():
        assert str(row.pk) in [r["id"] for r in changes[name]["updated"]], name
        row.refresh_from_db()
        assert row.is_deleted is False
    relation.refresh_from_db()
    assert relation.is_deleted is False and relation.deleted_at is None


@pytest.mark.django_db
def test_children_already_tombstoned_are_not_bumped_twice(world) -> None:
    user, project, _client = world
    t1, _t2, made, _relation = _children(user, project)
    link = made["task_links"]
    link.soft_delete()
    link.refresh_from_db()
    version = link.server_version
    t1.refresh_from_db()
    t1.soft_delete()
    link.refresh_from_db()
    assert link.server_version == version
