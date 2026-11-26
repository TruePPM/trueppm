"""The changeset and the two exits, over REST (ADR-1477 §5, #3150).

Role floors, and why:

- **Reads** (changeset, decision trail) are project-read, the same floor as task
  history: anyone who can read the plan sees the same per-author rows (Q3.11).
- **Answering a reason** is Scheduler and above. Members' structural writes still
  create entries; the plan owner answers them in Review (Q3.2).
- **Deciding** (take v2, keep v1, and the preview of taking v2) is Admin and above
  — the floor ``ProjectCommitView`` and ``BaselineActivateView`` already hold, so
  neither exit is easier to reach than the other and re-baselining sits with the
  role that could commit the plan in the first place. The decision write is also
  **human-session only**: re-baselining is a governance act, and a token caller is
  refused and audited by ``IsNotTokenAuthenticated``.
"""

from __future__ import annotations

from typing import Any

from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import OpenApiResponse, extend_schema, inline_serializer
from rest_framework import serializers, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.access.permissions import (
    IsNotTokenAuthenticated,
    IsProjectAdmin,
    IsProjectMember,
    IsProjectNotArchived,
    IsProjectScheduler,
)
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.scheduling.answer_stamp import stamp_answer

from . import amend, baselines
from .models import (
    Baseline,
    BaselineDecision,
    BaselineDecisionKind,
    ChangesetEntry,
    Project,
    RebaselineReasonCode,
)


class ChangesetEntrySerializer(serializers.ModelSerializer[ChangesetEntry]):
    """One entry. ``reason_state`` is derived, never stored (ADR-1477 §1)."""

    reason_state = serializers.CharField(read_only=True)
    #: The BaselineDecision that resolved this entry (a UUID, not a user).
    resolved_decision = serializers.UUIDField(
        source="resolved_by_id", read_only=True, allow_null=True
    )
    author_name = serializers.SerializerMethodField()
    reason_by_name = serializers.SerializerMethodField()

    class Meta:
        model = ChangesetEntry
        fields = (
            "id",
            "kind",
            "surface",
            "author",
            "author_name",
            "agent_actor_id",
            "task_ids",
            "task_names",
            "reason",
            "reason_state",
            "reason_by",
            "reason_by_name",
            "reason_at",
            "finish_before",
            "finish_after",
            "opened_at",
            "last_act_at",
            "closed_at",
            "resolved_decision",
        )
        read_only_fields = fields

    def get_author_name(self, obj: ChangesetEntry) -> str | None:
        return obj.author.username if obj.author is not None else None

    def get_reason_by_name(self, obj: ChangesetEntry) -> str | None:
        return obj.reason_by.username if obj.reason_by is not None else None


class BaselineDecisionSerializer(serializers.ModelSerializer[BaselineDecision]):
    actor_name = serializers.SerializerMethodField()
    to_baseline_name = serializers.SerializerMethodField()

    class Meta:
        model = BaselineDecision
        fields = (
            "id",
            "kind",
            "from_baseline",
            "to_baseline",
            "to_baseline_name",
            "reason_code",
            "reason",
            "note",
            "commitment_moved",
            "decision",
            "entry_ids",
            "finish_at_decision",
            "actor",
            "actor_name",
            "created_at",
        )
        read_only_fields = fields

    def get_actor_name(self, obj: BaselineDecision) -> str | None:
        return obj.actor.username if obj.actor is not None else None

    def get_to_baseline_name(self, obj: BaselineDecision) -> str | None:
        return obj.to_baseline.name if obj.to_baseline is not None else None


class BaselineDecisionWriteSerializer(serializers.Serializer[Any]):
    kind = serializers.ChoiceField(choices=BaselineDecisionKind.choices)
    expected_open_count = serializers.IntegerField(min_value=0)
    reason_code = serializers.ChoiceField(
        choices=RebaselineReasonCode.choices, required=False, allow_null=True
    )
    reason = serializers.CharField(max_length=500, required=False, allow_blank=True, default="")
    note = serializers.CharField(max_length=500, required=False, allow_blank=True, default="")
    commitment_moved = serializers.BooleanField(required=False, default=False)
    decision = serializers.UUIDField(required=False, allow_null=True)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if attrs["kind"] == BaselineDecisionKind.TAKEN:
            errors: dict[str, str] = {}
            if not attrs.get("reason_code"):
                errors["reason_code"] = "A reason code is required to take a new baseline."
            if not (attrs.get("reason") or "").strip():
                errors["reason"] = "A reason is required to take a new baseline."
            if errors:
                raise serializers.ValidationError(errors)
        return attrs


class ChangesetReasonSerializer(serializers.Serializer[Any]):
    reason = serializers.CharField(max_length=500, allow_blank=False, trim_whitespace=True)


_CHANGESET_RESPONSE = inline_serializer(
    name="ChangesetResponse",
    fields={
        "project_id": serializers.UUIDField(),
        "open_count": serializers.IntegerField(),
        "unreasoned_count": serializers.IntegerField(),
        "reasoned_count": serializers.IntegerField(),
        "active_baseline": serializers.UUIDField(allow_null=True),
        "active_baseline_name": serializers.CharField(allow_null=True),
        "finish_baseline": serializers.DateField(allow_null=True),
        "finish_current": serializers.DateField(allow_null=True),
        "net_delta_days": serializers.IntegerField(allow_null=True),
        "last_kept_at": serializers.DateTimeField(allow_null=True),
        "entries_since_kept": serializers.IntegerField(),
        "entries": ChangesetEntrySerializer(many=True),
        "_provenance": serializers.DictField(),
    },
)

_PREVIEW_RESPONSE = inline_serializer(
    name="BaselineDecisionPreview",
    fields={
        "finish_from": serializers.DateField(allow_null=True),
        "finish_to": serializers.DateField(allow_null=True),
        "delta_days": serializers.IntegerField(allow_null=True),
        "milestones_moved": serializers.ListField(child=serializers.DictField()),
        "tasks_with_new_dates": serializers.DictField(child=serializers.IntegerField()),
        "commitment_moves": serializers.BooleanField(),
        "_provenance": serializers.DictField(),
    },
)


def _project(request: Request, view: APIView, project_pk: str) -> Project:
    project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
    view.check_object_permissions(request, project)
    return project


class ChangesetView(APIView):
    """GET /projects/{project_pk}/changeset/ — what changed since the active baseline, and why.

    ``last_kept_at`` / ``entries_since_kept``: after a Keep v1 the client demotes
    Review until one new entry arrives (Pass 5 Q3.1). Finish figures carry
    ``_provenance`` (ADR-0112 §2); they are persisted CPM output, never guessed —
    a null ``finish_after`` means "impact not computed yet".
    """

    permission_classes = (
        IsAuthenticated,
        IsProjectMember,
    )

    @extend_schema(summary="Read the open baseline changeset", responses={200: _CHANGESET_RESPONSE})
    def get(self, request: Request, project_pk: str) -> Response:
        project = _project(request, self, project_pk)
        entries = list(baselines.open_entries(project.pk))
        active = Baseline.objects.filter(
            project_id=project.pk, is_active=True, is_deleted=False
        ).first()
        finish_baseline = baselines.baseline_finish(active)
        finish_current = amend.current_finish(project.pk)
        last_kept = (
            BaselineDecision.objects.filter(project_id=project.pk, kind=BaselineDecisionKind.KEPT)
            .order_by("-created_at")
            .values_list("created_at", flat=True)
            .first()
        )
        since_kept = (
            sum(1 for e in entries if e.opened_at > last_kept) if last_kept else len(entries)
        )
        unreasoned = sum(1 for e in entries if e.reason is None)
        payload = {
            "project_id": str(project.pk),
            "open_count": len(entries),
            "unreasoned_count": unreasoned,
            "reasoned_count": len(entries) - unreasoned,
            "active_baseline": str(active.pk) if active else None,
            "active_baseline_name": active.name if active else None,
            "finish_baseline": finish_baseline.isoformat() if finish_baseline else None,
            "finish_current": finish_current.isoformat() if finish_current else None,
            "net_delta_days": (
                (finish_current - finish_baseline).days
                if finish_baseline and finish_current
                else None
            ),
            "last_kept_at": last_kept.isoformat() if last_kept else None,
            "entries_since_kept": since_kept,
            "entries": ChangesetEntrySerializer(entries, many=True).data,
        }
        inputs = {
            "baseline": payload["active_baseline"],
            "finish_baseline": payload["finish_baseline"],
            "finish_current": payload["finish_current"],
            "entries": [(str(e.pk), str(e.finish_before), str(e.finish_after)) for e in entries],
        }
        return Response(stamp_answer(payload, engine_inputs=inputs))


class ChangesetEntryReasonView(IdempotencyMixin, APIView):
    """PATCH /projects/{project_pk}/changeset/entries/{entry_pk}/ ``{reason}`` — answer once.

    Set-once: a second write is ``409 reason_already_set``. A given reason cannot
    be edited, only noted (Q3.6) — the trail is evidence. Answering closes the
    group, so a later act opens a new entry rather than reopening a reasoned one.
    Sends no notification (D11: notified once, on the change); the
    ``changeset.entry_reasoned`` webhook is the integrator's signal (#5121).
    """

    permission_classes = (
        IsAuthenticated,
        IsProjectScheduler,
        IsProjectNotArchived,
    )

    @extend_schema(
        summary="Answer a changeset entry's reason",
        request=ChangesetReasonSerializer,
        responses={
            200: ChangesetEntrySerializer,
            409: OpenApiResponse(description="`reason_already_set`: a reason is set once."),
        },
    )
    def patch(self, request: Request, project_pk: str, entry_pk: str) -> Response:
        project = _project(request, self, project_pk)
        body = ChangesetReasonSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        with transaction.atomic():
            entry = get_object_or_404(
                ChangesetEntry.objects.select_for_update(), pk=entry_pk, project_id=project.pk
            )
            if entry.reason is not None:
                return Response(
                    {"code": "reason_already_set", "detail": "This reason is already set."},
                    status=status.HTTP_409_CONFLICT,
                )
            now = timezone.now()
            entry.reason = body.validated_data["reason"]
            entry.reason_by = request.user  # type: ignore[assignment]  # IsAuthenticated above
            entry.reason_at = now
            entry.closed_at = entry.closed_at or now
            entry.save(update_fields=["reason", "reason_by", "reason_at", "closed_at"])
            # Set-once (the 409 above), so this fires at most once per entry.
            amend.announce_entry(project, entry, "changeset.entry_reasoned")
            amend.broadcast_changeset(project.pk)
        return Response(ChangesetEntrySerializer(entry).data)


class BaselineDecisionView(IdempotencyMixin, APIView):
    """GET/POST /projects/{project_pk}/baseline-decisions/ — the trail, and the two exits.

    POST takes v(n+1) or keeps v(n) in one transaction (``baselines.decide``). The
    two exits share one role floor and one endpoint on purpose: a product that
    only offers re-baseline teaches people to launder slip (UX-REVIEW §4).
    """

    #: Read by the schema generator so token auth is not advertised for the POST.
    token_refused_methods = frozenset({"POST"})

    def get_permissions(self) -> list[Any]:
        if self.request.method not in self.token_refused_methods:
            return [IsAuthenticated(), IsProjectMember()]
        return [
            IsAuthenticated(),
            IsNotTokenAuthenticated(),
            IsProjectAdmin(),
            IsProjectNotArchived(),
        ]

    @extend_schema(
        summary="List baseline decisions (taken / kept), newest first",
        responses={200: BaselineDecisionSerializer(many=True)},
    )
    def get(self, request: Request, project_pk: str) -> Response:
        project = _project(request, self, project_pk)
        rows = BaselineDecision.objects.filter(project_id=project.pk).select_related(
            "actor", "to_baseline"
        )
        return Response(BaselineDecisionSerializer(rows, many=True).data)

    @extend_schema(
        summary="Take a new baseline or keep the current one",
        request=BaselineDecisionWriteSerializer,
        responses={
            201: BaselineDecisionSerializer,
            409: OpenApiResponse(
                description=(
                    "`changeset_changed` (with `open_count`), `changeset_unreasoned` (with "
                    "`entries`), or `project_not_committed`."
                )
            ),
        },
    )
    def post(self, request: Request, project_pk: str) -> Response:
        from .models import ProjectLifecycle

        project = _project(request, self, project_pk)
        if project.lifecycle != ProjectLifecycle.ACTIVE:
            return Response(
                {"code": "project_not_committed", "detail": "Commit the plan first."},
                status=status.HTTP_409_CONFLICT,
            )
        body = BaselineDecisionWriteSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        v = body.validated_data
        try:
            row = baselines.decide(
                project,
                user=request.user,
                data=baselines.DecisionInput(
                    kind=v["kind"],
                    expected_open_count=v["expected_open_count"],
                    reason_code=v.get("reason_code"),
                    reason=(v.get("reason") or "").strip(),
                    note=(v.get("note") or "").strip(),
                    commitment_moved=v.get("commitment_moved", False),
                    decision_id=v.get("decision"),
                ),
            )
        except baselines.DecisionRefused as refused:
            return Response(refused.body, status=refused.status)
        assert isinstance(row, BaselineDecision)
        return Response(BaselineDecisionSerializer(row).data, status=status.HTTP_201_CREATED)


class BaselineDecisionPreviewView(APIView):
    """GET /projects/{project_pk}/baseline-decisions/preview/ — what taking v(n+1) would do.

    Computed by the same ``baselines.decide`` the POST runs, with ``dry_run``. It
    reads persisted CPM output and recomputes nothing.
    """

    permission_classes = (
        IsAuthenticated,
        IsProjectAdmin,
    )

    @extend_schema(summary="Preview taking a new baseline", responses={200: _PREVIEW_RESPONSE})
    def get(self, request: Request, project_pk: str) -> Response:
        project = _project(request, self, project_pk)
        result = baselines.decide(
            project,
            user=request.user,
            data=baselines.DecisionInput(kind=BaselineDecisionKind.TAKEN),
            dry_run=True,
        )
        assert isinstance(result, baselines.Preview)
        payload = result.as_dict()
        return Response(stamp_answer(payload, engine_inputs=payload))
