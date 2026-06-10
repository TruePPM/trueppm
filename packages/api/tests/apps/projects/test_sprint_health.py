"""Tests for server-owned Tier-3 sprint-health (#988, ADR-0101 §4).

`GET /api/v1/projects/<pk>/sprint-health/` returns the orphan / active-sprint
phase-span / parent-task-in-sprint signals the Sprints view used to derive in
the browser — now with count, threshold, tone, and consequence copy all
server-owned (web-rule 141). Covers the signal logic at the service layer and
the endpoint permission gate.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Sprint, SprintState, Task
from trueppm_api.apps.projects.services import sprint_health

User = get_user_model()


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Std", working_days=31, hours_per_day=8.0)
    return Project.objects.create(name="P", start_date=date(2026, 1, 5), calendar=cal)


@pytest.fixture
def active_sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 1, 5),
        finish_date=date(2026, 1, 16),
        state=SprintState.ACTIVE,
    )


def _signals_by_key(project: Project) -> dict[str, dict]:
    return {s["key"]: s for s in sprint_health(project.pk)["signals"]}


# ---------------------------------------------------------------------------
# Service-layer signal logic
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestSprintHealthSignals:
    def test_healthy_project_returns_no_signals(self, project: Project) -> None:
        assert sprint_health(project.pk) == {"signals": []}

    def test_orphan_signal_counts_unrooted_unscheduled_leaves(self, project: Project) -> None:
        # Orphan: leaf, top-level wbs, no sprint, not milestone.
        Task.objects.create(project=project, name="Loose", wbs_path="5", duration=1)
        # NOT orphan: has a phase ancestor (dotted wbs).
        Task.objects.create(project=project, name="Phased", wbs_path="6.1", duration=1)
        # NOT orphan: a milestone.
        Task.objects.create(project=project, name="MS", wbs_path="7", duration=0, is_milestone=True)

        signals = _signals_by_key(project)
        assert signals["orphan"]["count"] == 1
        assert signals["orphan"]["tone"] == "info"
        assert signals["orphan"]["detail"] == "1 task in no sprint and no phase"

    def test_orphan_excludes_tasks_in_a_sprint(
        self, project: Project, active_sprint: Sprint
    ) -> None:
        Task.objects.create(
            project=project, name="Scheduled", wbs_path="5", duration=1, sprint=active_sprint
        )
        assert "orphan" not in _signals_by_key(project)

    def test_orphan_plural_copy(self, project: Project) -> None:
        for i in range(3):
            Task.objects.create(project=project, name=f"L{i}", wbs_path=str(10 + i), duration=1)
        assert _signals_by_key(project)["orphan"]["detail"] == "3 tasks in no sprint and no phase"

    def test_summary_in_sprint_signal(self, project: Project, active_sprint: Sprint) -> None:
        # Parent "1" (has child "1.1") assigned to the sprint → double-counts velocity.
        Task.objects.create(
            project=project, name="Phase", wbs_path="1", duration=1, sprint=active_sprint
        )
        Task.objects.create(project=project, name="Child", wbs_path="1.1", duration=1)

        sig = _signals_by_key(project)["summary_in_sprint"]
        assert sig["count"] == 1
        assert sig["tone"] == "warn"
        # ADR-0101 §2 — "parent task", never "summary task".
        assert sig["detail"] == "1 parent task in a sprint"

    def test_phase_span_fires_at_three_phases(
        self, project: Project, active_sprint: Sprint
    ) -> None:
        for root in ("1", "2", "3"):
            Task.objects.create(
                project=project,
                name=f"T{root}",
                wbs_path=f"{root}.1",
                duration=1,
                sprint=active_sprint,
            )
        sig = _signals_by_key(project)["phase_span"]
        assert sig["count"] == 3
        assert sig["tone"] == "info"
        assert sig["detail"] == "Active sprint spans 3 phases"

    def test_phase_span_silent_below_three(self, project: Project, active_sprint: Sprint) -> None:
        for root in ("1", "2"):
            Task.objects.create(
                project=project,
                name=f"T{root}",
                wbs_path=f"{root}.1",
                duration=1,
                sprint=active_sprint,
            )
        assert "phase_span" not in _signals_by_key(project)

    def test_phase_span_ignored_without_active_sprint(self, project: Project) -> None:
        # Same three-phase shape but no ACTIVE sprint → no span signal.
        for root in ("1", "2", "3"):
            Task.objects.create(project=project, name=f"T{root}", wbs_path=f"{root}.1", duration=1)
        assert "phase_span" not in _signals_by_key(project)


# ---------------------------------------------------------------------------
# Endpoint + permission gate
# ---------------------------------------------------------------------------


def _url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/sprint-health/"


@pytest.mark.django_db
class TestSprintHealthEndpoint:
    def _member_client(self, project: Project, role: int = Role.MEMBER) -> APIClient:
        user = User.objects.create_user(username=f"sh{role}", password="pw")
        ProjectMembership.objects.create(project=project, user=user, role=role)
        c = APIClient()
        c.force_authenticate(user=user)
        return c

    def test_member_gets_signals(self, project: Project, active_sprint: Sprint) -> None:
        Task.objects.create(project=project, name="Loose", wbs_path="5", duration=1)
        resp = self._member_client(project).get(_url(project))
        assert resp.status_code == 200
        keys = {s["key"] for s in resp.data["signals"]}
        assert "orphan" in keys

    def test_viewer_allowed(self, project: Project) -> None:
        """Viewer is the documented floor — a team+coach read surface (ADR-0101 §4)."""
        resp = self._member_client(project, role=Role.VIEWER).get(_url(project))
        assert resp.status_code == 200
        assert resp.data["signals"] == []

    def test_unauthenticated_denied(self, project: Project) -> None:
        assert APIClient().get(_url(project)).status_code in (401, 403)

    def test_non_member_denied(self, project: Project) -> None:
        other = User.objects.create_user(username="outsider", password="pw")
        c = APIClient()
        c.force_authenticate(user=other)
        assert c.get(_url(project)).status_code in (403, 404)
