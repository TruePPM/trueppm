"""Serializers for the scheduling app admin API."""

from __future__ import annotations

from typing import Any

from rest_framework import serializers

from trueppm_api.apps.scheduling.models import (
    FailedTask,
    MonteCarloRun,
    ProjectForecastSnapshot,
    VelocitySuggestion,
)


class MonteCarloWhatIfRequestSerializer(serializers.Serializer[dict[str, Any]]):
    """Validate the non-mutating Monte Carlo what-if query (#993).

    The what-if endpoint perturbs exactly one task's duration and recomputes the
    forecast in memory without persisting anything, so this is a *request* (query
    param) validator only — there is no model behind it. The caller must supply a
    ``task_id`` and exactly one of ``duration_delta`` (signed day offset applied to
    the task's current duration) or ``new_duration`` (an absolute day count the
    task's duration is set to). Requiring exactly one keeps the perturbation
    unambiguous — a request carrying both, or neither, cannot express a single
    well-defined schedule and is rejected up front rather than resolved by a silent
    precedence rule.
    """

    task_id = serializers.UUIDField()
    duration_delta = serializers.IntegerField(required=False)
    new_duration = serializers.IntegerField(required=False, min_value=0)
    n_simulations = serializers.IntegerField(required=False, min_value=1)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        has_delta = "duration_delta" in attrs
        has_absolute = "new_duration" in attrs
        if has_delta == has_absolute:
            raise serializers.ValidationError(
                "Supply exactly one of 'duration_delta' or 'new_duration'."
            )
        return attrs


class ProjectForecastSnapshotSerializer(serializers.ModelSerializer[ProjectForecastSnapshot]):
    """Read-only serializer for a project-grain forecast snapshot (ADR-0154, #388).

    Server-generated history; the endpoint is list-only, so every field is
    read-only and there is no create/update path.
    """

    class Meta:
        model = ProjectForecastSnapshot
        fields = [
            "id",
            "captured_at",
            "triggered_by",
            "cpm_finish",
            "total_float_days",
            "mc_p50_finish",
            "mc_p80_finish",
            "mc_p95_finish",
            "mc_iterations",
            "task_count",
            "completed_task_count",
        ]
        read_only_fields = fields


class FailedTaskSerializer(serializers.ModelSerializer[FailedTask]):
    """Read-only serializer for the failed-task dead-letter queue.

    Exposed by the admin API so operators can inspect and requeue or discard
    tasks that exceeded their retry budget. The ``resolution_*`` fields surface the
    operator-action audit (ADR-0210): who requeued/dropped the task, when, and the
    drop note.
    """

    resolved_by_display = serializers.SerializerMethodField()

    class Meta:
        model = FailedTask
        fields = [
            "id",
            "task_name",
            "task_id",
            "args",
            "kwargs",
            "exception_type",
            "exception_message",
            "traceback",
            "failure_count",
            "first_failed_at",
            "last_failed_at",
            "status",
            "resolution_note",
            "resolved_by_display",
            "resolved_at",
        ]
        read_only_fields = fields

    def get_resolved_by_display(self, obj: FailedTask) -> str | None:
        """Display name of the operator who last acted, or None if unresolved."""
        user: Any = obj.resolved_by
        if user is None:
            return None
        full_name = user.get_full_name() if hasattr(user, "get_full_name") else ""
        return full_name or user.get_username()


class FailedTaskRequeueSerializer(serializers.Serializer[dict[str, Any]]):
    """Validate the requeue-with-backoff request body (ADR-0210).

    ``backoff_seconds`` is the operator-chosen delay applied as a Celery
    ``countdown`` on the re-dispatched task. Bounded to a day so a fat-fingered
    value cannot park a task for a year; ``0`` means dispatch immediately.
    """

    backoff_seconds = serializers.IntegerField(
        required=False,
        default=0,
        min_value=0,
        max_value=86_400,
        help_text="Backoff before re-dispatch, in seconds (0-86400). 0 = immediate.",
    )


class FailedTaskDropSerializer(serializers.Serializer[dict[str, Any]]):
    """Validate the drop-with-note request body (ADR-0210).

    ``note`` is optional free-text audit context. Bounded and trimmed; stored as
    data and rendered as text (never interpolated into task args), so it carries no
    injection surface.
    """

    note = serializers.CharField(
        required=False,
        allow_blank=True,
        default="",
        max_length=1000,
        trim_whitespace=True,
        help_text="Optional audit note recorded with the drop.",
    )


class VelocitySuggestionSerializer(serializers.ModelSerializer[VelocitySuggestion]):
    """Read serializer for a velocity-calibration suggestion (ADR-0065).

    Surfaces the sprint that triggered the suggestion (name + id) so the Task
    Detail Drawer can render "Suggested from Sprint 12 close" without a second
    fetch.  The accept/dismiss audit fields are exposed so the drawer can also
    render a quiet history row once a decision is made.
    """

    sprint_name = serializers.CharField(source="sprint.name", read_only=True)
    sprint_id = serializers.UUIDField(source="sprint.id", read_only=True)
    is_pending = serializers.BooleanField(read_only=True)
    # Both team_velocity_per_day and suggested_duration are declared explicitly with
    # allow_null because to_representation nulls them for readers below the velocity
    # audience (ADR-0104 gate, #949/#1099) — the schema must advertise the suppressed
    # shape for schema-driven clients (#997 contract class).
    team_velocity_per_day = serializers.DecimalField(
        max_digits=6,
        decimal_places=3,
        read_only=True,
        allow_null=True,
        help_text="Rolling 6-sprint average of completed_points / sprint_working_days.",
    )
    # suggested_duration is computed *from* team_velocity_per_day
    # (round(story_points / velocity)); leaving it ungated lets a below-audience
    # reader back into the team's pace via the calibration value, so it is gated by
    # the same velocity check (#1099 — a new instance of the #949 leak class).
    suggested_duration = serializers.IntegerField(
        read_only=True,
        allow_null=True,
        help_text=(
            "Velocity-calibrated duration in working days; null when the reader is "
            "below the velocity audience."
        ),
    )

    class Meta:
        model = VelocitySuggestion
        fields = [
            "id",
            "task",
            "sprint_id",
            "sprint_name",
            "suggested_duration",
            "team_velocity_per_day",
            "flag_for_review",
            "is_pending",
            "created_at",
            "accepted_at",
            "accepted_by",
            "dismissed_at",
            "dismissed_by",
        ]
        read_only_fields = fields

    # Velocity-derived fields stripped for a reader below the velocity audience.
    # team_velocity_per_day is the raw rate; suggested_duration is computed from it
    # (#1099) — both must fall to the same gate or the rate leaks via the suggestion.
    _VELOCITY_GATED_FIELDS = ("team_velocity_per_day", "suggested_duration")

    def to_representation(self, instance: VelocitySuggestion) -> dict[str, Any]:
        data = super().to_representation(instance)
        # ADR-0104 velocity gate (#949/#1099): these are the same point-based velocity
        # number — and a value derived from it — that suppress_velocity_summary strips
        # from /velocity/. A reader below the velocity audience is suppressed there, so
        # they must not recover it from this calibration-suggestion surface.
        request = self.context.get("request")
        # Fail closed: a render with no request context can't establish the
        # reader's tier, so suppress rather than leak (the only callers are HTTP
        # responses, which always carry a request).
        if request is None:
            for field in self._VELOCITY_GATED_FIELDS:
                data[field] = None
            return data
        # The verdict is per-project; cache it on the (reused) child serializer so
        # a list render is not N+1 on the gate query.
        project_id = instance.task.project_id
        cache: dict[Any, bool] | None = getattr(self, "_velocity_gate_cache", None)
        if cache is None:
            cache = {}
            self._velocity_gate_cache = cache
        if project_id not in cache:
            from trueppm_api.apps.projects.signal_privacy_services import can_read_signal

            cache[project_id] = can_read_signal(request, project_id, "velocity")
        if not cache[project_id]:
            for field in self._VELOCITY_GATED_FIELDS:
                data[field] = None
        return data


class MonteCarloRunSerializer(serializers.ModelSerializer[MonteCarloRun]):
    """Read serializer for one project Monte Carlo run in the forecast history (ADR-0175).

    Two pieces of context the view must supply:

    - ``delta`` is computed-on-read (ADR-0108): the view attaches ``_delta`` to
      each instance — a ``{"p50"|"p80"|"p95": signed-int-days|None}`` map of the
      change versus the immediately-previous (older) run, or ``None`` on the
      oldest/baseline row. Positive = the forecast slipped later (worse).
    - ``triggered_by_name`` ("who ran it") is emitted **only** when the context
      flag ``can_see_attribution`` is true (requester is Admin/Owner). For every
      other member the field is ``None`` so forecast drift cannot be read as a
      named-individual performance signal (VoC Morgan). The FK is never exposed
      directly; only a display name, and only to admins.
    """

    delta = serializers.SerializerMethodField()
    triggered_by_name = serializers.SerializerMethodField()
    distribution = serializers.SerializerMethodField()

    class Meta:
        model = MonteCarloRun
        fields = [
            "id",
            "taken_at",
            "p50",
            "p80",
            "p95",
            "cpm_finish",
            "n_simulations",
            "task_count",
            "delta",
            "triggered_by_name",
            "distribution",
        ]
        read_only_fields = fields

    def get_delta(self, obj: MonteCarloRun) -> dict[str, int | None] | None:
        """Return the per-percentile day delta vs the previous run (view-attached)."""
        return getattr(obj, "_delta", None)

    def get_triggered_by_name(self, obj: MonteCarloRun) -> str | None:
        """Run-author display name — gated by the resolved attribution audience.

        The view sets ``can_see_attribution`` per the workspace-effective
        ``mc_history_attribution_audience`` (ADR-0144): ADMIN_OWNER → Admin/Owner,
        SCHEDULER_PLUS → Scheduler+, NONE → nobody. None when the reader is below
        the audience so forecast drift cannot become a named-individual signal.
        """
        if not self.context.get("can_see_attribution"):
            return None
        user: Any = obj.triggered_by
        if user is None:
            return None
        full_name = user.get_full_name() if hasattr(user, "get_full_name") else ""
        return full_name or user.get_username()

    def get_distribution(self, obj: MonteCarloRun) -> dict[str, Any] | None:
        """The persisted per-run distribution — only when explicitly expanded (#1231).

        Returns the stored ``{histogram_buckets, confidence_curve, sensitivity}``
        payload (snake_case, matching the ``/latest/`` response shape) ONLY when the
        view sets ``context['expand_distribution']`` — the history *list* stays
        lightweight by default and a single detail fetch opts in via
        ``?expand=distribution``. ``None`` for legacy runs with no stored
        distribution, or whenever the flag is unset.
        """
        if not self.context.get("expand_distribution"):
            return None
        return obj.distribution
