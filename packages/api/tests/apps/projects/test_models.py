"""Model tests for the projects app — require a real PostgreSQL instance."""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.utils import timezone

from trueppm_api.apps.projects.models import (
    AcceptanceCriterion,
    ApiToken,
    ApiTokenAuditAction,
    ApiTokenAuditEntry,
    BacklogItem,
    Baseline,
    BaselineTask,
    BlockerType,
    BoardColumnConfig,
    BoardSavedView,
    Calendar,
    CalendarException,
    CalendarRole,
    CeremonyCadenceType,
    CeremonyTemplate,
    CommentAcknowledgement,
    CommentReaction,
    CrossProjectSlipConflict,
    CustomFieldType,
    Dependency,
    ForecastBasis,
    ForecastConfidence,
    ForecastSnapshot,
    GuardrailLevel,
    GuardrailPolicySource,
    GuardrailRule,
    ImmutableModelError,
    InboundTaskLink,
    Label,
    PhaseGateConfig,
    PokerSession,
    PokerVote,
    Program,
    ProgramExportJob,
    Project,
    ProjectCalendarLayer,
    ProjectCustomField,
    ProjectDecisionsPolicy,
    ProjectExportJob,
    ProjectGuardrailPolicy,
    ProjectSignalPrivacyPolicy,
    PulseResponse,
    RecurrenceEndType,
    RetroActionItem,
    RetroBoardItem,
    RetroColumn,
    Risk,
    RiskComment,
    RiskTask,
    ShareLink,
    SignalAudience,
    SignalCeilingRaiseProposal,
    SignalCeilingRaiseVote,
    SlipConflictResolution,
    Sprint,
    SprintBurnSnapshot,
    SprintCloseRequest,
    SprintRetro,
    SprintScopeChange,
    SprintState,
    SprintTaskDisposition,
    SprintTaskOutcome,
    Task,
    TaskActivityEvent,
    TaskActivityEventType,
    TaskAttachment,
    TaskComment,
    TaskCustomFieldValue,
    TaskDurationChangeEvent,
    TaskLabel,
    TaskNote,
    TaskRecurrenceFrequency,
    TaskRecurrenceRule,
    TaskRelation,
    TaskStatus,
    TaskSuggestedAssignee,
    _member_role_choices,
    _next_risk_short_id,
    _next_short_id,
    _task_attachment_upload_to,
    cascade_project_children_restore,
    cascade_project_children_soft_delete,
    cascade_task_children_restore,
    committed_sprint_tasks,
    project_span_days,
    signal_audience_rank,
    task_is_phase,
    three_point_estimates_ordered,
    validate_project_span,
    validate_working_day_mask,
)

User = get_user_model()


@pytest.mark.django_db
class TestCalendar:
    def test_str(self) -> None:
        cal = Calendar(name="Standard")
        assert str(cal) == "Standard"

    def test_defaults(self) -> None:
        cal = Calendar(name="Test")
        assert cal.working_days == 31  # Mon–Fri
        assert cal.hours_per_day == 8.0
        assert cal.timezone == "UTC"

    def test_create_and_retrieve(self) -> None:
        cal = Calendar.objects.create(name="Custom", working_days=63, hours_per_day=9.0)
        retrieved = Calendar.objects.get(pk=cal.pk)
        assert retrieved.name == "Custom"
        assert retrieved.working_days == 63

    def test_server_version_increments_on_update(self) -> None:
        cal = Calendar.objects.create(name="V test")
        # INSERT now sets server_version=1 so sync since=0 returns all rows.
        assert cal.server_version == 1
        cal.name = "V test updated"
        cal.save()
        cal.refresh_from_db()
        assert cal.server_version == 2


@pytest.mark.django_db
class TestCalendarException:
    def test_create(self) -> None:
        cal = Calendar.objects.create(name="Cal")
        exc = CalendarException.objects.create(
            calendar=cal,
            exc_start=date(2026, 12, 25),
            exc_end=date(2026, 12, 26),
            description="Christmas",
        )
        assert exc.description == "Christmas"
        assert CalendarException.objects.filter(calendar=cal).count() == 1


@pytest.mark.django_db
class TestProject:
    def test_str(self) -> None:
        cal = Calendar.objects.create(name="Cal")
        p = Project(name="Alpha", start_date=date(2026, 3, 2), calendar=cal)
        assert str(p) == "Alpha"

    def test_create_without_calendar(self) -> None:
        p = Project.objects.create(name="No Cal", start_date=date(2026, 1, 1))
        assert p.calendar is None

    def test_ordering(self) -> None:
        Project.objects.create(name="B", start_date=date(2026, 2, 1))
        Project.objects.create(name="A", start_date=date(2026, 1, 1))
        names = list(Project.objects.values_list("name", flat=True))
        assert names == ["A", "B"]


@pytest.mark.django_db
class TestTask:
    def setup_method(self) -> None:
        self.project = Project.objects.create(name="P", start_date=date(2026, 3, 2))

    def test_str(self) -> None:
        t = Task(project=self.project, name="Design")
        assert "Design" in str(t)
        assert "P" in str(t)

    def test_defaults(self) -> None:
        t = Task.objects.create(project=self.project, name="T1")
        assert t.duration == 1
        assert t.percent_complete == 0.0
        assert t.is_critical is None
        assert t.early_start is None

    def test_wbs_path_stored_and_retrieved(self) -> None:
        t = Task.objects.create(project=self.project, name="T1", wbs_path="1.2.3")
        t.refresh_from_db()
        assert t.wbs_path == "1.2.3"

    def test_cpm_fields_writable(self) -> None:
        t = Task.objects.create(
            project=self.project,
            name="T2",
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 6),
            is_critical=True,
            total_float=0,
        )
        t.refresh_from_db()
        assert t.early_start == date(2026, 3, 2)
        assert t.is_critical is True

    def test_pert_fields(self) -> None:
        t = Task.objects.create(
            project=self.project,
            name="T3",
            optimistic_duration=3,
            most_likely_duration=5,
            pessimistic_duration=10,
        )
        t.refresh_from_db()
        assert t.optimistic_duration == 3
        assert t.pessimistic_duration == 10


@pytest.mark.django_db
class TestTaskSoftDelete:
    """Task.soft_delete() — tombstone, server_version bump, CommittedTaskManager exclusion."""

    def setup_method(self) -> None:
        self.project = Project.objects.create(name="SoftDelProj", start_date=date(2026, 3, 2))

    def test_tombstone_set(self) -> None:
        t = Task.objects.create(project=self.project, name="T", duration=1)
        t.soft_delete()
        t.refresh_from_db()
        assert t.is_deleted is True

    def test_server_version_bumped(self) -> None:
        t = Task.objects.create(project=self.project, name="T", duration=1)
        version_before = t.server_version
        t.soft_delete()
        t.refresh_from_db()
        assert t.server_version > version_before

    def test_excluded_from_committed_queryset(self) -> None:
        t = Task.objects.create(project=self.project, name="T", duration=1)
        assert Task.committed.filter(pk=t.pk).exists()
        t.soft_delete()
        assert not Task.committed.filter(pk=t.pk).exists()

    def test_dependency_edges_soft_deleted(self) -> None:
        t1 = Task.objects.create(project=self.project, name="A", duration=1)
        t2 = Task.objects.create(project=self.project, name="B", duration=1)
        dep = Dependency.objects.create(predecessor=t1, successor=t2)
        t1.soft_delete()
        dep.refresh_from_db()
        assert dep.is_deleted is True

    def test_deleted_at_stamped(self) -> None:
        """soft_delete() stamps deleted_at — the tombstone-reap age_field (sync/tasks.py)."""
        t = Task.objects.create(project=self.project, name="T", duration=1)
        assert t.deleted_at is None
        t.soft_delete()
        t.refresh_from_db()
        assert t.deleted_at is not None

    def test_cascaded_dependency_stamps_its_own_deleted_at(self) -> None:
        """A cascade-soft-deleted Dependency edge stamps its own deleted_at.

        Each cascaded row calls its own soft_delete() rather than inheriting the
        parent's timestamp — the dependency's retention grace period should be
        measured from when the edge itself was tombstoned.
        """
        t1 = Task.objects.create(project=self.project, name="A", duration=1)
        t2 = Task.objects.create(project=self.project, name="B", duration=1)
        dep = Dependency.objects.create(predecessor=t1, successor=t2)
        assert dep.deleted_at is None
        t1.soft_delete()
        dep.refresh_from_db()
        assert dep.deleted_at is not None


@pytest.mark.django_db
class TestTaskWbsPathUniqueConstraint:
    """DB-level UniqueConstraint on (project, wbs_path) for live tasks (#3048).

    ``wbs_path`` is the ONLY parenthood/ordering mechanism for the WBS tree — there
    is no ``parent_id`` column (see ``structural_parent()``'s docstring) — so
    nothing previously stopped two live tasks in the same project from silently
    sharing a path. A duplicate corrupted the next ``rewrite_level`` pass instead of
    raising anywhere; this constraint makes it a hard DB error at write time.
    """

    def setup_method(self) -> None:
        self.project = Project.objects.create(name="WbsUniq", start_date=date(2026, 3, 2))

    def test_duplicate_live_wbs_path_same_project_raises(self) -> None:
        from django.db import IntegrityError

        Task.objects.create(project=self.project, name="A", wbs_path="1")
        with pytest.raises(IntegrityError):
            Task.objects.create(project=self.project, name="B", wbs_path="1")

    def test_update_onto_colliding_live_wbs_path_raises(self) -> None:
        """The constraint also catches a collision introduced by an UPDATE, not just INSERT."""
        from django.db import IntegrityError

        Task.objects.create(project=self.project, name="A", wbs_path="1")
        b = Task.objects.create(project=self.project, name="B", wbs_path="2")
        b.wbs_path = "1"
        with pytest.raises(IntegrityError):
            b.save(update_fields=["wbs_path"])

    def test_distinct_wbs_paths_same_project_allowed(self) -> None:
        Task.objects.create(project=self.project, name="A", wbs_path="1")
        Task.objects.create(project=self.project, name="B", wbs_path="2")
        Task.objects.create(project=self.project, name="C", wbs_path="1.1")
        assert Task.objects.filter(project=self.project).count() == 3

    def test_same_wbs_path_different_projects_allowed(self) -> None:
        """Scoped per-project — two projects numbering from '1' never collide."""
        other = Project.objects.create(name="Other", start_date=date(2026, 3, 2))
        Task.objects.create(project=self.project, name="A", wbs_path="1")
        Task.objects.create(project=other, name="A", wbs_path="1")
        assert Task.objects.filter(wbs_path="1").count() == 2

    def test_soft_deleted_wbs_path_freed_for_reuse(self) -> None:
        """A tombstoned task's path does not block a new live task from taking it.

        Scoped ``is_deleted=False``, matching every other partial index on this
        model: a soft-deleted row keeps its old path for tombstone/history purposes,
        and that path must be free for reassignment to a new live task.
        """
        original = Task.objects.create(project=self.project, name="A", wbs_path="1")
        original.soft_delete()
        # Must not raise — the tombstoned row is excluded from the constraint.
        Task.objects.create(project=self.project, name="B", wbs_path="1")

    def test_multiple_null_wbs_paths_allowed(self) -> None:
        """Subtasks / recurrence templates with no wbs_path stay unconstrained (NULLS DISTINCT)."""
        Task.objects.create(project=self.project, name="A", wbs_path=None)
        Task.objects.create(project=self.project, name="B", wbs_path=None)
        assert Task.objects.filter(project=self.project, wbs_path__isnull=True).count() == 2


@pytest.mark.django_db
class TestDependency:
    def setup_method(self) -> None:
        self.project = Project.objects.create(name="P", start_date=date(2026, 3, 2))
        self.t1 = Task.objects.create(project=self.project, name="A", duration=5)
        self.t2 = Task.objects.create(project=self.project, name="B", duration=3)

    def test_create_fs(self) -> None:
        dep = Dependency.objects.create(predecessor=self.t1, successor=self.t2)
        assert dep.dep_type == "FS"
        assert dep.lag == 0

    def test_create_with_lag(self) -> None:
        dep = Dependency.objects.create(predecessor=self.t1, successor=self.t2, lag=2)
        assert dep.lag == 2

    def test_unique_constraint(self) -> None:
        from django.db import IntegrityError

        Dependency.objects.create(predecessor=self.t1, successor=self.t2, dep_type="FS")
        with pytest.raises(IntegrityError):
            Dependency.objects.create(predecessor=self.t1, successor=self.t2, dep_type="FS")

    def test_str(self) -> None:
        dep = Dependency(predecessor=self.t1, successor=self.t2, dep_type="FS", lag=0)
        assert "FS" in str(dep)


@pytest.mark.django_db
class TestDependencySoftDelete:
    """Dependency.soft_delete() — tombstone, server_version bump, deleted_at stamp."""

    def setup_method(self) -> None:
        self.project = Project.objects.create(name="DepSoftDelProj", start_date=date(2026, 3, 2))
        self.t1 = Task.objects.create(project=self.project, name="A", duration=1)
        self.t2 = Task.objects.create(project=self.project, name="B", duration=1)

    def test_tombstone_set(self) -> None:
        dep = Dependency.objects.create(predecessor=self.t1, successor=self.t2)
        dep.soft_delete()
        dep.refresh_from_db()
        assert dep.is_deleted is True

    def test_server_version_bumped(self) -> None:
        dep = Dependency.objects.create(predecessor=self.t1, successor=self.t2)
        version_before = dep.server_version
        dep.soft_delete()
        dep.refresh_from_db()
        assert dep.server_version > version_before

    def test_deleted_at_stamped(self) -> None:
        """soft_delete() stamps deleted_at — the tombstone-reap age_field (sync/tasks.py)."""
        dep = Dependency.objects.create(predecessor=self.t1, successor=self.t2)
        assert dep.deleted_at is None
        dep.soft_delete()
        dep.refresh_from_db()
        assert dep.deleted_at is not None


# ===========================================================================
# #2459 — branch coverage for the model helpers, invariants, and reprs that
# the endpoint suites never reach.
# ===========================================================================


MONDAY = date(2026, 1, 5)


@pytest.fixture
def project(db: object) -> Project:
    """A plain project with a Mon–Fri calendar — the root of most fixtures below."""
    cal = Calendar.objects.create(name="Std", working_days=31, hours_per_day=8.0)
    return Project.objects.create(name="P", start_date=MONDAY, calendar=cal)


@pytest.fixture
def user(db: object) -> Any:
    return User.objects.create_user(username="member", password="pw")


# ---------------------------------------------------------------------------
# Module-level validators and helpers
# ---------------------------------------------------------------------------


def _mask_errors(value: int) -> list[str]:
    """Messages ``validate_working_day_mask`` raises for ``value`` (empty = accepted)."""
    try:
        validate_working_day_mask(value)
    except ValidationError as exc:
        return list(exc.messages)
    return []


@pytest.mark.django_db
class TestValidateWorkingDayMask:
    def test_default_mon_fri_mask_is_accepted(self) -> None:
        assert _mask_errors(31) == []

    def test_single_weekday_mask_is_accepted(self) -> None:
        assert _mask_errors(1) == []

    def test_empty_mask_is_rejected(self) -> None:
        """A mask with no working day would spin the CPM calendar walk (#749)."""
        with pytest.raises(ValidationError, match="at least one weekday"):
            validate_working_day_mask(0)

    def test_mask_setting_only_bits_above_sunday_is_rejected(self) -> None:
        """Bits >= 7 are not weekdays, so 128 is as empty as 0."""
        with pytest.raises(ValidationError, match="at least one weekday"):
            validate_working_day_mask(128)

    def test_calendar_full_clean_surfaces_the_field_error(self) -> None:
        """The validator is wired onto Calendar.working_days, not just importable."""
        with pytest.raises(ValidationError) as exc:
            Calendar(name="Broken", working_days=0).full_clean()
        assert "working_days" in exc.value.message_dict

    def test_calendar_with_a_valid_mask_persists(self) -> None:
        cal = Calendar(name="Weekend crew", working_days=32 | 64)
        cal.full_clean()
        cal.save()
        assert Calendar.objects.get(pk=cal.pk).working_days == 96


class TestThreePointEstimatesOrdered:
    def test_fully_ordered_triple_is_valid(self) -> None:
        assert three_point_estimates_ordered(3, 5, 10) is True

    def test_equal_values_are_valid(self) -> None:
        assert three_point_estimates_ordered(5, 5, 5) is True

    def test_out_of_order_triple_is_invalid(self) -> None:
        """The exact state the scheduler's _validate_project rejects at compute time."""
        assert three_point_estimates_ordered(10, 5, 3) is False

    def test_most_likely_above_pessimistic_is_invalid(self) -> None:
        assert three_point_estimates_ordered(1, 9, 5) is False

    @pytest.mark.parametrize(
        "triple", [(None, 5, 10), (3, None, 10), (3, 5, None), (None, None, None)]
    )
    def test_incomplete_triple_is_ignored_under_the_all_or_none_rule(
        self, triple: tuple[int | None, int | None, int | None]
    ) -> None:
        assert three_point_estimates_ordered(*triple) is True


@pytest.mark.django_db
class TestProjectSpan:
    def test_span_sums_task_durations_and_absolute_dependency_lags(self, project: Project) -> None:
        a = Task.objects.create(project=project, name="A", duration=5)
        b = Task.objects.create(project=project, name="B", duration=3)
        Dependency.objects.create(predecessor=a, successor=b, lag=-4)
        # 5 + 3 durations, plus |−4| lag.
        assert project_span_days(project.pk) == 12

    def test_excluded_task_is_omitted_and_the_incoming_duration_added(
        self, project: Project
    ) -> None:
        a = Task.objects.create(project=project, name="A", duration=5)
        Task.objects.create(project=project, name="B", duration=3)
        assert (
            project_span_days(project.pk, exclude_task_pk=a.pk, added_task_duration_days=100) == 103
        )

    def test_excluded_dependency_is_omitted_and_the_incoming_lag_added(
        self, project: Project
    ) -> None:
        a = Task.objects.create(project=project, name="A", duration=1)
        b = Task.objects.create(project=project, name="B", duration=1)
        dep = Dependency.objects.create(predecessor=a, successor=b, lag=7)
        assert project_span_days(project.pk, exclude_dependency_pk=dep.pk, added_lag_days=-3) == 5

    def test_negative_added_duration_is_clamped_to_zero(self, project: Project) -> None:
        Task.objects.create(project=project, name="A", duration=4)
        assert project_span_days(project.pk, added_task_duration_days=-99) == 4

    def test_soft_deleted_rows_do_not_count(self, project: Project) -> None:
        a = Task.objects.create(project=project, name="A", duration=5)
        a.soft_delete()
        assert project_span_days(project.pk) == 0

    def test_cross_project_edge_lag_is_not_counted(self, project: Project) -> None:
        """Only same-project edges belong to a single project's span."""
        other = Project.objects.create(name="Other", start_date=MONDAY)
        a = Task.objects.create(project=project, name="A", duration=1)
        b = Task.objects.create(project=other, name="B", duration=1)
        Dependency.objects.create(predecessor=a, successor=b, lag=50)
        assert project_span_days(project.pk) == 1

    def test_validate_passes_under_the_cap(self, project: Project) -> None:
        Task.objects.create(project=project, name="A", duration=10)
        validate_project_span(project.pk)  # under the cap — no rejection
        assert project_span_days(project.pk) == 10

    def test_validate_rejects_a_write_that_would_exceed_the_cap(self, project: Project) -> None:
        with pytest.raises(ValidationError, match="Project span too large"):
            validate_project_span(project.pk, added_task_duration_days=366 * 1000 + 1)


@pytest.mark.django_db
class TestShortIdAllocators:
    def test_task_short_id_is_eight_char_uppercase_hex(self, project: Project) -> None:
        assert _next_short_id(project.pk) == "00000001"
        assert _next_short_id(project.pk) == "00000002"

    def test_risk_short_id_uses_a_separate_decimal_counter(self, project: Project) -> None:
        """Risks count in decimal on their own sequence (#929), never the hex one."""
        _next_short_id(project.pk)
        assert _next_risk_short_id(project.pk) == "1"
        assert _next_risk_short_id(project.pk) == "2"


class TestSignalAudienceRank:
    def test_ladder_is_strictly_ordered(self) -> None:
        ranks = [signal_audience_rank(v) for v in SignalAudience.values]
        assert ranks == sorted(ranks) == [0, 1, 2, 3]

    def test_team_is_the_most_private_rung(self) -> None:
        assert signal_audience_rank(SignalAudience.TEAM) < signal_audience_rank(
            SignalAudience.PROGRAM_SHARED
        )


class TestSmallModuleHelpers:
    def test_attachment_upload_path_is_partitioned_by_task_and_row_id(self) -> None:
        instance = TaskAttachment(id=uuid.UUID(int=1), task_id=uuid.UUID(int=2))
        path = _task_attachment_upload_to(instance, "spec.pdf")
        assert path == f"attachments/{instance.task_id}/{instance.id}_spec.pdf"

    def test_member_role_choices_are_deferred_role_choices(self) -> None:
        from trueppm_api.apps.access.models import Role

        assert _member_role_choices() == Role.choices


# ---------------------------------------------------------------------------
# VersionedModel — restore, and the known_exists fast path
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestVersionedModelRestore:
    def test_restore_clears_the_tombstone_and_bumps_the_version(self, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        task.soft_delete()
        deleted_version = task.server_version
        task.restore()
        task.refresh_from_db()
        assert task.is_deleted is False
        assert task.deleted_version is None
        assert task.server_version > deleted_version

    def test_task_restore_also_clears_the_reap_clock(self, project: Project) -> None:
        """deleted_at must clear too or the nightly reap still sees the live row (#2078)."""
        task = Task.objects.create(project=project, name="T", duration=1)
        task.soft_delete()
        assert task.deleted_at is not None
        task.restore()
        task.refresh_from_db()
        assert task.deleted_at is None

    def test_known_exists_true_takes_the_update_path(self, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        before = task.server_version
        task.name = "T renamed"
        task.save(known_exists=True)
        task.refresh_from_db()
        assert task.name == "T renamed"
        assert task.server_version == before + 1

    def test_insert_starts_the_version_at_one(self, project: Project) -> None:
        """since=0 sync must see every new row, so an INSERT can never land at 0."""
        task = Task.objects.create(project=project, name="Fresh", duration=1)
        assert task.server_version == 1

    def test_update_fields_save_still_bumps_the_version(self, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        task.duration = 9
        task.save(update_fields=["duration"])
        task.refresh_from_db()
        assert task.duration == 9
        assert task.server_version == 2


# ---------------------------------------------------------------------------
# Task.save — blocker stamping (ADR-0124)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskBlockerStamping:
    def test_first_blocked_reason_stamps_blocked_since(self, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        assert task.blocked_since is None
        task.blocked_reason = "waiting on vendor"
        task.save(update_fields=["blocked_reason"])
        task.refresh_from_db()
        assert task.blocked_since is not None

    def test_clearing_the_reason_clears_the_whole_structured_blocker(
        self, project: Project, user: Any
    ) -> None:
        blocker = Task.objects.create(project=project, name="Blocker", duration=1)
        task = Task.objects.create(
            project=project,
            name="T",
            duration=1,
            blocked_reason="waiting",
            blocker_type=BlockerType.VENDOR,
            blocking_task=blocker,
            blocked_by=user,
        )
        task.refresh_from_db()
        assert task.blocked_since is not None
        task.blocked_reason = ""
        task.save(update_fields=["blocked_reason"])
        task.refresh_from_db()
        assert task.blocked_since is None
        assert task.blocker_type == ""
        assert task.blocking_task_id is None
        assert task.blocked_by_id is None

    def test_whitespace_only_reason_does_not_count_as_blocked(self, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        task.blocked_reason = "   "
        task.save(update_fields=["blocked_reason"])
        task.refresh_from_db()
        assert task.blocked_since is None

    def test_a_save_that_does_not_touch_the_reason_leaves_the_stamp_alone(
        self, project: Project
    ) -> None:
        task = Task.objects.create(project=project, name="T", duration=1, blocked_reason="waiting")
        task.refresh_from_db()
        stamped = task.blocked_since
        task.duration = 4
        task.save(update_fields=["duration"])
        task.refresh_from_db()
        assert task.blocked_since == stamped

    def test_review_status_coerces_percent_complete_to_one_hundred(self, project: Project) -> None:
        """A card in Review is work-done-awaiting-signoff; the ring must agree."""
        task = Task.objects.create(project=project, name="T", duration=1, status=TaskStatus.REVIEW)
        task.refresh_from_db()
        assert task.percent_complete == 100.0

    def test_status_change_stamps_status_changed_at(self, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        first = task.status_changed_at
        task.status = TaskStatus.IN_PROGRESS
        task.save(update_fields=["status"])
        task.refresh_from_db()
        assert task.status_changed_at is not None
        assert task.status_changed_at != first


# ---------------------------------------------------------------------------
# Subtree cascades (#1112 / #1113 / #2078)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskSubtaskCascade:
    def test_soft_delete_cascades_to_drawer_subtasks(self, project: Project) -> None:
        parent = Task.objects.create(project=project, name="Parent", duration=1, wbs_path="1")
        child = Task.objects.create(
            project=project, name="Child", duration=1, wbs_path="1.1", is_subtask=True
        )
        structural = Task.objects.create(
            project=project, name="Phase child", duration=1, wbs_path="1.2"
        )
        parent.soft_delete()
        child.refresh_from_db()
        structural.refresh_from_db()
        assert child.is_deleted is True
        # WBS-structure children are the PM's to delete explicitly.
        assert structural.is_deleted is False

    def test_restore_cascade_brings_back_subtasks_and_live_edges(self, project: Project) -> None:
        parent = Task.objects.create(project=project, name="Parent", duration=1, wbs_path="1")
        child = Task.objects.create(
            project=project, name="Child", duration=1, wbs_path="1.1", is_subtask=True
        )
        other = Task.objects.create(project=project, name="Other", duration=1, wbs_path="2")
        dep = Dependency.objects.create(predecessor=parent, successor=other)
        parent.soft_delete()
        parent.restore()
        cascade_task_children_restore(parent)
        child.refresh_from_db()
        dep.refresh_from_db()
        assert child.is_deleted is False
        assert dep.is_deleted is False

    def test_restore_cascade_leaves_an_edge_with_a_dead_endpoint_tombstoned(
        self, project: Project
    ) -> None:
        parent = Task.objects.create(project=project, name="Parent", duration=1, wbs_path="1")
        other = Task.objects.create(project=project, name="Other", duration=1, wbs_path="2")
        dep = Dependency.objects.create(predecessor=parent, successor=other)
        other.soft_delete()  # tombstones the edge too
        parent.soft_delete()
        parent.restore()
        cascade_task_children_restore(parent)
        dep.refresh_from_db()
        assert dep.is_deleted is True

    def test_restore_cascade_is_idempotent(self, project: Project) -> None:
        parent = Task.objects.create(project=project, name="Parent", duration=1, wbs_path="1")
        child = Task.objects.create(
            project=project, name="Child", duration=1, wbs_path="1.1", is_subtask=True
        )
        parent.soft_delete()
        parent.restore()
        cascade_task_children_restore(parent)
        child.refresh_from_db()
        version = child.server_version
        cascade_task_children_restore(parent)
        child.refresh_from_db()
        assert child.server_version == version


@pytest.mark.django_db
class TestProjectCascades:
    def test_project_soft_delete_does_not_cascade_synchronously(self, project: Project) -> None:
        """#1112 split the row tombstone from the (Celery) child cascade."""
        task = Task.objects.create(project=project, name="T", duration=1)
        project.soft_delete()
        project.refresh_from_db()
        task.refresh_from_db()
        assert project.is_deleted is True
        assert project.deleted_at is not None
        assert task.is_deleted is False

    def test_child_cascade_tombstones_every_board_scoped_child(self, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        other = Task.objects.create(project=project, name="U", duration=1)
        dep = Dependency.objects.create(predecessor=task, successor=other)
        sprint = Sprint.objects.create(
            project=project, name="S", start_date=MONDAY, finish_date=MONDAY + timedelta(6)
        )
        baseline = Baseline.objects.create(project=project, name="B1")
        risk = Risk.objects.create(project=project, title="R", probability=3, impact=3)
        project.soft_delete()
        cascade_project_children_soft_delete(project)
        for row in (task, dep, sprint, baseline, risk):
            row.refresh_from_db()
            assert row.is_deleted is True, row
        task.refresh_from_db()
        assert task.deleted_version == task.server_version

    def test_child_cascade_is_idempotent(self, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        cascade_project_children_soft_delete(project)
        task.refresh_from_db()
        version = task.server_version
        cascade_project_children_soft_delete(project)
        task.refresh_from_db()
        assert task.server_version == version

    def test_project_restore_clears_the_deletion_audit_fields(
        self, project: Project, user: Any
    ) -> None:
        project.deleted_by = user
        project.soft_delete()
        project.restore()
        project.refresh_from_db()
        assert project.is_deleted is False
        assert project.deleted_at is None
        assert project.deleted_by_id is None

    def test_child_restore_cascade_brings_back_tasks_edges_sprints_and_risks(
        self, project: Project
    ) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        other = Task.objects.create(project=project, name="U", duration=1)
        dep = Dependency.objects.create(predecessor=task, successor=other)
        sprint = Sprint.objects.create(
            project=project, name="S", start_date=MONDAY, finish_date=MONDAY + timedelta(6)
        )
        risk = Risk.objects.create(project=project, title="R", probability=3, impact=3)
        cascade_project_children_soft_delete(project)
        cascade_project_children_restore(project)
        for row in (task, dep, sprint, risk):
            row.refresh_from_db()
            assert row.is_deleted is False, row
        task.refresh_from_db()
        assert task.deleted_at is None

    def test_child_restore_cascade_is_idempotent(self, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        cascade_project_children_soft_delete(project)
        cascade_project_children_restore(project)
        task.refresh_from_db()
        version = task.server_version
        cascade_project_children_restore(project)
        task.refresh_from_db()
        assert task.server_version == version


# ---------------------------------------------------------------------------
# task_is_phase / committed querysets
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskIsPhase:
    def test_task_with_a_structural_child_is_a_phase(self, project: Project) -> None:
        parent = Task.objects.create(project=project, name="Phase", duration=1, wbs_path="1")
        Task.objects.create(project=project, name="Leaf", duration=1, wbs_path="1.1")
        assert task_is_phase(parent) is True

    def test_leaf_task_is_not_a_phase(self, project: Project) -> None:
        leaf = Task.objects.create(project=project, name="Leaf", duration=1, wbs_path="1")
        assert task_is_phase(leaf) is False

    def test_leaf_with_only_drawer_subtasks_is_not_a_phase(self, project: Project) -> None:
        """is_summary=True but task_is_phase=False — the critical distinction."""
        parent = Task.objects.create(project=project, name="Story", duration=1, wbs_path="1")
        Task.objects.create(
            project=project, name="Sub", duration=1, wbs_path="1.1", is_subtask=True
        )
        assert task_is_phase(parent) is False

    def test_a_subtask_is_never_a_phase(self, project: Project) -> None:
        sub = Task.objects.create(
            project=project, name="Sub", duration=1, wbs_path="1.1", is_subtask=True
        )
        Task.objects.create(project=project, name="Deeper", duration=1, wbs_path="1.1.1")
        assert task_is_phase(sub) is False

    def test_task_without_a_wbs_path_is_not_a_phase(self, project: Project) -> None:
        recurring = Task.objects.create(project=project, name="Daily", duration=1)
        assert task_is_phase(recurring) is False

    def test_unsaved_task_is_not_a_phase(self, project: Project) -> None:
        assert task_is_phase(Task(project=project, name="Draft", wbs_path="1")) is False

    def test_soft_deleted_child_does_not_make_a_phase(self, project: Project) -> None:
        parent = Task.objects.create(project=project, name="Phase", duration=1, wbs_path="1")
        child = Task.objects.create(project=project, name="Leaf", duration=1, wbs_path="1.1")
        child.soft_delete()
        assert task_is_phase(parent) is False


@pytest.mark.django_db
class TestCommittedQuerysets:
    def test_committed_manager_excludes_backlog_recurring_and_epics(self, project: Project) -> None:
        from trueppm_api.apps.projects.models import TaskType

        delivered = Task.objects.create(project=project, name="Delivered", duration=1)
        Task.objects.create(project=project, name="Backlog", duration=1, status=TaskStatus.BACKLOG)
        Task.objects.create(project=project, name="Recurring", duration=1, is_recurring=True)
        Task.objects.create(project=project, name="Epic", duration=1, type=TaskType.EPIC)
        assert list(Task.committed.values_list("pk", flat=True)) == [delivered.pk]

    def test_committed_sprint_tasks_excludes_pending_injections(self, project: Project) -> None:
        sprint = Sprint.objects.create(
            project=project, name="S", start_date=MONDAY, finish_date=MONDAY + timedelta(6)
        )
        accepted = Task.objects.create(project=project, name="In", duration=1, sprint=sprint)
        Task.objects.create(
            project=project, name="Pending", duration=1, sprint=sprint, sprint_pending=True
        )
        deleted = Task.objects.create(project=project, name="Gone", duration=1, sprint=sprint)
        deleted.soft_delete()
        assert list(committed_sprint_tasks(sprint.pk).values_list("pk", flat=True)) == [accepted.pk]


# ---------------------------------------------------------------------------
# Immutability, validation, and computed properties
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestBaselineTaskImmutability:
    def test_insert_is_allowed(self, project: Project) -> None:
        baseline = Baseline.objects.create(project=project, name="B1")
        task = Task.objects.create(project=project, name="T", duration=1)
        row = BaselineTask.objects.create(
            baseline=baseline, task_id=task.pk, task_name="T", duration=1
        )
        assert BaselineTask.objects.filter(pk=row.pk).exists()

    def test_update_of_an_existing_snapshot_row_is_rejected(self, project: Project) -> None:
        baseline = Baseline.objects.create(project=project, name="B1")
        task = Task.objects.create(project=project, name="T", duration=1)
        row = BaselineTask.objects.create(
            baseline=baseline, task_id=task.pk, task_name="T", duration=1
        )
        row.duration = 99
        with pytest.raises(ImmutableModelError, match="immutable"):
            row.save()


def _clean_errors(rule: TaskRecurrenceRule) -> set[str]:
    """Field keys ``TaskRecurrenceRule.clean`` rejects (empty set = valid)."""
    try:
        rule.clean()
    except ValidationError as exc:
        return set(exc.message_dict)
    return set()


@pytest.mark.django_db
class TestTaskRecurrenceRuleClean:
    @pytest.fixture
    def rule(self, project: Project) -> TaskRecurrenceRule:
        task = Task.objects.create(project=project, name="Template", duration=1)
        return TaskRecurrenceRule(task=task)

    def test_weekly_without_a_weekday_is_rejected(self, rule: TaskRecurrenceRule) -> None:
        rule.frequency = TaskRecurrenceFrequency.WEEKLY
        rule.weekdays = 0
        with pytest.raises(ValidationError) as exc:
            rule.clean()
        assert "weekdays" in exc.value.message_dict

    def test_weekly_with_a_weekday_is_accepted(self, rule: TaskRecurrenceRule) -> None:
        rule.frequency = TaskRecurrenceFrequency.WEEKLY
        rule.weekdays = 1
        assert _clean_errors(rule) == set()

    def test_monthly_without_a_day_of_month_is_rejected(self, rule: TaskRecurrenceRule) -> None:
        rule.frequency = TaskRecurrenceFrequency.MONTHLY
        rule.day_of_month = None
        with pytest.raises(ValidationError) as exc:
            rule.clean()
        assert "day_of_month" in exc.value.message_dict

    def test_on_date_without_an_end_date_is_rejected(self, rule: TaskRecurrenceRule) -> None:
        rule.frequency = TaskRecurrenceFrequency.DAILY
        rule.end_type = RecurrenceEndType.ON_DATE
        with pytest.raises(ValidationError) as exc:
            rule.clean()
        assert "end_date" in exc.value.message_dict

    def test_after_n_without_a_count_is_rejected(self, rule: TaskRecurrenceRule) -> None:
        rule.frequency = TaskRecurrenceFrequency.DAILY
        rule.end_type = RecurrenceEndType.AFTER_N
        with pytest.raises(ValidationError) as exc:
            rule.clean()
        assert "end_count" in exc.value.message_dict

    def test_every_error_is_reported_at_once(self, rule: TaskRecurrenceRule) -> None:
        rule.frequency = TaskRecurrenceFrequency.WEEKLY
        rule.weekdays = 0
        rule.end_type = RecurrenceEndType.AFTER_N
        with pytest.raises(ValidationError) as exc:
            rule.clean()
        assert set(exc.value.message_dict) == {"weekdays", "end_count"}

    def test_daily_never_ending_rule_is_valid(self, rule: TaskRecurrenceRule) -> None:
        rule.frequency = TaskRecurrenceFrequency.DAILY
        assert _clean_errors(rule) == set()


@pytest.mark.django_db
class TestShareLinkActivity:
    def _link(self, project: Project, **kwargs: Any) -> ShareLink:
        return ShareLink.objects.create(
            project=project,
            token_prefix="abcdefghijkl",
            token_hash=uuid.uuid4().hex * 2,
            **kwargs,
        )

    def test_fresh_link_is_active_and_unexpired(self, project: Project) -> None:
        link = self._link(project)
        assert link.is_expired is False
        assert link.is_active is True

    def test_link_with_a_future_expiry_is_still_active(self, project: Project) -> None:
        link = self._link(project, expires_at=timezone.now() + timedelta(days=1))
        assert link.is_expired is False
        assert link.is_active is True

    def test_past_expiry_makes_the_link_inactive(self, project: Project) -> None:
        link = self._link(project, expires_at=timezone.now() - timedelta(seconds=1))
        assert link.is_expired is True
        assert link.is_active is False

    def test_revoked_link_is_inactive_even_without_an_expiry(self, project: Project) -> None:
        link = self._link(project, revoked_at=timezone.now())
        assert link.is_expired is False
        assert link.is_active is False


@pytest.mark.django_db
class TestApiTokenScopeAndExpiry:
    def _token(self, **kwargs: Any) -> ApiToken:
        return ApiToken.objects.create(
            name="T", token_prefix="abcd1234", token_hash=uuid.uuid4().hex * 2, **kwargs
        )

    def test_project_scoped_token_is_neither_program_scoped_nor_personal(
        self, project: Project
    ) -> None:
        token = self._token(project=project)
        assert token.is_program_scoped is False
        assert token.is_personal is False

    def test_program_scoped_token_is_flagged(self, db: object) -> None:
        program = Program.objects.create(name="Prog")
        token = self._token(program=program)
        assert token.is_program_scoped is True
        assert token.is_personal is False

    def test_personal_access_token_is_flagged(self, user: Any) -> None:
        token = self._token(owner=user)
        assert token.is_personal is True
        assert token.is_program_scoped is False

    def test_token_without_an_expiry_never_expires(self, project: Project) -> None:
        assert self._token(project=project).is_expired is False

    def test_future_expiry_is_not_expired(self, project: Project) -> None:
        token = self._token(project=project, expires_at=timezone.now() + timedelta(days=1))
        assert token.is_expired is False

    def test_past_expiry_is_expired(self, project: Project) -> None:
        token = self._token(project=project, expires_at=timezone.now() - timedelta(seconds=1))
        assert token.is_expired is True

    def test_active_personal_tokens_excludes_revoked_expired_and_deleted(self, user: Any) -> None:
        live = self._token(owner=user)
        self._token(owner=user, revoked_at=timezone.now())
        self._token(owner=user, expires_at=timezone.now() - timedelta(seconds=1))
        deleted = self._token(owner=user)
        deleted.soft_delete()
        other = User.objects.create_user(username="other", password="pw")
        self._token(owner=other)
        assert list(ApiToken.active_personal_tokens_for(user)) == [live]


@pytest.mark.django_db
class TestGuardrailPolicyEffectiveLevel:
    def _policy(self, project: Project, **kwargs: Any) -> ProjectGuardrailPolicy:
        return ProjectGuardrailPolicy.objects.create(project=project, **kwargs)

    def test_unset_rule_defaults_to_warn(self, project: Project) -> None:
        policy = self._policy(project)
        assert policy.effective_level(GuardrailRule.SUMMARY_IN_SPRINT) == GuardrailLevel.WARN

    def test_owner_sourced_block_is_enforced(self, project: Project) -> None:
        policy = self._policy(
            project,
            levels={GuardrailRule.SUMMARY_IN_SPRINT.value: GuardrailLevel.BLOCK.value},
            source=GuardrailPolicySource.OWNER,
        )
        assert policy.effective_level(GuardrailRule.SUMMARY_IN_SPRINT) == GuardrailLevel.BLOCK

    def test_unacknowledged_external_composition_block_is_inert(self, project: Project) -> None:
        """Sprint sovereignty: an imposed block only bites once the team accepts it."""
        policy = self._policy(
            project,
            levels={GuardrailRule.PHASE_IN_SPRINT.value: GuardrailLevel.BLOCK.value},
            source=GuardrailPolicySource.EXTERNAL,
            acknowledged_by_team=False,
        )
        assert policy.effective_level(GuardrailRule.PHASE_IN_SPRINT) == GuardrailLevel.WARN

    def test_acknowledged_external_composition_block_is_enforced(self, project: Project) -> None:
        policy = self._policy(
            project,
            levels={GuardrailRule.PHASE_IN_SPRINT.value: GuardrailLevel.BLOCK.value},
            source=GuardrailPolicySource.EXTERNAL,
            acknowledged_by_team=True,
        )
        assert policy.effective_level(GuardrailRule.PHASE_IN_SPRINT) == GuardrailLevel.BLOCK

    def test_non_composition_rule_block_is_enforced_even_when_external(
        self, project: Project
    ) -> None:
        """SUBTASKS_SPLIT is outside the sovereignty gate — it is never escalatable."""
        policy = self._policy(
            project,
            levels={GuardrailRule.SUBTASKS_SPLIT.value: GuardrailLevel.BLOCK.value},
            source=GuardrailPolicySource.EXTERNAL,
            acknowledged_by_team=False,
        )
        assert policy.effective_level(GuardrailRule.SUBTASKS_SPLIT) == GuardrailLevel.BLOCK


@pytest.mark.django_db
class TestSignalPrivacyPolicyResolution:
    def test_unset_signal_resolves_to_the_coded_default(self, project: Project) -> None:
        policy = ProjectSignalPrivacyPolicy.objects.create(project=project)
        assert policy.resolved("velocity") == {
            "audience": SignalAudience.TEAM,
            "ceiling": SignalAudience.TEAM,
        }
        assert policy.audience_of("throughput_rollup") == SignalAudience.TEAM
        assert policy.ceiling_of("throughput_rollup") == SignalAudience.PROGRAM_SHARED

    def test_partial_override_keeps_the_missing_half_from_the_default(
        self, project: Project
    ) -> None:
        policy = ProjectSignalPrivacyPolicy.objects.create(
            project=project,
            signal_visibility={"velocity": {"audience": SignalAudience.TEAM_SM.value}},
        )
        assert policy.audience_of("velocity") == SignalAudience.TEAM_SM
        assert policy.ceiling_of("velocity") == SignalAudience.TEAM

    def test_unknown_signal_key_falls_back_to_fully_private(self, project: Project) -> None:
        policy = ProjectSignalPrivacyPolicy.objects.create(project=project)
        assert policy.resolved("not_a_signal") == {
            "audience": SignalAudience.TEAM,
            "ceiling": SignalAudience.TEAM,
        }


@pytest.mark.django_db
class TestSlipConflictOpenState:
    @pytest.fixture
    def conflict(self, project: Project) -> CrossProjectSlipConflict:
        sprint = Sprint.objects.create(
            project=project, name="S", start_date=MONDAY, finish_date=MONDAY + timedelta(6)
        )
        task = Task.objects.create(project=project, name="T", duration=1, sprint=sprint)
        return CrossProjectSlipConflict.objects.create(
            sprint=sprint, task=task, pushed_to=MONDAY + timedelta(days=20)
        )

    def test_unresolved_and_unacknowledged_is_open(
        self, conflict: CrossProjectSlipConflict
    ) -> None:
        assert conflict.is_open is True

    def test_acknowledged_conflict_is_closed(self, conflict: CrossProjectSlipConflict) -> None:
        conflict.acknowledged_at = timezone.now()
        assert conflict.is_open is False

    def test_resolved_conflict_is_closed(self, conflict: CrossProjectSlipConflict) -> None:
        conflict.resolution = SlipConflictResolution.AUTO_RESOLVED
        assert conflict.is_open is False

    def test_project_id_resolves_through_the_downstream_task(
        self, conflict: CrossProjectSlipConflict, project: Project
    ) -> None:
        assert conflict.project_id == project.pk


# ---------------------------------------------------------------------------
# Soft-delete with actor attribution (comments, notes, attachments)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestActorAttributedSoftDelete:
    @pytest.fixture
    def task(self, project: Project) -> Task:
        return Task.objects.create(project=project, name="T", duration=1)

    def test_attachment_records_the_deleting_actor(self, task: Task, user: Any) -> None:
        att = TaskAttachment.objects.create(task=task, external_url="https://example.test")
        att.soft_delete(actor=user)
        att.refresh_from_db()
        assert att.is_deleted is True
        assert att.deleted_by_id == user.pk
        assert att.deleted_at is not None

    def test_attachment_soft_delete_without_an_actor_leaves_it_null(self, task: Task) -> None:
        att = TaskAttachment.objects.create(task=task, external_url="https://example.test")
        att.soft_delete()
        att.refresh_from_db()
        assert att.is_deleted is True
        assert att.deleted_by_id is None

    def test_comment_records_the_deleting_actor(self, task: Task, user: Any) -> None:
        comment = TaskComment.objects.create(task=task, body="hi", author=user)
        comment.soft_delete(actor=user)
        comment.refresh_from_db()
        assert comment.is_deleted is True
        assert comment.deleted_by_id == user.pk

    def test_note_records_the_deleting_actor(self, task: Task, user: Any) -> None:
        note = TaskNote.objects.create(task=task, body="note", author=user)
        note.soft_delete(actor=user)
        note.refresh_from_db()
        assert note.is_deleted is True
        assert note.deleted_by_id == user.pk


@pytest.mark.django_db
class TestRbacProjectIdProperties:
    """Every task-scoped child surfaces ``project_id`` so object permissions resolve."""

    @pytest.fixture
    def task(self, project: Project) -> Task:
        return Task.objects.create(project=project, name="T", duration=1)

    def test_acceptance_criterion(self, task: Task, project: Project) -> None:
        criterion = AcceptanceCriterion.objects.create(task=task, text="Given/When/Then")
        assert criterion.project_id == project.pk

    def test_recurrence_rule(self, task: Task, project: Project) -> None:
        rule = TaskRecurrenceRule.objects.create(task=task)
        assert rule.project_id == project.pk

    def test_task_relation(self, task: Task, project: Project) -> None:
        other = Task.objects.create(project=project, name="U", duration=1)
        relation = TaskRelation.objects.create(source=task, target=other)
        assert relation.project_id == project.pk

    def test_task_label(self, task: Task, project: Project) -> None:
        label = Label.objects.create(project=project, name="bug")
        link = TaskLabel.objects.create(task=task, label=label)
        assert link.project_id == project.pk

    def test_attachment_and_comment_children(self, task: Task, project: Project, user: Any) -> None:
        att = TaskAttachment.objects.create(task=task, external_url="https://example.test")
        comment = TaskComment.objects.create(task=task, body="hi", author=user)
        note = TaskNote.objects.create(task=task, body="note", author=user)
        ack = CommentAcknowledgement.objects.create(comment=comment, user=user)
        reaction = CommentReaction.objects.create(comment=comment, user=user, emoji="👍")
        assert att.project_id == project.pk
        assert comment.project_id == project.pk
        assert note.project_id == project.pk
        assert ack.project_id == project.pk
        assert reaction.project_id == project.pk

    def test_custom_field_value(self, task: Task, project: Project) -> None:
        field = ProjectCustomField.objects.create(
            project=project, name="Team", field_type=CustomFieldType.TEXT
        )
        value = TaskCustomFieldValue.objects.create(task=task, field=field, value_text="Core")
        assert value.project_id == project.pk

    def test_retro_board_item(self, project: Project, user: Any) -> None:
        sprint = Sprint.objects.create(
            project=project, name="S", start_date=MONDAY, finish_date=MONDAY + timedelta(6)
        )
        retro = SprintRetro.objects.create(sprint=sprint)
        item = RetroBoardItem.objects.create(
            retro=retro, text="Pairing helped", column=RetroColumn.WENT_WELL, author=user
        )
        assert item.project_id == project.pk


@pytest.mark.django_db
class TestSprintScopeChangeItemName:
    def test_item_name_reads_through_to_the_stored_column(self, project: Project) -> None:
        """``item_name`` is the forward-looking accessor over ``subtask_name``."""
        sprint = Sprint.objects.create(
            project=project,
            name="S",
            start_date=MONDAY,
            finish_date=MONDAY + timedelta(6),
            state=SprintState.ACTIVE,
        )
        task = Task.objects.create(project=project, name="T", duration=1, sprint=sprint)
        change = SprintScopeChange.objects.create(
            task=task, sprint=sprint, subtask_name="Hotfix login"
        )
        assert change.item_name == "Hotfix login"


# ---------------------------------------------------------------------------
# __str__ reprs — the admin/log/debug surface
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestModelStringRepresentations:
    """Every ``__str__`` identifies its row without raising on a minimal instance."""

    def test_calendar_family(self, project: Project) -> None:
        cal = Calendar.objects.create(name="Nordic")
        exc = CalendarException.objects.create(
            calendar=cal, exc_start=MONDAY, exc_end=MONDAY, description="Holiday"
        )
        layer = ProjectCalendarLayer.objects.create(
            project=project, calendar=cal, role=CalendarRole.HOLIDAYS
        )
        assert str(cal) == "Nordic"
        assert "Nordic" in str(exc)
        assert MONDAY.isoformat() in str(exc)
        assert CalendarRole.HOLIDAYS in str(layer)

    def test_program_family(self, db: object) -> None:
        program = Program.objects.create(name="Apollo")
        ceremony = CeremonyTemplate.objects.create(
            program=program, name="Standup", cadence_type=CeremonyCadenceType.WEEKLY
        )
        gate = PhaseGateConfig.objects.create(program=program)
        item = BacklogItem.objects.create(program=program, title="Idea")
        job = ProgramExportJob.objects.create(program=program)
        assert str(program) == "Apollo"
        assert "Standup" in str(ceremony)
        assert str(program.pk) in str(gate)
        assert "Idea" in str(item)
        assert str(program.pk) in str(job)

    def test_project_and_task_family(self, project: Project) -> None:
        task = Task.objects.create(project=project, name="Design", duration=1)
        other = Task.objects.create(project=project, name="Build", duration=1)
        dep = Dependency.objects.create(predecessor=task, successor=other, lag=2)
        relation = TaskRelation.objects.create(source=task, target=other)
        criterion = AcceptanceCriterion.objects.create(task=task, text="Renders")
        rule = TaskRecurrenceRule.objects.create(task=task)
        job = ProjectExportJob.objects.create(project=project)
        assert str(project) == "P"
        assert str(task) == "P / Design"
        assert "FS+2d" in str(dep)
        assert str(task.pk) in str(relation)
        assert "Renders" in str(criterion)
        assert "○" in str(criterion)
        assert str(task.pk) in str(rule)
        assert str(project.pk) in str(job)

    def test_met_acceptance_criterion_renders_a_tick(self, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        criterion = AcceptanceCriterion.objects.create(task=task, text="Renders", met=True)
        assert str(criterion).startswith("✓")

    def test_baseline_family(self, project: Project) -> None:
        baseline = Baseline.objects.create(project=project, name="B1")
        task = Task.objects.create(project=project, name="T", duration=1)
        row = BaselineTask.objects.create(
            baseline=baseline, task_id=task.pk, task_name="T", duration=1
        )
        assert str(baseline) == "P / B1"
        assert str(task.pk) in str(row)

    def test_risk_family(self, project: Project, user: Any) -> None:
        risk = Risk.objects.create(project=project, title="Vendor delay", probability=3, impact=4)
        task = Task.objects.create(project=project, name="T", duration=1)
        link = RiskTask.objects.create(risk=risk, task=task)
        comment = RiskComment.objects.create(risk=risk, message="Mitigating", author=user)
        assert "Vendor delay" in str(risk)
        assert str(risk.status) in str(risk)
        assert str(risk.pk) in str(link)
        assert str(risk.pk) in str(comment)

    def test_label_and_board_family(self, project: Project) -> None:
        label = Label.objects.create(project=project, name="bug")
        task = Task.objects.create(project=project, name="T", duration=1)
        link = TaskLabel.objects.create(task=task, label=label)
        columns = BoardColumnConfig.objects.create(project=project)
        view = BoardSavedView.objects.create(project=project, name="Mine", config={"q": "x"})
        share = ShareLink.objects.create(
            project=project, token_prefix="abcdefghijkl", token_hash=uuid.uuid4().hex * 2
        )
        assert "bug" in str(label)
        assert str(label.pk) in str(link)
        assert str(project.pk) in str(columns)
        assert "Mine" in str(view)
        assert "abcdefghijkl" in str(share)

    def test_sprint_family(self, project: Project, user: Any) -> None:
        sprint = Sprint.objects.create(
            project=project, name="S1", start_date=MONDAY, finish_date=MONDAY + timedelta(6)
        )
        task = Task.objects.create(project=project, name="T", duration=1, sprint=sprint)
        snapshot = SprintBurnSnapshot.objects.create(
            sprint=sprint,
            snapshot_date=MONDAY,
            remaining_points=5,
            remaining_task_count=1,
            completed_points=0,
            completed_task_count=0,
        )
        conflict = CrossProjectSlipConflict.objects.create(
            sprint=sprint, task=task, pushed_to=MONDAY + timedelta(days=30)
        )
        outcome = SprintTaskOutcome.objects.create(
            sprint=sprint,
            task=task,
            task_short_id="T-1",
            task_title="T",
            final_status=TaskStatus.COMPLETE,
            disposition=SprintTaskDisposition.COMPLETED,
        )
        close_request = SprintCloseRequest.objects.create(sprint=sprint)
        change = SprintScopeChange.objects.create(task=task, sprint=sprint, subtask_name="T")
        assert "S1" in str(sprint)
        assert MONDAY.isoformat() in str(snapshot)
        assert str(task.pk) in str(conflict)
        assert "T-1" in str(outcome)
        assert "pending" in str(close_request)
        assert str(sprint.pk) in str(change)

    def test_retro_family(self, project: Project, user: Any) -> None:
        sprint = Sprint.objects.create(
            project=project, name="S1", start_date=MONDAY, finish_date=MONDAY + timedelta(6)
        )
        retro = SprintRetro.objects.create(sprint=sprint)
        action = RetroActionItem.objects.create(retro=retro, text="Pair more")
        item = RetroBoardItem.objects.create(
            retro=retro, text="Good flow", column=RetroColumn.IDEAS, author=user
        )
        pulse = PulseResponse.objects.create(retro=retro, respondent=user, mood=4, energy=3)
        assert str(sprint.pk) in str(retro)
        assert str(retro.pk) in str(action)
        assert RetroColumn.IDEAS in str(item)
        assert str(retro.pk) in str(pulse)

    def test_governance_policy_family(self, project: Project, user: Any) -> None:
        guardrails = ProjectGuardrailPolicy.objects.create(project=project)
        privacy = ProjectSignalPrivacyPolicy.objects.create(project=project)
        decisions = ProjectDecisionsPolicy.objects.create(project=project)
        proposal = SignalCeilingRaiseProposal.objects.create(
            project=project,
            signal_key="velocity",
            from_ceiling=SignalAudience.TEAM,
            to_ceiling=SignalAudience.TEAM_SM,
            expires_at=timezone.now() + timedelta(days=3),
        )
        vote = SignalCeilingRaiseVote.objects.create(
            proposal=proposal, voter=user, choice="approve"
        )
        assert str(guardrails.pk) in str(guardrails)
        assert str(privacy.pk) in str(privacy)
        assert str(decisions.pk) in str(decisions)
        assert "velocity" in str(proposal)
        assert "team->team_sm" in str(proposal)
        assert "approve" in str(vote)

    def test_poker_family(self, project: Project, user: Any) -> None:
        sprint = Sprint.objects.create(
            project=project, name="S1", start_date=MONDAY, finish_date=MONDAY + timedelta(6)
        )
        task = Task.objects.create(project=project, name="T", duration=1, sprint=sprint)
        session = PokerSession.objects.create(sprint=sprint, task=task)
        vote = PokerVote.objects.create(session=session, voter=user, value="5")
        assert str(task.pk) in str(session)
        assert "5" in str(vote)

    def test_suggestion_and_inbound_link(self, project: Project, user: Any) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        suggestion = TaskSuggestedAssignee.objects.create(task=task, suggested_user=user)
        link = InboundTaskLink.objects.create(
            project=project, task=task, source="jira", external_id="PROJ-7"
        )
        assert str(task.pk) in str(suggestion)
        assert "jira:PROJ-7" in str(link)

    def test_api_token_repr_names_each_scope(self, project: Project, user: Any) -> None:
        program = Program.objects.create(name="Apollo")
        project_token = ApiToken.objects.create(
            name="P", token_prefix="aaaa1111", token_hash=uuid.uuid4().hex * 2, project=project
        )
        program_token = ApiToken.objects.create(
            name="G", token_prefix="bbbb2222", token_hash=uuid.uuid4().hex * 2, program=program
        )
        personal_token = ApiToken.objects.create(
            name="U", token_prefix="cccc3333", token_hash=uuid.uuid4().hex * 2, owner=user
        )
        assert f"project={project.pk}" in str(project_token)
        assert f"program={program.pk}" in str(program_token)
        assert f"owner={user.pk}" in str(personal_token)

    def test_api_token_audit_entry_repr_names_each_scope(self, project: Project, user: Any) -> None:
        program = Program.objects.create(name="Apollo")
        project_entry = ApiTokenAuditEntry.objects.create(
            token_prefix="aaaa1111", action=ApiTokenAuditAction.MINTED, project=project
        )
        program_entry = ApiTokenAuditEntry.objects.create(
            token_prefix="bbbb2222", action=ApiTokenAuditAction.MINTED, program=program
        )
        personal_entry = ApiTokenAuditEntry.objects.create(
            token_prefix="cccc3333", action=ApiTokenAuditAction.MINTED, owner=user
        )
        assert f"project={project.pk}" in str(project_entry)
        assert f"program={program.pk}" in str(program_entry)
        assert f"owner={user.pk}" in str(personal_entry)

    def test_task_event_family(self, project: Project, user: Any) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        duration_event = TaskDurationChangeEvent.objects.create(
            task=task,
            old_duration=3,
            new_duration=5,
            percent_complete_at_change=50.0,
            policy_applied="prorate",
        )
        activity = TaskActivityEvent.objects.create(
            task=task, event_type=TaskActivityEventType.RISK_LINKED
        )
        assert "3->5d" in str(duration_event)
        assert TaskActivityEventType.RISK_LINKED in str(activity)

    def test_comment_family(self, project: Project, user: Any) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        file_attachment = TaskAttachment.objects.create(
            task=task, file="attachments/spec.pdf", file_name="spec.pdf"
        )
        url_attachment = TaskAttachment.objects.create(
            task=task, external_url="https://example.test"
        )
        comment = TaskComment.objects.create(task=task, body="hi", author=user)
        note = TaskNote.objects.create(task=task, body="note", author=user)
        ack = CommentAcknowledgement.objects.create(comment=comment, user=user)
        reaction = CommentReaction.objects.create(comment=comment, user=user, emoji="👍")
        assert "TaskAttachment(file" in str(file_attachment)
        assert "TaskAttachment(url" in str(url_attachment)
        assert str(task.pk) in str(comment)
        assert str(task.pk) in str(note)
        assert str(comment.pk) in str(ack)
        assert "👍" in str(reaction)

    def test_custom_field_family(self, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        field = ProjectCustomField.objects.create(
            project=project, name="Team", field_type=CustomFieldType.TEXT
        )
        value = TaskCustomFieldValue.objects.create(task=task, field=field, value_text="Core")
        assert "Team" in str(field)
        assert CustomFieldType.TEXT in str(field)
        assert str(field.pk) in str(value)

    def test_forecast_snapshot(self, project: Project) -> None:
        milestone = Task.objects.create(project=project, name="M", duration=0, is_milestone=True)
        snapshot = ForecastSnapshot.objects.create(
            project=project,
            milestone=milestone,
            basis=ForecastBasis.VELOCITY_BAND,
            confidence=ForecastConfidence.LOW,
        )
        assert str(milestone.pk) in str(snapshot)
        assert ForecastBasis.VELOCITY_BAND in str(snapshot)
