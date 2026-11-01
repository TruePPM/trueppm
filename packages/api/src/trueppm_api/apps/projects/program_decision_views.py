"""Program decision log (ADR-1310, #4772).

    GET    /api/v1/programs/<program_pk>/decisions/[?status=awaiting|made|withdrawn]
    POST   /api/v1/programs/<program_pk>/decisions/
    GET    /api/v1/programs/<program_pk>/decisions/<pk>/
    PATCH  /api/v1/programs/<program_pk>/decisions/<pk>/
    DELETE /api/v1/programs/<program_pk>/decisions/<pk>/

Permission matrix (the program's 5-role RBAC):

  list / retrieve                — Viewer+ (``IsProgramMember``)
  create / update                — Team Member+ (``IsProgramEditor``)
  destroy                        — Program Manager+ (``IsProgramAdmin``)

Every write is also refused on a closed program (``IsProgramNotClosed``).

Delete is held one tier above edit on purpose. A decision log is a record; a
member who wants a decision off the list withdraws it, which keeps the row and
says why it is gone. Deleting is for a row that should never have existed.

This is not the project Decisions view (``decisions_views.py``, ADR-0167), which
reads decision-flagged task notes. See ``ProgramDecision`` for why the two are
separate.
"""

from __future__ import annotations

from typing import Any

from django.contrib.auth import get_user_model
from django.db.models import F, QuerySet
from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import extend_schema_field
from rest_framework import mixins, serializers, viewsets
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.serializers import BaseSerializer

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership
from trueppm_api.apps.access.permissions import (
    IsProgramAdmin,
    IsProgramEditor,
    IsProgramMember,
    IsProgramNotClosed,
)
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.projects.models import (
    PROGRAM_DECISION_TRANSITIONS,
    Program,
    ProgramDecision,
    ProgramDecisionStatus,
    Risk,
    Task,
)

User = get_user_model()


class ProgramDecisionOwnerSerializer(serializers.Serializer[Any]):
    """Just enough of the owner to render a name."""

    id = serializers.IntegerField()
    username = serializers.CharField()
    display_name = serializers.SerializerMethodField()

    def get_display_name(self, obj: Any) -> str:
        return str(obj.get_full_name() or obj.username)


class ProgramDecisionLinkSerializer(serializers.Serializer[Any]):
    """A linked task or risk, as the reader is allowed to see it.

    ``title`` and ``short_id`` are ``None`` when the reader is a program member but not a member of
    the project the linked item lives in. Program membership admits the reader to
    the program's log; project membership governs what of a project's plan is
    revealed (ADR-0120 D5) — so the link is disclosed, its name is not.
    """

    id = serializers.UUIDField()
    kind = serializers.ChoiceField(choices=["task", "risk"])
    short_id = serializers.CharField(allow_null=True)
    title = serializers.CharField(allow_null=True)
    project_id = serializers.UUIDField()


class ProgramDecisionSerializer(serializers.ModelSerializer[ProgramDecision]):
    """Read/write serializer for a program decision.

    ``program`` is bound by the URL and read-only, so a payload cannot retarget a
    decision to another program. ``decided_at`` is server-stamped on the move to
    ``made``. ``impact_note`` is the owner's free-text estimate — it is stored and
    echoed verbatim and nothing on the server computes or validates it as a number.
    """

    owner_detail = ProgramDecisionOwnerSerializer(source="owner", read_only=True, allow_null=True)
    link = serializers.SerializerMethodField()

    class Meta:
        model = ProgramDecision
        fields = [  # noqa: RUF012
            "id",
            "server_version",
            "program",
            "title",
            "owner",
            "owner_detail",
            "due_date",
            "status",
            "decided_at",
            "linked_task",
            "linked_risk",
            "link",
            "impact_note",
            "created_by",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [  # noqa: RUF012
            "id",
            "server_version",
            "program",
            "decided_at",
            "created_by",
            "created_at",
            "updated_at",
        ]
        extra_kwargs = {  # noqa: RUF012
            # Querysets are narrowed per request in __init__; the class-level ones
            # are only what drf-spectacular reads for the schema.
            "owner": {"queryset": User.objects.none()},
            "linked_task": {"queryset": Task.objects.none()},
            "linked_risk": {"queryset": Risk.objects.none()},
        }

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        program: Program | None = self.context.get("program")
        if program is None:
            return
        fields = self.fields
        # A primary key that resolves outside this program is reported as "does not
        # exist", exactly as a random UUID would be. That is the cross-program
        # refusal, and it is deliberately indistinguishable from a typo: a distinct
        # "belongs to another program" error would confirm the id is real.
        fields["owner"].queryset = User.objects.filter(  # type: ignore[attr-defined]
            pk__in=ProgramMembership.live().filter(program=program).values("user_id")
        )
        fields["linked_task"].queryset = Task.objects.filter(  # type: ignore[attr-defined]
            project__program=program, project__is_deleted=False, is_deleted=False
        )
        fields["linked_risk"].queryset = Risk.objects.filter(  # type: ignore[attr-defined]
            project__program=program, project__is_deleted=False, is_deleted=False
        )

    def _readable_project_ids(self) -> set[Any]:
        """Project ids the requester is a member of — computed once per response."""
        cached: set[Any] | None = getattr(self, "_readable_cache", None)
        if cached is not None:
            return cached
        request = self.context.get("request")
        user = getattr(request, "user", None)
        readable: set[Any] = set()
        if user is not None and user.is_authenticated:
            readable = set(
                ProjectMembership.live()
                .filter(user=user, project__is_deleted=False)
                .values_list("project_id", flat=True)
            )
        self._readable_cache = readable
        return readable

    @extend_schema_field(ProgramDecisionLinkSerializer(allow_null=True))
    def get_link(self, obj: ProgramDecision) -> dict[str, Any] | None:
        target: Task | Risk | None = obj.linked_task or obj.linked_risk
        if target is None:
            return None
        readable = target.project_id in self._readable_project_ids()
        kind = "task" if obj.linked_task_id else "risk"
        title = (target.name if isinstance(target, Task) else target.title) if readable else None
        return {
            "id": target.pk,
            "kind": kind,
            "short_id": (target.short_id or None) if readable else None,
            "title": title,
            "project_id": target.project_id,
        }

    def validate_title(self, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise serializers.ValidationError("Title is required.")
        return normalized

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        instance: ProgramDecision | None = self.instance

        task = attrs.get("linked_task", instance.linked_task if instance else None)
        risk = attrs.get("linked_risk", instance.linked_risk if instance else None)
        if task is not None and risk is not None:
            raise serializers.ValidationError(
                {"linked_risk": "Link a decision to a task or a risk, not both."}
            )
        self._check_link_readable(task, "linked_task")
        self._check_link_readable(risk, "linked_risk")

        if "status" in attrs:
            new = attrs["status"]
            if instance is None:
                if new == ProgramDecisionStatus.WITHDRAWN:
                    raise serializers.ValidationError(
                        {"status": "A new decision is either awaiting or made."}
                    )
            elif (
                new != instance.status and new not in PROGRAM_DECISION_TRANSITIONS[instance.status]
            ):
                raise serializers.ValidationError(
                    {
                        "status": (
                            f"A {instance.status} decision cannot move to {new}. "
                            "Reopen it to awaiting first."
                        )
                    }
                )
        return attrs

    def _check_link_readable(self, target: Task | Risk | None, field: str) -> None:
        """Refuse a link to work the writer cannot read.

        Program membership does not confer project membership (ADR-0070), so a
        program member who is not in the linked project could otherwise attach
        that project's task to the program log, and the accept/refuse pattern
        would confirm which ids exist in a project they cannot read.

        Checked only when the payload names the field: editing the title of a
        decision someone else linked must not fail because the editor is not in
        the linked project.
        """
        if target is None or field not in self.initial_data:
            return
        if target.project_id not in self._readable_project_ids():
            raise serializers.ValidationError(
                {field: "You can only link work in a project you are a member of."}
            )

    def _stamp_decided_at(self, attrs: dict[str, Any], previous: str | None) -> None:
        status = attrs.get("status")
        if status is None or status == previous:
            return
        attrs["decided_at"] = timezone.now() if status == ProgramDecisionStatus.MADE else None

    def create(self, validated_data: dict[str, Any]) -> ProgramDecision:
        self._stamp_decided_at(validated_data, None)
        return super().create(validated_data)

    def update(self, instance: ProgramDecision, validated_data: dict[str, Any]) -> ProgramDecision:
        self._stamp_decided_at(validated_data, instance.status)
        return super().update(instance, validated_data)


class ProgramDecisionViewSet(
    IdempotencyMixin,
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet[ProgramDecision],
):
    """CRUD for a program's decision log. See the module docstring for the matrix."""

    serializer_class = ProgramDecisionSerializer
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]  # noqa: RUF012
    # Ordering is part of the contract (awaiting by due date, made by most recent),
    # so the global OrderingFilter must not be able to override it.
    filter_backends: list[Any] = []  # noqa: RUF012

    def get_permissions(self) -> list[BasePermission]:
        if self.action in ("list", "retrieve"):
            return [IsAuthenticated(), IsProgramMember()]
        if self.action == "destroy":
            return [IsAuthenticated(), IsProgramAdmin(), IsProgramNotClosed()]
        return [IsAuthenticated(), IsProgramEditor(), IsProgramNotClosed()]

    def _program(self) -> Program:
        cached: Program | None = getattr(self, "_program_cache", None)
        if cached is None:
            cached = get_object_or_404(Program, pk=self.kwargs["program_pk"], is_deleted=False)
            self._program_cache = cached
        return cached

    def get_serializer_context(self) -> dict[str, Any]:
        context = dict(super().get_serializer_context())
        if "program_pk" in self.kwargs:
            context["program"] = self._program()
        return context

    def get_queryset(self) -> QuerySet[ProgramDecision]:
        qs = ProgramDecision.objects.filter(
            program_id=self.kwargs["program_pk"], is_deleted=False
        ).select_related("owner", "linked_task", "linked_risk")
        if self.action != "list":
            return qs
        status = (self.request.query_params.get("status") or "").strip()
        if status:
            if status not in ProgramDecisionStatus.values:
                raise serializers.ValidationError(
                    {"status": f"Expected one of {', '.join(ProgramDecisionStatus.values)}."}
                )
            qs = qs.filter(status=status)
        if status == ProgramDecisionStatus.MADE:
            return qs.order_by(F("decided_at").desc(nulls_last=True), "-created_at", "id")
        # Soonest-due first; undated decisions after dated ones. `id` is the
        # tiebreak that makes the order total, so page boundaries cannot repeat
        # or skip a row.
        return qs.order_by(F("due_date").asc(nulls_last=True), "created_at", "id")

    def perform_create(self, serializer: BaseSerializer[ProgramDecision]) -> None:
        program = self._program()
        # DRF does not run object permissions on create; check the program itself.
        self.check_object_permissions(self.request, program)
        serializer.save(program=program, created_by=self.request.user)

    def perform_destroy(self, instance: ProgramDecision) -> None:
        instance.soft_delete()
