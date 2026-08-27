"""Project template gallery, publish, apply and undo (ADR-0789, #2729).

RBAC follows ADR-0773's matrix, which already decided this before any code:
**"Apply a template" is Admin+** (Owner and Admin; Viewer, Member and Scheduler
cannot). Publishing is likewise Admin+ on the source project. *Reading* the gallery
needs only authentication — a Member should be able to see what skeletons exist
without being able to fire one at a project.
"""

from __future__ import annotations

from typing import Any, cast

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db.models import Case, Count, IntegerField, Q, QuerySet, Value, When
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from trueppm_api.apps.access.models import Role
from trueppm_api.apps.access.permissions import _membership_role
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.projects.models import (
    Methodology,
    Project,
    ProjectTemplate,
    TemplateApplication,
    TemplateApplicationStatus,
    TemplateSource,
)
from trueppm_api.apps.projects.program_views import SeedImportThrottle
from trueppm_api.apps.projects.project_templates import (
    TemplateStructureError,
    extract_structure,
    summarize_structure,
    validate_structure,
)
from trueppm_api.apps.projects.template_services import (
    enqueue_template_apply,
    undo_template_application,
)
from trueppm_api.apps.workspace.models import AuditEventType
from trueppm_api.apps.workspace.services import record_audit_event

# Shared user-facing response details.
_NO_SUCH_PROJECT_DETAIL = "No such project."


def _publish_inputs(data: Any) -> tuple[Any, str, Any]:
    """Read and type-check ``publish``'s three body fields, before any project read.

    Split out of ``publish`` only to keep it readable; the order matters and is
    preserved — every check here runs *before* the project lookup and therefore
    before ``_require_project_admin``, so an unauthorized caller still cannot use a
    malformed body to learn whether a project exists.

    Same type-confusion class as #2785: a JSON list/dict/number is truthy, so
    ``(value or "")`` hands it straight to .strip() / slicing and raises
    AttributeError, and a non-string pk reaches UUIDField.to_python, which raises
    Django's ValidationError — not one of the ValueError/TypeError caught by the
    caller, and not something DRF converts. All three are 500s on input that has to
    be a 400.

    Returns:
        The raw project pk, the stripped name, and the raw description.
    """
    project_id = data.get("project")
    raw_name = data.get("name")
    raw_description = data.get("description")
    for field, value in (
        ("project", project_id),
        ("name", raw_name),
        ("description", raw_description),
    ):
        if value is not None and not isinstance(value, str):
            raise ValidationError({field: "Must be a string."})

    name = (raw_name or "").strip()
    if not project_id or not name:
        raise ValidationError({"detail": "Both `project` and `name` are required."})
    return project_id, name, raw_description


def _flag(value: Any) -> bool:
    """Read a permissive boolean off attacker-shaped ``request.data``.

    Non-string input is the #2795 container-type class: a JSON list or dict is
    truthy and reaches ``.lower()`` as an AttributeError 500. Coerced through
    ``str`` so every shape lands on False rather than on a stack trace.
    """
    return str(value).lower() in {"true", "1"}


class ProjectTemplateSerializer(serializers.ModelSerializer[ProjectTemplate]):
    """Gallery row. ``structure`` is deliberately **not** exposed.

    The gallery renders a name, a description, a provenance chip, a methodology,
    and what the template carries — never the document itself. Publishing the
    structure on a list endpoint would put a whole project's shape (task names
    included) in front of anyone who can read the gallery, which is a wider
    audience than the source project's members.
    """

    task_count = serializers.SerializerMethodField()
    provenance = serializers.SerializerMethodField()
    methodology = serializers.SerializerMethodField()
    counts = serializers.SerializerMethodField()
    usage_count = serializers.SerializerMethodField()
    published_by_name = serializers.SerializerMethodField()
    source_project_name = serializers.SerializerMethodField()
    is_superseded = serializers.SerializerMethodField()

    class Meta:
        model = ProjectTemplate
        fields = [  # noqa: RUF012
            "id",
            "name",
            "description",
            "source_kind",
            "provenance",
            "carries",
            "methodology",
            "task_count",
            "version",
            "program",
            "is_published",
            "published_at",
            "published_by",
            "published_by_name",
            "source_project",
            "source_project_name",
            "supersedes",
            "is_superseded",
            "counts",
            "usage_count",
        ]
        read_only_fields = [  # noqa: RUF012
            "id",
            "source_kind",
            "provenance",
            "carries",
            "methodology",
            "task_count",
            "version",
            "published_at",
            "published_by",
            "published_by_name",
            "source_project",
            "source_project_name",
            "supersedes",
            "is_superseded",
            "counts",
            "usage_count",
        ]

    def get_counts(self, obj: ProjectTemplate) -> dict[str, Any]:
        """Tasks, phases, gates and dependencies, off the frozen document (#2909).

        Server-side because the publish inventory and the gallery's carries
        summary are both screens whose credibility rests on a number, and a
        client-side walk of a filtered tree would produce a different one.
        """
        return summarize_structure(obj.structure or {})

    def get_usage_count(self, obj: ProjectTemplate) -> int:
        """Projects created from this template — the PMO's only house-standard signal.

        Annotated on the queryset where one is available; falls back to a count so
        a serializer used outside the gallery (the publish response) still answers.
        Undone applications are excluded: a template whose seeding was reversed
        was not adopted, and counting it would overstate the standard.
        """
        annotated = getattr(obj, "adoption_count", None)
        if annotated is not None:
            return int(annotated)
        return obj.applications.filter(
            status=TemplateApplicationStatus.SUCCESS, undone_at__isnull=True
        ).count()

    def get_published_by_name(self, obj: ProjectTemplate) -> str:
        user = obj.published_by or obj.owner
        if user is None:
            return ""
        return str(getattr(user, "display_name", "") or getattr(user, "username", ""))

    def get_source_project_name(self, obj: ProjectTemplate) -> str:
        """Name of the project this was frozen from, or '' once it is gone.

        Empty rather than absent when the FK has been nulled by a project
        deletion: the provenance line simply drops, and the template still works.
        """
        return obj.source_project.name if obj.source_project else ""

    def get_is_superseded(self, obj: ProjectTemplate) -> bool:
        """A later version replaced this one. It stays selectable on purpose —
        projects already created from it are why it must remain legible."""
        return obj.superseded_by.exists()

    def get_task_count(self, obj: ProjectTemplate) -> int:
        """How many rows adopting this would write — the one number that decides adoption.

        Read off the stored document rather than counted in SQL: the structure is
        frozen at publish, so there is nothing to join against and no count that
        could disagree with what apply will actually write.
        """
        structure = obj.structure or {}
        tasks = structure.get("tasks")
        return len(tasks) if isinstance(tasks, list) else 0

    def get_methodology(self, obj: ProjectTemplate) -> str:
        """The methodology the source project carried at publish time (ADR-0791).

        Read off the frozen ``structure`` document, mirroring ``get_task_count`` —
        never re-queries the (possibly since-edited/archived/deleted) source
        project, and can never disagree with what ``apply`` will actually seed.
        Falls back to ``Methodology.HYBRID`` (never null) for a structure written
        before this key existed, or one edited outside the publish path — Hybrid is
        the lossless default everywhere else in the methodology chain
        (``methodology.DEFAULT_METHODOLOGY``), so an unresolved template under-hides
        rather than over-hides tabs.
        """
        structure = obj.structure or {}
        methodology = structure.get("methodology")
        return methodology if methodology in Methodology.values else Methodology.HYBRID

    def get_provenance(self, obj: ProjectTemplate) -> str:
        """The chip label — "Workspace" / "Community" / "Yours".

        ``source_kind`` is stored, so two readers agree on Workspace and Community.
        *Yours* is the one label additionally narrowed at read time, because it is
        the only one that is genuinely relative to who is asking (ADR-0789 §2).
        """
        request = self.context.get("request")
        user = getattr(request, "user", None)
        if obj.source_kind == TemplateSource.PERSONAL:
            if user is not None and obj.owner_id == getattr(user, "id", None):
                return "Yours"
            # Somebody else's personal template that has been shared into view:
            # it is not "Yours", and calling it Workspace would overstate its
            # standing. Name the publisher's tier honestly.
            return "Community"
        return TemplateSource(obj.source_kind).label


class TemplateApplicationSerializer(serializers.ModelSerializer[TemplateApplication]):
    """The adoption record — also what the Start sheet polls while seeding runs."""

    class Meta:
        model = TemplateApplication
        fields = [  # noqa: RUF012
            "id",
            "template",
            "template_name",
            "template_version",
            "project",
            "applied_by",
            "status",
            "result_summary",
            "error_detail",
            "created_at",
            "completed_at",
            "undone_at",
        ]
        read_only_fields = fields


class ProjectTemplateViewSet(IdempotencyMixin, viewsets.ReadOnlyModelViewSet[ProjectTemplate]):
    """Templates available to the caller, plus publish and apply.

    **ReadOnly** on purpose, not for lack of ambition. A ``ModelViewSet`` here would
    inherit create / update / destroy under this class's ``IsAuthenticated``, which
    is the wrong gate for all three: any authenticated user could mint an empty
    template, or rename and delete somebody else's. Publishing has exactly one door
    (``publish``, Admin+ on the source project) and it is the door that runs the
    extraction. Editing and unpublishing are deliberately not in this issue —
    absent is safer than present-and-ungated.

    Apply is throttled on the existing ``seed_import`` scope rather than a new one
    (ADR-0789 §Context 3). Template apply is a third background seeding path
    alongside seed import and CSV/MS Project import; #2615 remains the issue that
    bounds per-user concurrency for all three. Reusing the scope inherits exactly
    the bound the other paths have today and keeps that fix in one place, instead
    of adding a fourth unbounded path.
    """

    serializer_class = ProjectTemplateSerializer
    permission_classes = [IsAuthenticated]  # noqa: RUF012

    def get_queryset(self) -> QuerySet[ProjectTemplate]:
        """Published templates in scope: workspace-wide, or this program's.

        ``?program=`` narrows to a program's own templates *plus* the workspace-wide
        ones — a program-scoped gallery that hid the shared skeletons would be
        emptier than the user expects and would push them to republish duplicates.
        """
        qs = (
            ProjectTemplate.objects.filter(is_published=True)
            .select_related("owner", "published_by", "source_project")
            # One aggregate rather than a per-row count in the serializer: the
            # gallery renders every template at once, so a SerializerMethodField
            # doing its own query is N+1 by construction (#2909).
            .annotate(
                adoption_count=Count(
                    "applications",
                    filter=Q(
                        applications__status=TemplateApplicationStatus.SUCCESS,
                        applications__undone_at__isnull=True,
                    ),
                    distinct=True,
                )
            )
            # Provenance is the sort key as well as the chip (#2909): on a
            # workspace that has published its own shapes, those are the ones
            # worth reading first, and the bundled starters sort last. The chip
            # stays on every row regardless of position — order is a nudge, not
            # the information. Explicit rather than leaning on Meta.ordering,
            # which an annotate() drops and which paginates unordered.
            .order_by(
                Case(
                    When(source_kind=TemplateSource.COMMUNITY, then=Value(1)),
                    default=Value(0),
                    output_field=IntegerField(),
                ),
                "name",
                "-version",
            )
        )
        program_id = self.request.query_params.get("program")
        if program_id:
            qs = qs.filter(Q(program_id=program_id) | Q(program__isnull=True))
        return qs

    def _require_project_admin(self, project: Project) -> None:
        """ADR-0773: publishing and applying are Admin+ on the project in question."""
        role = _membership_role(self.request, project.pk)
        if role is None or role < Role.ADMIN:
            raise PermissionDenied(
                "You need at least Project Manager role to publish or apply a template."
            )

    @extend_schema(
        request=None,
        responses={201: ProjectTemplateSerializer},
        description="Publish a project's shape as a reusable template.",
    )
    @action(detail=False, methods=["post"], url_path="publish")
    def publish(self, request: Request) -> Response:
        """Freeze a project's shape into a new template (or a new version of one).

        Extraction happens **here**, synchronously: it is a read of one project's
        tasks and edges, bounded by ``MAX_TEMPLATE_NODES``, and the publisher should
        learn immediately whether their project was too large rather than by polling.
        """
        project_id, name, raw_description = _publish_inputs(request.data)
        try:
            project = Project.objects.get(pk=project_id, is_deleted=False)
        except (Project.DoesNotExist, ValueError, TypeError) as exc:
            raise ValidationError({"project": _NO_SUCH_PROJECT_DETAIL}) from exc
        self._require_project_admin(project)

        try:
            structure = extract_structure(project)
        except TemplateStructureError as exc:
            raise ValidationError({"project": str(exc)}) from exc

        source_kind = request.data.get("source_kind") or TemplateSource.WORKSPACE
        if source_kind not in TemplateSource.values:
            raise ValidationError({"source_kind": "Unknown provenance."})

        # Republishing writes a NEW row and leaves the old one selectable, rather
        # than editing in place (#2909). The projects already created from v1 are
        # the only audit trail a PMO has for why they look the way they do, and a
        # version mutated under them turns that trail into a lie. So a name that
        # is already taken is a decision, not an error to swallow: either publish
        # a new version of that template, or pick a different name.
        existing = ProjectTemplate.objects.filter(name=name[:200]).order_by("-version").first()
        supersede = _flag(request.data.get("new_version"))
        if existing is not None and not supersede:
            return Response(
                {
                    "code": "name_taken",
                    "detail": (
                        f"“{existing.name}” already exists in this workspace "
                        f"(v{existing.version}). Publish a new version of it, or "
                        f"give this one a different name."
                    ),
                    "template": str(existing.pk),
                    "version": existing.version,
                    "next_version": existing.version + 1,
                },
                status=status.HTTP_409_CONFLICT,
            )

        template = ProjectTemplate.objects.create(
            name=name[:200],
            description=(raw_description or "")[:2000],
            source_kind=source_kind,
            owner=cast("Any", request.user),
            published_by=cast("Any", request.user),
            program=project.program,
            source_project=project,
            supersedes=existing,
            version=(existing.version + 1) if existing is not None else 1,
            structure=structure,
            carries=structure.get("carries", []),
        )
        # A workspace-visible disclosure act: this puts one project's task names in
        # front of everyone in the workspace, and a new version changes what the
        # house shape resolves to for every future adopter. Written through the
        # ADR-0157 choke point, inside this request's transaction, so the log can
        # never claim a publish that rolled back.
        record_audit_event(
            event_type=AuditEventType.TEMPLATE_PUBLISHED,
            actor=request.user,
            target_type="project_template",
            target_id=template.pk,
            target_label=f"{template.name} v{template.version}",
            metadata={
                "version": template.version,
                "source_project": str(project.pk),
                "supersedes": str(existing.pk) if existing is not None else None,
                "task_count": len(structure.get("tasks", [])),
                "source_kind": source_kind,
            },
        )
        return Response(
            self.get_serializer(template).data,
            status=status.HTTP_201_CREATED,
        )

    @extend_schema(
        responses={
            200: OpenApiResponse(
                description=(
                    "Dry run: what publishing this project would carry — "
                    "{task_count, phase_count, gate_count, milestone_count, "
                    "dependency_count, methodology, carries, name_taken, "
                    "next_version}. Writes nothing."
                )
            ),
            403: OpenApiResponse(description="Caller is not Admin+ on the project."),
        },
        description=(
            "Counts for the publish form, computed from the same extraction publish itself runs."
        ),
    )
    @action(detail=False, methods=["get"], url_path="publish-preview")
    def publish_preview(self, request: Request) -> Response:
        """The six counts the Settings page and the confirm step both show (#2909).

        Runs the **same** ``extract_structure`` the publish action runs, so the
        numbers on the confirm screen are the numbers that will be written — not
        a client-side walk of whatever the Grid currently has loaded, which a
        collapsed or filtered view would get wrong.

        Also reports whether the proposed name is taken, so the form can offer
        "publish as v3 instead" before the operator fills anything in rather than
        after a 409.
        """
        project_id = request.query_params.get("project")
        if not project_id:
            raise ValidationError({"project": "Required."})
        try:
            project = Project.objects.get(pk=project_id, is_deleted=False)
        except (Project.DoesNotExist, ValueError, TypeError, DjangoValidationError) as exc:
            raise ValidationError({"project": _NO_SUCH_PROJECT_DETAIL}) from exc
        self._require_project_admin(project)

        try:
            structure = extract_structure(project)
        except TemplateStructureError as exc:
            raise ValidationError({"project": str(exc)}) from exc

        summary = summarize_structure(structure)
        proposed = (request.query_params.get("name") or "").strip()
        existing = (
            ProjectTemplate.objects.filter(name=proposed[:200]).order_by("-version").first()
            if proposed
            else None
        )
        summary["name_taken"] = existing is not None
        summary["next_version"] = (existing.version + 1) if existing is not None else 1
        summary["existing_template"] = str(existing.pk) if existing is not None else None
        return Response(summary, status=status.HTTP_200_OK)

    @extend_schema(
        request=None,
        responses={202: OpenApiResponse(description='{"queued": true, "application": "<uuid>"}')},
        description="Apply this template to a project. Returns 202; seeding runs async.",
    )
    @action(
        detail=True,
        methods=["post"],
        url_path="apply",
        throttle_classes=[SeedImportThrottle],
    )
    def apply(self, request: Request, pk: str | None = None) -> Response:
        """Queue a seeding job and hand back the application id.

        Returns ``202 {"queued": true}`` and **not** a Celery task id: dispatch is
        best-effort behind an outbox, so there may be no task id yet (or ever, for
        the delivery that gets dropped and re-dispatched by the drain). The
        application id is the durable handle — it exists the moment the request
        commits, and it is what the Start sheet polls.
        """
        template = self.get_object()
        project_id = request.data.get("project")
        if not project_id:
            raise ValidationError({"project": "This field is required."})
        try:
            project = Project.objects.get(pk=cast("Any", project_id), is_deleted=False)
        except (Project.DoesNotExist, ValueError, TypeError) as exc:
            raise ValidationError({"project": _NO_SUCH_PROJECT_DETAIL}) from exc
        self._require_project_admin(project)

        # Re-validate here, not only at publish: `structure` is a JSONB column, so
        # the row can be edited by any path that reaches the database, and this is
        # the request that turns it into rows in somebody's project.
        try:
            validate_structure(template.structure)
        except TemplateStructureError as exc:
            raise ValidationError({"template": str(exc)}) from exc

        application = enqueue_template_apply(
            template, project, applied_by=cast("Any", request.user)
        )
        return Response(
            {"queued": True, "application": str(application.id)},
            status=status.HTTP_202_ACCEPTED,
        )


class TemplateApplicationViewSet(
    IdempotencyMixin, viewsets.ReadOnlyModelViewSet[TemplateApplication]
):
    """Poll an application's progress, and undo it.

    Read is scoped to projects the caller is a member of — an application row names
    a project and a person, so an unscoped list would leak both.
    """

    serializer_class = TemplateApplicationSerializer
    permission_classes = [IsAuthenticated]  # noqa: RUF012

    def get_queryset(self) -> QuerySet[TemplateApplication]:
        from trueppm_api.apps.access.models import ProjectMembership

        member_project_ids = ProjectMembership.objects.filter(
            user=cast("Any", self.request.user), is_deleted=False
        ).values_list("project_id", flat=True)
        qs = TemplateApplication.objects.filter(project_id__in=member_project_ids)
        project_id = self.request.query_params.get("project")
        if project_id:
            qs = qs.filter(project_id=project_id)
        return qs

    @extend_schema(
        request=None,
        responses={200: TemplateApplicationSerializer},
        description="Undo this application — removes the rows it wrote that nobody has edited.",
    )
    @action(detail=True, methods=["post"], url_path="undo")
    def undo(self, request: Request, pk: str | None = None) -> Response:
        """Reverse one application in a single step.

        Rows a person has since touched are **kept**, not deleted — see
        ``undo_template_application``. Undoing an application that never succeeded,
        or has already been undone, is a 400 rather than a silent no-op: the caller
        asked to reverse something and deserves to know it did not happen.
        """
        application = self.get_object()
        role = _membership_role(request, cast("Any", application.project_id))
        if role is None or role < Role.ADMIN:
            raise PermissionDenied("You need at least Project Manager role to undo a template.")
        if application.status != TemplateApplicationStatus.SUCCESS:
            raise ValidationError(
                {
                    "detail": f"Only a completed application can be undone (this one is "
                    f"{application.status})."
                }
            )
        summary = undo_template_application(application)
        application.refresh_from_db()
        data: dict[str, Any] = self.get_serializer(application).data
        data["undo"] = summary
        return Response(data, status=status.HTTP_200_OK)
