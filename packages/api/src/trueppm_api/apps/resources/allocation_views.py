"""``POST /allocations/``: check a booking, or save it (#4806, ADR-1500)."""

from __future__ import annotations

import logging
from typing import Any

from django.db import transaction
from django.utils import timezone
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import serializers, status
from rest_framework.exceptions import APIException, PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.permissions import (
    CanAssignResource,
    IsProjectMember,
    IsProjectNotArchived,
    TokenReadOnlyMethods,
    _membership_role,
    assert_project_not_archived,
)
from trueppm_api.apps.notifications.models import NotificationEventType
from trueppm_api.apps.notifications.services import create_event_notifications
from trueppm_api.apps.projects.models import Project
from trueppm_api.apps.resources.allocation import MAX_BOOKING_WEEKS, WITHHELD, build_verdict
from trueppm_api.apps.resources.models import ProjectResource, Resource
from trueppm_api.core.openapi import validation_envelope_400

logger = logging.getLogger(__name__)


class AllocationRequestSerializer(serializers.Serializer[dict[str, Any]]):
    """A proposed booking of one person on one project."""

    project = serializers.UUIDField()
    resource = serializers.UUIDField()
    share_pct = serializers.IntegerField(
        min_value=0,
        max_value=400,
        help_text="Share of full time held every week of the window. 0 removes the booking.",
    )
    start = serializers.DateField()
    end = serializers.DateField()
    accept_overage = serializers.BooleanField(default=False)
    reason = serializers.CharField(required=False, allow_blank=True, default="", max_length=500)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        """Bound the window, and refuse a bare accept."""
        if attrs["end"] < attrs["start"]:
            raise serializers.ValidationError({"end": "Must be on or after start."})
        if (attrs["end"] - attrs["start"]).days >= MAX_BOOKING_WEEKS * 7:
            raise serializers.ValidationError(
                {"end": f"A booking covers at most {MAX_BOOKING_WEEKS} weeks."}
            )
        # The move search looks past ``end``; keep it inside the date type's range.
        if not 2000 <= attrs["start"].year <= attrs["end"].year <= 2200:
            raise serializers.ValidationError({"start": "Dates must fall between 2000 and 2200."})
        if attrs["accept_overage"] and not attrs["reason"].strip():
            raise serializers.ValidationError({"reason": "Accepting an overage requires a reason."})
        return attrs


class AllocationContributionSerializer(serializers.Serializer[dict[str, Any]]):
    """One line of a breaking week's load."""

    kind = serializers.ChoiceField(
        choices=["this_change", "other_project", "other_work", "time_off"]
    )
    project_id = serializers.UUIDField(allow_null=True)
    project_name = serializers.CharField(allow_null=True)
    pct = serializers.FloatField(
        allow_null=True,
        help_text=(
            "Null only on `other_work`: load on projects whose per-person load you "
            "may not read is counted but never shown as a number."
        ),
    )


class AllocationBreakingWeekSerializer(serializers.Serializer[dict[str, Any]]):
    """The first week the booking takes the person over their ceiling."""

    week_start = serializers.DateField()
    load_pct = serializers.FloatField(allow_null=True)
    reason = serializers.ChoiceField(
        choices=[WITHHELD],
        allow_null=True,
        help_text=(
            "`withheld` when the figure includes load on a project whose per-person "
            "load you may not read; the figure is then null. Null otherwise."
        ),
    )
    contributions = AllocationContributionSerializer(many=True)


class AllocationWeekSerializer(serializers.Serializer[dict[str, Any]]):
    """One week of the proposed window."""

    week_start = serializers.DateField()
    load_pct = serializers.FloatField(allow_null=True)
    reason = serializers.ChoiceField(
        choices=[WITHHELD],
        allow_null=True,
        help_text=(
            "`withheld` when the figure includes load on a project whose per-person "
            "load you may not read; the figure is then null. Null otherwise."
        ),
    )
    over = serializers.BooleanField(help_text="With this change, the week is over the ceiling.")
    breaks = serializers.BooleanField(
        help_text=(
            "Over the ceiling and higher than without this change. Only a breaking "
            "week refuses a save; a week already over that this change does not raise "
            "is `over` but not `breaks`."
        )
    )


class AllocationResolutionSerializer(serializers.Serializer[dict[str, Any]]):
    """What one resolution would leave."""

    available = serializers.BooleanField()
    start = serializers.DateField(allow_null=True)
    end = serializers.DateField(allow_null=True)
    peak_pct = serializers.FloatField(allow_null=True)
    peak_reason = serializers.ChoiceField(
        choices=[WITHHELD],
        allow_null=True,
        help_text=(
            "`withheld` when the figure includes load on a project whose per-person "
            "load you may not read; the figure is then null. Null otherwise."
        ),
    )


class AllocationResolutionsSerializer(serializers.Serializer[dict[str, Any]]):
    """The offered ways out of a conflict."""

    shorten = AllocationResolutionSerializer()
    move = AllocationResolutionSerializer()
    accept = AllocationResolutionSerializer()


class AllocationVerdictSerializer(serializers.Serializer[dict[str, Any]]):
    """The server's verdict on a proposed booking."""

    fits = serializers.BooleanField()
    ceiling_pct = serializers.FloatField()
    peak_pct = serializers.FloatField(allow_null=True)
    peak_reason = serializers.ChoiceField(
        choices=[WITHHELD],
        allow_null=True,
        help_text=(
            "`withheld` when the figure includes load on a project whose per-person "
            "load you may not read; the figure is then null. Null otherwise."
        ),
    )
    first_breaking_week = AllocationBreakingWeekSerializer(allow_null=True)
    weeks = AllocationWeekSerializer(many=True)
    resolutions = AllocationResolutionsSerializer(allow_null=True)
    as_of = serializers.DateTimeField()
    definitions = serializers.DictField(child=serializers.CharField())


class AllocationResultSerializer(serializers.Serializer[dict[str, Any]]):
    """A dry run or a completed save."""

    dry_run = serializers.BooleanField()
    saved = serializers.BooleanField()
    allocation_id = serializers.UUIDField(
        allow_null=True, help_text="The roster entry holding the booking; null on a dry run."
    )
    verdict = AllocationVerdictSerializer()


class AllocationRefusalSerializer(serializers.Serializer[dict[str, Any]]):
    """Body of the 409 refusing an unaccepted overage."""

    code = serializers.CharField()
    detail = serializers.CharField()
    verdict = AllocationVerdictSerializer()


class AllocationErrorSerializer(serializers.Serializer[dict[str, Any]]):
    """Body of the 503 when the check could not complete."""

    code = serializers.CharField()
    detail = serializers.CharField()


class AllocationCheckUnavailable(APIException):
    """The check could not complete, so the change is held and nothing is saved."""

    status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    default_code = "allocation_check_unavailable"
    default_detail = "The allocation check could not complete. Nothing was saved."


def _check(**kwargs: Any) -> dict[str, Any]:
    try:
        return build_verdict(**kwargs)
    except Exception as exc:
        logger.exception("allocation check failed")
        raise AllocationCheckUnavailable(
            {
                "code": AllocationCheckUnavailable.default_code,
                "detail": AllocationCheckUnavailable.default_detail,
            }
        ) from exc


class AllocationView(APIView):
    """Check or save a booking (a weekly share of one person on one project).

    Resource Manager (Scheduler) or above on the project, for the dry run as well as
    the save. Accepting an overage needs the same role. Agent (read-only MCP) tokens
    are refused (agent access is #5146).

    Visibility mirrors ``/me/people-load/`` (ADR-1314): the person must be on the
    live roster of a live, non-draft project where the caller is Scheduler or above,
    and load on any project whose per-person load the caller may not read there
    (below Scheduler, or the ADR-0104 ``capacity`` signal not shared) is counted but
    never shown as a number (ADR-1500 §7). A person outside the scope gets the same 400 as one that
    does not exist, so the check is not a directory of who is booked where.
    """

    permission_classes = (
        IsAuthenticated,
        TokenReadOnlyMethods,
        IsProjectMember,
        CanAssignResource,
        IsProjectNotArchived,
    )
    resolves_scope_in_body = (
        "Flat route: the project arrives in the body. `post` applies the Scheduler+ "
        "floor and the archived check to it before reading any load."
    )

    @extend_schema(
        tags=["resources"],
        parameters=[
            OpenApiParameter(
                "dry_run",
                bool,
                description="1 returns the verdict and writes nothing.",
            )
        ],
        request=AllocationRequestSerializer,
        responses={
            200: AllocationResultSerializer,
            400: validation_envelope_400(
                "The body failed validation (field-keyed), `accept_overage` came "
                "without a `reason`, or `resource` is not on a roster you schedule "
                "(the same body as an unknown resource)."
            ),
            409: AllocationRefusalSerializer,
            503: AllocationErrorSerializer,
        },
    )
    def post(self, request: Request) -> Response:
        """Return the verdict; without ``dry_run``, also save the booking."""
        body = AllocationRequestSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        data = body.validated_data
        dry_run = serializers.BooleanField().to_internal_value(
            request.query_params.get("dry_run", "false")
        )

        role = _membership_role(request, data["project"])
        if role is None or role < Role.SCHEDULER:
            raise PermissionDenied("You need at least Resource Manager role to book people.")
        assert_project_not_archived(data["project"])
        project = Project.objects.select_related("calendar").get(pk=data["project"])
        schedulable, visible = self._scope(request)
        rostered = (
            ProjectResource.objects.active()
            .filter(resource_id=data["resource"], project_id__in=schedulable)
            .exists()
        )

        with transaction.atomic():
            resources = Resource.objects.filter(pk=data["resource"], is_deleted=False)
            if not dry_run:
                # Every save for one person queues here, so the load read below
                # includes any booking that committed first: two saves cannot jointly
                # exceed the ceiling.
                resources = resources.select_for_update(of=("self",))
            resource = resources.select_related("calendar").first()
            if resource is None or not rostered:
                # One message for both: a missing person and one outside the caller's
                # scope must be indistinguishable.
                raise ValidationError(
                    {"resource": "No active resource with this id on a roster you can read."}
                )
            verdict = _check(
                resource=resource,
                project=project,
                share_pct=data["share_pct"],
                start=data["start"],
                end=data["end"],
                visible_projects=visible,
            )
            result: dict[str, Any] = {
                "dry_run": dry_run,
                "saved": False,
                "allocation_id": None,
                "verdict": verdict,
            }
            if dry_run:
                return Response(result)
            # Removing a booking (0) is never refused: it cannot raise any week.
            over = not verdict["fits"] and data["share_pct"] > 0
            if over and not data["accept_overage"]:
                return Response(
                    {
                        "code": "allocation_over_ceiling",
                        "detail": "This booking exceeds the person's ceiling. Nothing was saved.",
                        "verdict": verdict,
                    },
                    status=status.HTTP_409_CONFLICT,
                )
            row = self._save(request, project, resource, data, verdict, accepted=over)
        result.update(saved=True, allocation_id=str(row.pk) if row else None)
        return Response(result)

    def _scope(self, request: Request) -> tuple[list[str], dict[str, str]]:
        """``(schedulable ids, {readable id: name})`` for the caller.

        The same two gates, in the same order, as ``MePeopleLoadView``. Gate 1,
        Scheduler or above on a live non-draft project (the gate on
        ``/projects/{id}/utilization/``), decides whom the caller may check: a person
        on one of those rosters. Gate 2, the ADR-0104 ``capacity`` signal, decides
        whose load the caller may read as a number. A project that passes gate 1 but
        not gate 2 still counts, as fits or does not fit only, so a team's policy
        withholds its figures without blocking its own Resource Manager from booking.
        """
        from trueppm_api.apps.projects.lifecycle import exclude_draft_projects
        from trueppm_api.apps.projects.signal_privacy_services import (
            can_read_signal_for_projects,
        )

        rows = exclude_draft_projects(
            ProjectMembership.objects.filter(
                user_id=request.user.pk or 0,
                is_deleted=False,
                project__is_deleted=False,
                role__gte=Role.SCHEDULER,
            )
        ).values_list("project_id", "project__name")
        names = {str(pid): name for pid, name in rows}
        readable = can_read_signal_for_projects(request, list(names), "capacity")
        return list(names), {pid: name for pid, name in names.items() if readable.get(pid)}

    def _save(
        self,
        request: Request,
        project: Project,
        resource: Resource,
        data: dict[str, Any],
        verdict: dict[str, Any],
        *,
        accepted: bool,
    ) -> ProjectResource | None:
        """Write the booking; record the overage when one was accepted.

        The accepted-overage record describes the current booking. A save that
        breaks no week but leaves one ``over`` (lowering a booking while the person
        stays over) keeps the record it already has; a save with no week over, or a
        removal, clears it. No load figure is stored: the record holds the week and
        the reason, never a percent that could include load its readers may not see.
        """
        booked = data["share_pct"] > 0
        row = ProjectResource.objects.filter(project=project, resource=resource).first()
        if row is None:
            row = ProjectResource(project=project, resource=resource)
            if not booked:
                return None  # nothing to remove; removing must not roster the person
        row.is_deleted = False
        row.deactivated_with_resource = False
        row.share_pct = data["share_pct"] if booked else None
        row.share_start = data["start"] if booked else None
        row.share_end = data["end"] if booked else None
        week = verdict["first_breaking_week"] if accepted else None
        still_over = booked and any(w["over"] for w in verdict["weeks"])
        if accepted and week:
            row.overage_reason = data["reason"].strip()
            row.overage_week = week["week_start"]
            row.overage_accepted_by_id = request.user.pk
            row.overage_accepted_at = timezone.now()
        elif not still_over:
            row.overage_reason = ""
            row.overage_week = None
            row.overage_accepted_by_id = None
            row.overage_accepted_at = None
        row.save()

        # The person is told in the same transaction as the booking they are told about.
        if accepted and week and resource.user_id and resource.user_id != request.user.pk:
            # The inbox blanks a project-scoped row for a non-member (#3510), and
            # being rostered is not membership. So a non-member gets an
            # account-scoped notice that does not name the project.
            member = ProjectMembership.objects.filter(
                project=project,
                user_id=resource.user_id,
                is_deleted=False,
                project__is_deleted=False,
            ).exists()
            where = project.name if member else "a project you are not a member of"
            create_event_notifications(
                event_type=NotificationEventType.ALLOCATION_OVERAGE_ACCEPTED,
                recipient_ids=[resource.user_id],
                subject=f"You are booked over capacity on {where}",
                body=(
                    f"A booking of {data['share_pct']}% from {data['start']} to {data['end']} "
                    # No load figure: it can include projects the booker cannot read.
                    f"takes you over your ceiling of {verdict['ceiling_pct']}%, first in "
                    f"the week of {week['week_start']}. "
                    f"Reason given: {row.overage_reason}"
                ),
                project_id=project.pk if member else None,
            )

        project_id = str(project.pk)
        resource_id = str(resource.pk)

        def _on_commit() -> None:
            from trueppm_api.apps.sync.broadcast import broadcast_board_event

            broadcast_board_event(project_id, "roster_changed", {"resource_id": resource_id})

        transaction.on_commit(_on_commit)
        return row
