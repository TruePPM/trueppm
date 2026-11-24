"""URL patterns for the agents app: the agent-action log (#1805) and Agents page (#4814)."""

from __future__ import annotations

from django.urls import path

from trueppm_api.apps.agents.agent_views import (
    AgentAuditVerifyView,
    AgentDetailView,
    AgentListView,
    AgentPauseView,
    AgentResumeView,
    AgentRevokeView,
    AgentScopeView,
)
from trueppm_api.apps.agents.views import AgentActionViewSet

agent_action_list = AgentActionViewSet.as_view({"get": "list"})
agent_action_detail = AgentActionViewSet.as_view({"get": "retrieve"})

urlpatterns = [
    path("agent-actions/", agent_action_list, name="agent-action-list"),
    path("agent-actions/<uuid:pk>/", agent_action_detail, name="agent-action-detail"),
    # Workspace Agents page + control plane (#4814, #4757). Person-only.
    path("agents/", AgentListView.as_view(), name="agent-list"),
    path("agents/audit-verify/", AgentAuditVerifyView.as_view(), name="agent-audit-verify"),
    path("agents/<uuid:pk>/", AgentDetailView.as_view(), name="agent-detail"),
    path("agents/<uuid:pk>/pause/", AgentPauseView.as_view(), name="agent-pause"),
    path("agents/<uuid:pk>/resume/", AgentResumeView.as_view(), name="agent-resume"),
    path("agents/<uuid:pk>/scope/", AgentScopeView.as_view(), name="agent-scope"),
    path("agents/<uuid:pk>/revoke/", AgentRevokeView.as_view(), name="agent-revoke"),
]
