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
from rest_framework import mixins, viewsets
from rest_framework.generics import RetrieveUpdateAPIView
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.serializers import BaseSerializer

from trueppm_api.apps.access.permissions import (
    IsProgramAdmin,
    IsProgramMember,
    IsProgramNotClosed,
)
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.projects.models import (
    CeremonyTemplate,
    PhaseGateConfig,
    Program,
)
from trueppm_api.apps.projects.serializers import (
    CeremonyTemplateSerializer,
    PhaseGateConfigSerializer,
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
