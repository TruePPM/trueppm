"""Tests for per-workspace forecast-history config (#1232, ADR-0144).

Covers: the Workspace → Program → Project resolver inheritance + clamp; the
history endpoint returning ``enabled: false`` with an empty list when disabled;
the three-valued attribution-audience gate against each role; and the purge
respecting the per-workspace effective retention cap.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Program, Project
from trueppm_api.apps.scheduling.forecast_history_settings import (
    resolve_effective_mc_history,
    resolve_inherited_mc_history,
)
from trueppm_api.apps.scheduling.models import MCAttributionAudience, MonteCarloRun
from trueppm_api.apps.workspace.models import Workspace

User = get_user_model()


@pytest.fixture(autouse=True)
def clear_cache() -> None:
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def workspace(db: object) -> Workspace:
    return Workspace.load()


@pytest.fixture
def program(db: object) -> Program:
    return Program.objects.create(name="Prog")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 1, 5), calendar=calendar)


@pytest.mark.django_db
class TestResolverInheritance:
    def test_standalone_project_resolves_to_workspace(
        self, workspace: Workspace, project: Project
    ) -> None:
        workspace.mc_history_enabled = False
        workspace.mc_history_retention_cap = 42
        workspace.mc_history_attribution_audience = MCAttributionAudience.SCHEDULER_PLUS
        workspace.save()
        assert resolve_effective_mc_history(project, "mc_history_enabled") is False
        assert resolve_effective_mc_history(project, "mc_history_retention_cap") == 42
        assert (
            resolve_effective_mc_history(project, "mc_history_attribution_audience")
            == MCAttributionAudience.SCHEDULER_PLUS
        )

    def test_project_null_inherits_program_over_workspace(
        self, workspace: Workspace, program: Program, project: Project
    ) -> None:
        workspace.mc_history_retention_cap = 100
        workspace.save()
        program.mc_history_retention_cap = 25
        program.save()
        project.program = program
        project.mc_history_retention_cap = None  # inherit
        project.save()
        # Project null → program override (25), not the workspace default (100).
        assert resolve_effective_mc_history(project, "mc_history_retention_cap") == 25

    def test_project_override_wins(
        self, workspace: Workspace, program: Program, project: Project
    ) -> None:
        program.mc_history_retention_cap = 25
        program.save()
        project.program = program
        project.mc_history_retention_cap = 7
        project.save()
        assert resolve_effective_mc_history(project, "mc_history_retention_cap") == 7

    def test_inherited_skips_own_override(
        self, workspace: Workspace, program: Program, project: Project
    ) -> None:
        workspace.mc_history_retention_cap = 100
        workspace.save()
        program.mc_history_retention_cap = 30
        program.save()
        project.program = program
        project.mc_history_retention_cap = 7
        project.save()
        # inherited = what it WOULD get if its own override were cleared = program (30).
        assert resolve_inherited_mc_history(project, "mc_history_retention_cap") == 30

    def test_retention_cap_clamped_to_hard_cap(
        self, workspace: Workspace, project: Project, settings: object
    ) -> None:
        settings.MC_HISTORY_HARD_CAP = 500
        workspace.mc_history_retention_cap = 10_000  # way over the hard cap
        workspace.save()
        assert resolve_effective_mc_history(project, "mc_history_retention_cap") == 500


def _client(user: object, project: Project, role: int) -> APIClient:
    ProjectMembership.objects.create(project=project, user=user, role=role)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def history_url(pk: object) -> str:
    return f"/api/v1/projects/{pk}/monte-carlo/history/"


@pytest.mark.django_db
class TestHistoryEnabledGate:
    def test_disabled_returns_enabled_false_empty_list(
        self, workspace: Workspace, project: Project
    ) -> None:
        workspace.mc_history_enabled = False
        workspace.save()
        owner = User.objects.create_user(username="fh_owner", password="pw")
        client = _client(owner, project, Role.OWNER)
        MonteCarloRun.objects.create(project=project, p80=date(2026, 9, 1), n_simulations=10)
        res = client.get(history_url(project.pk))
        assert res.status_code == 200
        assert res.json()["enabled"] is False
        assert res.json()["results"] == []

    def test_enabled_returns_results(self, workspace: Workspace, project: Project) -> None:
        member = User.objects.create_user(username="fh_member", password="pw")
        client = _client(member, project, Role.MEMBER)
        MonteCarloRun.objects.create(project=project, p80=date(2026, 9, 1), n_simulations=10)
        res = client.get(history_url(project.pk))
        assert res.json()["enabled"] is True
        assert len(res.json()["results"]) == 1


@pytest.mark.django_db
class TestAttributionAudienceGate:
    def _setup(self, project: Project, audience: str, *, role: int) -> APIClient:
        ws = Workspace.load()
        ws.mc_history_attribution_audience = audience
        ws.save()
        author = User.objects.create_user(username="fh_author", password="pw")
        MonteCarloRun.objects.create(
            project=project, p80=date(2026, 9, 1), n_simulations=10, triggered_by=author
        )
        reader = User.objects.create_user(username=f"fh_reader_{role}", password="pw")
        return _client(reader, project, role)

    @pytest.mark.parametrize(
        ("audience", "role", "expect_name"),
        [
            (MCAttributionAudience.ADMIN_OWNER, Role.OWNER, True),
            (MCAttributionAudience.ADMIN_OWNER, Role.ADMIN, True),
            (MCAttributionAudience.ADMIN_OWNER, Role.SCHEDULER, False),
            (MCAttributionAudience.ADMIN_OWNER, Role.MEMBER, False),
            (MCAttributionAudience.SCHEDULER_PLUS, Role.SCHEDULER, True),
            (MCAttributionAudience.SCHEDULER_PLUS, Role.ADMIN, True),
            (MCAttributionAudience.SCHEDULER_PLUS, Role.MEMBER, False),
            (MCAttributionAudience.SCHEDULER_PLUS, Role.VIEWER, False),
            (MCAttributionAudience.NONE, Role.OWNER, False),
            (MCAttributionAudience.NONE, Role.ADMIN, False),
        ],
    )
    def test_attribution_gate(
        self, project: Project, audience: str, role: int, expect_name: bool
    ) -> None:
        client = self._setup(project, audience, role=role)
        res = client.get(history_url(project.pk))
        assert res.status_code == 200
        name = res.json()["results"][0]["triggered_by_name"]
        assert (name is not None) is expect_name


@pytest.mark.django_db
class TestPurgeRespectsWorkspaceCap:
    def test_purge_uses_effective_cap(self, workspace: Workspace, project: Project) -> None:
        from trueppm_api.apps.scheduling.tasks import _do_monte_carlo_run_purge

        workspace.mc_history_retention_cap = 2
        workspace.save()
        base = timezone.now()
        for i in range(5):
            run = MonteCarloRun.objects.create(
                project=project, p80=date(2026, 9, 1), n_simulations=10
            )
            MonteCarloRun.objects.filter(pk=run.pk).update(taken_at=base - timedelta(days=i))
        _do_monte_carlo_run_purge()
        assert MonteCarloRun.objects.filter(project=project).count() == 2

    def test_purge_uses_project_override_cap(self, workspace: Workspace, project: Project) -> None:
        from trueppm_api.apps.scheduling.tasks import _do_monte_carlo_run_purge

        workspace.mc_history_retention_cap = 100
        workspace.save()
        project.mc_history_retention_cap = 1
        project.save()
        base = timezone.now()
        for i in range(4):
            run = MonteCarloRun.objects.create(
                project=project, p80=date(2026, 9, 1), n_simulations=10
            )
            MonteCarloRun.objects.filter(pk=run.pk).update(taken_at=base - timedelta(days=i))
        _do_monte_carlo_run_purge()
        assert MonteCarloRun.objects.filter(project=project).count() == 1


# ===========================================================================
# Attribution-audience WIRE contract (#2841)
#
# Every test above sets ``mc_history_attribution_audience`` directly on the
# model, so none of them ever crossed the serializer — which is how a client
# that PATCHed the SCREAMING_CASE member names shipped green. These tests pin
# the wire casing itself: the lowercase TextChoices values are the contract,
# and the uppercase spelling must stay a 400 rather than silently succeed.
# ===========================================================================

WS_URL = "/api/v1/workspace/"
AUDIENCE_FIELD = "mc_history_attribution_audience"
WIRE_VALUES = ("admin_owner", "scheduler_plus", "none")


@pytest.fixture
def ws_admin(db: object) -> object:
    return User.objects.create_user(username="fh_ws_admin", password="pw", is_superuser=True)


@pytest.mark.django_db
class TestAttributionAudienceWireValues:
    """The enum's wire spelling is lowercase on every scope that accepts it."""

    def test_text_choices_are_lowercase(self) -> None:
        assert tuple(MCAttributionAudience.values) == WIRE_VALUES

    def test_openapi_enum_matches_text_choices(self) -> None:
        """The published schema is the client's reference — keep the two identical.

        ``docs/api/openapi.json`` is what a client transcribes from, and
        ``packages/web/src/api/types.ts`` is hand-maintained with no drift gate
        (#2609/#2633). Asserting the schema against the source enum makes a
        re-cased choice fail here instead of at a user's PATCH.
        """
        import json
        from pathlib import Path

        here = Path(__file__).resolve()
        candidate = next(
            (
                p / "docs" / "api" / "openapi.json"
                for p in here.parents
                if (p / "docs" / "api" / "openapi.json").exists()
            ),
            None,
        )
        assert candidate is not None, "Could not locate docs/api/openapi.json above the test file."
        schema = json.loads(candidate.read_text())
        published = schema["components"]["schemas"]["McHistoryAttributionAudienceEnum"]["enum"]
        assert tuple(published) == WIRE_VALUES


@pytest.mark.django_db
class TestProjectAudienceRoundTrip:
    @pytest.mark.parametrize("value", WIRE_VALUES)
    def test_patch_accepts_wire_value_and_reads_back(self, project: Project, value: str) -> None:
        user = User.objects.create_user(username=f"fh_pa_{value}", password="pw")
        client = _client(user, project, Role.ADMIN)

        res = client.patch(
            f"/api/v1/projects/{project.pk}/", {AUDIENCE_FIELD: value}, format="json"
        )
        assert res.status_code == 200, res.content
        assert res.data[AUDIENCE_FIELD] == value

        project.refresh_from_db()
        assert project.mc_history_attribution_audience == value

        # The persisted override survives a fresh read — this is the half the
        # uppercase union broke on read, leaving the <select> with nothing chosen.
        read = client.get(f"/api/v1/projects/{project.pk}/")
        assert read.status_code == 200
        assert read.data[AUDIENCE_FIELD] == value
        assert read.data[f"effective_{AUDIENCE_FIELD}"] == value

    @pytest.mark.parametrize("value", ["ADMIN_OWNER", "SCHEDULER_PLUS", "NONE"])
    def test_patch_rejects_uppercase_spelling(self, project: Project, value: str) -> None:
        """The #2841 regression: an uppercase member is not a valid choice."""
        user = User.objects.create_user(username=f"fh_pu_{value}", password="pw")
        client = _client(user, project, Role.ADMIN)

        res = client.patch(
            f"/api/v1/projects/{project.pk}/", {AUDIENCE_FIELD: value}, format="json"
        )
        assert res.status_code == 400, res.content
        assert AUDIENCE_FIELD in res.data

        project.refresh_from_db()
        assert project.mc_history_attribution_audience is None  # unchanged

    def test_patch_null_clears_the_override(self, project: Project) -> None:
        user = User.objects.create_user(username="fh_pnull", password="pw")
        client = _client(user, project, Role.ADMIN)
        project.mc_history_attribution_audience = MCAttributionAudience.NONE
        project.save()

        res = client.patch(f"/api/v1/projects/{project.pk}/", {AUDIENCE_FIELD: None}, format="json")
        assert res.status_code == 200, res.content
        project.refresh_from_db()
        assert project.mc_history_attribution_audience is None

    def test_patch_rejects_blank(self, project: Project) -> None:
        """`""` matches no member and must not fall through to the default."""
        user = User.objects.create_user(username="fh_pblank", password="pw")
        client = _client(user, project, Role.ADMIN)

        res = client.patch(f"/api/v1/projects/{project.pk}/", {AUDIENCE_FIELD: ""}, format="json")
        assert res.status_code == 400, res.content


@pytest.mark.django_db
class TestProgramAudienceRoundTrip:
    @pytest.mark.parametrize("value", WIRE_VALUES)
    def test_patch_accepts_wire_value_and_reads_back(self, program: Program, value: str) -> None:
        from trueppm_api.apps.access.models import ProgramMembership

        user = User.objects.create_user(username=f"fh_gr_{value}", password="pw")
        ProgramMembership.objects.create(program=program, user=user, role=Role.ADMIN)
        client = APIClient()
        client.force_authenticate(user=user)

        res = client.patch(
            f"/api/v1/programs/{program.pk}/", {AUDIENCE_FIELD: value}, format="json"
        )
        assert res.status_code == 200, res.content
        assert res.data[AUDIENCE_FIELD] == value

        program.refresh_from_db()
        assert program.mc_history_attribution_audience == value
        assert client.get(f"/api/v1/programs/{program.pk}/").data[AUDIENCE_FIELD] == value

    def test_patch_rejects_uppercase_spelling(self, program: Program) -> None:
        from trueppm_api.apps.access.models import ProgramMembership

        user = User.objects.create_user(username="fh_gu", password="pw")
        ProgramMembership.objects.create(program=program, user=user, role=Role.ADMIN)
        client = APIClient()
        client.force_authenticate(user=user)

        res = client.patch(
            f"/api/v1/programs/{program.pk}/", {AUDIENCE_FIELD: "ADMIN_OWNER"}, format="json"
        )
        assert res.status_code == 400, res.content
        program.refresh_from_db()
        assert program.mc_history_attribution_audience is None


@pytest.mark.django_db
class TestWorkspaceAudienceRoundTrip:
    @pytest.mark.parametrize("value", WIRE_VALUES)
    def test_patch_accepts_wire_value_and_reads_back(self, ws_admin: object, value: str) -> None:
        client = APIClient()
        client.force_authenticate(user=ws_admin)

        res = client.patch(WS_URL, {AUDIENCE_FIELD: value}, format="json")
        assert res.status_code == 200, res.content
        assert res.data[AUDIENCE_FIELD] == value
        assert Workspace.load().mc_history_attribution_audience == value
        assert client.get(WS_URL).data[AUDIENCE_FIELD] == value

    def test_patch_rejects_uppercase_spelling(self, ws_admin: object) -> None:
        client = APIClient()
        client.force_authenticate(user=ws_admin)

        res = client.patch(WS_URL, {AUDIENCE_FIELD: "SCHEDULER_PLUS"}, format="json")
        assert res.status_code == 400, res.content
        assert AUDIENCE_FIELD in res.data
        # The workspace root is non-nullable — it keeps its prior value.
        assert Workspace.load().mc_history_attribution_audience == (
            MCAttributionAudience.ADMIN_OWNER
        )
