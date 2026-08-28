"""The refusal vocabulary is a closed set, and the schema publishes it (#3037).

Two facets, both about the same thing: an integrator building against
``POST /projects/{id}/tasks/bulk/`` should be able to write correct retry/skip logic
from the published OpenAPI schema alone, without opening ``task_bulk.py``.

**A** — ``code`` was declared ``"type": "string"`` with no ``enum``, so a generated
client typed it ``str`` and the closed set of codes was only discoverable in Python
source. The drift test below is the part that has to keep working: an enum published
once and then left behind by a new code is worse than no enum, because a client that
trusted it now silently mis-handles a refusal it was told could not happen.

**B** — one request carries two permission floors. Task rows gate at the view;
dependency edges gate per-edge at ``IsProjectScheduler`` inside the apply loop. The
gap was only discoverable by submitting a batch with edges and reading
``dependencies.rejected`` — every batch, until the caller noticed the pattern.
"""

from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project
from trueppm_api.apps.projects.refusal_codes import (
    CAPABILITY_DEPENDENCIES,
    BulkRefusalCode,
    StructuralUndoBlockedReason,
)

URL = "/api/v1/projects/{pk}/tasks/bulk/"


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P", start_date="2026-01-05", calendar=calendar)


def _client(project: Project, username: str, role: int) -> APIClient:
    user = get_user_model().objects.create_user(username=username, password="x")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


# ---------------------------------------------------------------------------
# A — the published enum, and the drift guard that keeps it published
# ---------------------------------------------------------------------------


def _schema() -> dict:
    from drf_spectacular.generators import SchemaGenerator

    return SchemaGenerator().get_schema(request=None, public=True)


def _published_enum(schema: dict, component: str, field: str) -> set[str]:
    """The enum values a client actually sees for ``component.field``.

    drf-spectacular emits a pinned enum as ``{"allOf": [{"$ref": "…Enum"}]}`` rather
    than inlining the values, which is the shape we want — a named component is the
    handle a generated client's types carry, and it stays stable when an unrelated
    field's choices change. It does mean "is there an enum" has to follow the ref
    instead of looking for an ``enum`` key in place.
    """
    schemas = schema["components"]["schemas"]
    prop = schemas[component]["properties"][field]

    refs = []
    if "$ref" in prop:
        refs.append(prop["$ref"])
    for key in ("allOf", "oneOf"):
        refs.extend(m["$ref"] for m in prop.get(key, []) if "$ref" in m)

    assert refs, (
        f"{component}.{field} resolves to no enum component — a generated client "
        f"types it `str` and cannot distinguish a retryable refusal from a permanent "
        f"one. Got: {prop}"
    )
    # Union across every ref, not just the first. A choice set containing the empty
    # string is split by drf-spectacular into the named enum PLUS the shared
    # `BlankEnum`, joined by `oneOf` — so a caller (or a test) that reads only the
    # first ref sees a set that is missing "" and concludes the common case is
    # unpublished. It is published; it is in the other arm.
    values: set[str] = set()
    for ref in refs:
        values |= set(schemas[ref.rsplit("/", 1)[-1]]["enum"])
    return values


@pytest.mark.django_db
def test_every_bulk_refusal_code_reaches_the_published_schema() -> None:
    """The acceptance criterion that stops this from re-rotting.

    Adding a member to ``BulkRefusalCode`` without regenerating the schema fails
    here, and adding a bare string literal at a call site fails the source test
    below. Between them there is no way to put a code on the wire that the schema
    does not publish — which is the state #3037 found the endpoint in.
    """
    schema = _schema()
    published = _published_enum(schema, "TaskBulkProblemEntry", "code")
    assert published == {c.value for c in BulkRefusalCode}
    # The pinned component name is part of the contract: it is what a generated
    # client's type is called, so letting drf-spectacular derive (and later rename)
    # it would break the very clients this enum exists to serve.
    assert "TaskBulkRefusalCodeEnum" in schema["components"]["schemas"]


@pytest.mark.django_db
def test_every_structural_undo_reason_reaches_the_published_schema() -> None:
    """The undo/structural refusals are enumerated on their own response schema.

    A separate set from the bulk codes on purpose — publishing one union would tell
    each caller that codes their endpoint cannot emit are possible, which is the same
    defect as publishing none, pointing the other way.
    """
    schema = _schema()
    published = _published_enum(schema, "StructuralOperation", "undo_blocked_reason")
    assert published == {r.value for r in StructuralUndoBlockedReason}
    assert "" in published, (
        'The empty string means "undoable" and is the value a client sees most often; '
        "omitting it publishes a set that excludes the common case."
    )
    assert "StructuralUndoBlockedReasonEnum" in schema["components"]["schemas"]


def test_the_refusal_codes_have_exactly_one_definition_site() -> None:
    """A grep for a bare code literal outside ``refusal_codes.py`` returns nothing.

    This is the half the schema test cannot cover. #3037 named two modules holding
    the vocabulary; a third (`task_classification`) held a hand-maintained mirror of
    ``milestone_gate`` whose own comment asserted it matched ``task_bulk`` — an
    assertion nothing checked and nothing would have failed if it had drifted.

    Scoped to the modules that emit onto these two surfaces. ``graph_guard``'s
    ``self_reference``/``cyclic_dependency`` are an *upstream* reason that
    ``task_bulk`` maps into a code, and ``poker_services``' ``not_found`` is a
    different endpoint's vocabulary that happens to share a word — neither is on
    these surfaces, and folding them in would make the guard a rename hazard rather
    than a contract.
    """
    from pathlib import Path

    src = Path(__file__).resolve().parents[3] / "src" / "trueppm_api" / "apps" / "projects"
    emitters = [
        "task_bulk.py",
        "task_classification.py",
        "structural_operation_services.py",
        "structural_operation_views.py",
    ]
    values = {c.value for c in BulkRefusalCode} | {
        r.value for r in StructuralUndoBlockedReason if r.value
    }

    offenders = []
    for name in emitters:
        text = (src / name).read_text(encoding="utf-8")
        for line_no, line in enumerate(text.splitlines(), 1):
            stripped = line.strip()
            if stripped.startswith("#") or stripped.startswith("#:"):
                continue  # prose naming a code is fine; only executable literals count
            if "exc.reason" in stripped:
                # `InfeasibleGraphError.reason` is the SCHEDULER's vocabulary
                # (`graph_guard.py`), not a wire code. `task_bulk` reads it and maps it
                # INTO `BulkRefusalCode`; the two namespaces share two words and
                # nothing else. Binding this comparison to the wire enum would assert a
                # coupling that does not exist and would silently break if either side
                # renamed independently — which is the whole reason they are separate.
                continue
            for value in values:
                if f'"{value}"' in line or f"'{value}'" in line:
                    offenders.append(f"{name}:{line_no}: {stripped}")

    assert not offenders, (
        "Refusal codes must come from `refusal_codes`, not a bare literal:\n" + "\n".join(offenders)
    )


# ---------------------------------------------------------------------------
# B — the second permission floor, declared before the batch rather than inside it
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_a_member_batch_with_edges_is_told_the_capability_is_denied(project: Project) -> None:
    """The finding: rows applied, edges rejected, and nothing said the gap was structural.

    A Member submitting rows and edges got a 207 with every row in ``applied`` and
    every edge in ``dependencies.rejected`` — indistinguishable, from one response,
    from N edges that each happened to be individually bad. ``capabilities_denied``
    states it once.
    """
    client = _client(project, "member_caps", Role.MEMBER)
    a, b = str(uuid.uuid4()), str(uuid.uuid4())
    r = client.post(
        URL.format(pk=project.pk),
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
    assert len(r.data["applied"]) == 2, "task rows still apply — this is a partial success"
    assert r.data["capabilities_denied"] == [CAPABILITY_DEPENDENCIES]
    # The per-edge rejections stay: the top-level statement explains them, it does
    # not replace them, and a client already parsing `dependencies` keeps working.
    assert [e["code"] for e in r.data["dependencies"]["rejected"]] == [
        BulkRefusalCode.FORBIDDEN.value
    ]


@pytest.mark.django_db
def test_an_admin_batch_with_edges_denies_no_capability(project: Project) -> None:
    """The field is about the caller's floor, not about whether edges succeeded.

    **Admin, not Scheduler.** The edge check inside the apply loop names
    ``Role.SCHEDULER``, but ``IsProjectPlanAuthor`` (ADR-0773) excludes the
    resource-management band from this endpoint entirely — so a Scheduler-role token
    gets a flat 403 and never reaches the per-edge gate that its own role name
    appears in. The lowest role that can actually write an edge here is Admin. This
    is why the endpoint description spells the floors out by role rather than
    repeating "requires Scheduler", which would send an integrator to provision
    exactly the one role that cannot use the endpoint.
    """
    client = _client(project, "admin_caps", Role.ADMIN)
    a, b = str(uuid.uuid4()), str(uuid.uuid4())
    r = client.post(
        URL.format(pk=project.pk),
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
    assert r.data["capabilities_denied"] == []


@pytest.mark.django_db
def test_a_member_batch_with_no_edges_denies_no_capability(project: Project) -> None:
    """Empty when the request never asked for the capability.

    Reporting the Member's *latent* inability to write edges on every batch would
    make the field noise, and a client would learn to ignore it — the failure mode
    that produced this issue, one layer up.
    """
    client = _client(project, "member_noedges", Role.MEMBER)
    r = client.post(
        URL.format(pk=project.pk),
        {"operations": [{"op": "create", "data": {"name": "A", "duration": 1}}]},
        format="json",
    )
    assert r.status_code == 207, r.data
    assert r.data["capabilities_denied"] == []


@pytest.mark.django_db
def test_the_endpoint_description_states_both_permission_floors() -> None:
    """The docs half of facet B — the floor is discoverable without submitting a batch."""
    schema = _schema()
    description = schema["paths"]["/api/v1/projects/{id}/tasks/bulk/"]["post"]["description"]
    assert "Scheduler" in description
    assert "capabilities_denied" in description
