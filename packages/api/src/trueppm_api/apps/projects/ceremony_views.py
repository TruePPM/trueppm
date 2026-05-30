"""Views for Program Settings → Cadence & ceremonies (ADR-0079, issue #528).

CeremonyTemplate is a program-scoped CRUD resource; PhaseGateConfig is a
singleton (1:1) per program, exposed via a thin retrieve/update view that
lazy-creates the row on first GET.

Both surfaces are gated by program membership: VIEWER+ may read,
ADMIN+ may write. The 5-role matrix is enforced through the existing
``IsProgramMember`` and ``IsProgramAdmin`` permission classes — no new
permission infrastructure is introduced here.
"""

from __future__ import annotations

from django.db.models import QuerySet
from django.shortcuts import get_object_or_404
from rest_framework import mixins, status, viewsets
from rest_framework.exceptions import PermissionDenied
from rest_framework.generics import RetrieveUpdateAPIView
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.serializers import BaseSerializer

from trueppm_api.apps.access.models import Role
from trueppm_api.apps.access.permissions import (
    IsProgramAdmin,
    IsProgramMember,
    IsProgramNotClosed,
    IsProjectMember,
    IsProjectNotArchived,
    _membership_role,
)
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.projects.models import (
    COMPOSITION_GUARDRAIL_RULES,
    CeremonyTemplate,
    GuardrailLevel,
    PhaseGateConfig,
    Program,
    Project,
    ProjectGuardrailPolicy,
)
from trueppm_api.apps.projects.serializers import (
    CeremonyTemplateSerializer,
    PhaseGateConfigSerializer,
    ProjectGuardrailPolicySerializer,
)


class CeremonyTemplateViewSet(
    IdempotencyMixin,
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet[CeremonyTemplate],
):
    """CRUD for program-level ceremony templates.

    URL: ``/api/v1/programs/<program_pk>/ceremonies/[<pk>/]``

    Permission matrix (ADR-0079):
      list / retrieve         — IsProgramMember (Viewer+)
      create / update / destroy / enable toggle — IsProgramAdmin (Project Manager+)
    """

    serializer_class = CeremonyTemplateSerializer

    def get_permissions(self) -> list[BasePermission]:
        if self.action in ("list", "retrieve"):
            return [IsAuthenticated(), IsProgramMember(), IsProgramNotClosed()]
        return [IsAuthenticated(), IsProgramAdmin(), IsProgramNotClosed()]

    def get_queryset(self) -> QuerySet[CeremonyTemplate]:
        # ``program_pk`` is guaranteed by the URL pattern; cast to str so the
        # ORM lookup type-checks against the UUID/str union mypy expects.
        program_pk = str(self.kwargs["program_pk"])
        return (
            CeremonyTemplate.objects.filter(
                program_id=program_pk,
                is_deleted=False,
            )
            .select_related("created_by")
            .order_by("name")
        )

    def perform_create(self, serializer: BaseSerializer[CeremonyTemplate]) -> None:
        program_pk = self.kwargs["program_pk"]
        program = get_object_or_404(Program, pk=program_pk, is_deleted=False)
        # DRF skips ``has_object_permission`` on create — enforce the program
        # admin gate against the resolved program before saving.
        self.check_object_permissions(self.request, program)
        serializer.save(program=program, created_by=self.request.user)

    def perform_destroy(self, instance: CeremonyTemplate) -> None:
        # Soft-delete so the sync protocol can ship a tombstone to clients
        # rather than the row vanishing silently. The partial unique
        # constraint on (program, name) excludes deleted rows so a name can
        # be reused after deletion.
        instance.soft_delete()


class PhaseGateConfigView(IdempotencyMixin, RetrieveUpdateAPIView[PhaseGateConfig]):
    """Singleton phase-gate calendar config per program.

    URL: ``/api/v1/programs/<program_pk>/phase-gate-config/``

    GET — IsProgramMember (Viewer+). Lazy-creates the row with defaults
    (``enabled=False``, ``invite_template=""``) on first request so existing
    programs do not require a data migration.

    PATCH — IsProgramAdmin (Project Manager+).
    """

    serializer_class = PhaseGateConfigSerializer
    http_method_names = ["get", "patch", "head", "options"]  # noqa: RUF012

    def get_permissions(self) -> list[BasePermission]:
        if self.request.method in ("GET", "HEAD", "OPTIONS"):
            return [IsAuthenticated(), IsProgramMember(), IsProgramNotClosed()]
        return [IsAuthenticated(), IsProgramAdmin(), IsProgramNotClosed()]

    def get_object(self) -> PhaseGateConfig:
        program_pk = self.kwargs["program_pk"]
        program = get_object_or_404(Program, pk=program_pk, is_deleted=False)
        # Membership / role enforcement uses the program as the target object
        # for the configured permission classes (they read program_pk from
        # ``self.kwargs`` via has_permission, then enforce on the object).
        self.check_object_permissions(self.request, program)
        config, _ = PhaseGateConfig.objects.get_or_create(program=program)
        return config

    def get_queryset(self) -> QuerySet[PhaseGateConfig]:
        # Required by DRF's GenericAPIView contract even though we override
        # get_object — the OpenAPI generator inspects this for schema output.
        program_pk = str(self.kwargs["program_pk"])
        return PhaseGateConfig.objects.filter(program_id=program_pk)


class ProjectGuardrailPolicyView(IdempotencyMixin, RetrieveUpdateAPIView[ProjectGuardrailPolicy]):
    """Singleton sprint/phase/WBS guardrail policy per project (ADR-0101 §3).

    URL: ``/api/v1/projects/<project_pk>/guardrail-policy/``

    GET — IsProjectMember (Viewer+). Lazy-creates the row with default (all-WARN)
    on first request so existing projects need no data migration.

    PATCH — IsProjectMember at the gate, but escalating a *composition* rule to
    BLOCK additionally requires ``role >= Role.OWNER`` (the sprint-sovereignty
    rule: only the team's own Owner may turn a sprint-composition guardrail into a
    wall). Lowering to WARN, and toggling ``acknowledged_by_team``, need only
    member write — acknowledging an external policy is the team's call.
    """

    serializer_class = ProjectGuardrailPolicySerializer
    http_method_names = ["get", "patch", "head", "options"]  # noqa: RUF012

    def get_permissions(self) -> list[BasePermission]:
        return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]

    def get_object(self) -> ProjectGuardrailPolicy:
        project_pk = self.kwargs["project_pk"]
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        self.check_object_permissions(self.request, project)
        policy, _ = ProjectGuardrailPolicy.objects.get_or_create(project=project)
        return policy

    def get_queryset(self) -> QuerySet[ProjectGuardrailPolicy]:
        project_pk = str(self.kwargs["project_pk"])
        return ProjectGuardrailPolicy.objects.filter(project_id=project_pk)

    def perform_update(self, serializer: BaseSerializer[ProjectGuardrailPolicy]) -> None:
        """Apply the level map with the sovereignty gate.

        A request that newly sets any composition rule to BLOCK is rejected with
        403 unless the caller is Owner+. The gate is checked against the *incoming*
        levels, merged onto the existing map so a partial PATCH that touches one
        rule doesn't silently clear the others.
        """
        instance = self.get_object()
        validated = serializer.validated_data
        incoming_levels = validated.get("levels")
        if incoming_levels is not None:
            escalates_composition_block = any(
                rule in COMPOSITION_GUARDRAIL_RULES and level == GuardrailLevel.BLOCK
                for rule, level in incoming_levels.items()
            )
            if escalates_composition_block:
                role = _membership_role(self.request, self.kwargs["project_pk"])
                if role is None or role < Role.OWNER:
                    raise PermissionDenied(
                        "Only the project Owner can set a sprint-composition guardrail to block."
                    )
            # Merge onto the existing map so a partial update is non-destructive.
            merged = dict(instance.levels)
            merged.update(incoming_levels)
            instance.levels = merged
        if "acknowledged_by_team" in validated:
            ack = validated["acknowledged_by_team"]
            instance.acknowledged_by_team = ack
            if ack and instance.acknowledged_at is None:
                from django.utils import timezone

                instance.acknowledged_at = timezone.now()
        instance.save()
        # Re-bind so the response reflects the persisted state.
        serializer.instance = instance

    def update(self, request: Request, *args: object, **kwargs: object) -> Response:
        # RetrieveUpdateAPIView.update returns the serialized instance; our
        # perform_update does the merge + gate. PATCH only (enforced by
        # http_method_names), so this is always partial.
        response = super().update(request, *args, **kwargs)
        return Response(response.data, status=status.HTTP_200_OK)
