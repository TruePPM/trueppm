"""Unit coverage for the projects serializers' field-level validators (#2459).

Every rule exercised here is a *rejection* or *normalization* the API contract
promises but that the endpoint suites never reach: they drive the happy path and
the one or two errors a UI can produce, leaving the defensive branches (wrong
JSON shapes, out-of-range lengths, anonymous readers, unparseable identifiers)
unexecuted.

These run without the database on purpose. Field validators and read-side
projections are pure functions of their input — instantiating the serializer and
handing it a value is the same call DRF makes during ``is_valid()``/``.data``,
minus a Postgres round trip per case. Model instances that appear below are
unsaved value holders, never persisted.
"""

from __future__ import annotations

import io
import uuid
from datetime import date, timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework import serializers

from trueppm_api.apps.projects.models import (
    BacklogItemStatus,
    CrossProjectSlipConflict,
    Program,
    Project,
    Risk,
    Sprint,
    Task,
    TaskComment,
    TaskDurationChangeEvent,
    TaskRecurrenceRule,
    TaskRelation,
)
from trueppm_api.apps.projects.serializers import (
    BacklogItemSerializer,
    BoardColumnConfigSerializer,
    BoardSavedViewSerializer,
    CeremonyTemplateSerializer,
    CrossProjectSlipConflictSerializer,
    InboundTaskSyncPayloadSerializer,
    LabelSerializer,
    MyApiTokenCreateSerializer,
    PhaseSerializer,
    ProgramSerializer,
    ProjectApiTokenCreateSerializer,
    ProjectCustomFieldSerializer,
    ProjectDetailSerializer,
    ProjectGuardrailPolicySerializer,
    ProjectSerializer,
    RiskCommentSerializer,
    RiskSerializer,
    SprintSerializer,
    TaskAttachmentSerializer,
    TaskCommentSerializer,
    TaskDurationChangeEventSerializer,
    TaskNoteSerializer,
    TaskRecurrenceRuleSerializer,
    TaskRelationSerializer,
    TaskSerializer,
    TaskSuggestedAssigneeSerializer,
    _sniff_attachment_content,
)

User = get_user_model()


def _column(**over: Any) -> dict[str, Any]:
    """A single well-formed board column entry."""
    return {
        "status": "BACKLOG",
        "label": "Backlog",
        "visible": True,
        "color": "#94A3B8",
        "wip_limit": None,
        "age_threshold_days": None,
        **over,
    }


def _other_columns() -> list[dict[str, Any]]:
    """The four canonical columns other than BACKLOG — a board config must carry all five."""
    return [
        _column(status="NOT_STARTED", label="To Do"),
        _column(status="IN_PROGRESS", label="In Progress"),
        _column(status="REVIEW", label="Review"),
        _column(status="COMPLETE", label="Done"),
    ]


# --------------------------------------------------------------------------- #
# BoardColumnConfigSerializer.validate_columns — the board config contract.
# --------------------------------------------------------------------------- #


class TestBoardColumnConfigValidation:
    def test_a_full_board_is_normalized_to_the_known_keys(self) -> None:
        cleaned = BoardColumnConfigSerializer().validate_columns(
            [
                _column(smuggled="forward-compat key", wip_limit=3, age_threshold_days=7),
                *_other_columns(),
            ]
        )
        # Unknown keys are dropped rather than round-tripped (no key smuggling).
        assert cleaned[0] == {
            "status": "BACKLOG",
            "label": "Backlog",
            "visible": True,
            "color": "#94A3B8",
            "wip_limit": 3,
            "age_threshold_days": 7,
            # A column that names no lanes normalizes to one implicit lane (#2967).
            "lanes": [],
        }
        assert len(cleaned) == 5

    def test_an_incomplete_board_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="Missing statuses"):
            BoardColumnConfigSerializer().validate_columns([_column()])

    def test_unknown_status_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="Unknown status"):
            BoardColumnConfigSerializer().validate_columns([_column(status="TRIAGE")])

    def test_duplicate_status_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="Duplicate status"):
            BoardColumnConfigSerializer().validate_columns(
                [_column(), _column(label="Backlog again")]
            )

    def test_non_string_label_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="label must be a string"):
            BoardColumnConfigSerializer().validate_columns([_column(label=42)])

    def test_over_long_label_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="label must be a string"):
            BoardColumnConfigSerializer().validate_columns([_column(label="x" * 33)])

    def test_non_boolean_visible_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="visible must be a boolean"):
            BoardColumnConfigSerializer().validate_columns([_column(visible="yes")])

    def test_non_hex_color_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="#RRGGBB"):
            BoardColumnConfigSerializer().validate_columns([_column(color="rebeccapurple")])

    def test_boolean_wip_limit_is_rejected_despite_being_an_int_subclass(self) -> None:
        with pytest.raises(serializers.ValidationError, match="wip_limit"):
            BoardColumnConfigSerializer().validate_columns([_column(wip_limit=True)])

    def test_zero_age_threshold_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="age_threshold_days"):
            BoardColumnConfigSerializer().validate_columns([_column(age_threshold_days=0)])


# --------------------------------------------------------------------------- #
# PhaseSerializer — the Workflow settings name/color rules.
# --------------------------------------------------------------------------- #


class TestPhaseFieldValidation:
    def test_name_is_trimmed(self) -> None:
        assert PhaseSerializer().validate_name("  Discovery  ") == "Discovery"

    def test_whitespace_only_name_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="non-empty"):
            PhaseSerializer().validate_name("   ")

    def test_over_long_name_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="255"):
            PhaseSerializer().validate_name("x" * 256)

    def test_blank_color_collapses_to_null(self) -> None:
        assert PhaseSerializer().validate_color("") is None
        assert PhaseSerializer().validate_color(None) is None

    def test_hex_color_is_accepted(self) -> None:
        assert PhaseSerializer().validate_color("#1A2B3C") == "#1A2B3C"

    def test_non_hex_color_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="#RRGGBB"):
            PhaseSerializer().validate_color("blue")

    def test_task_count_falls_back_to_zero_without_the_annotation(self) -> None:
        # The count is annotated by PhaseViewSet; a phase read outside that
        # queryset reports 0 rather than raising.
        assert PhaseSerializer().get_task_count(Task()) == 0


# --------------------------------------------------------------------------- #
# ProjectCustomFieldSerializer — name + options shape (#521).
# --------------------------------------------------------------------------- #


class TestProjectCustomFieldValidation:
    def test_name_is_trimmed(self) -> None:
        assert ProjectCustomFieldSerializer().validate_name("  Team  ") == "Team"

    def test_whitespace_only_name_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="non-empty"):
            ProjectCustomFieldSerializer().validate_name(" \t ")

    def test_over_long_name_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="64"):
            ProjectCustomFieldSerializer().validate_name("x" * 65)

    def test_options_must_be_a_list(self) -> None:
        with pytest.raises(serializers.ValidationError, match="options must be a list"):
            ProjectCustomFieldSerializer().validate_options({"value": "a"})

    def test_more_than_fifty_options_are_rejected(self) -> None:
        too_many = [{"value": f"v{i}"} for i in range(51)]
        with pytest.raises(serializers.ValidationError, match="at most 50"):
            ProjectCustomFieldSerializer().validate_options(too_many)

    def test_non_object_option_entry_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="must be an object"):
            ProjectCustomFieldSerializer().validate_options(["red"])

    def test_option_without_a_value_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="non-empty value"):
            ProjectCustomFieldSerializer().validate_options([{"label": "Red"}])

    def test_blank_option_value_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="non-empty value"):
            ProjectCustomFieldSerializer().validate_options([{"value": "   "}])

    def test_over_long_option_value_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="option value must be"):
            ProjectCustomFieldSerializer().validate_options([{"value": "v" * 33}])

    def test_duplicate_option_values_are_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="duplicate option value"):
            ProjectCustomFieldSerializer().validate_options(
                [{"value": "red"}, {"value": "red", "label": "Red again"}]
            )

    def test_over_long_option_label_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="option label"):
            ProjectCustomFieldSerializer().validate_options([{"value": "red", "label": "L" * 65}])

    def test_non_hex_option_color_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="option color"):
            ProjectCustomFieldSerializer().validate_options(
                [{"value": "red", "label": "Red", "color": "red"}]
            )

    def test_label_defaults_to_the_value_and_color_defaults_to_null(self) -> None:
        assert ProjectCustomFieldSerializer().validate_options([{"value": "red"}]) == [
            {"value": "red", "label": "red", "color": None}
        ]


# --------------------------------------------------------------------------- #
# Comment / note bodies + reply nesting.
# --------------------------------------------------------------------------- #


class TestCommentAndNoteBodies:
    def test_blank_comment_body_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="Body cannot be blank"):
            TaskCommentSerializer().validate_body("   ")

    def test_comment_body_survives_validation_when_it_has_content(self) -> None:
        assert TaskCommentSerializer().validate_body(" ship it ") == " ship it "

    def test_absent_parent_is_allowed(self) -> None:
        # A top-level comment sends parent=null; the nesting rules do not apply.
        assert TaskCommentSerializer().validate_parent(None) is None

    def test_reply_to_a_reply_is_rejected(self) -> None:
        parent = TaskComment(parent=TaskComment())
        with pytest.raises(serializers.ValidationError, match="one level only"):
            TaskCommentSerializer().validate_parent(parent)

    def test_blank_note_body_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="Body cannot be blank"):
            TaskNoteSerializer().validate_body("\n\t")

    def test_blank_risk_comment_message_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="Message cannot be blank"):
            RiskCommentSerializer().validate_message("  ")

    def test_risk_comment_message_with_content_is_accepted(self) -> None:
        assert RiskCommentSerializer().validate_message("Mitigation agreed") == (
            "Mitigation agreed"
        )


class TestCommentViewerState:
    """The per-viewer flags degrade to "not mine" without an authenticated reader."""

    def test_acknowledgement_flag_is_false_without_a_request(self) -> None:
        assert TaskCommentSerializer(context={}).get_has_my_acknowledgement(TaskComment()) is False

    def test_acknowledgement_flag_is_false_for_an_anonymous_reader(self) -> None:
        request = SimpleNamespace(user=SimpleNamespace(is_authenticated=False))
        assert (
            TaskCommentSerializer(context={"request": request}).get_has_my_acknowledgement(
                TaskComment()
            )
            is False
        )

    def test_reaction_flags_are_empty_without_a_request(self) -> None:
        serializer = TaskCommentSerializer(context={})
        comment = TaskComment()
        assert serializer.get_has_my_reaction(comment) is False
        assert serializer.get_my_reaction_id(comment) is None

    def test_reaction_id_is_none_for_an_anonymous_reader(self) -> None:
        request = SimpleNamespace(user=SimpleNamespace(is_authenticated=False))
        serializer = TaskCommentSerializer(context={"request": request})
        assert serializer.get_my_reaction_id(TaskComment()) is None


# --------------------------------------------------------------------------- #
# Identifier projections — short_id rendering must never blank a reference.
# --------------------------------------------------------------------------- #


class TestIdentifierProjections:
    def test_risk_without_a_short_id_renders_empty(self) -> None:
        assert RiskSerializer().get_short_id_display(Risk(short_id="")) == ""

    def test_numeric_risk_short_id_is_zero_padded(self) -> None:
        assert RiskSerializer().get_short_id_display(Risk(short_id="7")) == "R-007"

    def test_non_numeric_risk_short_id_is_surfaced_verbatim(self) -> None:
        # Hand-seeded / imported rows predate the decimal sequence; surface them
        # rather than blanking the reference.
        assert RiskSerializer().get_short_id_display(Risk(short_id="LEGACY")) == "R-LEGACY"

    def test_qualified_risk_id_falls_back_to_the_compact_form_without_a_project(self) -> None:
        assert RiskSerializer().get_qualified_id(Risk(short_id="7")) == "R-007"

    def test_task_without_a_short_id_renders_empty(self) -> None:
        assert TaskSerializer().get_short_id_display(Task(short_id="")) == ""

    def test_hex_task_short_id_is_decoded_to_its_sequence(self) -> None:
        assert TaskSerializer().get_short_id_display(Task(short_id="0000000A")) == "T-10"

    def test_unparseable_task_short_id_is_surfaced_verbatim(self) -> None:
        assert TaskSerializer().get_short_id_display(Task(short_id="ZZZ")) == "T-ZZZ"


class TestRiskOwnerProjections:
    def test_owner_name_is_none_when_the_risk_is_unowned(self) -> None:
        assert RiskSerializer().get_owner_name(Risk()) is None
        assert RiskSerializer().get_owner_initials(Risk()) is None

    def test_owner_name_falls_back_to_the_username(self) -> None:
        risk = Risk(owner=User(username="ada", first_name="", last_name=""))
        assert RiskSerializer().get_owner_name(risk) == "ada"

    def test_initials_use_the_first_name_alone_when_there_is_no_surname(self) -> None:
        risk = Risk(owner=User(username="ada", first_name="Ada", last_name=""))
        assert RiskSerializer().get_owner_initials(risk) == "A"

    def test_initials_use_the_surname_alone_when_there_is_no_first_name(self) -> None:
        risk = Risk(owner=User(username="ada", first_name="", last_name="lovelace"))
        assert RiskSerializer().get_owner_initials(risk) == "L"

    def test_initials_combine_both_names(self) -> None:
        risk = Risk(owner=User(username="ada", first_name="Ada", last_name="Lovelace"))
        assert RiskSerializer().get_owner_initials(risk) == "AL"

    def test_initials_fall_back_to_the_username_when_no_names_are_set(self) -> None:
        risk = Risk(owner=User(username="ada", first_name="", last_name=""))
        assert RiskSerializer().get_owner_initials(risk) == "AD"


# --------------------------------------------------------------------------- #
# Risk scoring bounds.
# --------------------------------------------------------------------------- #


class TestRiskScoring:
    @pytest.mark.parametrize("bad", [0, 6, -1])
    def test_probability_outside_one_to_five_is_rejected(self, bad: int) -> None:
        with pytest.raises(serializers.ValidationError, match="probability"):
            RiskSerializer().validate_probability(bad)

    @pytest.mark.parametrize("bad", [0, 6])
    def test_impact_outside_one_to_five_is_rejected(self, bad: int) -> None:
        with pytest.raises(serializers.ValidationError, match="impact"):
            RiskSerializer().validate_impact(bad)

    def test_in_range_scores_are_returned_unchanged(self) -> None:
        assert RiskSerializer().validate_probability(3) == 3
        assert RiskSerializer().validate_impact(5) == 5

    def test_severity_is_the_probability_impact_product(self) -> None:
        assert RiskSerializer().get_severity(Risk(probability=3, impact=4)) == 12

    def test_more_than_ten_linked_tasks_are_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="at most 10 tasks"):
            RiskSerializer().validate_tasks([Task() for _ in range(11)])

    def test_ten_linked_tasks_are_allowed(self) -> None:
        tasks = [Task() for _ in range(10)]
        assert RiskSerializer().validate_tasks(tasks) == tasks


# --------------------------------------------------------------------------- #
# API token minting (#1713 blast-radius bound).
# --------------------------------------------------------------------------- #


class TestProjectApiTokenCreateValidation:
    def test_blank_name_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="name is required"):
            ProjectApiTokenCreateSerializer().validate_name("   ")

    def test_name_is_trimmed(self) -> None:
        assert ProjectApiTokenCreateSerializer().validate_name(" CI sync ") == "CI sync"

    def test_past_expiry_is_rejected(self) -> None:
        past = timezone.now() - timedelta(minutes=1)
        with pytest.raises(serializers.ValidationError, match="must be in the future"):
            ProjectApiTokenCreateSerializer().validate_expires_at(past)

    def test_future_expiry_is_accepted_and_null_means_never(self) -> None:
        future = timezone.now() + timedelta(days=1)
        assert ProjectApiTokenCreateSerializer().validate_expires_at(future) == future
        assert ProjectApiTokenCreateSerializer().validate_expires_at(None) is None

    def test_status_map_must_be_an_object(self) -> None:
        with pytest.raises(serializers.ValidationError, match="must be an object"):
            ProjectApiTokenCreateSerializer().validate_status_map(["Done"])

    def test_status_map_entries_must_be_strings(self) -> None:
        with pytest.raises(serializers.ValidationError, match="must be strings"):
            ProjectApiTokenCreateSerializer().validate_status_map({"Done": 3})

    def test_status_map_values_must_be_real_task_statuses(self) -> None:
        with pytest.raises(serializers.ValidationError, match="not a valid TaskStatus"):
            ProjectApiTokenCreateSerializer().validate_status_map({"Done": "SHIPPED"})

    def test_valid_status_map_is_returned_unchanged(self) -> None:
        mapping = {"Done": "COMPLETE", "Doing": "IN_PROGRESS"}
        assert ProjectApiTokenCreateSerializer().validate_status_map(mapping) == mapping

    def test_empty_scopes_collapse_to_the_legacy_full_scope(self) -> None:
        assert ProjectApiTokenCreateSerializer().validate_scopes([]) == ["legacy:full"]

    def test_duplicate_scopes_are_deduped_in_request_order(self) -> None:
        assert ProjectApiTokenCreateSerializer().validate_scopes(["mcp:read", "mcp:read"]) == [
            "mcp:read"
        ]
        assert ProjectApiTokenCreateSerializer().validate_scopes(
            ["legacy:full", "legacy:full"]
        ) == ["legacy:full"]

    def test_the_two_scopes_cannot_be_combined(self) -> None:
        """#2877: the pair selects mutually exclusive enforcement postures.

        Previously accepted-but-meaningless (``legacy:full`` already granted everything
        ``mcp:read`` does). Now load-bearing: ``is_agent_token`` resolves such a token to
        full authority, so the settings UI would label it "read-only for AI assistants"
        while it wrote freely and ignored the instance kill switch. Both mint paths share
        ``_normalize_token_scopes``, because two copies of this rule is how they drifted.
        """
        with pytest.raises(serializers.ValidationError, match="cannot be combined"):
            ProjectApiTokenCreateSerializer().validate_scopes(
                ["mcp:read", "legacy:full", "mcp:read"]
            )
        with pytest.raises(serializers.ValidationError, match="cannot be combined"):
            MyApiTokenCreateSerializer().validate_scopes(["legacy:full", "mcp:read"])

    def test_an_mcp_read_token_is_refused_at_project_scope(self) -> None:
        # #2890: a project/program token has a null owner and the MCP read surface
        # admits owner-scoped tokens only, so the scope is rejected here outright
        # rather than minting a credential that can read nothing. This replaced an
        # assertion on the mcp:read *expiry* rule (#1713/#2764), which is now only
        # reachable on the personal surface — see TestPersonalAccessTokenCreate-
        # Validation below and test_personal_access_tokens.py.
        with pytest.raises(serializers.ValidationError, match="not available on a project"):
            ProjectApiTokenCreateSerializer().validate({"scopes": ["mcp:read"], "expires_at": None})

    def test_a_legacy_full_token_may_never_expire(self) -> None:
        attrs = {"scopes": ["legacy:full"], "expires_at": None}
        assert ProjectApiTokenCreateSerializer().validate(attrs) == attrs


class TestPersonalAccessTokenCreateValidation:
    def test_blank_name_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="name is required"):
            MyApiTokenCreateSerializer().validate_name("  ")

    def test_empty_scopes_collapse_to_the_legacy_full_scope(self) -> None:
        assert MyApiTokenCreateSerializer().validate_scopes([]) == ["legacy:full"]

    def test_duplicate_scopes_are_deduped(self) -> None:
        assert MyApiTokenCreateSerializer().validate_scopes(["mcp:read", "mcp:read"]) == [
            "mcp:read"
        ]

    def test_past_expiry_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError):
            MyApiTokenCreateSerializer().validate_expires_at(timezone.now() - timedelta(days=1))

    def test_an_mcp_read_token_must_carry_an_expiry(self) -> None:
        # #1713: a leaked read credential must be self-limiting. This unit-level
        # assertion moved here from the project serializer when #2890 made the
        # personal surface the only one that can mint mcp:read at all — the shared
        # `_validate_mcp_read_expiry` helper is now only reachable through this
        # serializer, so this is where its coverage belongs.
        with pytest.raises(serializers.ValidationError, match="expires_at is required"):
            MyApiTokenCreateSerializer().validate({"scopes": ["mcp:read"], "expires_at": None})


# --------------------------------------------------------------------------- #
# Inbound task-sync identifiers (ADR-0049).
# --------------------------------------------------------------------------- #


class TestInboundTaskSyncIdentifiers:
    def test_source_must_match_the_provider_slug_shape(self) -> None:
        with pytest.raises(serializers.ValidationError, match="must match"):
            InboundTaskSyncPayloadSerializer().validate_source("Jira Cloud")

    def test_conforming_source_is_accepted(self) -> None:
        assert InboundTaskSyncPayloadSerializer().validate_source("jira_cloud") == "jira_cloud"

    def test_blank_external_id_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="external_id is required"):
            InboundTaskSyncPayloadSerializer().validate_external_id("   ")

    def test_external_id_is_trimmed(self) -> None:
        assert InboundTaskSyncPayloadSerializer().validate_external_id(" PROJ-12 ") == "PROJ-12"


# --------------------------------------------------------------------------- #
# Backlog item title + tags.
# --------------------------------------------------------------------------- #


class TestBacklogItemValidation:
    def test_blank_title_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="Title is required"):
            BacklogItemSerializer().validate_title("   ")

    def test_title_is_trimmed(self) -> None:
        assert BacklogItemSerializer().validate_title("  Idea  ") == "Idea"

    def test_tags_must_be_a_list(self) -> None:
        with pytest.raises(serializers.ValidationError, match="tags must be a list"):
            BacklogItemSerializer().validate_tags("mobile,ux")

    def test_each_tag_must_be_a_string(self) -> None:
        with pytest.raises(serializers.ValidationError, match="Each tag must be a string"):
            BacklogItemSerializer().validate_tags(["mobile", 7])

    def test_tags_are_trimmed_deduped_and_stripped_of_blanks(self) -> None:
        assert BacklogItemSerializer().validate_tags([" mobile ", "mobile", "  ", "ux"]) == [
            "mobile",
            "ux",
        ]

    def test_pulled_status_cannot_be_set_by_a_direct_write(self) -> None:
        with pytest.raises(serializers.ValidationError, match="pull action"):
            BacklogItemSerializer().validate_status(BacklogItemStatus.PULLED)

    def test_other_statuses_pass_through(self) -> None:
        assert (
            BacklogItemSerializer().validate_status(BacklogItemStatus.ARCHIVED)
            == BacklogItemStatus.ARCHIVED
        )


# --------------------------------------------------------------------------- #
# Recurrence rule + guardrail policy.
# --------------------------------------------------------------------------- #


class TestRecurrenceRuleValidation:
    def test_unknown_timezone_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="Unknown IANA timezone"):
            TaskRecurrenceRuleSerializer().validate_timezone("Mars/Olympus_Mons")

    def test_blank_timezone_is_rejected(self) -> None:
        # ZoneInfo("") raises ValueError rather than ZoneInfoNotFoundError; both
        # map to the same client-facing error.
        with pytest.raises(serializers.ValidationError, match="Unknown IANA timezone"):
            TaskRecurrenceRuleSerializer().validate_timezone("")

    def test_known_timezone_is_accepted(self) -> None:
        assert TaskRecurrenceRuleSerializer().validate_timezone("Europe/Berlin") == "Europe/Berlin"

    def test_occurrence_count_prefers_the_queryset_annotation(self) -> None:
        rule = SimpleNamespace(_occurrence_count=4)
        assert TaskRecurrenceRuleSerializer().get_occurrence_count(rule) == 4


class TestGuardrailPolicyValidation:
    def test_unknown_rule_key_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="Unknown guardrail rule"):
            ProjectGuardrailPolicySerializer().validate_levels({"typo_in_sprint": "warn"})

    def test_unknown_level_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match=r"expected warn\|block"):
            ProjectGuardrailPolicySerializer().validate_levels({"summary_in_sprint": "error"})

    def test_valid_levels_pass_through(self) -> None:
        levels = {"summary_in_sprint": "block", "recurring_in_sprint": "warn"}
        assert ProjectGuardrailPolicySerializer().validate_levels(levels) == levels


# --------------------------------------------------------------------------- #
# Sprint field rules that do not need a persisted sprint.
# --------------------------------------------------------------------------- #


class TestSprintFieldValidation:
    def test_absent_target_milestone_is_allowed(self) -> None:
        assert SprintSerializer().validate_target_milestone(None) is None

    def test_non_milestone_target_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="must be a milestone"):
            SprintSerializer().validate_target_milestone(Task(is_milestone=False))

    def test_a_milestone_in_another_project_is_rejected(self) -> None:
        # Direct FK writes are an IDOR surface — the target is scoped to the
        # sprint's own project (ADR-0074).
        sprint = Sprint(project_id=uuid.uuid4())
        foreign_milestone = Task(project_id=uuid.uuid4(), is_milestone=True)
        with pytest.raises(serializers.ValidationError, match="same project"):
            SprintSerializer(instance=sprint).validate_target_milestone(foreign_milestone)

    def test_a_milestone_in_the_sprints_project_is_accepted(self) -> None:
        project_id = uuid.uuid4()
        sprint = Sprint(project_id=project_id)
        milestone = Task(project_id=project_id, is_milestone=True)
        assert SprintSerializer(instance=sprint).validate_target_milestone(milestone) is milestone

    def test_finish_on_the_start_date_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="finish_date must be after"):
            SprintSerializer().validate(
                {"start_date": date(2026, 4, 6), "finish_date": date(2026, 4, 6)}
            )

    def test_finish_before_start_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="finish_date must be after"):
            SprintSerializer().validate(
                {"start_date": date(2026, 4, 6), "finish_date": date(2026, 4, 1)}
            )

    def test_scheduler_owned_fields_require_an_authenticated_caller(self) -> None:
        # #1093: the gate must fail closed on CREATE too, where there is no
        # instance to resolve a membership from.
        with pytest.raises(serializers.ValidationError) as excinfo:
            SprintSerializer(context={}).validate({"capacity_points": 30})
        assert "capacity_points" in str(excinfo.value)

    def test_scheduler_gate_fails_closed_when_no_project_can_be_resolved(self) -> None:
        # Authenticated but neither an instance nor a nested project_pk: the gate
        # must deny rather than fall through to an unchecked write.
        request = SimpleNamespace(user=SimpleNamespace(is_authenticated=True))
        with pytest.raises(serializers.ValidationError, match="Only Scheduler"):
            SprintSerializer(context={"request": request}).validate({"wip_limit": 4})

    def test_non_scheduler_fields_skip_the_gate_entirely(self) -> None:
        attrs = {"name": "Sprint 7"}
        assert SprintSerializer(context={}).validate(attrs) == attrs


# --------------------------------------------------------------------------- #
# Attachment content sniffing (#1003 / #573) — the declared MIME is untrusted.
# --------------------------------------------------------------------------- #


class _UnreadableFile:
    """A file object whose bytes cannot be read (non-seekable stream stand-in)."""

    def read(self, size: int) -> bytes:
        raise OSError("stream is not readable")

    def seek(self, offset: int) -> None:
        raise OSError("stream is not seekable")


class TestAttachmentContentSniffing:
    def test_unreadable_file_falls_back_to_the_allow_list(self) -> None:
        assert _sniff_attachment_content(_UnreadableFile(), "application/pdf") is None

    def test_empty_upload_is_reported(self) -> None:
        assert _sniff_attachment_content(io.BytesIO(b""), "application/pdf") == (
            "Uploaded file is empty."
        )

    def test_matching_magic_bytes_pass(self) -> None:
        assert _sniff_attachment_content(io.BytesIO(b"%PDF-1.7\n%..."), "application/pdf") is None

    def test_mismatched_magic_bytes_are_reported(self) -> None:
        message = _sniff_attachment_content(io.BytesIO(b"MZ\x90\x00" * 4), "application/pdf")
        assert message is not None
        assert "application/pdf" in message

    def test_riff_container_that_is_not_webp_is_reported(self) -> None:
        # RIFF is shared with WAV/AVI — the "WEBP" tag at offset 8 is what makes
        # it a WebP image.
        riff_wave = b"RIFF" + b"\x00\x00\x00\x00" + b"WAVE" + b"fmt "
        message = _sniff_attachment_content(io.BytesIO(riff_wave), "image/webp")
        assert message == "File contents do not match the declared type 'image/webp'."

    def test_genuine_webp_passes(self) -> None:
        webp = b"RIFF" + b"\x00\x00\x00\x00" + b"WEBP" + b"VP8 "
        assert _sniff_attachment_content(io.BytesIO(webp), "image/webp") is None

    def test_markup_declared_as_csv_is_reported(self) -> None:
        message = _sniff_attachment_content(io.BytesIO(b"\xef\xbb\xbf  <svg/>"), "text/csv")
        assert message is not None
        assert "text/csv" in message

    def test_binary_payload_declared_as_csv_is_reported(self) -> None:
        # No binary signature exists for CSV, so a file carrying *another*
        # format's magic bytes is the smuggling case to catch.
        message = _sniff_attachment_content(io.BytesIO(b"\x89PNG\r\n\x1a\n rows"), "text/csv")
        assert message is not None
        assert "text/csv" in message

    def test_plain_csv_passes(self) -> None:
        assert _sniff_attachment_content(io.BytesIO(b"name,role\nAda,PM\n"), "text/csv") is None

    def test_the_file_pointer_is_rewound_for_the_subsequent_save(self) -> None:
        handle = io.BytesIO(b"%PDF-1.7 body")
        _sniff_attachment_content(handle, "application/pdf")
        assert handle.tell() == 0


# --------------------------------------------------------------------------- #
# Read-side projections that degrade without context.
# --------------------------------------------------------------------------- #


class TestContextFreeProjections:
    def test_duration_change_actor_is_none_for_an_automated_event(self) -> None:
        assert TaskDurationChangeEventSerializer().get_actor_name(TaskDurationChangeEvent()) is None

    def test_project_facets_are_false_without_an_authenticated_request(self) -> None:
        assert ProjectDetailSerializer(context={}).get_my_facets(Project()) == {
            "is_scrum_master": False,
            "is_product_owner": False,
        }

    def test_project_facets_are_false_for_an_anonymous_request(self) -> None:
        request = SimpleNamespace(user=SimpleNamespace(is_authenticated=False))
        assert ProjectDetailSerializer(context={"request": request}).get_my_facets(Project()) == {
            "is_scrum_master": False,
            "is_product_owner": False,
        }

    def test_program_detail_is_none_when_the_project_has_no_program(self) -> None:
        assert ProjectDetailSerializer().get_program_detail(Project()) is None

    def test_suggested_assignee_usernames_are_none_when_unset(self) -> None:
        suggestion = SimpleNamespace(
            suggested_user_id=None,
            suggested_user=None,
            suggested_by_id=None,
            suggested_by=None,
        )
        serializer = TaskSuggestedAssigneeSerializer()
        assert serializer.get_suggested_user_username(suggestion) is None
        assert serializer.get_suggested_by_username(suggestion) is None

    def test_suggested_assignee_usernames_are_read_through_when_set(self) -> None:
        suggestion = SimpleNamespace(
            suggested_user_id=7,
            suggested_user=SimpleNamespace(username="ada"),
            suggested_by_id=9,
            suggested_by=SimpleNamespace(username="grace"),
        )
        serializer = TaskSuggestedAssigneeSerializer()
        assert serializer.get_suggested_user_username(suggestion) == "ada"
        assert serializer.get_suggested_by_username(suggestion) == "grace"


# --------------------------------------------------------------------------- #
# Label catalog names (ADR-0400).
# --------------------------------------------------------------------------- #


class TestLabelValidation:
    def test_blank_label_name_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="cannot be blank"):
            LabelSerializer().validate_name("   ")

    def test_label_name_is_trimmed(self) -> None:
        assert LabelSerializer().validate_name("  needs-design  ") == "needs-design"


# --------------------------------------------------------------------------- #
# Immutability guards — a write that would silently move a row is refused.
# --------------------------------------------------------------------------- #


class TestImmutabilityGuards:
    def test_a_recurrence_rule_cannot_be_repointed_to_another_task(self) -> None:
        rule = TaskRecurrenceRule(task=Task())
        with pytest.raises(serializers.ValidationError, match="cannot be changed after creation"):
            TaskRecurrenceRuleSerializer(instance=rule).validate_task(Task())

    def test_a_recurrence_rule_accepts_its_own_task(self) -> None:
        task = Task()
        rule = TaskRecurrenceRule(task=task)
        assert TaskRecurrenceRuleSerializer(instance=rule).validate_task(task) is task

    def test_a_relation_source_cannot_be_repointed(self) -> None:
        project_id = uuid.uuid4()
        source, target = Task(project_id=project_id), Task(project_id=project_id)
        relation = TaskRelation(source=source, target=target)
        with pytest.raises(serializers.ValidationError, match="cannot be changed after creation"):
            TaskRelationSerializer(instance=relation).validate({"source": Task()})

    def test_a_relation_target_cannot_be_repointed(self) -> None:
        project_id = uuid.uuid4()
        source, target = Task(project_id=project_id), Task(project_id=project_id)
        relation = TaskRelation(source=source, target=target)
        with pytest.raises(serializers.ValidationError, match="cannot be changed after creation"):
            TaskRelationSerializer(instance=relation).validate({"target": Task()})

    def test_a_task_cannot_relate_to_itself(self) -> None:
        task = Task(project_id=uuid.uuid4())
        with pytest.raises(serializers.ValidationError, match="cannot relate to itself"):
            TaskRelationSerializer().validate({"source": task, "target": task})

    def test_a_cross_project_relation_needs_a_request_to_authorize_against(self) -> None:
        # Scripted/internal callers carry no request, so there is no authority to
        # check — refuse rather than create an unauthorized cross-project link.
        source = Task(project_id=uuid.uuid4())
        target = Task(project_id=uuid.uuid4())
        with pytest.raises(serializers.ValidationError, match="only be created through the API"):
            TaskRelationSerializer(context={}).validate({"source": source, "target": target})


# --------------------------------------------------------------------------- #
# Attachment file-XOR-url + external URL scheme (ADR-0075).
# --------------------------------------------------------------------------- #


class TestAttachmentPayloadShape:
    def test_neither_a_file_nor_a_url_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="not both and not neither"):
            TaskAttachmentSerializer().validate({})

    def test_a_non_http_external_url_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="Only http"):
            TaskAttachmentSerializer().validate({"external_url": "javascript:alert(1)"})

    def test_a_schemeless_external_url_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="Only http"):
            TaskAttachmentSerializer().validate({"external_url": "www.example.com/spec"})

    def test_an_https_external_url_is_accepted_and_its_title_left_alone(self) -> None:
        attrs = {"external_url": "https://example.com/spec.pdf"}
        assert TaskAttachmentSerializer().validate(attrs) == attrs

    def test_a_supplied_file_name_is_sanitized(self) -> None:
        cleaned = TaskAttachmentSerializer().validate(
            {
                "external_url": "https://example.com/spec.pdf",
                "file_name": "../../<script>alert(1)</script>  report.pdf",
            }
        )
        assert "<" not in cleaned["file_name"]
        assert "/" not in cleaned["file_name"]


# --------------------------------------------------------------------------- #
# Risk cross-field validation without a project in scope.
# --------------------------------------------------------------------------- #


class TestRiskCrossFieldValidation:
    def test_validation_is_a_no_op_when_no_project_can_be_resolved(self) -> None:
        # No instance and no request (schema generation / internal construction):
        # the project-scoping checks have nothing to scope against and pass through.
        attrs: dict[str, Any] = {"title": "Vendor slip"}
        assert RiskSerializer().validate(attrs) == attrs

    def test_a_past_mitigation_due_date_is_accepted(self) -> None:
        # Deliberately non-blocking: an overdue risk must stay editable.
        past = date(2020, 1, 1)
        assert RiskSerializer().validate_mitigation_due_date(past) == past


# --------------------------------------------------------------------------- #
# Project settings bounds + inheritance no-ops.
# --------------------------------------------------------------------------- #


class TestProjectSettingsValidation:
    def test_an_empty_project_code_is_allowed(self) -> None:
        assert ProjectSerializer().validate_code("") == ""

    def test_an_over_long_project_code_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="12 characters or fewer"):
            ProjectSerializer().validate_code("ENGINEERING-2026")

    def test_a_hyphen_edged_project_code_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="may not start or end"):
            ProjectSerializer().validate_code("-ENG")

    def test_a_conforming_project_code_is_accepted(self) -> None:
        assert ProjectSerializer().validate_code("ENG-2026") == "ENG-2026"

    @pytest.mark.parametrize("bad", [0, 366])
    def test_stale_task_threshold_outside_one_year_is_rejected(self, bad: int) -> None:
        with pytest.raises(serializers.ValidationError, match="between 1 and 365"):
            ProjectSerializer().validate_stale_task_threshold_days(bad)

    def test_stale_task_threshold_inside_the_range_is_accepted(self) -> None:
        assert ProjectSerializer().validate_stale_task_threshold_days(14) == 14

    @pytest.mark.parametrize("bad", [0, 366])
    def test_end_date_shift_threshold_outside_one_year_is_rejected(self, bad: int) -> None:
        with pytest.raises(serializers.ValidationError, match="between 1 and 365"):
            ProjectSerializer().validate_end_date_shift_threshold_days(bad)

    def test_end_date_shift_threshold_inside_the_range_is_accepted(self) -> None:
        assert ProjectSerializer().validate_end_date_shift_threshold_days(3) == 3

    def test_unsetting_the_lead_is_always_allowed(self) -> None:
        assert ProjectSerializer().validate_lead(None) is None

    def test_the_lead_membership_check_is_skipped_on_create(self) -> None:
        # No instance yet, so there are no membership rows to check against.
        lead = User(username="ada")
        assert ProjectSerializer().validate_lead(lead) is lead

    def test_the_program_gate_is_skipped_without_an_authenticated_request(self) -> None:
        assert ProjectSerializer(context={}).validate_program(None) is None

    def test_keeping_the_current_calendar_does_not_trip_the_policy_lock(self) -> None:
        # A PATCH that re-sends the calendar it already had is a no-op, so the
        # workspace lock is never consulted.
        assert ProjectSerializer(instance=Project()).validate_calendar(None) is None


class TestProgramSettingsValidation:
    def test_a_null_iteration_label_clears_the_override(self) -> None:
        assert ProgramSerializer().validate_iteration_label(None) is None

    def test_a_blank_iteration_label_is_rejected(self) -> None:
        # "Inherit" already has an explicit representation (null).
        with pytest.raises(serializers.ValidationError, match="clear it to inherit"):
            ProgramSerializer().validate_iteration_label("   ")

    def test_an_iteration_label_is_trimmed(self) -> None:
        assert ProgramSerializer().validate_iteration_label("  Increment  ") == "Increment"

    def test_keeping_the_current_methodology_does_not_trip_the_policy_lock(self) -> None:
        program = Program()
        serializer = ProgramSerializer(instance=program)
        assert serializer.validate_methodology(program.methodology) == program.methodology

    def test_keeping_the_current_calendar_does_not_trip_the_policy_lock(self) -> None:
        assert ProgramSerializer(instance=Program()).validate_calendar(None) is None

    def test_a_null_attachment_override_means_inherit(self) -> None:
        assert ProgramSerializer().validate_allowed_attachment_types(None) is None

    def test_a_security_denied_attachment_type_cannot_be_allowed(self) -> None:
        with pytest.raises(serializers.ValidationError, match="blocked for security"):
            ProgramSerializer().validate_allowed_attachment_types(["application/pdf", "text/html"])

    def test_an_allowed_attachment_override_is_normalized(self) -> None:
        assert ProgramSerializer().validate_allowed_attachment_types(
            ["APPLICATION/PDF; charset=utf-8", "", "application/pdf"]
        ) == ["application/pdf"]


class TestCeremonyTemplateValidation:
    def test_a_blank_ceremony_name_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="Name is required"):
            CeremonyTemplateSerializer().validate_name("   ")

    def test_a_reserved_sprint_event_name_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match="configured per-sprint"):
            CeremonyTemplateSerializer().validate_name("sprint planning")

    def test_a_program_level_name_is_accepted_and_trimmed(self) -> None:
        assert CeremonyTemplateSerializer().validate_name("  Program sync ") == "Program sync"


class TestBoardSavedViewConfigValidation:
    def test_config_must_be_an_object(self) -> None:
        with pytest.raises(serializers.ValidationError, match="config must be an object"):
            BoardSavedViewSerializer().validate_config(["sort"])

    def test_an_unknown_sort_key_is_rejected(self) -> None:
        with pytest.raises(serializers.ValidationError, match=r"config\.sort"):
            BoardSavedViewSerializer().validate_config({"sort": "vibes"})

    def test_a_non_boolean_toggle_is_rejected(self) -> None:
        with pytest.raises(
            serializers.ValidationError, match=r"config\.show_wip must be a boolean"
        ):
            BoardSavedViewSerializer().validate_config({"show_wip": "yes"})


class TestSlipConflictProjection:
    def test_the_upstream_card_is_none_once_the_edge_is_deleted(self) -> None:
        # The conflict auto-resolves on the next pass; until then the row must
        # serialize without dereferencing a dependency that is gone.
        conflict = CrossProjectSlipConflict(dependency=None)
        assert CrossProjectSlipConflictSerializer().get_upstream_task(conflict) is None
