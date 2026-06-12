"""URL routing for the projects app."""

from __future__ import annotations

from django.urls import path
from rest_framework.routers import DefaultRouter

from trueppm_api.apps.integrations.views import TaskLinkViewSet
from trueppm_api.apps.projects.backlog_views import BacklogItemViewSet
from trueppm_api.apps.projects.ceremony_views import (
    CeremonyTemplateViewSet,
    PhaseGateConfigView,
    ProjectGuardrailPolicyView,
)
from trueppm_api.apps.projects.program_views import ProgramViewSet
from trueppm_api.apps.projects.signal_privacy_views import (
    SignalPrivacyPolicyView,
    SignalPrivacyRaiseCeilingView,
    SignalPrivacyRatchetDownView,
)
from trueppm_api.apps.projects.views import (
    AcceptanceCriterionViewSet,
    ApiTokenAuditView,
    BaselineActivateView,
    BaselineViewSet,
    BoardColumnConfigView,
    BoardSavedViewDetailView,
    BoardSavedViewListView,
    CalendarViewSet,
    CommentReactionViewSet,
    DependencyViewSet,
    MeActiveSprintsView,
    MeWorkView,
    PhaseReorderView,
    PhaseViewSet,
    ProgramApiTokenAuditView,
    ProgramApiTokenViewSet,
    ProjectApiTokenViewSet,
    ProjectAttentionView,
    ProjectBurnView,
    ProjectCustomFieldViewSet,
    ProjectForecastView,
    ProjectMilestonesView,
    ProjectMyTasksView,
    ProjectOverviewView,
    ProjectPresenceView,
    ProjectSprintHealthView,
    ProjectVelocityView,
    ProjectViewSet,
    RetroBoardItemViewSet,
    RiskCommentViewSet,
    RiskViewSet,
    SprintScopeChangeViewSet,
    SprintTaskOutcomeViewSet,
    SprintViewSet,
    TaskAttachmentViewSet,
    TaskBaselineDetailView,
    TaskBulkView,
    TaskCommentViewSet,
    TaskHistoryView,
    TaskIndentView,
    TaskOutdentView,
    TaskRecurrenceRuleViewSet,
    TaskReorderView,
    TaskReparentView,
    TaskSyncView,
    TaskViewSet,
)

router = DefaultRouter()
router.register(r"calendars", CalendarViewSet, basename="calendar")
router.register(r"projects", ProjectViewSet, basename="project")
router.register(r"programs", ProgramViewSet, basename="program")
router.register(r"tasks", TaskViewSet, basename="task")
router.register(r"dependencies", DependencyViewSet, basename="dependency")
router.register(r"recurrence-rules", TaskRecurrenceRuleViewSet, basename="recurrence-rule")
router.register(r"acceptance-criteria", AcceptanceCriterionViewSet, basename="acceptance-criterion")

urlpatterns = [
    *router.urls,
    # Nested project actions — not routable via DefaultRouter.
    path(
        "projects/<pk>/tasks/reorder/",
        TaskReorderView.as_view(),
        name="project-tasks-reorder",
    ),
    path(
        "projects/<pk>/tasks/bulk/",
        TaskBulkView.as_view(),
        name="project-tasks-bulk",
    ),
    path(
        "projects/<pk>/tasks/<task_id>/indent/",
        TaskIndentView.as_view(),
        name="project-task-indent",
    ),
    path(
        "projects/<pk>/tasks/<task_id>/outdent/",
        TaskOutdentView.as_view(),
        name="project-task-outdent",
    ),
    path(
        "projects/<pk>/tasks/<task_id>/reparent/",
        TaskReparentView.as_view(),
        name="project-task-reparent",
    ),
    # Baseline endpoints — nested under /projects/<project_pk>/baselines/
    path(
        "projects/<project_pk>/baselines/",
        BaselineViewSet.as_view({"get": "list", "post": "create"}),
        name="project-baselines-list",
    ),
    path(
        "projects/<project_pk>/baselines/<pk>/",
        BaselineViewSet.as_view({"get": "retrieve", "delete": "destroy"}),
        name="project-baselines-detail",
    ),
    path(
        "projects/<project_pk>/baselines/<baseline_pk>/activate/",
        BaselineActivateView.as_view(),
        name="project-baselines-activate",
    ),
    path(
        "projects/<pk>/board-config/",
        BoardColumnConfigView.as_view(),
        name="project-board-config",
    ),
    path(
        "projects/<pk>/board-views/",
        BoardSavedViewListView.as_view(),
        name="project-board-views",
    ),
    path(
        "projects/<pk>/board-views/<view_pk>/",
        BoardSavedViewDetailView.as_view(),
        name="project-board-views-detail",
    ),
    # Presence endpoint — who is connected to this project's WebSocket
    path(
        "projects/<pk>/presence/",
        ProjectPresenceView.as_view(),
        name="project-presence",
    ),
    # Overview dashboard endpoints (ADR-0030)
    path(
        "projects/<pk>/overview/",
        ProjectOverviewView.as_view(),
        name="project-overview",
    ),
    path(
        "projects/<pk>/attention/",
        ProjectAttentionView.as_view(),
        name="project-attention",
    ),
    path(
        "projects/<pk>/my-tasks/",
        ProjectMyTasksView.as_view(),
        name="project-my-tasks",
    ),
    # Task drawer — history and baseline (ADR-0032)
    path(
        "projects/<project_pk>/tasks/<task_pk>/history/",
        TaskHistoryView.as_view(),
        name="project-task-history",
    ),
    path(
        "projects/<project_pk>/tasks/<task_pk>/baseline/",
        TaskBaselineDetailView.as_view(),
        name="project-task-baseline",
    ),
    # Risk endpoints — nested under /projects/<project_pk>/risks/
    path(
        "projects/<project_pk>/risks/",
        RiskViewSet.as_view({"get": "list", "post": "create"}),
        name="project-risks-list",
    ),
    path(
        "projects/<project_pk>/risks/<pk>/",
        RiskViewSet.as_view(
            {
                "get": "retrieve",
                "put": "update",
                "patch": "partial_update",
                "delete": "destroy",
            }
        ),
        name="project-risks-detail",
    ),
    # Risk comments — append-only thread per risk (ADR-0044)
    path(
        "projects/<project_pk>/risks/<risk_pk>/comments/",
        RiskCommentViewSet.as_view({"get": "list", "post": "create"}),
        name="project-risk-comments-list",
    ),
    # Phase reorder — workshop mode drag-to-reorder (ADR-0046)
    path(
        "projects/<pk>/phases/reorder/",
        PhaseReorderView.as_view(),
        name="project-phases-reorder",
    ),
    # Phase CRUD — Workflow settings page (#521). Reorder lives at /phases/reorder/.
    path(
        "projects/<project_pk>/phases/",
        PhaseViewSet.as_view({"get": "list", "post": "create"}),
        name="project-phases-list",
    ),
    path(
        "projects/<project_pk>/phases/<pk>/",
        PhaseViewSet.as_view(
            {
                "get": "retrieve",
                "put": "update",
                "patch": "partial_update",
                "delete": "destroy",
            }
        ),
        name="project-phases-detail",
    ),
    # Project custom field definitions — Workflow settings page (#521).
    path(
        "projects/<project_pk>/fields/",
        ProjectCustomFieldViewSet.as_view({"get": "list", "post": "create"}),
        name="project-fields-list",
    ),
    path(
        "projects/<project_pk>/fields/<pk>/",
        ProjectCustomFieldViewSet.as_view(
            {
                "get": "retrieve",
                "put": "update",
                "patch": "partial_update",
                "delete": "destroy",
            }
        ),
        name="project-fields-detail",
    ),
    # Sprint/Phase/WBS guardrail policy — singleton per project (ADR-0101).
    path(
        "projects/<project_pk>/guardrail-policy/",
        ProjectGuardrailPolicyView.as_view(),
        name="project-guardrail-policy",
    ),
    # Team-signal privacy policy — singleton per project (ADR-0104).
    path(
        "projects/<project_pk>/signal-privacy/",
        SignalPrivacyPolicyView.as_view(),
        name="project-signal-privacy",
    ),
    path(
        "projects/<project_pk>/signal-privacy/raise-ceiling/",
        SignalPrivacyRaiseCeilingView.as_view(),
        name="project-signal-privacy-raise-ceiling",
    ),
    path(
        "projects/<project_pk>/signal-privacy/ratchet-down/",
        SignalPrivacyRatchetDownView.as_view(),
        name="project-signal-privacy-ratchet-down",
    ),
    # Sprint endpoints (ADR-0037)
    path(
        "projects/<project_pk>/sprints/",
        SprintViewSet.as_view({"get": "list", "post": "create"}),
        name="project-sprints-list",
    ),
    path(
        "sprints/<pk>/",
        SprintViewSet.as_view(
            {
                "get": "retrieve",
                "put": "update",
                "patch": "partial_update",
                "delete": "destroy",
            }
        ),
        name="sprints-detail",
    ),
    path(
        "sprints/<pk>/activate/",
        SprintViewSet.as_view({"post": "activate"}),
        name="sprints-activate",
    ),
    path(
        "sprints/<pk>/close/",
        SprintViewSet.as_view({"post": "close"}),
        name="sprints-close",
    ),
    path(
        "sprints/<pk>/cancel/",
        SprintViewSet.as_view({"post": "cancel"}),
        name="sprints-cancel",
    ),
    path(
        "sprints/<pk>/burndown/",
        SprintViewSet.as_view({"get": "burndown"}),
        name="sprints-burndown",
    ),
    path(
        "sprints/<pk>/outcome/",
        SprintViewSet.as_view({"get": "outcome"}),
        name="sprints-outcome",
    ),
    # Sprint Review demo-list curation (ADR-0118, #924)
    path(
        "sprint-task-outcomes/<pk>/toggle-demo/",
        SprintTaskOutcomeViewSet.as_view({"post": "toggle_demo"}),
        name="sprint-task-outcome-toggle-demo",
    ),
    # Team daily-standup "what changed since yesterday" delta (ADR-0121, #925)
    path(
        "sprints/<pk>/daily-delta/",
        SprintViewSet.as_view({"get": "daily_delta"}),
        name="sprints-daily-delta",
    ),
    # Sprint↔milestone binding — the agile/waterfall bridge (ADR-0106 §2)
    path(
        "sprints/<pk>/promote-to-milestone/",
        SprintViewSet.as_view({"post": "promote_to_milestone"}),
        name="sprints-promote-to-milestone",
    ),
    path(
        "sprints/<pk>/unbind-milestone/",
        SprintViewSet.as_view({"post": "unbind_milestone"}),
        name="sprints-unbind-milestone",
    ),
    # Dry-run reforecast preview for the promote dialog (ADR-0106 §E1.1, #928)
    path(
        "sprints/<pk>/reforecast-preview/",
        SprintViewSet.as_view({"get": "reforecast_preview"}),
        name="sprints-reforecast-preview",
    ),
    # Mid-sprint scope-injection approve-gate (ADR-0102 §5)
    # GET list (audit + delta, #543/#550) is registered before the /accept|/reject
    # POSTs; all three share the scope-changes/ prefix but resolve distinctly.
    path(
        "sprints/<pk>/scope-changes/",
        SprintViewSet.as_view({"get": "scope_changes"}),
        name="sprints-scope-changes",
    ),
    path(
        "sprints/<pk>/scope-changes/accept/",
        SprintViewSet.as_view({"post": "scope_changes_accept"}),
        name="sprints-scope-changes-accept",
    ),
    path(
        "sprints/<pk>/scope-changes/reject/",
        SprintViewSet.as_view({"post": "scope_changes_reject"}),
        name="sprints-scope-changes-reject",
    ),
    path(
        "scope-changes/<pk>/accept/",
        SprintScopeChangeViewSet.as_view({"post": "accept"}),
        name="scope-changes-accept",
    ),
    path(
        "scope-changes/<pk>/reject/",
        SprintScopeChangeViewSet.as_view({"post": "reject"}),
        name="scope-changes-reject",
    ),
    path(
        "sprints/<pk>/capacity/",
        SprintViewSet.as_view({"get": "capacity"}),
        name="sprints-capacity",
    ),
    path(
        "sprints/<pk>/incoming_carryover/",
        SprintViewSet.as_view({"get": "incoming_carryover"}),
        name="sprints-incoming-carryover",
    ),
    path(
        "sprints/<pk>/retro/",
        SprintViewSet.as_view({"get": "retro", "post": "retro", "patch": "retro"}),
        name="sprints-retro",
    ),
    # Live multi-writer retro board + team-health pulse (ADR-0117, #851 / #923)
    path(
        "sprints/<pk>/retro-board/",
        SprintViewSet.as_view({"get": "retro_board", "post": "retro_board"}),
        name="sprints-retro-board",
    ),
    path(
        "sprints/<pk>/pulse/",
        SprintViewSet.as_view({"get": "pulse", "put": "pulse"}),
        name="sprints-pulse",
    ),
    path(
        "sprints/<pk>/pulse-trend/",
        SprintViewSet.as_view({"get": "pulse_trend"}),
        name="sprints-pulse-trend",
    ),
    path(
        "retro-items/<pk>/",
        RetroBoardItemViewSet.as_view({"patch": "partial_update", "delete": "destroy"}),
        name="retro-item-detail",
    ),
    path(
        "retro-items/<pk>/convert-to-action/",
        RetroBoardItemViewSet.as_view({"post": "convert_to_action"}),
        name="retro-item-convert-to-action",
    ),
    # Retrospective sub-resource endpoints (ADR-0071)
    path(
        "sprints/<pk>/retrospective/prior/",
        SprintViewSet.as_view({"get": "retro_prior"}),
        name="sprints-retro-prior",
    ),
    path(
        "sprints/<pk>/retrospective/action-items/<uuid:item_pk>/promote/",
        SprintViewSet.as_view({"post": "promote_action_item"}),
        name="sprints-retro-promote",
    ),
    path(
        "sprints/<pk>/retrospective/action-items/<uuid:item_pk>/pull-to-sprint/",
        SprintViewSet.as_view({"post": "pull_action_item_to_sprint"}),
        name="sprints-retro-pull-to-sprint",
    ),
    path(
        "projects/<pk>/retrospective/carryover/",
        ProjectViewSet.as_view({"get": "retro_carryover"}),
        name="project-retro-carryover",
    ),
    # TaskSuggestedAssignee endpoints (ADR-0071 §5)
    path(
        "tasks/<pk>/suggestions/<uuid:suggestion_pk>/accept/",
        TaskViewSet.as_view({"post": "accept_suggestion"}),
        name="task-suggestion-accept",
    ),
    path(
        "tasks/<pk>/suggestions/<uuid:suggestion_pk>/decline/",
        TaskViewSet.as_view({"post": "decline_suggestion"}),
        name="task-suggestion-decline",
    ),
    path(
        "tasks/<pk>/suggestions/<uuid:suggestion_pk>/revoke/",
        TaskViewSet.as_view({"post": "revoke_suggestion"}),
        name="task-suggestion-revoke",
    ),
    path(
        "projects/<pk>/velocity/",
        ProjectVelocityView.as_view(),
        name="project-velocity",
    ),
    path(
        "projects/<pk>/sprint-health/",
        ProjectSprintHealthView.as_view(),
        name="project-sprint-health",
    ),
    # Bridge forecast read: velocity range + sprints-to-complete + per-milestone
    # latest ForecastSnapshot (ADR-0106 §5, #487/#860).
    path(
        "projects/<pk>/forecast/",
        ProjectForecastView.as_view(),
        name="project-forecast",
    ),
    # Slim milestone list for the bind-existing picker (ADR-0106 §E1.3, #928)
    path(
        "projects/<pk>/milestones/",
        ProjectMilestonesView.as_view(),
        name="project-milestones",
    ),
    path(
        "projects/<pk>/burn/",
        ProjectBurnView.as_view(),
        name="project-burn",
    ),
    path(
        "me/active-sprints/",
        MeActiveSprintsView.as_view(),
        name="me-active-sprints",
    ),
    # My Work — contributor surface (ADR-0065 Gap 2, issue #499)
    path(
        "me/work/",
        MeWorkView.as_view(),
        name="me-work",
    ),
    # Inbound task-sync — ADR-0068 (ADR-0065 Gap 3, issue #500)
    path(
        "projects/<pk>/task-sync/",
        TaskSyncView.as_view(),
        name="project-task-sync",
    ),
    path(
        "projects/<project_pk>/api-tokens/",
        ProjectApiTokenViewSet.as_view({"get": "list", "post": "create"}),
        name="project-api-tokens-list",
    ),
    path(
        "projects/<project_pk>/api-tokens/<pk>/",
        ProjectApiTokenViewSet.as_view({"get": "retrieve", "delete": "destroy"}),
        name="project-api-tokens-detail",
    ),
    path(
        "projects/<project_pk>/api-token-audit/",
        ApiTokenAuditView.as_view(),
        name="project-api-token-audit",
    ),
    # Program-scoped API tokens (ADR-0076 program extension, #600)
    path(
        "programs/<program_pk>/api-tokens/",
        ProgramApiTokenViewSet.as_view({"get": "list", "post": "create"}),
        name="program-api-tokens-list",
    ),
    path(
        "programs/<program_pk>/api-tokens/<pk>/",
        ProgramApiTokenViewSet.as_view({"get": "retrieve", "delete": "destroy"}),
        name="program-api-tokens-detail",
    ),
    path(
        "programs/<program_pk>/api-token-audit/",
        ProgramApiTokenAuditView.as_view(),
        name="program-api-token-audit",
    ),
    # Task collaboration endpoints (ADR-0075, #310 #311)
    path(
        "projects/<project_pk>/tasks/<task_pk>/attachments/",
        TaskAttachmentViewSet.as_view({"get": "list", "post": "create"}),
        name="project-task-attachments-list",
    ),
    path(
        "projects/<project_pk>/tasks/<task_pk>/attachments/<pk>/",
        TaskAttachmentViewSet.as_view({"get": "retrieve", "delete": "destroy"}),
        name="project-task-attachments-detail",
    ),
    path(
        "projects/<project_pk>/tasks/<task_pk>/attachments/<pk>/signed-url/",
        TaskAttachmentViewSet.as_view({"get": "signed_url"}),
        name="project-task-attachments-signed-url",
    ),
    # Git-aware task links (ADR-0049 §3, #637)
    path(
        "projects/<project_pk>/tasks/<task_pk>/links/",
        TaskLinkViewSet.as_view({"get": "list", "post": "create"}),
        name="project-task-links-list",
    ),
    path(
        "projects/<project_pk>/tasks/<task_pk>/links/<pk>/",
        TaskLinkViewSet.as_view(
            {"get": "retrieve", "patch": "partial_update", "delete": "destroy"}
        ),
        name="project-task-links-detail",
    ),
    path(
        "projects/<project_pk>/tasks/<task_pk>/links/<pk>/refresh/",
        TaskLinkViewSet.as_view({"post": "refresh"}),
        name="project-task-links-refresh",
    ),
    path(
        "projects/<project_pk>/tasks/<task_pk>/comments/",
        TaskCommentViewSet.as_view({"get": "list", "post": "create"}),
        name="project-task-comments-list",
    ),
    path(
        "projects/<project_pk>/tasks/<task_pk>/comments/<pk>/",
        TaskCommentViewSet.as_view(
            {"get": "retrieve", "patch": "partial_update", "delete": "destroy"}
        ),
        name="project-task-comments-detail",
    ),
    path(
        "projects/<project_pk>/tasks/<task_pk>/comments/<pk>/acknowledge/",
        TaskCommentViewSet.as_view({"post": "acknowledge", "delete": "acknowledge"}),
        name="project-task-comments-acknowledge",
    ),
    path(
        "projects/<project_pk>/tasks/<task_pk>/comments/<comment_pk>/reactions/",
        CommentReactionViewSet.as_view({"post": "create"}),
        name="project-task-comment-reactions-list",
    ),
    path(
        "projects/<project_pk>/tasks/<task_pk>/comments/<comment_pk>/reactions/<pk>/",
        CommentReactionViewSet.as_view({"delete": "destroy"}),
        name="project-task-comment-reactions-detail",
    ),
    # Program ceremony templates + phase-gate config (ADR-0079, #528)
    path(
        "programs/<program_pk>/ceremonies/",
        CeremonyTemplateViewSet.as_view({"get": "list", "post": "create"}),
        name="program-ceremonies-list",
    ),
    path(
        "programs/<program_pk>/ceremonies/<pk>/",
        CeremonyTemplateViewSet.as_view(
            {
                "get": "retrieve",
                "patch": "partial_update",
                "put": "update",
                "delete": "destroy",
            }
        ),
        name="program-ceremonies-detail",
    ),
    path(
        "programs/<program_pk>/phase-gate-config/",
        PhaseGateConfigView.as_view(),
        name="program-phase-gate-config",
    ),
    # Program backlog (ADR-0069, #737 / #739)
    path(
        "programs/<program_pk>/backlog-items/",
        BacklogItemViewSet.as_view({"get": "list", "post": "create"}),
        name="program-backlog-items-list",
    ),
    path(
        "programs/<program_pk>/backlog-items/<pk>/",
        BacklogItemViewSet.as_view(
            {
                "get": "retrieve",
                "patch": "partial_update",
                "put": "update",
                "delete": "destroy",
            }
        ),
        name="program-backlog-items-detail",
    ),
    path(
        "programs/<program_pk>/backlog-items/<pk>/pull/",
        BacklogItemViewSet.as_view({"post": "pull"}),
        name="program-backlog-items-pull",
    ),
]
