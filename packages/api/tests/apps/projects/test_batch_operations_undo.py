"""⌘Z undo for paste-many, cascade classification, and CSV import (ADR-0810, #2756).

The assertions that matter most mirror ``test_project_templates.py``'s undo
coverage, extended to the touched-since check this ADR changed: paste-many and
CSV import create rows via a write path that stamps ``edited_at`` at creation
(paste-many) or never at all (import, bulk_create) — ``server_version``
comparison, not ``edited_at IS NOT NULL``, is what has to distinguish "nobody
touched this since the batch wrote it" from "someone touched it a second
later" in both cases.
"""

from __future__ import annotations

import base64
import uuid
from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.permissions import role_can_undo_batch_operation
from trueppm_api.apps.csvimport.models import CsvImportRequest, CsvImportStatus
from trueppm_api.apps.csvimport.parser import parse_spreadsheet
from trueppm_api.apps.msproject.importer import import_project
from trueppm_api.apps.projects.models import (
    Calendar,
    CascadeClassificationOperation,
    DeliveryMode,
    GovernanceClass,
    PasteManyOperation,
    Project,
    SyncBatchOperationStatus,
    Task,
)
from trueppm_api.apps.projects.task_batch_services import (
    finalize_import_fix_operation,
    undo_import_fix_operation,
)

from ..csvimport.fixtures import REFERENCE_CSV

User = get_user_model()

BULK_URL = "/api/v1/projects/{pk}/tasks/bulk/"
CLASSIFY_URL = "/api/v1/projects/{pk}/tasks/classification/"


def bulk_url(project: Project) -> str:
    return BULK_URL.format(pk=project.pk)


def classify_url(project: Project) -> str:
    return CLASSIFY_URL.format(pk=project.pk)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Undo", start_date=date(2026, 1, 1), calendar=calendar)


def _member(project: Project, username: str, role: int) -> APIClient:
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def owner_client(project: Project) -> APIClient:
    return _member(project, "owner", Role.OWNER)


@pytest.fixture
def member_client(project: Project) -> APIClient:
    return _member(project, "member", Role.MEMBER)


@pytest.fixture
def outsider_client() -> APIClient:
    """Authenticated, but a member of no project at all — the IDOR case."""
    user = User.objects.create_user(username="outsider", password="pw")
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _immediate_on_commit() -> Any:
    """Run ``transaction.on_commit`` callbacks synchronously.

    Tests run inside a rolled-back transaction (`@pytest.mark.django_db`), so an
    unpatched `on_commit` callback never fires — this is what lets a test assert
    on the broadcast/recalc calls those callbacks make.
    """
    return patch("django.db.transaction.on_commit", side_effect=lambda f: f())


# ---------------------------------------------------------------------------
# Paste-many
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_paste_many_operation_recorded_from_a_real_bulk_create(
    owner_client: APIClient, project: Project
) -> None:
    """The endpoint, not just the service — this is the wiring's own regression test."""
    ops = [{"op": "create", "data": {"name": f"Row {i}", "duration": 1}} for i in range(3)]
    r = owner_client.post(bulk_url(project), {"operations": ops}, format="json")
    assert r.status_code == 207, r.data

    operation = PasteManyOperation.objects.get(project=project)
    assert len(operation.created_task_versions) == 3
    assert operation.status == SyncBatchOperationStatus.ACTIVE
    # The frontend's whole undo affordance hangs off this field being present.
    assert r.data["operation_id"] == str(operation.pk)


@pytest.mark.django_db
def test_bulk_response_operation_id_is_null_when_nothing_was_created(
    owner_client: APIClient, project: Project
) -> None:
    task = Task.objects.create(project=project, name="Existing", duration=2)
    r = owner_client.post(
        bulk_url(project),
        {"operations": [{"op": "update", "id": str(task.pk), "data": {"duration": 3}}]},
        format="json",
    )
    assert r.data["operation_id"] is None


@pytest.mark.django_db
def test_paste_many_undo_removes_exactly_what_it_created(
    owner_client: APIClient, project: Project
) -> None:
    pre_existing = Task.objects.create(project=project, name="Ours", duration=3)
    ops = [{"op": "create", "data": {"name": f"Row {i}", "duration": 1}} for i in range(3)]
    owner_client.post(bulk_url(project), {"operations": ops}, format="json")
    operation_id = PasteManyOperation.objects.get(project=project).pk

    undo_resp = owner_client.post(
        f"/api/v1/paste-many-operations/{operation_id}/undo/", {}, format="json"
    )
    assert undo_resp.status_code == 200, undo_resp.data
    assert undo_resp.data["undo"] == {"deleted": 3, "kept": 0}

    pre_existing.refresh_from_db()
    assert pre_existing.is_deleted is False
    assert Task.objects.filter(project=project, is_deleted=False).count() == 1


@pytest.mark.django_db
def test_paste_many_undo_keeps_a_row_touched_after_the_paste(
    owner_client: APIClient, project: Project
) -> None:
    """The precise reason for the server_version check over edited_at.

    Paste-many creates through the normal serializer path, which stamps
    ``edited_at`` at creation itself — an ``edited_at IS NOT NULL`` check would
    call every freshly pasted row "touched" and undo nothing. This test would
    pass with `deleted: 0` under that bug and only the version-snapshot check
    catches it.
    """
    ops = [{"op": "create", "data": {"name": f"Row {i}", "duration": 1}} for i in range(2)]
    r = owner_client.post(bulk_url(project), {"operations": ops}, format="json")
    created_id = r.data["applied"][0]["id"]
    operation_id = PasteManyOperation.objects.get(project=project).pk

    # A person edits one of the pasted rows before anyone undoes the paste.
    touched = Task.objects.get(pk=created_id)
    touched.name = "Renamed by a person"
    touched.save()

    undo_resp = owner_client.post(
        f"/api/v1/paste-many-operations/{operation_id}/undo/", {}, format="json"
    )
    assert undo_resp.data["undo"] == {"deleted": 1, "kept": 1}
    touched.refresh_from_db()
    assert touched.is_deleted is False
    assert touched.name == "Renamed by a person"


@pytest.mark.django_db
def test_paste_many_undo_requires_admin(
    owner_client: APIClient, member_client: APIClient, project: Project
) -> None:
    owner_client.post(
        bulk_url(project),
        {"operations": [{"op": "create", "data": {"name": "Solo", "duration": 1}}]},
        format="json",
    )
    operation_id = PasteManyOperation.objects.get(project=project).pk

    resp = member_client.post(
        f"/api/v1/paste-many-operations/{operation_id}/undo/", {}, format="json"
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_paste_many_undo_twice_is_refused(owner_client: APIClient, project: Project) -> None:
    owner_client.post(
        bulk_url(project),
        {"operations": [{"op": "create", "data": {"name": "Solo", "duration": 1}}]},
        format="json",
    )
    operation_id = PasteManyOperation.objects.get(project=project).pk
    url = f"/api/v1/paste-many-operations/{operation_id}/undo/"

    first = owner_client.post(url, {}, format="json")
    assert first.status_code == 200
    second = owner_client.post(url, {}, format="json")
    assert second.status_code == 400


@pytest.mark.django_db
def test_bulk_batch_with_no_creates_records_no_paste_many_operation(
    owner_client: APIClient, project: Project
) -> None:
    task = Task.objects.create(project=project, name="Existing", duration=2)
    owner_client.post(
        bulk_url(project),
        {"operations": [{"op": "update", "id": str(task.pk), "data": {"duration": 3}}]},
        format="json",
    )
    assert PasteManyOperation.objects.filter(project=project).count() == 0


# ---------------------------------------------------------------------------
# Cascade classification
# ---------------------------------------------------------------------------


def _no_recalc() -> Any:
    from unittest.mock import patch

    return patch("trueppm_api.apps.projects.views._enqueue_recalculate")


@pytest.mark.django_db
def test_cascade_undo_restores_prior_classification(
    owner_client: APIClient, project: Project
) -> None:
    root = Task.objects.create(
        project=project,
        name="Phase",
        wbs_path="1",
        duration=5,
        governance_class=GovernanceClass.FLOW,
    )
    with _no_recalc():
        r = owner_client.patch(
            classify_url(project),
            {"subtree": str(root.pk), "cascade": False, "governance_class": "gated"},
            format="json",
        )
    assert r.status_code == 200, r.data
    operation = CascadeClassificationOperation.objects.get(project=project)
    assert operation.task_snapshots[str(root.pk)]["before"]["governance_class"] == "flow"
    assert r.data["operation_id"] == str(operation.pk)

    undo_resp = owner_client.post(
        f"/api/v1/cascade-classification-operations/{operation.pk}/undo/", {}, format="json"
    )
    assert undo_resp.status_code == 200, undo_resp.data
    assert undo_resp.data["undo"] == {"reverted": 1, "kept": 0}
    root.refresh_from_db()
    assert root.governance_class == "flow"


@pytest.mark.django_db
def test_cascade_response_operation_id_is_null_on_a_no_op(
    owner_client: APIClient, project: Project
) -> None:
    # The root's inherit bit is already at its post-cascade target value
    # (False — the root is always the declaration point), so re-declaring the
    # same governance_class is a genuine no-op rather than a bit flip.
    root = Task.objects.create(
        project=project,
        name="Phase",
        wbs_path="1",
        duration=5,
        governance_class="flow",
        parent_governance_inherited=False,
    )
    with _no_recalc():
        r = owner_client.patch(
            classify_url(project),
            {"subtree": str(root.pk), "cascade": False, "governance_class": "flow"},
            format="json",
        )
    assert r.status_code == 200, r.data
    assert r.data["operation_id"] is None
    assert CascadeClassificationOperation.objects.filter(project=project).count() == 0


@pytest.mark.django_db
def test_cascade_undo_skips_a_row_reclassified_since(
    owner_client: APIClient, project: Project
) -> None:
    root = Task.objects.create(
        project=project,
        name="Phase",
        wbs_path="1",
        duration=5,
        delivery_mode=DeliveryMode.WATERFALL,
    )
    with _no_recalc():
        owner_client.patch(
            classify_url(project),
            {"subtree": str(root.pk), "cascade": False, "delivery_mode": "scrum"},
            format="json",
        )
    operation = CascadeClassificationOperation.objects.get(project=project)

    # A person (or a second cascade) changes it again before anyone undoes the first.
    root.refresh_from_db()
    root.delivery_mode = DeliveryMode.KANBAN
    root.save()

    undo_resp = owner_client.post(
        f"/api/v1/cascade-classification-operations/{operation.pk}/undo/", {}, format="json"
    )
    assert undo_resp.data["undo"] == {"reverted": 0, "kept": 1}
    root.refresh_from_db()
    assert root.delivery_mode == "kanban"


@pytest.mark.django_db
def test_cascade_undo_requires_admin(
    owner_client: APIClient, member_client: APIClient, project: Project
) -> None:
    root = Task.objects.create(
        project=project, name="Phase", wbs_path="1", duration=5, governance_class="flow"
    )
    with _no_recalc():
        owner_client.patch(
            classify_url(project),
            {"subtree": str(root.pk), "cascade": False, "governance_class": "gated"},
            format="json",
        )
    operation = CascadeClassificationOperation.objects.get(project=project)

    resp = member_client.post(
        f"/api/v1/cascade-classification-operations/{operation.pk}/undo/", {}, format="json"
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# `can_undo` on the cascade's own 200 (#3304)
#
# Apply is `IsProjectPlanAuthor` (Member+ minus the resource-management band) and
# the undo endpoint is Admin+, so a Member clears one floor and not the other. The
# receipt has to say which, because the Undo affordance lives on an 8-second toast
# with no second route to it. `role_can_undo_batch_operation` is the one rule both
# the field and `_require_admin` call, so these assertions and the 403 above cannot
# drift apart.
# ---------------------------------------------------------------------------


def _classify(client: APIClient, project: Project, root: Task) -> Any:
    with _no_recalc():
        return client.patch(
            classify_url(project),
            {"subtree": str(root.pk), "cascade": False, "governance_class": "gated"},
            format="json",
        )


@pytest.mark.parametrize(
    ("role", "expected"),
    [
        (None, False),
        (Role.VIEWER, False),
        (Role.MEMBER, False),
        # The one ordinal where the two rules diverge non-obviously: `role_can_author_plan`
        # excludes the resource band as a BAND, this one refuses it as a THRESHOLD. Same
        # answer, different reason, and only one of them survives a renumber.
        (Role.SCHEDULER, False),
        (Role.ADMIN, True),
        # 301-399 is the Enterprise project-lead band (ADR-0072). The docstring claims a
        # custom role registered there inherits undo authority — this is that claim.
        (350, True),
        (Role.OWNER, True),
    ],
)
def test_role_can_undo_batch_operation_band_table(role: int | None, expected: bool) -> None:
    """The predicate itself, as a pure function — no request, no database.

    Pinned directly because it is now the single definition both the undo endpoint's
    refusal and the cascade's ``can_undo`` field resolve through, and because its
    docstring makes two checkable claims (threshold not band exclusion; fails closed
    on ``None``) that nothing else asserts.
    """
    assert role_can_undo_batch_operation(role) is expected


@pytest.mark.django_db
@pytest.mark.parametrize("role", [Role.MEMBER, Role.ADMIN, Role.OWNER])
def test_cascade_can_undo_agrees_with_the_predicate_for_every_role_that_can_apply(
    project: Project, role: int
) -> None:
    """The field and the predicate, asserted against each other rather than hard-coded.

    The whole justification for shipping ``can_undo`` is that the client must not
    re-derive the rule. Hard-coding ``is True`` / ``is False`` per role would let the
    field drift from the predicate and only the enumerated roles would notice; this
    says they are the same answer. Mirrors ``test_task_bulk_contract``'s ``can_author``
    coverage.

    Scoped to the roles that can reach a 200 at all: Viewer and Scheduler are refused
    by the apply gate, so there is no response for the field to be on.
    """
    user = User.objects.create_user(username=f"role-{role}", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    client = APIClient()
    client.force_authenticate(user=user)
    root = Task.objects.create(
        project=project,
        name="Phase",
        wbs_path="1",
        duration=5,
        governance_class="flow",
        # A Member may only cascade rows assigned to them (ADR-0790 §6 is
        # all-or-nothing over ``can_user_edit_task``); Admin+ needs no assignment.
        assignee=user if role == Role.MEMBER else None,
    )
    r = _classify(client, project, root)
    assert r.status_code == 200, r.data
    assert r.data["can_undo"] is role_can_undo_batch_operation(role)


@pytest.mark.django_db
def test_cascade_undo_refuses_the_resource_band_too(
    owner_client: APIClient, project: Project
) -> None:
    """Scheduler (200) is above Member but still below the undo floor.

    The existing 403 coverage used Member alone, which cannot tell a threshold from a
    band rule — and the resource band is genuinely reachable here, because the undo
    viewsets gate on ``IsAuthenticated`` plus a membership-scoped queryset rather than
    on the plan-authoring class that excludes the band at apply time.
    """
    scheduler_client = _member(project, "scheduler", Role.SCHEDULER)
    root = Task.objects.create(
        project=project, name="Phase", wbs_path="1", duration=5, governance_class="flow"
    )
    with _no_recalc():
        owner_client.patch(
            classify_url(project),
            {"subtree": str(root.pk), "cascade": False, "governance_class": "gated"},
            format="json",
        )
    operation = CascadeClassificationOperation.objects.get(project=project)

    resp = scheduler_client.post(
        f"/api/v1/cascade-classification-operations/{operation.pk}/undo/", {}, format="json"
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_cascade_response_reports_can_undo_true_for_an_owner(
    owner_client: APIClient, project: Project
) -> None:
    root = Task.objects.create(
        project=project, name="Phase", wbs_path="1", duration=5, governance_class="flow"
    )
    r = _classify(owner_client, project, root)
    assert r.status_code == 200, r.data
    assert r.data["can_undo"] is True


@pytest.mark.django_db
def test_cascade_response_reports_can_undo_true_for_an_admin(
    project: Project,
) -> None:
    """Admin (300) is the floor itself, not just Owner — a `>` would pass Owner alone."""
    admin_client = _member(project, "admin", Role.ADMIN)
    root = Task.objects.create(
        project=project, name="Phase", wbs_path="1", duration=5, governance_class="flow"
    )
    r = _classify(admin_client, project, root)
    assert r.status_code == 200, r.data
    assert r.data["can_undo"] is True


@pytest.mark.django_db
def test_cascade_response_reports_can_undo_false_for_a_member_who_may_apply(
    project: Project,
) -> None:
    """The bug's exact shape: the cascade succeeds, the ledger row exists, and the
    caller still may not undo it. `operation_id` alone therefore cannot decide the
    affordance — which is why `can_undo` is a separate field rather than folded in.

    The Member has to be the **assignee**, and that is the whole reachable path.
    `IsProjectPlanAuthor` admits Member+, but the cascade is all-or-nothing per
    ADR-0790 §6 and resolves each row through ``can_user_edit_task``, which lets a
    Member edit only their own assigned tasks. So an unassigned subtree 403s at
    apply and never reaches the toast at all — the bug needs a Member classifying
    work that is genuinely theirs, which is exactly the case the feature is for.
    """
    user = User.objects.create_user(username="assigned-member", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    member_client = APIClient()
    member_client.force_authenticate(user=user)

    root = Task.objects.create(
        project=project,
        name="Phase",
        wbs_path="1",
        duration=5,
        governance_class="flow",
        assignee=user,
    )
    r = _classify(member_client, project, root)
    assert r.status_code == 200, r.data
    # The Member really did apply it, and a real ledger row was written.
    assert r.data["operation_id"] is not None
    assert CascadeClassificationOperation.objects.filter(project=project).count() == 1
    assert r.data["can_undo"] is False

    # And the field is honest: the undo it withholds is genuinely refused.
    resp = member_client.post(
        f"/api/v1/cascade-classification-operations/{r.data['operation_id']}/undo/",
        {},
        format="json",
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_cascade_response_reports_can_undo_independently_of_operation_id(
    owner_client: APIClient, project: Project
) -> None:
    """A no-op cascade records nothing, but the caller's authority is unchanged.

    Pinned because collapsing the two into one boolean is the obvious
    simplification, and it would make a `false` mean either "nothing to undo" or
    "not your role" with no way for a client to tell them apart.
    """
    root = Task.objects.create(
        project=project,
        name="Phase",
        wbs_path="1",
        duration=5,
        governance_class="gated",
        parent_governance_inherited=False,
    )
    r = _classify(owner_client, project, root)
    assert r.status_code == 200, r.data
    assert r.data["operation_id"] is None
    assert r.data["can_undo"] is True


# ---------------------------------------------------------------------------
# `can_undo_batch_operations` on the PROJECT DETAIL payload (#3357)
#
# The pre-act half of what `can_undo` answers post-act. The cascade popover has to
# disclose the reversal floor BEFORE the irreversible act, and the apply response
# arrives after it — so the same predicate is emitted on a payload the surface
# already holds. Third call site of `role_can_undo_batch_operation`; these
# assertions exist so it stays one rule rather than becoming three.
# ---------------------------------------------------------------------------


def project_detail_url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/"


def _grant_po_facet(project: Project, user: Any) -> None:
    """Give ``user`` the Product-Owner facet on the project's default team.

    Mirrors ``test_rbac._grant_facet`` — facets live on the TeamMembership row of the
    project's default team, and the on_commit mirror signal does not fire inside the
    test transaction, so the row is written directly.
    """
    from trueppm_api.apps.teams.models import Team, TeamMembership, TeamRole

    team, _ = Team.objects.get_or_create(
        project=project,
        is_default=True,
        defaults={"name": "Default Team", "short_id": "T01"},
    )
    TeamMembership.objects.create(team=team, user=user, role=TeamRole.MEMBER, is_product_owner=True)


@pytest.mark.django_db
@pytest.mark.parametrize(
    "role",
    [
        Role.VIEWER,
        Role.MEMBER,
        Role.SCHEDULER,
        Role.ADMIN,
        Role.OWNER,
    ],
)
def test_project_detail_can_undo_batch_operations_agrees_with_the_predicate(
    project: Project, role: int
) -> None:
    """All five roles, asserted against the predicate rather than a truth table.

    Against ``role_can_undo_batch_operation`` for the reason ``can_undo``'s own test
    gives: a hard-coded expectation lets the field drift from the rule the undo
    endpoint enforces and only the enumerated roles would notice. Unlike ``can_undo``
    this one covers Viewer and Scheduler too — the field rides the project detail,
    which every role can read, not an apply response only a plan author can reach.

    The Enterprise 301-399 band is NOT parametrized here, and the omission is not an
    oversight in this field: a membership at an unnamed ordinal 500s the whole detail
    route on a *different* field, ``my_role_label``, whose ``Role(role).label`` raises
    ``ValueError`` before this one is ever reached. The band claim is pinned on the
    predicate itself by ``test_role_can_undo_batch_operation_band_table`` above, which
    is where it belongs anyway — this field adds no band logic of its own.
    """
    user = User.objects.create_user(username=f"detail-{role}", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    client = APIClient()
    client.force_authenticate(user=user)

    r = client.get(project_detail_url(project))
    assert r.status_code == 200, r.data
    assert r.data["can_undo_batch_operations"] is role_can_undo_batch_operation(role)


@pytest.mark.django_db
def test_project_detail_can_undo_batch_operations_is_false_for_a_product_owner_below_admin(
    project: Project,
) -> None:
    """The case the whole server-side choice exists for (#3357, web rule 373(a)).

    A Member holding the Product-Owner facet may **apply** a cascade from the product
    backlog — that entry point is gated on ``can_manage_backlog``, which is
    ``Admin+ OR the PO facet`` — and may **not** undo one, because the undo floor is a
    plain Admin+ threshold that the facet does not reach.

    Both halves are asserted, because the defect this guards is not "the field is
    wrong for a PO"; it is a client reusing the authority variable already in scope on
    that surface. ``can_manage_backlog`` is true here and
    ``can_undo_batch_operations`` is false, so the two are demonstrably different
    answers and one cannot stand in for the other.
    """
    from trueppm_api.apps.access.permissions import can_manage_backlog_with_facet

    user = User.objects.create_user(username="po-below-admin", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    _grant_po_facet(project, user)
    client = APIClient()
    client.force_authenticate(user=user)

    assert can_manage_backlog_with_facet(user, project.pk, Role.MEMBER) is True

    r = client.get(project_detail_url(project))
    assert r.status_code == 200, r.data
    assert r.data["can_undo_batch_operations"] is False


@pytest.mark.django_db
def test_project_detail_can_undo_batch_operations_matches_the_cascade_receipt(
    project: Project,
) -> None:
    """The pre-act disclosure and the post-act receipt, **on a fresh apply**.

    Two call sites of one predicate on two different payloads, and the point of the
    feature is that a planner is told the same thing before and after. A drift here
    would be invisible to either field's own test.

    Scoped to a fresh apply on purpose, and the scope is not pedantry. The two
    payloads are NOT guaranteed to agree in general: ``TaskClassificationView`` carries
    ``IdempotencyMixin``, whose request hash covers method, path and body but not the
    caller's role, so a repeated ``Idempotency-Key`` replays a stored ``can_undo`` that
    may predate a role change while the project detail re-derives live. Asserting the
    equality unconditionally would state a guarantee the system does not make — see
    ``can_user_undo_batch_operation``'s own docstring, which flags the same snapshot.
    """
    user = User.objects.create_user(username="pre-and-post", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    client = APIClient()
    client.force_authenticate(user=user)
    root = Task.objects.create(
        project=project,
        name="Phase",
        wbs_path="1",
        duration=5,
        governance_class="flow",
        assignee=user,
    )

    detail = client.get(project_detail_url(project))
    assert detail.status_code == 200, detail.data
    receipt = _classify(client, project, root)
    assert receipt.status_code == 200, receipt.data

    assert detail.data["can_undo_batch_operations"] is receipt.data["can_undo"]
    assert detail.data["can_undo_batch_operations"] is False


@pytest.mark.django_db
def test_project_detail_can_undo_batch_operations_without_the_my_role_annotation(
    project: Project,
) -> None:
    """The serializer's fallback branch, which no API route reaches.

    ``ProjectViewSet.get_queryset`` annotates ``_my_role`` on both list and retrieve,
    so the request-scoped fallback only fires for an instance serialized outside that
    queryset (a freshly-created object, or a caller building the serializer by hand).
    It is asserted directly because it is a *second* resolution path for the same
    field, and a second path that no test exercises is a second answer waiting to
    disagree with the first.
    """
    from rest_framework.test import APIRequestFactory

    from trueppm_api.apps.projects.serializers import ProjectSerializer

    admin = User.objects.create_user(username="unannotated-admin", password="pw")
    ProjectMembership.objects.create(project=project, user=admin, role=Role.ADMIN)
    member = User.objects.create_user(username="unannotated-member", password="pw")
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)

    factory = APIRequestFactory()

    def field_for(user: Any) -> Any:
        request = factory.get(project_detail_url(project))
        request.user = user
        # A plain Project instance — not from the annotated queryset — so
        # ``getattr(obj, "_my_role", None)`` is None and the fallback runs.
        fresh = Project.objects.get(pk=project.pk)
        assert not hasattr(fresh, "_my_role")
        return ProjectSerializer(fresh, context={"request": request}).data[
            "can_undo_batch_operations"
        ]

    assert field_for(admin) is True
    assert field_for(member) is False


# ---------------------------------------------------------------------------
# Import-fix (CSV import) — service-level, mirroring test_import.py's own
# direct-``import_project`` pattern rather than the full upload/Celery path.
# ---------------------------------------------------------------------------


def _make_request(project: Project, **kwargs: object) -> CsvImportRequest:
    defaults: dict[str, object] = {
        "project": project,
        "filename": "plan.csv",
        "file_content_b64": base64.b64encode(REFERENCE_CSV).decode("ascii"),
    }
    defaults.update(kwargs)
    return CsvImportRequest.objects.create(**defaults)


@pytest.mark.django_db
def test_import_project_reports_created_task_ids(project: Project) -> None:
    parsed = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
    summary = import_project(str(project.pk), parsed.project_data)
    assert len(summary["created_task_ids"]) == summary["tasks_created"] == 7


@pytest.mark.django_db
def test_import_fix_undo_removes_exactly_what_it_created(project: Project) -> None:
    pre_existing = Task.objects.create(project=project, name="Ours", duration=3)
    parsed = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
    summary = import_project(str(project.pk), parsed.project_data)
    req = _make_request(project, status=CsvImportStatus.DONE)
    finalize_import_fix_operation(str(req.pk), project.pk, summary["created_task_ids"])
    req.refresh_from_db()
    assert len(req.created_task_versions) == 7

    result = undo_import_fix_operation(req)
    assert result == {"deleted": 7, "kept": 0}
    pre_existing.refresh_from_db()
    assert pre_existing.is_deleted is False
    assert Task.objects.filter(project=project, is_deleted=False).count() == 1


@pytest.mark.django_db
def test_import_fix_undo_keeps_a_row_a_person_has_touched(project: Project) -> None:
    parsed = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
    summary = import_project(str(project.pk), parsed.project_data)
    req = _make_request(project, status=CsvImportStatus.DONE)
    finalize_import_fix_operation(str(req.pk), project.pk, summary["created_task_ids"])
    req.refresh_from_db()

    touched = Task.objects.get(pk=summary["created_task_ids"][0])
    touched.name = "Renamed after import"
    touched.save()

    result = undo_import_fix_operation(req)
    assert result == {"deleted": 6, "kept": 1}
    touched.refresh_from_db()
    assert touched.is_deleted is False
    assert touched.name == "Renamed after import"


@pytest.mark.django_db
def test_import_fix_undo_is_idempotent(project: Project) -> None:
    parsed = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
    summary = import_project(str(project.pk), parsed.project_data)
    req = _make_request(project, status=CsvImportStatus.DONE)
    finalize_import_fix_operation(str(req.pk), project.pk, summary["created_task_ids"])
    req.refresh_from_db()

    first = undo_import_fix_operation(req)
    req.refresh_from_db()
    second = undo_import_fix_operation(req)
    assert first == second == {"deleted": 7, "kept": 0}
    assert Task.objects.filter(project=project, is_deleted=False).count() == 0


@pytest.mark.django_db
def test_import_fix_undo_endpoint_refuses_a_not_yet_done_import(
    owner_client: APIClient, project: Project
) -> None:
    req = _make_request(project, status=CsvImportStatus.DISPATCHED)
    resp = owner_client.post(
        f"/api/v1/projects/{project.pk}/import/csv/{req.pk}/undo/", {}, format="json"
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_import_fix_undo_endpoint_requires_admin(
    owner_client: APIClient, member_client: APIClient, project: Project
) -> None:
    parsed = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
    summary = import_project(str(project.pk), parsed.project_data)
    req = _make_request(project, status=CsvImportStatus.DONE)
    finalize_import_fix_operation(str(req.pk), project.pk, summary["created_task_ids"])

    resp = member_client.post(
        f"/api/v1/projects/{project.pk}/import/csv/{req.pk}/undo/", {}, format="json"
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_import_fix_undo_endpoint_happy_path(owner_client: APIClient, project: Project) -> None:
    parsed = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
    summary = import_project(str(project.pk), parsed.project_data)
    req = _make_request(project, status=CsvImportStatus.DONE)
    finalize_import_fix_operation(str(req.pk), project.pk, summary["created_task_ids"])

    resp = owner_client.post(
        f"/api/v1/projects/{project.pk}/import/csv/{req.pk}/undo/", {}, format="json"
    )
    assert resp.status_code == 200, resp.data
    assert resp.data["undo"] == {"deleted": 7, "kept": 0}
    assert resp.data["status"] == CsvImportStatus.UNDONE


# ---------------------------------------------------------------------------
# Purge (ADR-0810 §Durable Execution 6)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_purge_deletes_only_rows_past_retention(project: Project, settings: Any) -> None:
    from trueppm_api.apps.projects.tasks import _do_purge_expired_batch_operations

    settings.TRUEPPM_BATCH_OPERATION_RETENTION_DAYS = 30
    old = PasteManyOperation.objects.create(project=project, created_task_versions={})
    PasteManyOperation.objects.filter(pk=old.pk).update(
        created_at=old.created_at.replace(year=old.created_at.year - 1)
    )
    recent = PasteManyOperation.objects.create(project=project, created_task_versions={})

    _do_purge_expired_batch_operations()

    assert not PasteManyOperation.objects.filter(pk=old.pk).exists()
    assert PasteManyOperation.objects.filter(pk=recent.pk).exists()


@pytest.mark.django_db
def test_purge_disabled_when_retention_is_none(project: Project, settings: Any) -> None:
    from trueppm_api.apps.projects.tasks import _do_purge_expired_batch_operations

    settings.TRUEPPM_BATCH_OPERATION_RETENTION_DAYS = None
    old = PasteManyOperation.objects.create(project=project, created_task_versions={})
    PasteManyOperation.objects.filter(pk=old.pk).update(
        created_at=old.created_at.replace(year=old.created_at.year - 1)
    )

    _do_purge_expired_batch_operations()

    assert PasteManyOperation.objects.filter(pk=old.pk).exists()


# ---------------------------------------------------------------------------
# Cross-project undo (IDOR) — rbac-check / security-review coverage gap
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_paste_many_undo_404s_for_a_caller_with_no_membership_on_the_project(
    owner_client: APIClient, outsider_client: APIClient, project: Project
) -> None:
    owner_client.post(
        bulk_url(project),
        {"operations": [{"op": "create", "data": {"name": "Solo", "duration": 1}}]},
        format="json",
    )
    operation_id = PasteManyOperation.objects.get(project=project).pk

    resp = outsider_client.post(
        f"/api/v1/paste-many-operations/{operation_id}/undo/", {}, format="json"
    )
    # get_queryset() scopes to the caller's own memberships — an operation on a
    # project the caller has never joined does not exist as far as they're
    # concerned, so this is a 404, not a 403 (no existence leak).
    assert resp.status_code == 404


@pytest.mark.django_db
def test_cascade_undo_404s_for_a_caller_with_no_membership_on_the_project(
    owner_client: APIClient, outsider_client: APIClient, project: Project
) -> None:
    root = Task.objects.create(
        project=project, name="Phase", wbs_path="1", duration=5, governance_class="flow"
    )
    with _no_recalc():
        owner_client.patch(
            classify_url(project),
            {"subtree": str(root.pk), "cascade": False, "governance_class": "gated"},
            format="json",
        )
    operation_id = CascadeClassificationOperation.objects.get(project=project).pk

    resp = outsider_client.post(
        f"/api/v1/cascade-classification-operations/{operation_id}/undo/", {}, format="json"
    )
    assert resp.status_code == 404


@pytest.mark.django_db
def test_import_fix_undo_404s_for_a_caller_with_no_membership_on_the_project(
    outsider_client: APIClient, project: Project
) -> None:
    parsed = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
    summary = import_project(str(project.pk), parsed.project_data)
    req = _make_request(project, status=CsvImportStatus.DONE)
    finalize_import_fix_operation(str(req.pk), project.pk, summary["created_task_ids"])

    resp = outsider_client.post(
        f"/api/v1/projects/{project.pk}/import/csv/{req.pk}/undo/", {}, format="json"
    )
    # IsProjectScheduler is the class-level gate here (not a plain IsAuthenticated
    # + queryset scope like the two router-registered viewsets above), so a
    # non-member fails that permission class before the view body even runs —
    # 403, not 404. Different mechanism, same outcome: no cross-project undo.
    assert resp.status_code == 403


@pytest.mark.django_db
def test_import_fix_undo_404s_when_project_pk_does_not_match_the_import(
    owner_client: APIClient, project: Project, calendar: Calendar
) -> None:
    """The dual-key lookup (id AND project_id) — not just id — is what closes this."""
    other_project = Project.objects.create(
        name="Other", start_date=date(2026, 1, 1), calendar=calendar
    )
    parsed = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
    summary = import_project(str(project.pk), parsed.project_data)
    req = _make_request(project, status=CsvImportStatus.DONE)
    finalize_import_fix_operation(str(req.pk), project.pk, summary["created_task_ids"])

    # owner_client is Admin on `project`, but not on `other_project` — using
    # other_project's pk in the URL with project's own import id must 404, not
    # silently undo an import that belongs to a different project.
    resp = owner_client.post(
        f"/api/v1/projects/{other_project.pk}/import/csv/{req.pk}/undo/", {}, format="json"
    )
    assert resp.status_code in (403, 404)
    req.refresh_from_db()
    assert req.status == CsvImportStatus.DONE


# ---------------------------------------------------------------------------
# Broadcast + recalc on undo (broadcast-check finding — undo is a mutation too)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_paste_many_undo_broadcasts_and_recalculates(
    owner_client: APIClient, project: Project
) -> None:
    ops = [{"op": "create", "data": {"name": f"Row {i}", "duration": 1}} for i in range(2)]
    owner_client.post(bulk_url(project), {"operations": ops}, format="json")
    operation_id = PasteManyOperation.objects.get(project=project).pk

    with (
        _immediate_on_commit(),
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_broadcast,
        patch("trueppm_api.apps.scheduling.services.enqueue_recalculate") as mock_recalc,
    ):
        resp = owner_client.post(
            f"/api/v1/paste-many-operations/{operation_id}/undo/", {}, format="json"
        )
    assert resp.status_code == 200
    mock_recalc.assert_called_once_with(str(project.pk))
    mock_broadcast.assert_called_once()
    args = mock_broadcast.call_args[0]
    assert args[0] == str(project.pk)
    assert args[1] == "tasks_bulk_mutated"
    assert len(args[2]["task_ids"]) == 2


@pytest.mark.django_db
def test_cascade_undo_broadcasts_and_recalculates(
    owner_client: APIClient, project: Project
) -> None:
    root = Task.objects.create(
        project=project, name="Phase", wbs_path="1", duration=5, governance_class="flow"
    )
    with _no_recalc():
        owner_client.patch(
            classify_url(project),
            {"subtree": str(root.pk), "cascade": False, "governance_class": "gated"},
            format="json",
        )
    operation_id = CascadeClassificationOperation.objects.get(project=project).pk

    with (
        _immediate_on_commit(),
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_broadcast,
        patch("trueppm_api.apps.scheduling.services.enqueue_recalculate") as mock_recalc,
    ):
        resp = owner_client.post(
            f"/api/v1/cascade-classification-operations/{operation_id}/undo/", {}, format="json"
        )
    assert resp.status_code == 200
    mock_recalc.assert_called_once_with(str(project.pk))
    mock_broadcast.assert_called_once_with(
        str(project.pk), "tasks_bulk_mutated", {"task_ids": [str(root.pk)]}
    )


@pytest.mark.django_db
def test_import_fix_undo_broadcasts_and_recalculates(
    owner_client: APIClient, project: Project
) -> None:
    parsed = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
    summary = import_project(str(project.pk), parsed.project_data)
    req = _make_request(project, status=CsvImportStatus.DONE)
    finalize_import_fix_operation(str(req.pk), project.pk, summary["created_task_ids"])

    with (
        _immediate_on_commit(),
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_broadcast,
        patch("trueppm_api.apps.scheduling.services.enqueue_recalculate") as mock_recalc,
    ):
        resp = owner_client.post(
            f"/api/v1/projects/{project.pk}/import/csv/{req.pk}/undo/", {}, format="json"
        )
    assert resp.status_code == 200
    mock_recalc.assert_called_once_with(str(project.pk))
    mock_broadcast.assert_called_once()
    args = mock_broadcast.call_args[0]
    assert args[0] == str(project.pk)
    assert args[1] == "tasks_bulk_mutated"
    assert len(args[2]["task_ids"]) == 7


# ---------------------------------------------------------------------------
# Archived-project floor (#3354)
#
# `PasteManyOperationViewSet` and `CascadeClassificationOperationViewSet` shipped
# with `permission_classes = [IsAuthenticated]` only, while every sibling write in
# this family (`StructuralOperationViewSet`, `CsvImportUndoView`, `TaskBulkView`,
# `TaskClassificationView`) carried `IsProjectNotArchived`. So an Admin could
# hard-delete rows in an archived project through the undo route.
#
# The floor is about project *state*, not role — hence the Owner in these tests,
# the highest role there is. A test that used a Member would pass on the broken
# build for the wrong reason.
# ---------------------------------------------------------------------------


def _archive(project: Project) -> None:
    project.is_archived = True
    project.save(update_fields=["is_archived"])


@pytest.mark.django_db
def test_paste_many_undo_is_refused_once_the_project_is_archived(
    owner_client: APIClient, project: Project
) -> None:
    ops = [{"op": "create", "data": {"name": f"Row {i}", "duration": 1}} for i in range(3)]
    owner_client.post(bulk_url(project), {"operations": ops}, format="json")
    operation = PasteManyOperation.objects.get(project=project)
    _archive(project)

    resp = owner_client.post(
        f"/api/v1/paste-many-operations/{operation.pk}/undo/", {}, format="json"
    )

    assert resp.status_code == 403, resp.data
    # The refusal has to be inert, not just non-200: the undo hard-deletes rows, so
    # a 403 that still ran the service would be the same data loss with a worse
    # status code.
    assert Task.objects.filter(project=project, is_deleted=False).count() == 3
    operation.refresh_from_db()
    assert operation.status == SyncBatchOperationStatus.ACTIVE
    assert operation.undone_at is None


@pytest.mark.django_db
def test_cascade_undo_is_refused_once_the_project_is_archived(
    owner_client: APIClient, project: Project
) -> None:
    root = Task.objects.create(
        project=project, name="Phase", wbs_path="1", duration=5, governance_class="flow"
    )
    with _no_recalc():
        owner_client.patch(
            classify_url(project),
            {"subtree": str(root.pk), "cascade": False, "governance_class": "gated"},
            format="json",
        )
    operation = CascadeClassificationOperation.objects.get(project=project)
    _archive(project)

    resp = owner_client.post(
        f"/api/v1/cascade-classification-operations/{operation.pk}/undo/", {}, format="json"
    )

    assert resp.status_code == 403, resp.data
    root.refresh_from_db()
    # Still the cascaded value — the undo did not write the "before" snapshot back.
    assert root.governance_class == GovernanceClass.GATED
    operation.refresh_from_db()
    assert operation.status == SyncBatchOperationStatus.ACTIVE


@pytest.mark.django_db
def test_paste_many_undo_still_works_when_the_project_is_not_archived(
    owner_client: APIClient, project: Project
) -> None:
    """Negative control for the two refusals above.

    Identical setup minus the archive step. Without this, a permission class wired
    to refuse unconditionally would pass both refusal tests.
    """
    ops = [{"op": "create", "data": {"name": f"Row {i}", "duration": 1}} for i in range(3)]
    owner_client.post(bulk_url(project), {"operations": ops}, format="json")
    operation = PasteManyOperation.objects.get(project=project)

    resp = owner_client.post(
        f"/api/v1/paste-many-operations/{operation.pk}/undo/", {}, format="json"
    )

    assert resp.status_code == 200, resp.data
    assert Task.objects.filter(project=project, is_deleted=False).count() == 0


@pytest.mark.django_db
def test_cascade_undo_still_works_when_the_project_is_not_archived(
    owner_client: APIClient, project: Project
) -> None:
    root = Task.objects.create(
        project=project, name="Phase", wbs_path="1", duration=5, governance_class="flow"
    )
    with _no_recalc():
        owner_client.patch(
            classify_url(project),
            {"subtree": str(root.pk), "cascade": False, "governance_class": "gated"},
            format="json",
        )
    operation = CascadeClassificationOperation.objects.get(project=project)

    resp = owner_client.post(
        f"/api/v1/cascade-classification-operations/{operation.pk}/undo/", {}, format="json"
    )

    assert resp.status_code == 200, resp.data
    root.refresh_from_db()
    assert root.governance_class == GovernanceClass.FLOW


@pytest.mark.django_db
@pytest.mark.parametrize(
    "collection",
    ["paste-many-operations", "cascade-classification-operations"],
)
def test_reading_a_ledger_row_still_works_on_an_archived_project(
    owner_client: APIClient, project: Project, collection: str
) -> None:
    """`IsProjectNotArchived` passes every SAFE_METHOD, and it has to.

    Archiving makes a plan read-only, not invisible. If the added permission class
    also blocked GET, the Undo affordance's own polling would 403 on an archived
    project — a regression the two refusal tests above cannot see.
    """
    if collection == "paste-many-operations":
        operation_pk = PasteManyOperation.objects.create(
            project=project, created_task_versions={}
        ).pk
    else:
        operation_pk = CascadeClassificationOperation.objects.create(
            project=project, subtree_id=uuid.uuid4(), task_snapshots={}
        ).pk
    _archive(project)

    resp = owner_client.get(f"/api/v1/{collection}/{operation_pk}/")

    assert resp.status_code == 200, resp.data


# ---------------------------------------------------------------------------
# The same floor underneath the view (#3354)
#
# The views are only one door. These call the services directly — the shape a
# Celery task, a management command, or a future body-resolving endpoint would
# take — and are what stop the hole being reintroduced by a non-view caller.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_undo_paste_many_service_refuses_an_archived_project(project: Project) -> None:
    from rest_framework.exceptions import PermissionDenied

    from trueppm_api.apps.projects.task_batch_services import undo_paste_many_operation

    task = Task.objects.create(project=project, name="Pasted", duration=1)
    operation = PasteManyOperation.objects.create(
        project=project, created_task_versions={str(task.pk): task.server_version}
    )
    _archive(project)

    with pytest.raises(PermissionDenied):
        undo_paste_many_operation(operation)

    task.refresh_from_db()
    assert task.is_deleted is False


@pytest.mark.django_db
def test_undo_cascade_service_refuses_an_archived_project(project: Project) -> None:
    from rest_framework.exceptions import PermissionDenied

    from trueppm_api.apps.projects.task_batch_services import (
        undo_cascade_classification_operation,
    )

    task = Task.objects.create(
        project=project, name="Phase", wbs_path="1", duration=1, governance_class="gated"
    )
    operation = CascadeClassificationOperation.objects.create(
        project=project,
        subtree_id=task.pk,
        # The real shape the service reads: {"version": N, "before": {...fields}}.
        # Getting this right is what makes the negative control honest — with a
        # malformed snapshot the reverted build dies on a KeyError instead of
        # actually reverting, and the test would be asserting the wrong failure.
        task_snapshots={
            str(task.pk): {
                "version": task.server_version,
                "before": {"governance_class": GovernanceClass.FLOW},
            }
        },
    )
    _archive(project)

    with pytest.raises(PermissionDenied):
        undo_cascade_classification_operation(operation)

    task.refresh_from_db()
    assert task.governance_class == GovernanceClass.GATED


@pytest.mark.django_db
def test_undo_import_fix_service_refuses_an_archived_project(project: Project) -> None:
    """The third undo service in this file, held to the same floor as its two siblings.

    `CsvImportUndoView` has always carried `IsProjectNotArchived`, so this closes no
    open hole. It is here because a floor with one exception is not a floor — the
    exception is the one a non-view caller reaches for.
    """
    from rest_framework.exceptions import PermissionDenied

    parsed = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
    summary = import_project(str(project.pk), parsed.project_data)
    req = _make_request(project, status=CsvImportStatus.DONE)
    finalize_import_fix_operation(str(req.pk), project.pk, summary["created_task_ids"])
    _archive(project)

    with pytest.raises(PermissionDenied):
        undo_import_fix_operation(req)

    assert Task.objects.filter(project=project, is_deleted=False).count() == 7
    req.refresh_from_db()
    assert req.status == CsvImportStatus.DONE


# ---------------------------------------------------------------------------
# The helper fails closed on input it cannot resolve (#3354)
#
# `Project.objects.filter(pk=None)` compiles to `id IS NULL`, matches nothing, and
# would read as "not archived" — a silent fail-open in the one function whose whole
# value is being unbypassable. An unparseable id reaches `UUIDField.to_python`,
# which raises Django's ValidationError: not something DRF converts, so it would
# surface as a 500 rather than a refusal (the #2785 class).
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize(
    "bad", [None, "not-a-uuid", "", 12345, []], ids=["none", "garbage", "empty", "int", "list"]
)
def test_assert_project_not_archived_fails_closed_on_an_unresolvable_id(bad: Any) -> None:
    from rest_framework.exceptions import PermissionDenied

    from trueppm_api.apps.access.permissions import assert_project_not_archived

    with pytest.raises(PermissionDenied):
        assert_project_not_archived(bad)


@pytest.mark.django_db
def test_assert_project_not_archived_passes_a_live_project(project: Project) -> None:
    """Negative control — without this the test above passes on a function that
    raises unconditionally."""
    from trueppm_api.apps.access.permissions import assert_project_not_archived

    assert_project_not_archived(project.pk)
    assert_project_not_archived(str(project.pk))

    _archive(project)
    from rest_framework.exceptions import PermissionDenied

    with pytest.raises(PermissionDenied):
        assert_project_not_archived(project.pk)


@pytest.mark.django_db
def test_assert_project_not_archived_re_reads_a_stale_instance(project: Project) -> None:
    """The helper's "always re-read the flag" contract, pinned.

    Every other test archives through `_archive()`, which saves via the instance and
    leaves it fresh — so all of them would still pass if the helper were "optimized"
    into an in-memory fast path (`if isinstance(project, Project): return not
    project.is_archived`), which is a fail-open the docstring exists to forbid.
    `enqueue_template_apply` takes a `Project` by signature, so a caller cannot opt
    out of that shape.

    Archiving out of band leaves the in-memory row stale at `is_archived=False`,
    which is the state that tells the two apart.
    """
    from rest_framework.exceptions import PermissionDenied

    from trueppm_api.apps.access.permissions import assert_project_not_archived

    Project.objects.filter(pk=project.pk).update(is_archived=True)
    assert project.is_archived is False  # the instance never saw the write

    with pytest.raises(PermissionDenied):
        assert_project_not_archived(project)
