"""Amend: a structural edit to a committed plan carries a reason (#2964).

Before this, editing a committed plan and editing a greenfield draft were
indistinguishable — same keystrokes, no record, no signal to the people who had
planned around it.

The three properties, in the order they are most likely to be eroded later:
the reason reaches plan history, it reaches the people affected, and it is
NEVER a block.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.amend import AMEND_PREFIX, is_amendable
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    ProjectLifecycle,
    Task,
)


@pytest.fixture
def user(db: object) -> object:
    return get_user_model().objects.create_user(username="amenduser", password="pw")


@pytest.fixture
def client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


def _project(calendar: Calendar, lifecycle: str) -> Project:
    return Project.objects.create(
        name="Pad 39C", start_date=date(2026, 3, 2), calendar=calendar, lifecycle=lifecycle
    )


@pytest.fixture
def committed(calendar: Calendar, user: object) -> Project:
    p = _project(calendar, ProjectLifecycle.ACTIVE)
    ProjectMembership.objects.create(project=p, user=user, role=Role.OWNER)
    return p


@pytest.fixture
def draft(calendar: Calendar, user: object) -> Project:
    p = _project(calendar, ProjectLifecycle.DRAFT)
    ProjectMembership.objects.create(project=p, user=user, role=Role.OWNER)
    return p


def _task(project: Project, name: str = "Permits") -> Task:
    return Task.objects.create(project=project, name=name, duration=5, wbs_path="1")


@pytest.mark.django_db
class TestWhenAmendApplies:
    def test_a_committed_plan_is_amendable(self, committed: Project) -> None:
        assert is_amendable(committed) is True

    def test_a_draft_is_not(self, draft: Project) -> None:
        """Authoring a plan nobody has agreed to must stay frictionless.

        Making a draft carry reasons would make the commit moment something
        people avoid rather than reach for.
        """
        assert is_amendable(draft) is False


@pytest.mark.django_db
class TestReasonReachesPlanHistory:
    def test_the_reason_lands_on_the_history_row(
        self, client: APIClient, committed: Project
    ) -> None:
        task = _task(committed)
        r = client.patch(
            f"/api/v1/tasks/{task.id}/",
            {
                "name": "Permits (revised)",
                "amend_reason": "Range safety added a dry-run",
                "project": str(committed.id),
            },
            format="json",
        )
        assert r.status_code == 200
        entry = task.history.first()
        assert entry is not None
        assert "Range safety added a dry-run" in (entry.history_change_reason or "")

    def test_an_amend_with_no_reason_is_still_marked(
        self, client: APIClient, committed: Project
    ) -> None:
        """ "Amended, and nobody said why" is different from "never amended"."""
        task = _task(committed)
        client.patch(
            f"/api/v1/tasks/{task.id}/",
            {"name": "Quietly changed", "project": str(committed.id)},
            format="json",
        )
        entry = task.history.first()
        assert (entry.history_change_reason or "").startswith(AMEND_PREFIX)

    def test_a_draft_edit_carries_no_amend_marker(self, client: APIClient, draft: Project) -> None:
        task = _task(draft)
        client.patch(
            f"/api/v1/tasks/{task.id}/",
            {"name": "Still drafting", "project": str(draft.id)},
            format="json",
        )
        entry = task.history.first()
        assert AMEND_PREFIX not in (entry.history_change_reason or "")


@pytest.mark.django_db
class TestNeverABlock:
    def test_an_amend_without_a_reason_still_succeeds(
        self, client: APIClient, committed: Project
    ) -> None:
        """The property most likely to be eroded later.

        Amend records and tells. It does not gate, refuse, or require approval —
        a planner who cannot change a committed plan keeps the real plan
        somewhere else, and then the tool is describing fiction.
        """
        task = _task(committed)
        r = client.patch(
            f"/api/v1/tasks/{task.id}/",
            {"name": "Changed with no reason", "project": str(committed.id)},
            format="json",
        )
        assert r.status_code == 200
        task.refresh_from_db()
        assert task.name == "Changed with no reason"

    def test_a_notification_failure_does_not_revert_the_edit(
        self, client: APIClient, committed: Project, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A dispatch failure must never turn Amend into a gate accidentally."""
        import trueppm_api.apps.projects.amend as amend_mod

        def boom(*_a: object, **_k: object) -> None:
            raise RuntimeError("notification backend down")

        monkeypatch.setattr(amend_mod, "_emit_amend_notifications", boom)

        task = _task(committed)
        r = client.patch(
            f"/api/v1/tasks/{task.id}/",
            {
                "name": "Survives a broken notifier",
                "project": str(committed.id),
                "amend_reason": "scope change",
            },
            format="json",
        )
        assert r.status_code == 200
        task.refresh_from_db()
        assert task.name == "Survives a broken notifier"


@pytest.mark.django_db
class TestTheReasonIsFreeText:
    def test_no_choices_are_enforced(self, client: APIClient, committed: Project) -> None:
        """A dropdown of blessed reasons collects the nearest wrong one."""
        task = _task(committed)
        r = client.patch(
            f"/api/v1/tasks/{task.id}/",
            {"name": "x", "amend_reason": "anything at all, really", "project": str(committed.id)},
            format="json",
        )
        assert r.status_code == 200

    def test_it_is_write_only_and_never_echoed(self, client: APIClient, committed: Project) -> None:
        task = _task(committed)
        r = client.patch(
            f"/api/v1/tasks/{task.id}/",
            {"name": "x", "amend_reason": "secret-ish", "project": str(committed.id)},
            format="json",
        )
        assert "amend_reason" not in r.data
