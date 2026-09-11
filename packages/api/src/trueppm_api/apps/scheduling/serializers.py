"""Serializers for the scheduling app admin API."""

from __future__ import annotations

from typing import Any

from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from trueppm_api.apps.scheduling.models import (
    FailedTask,
    MonteCarloRun,
    ProjectForecastSnapshot,
    VelocitySuggestion,
)
from trueppm_api.apps.scheduling.services import (
    FORECAST_ALL_COMPLETE,
    FORECAST_ESTIMATES_OFF_CRITICAL_PATH,
    FORECAST_ESTIMATES_PENDING_APPROVAL,
    FORECAST_NO_COMMITTED_TASKS,
    FORECAST_NO_ESTIMATES,
    FORECAST_NO_VELOCITY_HISTORY,
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


class MonteCarloDeltaSerializer(serializers.Serializer[dict[str, Any]]):
    """Signed calendar-day delta of a percentile finish, per field (#987/#993/#2483).

    Positive means the field slipped later (worse). Shared shape for
    ``run_monte_carlo``/``latest``'s ``delta_vs_cpm`` (each percentile vs the
    deterministic CPM finish), the what-if endpoint's ``delta_vs_current``, and
    the history endpoint's per-run ``delta`` (ADR-0108) — one derivation, one
    schema, three call sites. ``None`` whenever either date it is measured
    between is missing.
    """

    p50 = serializers.IntegerField(allow_null=True)
    p80 = serializers.IntegerField(allow_null=True)
    p95 = serializers.IntegerField(allow_null=True)


class MonteCarloHistogramBucketSerializer(serializers.Serializer[dict[str, Any]]):
    """One ascending finish-date bucket of a Monte Carlo distribution."""

    date = serializers.DateField()
    count = serializers.IntegerField()


class MonteCarloConfidencePointSerializer(serializers.Serializer[dict[str, Any]]):
    """One point of the cumulative P(finish <= date) S-curve derived from the histogram."""

    date = serializers.DateField()
    pct = serializers.FloatField()


class MonteCarloSensitivitySerializer(serializers.Serializer[dict[str, Any]]):
    """One task's duration-sensitivity tornado entry (ADR-0140).

    ``index`` is the absolute Spearman rank correlation between the task's
    sampled duration and the project's finish, in [0, 1]. Tasks whose duration
    cannot vary the finish are omitted from the list entirely rather than
    reported as 0.
    """

    task_id = serializers.CharField()
    index = serializers.FloatField()


class MonteCarloDistributionFieldsSerializer(serializers.Serializer[dict[str, Any]]):
    """The ``{histogram_buckets, confidence_curve, sensitivity}`` shape (#1231).

    Mixed into :class:`MonteCarloForecastSerializer` as flat top-level fields
    (the live-run and ``latest`` payloads), and used standalone — nested under
    a ``distribution`` key — by :meth:`MonteCarloRunSerializer.get_distribution`
    for the history endpoint's opt-in ``?expand=distribution``. One field
    definition, two positions on the wire.
    """

    histogram_buckets = MonteCarloHistogramBucketSerializer(many=True)
    confidence_curve = MonteCarloConfidencePointSerializer(many=True)
    sensitivity = MonteCarloSensitivitySerializer(many=True)


class MonteCarloForecastDiagnosticSerializer(serializers.Serializer[dict[str, Any]]):
    """Why a Monte Carlo forecast carries -- or lacks -- an uncertainty band (#1340).

    ``reason`` is populated only when ``deterministic`` is true (the forecast
    collapsed to a single date); it is ``None`` whenever a real band exists.
    """

    deterministic = serializers.BooleanField()
    reason = serializers.ChoiceField(
        choices=[
            FORECAST_NO_COMMITTED_TASKS,
            FORECAST_ALL_COMPLETE,
            FORECAST_ESTIMATES_OFF_CRITICAL_PATH,
            FORECAST_ESTIMATES_PENDING_APPROVAL,
            FORECAST_NO_VELOCITY_HISTORY,
            FORECAST_NO_ESTIMATES,
        ],
        allow_null=True,
    )
    tasks_total = serializers.IntegerField()
    tasks_with_variance = serializers.IntegerField()
    tasks_pending_approval = serializers.IntegerField()
    agile_tasks_without_velocity = serializers.IntegerField()


class RiskPremiumFieldsSerializer(serializers.Serializer[dict[str, Any]]):
    """The flat ``risk_premium_*`` family shared by every forecast payload (ADR-0698).

    Mixed into :class:`MonteCarloForecastSerializer` rather than nested — the
    view spreads these keys directly onto the response dict (``**risk_premium_from_values(...)``),
    and the schema mirrors that shape.
    """

    risk_premium_days = serializers.IntegerField(allow_null=True)
    risk_premium_ratio = serializers.FloatField(allow_null=True)
    # Always null until #2299 (the calibration flywheel); declared nullable now so
    # the schema does not have to change shape when a band is first populated.
    risk_premium_band = serializers.CharField(allow_null=True)
    risk_premium_as_of = serializers.DateTimeField(allow_null=True)
    risk_premium_reason = serializers.CharField(allow_null=True)
    risk_premium_state = serializers.ChoiceField(
        choices=["not_run", "unmeasurable", "stale", "zero", "premium", "negative"]
    )
    risk_premium_cpm_finish = serializers.DateField(allow_null=True)
    risk_premium_p80 = serializers.DateField(allow_null=True)


class ForecastStalenessFieldsSerializer(serializers.Serializer[dict[str, Any]]):
    """The flat forecast-staleness family shared by every forecast payload (#3140).

    Mixed into :class:`MonteCarloForecastSerializer` for the same reason as
    :class:`RiskPremiumFieldsSerializer` — the view spreads
    ``**forecast_staleness_facts(...)`` directly onto the response dict.
    """

    forecast_staleness = serializers.ChoiceField(
        choices=["current", "project_changed", "aged", "unknown"]
    )
    plan_version = serializers.IntegerField(allow_null=True)
    plan_version_current = serializers.IntegerField(allow_null=True)


class MonteCarloForecastSerializer(
    RiskPremiumFieldsSerializer,
    ForecastStalenessFieldsSerializer,
    MonteCarloDistributionFieldsSerializer,
):
    """Monte Carlo forecast payload shared by the live run and the ``latest`` read.

    Two response-producing paths share this exact shape and are not identical on
    the wire:

    - The **live run** (``POST .../monte-carlo/``) and a **cache hit**
      (``GET .../monte-carlo/latest/`` inside the 24h TTL) always carry
      ``distribution`` (the full sorted per-run finish-date sample — the large
      field) and never carry ``from_history``.
    - The **persisted-history fallback** (``GET .../latest/`` once the cache
      entry has expired, ADR-0175) always carries ``from_history: true`` and
      never carries ``distribution`` — only the derived
      ``histogram_buckets``/``confidence_curve``/``sensitivity`` (and
      ``forecast_diagnostic``) survive past the TTL, and only for runs
      persisted after #1231/#2483.

    Both fields are declared ``required=False`` rather than modeled as two
    named variants (``PolymorphicProxySerializer``): nothing else about the
    shape differs between the two paths, so a discriminated union would only
    duplicate every other field for no added precision.
    """

    project_id = serializers.CharField()
    runs = serializers.IntegerField()
    # Nullable: a project with no committed tasks yields no distribution to
    # anchor the percentiles on (mirrors MonteCarloRun.p50/p80/p95).
    p50 = serializers.DateField(allow_null=True)
    p80 = serializers.DateField(allow_null=True)
    p95 = serializers.DateField(allow_null=True)
    distribution = serializers.ListField(
        child=serializers.DateField(),
        required=False,
        help_text=(
            "Full sorted per-run finish-date sample. Present on a live run or a "
            "cache hit; absent on the persisted-history fallback."
        ),
    )
    cpm_finish = serializers.DateField(allow_null=True)
    delta_vs_cpm = MonteCarloDeltaSerializer()
    forecast_diagnostic = MonteCarloForecastDiagnosticSerializer(allow_null=True)
    last_run_at = serializers.DateTimeField()
    status_date = serializers.DateField(allow_null=True)
    from_history = serializers.BooleanField(
        required=False,
        help_text=(
            "True only on the persisted-history fallback past the 24h cache TTL; "
            "absent (never false) on a live run or cache hit."
        ),
    )


class MonteCarloWhatIfAppliedSerializer(serializers.Serializer[dict[str, Any]]):
    """The resolved perturbation the what-if endpoint applied to the target task (#993)."""

    base_duration_days = serializers.IntegerField()
    duration_delta_days = serializers.IntegerField()
    new_duration_days = serializers.IntegerField()


class MonteCarloWhatIfLegSerializer(serializers.Serializer[dict[str, Any]]):
    """One forecast leg (``current`` or ``whatif``) of the what-if response (#993)."""

    p50 = serializers.DateField()
    p80 = serializers.DateField()
    p95 = serializers.DateField()
    cpm_finish = serializers.DateField(allow_null=True)
    critical_path = serializers.ListField(child=serializers.CharField())


class MonteCarloWhatIfDeltaSerializer(serializers.Serializer[dict[str, Any]]):
    """Signed calendar-day shift of ``whatif`` vs ``current``, per field (#993).

    Same ``p50``/``p80``/``p95`` shape as :class:`MonteCarloDeltaSerializer`,
    plus ``cpm_finish`` — the what-if endpoint's own deterministic-pass delta,
    distinct from ``delta_vs_cpm``'s MC-vs-CPM comparison elsewhere.
    """

    p50 = serializers.IntegerField(allow_null=True)
    p80 = serializers.IntegerField(allow_null=True)
    p95 = serializers.IntegerField(allow_null=True)
    cpm_finish = serializers.IntegerField(allow_null=True)


class MonteCarloWhatIfResponseSerializer(serializers.Serializer[dict[str, Any]]):
    """Non-mutating Monte Carlo what-if result (#993).

    Perturbs exactly one committed task's duration and recomputes both the
    deterministic CPM pass and a seeded Monte Carlo simulation in memory,
    without persisting anything — see the view docstring for the
    non-persistence guarantee.
    """

    task_id = serializers.CharField()
    applied = MonteCarloWhatIfAppliedSerializer()
    current = MonteCarloWhatIfLegSerializer()
    whatif = MonteCarloWhatIfLegSerializer()
    critical_path_changed = serializers.BooleanField()
    delta_vs_current = MonteCarloWhatIfDeltaSerializer()
    runs = serializers.IntegerField()
    seed = serializers.IntegerField(
        help_text="Fixed RNG seed shared by both runs so the delta isolates the perturbation."
    )
    cpm_status_date = serializers.DateField()
    mc_status_date = serializers.DateField()


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
            "project_id",
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
            "status_date",
            "delta",
            "triggered_by_name",
            "distribution",
        ]
        read_only_fields = fields

    @extend_schema_field(MonteCarloDeltaSerializer(allow_null=True))
    def get_delta(self, obj: MonteCarloRun) -> dict[str, int | None] | None:
        """Return the per-percentile day delta vs the previous run (view-attached)."""
        return getattr(obj, "_delta", None)

    @extend_schema_field(serializers.CharField(allow_null=True))
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

    @extend_schema_field(MonteCarloDistributionFieldsSerializer(allow_null=True))
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
