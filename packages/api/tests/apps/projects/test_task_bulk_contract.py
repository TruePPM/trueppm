"""The 207 batch contract for POST /projects/{pk}/tasks/bulk/ (#2723, ADR-0772/0773).

Covers the four things the endpoint did not do before: apply rows independently,
accept a client-minted primary key under its four guards, run the ADR-0259 graph
guard over the edges it now writes, and recalculate + broadcast for whatever
actually committed.
"""

from __future__ import annotations

import uuid
from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.db import DatabaseError
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.permissions import role_can_author_plan
from trueppm_api.apps.projects.models import (
    Calendar,
    DeliveryMode,
    Dependency,
    Program,
    Project,
    Task,
)
from trueppm_api.apps.projects.task_bulk import TASK_BULK_MAX_OPERATIONS

URL = "/api/v1/projects/{pk}/tasks/bulk/"


def url(project: Project) -> str:
    return URL.format(pk=project.pk)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Batch", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def other_project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Other", start_date=date(2026, 1, 1), calendar=calendar)


def _member(project: Project, username: str, role: int) -> APIClient:
    User = get_user_model()
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def owner_client(project: Project) -> APIClient:
    return _member(project, "owner_b", Role.OWNER)


def _no_side_effects() -> object:
    """Silence the CPM enqueue and the board broadcast unless a test asserts on them."""
    return patch("trueppm_api.apps.projects.views._enqueue_recalculate")


# ---------------------------------------------------------------------------
# Per-row application
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_38_row_batch_with_3_bad_rows_applies_35(owner_client: APIClient, project: Project) -> None:
    """One unparseable row out of 38 must not discard the other 37 (#2723 §1).

    The bad rows are spread through the batch rather than bunched at the end, because
    the failure this replaces was order-dependent: the old loop stopped at the first
    rejection, so where a bad row sat decided how many good rows survived.
    """
    operations = []
    bad_indices = {7, 19, 30}
    for i in range(38):
        if i in bad_indices:
            # Invalid: a create with no name.
            operations.append({"op": "create", "data": {"duration": 2}})
        else:
            operations.append({"op": "create", "data": {"name": f"Row {i}", "duration": 2}})

    with _no_side_effects():
        r = owner_client.post(url(project), {"operations": operations}, format="json")

    assert r.status_code == 207, r.data
    assert len(r.data["applied"]) == 35
    assert len(r.data["rejected"]) == 3
    assert {e["index"] for e in r.data["rejected"]} == bad_indices
    assert all(e["code"] == "invalid" for e in r.data["rejected"])
    assert all(e["message"] for e in r.data["rejected"])
    assert Task.objects.filter(project=project, is_deleted=False).count() == 35


@pytest.mark.django_db
def test_recalculation_and_broadcast_fire_for_a_partial_batch(
    owner_client: APIClient,
    project: Project,
    django_capture_on_commit_callbacks: object,
) -> None:
    """35 applied rows out of 38 still mutated 35 rows (#2746).

    The old control flow returned from inside the atomic block, which skipped both
    ``transaction.on_commit`` registrations — so a partially-rejected batch committed
    its writes and left every collaborator on a stale schedule with no notification.
    """
    operations = [
        {"op": "create", "data": {"name": "Good", "duration": 1}},
        {"op": "create", "data": {"duration": 1}},  # invalid: no name
    ]
    with (
        patch("trueppm_api.apps.projects.views._enqueue_recalculate") as mock_recalc,
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_bcast,
        # Both are deferred with transaction.on_commit, so the callbacks have to be
        # captured and executed to observe them at all.
        django_capture_on_commit_callbacks(execute=True),  # type: ignore[operator]
    ):
        r = owner_client.post(url(project), {"operations": operations}, format="json")

    assert r.status_code == 207, r.data
    assert len(r.data["applied"]) == 1
    assert len(r.data["rejected"]) == 1
    assert mock_recalc.called
    events = [c.args[1] for c in mock_bcast.call_args_list]
    assert "tasks_bulk_mutated" in events
    payload = next(
        c.args[2] for c in mock_bcast.call_args_list if c.args[1] == "tasks_bulk_mutated"
    )
    # Only the row that actually committed is broadcast — never a rejected id.
    assert payload["task_ids"] == [r.data["applied"][0]["id"]]


# ---------------------------------------------------------------------------
# Client-minted ids and the four guards
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_client_minted_id_becomes_the_primary_key(
    owner_client: APIClient, project: Project
) -> None:
    minted = str(uuid.uuid4())
    with _no_side_effects():
        r = owner_client.post(
            url(project),
            {
                "operations": [
                    {"op": "create", "id": minted, "data": {"name": "Survey", "duration": 3}}
                ]
            },
            format="json",
        )
    assert r.status_code == 207, r.data
    assert r.data["applied"][0]["id"] == minted
    assert Task.objects.filter(pk=minted, project=project).exists()


@pytest.mark.django_db
def test_repeat_create_with_the_same_id_is_an_edit_not_a_second_row(
    owner_client: APIClient, project: Project
) -> None:
    """Layer 2 of the replay contract: a create whose id exists is an in-place edit."""
    minted = str(uuid.uuid4())
    body = {
        "operations": [{"op": "create", "id": minted, "data": {"name": "Survey", "duration": 3}}]
    }
    with _no_side_effects():
        first = owner_client.post(url(project), body, format="json")
        second = owner_client.post(url(project), body, format="json")

    assert first.data["applied"][0]["outcome"] == "created"
    assert second.data["applied"][0]["outcome"] == "updated"
    assert Task.objects.filter(project=project, is_deleted=False).count() == 1


@pytest.mark.django_db
def test_identical_batch_replayed_under_one_idempotency_key_writes_nothing_twice(
    owner_client: APIClient, project: Project
) -> None:
    """Layer 1 — the replay guarantee the contract actually makes (ADR-0772 §5).

    Unlike layer 2 this performs zero writes on replay, so it holds for every role
    including the Member-on-an-unassigned-row case layer 2 cannot cover.
    """
    key = "batch-key-1"
    body = {"operations": [{"op": "create", "data": {"name": "Survey", "duration": 3}}]}
    with _no_side_effects():
        first = owner_client.post(url(project), body, format="json", HTTP_IDEMPOTENCY_KEY=key)
        second = owner_client.post(url(project), body, format="json", HTTP_IDEMPOTENCY_KEY=key)

    assert first.status_code == 207
    assert second.status_code == 207
    assert second["Idempotent-Replay"] == "true"
    # The stored response is replayed verbatim, so the same row comes back — but the
    # body has round-tripped through JSON, so compare the identity that matters
    # rather than the rendered payload.
    assert second.data["applied"][0]["id"] == first.data["applied"][0]["id"]
    assert second.data["rejected"] == []
    assert Task.objects.filter(project=project, is_deleted=False).count() == 1


@pytest.mark.django_db
def test_malformed_id_rejects_only_its_own_row(owner_client: APIClient, project: Project) -> None:
    """Guard 1. Before #2723 an unparseable id reaching the ORM was a 500 (#1730)."""
    with _no_side_effects():
        r = owner_client.post(
            url(project),
            {
                "operations": [
                    {"op": "create", "id": "not-a-uuid", "data": {"name": "Bad", "duration": 1}},
                    {"op": "create", "data": {"name": "Good", "duration": 1}},
                ]
            },
            format="json",
        )
    assert r.status_code == 207, r.data
    assert r.data["rejected"] == [
        {"index": 0, "id": None, "code": "malformed_id", "message": "'id' is not a valid UUID."}
    ]
    assert [e["index"] for e in r.data["applied"]] == [1]


@pytest.mark.django_db
def test_foreign_id_is_rejected_without_asserting_that_it_exists(
    owner_client: APIClient, project: Project, other_project: Project
) -> None:
    """Guard 2 — the #887 IDOR, reported through the #359 non-asserting code.

    The caller must not be able to tell "this id lives in a project you cannot see"
    from "you may not use this id": per-row rejection would otherwise leak N bits of
    membership information per request, where the sync path's whole-request abort
    leaks one.
    """
    foreign = Task.objects.create(project=other_project, name="Theirs", duration=1, wbs_path="1")
    with _no_side_effects():
        r = owner_client.post(
            url(project),
            {"operations": [{"op": "create", "id": str(foreign.pk), "data": {"name": "Hijack"}}]},
            format="json",
        )
    assert r.status_code == 207, r.data
    assert r.data["rejected"][0]["code"] == "id_unavailable"
    assert "not available" in r.data["rejected"][0]["message"]
    foreign.refresh_from_db()
    assert foreign.name == "Theirs"


@pytest.mark.django_db
def test_create_against_a_tombstone_is_skipped_not_applied(
    owner_client: APIClient, project: Project
) -> None:
    """Guard 3. A documented no-op: no write, no server_version bump, no broadcast."""
    dead = Task.objects.create(project=project, name="Dead", duration=1, wbs_path="1")
    dead.soft_delete()
    before = Task.objects.get(pk=dead.pk).server_version

    with _no_side_effects():
        r = owner_client.post(
            url(project),
            {"operations": [{"op": "create", "id": str(dead.pk), "data": {"name": "Zombie"}}]},
            format="json",
        )
    assert r.status_code == 207, r.data
    assert r.data["applied"] == []
    assert r.data["skipped"][0]["code"] == "tombstoned"
    assert r.data["skipped"][0]["id"] == str(dead.pk)
    dead.refresh_from_db()
    assert dead.is_deleted is True
    assert dead.name == "Dead"
    assert dead.server_version == before


@pytest.mark.django_db
def test_create_into_an_existing_id_is_checked_against_the_edit_bar(project: Project) -> None:
    """Guard 4 — the privilege-escalation trap.

    A create-with-an-existing-id is an *edit*, so it must clear ``can_user_edit_task``
    rather than the looser create bar. Getting this backwards would let a Member mint
    the id of somebody else's task and rewrite it as a "create".
    """
    member_client = _member(project, "member_guard4", Role.MEMBER)
    theirs = Task.objects.create(project=project, name="Theirs", duration=1, wbs_path="1")

    with _no_side_effects():
        r = member_client.post(
            url(project),
            {"operations": [{"op": "create", "id": str(theirs.pk), "data": {"name": "Mine now"}}]},
            format="json",
        )
    assert r.status_code == 207, r.data
    assert r.data["rejected"][0]["code"] == "forbidden"
    theirs.refresh_from_db()
    assert theirs.name == "Theirs"


@pytest.mark.django_db
def test_batch_size_cap_is_enforced(owner_client: APIClient, project: Project) -> None:
    """ADR-0772 requires a cap; the endpoint previously had none at all."""
    operations = [
        {"op": "create", "data": {"name": f"R{i}", "duration": 1}}
        for i in range(TASK_BULK_MAX_OPERATIONS + 1)
    ]
    r = owner_client.post(url(project), {"operations": operations}, format="json")
    assert r.status_code == 400
    assert Task.objects.filter(project=project).count() == 0


# ---------------------------------------------------------------------------
# Dependencies and the ADR-0259 graph guard
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_edges_may_forward_reference_a_task_created_later_in_the_batch(
    owner_client: APIClient, project: Project
) -> None:
    """The property client-minted ids buy: no reference syntax at all (ADR-0772 §3)."""
    a, b = str(uuid.uuid4()), str(uuid.uuid4())
    with _no_side_effects():
        r = owner_client.post(
            url(project),
            {
                "operations": [
                    {"op": "create", "id": a, "data": {"name": "Survey", "duration": 3}},
                    {"op": "create", "id": b, "data": {"name": "Design", "duration": 5}},
                ],
                "dependencies": {
                    "created": [{"predecessor": a, "successor": b, "dep_type": "FS", "lag": 0}]
                },
            },
            format="json",
        )
    assert r.status_code == 207, r.data
    assert r.data["dependencies"]["rejected"] == []
    assert len(r.data["dependencies"]["applied"]) == 1
    assert Dependency.objects.filter(predecessor_id=a, successor_id=b).exists()


@pytest.mark.django_db
def test_a_batch_that_would_close_a_cycle_is_rejected_by_the_graph_guard(
    owner_client: APIClient, project: Project
) -> None:
    """#2723 §3 — the guard the endpoint never called.

    Only the edges on the reported cycle path are refused. The task rows applied in
    phase 1 are not rolled back, which is what keeps "one bad row out of 38 must not
    discard the other 37" true without weakening the guard.
    """
    a, b = str(uuid.uuid4()), str(uuid.uuid4())
    with _no_side_effects():
        r = owner_client.post(
            url(project),
            {
                "operations": [
                    {"op": "create", "id": a, "data": {"name": "A", "duration": 1}},
                    {"op": "create", "id": b, "data": {"name": "B", "duration": 1}},
                ],
                "dependencies": {
                    "created": [
                        {"predecessor": a, "successor": b},
                        {"predecessor": b, "successor": a},
                    ]
                },
            },
            format="json",
        )
    assert r.status_code == 207, r.data
    # Both task rows still applied.
    assert len(r.data["applied"]) == 2
    assert Task.objects.filter(project=project, is_deleted=False).count() == 2
    rejected = r.data["dependencies"]["rejected"]
    assert rejected, r.data["dependencies"]
    assert any(e["code"] == "cyclic_dependency" for e in rejected)
    # Nothing that closes the cycle was written.
    assert not (
        Dependency.objects.filter(predecessor_id=a, successor_id=b).exists()
        and Dependency.objects.filter(predecessor_id=b, successor_id=a).exists()
    )


@pytest.mark.django_db
def test_a_self_referential_edge_is_rejected(owner_client: APIClient, project: Project) -> None:
    a = str(uuid.uuid4())
    with _no_side_effects():
        r = owner_client.post(
            url(project),
            {
                "operations": [{"op": "create", "id": a, "data": {"name": "A", "duration": 1}}],
                "dependencies": {"created": [{"predecessor": a, "successor": a}]},
            },
            format="json",
        )
    assert r.status_code == 207, r.data
    assert [e["code"] for e in r.data["dependencies"]["rejected"]] == ["self_reference"]
    # Dependency ids are server-assigned, so a rejection never has one to echo back —
    # but the key itself is required by TaskBulkProblemEntry (#2757).
    assert r.data["dependencies"]["rejected"][0]["id"] is None
    assert not Dependency.objects.filter(predecessor_id=a).exists()


@pytest.mark.django_db
def test_a_member_may_paste_rows_but_not_author_edges(project: Project) -> None:
    """Dependency ops sit one role above this view's own floor (ADR-0772 §3).

    Checked per-op rather than per-request, so the Member's task rows still apply and
    only their edge rows reject.
    """
    member_client = _member(project, "member_edges", Role.MEMBER)
    a, b = str(uuid.uuid4()), str(uuid.uuid4())
    with _no_side_effects():
        r = member_client.post(
            url(project),
            {
                "operations": [
                    {"op": "create", "id": a, "data": {"name": "A", "duration": 1}},
                    {"op": "create", "id": b, "data": {"name": "B", "duration": 1}},
                ],
                "dependencies": {"created": [{"predecessor": a, "successor": b}]},
            },
            format="json",
        )
    assert r.status_code == 207, r.data
    assert len(r.data["applied"]) == 2
    assert [e["code"] for e in r.data["dependencies"]["rejected"]] == ["forbidden"]
    assert r.data["dependencies"]["rejected"][0]["id"] is None
    assert not Dependency.objects.filter(predecessor_id=a).exists()


@pytest.mark.django_db
def test_a_caller_supplied_dependency_id_is_rejected(
    owner_client: APIClient, project: Project
) -> None:
    """Client-minted ids are scoped to Task only — all four guards are about tasks."""
    a, b = str(uuid.uuid4()), str(uuid.uuid4())
    with _no_side_effects():
        r = owner_client.post(
            url(project),
            {
                "operations": [
                    {"op": "create", "id": a, "data": {"name": "A", "duration": 1}},
                    {"op": "create", "id": b, "data": {"name": "B", "duration": 1}},
                ],
                "dependencies": {
                    "created": [{"predecessor": a, "successor": b, "id": str(uuid.uuid4())}]
                },
            },
            format="json",
        )
    assert r.status_code == 207, r.data
    assert [e["code"] for e in r.data["dependencies"]["rejected"]] == ["invalid"]
    assert r.data["dependencies"]["rejected"][0]["id"] is None


@pytest.mark.django_db
def test_a_malformed_edge_endpoint_is_rejected(owner_client: APIClient, project: Project) -> None:
    """A non-UUID endpoint fails before any DB lookup runs."""
    a = str(uuid.uuid4())
    with _no_side_effects():
        r = owner_client.post(
            url(project),
            {
                "operations": [{"op": "create", "id": a, "data": {"name": "A", "duration": 1}}],
                "dependencies": {"created": [{"predecessor": a, "successor": "not-a-uuid"}]},
            },
            format="json",
        )
    assert r.status_code == 207, r.data
    assert [e["code"] for e in r.data["dependencies"]["rejected"]] == ["malformed_id"]
    assert r.data["dependencies"]["rejected"][0]["id"] is None


@pytest.mark.django_db
def test_an_edge_referencing_a_task_that_does_not_exist_is_rejected(
    owner_client: APIClient, project: Project
) -> None:
    """A well-formed UUID that resolves to no live task is a distinct rejection
    from a malformed one — the batch's own create ops are visible (forward
    references), so this can only be a genuinely absent or tombstoned task."""
    a = str(uuid.uuid4())
    missing = str(uuid.uuid4())
    with _no_side_effects():
        r = owner_client.post(
            url(project),
            {
                "operations": [{"op": "create", "id": a, "data": {"name": "A", "duration": 1}}],
                "dependencies": {"created": [{"predecessor": a, "successor": missing}]},
            },
            format="json",
        )
    assert r.status_code == 207, r.data
    assert [e["code"] for e in r.data["dependencies"]["rejected"]] == ["unresolved_endpoint"]
    assert r.data["dependencies"]["rejected"][0]["id"] is None


@pytest.mark.django_db
def test_a_cross_project_edge_without_successor_access_is_forbidden(
    owner_client: APIClient, project: Project, other_project: Project
) -> None:
    """The role gate in `_resolve_edges` only checks the caller's role on
    `ctx.project` — a cross-project edge still owes the ADR-0120 D2 consent
    check on the successor's own project, which this caller has no access to."""
    a = str(uuid.uuid4())
    foreign_task = Task.objects.create(project=other_project, name="Foreign", duration=1)
    with _no_side_effects():
        r = owner_client.post(
            url(project),
            {
                "operations": [{"op": "create", "id": a, "data": {"name": "A", "duration": 1}}],
                "dependencies": {
                    "created": [{"predecessor": a, "successor": str(foreign_task.pk)}]
                },
            },
            format="json",
        )
    assert r.status_code == 207, r.data
    assert [e["code"] for e in r.data["dependencies"]["rejected"]] == ["forbidden"]
    assert r.data["dependencies"]["rejected"][0]["id"] is None
    assert not Dependency.objects.filter(predecessor_id=a).exists()


@pytest.mark.django_db
def test_a_cross_program_edge_is_rejected_as_invalid(
    project: Project, other_project: Project, calendar: Calendar
) -> None:
    """A caller with Scheduler+ on both endpoints still hits the ADR-0070
    Enterprise boundary when the projects share no Program — a portfolio-level
    concern, not a permission one, so it surfaces as `invalid` rather than
    `forbidden`."""
    User = get_user_model()
    user = User.objects.create_user(username="cross_program_author", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)
    other_program = Program.objects.create(name="Other Program")
    other_project.program = other_program
    other_project.save(update_fields=["program"])
    ProjectMembership.objects.create(project=other_project, user=user, role=Role.SCHEDULER)
    client = APIClient()
    client.force_authenticate(user=user)

    a = str(uuid.uuid4())
    foreign_task = Task.objects.create(project=other_project, name="Foreign", duration=1)
    with _no_side_effects():
        r = client.post(
            url(project),
            {
                "operations": [{"op": "create", "id": a, "data": {"name": "A", "duration": 1}}],
                "dependencies": {
                    "created": [{"predecessor": a, "successor": str(foreign_task.pk)}]
                },
            },
            format="json",
        )
    assert r.status_code == 207, r.data
    assert [e["code"] for e in r.data["dependencies"]["rejected"]] == ["invalid"]
    assert r.data["dependencies"]["rejected"][0]["id"] is None


@pytest.mark.django_db
def test_a_database_error_during_dependency_write_is_rejected_not_500(
    owner_client: APIClient, project: Project, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A DB-level failure mid-write (e.g. a race lost to a concurrent writer)
    must surface as a structured rejection, not a 500 — and the entry still
    carries a null id per TaskBulkProblemEntry (#2757)."""
    from trueppm_api.apps.projects import serializers as project_serializers

    def _raise_database_error(self: object, **_kwargs: object) -> None:
        raise DatabaseError("could not serialize access due to concurrent update")

    monkeypatch.setattr(project_serializers.DependencySerializer, "save", _raise_database_error)

    a, b = str(uuid.uuid4()), str(uuid.uuid4())
    with _no_side_effects():
        r = owner_client.post(
            url(project),
            {
                "operations": [
                    {"op": "create", "id": a, "data": {"name": "A", "duration": 1}},
                    {"op": "create", "id": b, "data": {"name": "B", "duration": 1}},
                ],
                "dependencies": {"created": [{"predecessor": a, "successor": b}]},
            },
            format="json",
        )
    assert r.status_code == 207, r.data
    assert [e["code"] for e in r.data["dependencies"]["rejected"]] == ["conflict"]
    assert r.data["dependencies"]["rejected"][0]["id"] is None
    assert not Dependency.objects.filter(predecessor_id=a).exists()


@pytest.mark.django_db
def test_no_dependency_bucket_means_the_guard_does_not_run(
    owner_client: APIClient, project: Project
) -> None:
    """A paste-many that creates no edges must not pay for the union-graph build.

    The graph is built from every persisted edge in the project, so its cost scales
    with project size rather than batch size.
    """
    with (
        _no_side_effects(),
        patch("trueppm_api.apps.scheduling.graph_guard.validate_task_graph") as mock_guard,
    ):
        r = owner_client.post(
            url(project),
            {"operations": [{"op": "create", "data": {"name": "A", "duration": 1}}]},
            format="json",
        )
    assert r.status_code == 207, r.data
    assert not mock_guard.called


# ---------------------------------------------------------------------------
# Milestone gate — a classification crossing a gate is a no-op, never a failure
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_classification_across_a_milestone_is_skipped_with_the_invariant_intact(
    owner_client: APIClient, project: Project
) -> None:
    """#2723 §4.

    ``delivery_mode`` and ``is_milestone`` are two encodings of one fact, so
    re-classifying a milestone row would silently dissolve the gate. The row is
    skipped rather than rejected, so one milestone inside a classified range cannot
    fail the rows around it.
    """
    gate = Task.objects.create(
        project=project,
        name="Gate",
        duration=0,
        wbs_path="1",
        is_milestone=True,
        delivery_mode=DeliveryMode.MILESTONE,
    )
    normal = Task.objects.create(project=project, name="Work", duration=3, wbs_path="2")

    with _no_side_effects():
        r = owner_client.post(
            url(project),
            {
                "operations": [
                    {"op": "update", "id": str(gate.pk), "data": {"delivery_mode": "scrum"}},
                    {"op": "update", "id": str(normal.pk), "data": {"delivery_mode": "scrum"}},
                ]
            },
            format="json",
        )
    assert r.status_code == 207, r.data
    assert r.data["rejected"] == []
    assert [e["index"] for e in r.data["skipped"]] == [0]
    assert r.data["skipped"][0]["code"] == "milestone_gate"
    assert [e["index"] for e in r.data["applied"]] == [1]

    gate.refresh_from_db()
    normal.refresh_from_db()
    # The coupled invariant survives untouched.
    assert gate.is_milestone is True
    assert gate.delivery_mode == DeliveryMode.MILESTONE
    assert gate.duration == 0
    assert normal.delivery_mode == DeliveryMode.SCRUM


@pytest.mark.django_db
def test_an_explicit_is_milestone_false_still_un_milestones(
    owner_client: APIClient, project: Project
) -> None:
    """The gate catches classification, not a deliberate act by an author.

    Sending ``is_milestone`` explicitly is unambiguous, so it proceeds — otherwise
    the skip would make a milestone permanently un-editable through this endpoint.
    """
    gate = Task.objects.create(
        project=project,
        name="Gate",
        duration=0,
        wbs_path="1",
        is_milestone=True,
        delivery_mode=DeliveryMode.MILESTONE,
    )
    with _no_side_effects():
        r = owner_client.post(
            url(project),
            {
                "operations": [
                    {
                        "op": "update",
                        "id": str(gate.pk),
                        "data": {"delivery_mode": "scrum", "is_milestone": False},
                    }
                ]
            },
            format="json",
        )
    assert r.status_code == 207, r.data
    assert r.data["skipped"] == []
    assert len(r.data["applied"]) == 1
    gate.refresh_from_db()
    assert gate.is_milestone is False
    assert gate.delivery_mode == DeliveryMode.SCRUM


# ---------------------------------------------------------------------------
# ADR-0773 — who may author
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_a_viewer_is_denied(project: Project) -> None:
    """No test covered Viewer denial on any bulk or restructure endpoint (#2719 G2)."""
    viewer_client = _member(project, "viewer_b", Role.VIEWER)
    r = viewer_client.post(
        url(project),
        {"operations": [{"op": "create", "data": {"name": "X", "duration": 1}}]},
        format="json",
    )
    assert r.status_code == 403
    assert Task.objects.filter(project=project).count() == 0


@pytest.mark.django_db
def test_a_scheduler_cannot_enter_author_mode(project: Project) -> None:
    """ADR-0773 §2.

    Scheduler is ordinally above Member, but ``can_user_edit_task`` refuses it task
    content — so on main a Scheduler could create a task and then not edit or delete
    the task they had just created. In a keyboard-fast row grid that is a trap, not a
    one-off 403, so the whole mode is denied rather than each keystroke.
    """
    scheduler_client = _member(project, "sched_b", Role.SCHEDULER)
    r = scheduler_client.post(
        url(project),
        {"operations": [{"op": "create", "data": {"name": "X", "duration": 1}}]},
        format="json",
    )
    assert r.status_code == 403
    assert Task.objects.filter(project=project).count() == 0


def test_role_can_author_plan_excludes_the_whole_resource_management_band() -> None:
    """Band-range, not ``== Role.SCHEDULER`` (ADR-0072).

    An Enterprise custom role registered at 201-299 must inherit the exclusion rather
    than silently gain authoring rights the OSS tier beside it does not have.
    """
    assert role_can_author_plan(None) is False
    assert role_can_author_plan(Role.VIEWER) is False
    assert role_can_author_plan(Role.MEMBER) is True
    assert role_can_author_plan(Role.ADMIN) is True
    assert role_can_author_plan(Role.OWNER) is True
    for ordinal in range(Role.SCHEDULER, Role.ADMIN):
        assert role_can_author_plan(ordinal) is False, ordinal
    # Enterprise band just below Scheduler still authors.
    assert role_can_author_plan(Role.MEMBER + 50) is True


@pytest.mark.django_db
@pytest.mark.parametrize(
    "role",
    [Role.VIEWER, Role.MEMBER, Role.SCHEDULER, Role.ADMIN, Role.OWNER],
)
def test_project_serializer_can_author_agrees_with_the_predicate(
    project: Project, role: int
) -> None:
    """The Designer's toggle reads a server fact, so it cannot drift (ADR-0773 §(d))."""
    client = _member(project, f"role_{role}", role)
    r = client.get(f"/api/v1/projects/{project.pk}/")
    assert r.status_code == 200, r.data
    assert r.data["can_author"] is role_can_author_plan(role)


# ---------------------------------------------------------------------------
# The published contract matches what the endpoint actually returns
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_the_207_body_matches_the_schema_it_publishes(
    owner_client: APIClient, project: Project
) -> None:
    """`api:schema-drift` only checks the schema against itself (#2515/#2649).

    It proves the committed document matches the current code's *declarations*, not
    that a response body satisfies them — so a wrong `responses={...}` passes CI and
    breaks a generated SDK instead. This asserts the actual body, with all three
    buckets — and both `dependencies` buckets — non-trivially populated, against the
    committed schema.

    The pre-#2757 gap: this test populated `dependencies.applied` but never
    `dependencies.rejected`, so a dep-edge rejection missing the schema's required
    `id` key (#2757) passed this exact conformance check untouched.
    """
    from tests.test_openapi_response_conformance import (
        assert_response_matches_schema,
        load_committed_schema,
    )

    dead = Task.objects.create(project=project, name="Dead", duration=1, wbs_path="9")
    dead.soft_delete()
    a, b = str(uuid.uuid4()), str(uuid.uuid4())

    with _no_side_effects():
        r = owner_client.post(
            url(project),
            {
                "operations": [
                    {"op": "create", "id": a, "data": {"name": "A", "duration": 1}},
                    {"op": "create", "id": b, "data": {"name": "B", "duration": 1}},
                    {"op": "create", "data": {"duration": 1}},  # rejected: no name
                    {"op": "create", "id": str(dead.pk), "data": {"name": "Z"}},  # skipped
                ],
                "dependencies": {
                    "created": [
                        {"predecessor": a, "successor": b},
                        {"predecessor": a, "successor": a},  # rejected: self-reference
                    ]
                },
            },
            format="json",
        )

    assert r.data["applied"] and r.data["rejected"] and r.data["skipped"]
    assert r.data["dependencies"]["applied"]
    assert r.data["dependencies"]["rejected"]
    assert_response_matches_schema(
        load_committed_schema(),
        r,
        "/api/v1/projects/{id}/tasks/bulk/",
        method="post",
        status_code="207",
    )


# ---------------------------------------------------------------------------
# Hierarchy placement on create (#2724 — paste-many needs a real tree, not a
# batch of root-level rows). Mirrors TaskViewSet.perform_create's parent_id
# handling, which _apply_create did not call before this.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_under_an_existing_parent_gets_a_child_wbs_path(
    owner_client: APIClient, project: Project
) -> None:
    phase = Task.objects.create(project=project, name="Phase 1", duration=1, wbs_path="1")

    with _no_side_effects():
        r = owner_client.post(
            url(project),
            {
                "operations": [
                    {
                        "op": "create",
                        "data": {"name": "Child", "duration": 2, "parent_id": str(phase.pk)},
                    }
                ]
            },
            format="json",
        )

    assert r.status_code == 207, r.data
    assert len(r.data["applied"]) == 1
    child = Task.objects.get(pk=r.data["applied"][0]["id"])
    assert child.wbs_path == "1.1"


@pytest.mark.django_db
def test_batch_creates_a_whole_subtree_via_intra_batch_parent_references(
    owner_client: APIClient, project: Project
) -> None:
    """The paste-many case: a fresh phase and its children in one request.

    The children name the phase's CLIENT-MINTED id (ADR-0772) — a forward reference
    that only resolves because phase 1 (apply_task_operations) materializes rows in
    ``operations`` order, so a later row's parent already exists in this same
    transaction by the time it is processed.
    """
    phase_id = str(uuid.uuid4())
    operations = [
        {"op": "create", "id": phase_id, "data": {"name": "Design", "duration": 1}},
        {"op": "create", "data": {"name": "Wireframes", "duration": 3, "parent_id": phase_id}},
        {"op": "create", "data": {"name": "Review", "duration": 1, "parent_id": phase_id}},
    ]

    with _no_side_effects():
        r = owner_client.post(url(project), {"operations": operations}, format="json")

    assert r.status_code == 207, r.data
    assert len(r.data["applied"]) == 3
    phase = Task.objects.get(pk=phase_id)
    assert phase.wbs_path == "1"
    children = list(Task.objects.filter(project=project).exclude(pk=phase_id).order_by("wbs_path"))
    assert [c.wbs_path for c in children] == ["1.1", "1.2"]
    assert [c.name for c in children] == ["Wireframes", "Review"]


@pytest.mark.django_db
def test_root_level_creates_in_one_batch_get_sequential_wbs_paths(
    owner_client: APIClient, project: Project
) -> None:
    operations = [{"op": "create", "data": {"name": f"Row {i}", "duration": 1}} for i in range(3)]

    with _no_side_effects():
        r = owner_client.post(url(project), {"operations": operations}, format="json")

    assert r.status_code == 207, r.data
    created = Task.objects.filter(project=project).order_by("wbs_path")
    assert [t.wbs_path for t in created] == ["1", "2", "3"]


@pytest.mark.django_db
def test_create_under_a_milestone_parent_is_rejected_without_discarding_siblings(
    owner_client: APIClient, project: Project
) -> None:
    """The depth/milestone placement guards apply per row — one bad parent must not
    fail the rest of the batch (#2723 §1 extended to placement, not just validation).
    """
    milestone = Task.objects.create(
        project=project, name="Ship", duration=0, wbs_path="1", is_milestone=True
    )
    operations = [
        {
            "op": "create",
            "data": {"name": "Bad child", "duration": 1, "parent_id": str(milestone.pk)},
        },
        {"op": "create", "data": {"name": "Fine at root", "duration": 1}},
    ]

    with _no_side_effects():
        r = owner_client.post(url(project), {"operations": operations}, format="json")

    assert r.status_code == 207, r.data
    assert [e["index"] for e in r.data["rejected"]] == [0]
    assert r.data["rejected"][0]["code"] == "invalid"
    assert [e["index"] for e in r.data["applied"]] == [1]
    assert Task.objects.filter(project=project, name="Bad child").exists() is False


@pytest.mark.django_db
def test_create_with_a_parent_id_from_another_project_is_rejected(
    owner_client: APIClient, project: Project, other_project: Project
) -> None:
    foreign_parent = Task.objects.create(
        project=other_project, name="Theirs", duration=1, wbs_path="1"
    )

    with _no_side_effects():
        r = owner_client.post(
            url(project),
            {
                "operations": [
                    {
                        "op": "create",
                        "data": {
                            "name": "Orphan",
                            "duration": 1,
                            "parent_id": str(foreign_parent.pk),
                        },
                    }
                ]
            },
            format="json",
        )

    assert r.status_code == 207, r.data
    assert len(r.data["rejected"]) == 1
    assert r.data["rejected"][0]["code"] == "invalid"


@pytest.mark.django_db
def test_update_op_ignores_a_parent_id_in_its_data(
    owner_client: APIClient, project: Project
) -> None:
    """PATCH-shaped update never re-parents through this path (matches perform_update,
    which does not touch wbs_path) — parent_id is popped unconditionally in
    _apply_create, not only on the create branch.
    """
    phase = Task.objects.create(project=project, name="Phase", duration=1, wbs_path="1")
    task = Task.objects.create(project=project, name="Loose", duration=1, wbs_path="2")

    with _no_side_effects():
        r = owner_client.post(
            url(project),
            {
                "operations": [
                    {
                        "op": "update",
                        "id": str(task.pk),
                        "data": {"parent_id": str(phase.pk), "duration": 5},
                    }
                ]
            },
            format="json",
        )

    assert r.status_code == 207, r.data
    assert len(r.data["applied"]) == 1
    task.refresh_from_db()
    assert task.wbs_path == "2"
    assert task.duration == 5
