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
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.permissions import role_can_undo_batch_operation
from trueppm_api.apps.projects.models import (
    Calendar,
    Dependency,
    Program,
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
from trueppm_api.apps.workspace.models import AuditEvent

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
    # Scoped to what *this request* would have written, not to an empty table:
    # #2909 seeds bundled starters, so a bare `.exists()` here stopped meaning
    # "the refusal wrote nothing" and started meaning "the table is empty".
    assert not ProjectTemplate.objects.filter(source_project=source_project).exists()


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


# ---------------------------------------------------------------------------
# #2909 — the way in was empty, and the screen its empty state named did not exist
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestBundledStarters:
    """Every fresh install now has something in the Template way-in.

    Before this, the only row-creation site was the publish action and no publish
    UI existed, so the gallery was empty on every install and its empty state
    pointed at a screen nobody had built.
    """

    def test_one_starter_ships_per_methodology(self) -> None:
        # Whichever way in a new team picks, the gallery has something for it.
        bundled = ProjectTemplate.objects.filter(source_kind=TemplateSource.COMMUNITY)
        assert bundled.count() == 3
        assert {t.structure["methodology"] for t in bundled} == {"AGILE", "WATERFALL", "HYBRID"}

    def test_every_starter_is_a_document_apply_would_accept(self) -> None:
        """A starter that fails validation is worse than no starter: it is a
        way in that visibly exists and cannot be walked."""
        for template in ProjectTemplate.objects.filter(source_kind=TemplateSource.COMMUNITY):
            validate_structure(template.structure)

    def test_starters_claim_no_publisher(self) -> None:
        """Nobody in this workspace published them, and a name on the provenance
        line that means nothing to the reader is worse than no name."""
        for template in ProjectTemplate.objects.filter(source_kind=TemplateSource.COMMUNITY):
            assert template.owner_id is None
            assert template.published_by_id is None
            assert template.source_project_id is None

    def test_the_gallery_sorts_bundled_last(self, admin_client: APIClient) -> None:
        """On a workspace with its own published shapes, those are read first."""
        ProjectTemplate.objects.create(
            name="Aardvark local shape",
            source_kind=TemplateSource.WORKSPACE,
            structure={"version": STRUCTURE_VERSION, "tasks": [], "methodology": "AGILE"},
        )
        rows = admin_client.get("/api/v1/project-templates/").data["results"]
        kinds = [r["source_kind"] for r in rows]
        # Not merely "workspace is present" — every community row after every
        # non-community one, which alphabetical ordering alone would not give.
        assert kinds == sorted(kinds, key=lambda k: k == "community")
        assert kinds[0] == "workspace"


@pytest.mark.django_db
class TestPublishPreview:
    """The dry run behind the Settings page's six counts and the confirm step."""

    def test_counts_come_from_the_same_extraction_publish_runs(
        self, admin_client: APIClient, source_project: Project
    ) -> None:
        _shape(source_project)
        resp = admin_client.get(
            "/api/v1/project-templates/publish-preview/", {"project": str(source_project.pk)}
        )
        assert resp.status_code == 200
        assert resp.data["task_count"] == 2
        assert resp.data["dependency_count"] == 1
        assert "durations" in resp.data["carries"]

    def test_phases_and_gates_are_counted_off_the_document(
        self, admin_client: APIClient, source_project: Project
    ) -> None:
        """A phase is a node with structural descendants; a gate is a gated milestone."""
        Task.objects.create(project=source_project, name="Initiate", duration=5, wbs_path="1")
        Task.objects.create(project=source_project, name="Charter", duration=5, wbs_path="1.1")
        Task.objects.create(
            project=source_project,
            name="Gate 1",
            duration=0,
            wbs_path="1.2",
            is_milestone=True,
            governance_class="gated",
        )
        resp = admin_client.get(
            "/api/v1/project-templates/publish-preview/", {"project": str(source_project.pk)}
        )
        assert resp.data["phase_count"] == 1
        assert resp.data["gate_count"] == 1
        assert resp.data["milestone_count"] == 1

    def test_it_reports_a_taken_name_before_the_form_is_filled_in(
        self, admin_client: APIClient, source_project: Project
    ) -> None:
        _shape(source_project)
        ProjectTemplate.objects.create(
            name="Delivery skeleton",
            version=2,
            structure={"version": STRUCTURE_VERSION, "tasks": []},
        )
        resp = admin_client.get(
            "/api/v1/project-templates/publish-preview/",
            {"project": str(source_project.pk), "name": "Delivery skeleton"},
        )
        assert resp.data["name_taken"] is True
        assert resp.data["next_version"] == 3

    def test_it_writes_nothing(self, admin_client: APIClient, source_project: Project) -> None:
        _shape(source_project)
        before = ProjectTemplate.objects.count()
        admin_client.get(
            "/api/v1/project-templates/publish-preview/", {"project": str(source_project.pk)}
        )
        assert ProjectTemplate.objects.count() == before

    def test_it_is_admin_only(self, source_project: Project, owner: Any) -> None:
        member = User.objects.create_user(username="member", password="pw")
        ProjectMembership.objects.create(project=source_project, user=member, role=Role.MEMBER)
        client = APIClient()
        client.force_authenticate(user=member)
        resp = client.get(
            "/api/v1/project-templates/publish-preview/", {"project": str(source_project.pk)}
        )
        assert resp.status_code == 403

    def test_a_junk_project_id_is_a_400_not_a_500(self, admin_client: APIClient) -> None:
        """`UUIDField.to_python` raises Django's ValidationError, which DRF does
        not convert — the #2785 class, on a new query parameter."""
        resp = admin_client.get(
            "/api/v1/project-templates/publish-preview/", {"project": "not-a-uuid"}
        )
        assert resp.status_code == 400


@pytest.mark.django_db
class TestRepublishVersioning:
    """Republishing writes a new version and leaves the old one selectable.

    The projects already created from v1 are the only audit trail a PMO has for
    why they look the way they do; a version edited under them makes that a lie.
    """

    def _publish(self, client: APIClient, project: Project, **extra: Any) -> Any:
        return client.post(
            "/api/v1/project-templates/publish/",
            {"project": str(project.pk), "name": "Delivery skeleton", **extra},
            format="json",
        )

    def test_a_taken_name_is_a_409_offering_the_next_version(
        self, admin_client: APIClient, source_project: Project
    ) -> None:
        _shape(source_project)
        assert self._publish(admin_client, source_project).status_code == 201
        resp = self._publish(admin_client, source_project)
        assert resp.status_code == 409
        assert resp.data["code"] == "name_taken"
        # The form's recovery is "publish as v2 instead", so the number is in the body.
        assert resp.data["next_version"] == 2

    def test_republishing_writes_a_new_row_and_keeps_the_old_one(
        self, admin_client: APIClient, source_project: Project
    ) -> None:
        _shape(source_project)
        first = self._publish(admin_client, source_project).data
        second = self._publish(admin_client, source_project, new_version=True).data

        assert second["version"] == 2
        assert str(second["supersedes"]) == str(first["id"])
        assert second["id"] != first["id"]
        # v1 is still there and still selectable — that is the point.
        assert ProjectTemplate.objects.filter(pk=first["id"], is_published=True).exists()

    def test_the_superseded_version_says_so(
        self, admin_client: APIClient, source_project: Project
    ) -> None:
        _shape(source_project)
        first = self._publish(admin_client, source_project).data
        self._publish(admin_client, source_project, new_version=True)

        rows = {
            str(r["id"]): r for r in admin_client.get("/api/v1/project-templates/").data["results"]
        }
        assert rows[str(first["id"])]["is_superseded"] is True

    def test_publish_records_the_project_it_was_frozen_from(
        self, admin_client: APIClient, source_project: Project
    ) -> None:
        _shape(source_project)
        data = self._publish(admin_client, source_project).data
        assert str(data["source_project"]) == str(source_project.pk)
        assert data["source_project_name"] == "Source"

    def test_deleting_the_source_project_does_not_take_the_template(
        self, admin_client: APIClient, source_project: Project
    ) -> None:
        """SET_NULL, not CASCADE: the structure is frozen, so a lost source is a
        dropped provenance line and never a broken template."""
        _shape(source_project)
        data = self._publish(admin_client, source_project).data
        # Memberships PROTECT the project, so clear them first — the thing under
        # test is the template FK's on_delete, not the membership FK's.
        ProjectMembership.objects.filter(project=source_project).delete()
        source_project.delete()

        template = ProjectTemplate.objects.get(pk=data["id"])
        assert template.source_project_id is None
        assert template.structure["tasks"]

    def test_a_non_string_new_version_flag_is_not_a_500(
        self, admin_client: APIClient, source_project: Project
    ) -> None:
        """The #2795 container-type class on the one new raw-body read."""
        _shape(source_project)
        self._publish(admin_client, source_project)
        resp = self._publish(admin_client, source_project, new_version=[1, 2])
        assert resp.status_code == 409


@pytest.mark.django_db
class TestProgramScopedUniqueness:
    """A name collision is only a collision inside a pool the publisher can see (#3309).

    ``ProjectTemplateViewSet.get_queryset`` narrows a program's gallery to that
    program's templates plus the workspace-wide ones. Publishing used to look a
    name up across the whole workspace, so two programs sharing a template name —
    the ordinary shape for a PMO running several programs — collided in two
    user-visible ways: a ``superseded`` chip on a card whose cause the owner
    cannot see, and a 409 disclosing the name and version of a template the
    caller has no access to.
    """

    def _publish(self, client: APIClient, project: Project, **extra: Any) -> Any:
        return client.post(
            "/api/v1/project-templates/publish/",
            {"project": str(project.pk), "name": "Delivery skeleton", **extra},
            format="json",
        )

    @pytest.fixture
    def two_programs(self, calendar: Calendar, owner: Any) -> tuple[Project, Project, APIClient]:
        """One workspace, two programs, one Admin on a project in each."""
        a = Project.objects.create(
            name="A1",
            start_date=date(2026, 4, 1),
            calendar=calendar,
            program=Program.objects.create(name="Program A"),
        )
        b = Project.objects.create(
            name="B1",
            start_date=date(2026, 4, 1),
            calendar=calendar,
            program=Program.objects.create(name="Program B"),
        )
        for project in (a, b):
            ProjectMembership.objects.create(project=project, user=owner, role=Role.ADMIN)
            _shape(project)
        client = APIClient()
        client.force_authenticate(user=owner)
        return a, b, client

    def test_a_sibling_programs_template_is_not_a_name_collision(
        self, two_programs: tuple[Project, Project, APIClient]
    ) -> None:
        """No 409, so nothing about A's template leaks into B's rejection."""
        a, b, client = two_programs
        assert self._publish(client, a).status_code == 201

        resp = self._publish(client, b)

        assert resp.status_code == 201, resp.data
        assert resp.data["version"] == 1
        assert resp.data["supersedes"] is None

    def test_republishing_in_one_program_never_supersedes_a_siblings_template(
        self, two_programs: tuple[Project, Project, APIClient]
    ) -> None:
        """The chip A's PM sees must never be caused by a row A cannot see."""
        a, b, client = two_programs
        first_a = self._publish(client, a).data
        self._publish(client, b)

        second_b = self._publish(client, b, new_version=True).data

        assert second_b["version"] == 2
        assert str(second_b["supersedes"]) != str(first_a["id"])
        assert ProjectTemplate.objects.get(pk=first_a["id"]).superseded_by.exists() is False
        # And the gallery A actually renders agrees.
        rows = {
            str(r["id"]): r
            for r in client.get("/api/v1/project-templates/", {"program": str(a.program_id)}).data[
                "results"
            ]
        }
        assert rows[str(first_a["id"])]["is_superseded"] is False

    def test_a_program_still_supersedes_its_own_earlier_version(
        self, two_programs: tuple[Project, Project, APIClient]
    ) -> None:
        """The scoping must not cost a program its own version chain."""
        a, _b, client = two_programs
        first = self._publish(client, a).data

        conflict = self._publish(client, a)
        assert conflict.status_code == 409
        assert conflict.data["next_version"] == 2

        second = self._publish(client, a, new_version=True).data
        assert second["version"] == 2
        assert str(second["supersedes"]) == str(first["id"])

    def test_a_program_extends_its_own_chain_over_a_higher_workspace_wide_version(
        self, two_programs: tuple[Project, Project, APIClient]
    ) -> None:
        """Own-pool rows outrank shared ones, so the chain cannot fork on version alone."""
        a, _b, client = two_programs
        own = self._publish(client, a).data
        # A workspace-wide row of the same name, at a HIGHER version than A's own.
        shared = ProjectTemplate.objects.create(
            name="Delivery skeleton", program=None, version=7, structure={}, is_published=True
        )

        second = self._publish(client, a, new_version=True).data

        assert str(second["supersedes"]) == str(own["id"])
        assert ProjectTemplate.objects.get(pk=shared.pk).superseded_by.exists() is False


class TestUsageCount:
    """ "12 projects" is the PMO's only evidence that a shape is the house standard."""

    def _template(self) -> ProjectTemplate:
        return ProjectTemplate.objects.create(
            name="Counted", structure={"version": STRUCTURE_VERSION, "tasks": []}
        )

    def test_it_counts_successful_adoptions(
        self, admin_client: APIClient, target_project: Project
    ) -> None:
        template = self._template()
        TemplateApplication.objects.create(
            template=template,
            project=target_project,
            template_name=template.name,
            status=TemplateApplicationStatus.SUCCESS,
        )
        rows = {
            str(r["id"]): r for r in admin_client.get("/api/v1/project-templates/").data["results"]
        }
        assert rows[str(template.pk)]["usage_count"] == 1

    def test_an_undone_adoption_does_not_count(
        self, admin_client: APIClient, target_project: Project
    ) -> None:
        """A template whose seeding was reversed was not adopted, and counting it
        would overstate the standard it is supposed to be evidence of."""
        template = self._template()
        TemplateApplication.objects.create(
            template=template,
            project=target_project,
            template_name=template.name,
            status=TemplateApplicationStatus.SUCCESS,
            undone_at=timezone.now(),
        )
        rows = {
            str(r["id"]): r for r in admin_client.get("/api/v1/project-templates/").data["results"]
        }
        assert rows[str(template.pk)]["usage_count"] == 0


@pytest.mark.django_db
class TestPublishIsAudited:
    """Publishing is a workspace-visible disclosure act, and must be legible after.

    It takes one project's shape — task names included — and makes it readable by
    everyone in the workspace, a wider audience than the source project's own
    members. Republishing additionally changes what the house shape resolves to
    for every future adopter. Found by the `ai-review` gate: both were Admin-gated
    and neither left a trace.
    """

    def _publish(self, client: APIClient, project: Project, **extra: Any) -> Any:
        return client.post(
            "/api/v1/project-templates/publish/",
            {"project": str(project.pk), "name": "Audited shape", **extra},
            format="json",
        )

    def test_a_publish_writes_an_audit_event(
        self, admin_client: APIClient, source_project: Project
    ) -> None:
        _shape(source_project)
        self._publish(admin_client, source_project)

        event = AuditEvent.objects.get(event_type="template_published")
        assert event.target_label == "Audited shape v1"
        assert event.metadata["version"] == 1
        assert event.metadata["source_project"] == str(source_project.pk)
        assert event.metadata["supersedes"] is None

    def test_a_republish_records_what_it_superseded(
        self, admin_client: APIClient, source_project: Project
    ) -> None:
        _shape(source_project)
        first = self._publish(admin_client, source_project).data
        self._publish(admin_client, source_project, new_version=True)

        event = AuditEvent.objects.get(event_type="template_published", target_label__endswith="v2")
        assert event.metadata["supersedes"] == str(first["id"])

    def test_a_refused_publish_leaves_no_audit_entry(
        self, admin_client: APIClient, source_project: Project
    ) -> None:
        """The log must never claim a publish that did not happen — a 409 writes
        no template, so it writes no event either."""
        _shape(source_project)
        self._publish(admin_client, source_project)
        assert self._publish(admin_client, source_project).status_code == 409
        assert AuditEvent.objects.filter(event_type="template_published").count() == 1


# ---------------------------------------------------------------------------
# Seeded WBS paths must not land on rows that are already there (#3061)
# ---------------------------------------------------------------------------


def _doc(*paths: str) -> dict[str, Any]:
    """A structure document whose nodes sit at exactly ``paths``."""
    return {
        "version": STRUCTURE_VERSION,
        "methodology": "HYBRID",
        "carries": ["structure"],
        "tasks": [
            {
                "ref": f"t{i}",
                "name": f"Node {path}",
                "duration": 3,
                "wbs_path": path,
                "parent": None,
                "is_milestone": False,
                "type": "waterfall",
            }
            for i, path in enumerate(paths)
        ],
    }


def _live_paths(project: Project) -> list[str]:
    return sorted(
        str(p)
        for p in Task.objects.filter(project=project, is_deleted=False).values_list(
            "wbs_path", flat=True
        )
        if p is not None
    )


@pytest.mark.django_db
def test_first_adoption_keeps_the_documents_paths_verbatim(target_project: Project) -> None:
    """An empty project shifts by nothing — the offset must not perturb the common case."""
    template = ProjectTemplate.objects.create(name="Skeleton", structure=_doc("1", "1.1", "2"))

    materialize_structure(template, target_project)

    assert _live_paths(target_project) == ["1", "1.1", "2"]


@pytest.mark.django_db
def test_second_adoption_appends_past_the_rows_already_there(target_project: Project) -> None:
    """Template paths are relative to a fresh project, so a second adoption must shift.

    Writing them verbatim put two live tasks on one ``wbs_path``, which corrupts the
    next ``rewrite_level`` pass rather than raising anywhere (#3061, #3048).
    """
    first = ProjectTemplate.objects.create(name="Skeleton", structure=_doc("1", "1.1", "2"))
    second = ProjectTemplate.objects.create(name="Overlay", structure=_doc("1", "2"))

    materialize_structure(first, target_project)
    materialize_structure(second, target_project)

    assert _live_paths(target_project) == ["1", "1.1", "2", "3", "4"]


@pytest.mark.django_db
def test_adoption_shifts_a_whole_subtree_not_just_its_root(target_project: Project) -> None:
    """Only the leading segment moves, so the document's tree shape survives intact."""
    Task.objects.create(project=target_project, name="Ours", duration=2, wbs_path="1")
    template = ProjectTemplate.objects.create(name="Overlay", structure=_doc("1", "1.1", "1.1.2"))

    materialize_structure(template, target_project)

    assert _live_paths(target_project) == ["1", "2", "2.1", "2.1.2"]


@pytest.mark.django_db
def test_adoption_offsets_past_hand_typed_rows_not_just_seeded_ones(
    target_project: Project,
) -> None:
    """The offset reads the project's live rows, whatever wrote them."""
    Task.objects.create(project=target_project, name="Ours", duration=2, wbs_path="4")
    template = ProjectTemplate.objects.create(name="Overlay", structure=_doc("1", "2"))

    materialize_structure(template, target_project)

    assert _live_paths(target_project) == ["4", "5", "6"]


@pytest.mark.django_db
def test_a_soft_deleted_row_does_not_push_the_offset_up(target_project: Project) -> None:
    """Tombstones are excluded from the uniqueness constraint, so they must not shift it."""
    tombstone = Task.objects.create(project=target_project, name="Gone", duration=2, wbs_path="7")
    tombstone.soft_delete()
    template = ProjectTemplate.objects.create(name="Overlay", structure=_doc("1", "2"))

    materialize_structure(template, target_project)

    assert _live_paths(target_project) == ["1", "2"]


# ---------------------------------------------------------------------------
# Archived-project floor (#3354)
#
# Found by sweeping the family after #3354: `TemplateApplicationViewSet` had the
# same gap as the two `batch_operation_views` ledgers — which were written to
# mirror this viewset and inherited its omission. `apply` is the forward half and
# the larger write of the two: it seeds a whole skeleton, and it resolves its
# target project from the request *body*, which is why `IsProjectNotArchived`
# cannot see it and the check has to be explicit.
# ---------------------------------------------------------------------------


def _archive(project: Project) -> None:
    project.is_archived = True
    project.save(update_fields=["is_archived"])


@pytest.mark.django_db
def test_apply_is_refused_when_the_target_project_is_archived(
    admin_client: APIClient, source_project: Project, target_project: Project
) -> None:
    _shape(source_project)
    template = ProjectTemplate.objects.create(
        name="Skeleton", structure=extract_structure(source_project)
    )
    _archive(target_project)

    resp = admin_client.post(
        f"/api/v1/project-templates/{template.pk}/apply/",
        {"project": str(target_project.pk)},
        format="json",
    )

    assert resp.status_code == 403, resp.data
    # The helper claims it reuses `IsProjectNotArchived.message` verbatim so the
    # contract is identical whichever layer refuses, and docs/api/reference.md now
    # publishes that. This route is one of only two where the body comes from the
    # helper rather than the permission class, so nothing else pins it.
    from trueppm_api.apps.access.permissions import IsProjectNotArchived

    assert resp.data["detail"] == IsProjectNotArchived.message
    # Inert, not merely refused: `enqueue_template_apply` writes the application row
    # before it dispatches, so a 403 raised too late would still have queued a seed.
    assert TemplateApplication.objects.filter(project=target_project).count() == 0


@pytest.mark.django_db
def test_apply_still_works_when_the_target_project_is_not_archived(
    admin_client: APIClient, source_project: Project, target_project: Project
) -> None:
    """Negative control — identical setup minus the archive step."""
    _shape(source_project)
    template = ProjectTemplate.objects.create(
        name="Skeleton", structure=extract_structure(source_project)
    )

    resp = admin_client.post(
        f"/api/v1/project-templates/{template.pk}/apply/",
        {"project": str(target_project.pk)},
        format="json",
    )

    assert resp.status_code == 202, resp.data
    assert TemplateApplication.objects.filter(project=target_project).count() == 1


@pytest.mark.django_db
def test_publish_is_still_allowed_from_an_archived_source_project(
    admin_client: APIClient, source_project: Project
) -> None:
    """Deliberate asymmetry, stated so a later reader does not "fix" it.

    Archived makes a plan read-only. Extracting a template out of one reads it and
    writes a workspace-level `ProjectTemplate` row — nothing lands in the archived
    project — so publish keeps working while apply does not.
    """
    _shape(source_project)
    _archive(source_project)

    resp = admin_client.post(
        "/api/v1/project-templates/publish/",
        {"project": str(source_project.pk), "name": "From an archived plan"},
        format="json",
    )

    assert resp.status_code == 201, resp.data


def _seeded_application(
    source_project: Project, target_project: Project
) -> tuple[ProjectTemplate, TemplateApplication]:
    """A SUCCESS application over rows an undo would really delete.

    Seeding through `materialize_structure` (`bulk_create`) is what makes the
    assertions below non-vacuous: it leaves `edited_at` NULL, so the rows are
    *untouched* and a leaked undo would soft-delete them. Building them with
    `Task.objects.create()` instead stamps `edited_at` via `Task.save()`, undo keeps
    them as typed work, and a refusal test then passes on the broken build too.
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
    return template, application


@pytest.mark.django_db
def test_undo_endpoint_is_refused_when_the_project_is_archived(
    admin_client: APIClient, source_project: Project, target_project: Project
) -> None:
    """The gate is about project state, not role — admin_client is Admin on this project."""
    _, application = _seeded_application(source_project, target_project)
    _archive(target_project)

    resp = admin_client.post(
        f"/api/v1/template-applications/{application.pk}/undo/", {}, format="json"
    )

    assert resp.status_code == 403, resp.data
    assert Task.objects.filter(project=target_project, is_deleted=False).count() == 2
    application.refresh_from_db()
    assert application.status == TemplateApplicationStatus.SUCCESS
    assert application.undone_at is None


@pytest.mark.django_db
def test_undo_endpoint_still_works_when_the_project_is_not_archived(
    admin_client: APIClient, source_project: Project, target_project: Project
) -> None:
    """Negative control — identical setup minus the archive step.

    This is the assertion that proves the refusal above is the archived floor and
    not the undo declining to touch these rows for some other reason.
    """
    _, application = _seeded_application(source_project, target_project)

    resp = admin_client.post(
        f"/api/v1/template-applications/{application.pk}/undo/", {}, format="json"
    )

    assert resp.status_code == 200, resp.data
    assert Task.objects.filter(project=target_project, is_deleted=False).count() == 0


@pytest.mark.django_db
@pytest.mark.parametrize(
    "role",
    [Role.VIEWER, Role.MEMBER, Role.SCHEDULER, Role.ADMIN, Role.OWNER, 350],
)
def test_undo_endpoint_admits_exactly_the_shared_predicate_s_roles(
    source_project: Project, target_project: Project, role: int
) -> None:
    """#3353 — the undo action now defers to ``role_can_undo_batch_operation``.

    Asserted against the predicate rather than a hard-coded truth table, because the
    point of the consolidation is that this endpoint and the paste-many / cascade /
    CSV-import undos cannot drift: a change to the predicate must move all four or
    fail here. Nothing covered this route's role floor before — the archived-project
    tests above hold role constant on purpose.

    ``350`` is the Enterprise project-lead band (ADR-0072). The predicate is a
    threshold, so a custom role registered there inherits undo authority; the inline
    ``role < Role.ADMIN`` this replaced agreed, and this pins that it still does.

    ``_require_project_admin`` on the same viewset is deliberately NOT folded into the
    predicate: it gates publishing and applying, a different rule that shares today's
    ordinal.
    """
    _, application = _seeded_application(source_project, target_project)
    user = User.objects.create_user(username=f"tmpl-undo-{role}", password="pw")
    ProjectMembership.objects.create(project=target_project, user=user, role=role)
    client = APIClient()
    client.force_authenticate(user=user)

    resp = client.post(f"/api/v1/template-applications/{application.pk}/undo/", {}, format="json")

    assert (resp.status_code != 403) is role_can_undo_batch_operation(role), resp.data


@pytest.mark.django_db
def test_polling_an_application_still_works_on_an_archived_project(
    admin_client: APIClient, source_project: Project, target_project: Project
) -> None:
    """`IsProjectNotArchived` passes every SAFE_METHOD, and the Start sheet needs it to.

    The viewset's comment makes this claim specifically; without the assertion the
    added permission class could start blocking GET and only the polling UI would
    notice.
    """
    _, application = _seeded_application(source_project, target_project)
    _archive(target_project)

    resp = admin_client.get(f"/api/v1/template-applications/{application.pk}/")

    assert resp.status_code == 200, resp.data
    assert resp.data["status"] == TemplateApplicationStatus.SUCCESS


@pytest.mark.django_db
def test_template_services_refuse_an_archived_project_without_a_view(
    source_project: Project, target_project: Project
) -> None:
    """The floor underneath the view — the shape a Celery task or command would take."""
    from rest_framework.exceptions import PermissionDenied

    from trueppm_api.apps.projects.template_services import enqueue_template_apply

    template, application = _seeded_application(source_project, target_project)
    _archive(target_project)

    with pytest.raises(PermissionDenied):
        enqueue_template_apply(template, target_project)
    with pytest.raises(PermissionDenied):
        undo_template_application(application)

    assert Task.objects.filter(project=target_project, is_deleted=False).count() == 2
    # The apply refusal wrote no second application row, and the undo refusal left
    # the first one intact.
    assert TemplateApplication.objects.filter(project=target_project).count() == 1


@pytest.mark.django_db(transaction=True)
def test_the_seeding_task_refuses_a_project_archived_after_enqueue(
    source_project: Project, target_project: Project
) -> None:
    """The one non-view write caller in this family, and the widest window (#3354).

    `enqueue_template_apply` refuses an already-archived target, but dispatch is
    deferred to `on_commit` and the drain re-dispatches a still-`pending`
    application every 30s — so the write can land long after the check that
    admitted it. Archiving between the two must not seed the plan.
    """
    from trueppm_api.apps.projects.template_tasks import apply_template

    _shape(source_project)
    template = ProjectTemplate.objects.create(
        name="Skeleton", structure=extract_structure(source_project)
    )
    application = TemplateApplication.objects.create(template=template, project=target_project)
    _archive(target_project)

    result = apply_template.apply(args=[str(application.pk)]).get()

    assert result["failed"] is True
    assert result["tasks_created"] == 0
    # Nothing seeded, and the row is terminal rather than left at `running` for the
    # drain to resurrect on a project that will still be archived next time.
    assert Task.objects.filter(project=target_project, is_deleted=False).count() == 0
    application.refresh_from_db()
    assert application.status == TemplateApplicationStatus.FAILED
    assert "archived" in application.error_detail


@pytest.mark.django_db(transaction=True)
def test_the_seeding_task_still_seeds_when_the_project_is_not_archived(
    source_project: Project, target_project: Project
) -> None:
    """Negative control — identical setup minus the archive step."""
    from trueppm_api.apps.projects.template_tasks import apply_template

    _shape(source_project)
    template = ProjectTemplate.objects.create(
        name="Skeleton", structure=extract_structure(source_project)
    )
    application = TemplateApplication.objects.create(template=template, project=target_project)

    apply_template.apply(args=[str(application.pk)]).get()

    application.refresh_from_db()
    assert application.status == TemplateApplicationStatus.SUCCESS
    assert Task.objects.filter(project=target_project, is_deleted=False).count() == 2


@pytest.mark.django_db
def test_apply_answers_400_not_500_for_a_malformed_project_id(
    admin_client: APIClient, source_project: Project
) -> None:
    """`UUIDField.to_python` raises Django's ValidationError, which DRF does not convert.

    This line runs before `_require_project_admin`, so the 500 was reachable by any
    authenticated user. `publish_preview` already caught it; `apply` had drifted.
    """
    _shape(source_project)
    template = ProjectTemplate.objects.create(
        name="Skeleton", structure=extract_structure(source_project)
    )

    resp = admin_client.post(
        f"/api/v1/project-templates/{template.pk}/apply/",
        {"project": "not-a-uuid"},
        format="json",
    )

    assert resp.status_code == 400, resp.data
    assert TemplateApplication.objects.count() == 0
