"""Project templates — publish, apply, undo (ADR-0789, #2729).

The assertions that matter most are the ones about what a template *refuses* to
carry, and about undo not eating typed work:

* ``test_extract_strips_moment_and_person`` — every field in that list is a live
  defect if carried, not a tidiness preference;
* ``test_undo_keeps_rows_a_person_has_touched`` — an undo that discards typed work
  to reverse a machine's write is unrecoverable, and the whole point of recording
  ``created_task_ids`` is that undo can be exact instead of a heuristic;
* ``test_apply_is_idempotent_under_redelivery`` — the claim is what stops a broker
  redelivery from seeding the same skeleton twice.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Dependency,
    Project,
    ProjectTemplate,
    Task,
    TemplateApplication,
    TemplateApplicationStatus,
    TemplateSource,
)
from trueppm_api.apps.projects.project_templates import (
    STRUCTURE_VERSION,
    TemplateStructureError,
    extract_structure,
    materialize_structure,
    validate_structure,
)
from trueppm_api.apps.projects.template_services import undo_template_application

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(username="pm", password="pw")


@pytest.fixture
def source_project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Source", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def target_project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Target", start_date=date(2026, 9, 1), calendar=calendar)


@pytest.fixture
def admin_client(owner: Any, source_project: Project, target_project: Project) -> APIClient:
    for project in (source_project, target_project):
        ProjectMembership.objects.create(project=project, user=owner, role=Role.ADMIN)
    client = APIClient()
    client.force_authenticate(user=owner)
    return client


def _shape(project: Project) -> list[Task]:
    """A two-phase skeleton with one dependency — enough shape to be worth templating."""
    a = Task.objects.create(project=project, name="Design", duration=5, wbs_path="1")
    b = Task.objects.create(project=project, name="Build", duration=10, wbs_path="2")
    Dependency.objects.create(predecessor=a, successor=b, dep_type="FS", lag=2)
    return [a, b]


# ---------------------------------------------------------------------------
# Extract — what a template carries, and what it must refuse to carry
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_extract_carries_shape(source_project: Project) -> None:
    _shape(source_project)
    structure = extract_structure(source_project)

    assert structure["version"] == STRUCTURE_VERSION
    assert [t["name"] for t in structure["tasks"]] == ["Design", "Build"]
    assert [t["duration"] for t in structure["tasks"]] == [5, 10]
    assert len(structure["dependencies"]) == 1
    assert structure["dependencies"][0]["lag"] == 2
    assert "dependencies" in structure["carries"]
    assert "durations" in structure["carries"]


@pytest.mark.django_db
def test_extract_strips_moment_and_person(source_project: Project, owner: Any) -> None:
    """Owners, dates and progress must never reach a template (ADR-0789 §1).

    Each of these is a live defect if carried, not noise: a user id from the
    publisher's workspace is unresolvable (or worse, resolvable to the wrong
    person) in the adopter's, and a template applied in November must not schedule
    to the publisher's March.
    """
    task = Task.objects.create(
        project=source_project,
        name="Design",
        duration=5,
        assignee=owner,
        planned_start=date(2026, 4, 1),
        actual_start=date(2026, 4, 2),
        percent_complete=40.0,
    )
    assert task.assignee_id is not None  # the source really does carry a person

    node = extract_structure(source_project)["tasks"][0]

    for stripped in (
        "assignee",
        "planned_start",
        "actual_start",
        "actual_finish",
        "early_start",
        "early_finish",
        "baseline_start",
        "baseline_finish",
        "percent_complete",
        "status",
    ):
        assert stripped not in node, f"{stripped} must never reach a template"


@pytest.mark.django_db
def test_extract_drops_edges_that_leave_the_project(
    source_project: Project, target_project: Project
) -> None:
    """A cross-project edge has no meaning in a template — the other project is not coming."""
    inside = Task.objects.create(project=source_project, name="Inside", duration=1)
    outside = Task.objects.create(project=target_project, name="Outside", duration=1)
    Dependency.objects.create(predecessor=inside, successor=outside, dep_type="FS")

    structure = extract_structure(source_project)
    assert structure["dependencies"] == []


# ---------------------------------------------------------------------------
# Validate — the apply-time gate on a JSONB column
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_validate_refuses_an_unknown_structure_version() -> None:
    with pytest.raises(TemplateStructureError, match="Unsupported structure version"):
        validate_structure({"version": 999, "tasks": []})


@pytest.mark.django_db
def test_validate_refuses_a_dangling_dependency() -> None:
    """A dangling edge would apply 'successfully' while silently dropping structure."""
    with pytest.raises(TemplateStructureError, match="not in this template"):
        validate_structure(
            {
                "version": STRUCTURE_VERSION,
                "tasks": [{"ref": "a", "name": "A"}],
                "dependencies": [{"predecessor": "a", "successor": "ghost"}],
            }
        )


# ---------------------------------------------------------------------------
# Materialize — shape lands, moment does not
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_materialize_writes_shape_without_dates(
    source_project: Project, target_project: Project, owner: Any
) -> None:
    _shape(source_project)
    template = ProjectTemplate.objects.create(
        name="Skeleton", structure=extract_structure(source_project), owner=owner
    )

    result = materialize_structure(template, target_project)

    assert len(result.task_ids) == 2
    assert result.milestones_created == 0
    assert result.dependencies_created == 1
    rows = Task.objects.filter(project=target_project).order_by("wbs_path")
    assert [r.name for r in rows] == ["Design", "Build"]
    assert [r.duration for r in rows] == [5, 10]
    # The adopter's schedule comes from their calendar via the CPM pass the caller
    # enqueues — never from the publisher's dates.
    assert all(r.planned_start is None for r in rows)
    assert all(r.assignee_id is None for r in rows)
    # The edge is relabelled onto the new rows, not left pointing at the source.
    edge = Dependency.objects.get(predecessor__project=target_project)
    assert edge.lag == 2
    assert edge.predecessor.name == "Design"
    assert edge.successor.name == "Build"


@pytest.mark.django_db
def test_materialized_rows_are_visible_to_the_sync_delta(
    source_project: Project, target_project: Project, owner: Any
) -> None:
    """bulk_create bypasses save(), so sync_seq must be stamped explicitly.

    A row left at ``sync_seq = 0`` sits below every checkpoint and is invisible to
    every offline client forever — and it fails completely silently, which is why
    it earns a test of its own.
    """
    _shape(source_project)
    template = ProjectTemplate.objects.create(
        name="Skeleton", structure=extract_structure(source_project), owner=owner
    )
    materialize_structure(template, target_project)

    for row in Task.objects.filter(project=target_project):
        assert row.sync_seq > 0
        assert row.server_version == 1


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_publish_then_apply_returns_202_and_an_application(
    admin_client: APIClient, source_project: Project, target_project: Project
) -> None:
    _shape(source_project)

    resp = admin_client.post(
        "/api/v1/project-templates/publish/",
        {"project": str(source_project.pk), "name": "Delivery skeleton"},
        format="json",
    )
    assert resp.status_code == 201, resp.data
    assert resp.data["task_count"] == 2
    template_id = resp.data["id"]

    resp = admin_client.post(
        f"/api/v1/project-templates/{template_id}/apply/",
        {"project": str(target_project.pk)},
        format="json",
    )
    # 202 with the application id, never a Celery task id: dispatch is best-effort
    # behind an outbox, so there may be no task id yet — or ever, for the delivery
    # the drain re-dispatches.
    assert resp.status_code == 202, resp.data
    assert resp.data["queued"] is True
    assert TemplateApplication.objects.filter(pk=resp.data["application"]).exists()


@pytest.mark.django_db
@pytest.mark.parametrize(
    "field", ["project", "name", "description"], ids=["project", "name", "description"]
)
def test_publish_refuses_a_non_string_field_with_a_400_not_a_500(
    admin_client: APIClient, source_project: Project, field: str
) -> None:
    """Type confusion on publish's raw body reads must fail closed (#2785).

    `publish` reads `project`, `name`, and `description` straight off `request.data`
    with no serializer, so a JSON list reached `.strip()` (AttributeError), slicing
    into the model field, or `UUIDField.to_python` — which raises Django's
    ValidationError, not the ValueError/TypeError the `Project.objects.get` guard
    catches, and not something DRF converts. All three were 500s.
    """
    body: dict[str, Any] = {"project": str(source_project.pk), "name": "Delivery skeleton"}
    body[field] = [None, None]

    resp = admin_client.post("/api/v1/project-templates/publish/", body, format="json")

    assert resp.status_code == 400, resp.data
    assert not ProjectTemplate.objects.exists()


@pytest.mark.django_db
def test_apply_is_admin_only(
    calendar: Calendar, source_project: Project, target_project: Project
) -> None:
    """ADR-0773's matrix already decided this: applying a template is Admin+."""
    _shape(source_project)
    template = ProjectTemplate.objects.create(
        name="Skeleton", structure=extract_structure(source_project)
    )
    member = User.objects.create_user(username="member", password="pw")
    ProjectMembership.objects.create(project=target_project, user=member, role=Role.MEMBER)
    client = APIClient()
    client.force_authenticate(user=member)

    resp = client.post(
        f"/api/v1/project-templates/{template.pk}/apply/",
        {"project": str(target_project.pk)},
        format="json",
    )
    assert resp.status_code == 403
    assert TemplateApplication.objects.count() == 0


@pytest.mark.django_db
def test_gallery_does_not_expose_the_structure_document(
    admin_client: APIClient, source_project: Project
) -> None:
    """A gallery reader is a wider audience than the source project's members."""
    _shape(source_project)
    ProjectTemplate.objects.create(name="Skeleton", structure=extract_structure(source_project))

    resp = admin_client.get("/api/v1/project-templates/")
    assert resp.status_code == 200
    row = resp.data["results"][0]
    assert "structure" not in row
    assert row["task_count"] == 2


@pytest.mark.django_db
def test_gallery_exposes_methodology_without_the_structure_document(
    admin_client: APIClient, source_project: Project
) -> None:
    """ADR-0791: the Start sheet derives its methodology line from this field.

    The gallery must carry the enum value the source project had at publish
    time — not the whole ``structure`` document ``carries`` already refuses to
    expose, and not the *current* value on the (possibly since-edited) source
    project.
    """
    source_project.methodology = "WATERFALL"
    source_project.save(update_fields=["methodology"])
    _shape(source_project)
    ProjectTemplate.objects.create(name="Skeleton", structure=extract_structure(source_project))

    resp = admin_client.get("/api/v1/project-templates/")
    assert resp.status_code == 200
    row = resp.data["results"][0]
    assert row["methodology"] == "WATERFALL"
    assert "structure" not in row

    # The source project changing later must not retroactively change what an
    # already-published template reports — the structure was frozen at publish.
    source_project.methodology = "AGILE"
    source_project.save(update_fields=["methodology"])
    resp = admin_client.get("/api/v1/project-templates/")
    assert resp.data["results"][0]["methodology"] == "WATERFALL"


@pytest.mark.django_db
def test_gallery_methodology_falls_back_to_hybrid_for_a_structure_missing_the_key(
    admin_client: APIClient, source_project: Project
) -> None:
    """A structure written before ADR-0791 (or edited outside ``publish``) has no
    ``methodology`` key — the gallery must degrade to the same lossless default
    ``methodology.DEFAULT_METHODOLOGY`` uses everywhere else, not error.
    """
    _shape(source_project)
    structure = extract_structure(source_project)
    del structure["methodology"]
    ProjectTemplate.objects.create(name="Skeleton", structure=structure)

    resp = admin_client.get("/api/v1/project-templates/")
    assert resp.status_code == 200
    assert resp.data["results"][0]["methodology"] == "HYBRID"


@pytest.mark.django_db
def test_personal_provenance_reads_yours_only_to_its_owner(
    admin_client: APIClient, owner: Any, source_project: Project, calendar: Calendar
) -> None:
    """The chip is stored, except *Yours*, which is genuinely relative to the reader."""
    _shape(source_project)
    ProjectTemplate.objects.create(
        name="Mine",
        structure=extract_structure(source_project),
        source_kind=TemplateSource.PERSONAL,
        owner=owner,
    )

    resp = admin_client.get("/api/v1/project-templates/")
    assert resp.data["results"][0]["provenance"] == "Yours"

    other = User.objects.create_user(username="other", password="pw")
    other_client = APIClient()
    other_client.force_authenticate(user=other)
    resp = other_client.get("/api/v1/project-templates/")
    assert resp.data["results"][0]["provenance"] != "Yours"


# ---------------------------------------------------------------------------
# Undo — exact, and never at the cost of typed work
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_undo_removes_exactly_what_the_application_wrote(
    source_project: Project, target_project: Project
) -> None:
    _shape(source_project)
    template = ProjectTemplate.objects.create(
        name="Skeleton", structure=extract_structure(source_project)
    )
    # A row that predates the application must survive the undo.
    pre_existing = Task.objects.create(project=target_project, name="Ours", duration=3)

    created = materialize_structure(template, target_project).task_ids
    application = TemplateApplication.objects.create(
        template=template,
        project=target_project,
        status=TemplateApplicationStatus.SUCCESS,
        created_task_ids=created,
    )

    summary = undo_template_application(application)

    assert summary["deleted"] == 2
    pre_existing.refresh_from_db()
    assert pre_existing.is_deleted is False
    assert Task.objects.filter(project=target_project, is_deleted=False).count() == 1


@pytest.mark.django_db
def test_undo_keeps_rows_a_person_has_touched(
    source_project: Project, target_project: Project
) -> None:
    """Undo must not discard typed work to reverse a machine's write.

    The asymmetry is the same one ADR-0786 §4 is organized around: leaving a row
    behind is disappointing, deleting a sentence somebody wrote is not recoverable.
    Whoever undoes a template five minutes after a teammate started filling it in
    must not take the teammate's work with them.
    """
    _shape(source_project)
    template = ProjectTemplate.objects.create(
        name="Skeleton", structure=extract_structure(source_project)
    )
    created = materialize_structure(template, target_project).task_ids
    application = TemplateApplication.objects.create(
        template=template,
        project=target_project,
        status=TemplateApplicationStatus.SUCCESS,
        created_task_ids=created,
    )

    touched = Task.objects.get(pk=created[0])
    touched.name = "Design — our actual scope"
    touched.save()

    summary = undo_template_application(application)

    assert summary["deleted"] == 1
    assert summary["kept"] == 1
    touched.refresh_from_db()
    assert touched.is_deleted is False
    assert touched.name == "Design — our actual scope"


@pytest.mark.django_db
def test_undo_endpoint_refuses_an_application_that_never_succeeded(
    admin_client: APIClient, target_project: Project
) -> None:
    """A caller asked to reverse something; a silent no-op would not tell them it didn't happen."""
    application = TemplateApplication.objects.create(
        project=target_project, status=TemplateApplicationStatus.PENDING
    )
    resp = admin_client.post(
        f"/api/v1/template-applications/{application.pk}/undo/", {}, format="json"
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# The Celery task — the claim is what makes redelivery safe
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_apply_is_idempotent_under_redelivery(
    source_project: Project, target_project: Project
) -> None:
    """A second delivery must find nothing to claim and seed nothing.

    Without the claim, a drain re-dispatch after a worker-death window (or an
    ``acks_late`` replay of an already-completed message) would write the whole
    skeleton a second time into a project that already has it.
    """
    from trueppm_api.apps.projects.template_tasks import apply_template

    _shape(source_project)
    template = ProjectTemplate.objects.create(
        name="Skeleton", structure=extract_structure(source_project)
    )
    application = TemplateApplication.objects.create(template=template, project=target_project)

    first = apply_template.apply(args=[str(application.pk)]).get()
    second = apply_template.apply(args=[str(application.pk)]).get()

    assert first["tasks_created"] == 2
    assert second.get("skipped") is True
    assert Task.objects.filter(project=target_project, is_deleted=False).count() == 2


@pytest.mark.django_db(transaction=True)
def test_apply_records_milestone_and_dependency_counts_for_the_seed_banner(
    source_project: Project, target_project: Project
) -> None:
    """result_summary carries the breakdown the seed banner reads (#2731, ADR-0799 §2).

    Read straight off what materialize_structure already built, never re-derived by a
    second query — a milestone task plus the one FS edge from ``_shape`` gives an
    unambiguous, non-zero expectation for both new keys.
    """
    from trueppm_api.apps.projects.template_tasks import apply_template

    _shape(source_project)
    milestone = Task.objects.create(project=source_project, name="Ship", is_milestone=True)
    Dependency.objects.create(
        predecessor=Task.objects.get(project=source_project, name="Build"),
        successor=milestone,
        dep_type="FS",
    )
    template = ProjectTemplate.objects.create(
        name="Skeleton", structure=extract_structure(source_project)
    )
    application = TemplateApplication.objects.create(template=template, project=target_project)

    apply_template.apply(args=[str(application.pk)]).get()

    application.refresh_from_db()
    assert application.result_summary == {
        "tasks_created": 3,
        "milestones_created": 1,
        "dependencies_created": 2,
    }


@pytest.mark.django_db(transaction=True)
def test_apply_records_a_failure_rather_than_hanging_at_running(
    target_project: Project,
) -> None:
    """A structure we cannot read is terminal, not retryable — the user needs the message now."""
    from trueppm_api.apps.projects.template_tasks import apply_template

    template = ProjectTemplate.objects.create(
        name="Broken", structure={"version": 999, "tasks": []}
    )
    application = TemplateApplication.objects.create(template=template, project=target_project)

    result = apply_template.apply(args=[str(application.pk)]).get()

    assert result["failed"] is True
    application.refresh_from_db()
    assert application.status == TemplateApplicationStatus.FAILED
    assert "Unsupported structure version" in application.error_detail


@pytest.mark.django_db
def test_templates_cannot_be_minted_or_renamed_outside_publish(
    admin_client: APIClient, source_project: Project
) -> None:
    """Publish is the only door — and it is the door that runs the extraction.

    A ``ModelViewSet`` here would inherit create/update/destroy under the class's
    ``IsAuthenticated``, which is the wrong gate for all three: any authenticated
    user could mint an empty template, or rename and delete somebody else's. This
    test is the tripwire for that regression, because the hole is invisible in a
    diff — it comes from the base class, not from a line anyone wrote.
    """
    _shape(source_project)
    template = ProjectTemplate.objects.create(
        name="Skeleton", structure=extract_structure(source_project)
    )

    assert admin_client.post(
        "/api/v1/project-templates/", {"name": "Minted"}, format="json"
    ).status_code in (403, 405)
    assert admin_client.patch(
        f"/api/v1/project-templates/{template.pk}/", {"name": "Renamed"}, format="json"
    ).status_code in (403, 405)
    assert admin_client.delete(f"/api/v1/project-templates/{template.pk}/").status_code in (
        403,
        405,
    )

    template.refresh_from_db()
    assert template.name == "Skeleton"
