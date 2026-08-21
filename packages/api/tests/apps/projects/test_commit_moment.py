"""The commit moment (#2963) and the frozen calendar (ADR-0845).

Nothing marked "this is the plan we agreed to", so variance had nothing to
subtract from. These pin what commit does, what it refuses, and the one
property the whole feature rests on: that the anchor does not move.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.commit_moment import AlreadyCommitted, commit_project
from trueppm_api.apps.projects.models import (
    Baseline,
    BaselineTask,
    Calendar,
    Project,
    ProjectLifecycle,
    Task,
)


@pytest.fixture
def user(db: object) -> object:
    return get_user_model().objects.create_user(username="commituser", password="pw")


@pytest.fixture
def client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard", working_days=31, hours_per_day=8.0)


@pytest.fixture
def draft(calendar: Calendar) -> Project:
    p = Project.objects.create(
        name="Pad 39C",
        start_date=date(2026, 3, 2),
        calendar=calendar,
        lifecycle=ProjectLifecycle.DRAFT,
    )
    Task.objects.create(
        project=p,
        name="Permits",
        duration=5,
        wbs_path="1",
        early_start=date(2026, 3, 2),
        early_finish=date(2026, 3, 6),
    )
    Task.objects.create(
        project=p,
        name="Survey",
        duration=3,
        wbs_path="2",
        early_start=date(2026, 3, 9),
        early_finish=date(2026, 3, 11),
    )
    return p


@pytest.mark.django_db
class TestCommit:
    def test_flips_lifecycle_and_captures_baseline_v1(self, draft: Project, user: object) -> None:
        result = commit_project(draft, user=user)
        draft.refresh_from_db()
        assert draft.lifecycle == ProjectLifecycle.ACTIVE
        assert result.baseline.name == "Baseline v1"
        assert result.baseline.is_active is True
        assert result.task_count == 2
        assert BaselineTask.objects.filter(baseline=result.baseline).count() == 2

    def test_a_second_commit_is_refused(self, draft: Project, user: object) -> None:
        """A second 'v1' would move the anchor every variance number is measured from."""
        commit_project(draft, user=user)
        draft.refresh_from_db()
        with pytest.raises(AlreadyCommitted):
            commit_project(draft, user=user)
        assert Baseline.objects.filter(project=draft).count() == 1

    def test_the_commit_is_atomic(self, draft: Project, user: object) -> None:
        """A lifecycle flip without a baseline is worse than not committing.

        The claim would be visible and the missing anchor would not.
        """
        before = Baseline.objects.count()
        commit_project(draft, user=user)
        draft.refresh_from_db()
        assert draft.lifecycle == ProjectLifecycle.ACTIVE
        assert Baseline.objects.count() == before + 1


@pytest.mark.django_db
class TestFrozenCalendar:
    """ADR-0845 — the property the whole feature rests on."""

    def test_the_baseline_records_the_calendar_by_VALUE(
        self, draft: Project, calendar: Calendar, user: object
    ) -> None:
        result = commit_project(draft, user=user)
        assert result.baseline.calendar_working_days == 31
        assert result.baseline.calendar_hours_per_day == 8.0
        assert result.baseline.calendar_id_at_capture == calendar.id

    def test_editing_the_calendar_afterwards_does_not_move_the_baseline(
        self, draft: Project, calendar: Calendar, user: object
    ) -> None:
        """The whole point.

        A reference would let a later calendar edit reshape the anchor, so
        variance would quietly agree with whatever the calendar last became —
        the number improving at the exact moment the plan got harder.
        """
        result = commit_project(draft, user=user)

        calendar.working_days = 63  # someone adds Saturday
        calendar.hours_per_day = 10.0
        calendar.save()

        result.baseline.refresh_from_db()
        assert result.baseline.calendar_working_days == 31, "frozen, not a live reference"
        assert result.baseline.calendar_hours_per_day == 8.0

    def test_a_project_with_no_calendar_captures_no_snapshot_rather_than_a_fake_one(
        self, user: object
    ) -> None:
        p = Project.objects.create(
            name="No calendar",
            start_date=date(2026, 3, 2),
            lifecycle=ProjectLifecycle.DRAFT,
        )
        result = commit_project(p, user=user)
        assert result.baseline.calendar_working_days is None


@pytest.mark.django_db
class TestEndpoint:
    def test_commit_returns_the_baseline_and_counts(
        self, client: APIClient, user: object, draft: Project
    ) -> None:
        ProjectMembership.objects.create(project=draft, user=user, role=Role.OWNER)
        r = client.post(f"/api/v1/projects/{draft.id}/commit/")
        assert r.status_code == 200
        assert r.data["baseline_name"] == "Baseline v1"
        assert r.data["task_count"] == 2

    def test_committing_twice_is_a_409(
        self, client: APIClient, user: object, draft: Project
    ) -> None:
        ProjectMembership.objects.create(project=draft, user=user, role=Role.OWNER)
        client.post(f"/api/v1/projects/{draft.id}/commit/")
        r = client.post(f"/api/v1/projects/{draft.id}/commit/")
        assert r.status_code == 409
        assert r.data["code"] == "already_committed"

    def test_a_member_below_scheduler_cannot_commit(
        self, client: APIClient, user: object, draft: Project
    ) -> None:
        """Committing notifies everyone with work in the plan — not a Member act."""
        ProjectMembership.objects.create(project=draft, user=user, role=Role.MEMBER)
        r = client.post(f"/api/v1/projects/{draft.id}/commit/")
        assert r.status_code == 403
        draft.refresh_from_db()
        assert draft.lifecycle == ProjectLifecycle.DRAFT


class TestSchemaBinding:
    """The commit endpoint declares its own responses (#2963).

    The #2455 orphaned-decorator trap bit this MR too: the view was first
    inserted between `BoardLanesView`'s `@extend_schema` and its class, which
    silently reassigned that decorator — the commit endpoint took a schema it
    never declared and BoardLanes lost the one it did.

    A structural "is the decorator anchored to a class?" check does NOT catch
    this: decorator stacking is legal Python and looks identical. I wrote that
    check, it passed against the reintroduced bug, and I deleted it. What caught
    it — twice now — is asserting the GENERATED schema against what each
    endpoint declared, which is what this does.
    """

    @staticmethod
    def _schema() -> dict:
        import json
        from pathlib import Path

        root = Path(__file__).resolve().parents[5]
        return json.loads((root / "docs" / "api" / "openapi.json").read_text())

    def test_commit_declares_its_409(self) -> None:
        post = self._schema()["paths"]["/api/v1/projects/{id}/commit/"]["post"]
        assert "409" in post["responses"], "committing twice must be a documented refusal"

    def test_commit_declares_its_result_shape(self) -> None:
        post = self._schema()["paths"]["/api/v1/projects/{id}/commit/"]["post"]
        ref = post["responses"]["200"]["content"]["application/json"]["schema"]["$ref"]
        assert ref.endswith("/CommitProjectResult")

    def test_board_lanes_still_owns_its_own(self) -> None:
        """The endpoint this MR's misplacement silently stripped."""
        get = self._schema()["paths"]["/api/v1/projects/{id}/board/lanes/"]["get"]
        ref = get["responses"]["200"]["content"]["application/json"]["schema"]["$ref"]
        assert ref.endswith("/BoardLanes")
        assert "group_depth" in [q["name"] for q in get.get("parameters", [])]
