"""URL patterns for the agents app — the team-readable agent-action log (#1805)."""

from __future__ import annotations

from django.urls import path

from trueppm_api.apps.agents.views import AgentActionViewSet

agent_action_list = AgentActionViewSet.as_view({"get": "list"})
agent_action_detail = AgentActionViewSet.as_view({"get": "retrieve"})

urlpatterns = [
    path("agent-actions/", agent_action_list, name="agent-action-list"),
    path("agent-actions/<uuid:pk>/", agent_action_detail, name="agent-action-detail"),
]
